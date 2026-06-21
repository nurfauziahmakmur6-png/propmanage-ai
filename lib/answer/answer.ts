import type { LLMProvider } from "../llm";
import type { EmbeddingProvider } from "../embeddings";
import type { Reranker } from "../reranking";
import { retrieve, type RetrievedChunk } from "../retrieval";
import { getDocumentTitles } from "../retrieval/search";

export const REFUSAL = "I couldn't find this in the documents.";

// Default reranker-score floor. A chunk must clear this for the LLM to be called at all,
// so the system refuses rather than guessing when nothing relevant was retrieved.
export const DEFAULT_THRESHOLD = Number(process.env.RAG_RERANK_THRESHOLD ?? 0.3);

export interface AnswerSource {
  ref: number;
  documentId: string;
  title: string;
  page?: number;
  section?: string | null;
  chunkId: string;
  score: number;
}

export interface AnswerResult {
  answer: string;
  sources: AnswerSource[];
  usedFallback: boolean;
}

export interface AnswerDeps {
  embeddingProvider: EmbeddingProvider;
  reranker: Reranker;
  llm: LLMProvider;
}

export interface AnswerOptions {
  organizationId: string;
  propertyId?: string | null;
  threshold?: number;
  topN?: number;
}

function buildSystemPrompt(): string {
  return [
    "You are a property-management assistant.",
    "Answer the question using ONLY the numbered sources provided.",
    "Cite the sources you use inline with their number in square brackets, e.g. [1] or [2].",
    `If the sources do not contain the answer, reply exactly: "${REFUSAL}"`,
    "Keep the answer concise and factual.",
  ].join(" ");
}

function buildUserPrompt(query: string, sources: AnswerSource[], chunks: RetrievedChunk[]): string {
  const context = sources
    .map((s, i) => {
      const loc = s.page ? `, page ${s.page}` : "";
      return `[${s.ref}] ${s.title}${loc}\n${chunks[i].content}`;
    })
    .join("\n\n");
  return `Question: ${query}\n\nSources:\n${context}`;
}

/**
 * Threshold gate + generation. Pure with respect to the DB (titles are passed in), so the
 * refusal path is unit-testable and provably does NOT call the LLM when nothing is
 * relevant.
 */
export async function composeAnswer(
  query: string,
  ranked: RetrievedChunk[],
  titles: Map<string, string>,
  llm: LLMProvider,
  threshold: number
): Promise<AnswerResult> {
  const relevant = ranked.filter((c) => c.rerankScore >= threshold);
  if (relevant.length === 0) {
    return { answer: REFUSAL, sources: [], usedFallback: true };
  }

  const sources: AnswerSource[] = relevant.map((c, i) => ({
    ref: i + 1,
    documentId: c.documentId,
    title: titles.get(c.documentId) ?? "Untitled document",
    page: c.metadata?.page,
    section: c.metadata?.section ?? null,
    chunkId: c.id,
    score: c.rerankScore,
  }));

  const completion = await llm.complete({
    system: buildSystemPrompt(),
    user: buildUserPrompt(query, sources, relevant),
  });

  return { answer: completion.text.trim(), sources, usedFallback: false };
}

export async function answerQuestion(
  query: string,
  deps: AnswerDeps,
  opts: AnswerOptions
): Promise<AnswerResult> {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const ranked = await retrieve(
    query,
    { embeddingProvider: deps.embeddingProvider, reranker: deps.reranker },
    { organizationId: opts.organizationId, propertyId: opts.propertyId, topN: opts.topN }
  );
  if (ranked.length === 0) {
    return { answer: REFUSAL, sources: [], usedFallback: true };
  }
  const titles = await getDocumentTitles(
    opts.organizationId,
    [...new Set(ranked.map((c) => c.documentId))]
  );
  return composeAnswer(query, ranked, titles, deps.llm, threshold);
}
