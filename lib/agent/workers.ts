import { Worker, QueueEvents, type Job, type ConnectionOptions } from "bullmq";
import { redisConnectionOptions } from "../queue/connection";
import {
  QUEUE_EMAIL,
  QUEUE_TRIAGE,
  enqueueTriage,
  type EmailJobData,
  type TriageJobData,
} from "../queue/queues";
import { processInboundEmail } from "../email/process";
import { runTriage } from "./agent";
import { backoffStrategy } from "../ingestion/workers";
import type { LogFn } from "../ingestion/pipeline";
import type { LLMProvider } from "../llm";
import type { EmbeddingProvider } from "../embeddings";
import type { Reranker } from "../reranking";

export interface TriageWorkerConfig {
  llm: LLMProvider;
  embeddingProvider: EmbeddingProvider;
  reranker: Reranker;
  log: LogFn;
  newConnection?: () => ConnectionOptions;
  prefix?: string;
  triageConcurrency?: number;
  triageMaxPerSecond?: number;
  backoff?: (attemptsMade: number) => number;
}

export interface TriageWorkerHandles {
  emailWorker: Worker<EmailJobData>;
  triageWorker: Worker<TriageJobData>;
  emailEvents: QueueEvents;
  triageEvents: QueueEvents;
  close: () => Promise<void>;
}

export function createTriageWorkers(config: TriageWorkerConfig): TriageWorkerHandles {
  const newConnection = config.newConnection ?? (() => redisConnectionOptions());
  const prefix = config.prefix;
  const strategy = config.backoff ?? backoffStrategy;
  const { log } = config;

  // ----- email-processing: inbound email -> ticket + message -> enqueue triage -----
  const emailWorker = new Worker<EmailJobData>(
    QUEUE_EMAIL,
    async (job: Job<EmailJobData>) =>
      processInboundEmail(job.data.organizationId, job.data.inboundEmailId, { enqueueTriage }),
    {
      connection: newConnection(),
      prefix,
      concurrency: 4,
      settings: { backoffStrategy: strategy },
    }
  );

  // ----- agent-triage: tool-calling triage run, logged to agent_runs -----
  const triageWorker = new Worker<TriageJobData>(
    QUEUE_TRIAGE,
    async (job: Job<TriageJobData>) =>
      runTriage(
        {
          organizationId: job.data.organizationId,
          ticketId: job.data.ticketId,
          triggeringMessageId: job.data.triggeringMessageId,
        },
        {
          llm: config.llm,
          embeddingProvider: config.embeddingProvider,
          reranker: config.reranker,
        }
      ),
    {
      connection: newConnection(),
      prefix,
      concurrency: config.triageConcurrency ?? 2,
      // Cap LLM calls/sec across workers so scaling out can't blow the provider's limit.
      limiter: { max: config.triageMaxPerSecond ?? 4, duration: 1000 },
      settings: { backoffStrategy: strategy },
    }
  );

  emailWorker.on("failed", (job, err) =>
    log("email.attempt.failed", { jobId: job?.id, error: err?.message })
  );
  emailWorker.on("completed", (job) => log("email.completed", { jobId: job.id }));
  triageWorker.on("failed", (job, err) =>
    log("triage.attempt.failed", {
      jobId: job?.id,
      ticketId: job?.data?.ticketId,
      attemptsMade: job?.attemptsMade,
      error: err?.message,
    })
  );
  triageWorker.on("completed", (job) =>
    log("triage.completed", { jobId: job.id, ticketId: job.data?.ticketId })
  );

  const emailEvents = new QueueEvents(QUEUE_EMAIL, { connection: newConnection(), prefix });
  const triageEvents = new QueueEvents(QUEUE_TRIAGE, { connection: newConnection(), prefix });
  for (const [name, qe] of [
    ["email", emailEvents],
    ["triage", triageEvents],
  ] as const) {
    qe.on("added", ({ jobId }) => log(`${name}.event.added`, { jobId }));
    qe.on("completed", ({ jobId }) => log(`${name}.event.completed`, { jobId }));
    qe.on("failed", ({ jobId, failedReason }) =>
      log(`${name}.event.failed`, { jobId, failedReason })
    );
  }

  const close = async () => {
    await Promise.allSettled([
      emailWorker.close(),
      triageWorker.close(),
      emailEvents.close(),
      triageEvents.close(),
    ]);
  };

  return { emailWorker, triageWorker, emailEvents, triageEvents, close };
}
