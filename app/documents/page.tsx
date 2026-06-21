import { listDocumentsWithChunkCounts } from "@/lib/documents";
import { UploadForm, AutoRefresh } from "./documents-client";

export const dynamic = "force-dynamic";

const DEMO_ORG_ID = process.env.DEMO_ORG_ID ?? "";

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-gray-100 text-gray-600",
  processing: "bg-blue-100 text-blue-800",
  ready: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
};

export default async function DocumentsPage() {
  const rows = await listDocumentsWithChunkCounts(DEMO_ORG_ID);

  const anyActive = rows.some((r) => r.status === "pending" || r.status === "processing");

  return (
    <div>
      <AutoRefresh active={anyActive} />
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Documents</h1>
        <span className="text-sm text-gray-500">{rows.length} total</span>
      </div>

      <UploadForm />

      {rows.length === 0 ? (
        <p className="text-gray-500 text-center py-16">
          No documents yet. Upload a PDF to start ingestion.
        </p>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100">
          {rows.map((d) => (
            <div key={d.id} className="flex items-center gap-4 px-5 py-4">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-gray-900 truncate">{d.title}</p>
                <p className="text-sm text-gray-500 mt-0.5">
                  {d.chunkCount} chunk{d.chunkCount === 1 ? "" : "s"}
                  {d.status === "failed" && d.error ? ` · ${d.error}` : ""}
                </p>
              </div>
              <span
                className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                  STATUS_COLORS[d.status] ?? "bg-gray-100 text-gray-600"
                }`}
              >
                {d.status}
              </span>
              <span className="text-xs text-gray-400 w-32 text-right">
                {new Date(d.createdAt).toLocaleString("en-US", {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
