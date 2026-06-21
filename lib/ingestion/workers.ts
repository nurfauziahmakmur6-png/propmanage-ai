import {
  Worker,
  QueueEvents,
  Queue,
  WaitingChildrenError,
  type Job,
  type ConnectionOptions,
} from "bullmq";
import { redisConnectionOptions } from "../queue/connection";
import {
  QUEUE_INGESTION,
  QUEUE_EMBED,
  QUEUE_MAINTENANCE,
  JOB_EMBED_BATCH,
  MAX_ATTEMPTS,
  BACKOFF,
  embedBatchJobId,
  type IngestionJobData,
  type EmbedBatchJobData,
  type SweepJobData,
} from "../queue/queues";
import {
  splitDocument,
  runEmbedBatch,
  finalizeDocument,
  markFailed,
  type PipelineDeps,
  type LogFn,
} from "./pipeline";
import { sweepStuckDocuments } from "./sweeper";

// Exponential backoff with jitter, capped at 30s. Jitter spreads retries so a batch of
// jobs that failed together (e.g. a transient outage) does not retry in lockstep.
export function backoffStrategy(attemptsMade: number): number {
  const base = Math.min(1000 * 2 ** Math.max(0, attemptsMade - 1), 30_000);
  const jitter = Math.random() * base * 0.25;
  return Math.floor(base + jitter);
}

export interface WorkerHandles {
  ingestionWorker: Worker<IngestionJobData>;
  embedWorker: Worker<EmbedBatchJobData>;
  maintenanceWorker?: Worker<SweepJobData>;
  ingestionEvents: QueueEvents;
  embedEvents: QueueEvents;
  close: () => Promise<void>;
}

export interface WorkerConfig {
  deps: PipelineDeps;
  log: LogFn;
  embedConcurrency?: number;
  embedMaxPerSecond?: number;
  ingestionConcurrency?: number;
  // Each worker/QueueEvents needs its own blocking connection.
  newConnection?: () => ConnectionOptions;
  // Isolates a test's queues from a running dev worker (default "bull").
  prefix?: string;
  includeMaintenance?: boolean;
  // Tests inject a fast backoff so retry exhaustion does not take ~15s.
  backoff?: (attemptsMade: number) => number;
}

export function createWorkers(config: WorkerConfig): WorkerHandles {
  const { deps, log } = config;
  const newConnection = config.newConnection ?? (() => redisConnectionOptions());
  const prefix = config.prefix;
  const strategy = config.backoff ?? backoffStrategy;
  const includeMaintenance = config.includeMaintenance ?? true;

  // Queue handle used by the parent to fan out children, on the same prefix as the
  // workers so test isolation holds.
  const embedQueue = new Queue<EmbedBatchJobData>(QUEUE_EMBED, {
    connection: newConnection(),
    prefix,
  });

  // ----- Parent: document-ingestion (re-entrant split -> wait -> finalize) -----
  const ingestionWorker = new Worker<IngestionJobData>(
    QUEUE_INGESTION,
    async (job: Job<IngestionJobData>, token?: string) => {
      const phase = job.data.phase ?? "split";

      if (phase === "split") {
        const batches = await splitDocument(job.data, deps);
        for (const b of batches) {
          await embedQueue.add(
            JOB_EMBED_BATCH,
            {
              documentId: job.data.documentId,
              organizationId: job.data.organizationId,
              batchIndex: b.batchIndex,
              fromChunkIndex: b.fromChunkIndex,
              toChunkIndex: b.toChunkIndex,
            },
            {
              jobId: embedBatchJobId(job.data.documentId, b.batchIndex),
              parent: { id: job.id!, queue: job.queueQualifiedName },
              attempts: MAX_ATTEMPTS,
              backoff: BACKOFF,
              // A permanently failed batch is ignored as a dependency so the parent is
              // still promoted to finalize, where the DB-truth check (any unembedded
              // chunk) marks the document failed. The failed child stays in the failed
              // set for observability.
              ignoreDependencyOnFailure: true,
              removeOnComplete: { age: 24 * 3600 },
              removeOnFail: false,
            }
          );
        }
        await job.updateData({ ...job.data, phase: "finalize" });
        const shouldWait = await job.moveToWaitingChildren(token!);
        if (shouldWait) throw new WaitingChildrenError();
      }

      return finalizeDocument(job.data, deps);
    },
    {
      connection: newConnection(),
      prefix,
      concurrency: config.ingestionConcurrency ?? 4,
      settings: { backoffStrategy: strategy },
    }
  );

  // ----- Children: embed-batch (capped concurrency + rate limiter) -----
  const embedWorker = new Worker<EmbedBatchJobData>(
    QUEUE_EMBED,
    async (job: Job<EmbedBatchJobData>) => runEmbedBatch(job.data, deps),
    {
      connection: newConnection(),
      prefix,
      concurrency: config.embedConcurrency ?? 2,
      // Global token-bucket across all workers on this queue, so scaling workers can't
      // overwhelm the embedder.
      limiter: { max: config.embedMaxPerSecond ?? 8, duration: 1000 },
      settings: { backoffStrategy: strategy },
    }
  );

  // ----- Maintenance: stuck-document sweeper -----
  const maintenanceWorker = includeMaintenance
    ? new Worker<SweepJobData>(QUEUE_MAINTENANCE, async () => sweepStuckDocuments(log), {
        connection: newConnection(),
        prefix,
        concurrency: 1,
      })
    : undefined;

  // The parent only marks the document failed once it has truly exhausted retries (or a
  // child force-failed it). getState() === "failed" distinguishes terminal failure from
  // an intermediate attempt that will still be retried.
  ingestionWorker.on("failed", async (job, err) => {
    if (!job) return;
    log("ingestion.attempt.failed", {
      jobId: job.id,
      documentId: job.data?.documentId,
      attemptsMade: job.attemptsMade,
      error: err?.message,
    });
    try {
      const state = await job.getState();
      if (state === "failed") {
        await markFailed(
          job.data.documentId,
          job.data.organizationId,
          err?.message ?? "unknown error"
        );
        log("ingestion.terminal.failed", { documentId: job.data.documentId });
      }
    } catch (e) {
      log("ingestion.failed_handler.error", { error: String(e) });
    }
  });

  ingestionWorker.on("completed", (job) => {
    log("ingestion.completed", { jobId: job.id, documentId: job.data?.documentId });
  });

  embedWorker.on("failed", (job, err) => {
    log("embed.attempt.failed", {
      jobId: job?.id,
      documentId: job?.data?.documentId,
      attemptsMade: job?.attemptsMade,
      error: err?.message,
    });
  });

  // ----- QueueEvents: structured job-lifecycle logging keyed by jobId (encodes docId) -----
  const ingestionEvents = new QueueEvents(QUEUE_INGESTION, {
    connection: newConnection(),
    prefix,
  });
  const embedEvents = new QueueEvents(QUEUE_EMBED, { connection: newConnection(), prefix });
  const lifecycle: Array<[string, QueueEvents]> = [
    ["ingestion", ingestionEvents],
    ["embed", embedEvents],
  ];
  for (const [name, qe] of lifecycle) {
    qe.on("added", ({ jobId }) => log(`${name}.event.added`, { jobId }));
    qe.on("active", ({ jobId }) => log(`${name}.event.active`, { jobId }));
    qe.on("completed", ({ jobId }) => log(`${name}.event.completed`, { jobId }));
    qe.on("failed", ({ jobId, failedReason }) =>
      log(`${name}.event.failed`, { jobId, failedReason })
    );
    qe.on("stalled", ({ jobId }) => log(`${name}.event.stalled`, { jobId }));
  }

  const close = async () => {
    await Promise.allSettled([
      ingestionWorker.close(),
      embedWorker.close(),
      maintenanceWorker?.close(),
      ingestionEvents.close(),
      embedEvents.close(),
      embedQueue.close(),
    ]);
  };

  return {
    ingestionWorker,
    embedWorker,
    maintenanceWorker,
    ingestionEvents,
    embedEvents,
    close,
  };
}
