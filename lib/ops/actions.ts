import { eq } from "drizzle-orm";
import { db } from "../../db";
import { documents } from "../../db/schema";
import { withOrgFilter } from "../withOrg";
import {
  enqueueIngestion,
  getQueues,
  QUEUE_INGESTION,
  QUEUE_EMBED,
  QUEUE_MAINTENANCE,
  QUEUE_EMAIL,
  QUEUE_TRIAGE,
} from "../queue/queues";

export type ReenqueueResult = "enqueued" | "deduped" | "not-found";

/**
 * Re-drive a document's ingestion. Org-scoped: the document must belong to the caller's org,
 * so the action can never touch another tenant's data. Idempotent via the deterministic job
 * id — a second click while a pipeline is in flight is a no-op ("deduped").
 */
export async function reenqueueDocument(
  organizationId: string,
  documentId: string
): Promise<ReenqueueResult> {
  const [doc] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(withOrgFilter(organizationId, documents, eq(documents.id, documentId)));
  if (!doc) return "not-found";
  return enqueueIngestion({ documentId, organizationId }, { force: true });
}

const QUEUE_BY_NAME = () => {
  const q = getQueues();
  return {
    [QUEUE_INGESTION]: q.ingestion,
    [QUEUE_EMBED]: q.embed,
    [QUEUE_MAINTENANCE]: q.maintenance,
    [QUEUE_EMAIL]: q.email,
    [QUEUE_TRIAGE]: q.triage,
  } as const;
};

export type RetryResult = "retried" | "not-found" | "not-failed" | "unknown-queue";

/**
 * Retry one job from a queue's failed set. Guarded: only a known queue and only a job that
 * is actually in the failed state. Queues are infrastructure (not per-tenant), so this is an
 * operator action rather than tenant data.
 */
export async function retryFailedJob(queueName: string, jobId: string): Promise<RetryResult> {
  const queues = QUEUE_BY_NAME();
  const queue = queues[queueName as keyof typeof queues];
  if (!queue) return "unknown-queue";
  const job = await queue.getJob(jobId);
  if (!job) return "not-found";
  const state = await job.getState();
  if (state !== "failed") return "not-failed";
  await job.retry();
  return "retried";
}
