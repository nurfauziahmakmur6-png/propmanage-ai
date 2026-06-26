import "./lib/env"; // MUST be first: loads .env.local before db/queue read env

import { getQueues, JOB_SWEEP, SWEEP_INTERVAL_MS } from "./lib/queue/queues";
import { getEmbeddingProvider } from "./lib/embeddings";
import { getReranker } from "./lib/reranking";
import { getLLMProvider, type LLMProvider } from "./lib/llm";
import { getStorageProvider, documentStorageKey } from "./lib/storage";
import { extractPdfPages } from "./lib/ingestion/extract";
import type { PipelineDeps, LogFn } from "./lib/ingestion/pipeline";
import { createWorkers } from "./lib/ingestion/workers";
import { createTriageWorkers } from "./lib/agent/workers";

const log: LogFn = (event, fields) => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
};

const storage = getStorageProvider();
const embeddingProvider = getEmbeddingProvider();

const deps: PipelineDeps = {
  embeddingProvider,
  loadPages: async (documentId, organizationId) => {
    const key = documentStorageKey(organizationId, documentId);
    const buffer = await storage.read(key);
    return extractPdfPages(buffer);
  },
  log,
};

const handles = createWorkers({
  deps,
  log,
  embedConcurrency: Number(process.env.EMBED_CONCURRENCY ?? 2),
  embedMaxPerSecond: Number(process.env.EMBED_MAX_PER_SEC ?? 8),
});

// Resolve the LLM lazily so the worker process still starts (and ingestion still runs)
// when GROQ_API_KEY is absent; only triage jobs then fail until it is set.
const lazyLlm: LLMProvider = {
  id: "lazy",
  complete: (opts) => getLLMProvider().complete(opts),
  chat: (opts) => getLLMProvider().chat(opts),
};

const triageHandles = createTriageWorkers({
  llm: lazyLlm,
  embeddingProvider,
  reranker: getReranker(),
  log,
  triageConcurrency: Number(process.env.TRIAGE_CONCURRENCY ?? 2),
  triageMaxPerSecond: Number(process.env.TRIAGE_MAX_PER_SEC ?? 4),
});

async function scheduleSweeper(): Promise<void> {
  // Repeatable job; the fixed jobId keeps a single schedule even across restarts.
  await getQueues().maintenance.add(
    JOB_SWEEP,
    {},
    {
      repeat: { every: SWEEP_INTERVAL_MS },
      jobId: "sweep-schedule",
      removeOnComplete: true,
      removeOnFail: true,
    }
  );
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log("worker.shutdown", { signal });
  await Promise.allSettled([handles.close(), triageHandles.close()]);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

scheduleSweeper()
  .then(() => {
    log("worker.started", {
      embedder: embeddingProvider.id,
      dimensions: embeddingProvider.dimensions,
      sweepIntervalMs: SWEEP_INTERVAL_MS,
      queues: ["document-ingestion", "embed-batch", "maintenance", "email-processing", "agent-triage"],
    });
  })
  .catch((err) => {
    log("worker.start_failed", { error: String(err) });
    process.exit(1);
  });
