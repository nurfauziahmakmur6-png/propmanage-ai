import { Queue, type JobsOptions } from "bullmq";
import { redisConnectionOptions } from "./connection";

export const QUEUE_INGESTION = "document-ingestion";
export const QUEUE_EMBED = "embed-batch";
export const QUEUE_MAINTENANCE = "maintenance";

export const JOB_INGEST = "ingest-document";
export const JOB_EMBED_BATCH = "embed-batch";
export const JOB_SWEEP = "sweep-stuck-documents";

// How many chunks each embed-batch child handles. Keeps individual jobs short and lets
// one failed batch retry without restarting the whole document.
export const EMBED_BATCH_SIZE = 32;

export const MAX_ATTEMPTS = 5;

// Documents in `processing` longer than this are considered stuck and re-enqueued.
export const STUCK_TIMEOUT_MS = 5 * 60 * 1000;
export const SWEEP_INTERVAL_MS = 2 * 60 * 1000;

// Custom backoff name resolved by the worker's backoffStrategy (exponential + jitter).
export const BACKOFF: JobsOptions["backoff"] = { type: "exponential-jitter", delay: 1000 };

export interface IngestionJobData {
  documentId: string;
  organizationId: string;
  phase?: "split" | "finalize";
}

export interface EmbedBatchJobData {
  documentId: string;
  organizationId: string;
  batchIndex: number;
  fromChunkIndex: number;
  toChunkIndex: number; // inclusive
}

export interface SweepJobData {
  reason?: string;
}

type Queues = {
  ingestion: Queue<IngestionJobData>;
  embed: Queue<EmbedBatchJobData>;
  maintenance: Queue<SweepJobData>;
};

let queues: Queues | null = null;

export function getQueues(): Queues {
  if (queues) return queues;
  const connection = redisConnectionOptions();
  queues = {
    ingestion: new Queue<IngestionJobData>(QUEUE_INGESTION, { connection }),
    embed: new Queue<EmbedBatchJobData>(QUEUE_EMBED, { connection }),
    maintenance: new Queue<SweepJobData>(QUEUE_MAINTENANCE, { connection }),
  };
  return queues;
}

// BullMQ v5 forbids ":" in custom job ids (it is the Redis key separator), so the
// deterministic ids use "__" instead.
export function ingestionJobId(documentId: string): string {
  return `doc-ingest__${documentId}`;
}

export function embedBatchJobId(documentId: string, batchIndex: number): string {
  return `embed-batch__${documentId}__${batchIndex}`;
}

/**
 * Enqueue (or re-drive) a document's ingestion. The deterministic job id makes a
 * duplicate upload a no-op while a pipeline is still active. When `force` is set
 * (the sweeper), a finished job in the same id is cleared first so the document can
 * be re-driven; an active/waiting job is left alone.
 */
export async function enqueueIngestion(
  data: IngestionJobData,
  opts: { force?: boolean } = {}
): Promise<"enqueued" | "deduped"> {
  const { ingestion } = getQueues();
  const jobId = ingestionJobId(data.documentId);
  const existing = await ingestion.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === "completed" || state === "failed") {
      if (!opts.force) return "deduped";
      await existing.remove();
    } else {
      // waiting | active | delayed | waiting-children -> pipeline already in flight
      return "deduped";
    }
  }
  await ingestion.add(
    JOB_INGEST,
    { ...data, phase: "split" },
    {
      jobId,
      attempts: MAX_ATTEMPTS,
      backoff: BACKOFF,
      removeOnComplete: { age: 24 * 3600 },
      // Keep failures so they remain visible in the failed set for ops.
      removeOnFail: false,
    }
  );
  return "enqueued";
}
