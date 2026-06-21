import { desc, sql } from "drizzle-orm";
import { db } from "../db";
import { documents, documentChunks } from "../db/schema";
import { withOrgFilter } from "./withOrg";

export interface DocumentListItem {
  id: string;
  title: string;
  status: string;
  error: string | null;
  createdAt: string;
  chunkCount: number;
}

// Documents for an org with their chunk counts. Uses a grouped count (not a correlated
// subquery) so both queries stay org-scoped through withOrgFilter.
export async function listDocumentsWithChunkCounts(
  organizationId: string
): Promise<DocumentListItem[]> {
  const docs = await db
    .select({
      id: documents.id,
      title: documents.title,
      status: documents.status,
      error: documents.error,
      createdAt: documents.createdAt,
    })
    .from(documents)
    .where(withOrgFilter(organizationId, documents))
    .orderBy(desc(documents.createdAt));

  const counts = await db
    .select({
      documentId: documentChunks.documentId,
      n: sql<number>`count(*)::int`,
    })
    .from(documentChunks)
    .where(withOrgFilter(organizationId, documentChunks))
    .groupBy(documentChunks.documentId);

  const countMap = new Map(counts.map((c) => [c.documentId, c.n]));
  return docs.map((d) => ({ ...d, chunkCount: countMap.get(d.id) ?? 0 }));
}
