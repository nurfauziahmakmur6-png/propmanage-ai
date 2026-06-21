"use client";

import { useState } from "react";

interface Source {
  ref: number;
  title: string;
  page?: number;
  section?: string | null;
  score: number;
}

interface QueryResult {
  answer: string;
  sources: Source[];
  usedFallback: boolean;
}

export function KbQuery() {
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!question.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/kb/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: question.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <form onSubmit={onSubmit} className="flex gap-2 mb-6">
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask about the property documents…"
          className="flex-1 border border-gray-300 rounded px-4 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={loading}
          className="bg-blue-600 text-white px-5 py-2 rounded text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? "Searching…" : "Ask"}
        </button>
      </form>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-4 text-sm">
          {error}
        </div>
      )}

      {result && (
        <div className="space-y-5">
          <div
            className={`rounded-lg p-5 border ${
              result.usedFallback
                ? "bg-yellow-50 border-yellow-200"
                : "bg-white border-gray-200"
            }`}
          >
            <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">
              Answer
            </p>
            <p className="text-gray-900 whitespace-pre-wrap leading-relaxed">{result.answer}</p>
          </div>

          {result.sources.length > 0 && (
            <div>
              <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">
                Sources
              </p>
              <ol className="space-y-2">
                {result.sources.map((s) => (
                  <li
                    key={s.ref}
                    className="bg-white border border-gray-200 rounded-lg px-4 py-3 text-sm flex items-start gap-3"
                  >
                    <span className="shrink-0 w-6 h-6 rounded-full bg-blue-100 text-blue-700 text-xs font-semibold flex items-center justify-center">
                      {s.ref}
                    </span>
                    <span className="text-gray-700">
                      <span className="font-medium text-gray-900">{s.title}</span>
                      {s.page ? ` · page ${s.page}` : ""}
                      {s.section ? ` · ${s.section}` : ""}
                      <span className="text-gray-400">
                        {" "}
                        · relevance {s.score.toFixed(2)}
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
