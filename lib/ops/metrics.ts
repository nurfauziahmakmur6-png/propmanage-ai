import type { Queue } from "bullmq";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { documents, agentRuns, tickets } from "../../db/schema";
import { withOrgFilter } from "../withOrg";
import {
  getQueues,
  STUCK_TIMEOUT_MS,
  QUEUE_INGESTION,
  QUEUE_EMBED,
  QUEUE_MAINTENANCE,
  QUEUE_EMAIL,
  QUEUE_TRIAGE,
} from "../queue/queues";

export interface QueueHealth {
  queue: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}

export interface DocumentPipeline {
  byStatus: Record<string, number>;
  total: number;
  stuck: number;
}

export interface AgentMetrics {
  totalRuns: number;
  succeeded: number;
  escalated: number;
  failed: number;
  avgLatencyMs: number;
  totalTokens: number;
  avgTokens: number;
}

export interface RecentRun {
  id: string;
  ticketId: string | null;
  ticketTitle: string | null;
  status: string;
  tools: string[];
  tokensUsed: number | null;
  latencyMs: number | null;
  createdAt: string;
}

export interface FailedDoc {
  id: string;
  title: string;
  error: string | null;
  updatedAt: string;
}

export interface StuckDoc {
  id: string;
  title: string;
  updatedAt: string;
}

export interface FailedJob {
  queue: string;
  jobId: string;
  name: string;
  failedReason: string | null;
  attemptsMade: number;
}

export interface OpsMetrics {
  queues: QueueHealth[];
  documents: DocumentPipeline;
  agent: AgentMetrics;
  recentRuns: RecentRun[];
  failedDocuments: FailedDoc[];
  stuckDocuments: StuckDoc[];
  failedJobs: FailedJob[];
}

// Queue counts are system-wide (BullMQ queues are shared infrastructure, not per-tenant);
// everything else on the page is org-scoped.
export async function getQueueHealth(): Promise<QueueHealth[]> {
  const q = getQueues();
  const entries: Array<[string, Queue]> = [
    [QUEUE_INGESTION, q.ingestion],
    [QUEUE_EMBED, q.embed],
    [QUEUE_MAINTENANCE, q.maintenance],
    [QUEUE_EMAIL, q.email],
    [QUEUE_TRIAGE, q.triage],
  ];
  return Promise.all(
    entries.map(async ([name, queue]) => {
      const c = await queue.getJobCounts("waiting", "active", "completed", "failed", "delayed");
      return {
        queue: name,
        waiting: c.waiting ?? 0,
        active: c.active ?? 0,
        completed: c.completed ?? 0,
        failed: c.failed ?? 0,
        delayed: c.delayed ?? 0,
      };
    })
  );
}

const cutoffSeconds = Math.floor(STUCK_TIMEOUT_MS / 1000);
// Same predicate the sweeper uses: processing rows whose updatedAt is past the timeout.
const stuckPredicate = sql`${documents.status} = 'processing' and ${documents.updatedAt}::timestamptz < now() - make_interval(secs => ${cutoffSeconds})`;

export async function getDocumentPipeline(organizationId: string): Promise<DocumentPipeline> {
  const rows = await db
    .select({ status: documents.status, count: sql<number>`count(*)::int` })
    .from(documents)
    .where(withOrgFilter(organizationId, documents))
    .groupBy(documents.status);

  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    byStatus[r.status] = Number(r.count);
    total += Number(r.count);
  }

  const [stuckRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(documents)
    .where(withOrgFilter(organizationId, documents, stuckPredicate));

  return { byStatus, total, stuck: Number(stuckRow?.count ?? 0) };
}

export async function getAgentMetrics(organizationId: string): Promise<AgentMetrics> {
  const [agg] = await db
    .select({
      total: sql<number>`count(*)::int`,
      succeeded: sql<number>`count(*) filter (where ${agentRuns.status} = 'succeeded')::int`,
      escalated: sql<number>`count(*) filter (where ${agentRuns.status} = 'escalated')::int`,
      failed: sql<number>`count(*) filter (where ${agentRuns.status} = 'failed')::int`,
      avgLatency: sql<number>`coalesce(avg(${agentRuns.latencyMs}), 0)::int`,
      totalTokens: sql<number>`coalesce(sum(${agentRuns.tokensUsed}), 0)::int`,
      avgTokens: sql<number>`coalesce(avg(${agentRuns.tokensUsed}), 0)::int`,
    })
    .from(agentRuns)
    .where(withOrgFilter(organizationId, agentRuns));

  return {
    totalRuns: Number(agg?.total ?? 0),
    succeeded: Number(agg?.succeeded ?? 0),
    escalated: Number(agg?.escalated ?? 0),
    failed: Number(agg?.failed ?? 0),
    avgLatencyMs: Number(agg?.avgLatency ?? 0),
    totalTokens: Number(agg?.totalTokens ?? 0),
    avgTokens: Number(agg?.avgTokens ?? 0),
  };
}

function toolNames(toolCalls: unknown): string[] {
  if (!Array.isArray(toolCalls)) return [];
  return (toolCalls as Array<{ name?: string }>).map((c) => c.name ?? "?");
}

export async function getRecentRuns(organizationId: string, limit = 10): Promise<RecentRun[]> {
  const rows = await db
    .select({
      id: agentRuns.id,
      ticketId: agentRuns.ticketId,
      ticketTitle: tickets.title,
      status: agentRuns.status,
      toolCalls: agentRuns.toolCalls,
      tokensUsed: agentRuns.tokensUsed,
      latencyMs: agentRuns.latencyMs,
      createdAt: agentRuns.createdAt,
    })
    .from(agentRuns)
    .leftJoin(tickets, eq(agentRuns.ticketId, tickets.id))
    .where(withOrgFilter(organizationId, agentRuns))
    .orderBy(desc(agentRuns.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    ticketId: r.ticketId,
    ticketTitle: r.ticketTitle,
    status: r.status,
    tools: toolNames(r.toolCalls),
    tokensUsed: r.tokensUsed,
    latencyMs: r.latencyMs,
    createdAt: r.createdAt,
  }));
}

export async function getFailedDocuments(organizationId: string): Promise<FailedDoc[]> {
  const rows = await db
    .select({
      id: documents.id,
      title: documents.title,
      error: documents.error,
      updatedAt: documents.updatedAt,
    })
    .from(documents)
    .where(withOrgFilter(organizationId, documents, eq(documents.status, "failed")))
    .orderBy(desc(documents.updatedAt))
    .limit(50);
  return rows;
}

export async function getStuckDocuments(organizationId: string): Promise<StuckDoc[]> {
  const rows = await db
    .select({ id: documents.id, title: documents.title, updatedAt: documents.updatedAt })
    .from(documents)
    .where(withOrgFilter(organizationId, documents, stuckPredicate))
    .orderBy(desc(documents.updatedAt))
    .limit(50);
  return rows;
}

// Lists actual failed jobs (not just counts) so each can be retried from the ops view.
export async function getFailedJobs(limitPerQueue = 20): Promise<FailedJob[]> {
  const q = getQueues();
  const entries: Array<[string, Queue]> = [
    [QUEUE_INGESTION, q.ingestion],
    [QUEUE_EMBED, q.embed],
    [QUEUE_MAINTENANCE, q.maintenance],
    [QUEUE_EMAIL, q.email],
    [QUEUE_TRIAGE, q.triage],
  ];
  const all: FailedJob[] = [];
  for (const [name, queue] of entries) {
    const jobs = await queue.getFailed(0, limitPerQueue - 1);
    for (const j of jobs) {
      all.push({
        queue: name,
        jobId: j.id ?? "",
        name: j.name,
        failedReason: j.failedReason ?? null,
        attemptsMade: j.attemptsMade,
      });
    }
  }
  return all;
}

export async function getOpsMetrics(organizationId: string): Promise<OpsMetrics> {
  const [queues, documentsPipeline, agent, recentRuns, failedDocuments, stuckDocuments, failedJobs] =
    await Promise.all([
      getQueueHealth(),
      getDocumentPipeline(organizationId),
      getAgentMetrics(organizationId),
      getRecentRuns(organizationId),
      getFailedDocuments(organizationId),
      getStuckDocuments(organizationId),
      getFailedJobs(),
    ]);
  return {
    queues,
    documents: documentsPipeline,
    agent,
    recentRuns,
    failedDocuments,
    stuckDocuments,
    failedJobs,
  };
}
