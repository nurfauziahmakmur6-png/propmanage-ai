import type { EmbeddingProvider } from "../embeddings";
import type { Reranker } from "../reranking";
import { vectorSearch, keywordSearch, type ChunkMeta } from "./search";
import { reciprocalRankFusion, RRF_K } from "./rrf";

export interface RetrievalDeps {
  embeddingProvider: EmbeddingProvider;
  reranker: Reranker;
}

export interface RetrieveOptions {
  organizationId: string;
  propertyId?: string | null;
  vectorK?: number;
  keywordK?: number;
  rerankCandidates?: number;
  topN?: number;
}

export interface RetrievedChunk {
  id: string;
  documentId: string;
  content: string;
  metadata: ChunkMeta | null;
  vectorScore?: number;
  keywordScore?: number;
  rerankScore: number;
}

const DEFAULTS = { vectorK: 20, keywordK: 20, rerankCandidates: 30, topN: 5 };

/**
 * Hybrid retrieval: vector + keyword search in parallel, fused with RRF, then reranked by
 * the cross-encoder. Returns the top-N chunks by reranker score.
 */
export async function retrieve(
  query: string,
  deps: RetrievalDeps,
  opts: RetrieveOptions
): Promise<RetrievedChunk[]> {
  const vectorK = opts.vectorK ?? DEFAULTS.vectorK;
  const keywordK = opts.keywordK ?? DEFAULTS.keywordK;
  const rerankCandidates = opts.rerankCandidates ?? DEFAULTS.rerankCandidates;
  const topN = opts.topN ?? DEFAULTS.topN;
  const scope = { organizationId: opts.organizationId, propertyId: opts.propertyId };

  const queryEmbedding = await deps.embeddingProvider.embedQuery(query);
  const [vec, kw] = await Promise.all([
    vectorSearch(queryEmbedding, { ...scope, limit: vectorK }),
    keywordSearch(query, { ...scope, limit: keywordK }),
  ]);

  const byId = new Map<string, RetrievedChunk>();
  for (const h of vec) {
    byId.set(h.id, {
      id: h.id,
      documentId: h.documentId,
      content: h.content,
      metadata: h.metadata,
      vectorScore: h.score,
      rerankScore: 0,
    });
  }
  for (const h of kw) {
    const existing = byId.get(h.id);
    if (existing) {
      existing.keywordScore = h.score;
    } else {
      byId.set(h.id, {
        id: h.id,
        documentId: h.documentId,
        content: h.content,
        metadata: h.metadata,
        keywordScore: h.score,
        rerankScore: 0,
      });
    }
  }

  const fused = reciprocalRankFusion([vec.map((h) => h.id), kw.map((h) => h.id)], RRF_K);
  const candidates = fused
    .slice(0, rerankCandidates)
    .map((f) => byId.get(f.id))
    .filter((c): c is RetrievedChunk => Boolean(c));

  if (candidates.length === 0) return [];

  const scores = await deps.reranker.rerank(
    query,
    candidates.map((c) => c.content)
  );
  candidates.forEach((c, i) => {
    c.rerankScore = scores[i] ?? 0;
  });

  return candidates.sort((a, b) => b.rerankScore - a.rerankScore).slice(0, topN);
}
