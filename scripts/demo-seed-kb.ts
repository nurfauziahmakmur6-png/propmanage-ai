import "../lib/env";

import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { documents, documentChunks } from "../db/schema";
import { LocalEmbeddingProvider } from "../lib/embeddings/local";
import { splitDocument, runEmbedBatch, type PipelineDeps } from "../lib/ingestion/pipeline";

// Ingests one known property document into the demo org via the real ingestion pipeline
// functions (same chunking + embedding the worker runs), so /kb has something to ground an
// answer on. Uses a deterministic document id so re-running upserts rather than duplicates.
const DOC_ID = "11111111-1111-1111-1111-111111111111";
const TITLE = "Oakwood Apartments — House Rules";
const TEXT = `Oakwood Apartments — House Rules.

Quiet hours. At Oakwood Apartments, quiet hours run from 10pm to 7am on weekdays and from 11pm to 8am at weekends. Please keep music and television low and avoid using washing machines and vacuum cleaners during these hours.

Rubbish and recycling. General waste is collected every Tuesday and Friday morning, and recycling is collected on Wednesday. Move bins to the kerb the night before collection and return them to the bin store by the end of the day.

Pets. Dogs are allowed only with prior written approval from the building manager. Cats and small caged animals are always welcome.`;

async function main() {
  const organizationId = process.env.DEMO_ORG_ID;
  if (!organizationId) throw new Error("DEMO_ORG_ID is not set");

  const embeddingProvider = new LocalEmbeddingProvider();

  await db
    .delete(documentChunks)
    .where(and(eq(documentChunks.organizationId, organizationId), eq(documentChunks.documentId, DOC_ID)));

  const existing = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.organizationId, organizationId), eq(documents.id, DOC_ID)));
  if (existing.length === 0) {
    await db.insert(documents).values({
      id: DOC_ID,
      organizationId,
      title: TITLE,
      docType: "house_rules",
      storageKey: `${organizationId}/${DOC_ID}.pdf`,
      mimeType: "application/pdf",
      status: "pending",
    });
  }

  const deps: PipelineDeps = { embeddingProvider, loadPages: async () => [TEXT] };
  const batches = await splitDocument({ documentId: DOC_ID, organizationId }, deps);
  for (const b of batches) {
    await runEmbedBatch(
      {
        documentId: DOC_ID,
        organizationId,
        batchIndex: b.batchIndex,
        fromChunkIndex: b.fromChunkIndex,
        toChunkIndex: b.toChunkIndex,
      },
      deps
    );
  }
  await db
    .update(documents)
    .set({ status: "ready" })
    .where(and(eq(documents.organizationId, organizationId), eq(documents.id, DOC_ID)));

  const chunks = await db
    .select({ id: documentChunks.id })
    .from(documentChunks)
    .where(and(eq(documentChunks.organizationId, organizationId), eq(documentChunks.documentId, DOC_ID)));
  console.log(`Ingested "${TITLE}" into demo org ${organizationId}: ${chunks.length} chunk(s), status ready.`);
}

main().catch((err) => {
  console.error("demo seed failed:", err);
  process.exit(1);
});
