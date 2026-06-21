import { KbQuery } from "./kb-client";

export const dynamic = "force-dynamic";

export default function KbPage() {
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Knowledge Base</h1>
        <p className="text-sm text-gray-500 mt-1">
          Ask a question and get an answer grounded in your property documents, with sources.
        </p>
      </div>
      <KbQuery />
    </div>
  );
}
