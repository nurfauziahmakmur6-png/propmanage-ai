-- M2: switch embeddings from OpenAI 1536-dim to local bge-small-en-v1.5 384-dim.
-- The HNSW index is bound to the column's vector type, so it must be dropped before
-- the dimension change and recreated afterwards. document_chunks is empty at this point,
-- so no data is lost.
DROP INDEX IF EXISTS "document_chunks_embedding_idx";--> statement-breakpoint
ALTER TABLE "document_chunks" ALTER COLUMN "embedding" SET DATA TYPE vector(384);--> statement-breakpoint
-- Vector similarity search (RAG retrieval) — cosine distance, org-scoped
CREATE INDEX IF NOT EXISTS "document_chunks_embedding_idx" ON "document_chunks" USING hnsw ("embedding" vector_cosine_ops);
