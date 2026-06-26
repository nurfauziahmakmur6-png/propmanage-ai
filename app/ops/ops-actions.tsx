"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  async function run(url: string) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(url, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      setMsg(data.result ?? data.error ?? (res.ok ? "done" : "failed"));
      router.refresh();
    } catch {
      setMsg("error");
    } finally {
      setBusy(false);
    }
  }
  return { busy, msg, run };
}

export function ReenqueueButton({ documentId }: { documentId: string }) {
  const { busy, msg, run } = useAction();
  return (
    <span className="flex items-center gap-2">
      <button
        onClick={() => run(`/api/ops/documents/${documentId}/reenqueue`)}
        disabled={busy}
        className="text-xs px-3 py-1 rounded border border-blue-300 text-blue-700 hover:bg-blue-50 disabled:opacity-50"
      >
        {busy ? "Re-enqueuing…" : "Re-enqueue"}
      </button>
      {msg && <span className="text-xs text-gray-500">{msg}</span>}
    </span>
  );
}

export function RetryJobButton({ queue, jobId }: { queue: string; jobId: string }) {
  const { busy, msg, run } = useAction();
  return (
    <span className="flex items-center gap-2">
      <button
        onClick={() => run(`/api/ops/queues/${queue}/jobs/${jobId}/retry`)}
        disabled={busy}
        className="text-xs px-3 py-1 rounded border border-blue-300 text-blue-700 hover:bg-blue-50 disabled:opacity-50"
      >
        {busy ? "Retrying…" : "Retry"}
      </button>
      {msg && <span className="text-xs text-gray-500">{msg}</span>}
    </span>
  );
}

export function RefreshButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      onClick={() => {
        setBusy(true);
        router.refresh();
        setTimeout(() => setBusy(false), 500);
      }}
      disabled={busy}
      className="text-sm px-3 py-1.5 rounded border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
    >
      {busy ? "Refreshing…" : "Refresh"}
    </button>
  );
}
