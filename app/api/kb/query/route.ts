import { NextResponse } from "next/server";
import { getEmbeddingProvider } from "@/lib/embeddings";
import { getReranker } from "@/lib/reranking";
import { getLLMProvider, type LLMProvider } from "@/lib/llm";
import { answerQuestion } from "@/lib/answer";

// Transformers.js (embedder + reranker) needs the Node runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function orgId(): string {
  const id = process.env.DEMO_ORG_ID;
  if (!id) throw new Error("DEMO_ORG_ID is not set");
  return id;
}

export async function POST(req: Request) {
  const organizationId = orgId();
  const body = await req.json().catch(() => ({}) as Record<string, unknown>);
  const question = String(body.question ?? "").trim();
  const propertyId = body.propertyId ? String(body.propertyId) : null;

  if (!question) {
    return NextResponse.json({ error: "Missing question" }, { status: 400 });
  }

  // Resolve the LLM lazily so retrieval and the refusal path work without an API key;
  // only an actual answer generation requires GROQ_API_KEY.
  const llm: LLMProvider = {
    id: "lazy",
    complete: (opts) => getLLMProvider().complete(opts),
    chat: (opts) => getLLMProvider().chat(opts),
  };

  try {
    const result = await answerQuestion(
      question,
      { embeddingProvider: getEmbeddingProvider(), reranker: getReranker(), llm },
      { organizationId, propertyId }
    );
    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Query failed";
    const status = /API_KEY|not set/.test(message) ? 503 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
