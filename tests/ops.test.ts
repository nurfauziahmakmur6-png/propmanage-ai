import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { organizations, documents, agentRuns } from "../db/schema";
import {
  getDocumentPipeline,
  getAgentMetrics,
  getFailedDocuments,
  getStuckDocuments,
} from "../lib/ops/metrics";
import { reenqueueDocument } from "../lib/ops/actions";
import { getQueues, ingestionJobId } from "../lib/queue/queues";

async function freshOrg(name: string): Promise<string> {
  const [org] = await db.insert(organizations).values({ name }).returning({ id: organizations.id });
  return org.id;
}
async function dropOrg(id: string): Promise<void> {
  await db.delete(organizations).where(eq(organizations.id, id));
}

function doc(organizationId: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    organizationId,
    title: `doc-${status}`,
    storageKey: `${organizationId}/x.pdf`,
    mimeType: "application/pdf",
    status,
    ...extra,
  };
}

describe("ops metrics aggregation", () => {
  it("returns correct document and agent counts for a known seeded state", async () => {
    const org = await freshOrg(`test-ops-${Date.now()}`);
    try {
      const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      await db.insert(documents).values([
        doc(org, "ready"),
        doc(org, "ready"),
        doc(org, "failed", { error: "boom" }),
        doc(org, "pending"),
        // processing + old updatedAt => stuck past the sweeper timeout
        doc(org, "processing", { updatedAt: tenMinAgo }),
      ]);

      await db.insert(agentRuns).values([
        { organizationId: org, status: "succeeded", tokensUsed: 100, latencyMs: 1000 },
        { organizationId: org, status: "succeeded", tokensUsed: 200, latencyMs: 3000 },
        { organizationId: org, status: "escalated", tokensUsed: 50, latencyMs: 500 },
      ]);

      const pipeline = await getDocumentPipeline(org);
      expect(pipeline.total).toBe(5);
      expect(pipeline.byStatus.ready).toBe(2);
      expect(pipeline.byStatus.failed).toBe(1);
      expect(pipeline.byStatus.pending).toBe(1);
      expect(pipeline.byStatus.processing).toBe(1);
      expect(pipeline.stuck).toBe(1);

      const failed = await getFailedDocuments(org);
      expect(failed).toHaveLength(1);
      expect(failed[0].error).toBe("boom");

      const stuck = await getStuckDocuments(org);
      expect(stuck).toHaveLength(1);

      const agent = await getAgentMetrics(org);
      expect(agent.totalRuns).toBe(3);
      expect(agent.succeeded).toBe(2);
      expect(agent.escalated).toBe(1);
      expect(agent.failed).toBe(0);
      expect(agent.totalTokens).toBe(350);
      expect(agent.avgLatencyMs).toBe(1500);
    } finally {
      await dropOrg(org);
    }
  });

  it("scopes metrics to the org (no cross-tenant leakage)", async () => {
    const orgA = await freshOrg(`test-ops-a-${Date.now()}`);
    const orgB = await freshOrg(`test-ops-b-${Date.now()}`);
    try {
      await db.insert(documents).values([doc(orgA, "ready"), doc(orgA, "ready")]);
      await db.insert(documents).values([doc(orgB, "failed", { error: "x" })]);
      const a = await getDocumentPipeline(orgA);
      const b = await getDocumentPipeline(orgB);
      expect(a.total).toBe(2);
      expect(a.byStatus.failed ?? 0).toBe(0);
      expect(b.total).toBe(1);
      expect(b.byStatus.ready ?? 0).toBe(0);
    } finally {
      await dropOrg(orgA);
      await dropOrg(orgB);
    }
  });
});

describe("ops re-enqueue action", () => {
  it("is idempotent: a second re-enqueue while in flight is deduped", async () => {
    const org = await freshOrg(`test-reenqueue-${Date.now()}`);
    let documentId = "";
    try {
      const [d] = await db
        .insert(documents)
        .values(doc(org, "failed", { error: "boom" }))
        .returning({ id: documents.id });
      documentId = d.id;

      const first = await reenqueueDocument(org, documentId);
      const second = await reenqueueDocument(org, documentId);
      expect(first).toBe("enqueued");
      expect(second).toBe("deduped");

      // A document from another org is never reachable.
      const other = await reenqueueDocument("00000000-0000-0000-0000-000000000000", documentId);
      expect(other).toBe("not-found");
    } finally {
      try {
        await getQueues().ingestion.remove(ingestionJobId(documentId));
      } catch {
        // job may be locked/active; ignore in cleanup
      }
      await dropOrg(org);
    }
  });
});
