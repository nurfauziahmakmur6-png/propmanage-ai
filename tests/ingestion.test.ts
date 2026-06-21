import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "crypto";
import { Queue } from "bullmq";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { organizations, documents, documentChunks } from "../db/schema";
import type { EmbeddingProvider } from "../lib/embeddings";
import {
  splitDocument,
  runEmbedBatch,
  finalizeDocument,
  type PipelineDeps,
} from "../lib/ingestion/pipeline";
import { createWorkers } from "../lib/ingestion/workers";
import { redisConnectionOptions } from "../lib/queue/connection";
import {
  QUEUE_INGESTION,
  QUEUE_EMBED,
  JOB_INGEST,
  MAX_ATTEMPTS,
  ingestionJobId,
  embedBatchJobId,
} from "../lib/queue/queues";

const DIM = 384;

class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly id = "fake";
  readonly dimensions = DIM;
  async embedPassages(texts: string[]): Promise<number[][]> {
    return texts.map((t, i) => {
      const v = new Array(DIM).fill(0);
      v[0] = (t.length % 7) + 1;
      v[1] = i + 1;
      return v;
    });
  }
  async embedQuery(text: string): Promise<number[]> {
    return (await this.embedPassages([text]))[0];
  }
}

class ThrowingEmbeddingProvider implements EmbeddingProvider {
  readonly id = "throwing";
  readonly dimensions = DIM;
  async embedPassages(): Promise<number[][]> {
    throw new Error("embed failed (test)");
  }
  async embedQuery(): Promise<number[]> {
    throw new Error("embed failed (test)");
  }
}

// Multi-paragraph text large enough to produce several chunks (and thus >1 batch).
function sampleText(): string {
  const paras: string[] = ["HOUSE RULES"];
  for (let i = 1; i <= 40; i++) {
    paras.push(
      `Section ${i}. ` +
        `Tenants must observe quiet hours and keep common areas clean. ` +
          "Rubbish is collected on Tuesday and Friday mornings. ".repeat(6)
    );
  }
  return paras.join("\n\n");
}

const createdOrgs: string[] = [];

async function makeOrgAndDocument(): Promise<{ organizationId: string; documentId: string }> {
  const [org] = await db
    .insert(organizations)
    .values({ name: `test-${randomUUID()}` })
    .returning();
  createdOrgs.push(org.id);
  const documentId = randomUUID();
  await db.insert(documents).values({
    id: documentId,
    organizationId: org.id,
    title: "Test document",
    storageKey: `${org.id}/${documentId}.pdf`,
    mimeType: "application/pdf",
    status: "pending",
  });
  return { organizationId: org.id, documentId };
}

async function chunkCount(documentId: string, organizationId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(documentChunks)
    .where(
      and(
        eq(documentChunks.documentId, documentId),
        eq(documentChunks.organizationId, organizationId)
      )
    );
  return rows[0].n;
}

async function distinctChunkIndexCount(
  documentId: string,
  organizationId: string
): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(distinct ${documentChunks.chunkIndex})::int` })
    .from(documentChunks)
    .where(
      and(
        eq(documentChunks.documentId, documentId),
        eq(documentChunks.organizationId, organizationId)
      )
    );
  return rows[0].n;
}

async function docStatus(documentId: string, organizationId: string) {
  const rows = await db
    .select({ status: documents.status, error: documents.error })
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.organizationId, organizationId)));
  return rows[0];
}

async function runPipelineInline(
  data: { documentId: string; organizationId: string },
  deps: PipelineDeps
) {
  const batches = await splitDocument(data, deps);
  for (const b of batches) {
    await runEmbedBatch(
      {
        documentId: data.documentId,
        organizationId: data.organizationId,
        batchIndex: b.batchIndex,
        fromChunkIndex: b.fromChunkIndex,
        toChunkIndex: b.toChunkIndex,
      },
      deps
    );
  }
  return finalizeDocument(data, deps);
}

async function waitFor<T>(
  fn: () => Promise<T | null | undefined>,
  timeoutMs = 40_000,
  intervalMs = 250
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitFor: timed out");
}

afterEach(async () => {
  // Cascade deletes documents + chunks.
  while (createdOrgs.length > 0) {
    const id = createdOrgs.pop()!;
    await db.delete(organizations).where(eq(organizations.id, id));
  }
});

describe("ingestion idempotency", () => {
  it("running ingestion twice yields the same chunk count with no duplicates", async () => {
    const { organizationId, documentId } = await makeOrgAndDocument();
    const deps: PipelineDeps = {
      embeddingProvider: new FakeEmbeddingProvider(),
      loadPages: async () => [sampleText()],
    };

    const first = await runPipelineInline({ documentId, organizationId }, deps);
    const countAfterFirst = await chunkCount(documentId, organizationId);

    const second = await runPipelineInline({ documentId, organizationId }, deps);
    const countAfterSecond = await chunkCount(documentId, organizationId);

    expect(first).toBe("ready");
    expect(second).toBe("ready");
    expect(countAfterFirst).toBeGreaterThan(1); // produced multiple chunks
    expect(countAfterSecond).toBe(countAfterFirst); // no growth on re-run
    // No duplicate (document_id, chunk_index) rows.
    expect(await distinctChunkIndexCount(documentId, organizationId)).toBe(countAfterSecond);
    // Every chunk embedded.
    const status = await docStatus(documentId, organizationId);
    expect(status.status).toBe("ready");
  });
});

describe("ingestion failure handling", () => {
  it("a failing embed retries to exhaustion and the document ends failed, not stuck", async () => {
    const { organizationId, documentId } = await makeOrgAndDocument();
    const prefix = `test-${randomUUID()}`;

    const handles = createWorkers({
      deps: {
        embeddingProvider: new ThrowingEmbeddingProvider(),
        loadPages: async () => [sampleText()],
      },
      log: () => {},
      prefix,
      includeMaintenance: false,
      backoff: () => 20, // fast retries
      embedConcurrency: 4,
      embedMaxPerSecond: 100,
    });

    const ingestionQueue = new Queue(QUEUE_INGESTION, {
      connection: redisConnectionOptions(),
      prefix,
    });
    const embedQueue = new Queue(QUEUE_EMBED, {
      connection: redisConnectionOptions(),
      prefix,
    });

    try {
      await ingestionQueue.add(
        JOB_INGEST,
        { documentId, organizationId, phase: "split" },
        { jobId: ingestionJobId(documentId), attempts: 1 }
      );

      const status = await waitFor(async () => {
        const s = await docStatus(documentId, organizationId);
        return s.status === "failed" ? s : null;
      });

      expect(status.status).toBe("failed");
      expect(status.error).toBeTruthy();

      // The failing batch exhausted its retries and remains in the failed set.
      const child = await embedQueue.getJob(embedBatchJobId(documentId, 0));
      expect(child).toBeTruthy();
      expect(await child!.getState()).toBe("failed");
      expect(child!.attemptsMade).toBe(MAX_ATTEMPTS);
    } finally {
      await handles.close();
      await ingestionQueue.obliterate({ force: true });
      await embedQueue.obliterate({ force: true });
      await ingestionQueue.close();
      await embedQueue.close();
    }
  });
});
