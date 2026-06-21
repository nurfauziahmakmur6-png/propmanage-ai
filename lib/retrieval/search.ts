import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "../../db";
import { documentChunks, documents } from "../../db/schema";
import { withOrgFilter } from "../withOrg";

export interface ChunkMeta {
  page?: number;
  section?: string | null;
}

export interface SearchHit {
  id: string;
  documentId: string;
  content: string;
  metadata: ChunkMeta | null;
  score: number;
}

export interface SearchScope {
  organizationId: string;
  propertyId?: string | null;
  limit: number;
}

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

// Common English question/function words that carry no retrieval signal. The content_tsv
// column uses the 'simple' config (no stop-word removal), so we strip them here; otherwise
// an AND query would demand words like "what"/"the" that never appear in the documents.
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are", "be", "was",
  "do", "does", "did", "what", "when", "where", "which", "who", "whom", "how", "why", "can",
  "could", "should", "would", "i", "my", "me", "you", "your", "it", "its", "this", "that",
  "these", "those", "with", "at", "by", "as", "from", "each", "between", "into", "about",
  "there", "here", "have", "has", "had", "will", "shall", "may", "any", "some",
]);

// Build an OR tsquery from the query's content words. OR (rather than plainto's AND) is the
// right recall profile for the keyword arm of hybrid retrieval — a chunk sharing any salient
// term is a candidate, and RRF + the reranker sort out precision. Tokens are reduced to
// [a-z0-9] so the assembled to_tsquery string is injection-safe.
export function buildOrTsquery(query: string): string | null {
  const tokens = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const terms = [...new Set(tokens.filter((t) => t.length >= 3 && !STOPWORDS.has(t)))];
  return terms.length > 0 ? terms.join(" | ") : null;
}

// Restrict to one property's documents when a property is in scope. Always org-scoped.
function propertyPredicate(scope: SearchScope) {
  if (!scope.propertyId) return undefined;
  return sql`${documentChunks.documentId} in (
    select id from documents
    where organization_id = ${scope.organizationId} and property_id = ${scope.propertyId}
  )`;
}

// Vector search by cosine distance (<=>), served by the HNSW index. No join, so the
// index ordering is preserved; titles are fetched later only for the final sources.
export async function vectorSearch(
  queryEmbedding: number[],
  scope: SearchScope
): Promise<SearchHit[]> {
  const vec = toVectorLiteral(queryEmbedding);
  const prop = propertyPredicate(scope);
  const rows = await db
    .select({
      id: documentChunks.id,
      documentId: documentChunks.documentId,
      content: documentChunks.content,
      metadata: documentChunks.metadata,
      distance: sql<number>`${documentChunks.embedding} <=> ${vec}::vector`,
    })
    .from(documentChunks)
    .where(
      and(
        eq(documentChunks.organizationId, scope.organizationId),
        isNotNull(documentChunks.embedding),
        ...(prop ? [prop] : [])
      )
    )
    .orderBy(sql`${documentChunks.embedding} <=> ${vec}::vector`)
    .limit(scope.limit);

  return rows.map((r) => ({
    id: r.id,
    documentId: r.documentId,
    content: r.content,
    metadata: r.metadata as ChunkMeta | null,
    score: 1 - Number(r.distance), // cosine similarity, for inspection
  }));
}

// Full-text keyword search over the generated content_tsv (GIN), using the same 'simple'
// config the column was built with so the @@ match lines up. The query is an OR of content
// words (see buildOrTsquery) for recall; a query with no content words matches nothing.
export async function keywordSearch(query: string, scope: SearchScope): Promise<SearchHit[]> {
  const orExpr = buildOrTsquery(query);
  if (!orExpr) return [];
  const tsq = sql`to_tsquery('simple', ${orExpr})`;
  const prop = propertyPredicate(scope);
  const rows = await db
    .select({
      id: documentChunks.id,
      documentId: documentChunks.documentId,
      content: documentChunks.content,
      metadata: documentChunks.metadata,
      rank: sql<number>`ts_rank(${documentChunks.contentTsv}, ${tsq})`,
    })
    .from(documentChunks)
    .where(
      and(
        eq(documentChunks.organizationId, scope.organizationId),
        sql`${documentChunks.contentTsv} @@ ${tsq}`,
        ...(prop ? [prop] : [])
      )
    )
    .orderBy(desc(sql`ts_rank(${documentChunks.contentTsv}, ${tsq})`))
    .limit(scope.limit);

  return rows.map((r) => ({
    id: r.id,
    documentId: r.documentId,
    content: r.content,
    metadata: r.metadata as ChunkMeta | null,
    score: Number(r.rank),
  }));
}

export async function getDocumentTitles(
  organizationId: string,
  documentIds: string[]
): Promise<Map<string, string>> {
  if (documentIds.length === 0) return new Map();
  const rows = await db
    .select({ id: documents.id, title: documents.title })
    .from(documents)
    .where(withOrgFilter(organizationId, documents, inArray(documents.id, documentIds)));
  return new Map(rows.map((r) => [r.id, r.title]));
}
