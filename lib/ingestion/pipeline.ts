import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { db } from "../../db";
import { documents, documentChunks } from "../../db/schema";
import type { EmbeddingProvider } from "../embeddings";
import { chunkPages } from "./chunk";
import { EMBED_BATCH_SIZE, type IngestionJobData, type EmbedBatchJobData } from "../queue/queues";

export type LogFn = (event: string, fields: Record<string, unknown>) => void;

export interface PipelineDeps {
  embeddingProvider: EmbeddingProvider;
  // Injectable so tests can supply text without a real PDF/storage round-trip.
  loadPages: (documentId: string, organizationId: string) => Promise<string[]>;
  log?: LogFn;
}

export interface BatchDescriptor {
  batchIndex: number;
  fromChunkIndex: number;
  toChunkIndex: number; // inclusive
}

export function computeBatches(chunkCount: number): BatchDescriptor[] {
  const batches: BatchDescriptor[] = [];
  for (let from = 0, i = 0; from < chunkCount; from += EMBED_BATCH_SIZE, i++) {
    batches.push({
      batchIndex: i,
      fromChunkIndex: from,
      toChunkIndex: Math.min(from + EMBED_BATCH_SIZE, chunkCount) - 1,
    });
  }
  return batches;
}

async function setStatus(
  documentId: string,
  organizationId: string,
  status: "processing" | "ready" | "failed",
  error: string | null
): Promise<void> {
  await db
    .update(documents)
    .set({ status, error, updatedAt: sql`now()` })
    .where(and(eq(documents.id, documentId), eq(documents.organizationId, organizationId)));
}

export function markProcessing(documentId: string, organizationId: string) {
  return setStatus(documentId, organizationId, "processing", null);
}

export function markReady(documentId: string, organizationId: string) {
  return setStatus(documentId, organizationId, "ready", null);
}

export function markFailed(documentId: string, organizationId: string, error: string) {
  return setStatus(documentId, organizationId, "failed", error.slice(0, 2000));
}

export async function countMissingEmbeddings(
  documentId: string,
  organizationId: string
): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(documentChunks)
    .where(
      and(
        eq(documentChunks.documentId, documentId),
        eq(documentChunks.organizationId, organizationId),
        isNull(documentChunks.embedding)
      )
    );
  return rows[0]?.n ?? 0;
}

export async function countChunks(
  documentId: string,
  organizationId: string
): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(documentChunks)
    .where(
      and(
        eq(documentChunks.documentId, documentId),
        eq(documentChunks.organizationId, organizationId)
      )
    );
  return rows[0]?.n ?? 0;
}

/**
 * Split phase: extract -> chunk -> idempotently upsert chunk rows (embeddings left
 * null). Returns the batch descriptors the parent fans out as embed-batch children.
 * Re-running this for the same document overwrites rows by (document_id, chunk_index)
 * and deletes any trailing rows from a previous longer run, so the chunk count is
 * stable across retries.
 */
export async function splitDocument(
  data: IngestionJobData,
  deps: PipelineDeps
): Promise<BatchDescriptor[]> {
  const { documentId, organizationId } = data;
  await markProcessing(documentId, organizationId);

  const pages = await deps.loadPages(documentId, organizationId);
  const chunks = chunkPages(pages);
  deps.log?.("split.chunked", { documentId, chunkCount: chunks.length });

  if (chunks.length === 0) {
    throw new Error("no extractable text (possibly a scanned PDF; OCR is future work)");
  }

  const rows = chunks.map((c, i) => ({
    documentId,
    organizationId,
    chunkIndex: i,
    content: c.content,
    tokenCount: c.tokenCount,
    metadata: c.metadata,
  }));

  const GROUP = 200;
  for (let i = 0; i < rows.length; i += GROUP) {
    await db
      .insert(documentChunks)
      .values(rows.slice(i, i + GROUP))
      .onConflictDoUpdate({
        target: [documentChunks.documentId, documentChunks.chunkIndex],
        set: {
          content: sql`excluded.content`,
          tokenCount: sql`excluded.token_count`,
          metadata: sql`excluded.metadata`,
        },
      });
  }

  // Drop any leftover rows from a previous run that produced more chunks.
  await db
    .delete(documentChunks)
    .where(
      and(
        eq(documentChunks.documentId, documentId),
        eq(documentChunks.organizationId, organizationId),
        gte(documentChunks.chunkIndex, chunks.length)
      )
    );

  return computeBatches(chunks.length);
}

/**
 * Embed-batch phase: read this batch's chunk rows, embed their content, and write the
 * vectors back. The UPDATE is idempotent, so re-running overwrites rather than
 * duplicates.
 */
export async function runEmbedBatch(
  data: EmbedBatchJobData,
  deps: PipelineDeps
): Promise<number> {
  const { documentId, organizationId, fromChunkIndex, toChunkIndex } = data;
  const rows = await db
    .select({ id: documentChunks.id, content: documentChunks.content })
    .from(documentChunks)
    .where(
      and(
        eq(documentChunks.documentId, documentId),
        eq(documentChunks.organizationId, organizationId),
        gte(documentChunks.chunkIndex, fromChunkIndex),
        sql`${documentChunks.chunkIndex} <= ${toChunkIndex}`
      )
    )
    .orderBy(documentChunks.chunkIndex);

  if (rows.length === 0) return 0;

  const vectors = await deps.embeddingProvider.embedPassages(rows.map((r) => r.content));

  for (let i = 0; i < rows.length; i++) {
    const literal = `[${vectors[i].join(",")}]`;
    await db.execute(
      sql`update document_chunks set embedding = ${literal}::vector
          where id = ${rows[i].id} and organization_id = ${organizationId}`
    );
  }

  deps.log?.("embed.batch.done", {
    documentId,
    batchIndex: data.batchIndex,
    embedded: rows.length,
  });
  return rows.length;
}

/**
 * Finalize phase (parent re-entry after all children settle): the document is `ready`
 * only if every chunk has an embedding; otherwise a batch failed and the document is
 * marked `failed` rather than left stuck in `processing`.
 */
export async function finalizeDocument(
  data: IngestionJobData,
  deps: PipelineDeps
): Promise<"ready" | "failed"> {
  const { documentId, organizationId } = data;
  const missing = await countMissingEmbeddings(documentId, organizationId);
  if (missing > 0) {
    await markFailed(documentId, organizationId, `embedding incomplete: ${missing} chunk(s) unembedded`);
    deps.log?.("finalize.failed", { documentId, missing });
    return "failed";
  }
  await markReady(documentId, organizationId);
  deps.log?.("finalize.ready", { documentId });
  return "ready";
}
