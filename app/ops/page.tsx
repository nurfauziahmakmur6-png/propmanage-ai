import { getOpsMetrics } from "@/lib/ops/metrics";
import { ReenqueueButton, RetryJobButton, RefreshButton } from "./ops-actions";

const DEMO_ORG_ID = process.env.DEMO_ORG_ID ?? "";

export const dynamic = "force-dynamic";

const RUN_STATUS_COLORS: Record<string, string> = {
  succeeded: "bg-green-100 text-green-800",
  escalated: "bg-amber-100 text-amber-800",
  failed: "bg-red-100 text-red-800",
};

const DOC_STATUS_COLORS: Record<string, string> = {
  pending: "bg-gray-100 text-gray-700",
  processing: "bg-blue-100 text-blue-800",
  ready: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
};

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <p className="text-xs font-medium text-gray-400 uppercase tracking-wide">{label}</p>
      <p className="text-2xl font-bold text-gray-900 mt-1">{value}</p>
      {hint && <p className="text-xs text-gray-500 mt-0.5">{hint}</p>}
    </div>
  );
}

export default async function OpsPage() {
  const m = await getOpsMetrics(DEMO_ORG_ID);
  const nothingBroken =
    m.failedJobs.length === 0 && m.failedDocuments.length === 0 && m.stuckDocuments.length === 0;

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Operations</h1>
          <p className="text-sm text-gray-500 mt-1">
            Queue health, document pipeline, and agent cost/latency.
          </p>
        </div>
        <RefreshButton />
      </div>

      {/* Queue health */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-2">
          Queue health <span className="font-normal text-gray-400">· system-wide</span>
        </h2>
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left font-medium px-4 py-2">Queue</th>
                <th className="text-right font-medium px-4 py-2">Waiting</th>
                <th className="text-right font-medium px-4 py-2">Active</th>
                <th className="text-right font-medium px-4 py-2">Completed</th>
                <th className="text-right font-medium px-4 py-2">Failed</th>
                <th className="text-right font-medium px-4 py-2">Delayed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {m.queues.map((q) => (
                <tr key={q.queue}>
                  <td className="px-4 py-2 font-mono text-xs text-gray-800">{q.queue}</td>
                  <td className="px-4 py-2 text-right text-gray-700">{q.waiting}</td>
                  <td className="px-4 py-2 text-right text-gray-700">{q.active}</td>
                  <td className="px-4 py-2 text-right text-gray-700">{q.completed}</td>
                  <td className={`px-4 py-2 text-right ${q.failed > 0 ? "text-red-600 font-semibold" : "text-gray-700"}`}>
                    {q.failed}
                  </td>
                  <td className="px-4 py-2 text-right text-gray-700">{q.delayed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Document pipeline */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-2">Document pipeline</h2>
        <div className="flex flex-wrap gap-2">
          {(["pending", "processing", "ready", "failed"] as const).map((s) => (
            <span
              key={s}
              className={`text-sm px-3 py-1.5 rounded-full font-medium ${DOC_STATUS_COLORS[s]}`}
            >
              {s}: {m.documents.byStatus[s] ?? 0}
            </span>
          ))}
          <span className="text-sm px-3 py-1.5 rounded-full font-medium bg-gray-100 text-gray-700">
            total: {m.documents.total}
          </span>
          {m.documents.stuck > 0 && (
            <span className="text-sm px-3 py-1.5 rounded-full font-medium bg-orange-100 text-orange-800">
              stuck in processing: {m.documents.stuck}
            </span>
          )}
        </div>
      </section>

      {/* Agent metrics */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-2">
          Agent runs <span className="font-normal text-gray-400">· cost &amp; latency</span>
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          <Stat label="Total runs" value={m.agent.totalRuns} />
          <Stat
            label="Outcomes"
            value={`${m.agent.succeeded}/${m.agent.escalated}/${m.agent.failed}`}
            hint="succeeded / escalated / failed"
          />
          <Stat label="Avg latency" value={`${(m.agent.avgLatencyMs / 1000).toFixed(2)}s`} />
          <Stat
            label="Tokens"
            value={m.agent.totalTokens.toLocaleString()}
            hint={`avg ${m.agent.avgTokens}/run`}
          />
        </div>

        {m.recentRuns.length > 0 && (
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left font-medium px-4 py-2">Ticket</th>
                  <th className="text-left font-medium px-4 py-2">Tools</th>
                  <th className="text-right font-medium px-4 py-2">Latency</th>
                  <th className="text-right font-medium px-4 py-2">Tokens</th>
                  <th className="text-right font-medium px-4 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {m.recentRuns.map((r) => (
                  <tr key={r.id}>
                    <td className="px-4 py-2 text-gray-800 max-w-xs truncate">
                      {r.ticketTitle ?? r.ticketId ?? "—"}
                    </td>
                    <td className="px-4 py-2 text-xs text-gray-500 font-mono">
                      {r.tools.join(" → ") || "—"}
                    </td>
                    <td className="px-4 py-2 text-right text-gray-700">
                      {r.latencyMs != null ? `${(r.latencyMs / 1000).toFixed(1)}s` : "—"}
                    </td>
                    <td className="px-4 py-2 text-right text-gray-700">{r.tokensUsed ?? "—"}</td>
                    <td className="px-4 py-2 text-right">
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full font-medium ${RUN_STATUS_COLORS[r.status] ?? "bg-gray-100 text-gray-700"}`}
                      >
                        {r.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Problems + actions */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-2">Needs attention</h2>
        {nothingBroken ? (
          <div className="bg-green-50 border border-green-200 rounded-lg p-6 text-center">
            <p className="text-sm text-green-800 font-medium">
              All clear — no failed jobs, no failed documents, nothing stuck.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {m.failedDocuments.length > 0 && (
              <div className="bg-white rounded-lg border border-gray-200 p-4">
                <p className="text-sm font-medium text-gray-800 mb-3">
                  Failed documents ({m.failedDocuments.length})
                </p>
                <ul className="space-y-2">
                  {m.failedDocuments.map((d) => (
                    <li key={d.id} className="flex items-center justify-between gap-4 text-sm">
                      <span className="min-w-0">
                        <span className="text-gray-800">{d.title}</span>
                        {d.error && <span className="text-gray-400 ml-2 text-xs">{d.error}</span>}
                      </span>
                      <ReenqueueButton documentId={d.id} />
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {m.stuckDocuments.length > 0 && (
              <div className="bg-white rounded-lg border border-gray-200 p-4">
                <p className="text-sm font-medium text-gray-800 mb-3">
                  Stuck in processing ({m.stuckDocuments.length})
                </p>
                <ul className="space-y-2">
                  {m.stuckDocuments.map((d) => (
                    <li key={d.id} className="flex items-center justify-between gap-4 text-sm">
                      <span className="text-gray-800">{d.title}</span>
                      <ReenqueueButton documentId={d.id} />
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {m.failedJobs.length > 0 && (
              <div className="bg-white rounded-lg border border-gray-200 p-4">
                <p className="text-sm font-medium text-gray-800 mb-3">
                  Failed jobs ({m.failedJobs.length})
                </p>
                <ul className="space-y-2">
                  {m.failedJobs.map((j) => (
                    <li key={`${j.queue}:${j.jobId}`} className="flex items-center justify-between gap-4 text-sm">
                      <span className="min-w-0">
                        <span className="font-mono text-xs text-gray-600">{j.queue}</span>
                        <span className="text-gray-400 ml-2 text-xs">
                          {j.failedReason ?? j.name} · {j.attemptsMade} attempts
                        </span>
                      </span>
                      <RetryJobButton queue={j.queue} jobId={j.jobId} />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
