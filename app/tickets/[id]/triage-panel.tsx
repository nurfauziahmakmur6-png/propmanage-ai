"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export interface Citation {
  title?: string;
  page?: number;
}

export interface DraftReply {
  id: string;
  body: string;
  citations: Citation[];
  createdAt: string;
}

export interface AgentRun {
  status: string;
  toolsCalled: string[];
  tokensUsed: number | null;
  latencyMs: number | null;
  createdAt: string;
}

interface TriagePanelProps {
  ticketId: string;
  draft: DraftReply | null;
  escalation: { reason: string | null; at: string } | null;
  agentRun: AgentRun | null;
}

export function TriagePanel({ ticketId, draft, escalation, agentRun }: TriagePanelProps) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(draft?.body ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function approve() {
    setBusy("approve");
    setError(null);
    try {
      const res = await fetch(`/api/tickets/${ticketId}/messages/${draft!.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editing ? { body } : {}),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Approve failed");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Approve failed");
    } finally {
      setBusy(null);
    }
  }

  async function escalate() {
    setBusy("escalate");
    setError(null);
    try {
      const res = await fetch(`/api/tickets/${ticketId}/escalate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Escalated by staff from the ticket view." }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Escalate failed");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Escalate failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-lg border border-purple-200 bg-purple-50/60 p-5 mb-6">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-purple-900 flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-purple-500" />
          AI Triage
        </h2>
        {agentRun && <AgentTrace run={agentRun} />}
      </div>

      {escalation ? (
        <div className="rounded-md bg-amber-50 border border-amber-200 p-4">
          <p className="text-sm font-medium text-amber-900">Escalated to a human</p>
          {escalation.reason && (
            <p className="text-sm text-amber-800 mt-1">{escalation.reason}</p>
          )}
        </div>
      ) : draft ? (
        <div className="rounded-md bg-white border border-gray-200 p-4">
          <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">
            Draft reply (awaiting approval)
          </p>
          {editing ? (
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={6}
              className="w-full border border-gray-300 rounded p-2 text-sm text-gray-800"
            />
          ) : (
            <p className="text-sm text-gray-800 whitespace-pre-wrap">{draft.body}</p>
          )}

          {draft.citations.length > 0 && (
            <div className="mt-3">
              <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-1">
                Sources
              </p>
              <ul className="text-xs text-gray-600 space-y-0.5">
                {draft.citations.map((c, i) => (
                  <li key={i}>
                    [{i + 1}] {c.title ?? "Document"}
                    {c.page ? ` · page ${c.page}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex items-center gap-2 mt-4">
            <button
              onClick={approve}
              disabled={busy !== null}
              className="bg-green-600 text-white text-sm px-4 py-1.5 rounded hover:bg-green-700 disabled:opacity-50"
            >
              {busy === "approve" ? "Sending…" : editing ? "Save & send" : "Approve & send"}
            </button>
            <button
              onClick={() => setEditing((v) => !v)}
              disabled={busy !== null}
              className="text-sm px-4 py-1.5 rounded border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {editing ? "Cancel edit" : "Edit"}
            </button>
            <button
              onClick={escalate}
              disabled={busy !== null}
              className="text-sm px-4 py-1.5 rounded border border-amber-300 text-amber-700 hover:bg-amber-50 disabled:opacity-50"
            >
              {busy === "escalate" ? "Escalating…" : "Escalate"}
            </button>
          </div>
        </div>
      ) : (
        <div className="rounded-md bg-white border border-gray-200 p-4 flex items-center justify-between">
          <p className="text-sm text-gray-500">
            No AI draft yet — the triage agent may still be running.
          </p>
          <button
            onClick={escalate}
            disabled={busy !== null}
            className="text-sm px-4 py-1.5 rounded border border-amber-300 text-amber-700 hover:bg-amber-50 disabled:opacity-50"
          >
            {busy === "escalate" ? "Escalating…" : "Escalate"}
          </button>
        </div>
      )}

      {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
    </div>
  );
}

function AgentTrace({ run }: { run: AgentRun }) {
  return (
    <div className="text-xs text-purple-700/80 flex items-center gap-3">
      <span title="tools called">
        {run.toolsCalled.length > 0 ? run.toolsCalled.join(" → ") : "no tools"}
      </span>
      {run.latencyMs != null && <span>· {(run.latencyMs / 1000).toFixed(1)}s</span>}
      {run.tokensUsed != null && <span>· {run.tokensUsed} tok</span>}
      <span>· {run.status}</span>
    </div>
  );
}
