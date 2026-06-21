# Milestone 1 — Design Decisions

## Why each index exists

### `tickets_org_status_created_idx` on `(organization_id, status, created_at desc)`

The hottest read path in the app is "give me all open tickets for this org, newest first."
The composite order `(organization_id, status, created_at)` means Postgres can satisfy
the entire query — filter, equality, and sort — with a single index scan, zero heap access
for the filtering columns, and no sort step. Putting `organization_id` first ensures the
index is useful for *all* org-scoped ticket queries, not just those that also filter on status.

### `tickets_org_open_idx` partial index on `(organization_id, created_at desc) WHERE status IN ('open','in_progress','waiting')`

The overwhelming majority of ticket-list views show active (non-closed) tickets. The partial
index excludes `closed` tickets, making it physically smaller and faster to scan for this
common case. Once a ticket is closed it falls out of the index entirely. This is complementary
to the full composite index above, not a replacement — the partial index wins on the hot path;
the full index handles ad-hoc filtering by any status.

### `tickets_org_assigned_status_idx` on `(organization_id, assigned_to, status)`

Serves the "my tickets" view — staff members seeing their own assigned tickets filtered by
status. Without this index, filtering on `assigned_to` inside a large org would require a
full org-partition scan.

### `document_chunks_embedding_idx` HNSW `(embedding vector_cosine_ops)`

Vector similarity search at query time. HNSW (Hierarchical Navigable Small World) is chosen
over IVFFlat because HNSW offers better recall at low latency without requiring a training
step (IVFFlat requires `VACUUM`/`ANALYZE` after initial load). The trade-off — HNSW uses more
memory and has slower build time — is acceptable for a corpus of this size where read latency
matters more than index build time.

### `document_chunks_tsv_idx` GIN `(content_tsv)`

Supports the keyword half of hybrid retrieval. The `content_tsv` column is a generated
`tsvector` (computed by Postgres on write, stored), so the GIN index covers it directly
without per-query `to_tsvector()` calls. GIN is the right choice for `tsvector` columns
because it indexes each lexeme individually, making `@@` queries fast regardless of term
cardinality.

### `document_chunks_document_id_idx` on `(document_id)`

Postgres does *not* automatically create indexes on foreign key columns. Without this index,
fetching all chunks for a document (during ingestion status checks or re-ingestion) would
cause a sequential scan of the entire `document_chunks` table. A single-column FK index is
the minimum needed.

### `ticket_messages_ticket_id_idx` on `(ticket_id)`

Same FK reasoning: loading the message thread for a ticket would table-scan without this.
Every ticket detail page hits this index.

---

## How org-scoping is enforced

**Application layer (primary):** every business-table query must go through `withOrg()` or
`withOrgFilter()` in [`lib/withOrg.ts`](../lib/withOrg.ts). These helpers inject
`WHERE organization_id = $orgId` before any caller-supplied predicates. The `orgColumns`
map in that file is the registry — adding a new business table without registering it causes
a runtime error rather than silently returning unscoped data. This is the enforced mechanism
for Milestone 1.

**Database layer (documented, not yet enabled):** Postgres Row-Level Security policies keyed
on a session-local variable (`SET LOCAL app.org_id = '...'`) provide a second layer of
isolation. A bug in the application that omits the org predicate would be caught by RLS
instead of leaking cross-tenant data. This is documented as future work; enabling it is
additive and does not require schema changes.

The explicit choice to make app-level scoping the *enforced* mechanism — rather than relying
solely on RLS — reflects a deliberate trade-off: RLS adds overhead to every query and makes
query plans harder to reason about. For a demo with a single runtime user per request, the
application layer is both sufficient and easier to audit.

---

## Why keyset pagination instead of OFFSET

`OFFSET n` forces Postgres to read and discard the first *n* rows before returning results.
On a table with tens of thousands of tickets, page 50 (`OFFSET 1000`) costs roughly as much
as a full scan of the first 1000 rows — latency grows linearly with page depth.

Keyset pagination (`WHERE created_at < $cursor ORDER BY created_at DESC LIMIT n`) lets
Postgres start reading exactly at the cursor position using the `tickets_org_status_created_idx`
index. Deep pages are as fast as page 1. The trade-off is that keyset pagination only supports
"next page" / "previous page" navigation — you cannot jump to "page 47". For a ticket list
this is the right trade-off: users want the newest tickets or to scroll forward, not random
access to arbitrary pages.

The cursor is the `created_at` timestamp of the last row returned. It is URL-encoded and
passed as a query parameter, keeping pagination stateless and cache-friendly.

---

# Milestone 2 — Ingestion Pipeline Decisions

## Why a separate worker process

The web tier (Next.js) and the ingestion worker ship as **two processes from one repo**.
PDF parsing, embedding, and the local transformer model are slow, CPU-bound, and spiky —
exactly the work that must not run inside request handlers:

- **Serverless/request runtimes are the wrong home for long work.** A Vercel function has
  an execution-time limit and is billed for wall-clock; embedding a 200-page PDF there
  would time out or cost a fortune. The worker is a long-running Node process (`npm run
  worker`, `tsx worker.ts`) that can be deployed to Railway/Render/Fly and scaled
  independently of web traffic.
- **Isolation of failure and resource use.** A model load that pins a CPU core, or a crash
  loop on a poison document, stays in the worker and never degrades the web tier.
- **Independent scaling.** Throughput is "how many worker instances," set separately from
  web autoscaling. The queue is the buffer between them.

The web tier's only job is to persist the upload, write a `pending` row, and enqueue. It
returns in milliseconds.

## How idempotency is guaranteed

BullMQ delivers **at-least-once** — a worker can crash after doing work but before acking,
so every job must be safe to run again. Three mechanisms, each at a different layer:

1. **Deterministic job ids.** Ingestion enqueues as `doc-ingest__{documentId}`; each batch
   is `embed-batch__{documentId}__{batchIndex}`. Re-enqueuing the same document while a
   pipeline is in flight is a no-op, so a double-clicked upload or a retried webhook can't
   start a second pipeline. (BullMQ v5 forbids `:` in custom ids — it is the Redis key
   separator — hence `__`.)
2. **Idempotent side effects.** Chunk rows are written with
   `insert … on conflict (document_id, chunk_index) do update`, so a re-run overwrites
   rather than duplicates; the split phase also deletes any trailing rows from a previous,
   longer run, so the chunk count is exactly stable. Embeddings are written with a plain
   `UPDATE` keyed by chunk id — re-running just overwrites the vector.
3. **Status as a state machine.** `documents.status` moves `pending → processing →
   ready | failed` and `updated_at` is bumped on every transition. The *database*, not the
   queue, is the source of truth for whether a document finished.

The idempotency test asserts the crux: running ingestion twice for one document yields the
**same** chunk count with no duplicate `(document_id, chunk_index)` rows.

## The fan-out flow design

A long PDF is never embedded in a single job. The pipeline is a **re-entrant BullMQ
parent with dynamic children**:

- The parent (`document-ingestion`) runs its **split phase**: mark `processing`, extract
  text, chunk, upsert the chunk rows. It then adds one `embed-batch` child per batch (32
  chunks/batch) with a `parent` reference, records `phase: "finalize"` on its own job
  data, and calls `moveToWaitingChildren()` — throwing `WaitingChildrenError` to park
  itself.
- Each **child** embeds its batch and writes the vectors back. Children run on a separate
  queue with capped concurrency and a rate limiter, so embedding throughput is controlled
  independently of how many documents are in flight.
- When all children settle, BullMQ re-runs the parent. This time `phase === "finalize"`:
  the parent checks the DB and marks the document `ready` only if **every** chunk has an
  embedding, else `failed`.

Two consequences worth calling out:

- **A single failed batch retries on its own** (its own 5 attempts) instead of restarting
  the whole document. Failed children use `ignoreDependencyOnFailure`, so the parent is
  still promoted to `finalize`, where the DB-truth check (any unembedded chunk) decides the
  document's fate. The failed child job stays in the failed set for observability.
- **The DB is the arbiter of done**, not the queue topology — finalize asserts on actual
  embedded rows, which is robust to any partial or out-of-order child completion.

## Retry / backoff strategy

- `attempts: 5` on both parent and child jobs.
- **Exponential backoff with jitter**, registered as a custom strategy:
  `min(1000 · 2^(n-1), 30s)` plus up to 25% random jitter. Jitter de-synchronises a batch
  of jobs that failed together (e.g. a transient embedder hiccup) so they don't retry in
  lockstep and re-stampede the dependency.
- After the 5th failure a job lands in the **failed set** (dead-letter) and stays there
  (`removeOnFail: false`) — failures are never silently dropped and are available for an
  ops view later.
- The parent marks the document `failed` only on **terminal** failure, distinguished by
  `job.getState() === "failed"` (an intermediate attempt that will still retry is in
  `delayed`/`wait`, not `failed`).

The failure test asserts this: an embed step that always throws retries to exhaustion and
the document ends `failed` (not stuck in `processing`), with the failed batch preserved in
the failed set at `attemptsMade === 5`.

## Rate limiting and backpressure

- **Worker concurrency is capped** per queue (`embed` concurrency defaults to 2 — the
  local model is CPU-bound).
- A **Redis-backed limiter** (`{ max, duration }`) on the embed worker caps batches per
  second *across all worker instances*, so scaling workers horizontally can't blow an
  upstream API budget when the embedder is later swapped for OpenAI.
- Spikes are absorbed by the queue; the web tier never blocks.

## The stuck-job sweeper

Defense in depth for the "worker crashed after setting `processing` but before finishing"
case (beyond BullMQ's own stalled-job recovery). A **repeatable maintenance job** runs
every 2 minutes and finds documents in `processing` whose `updated_at` is older than the
timeout (5 min), then force-re-enqueues them. Force clears a *finished* job sharing the
deterministic id so the document can be re-driven, while an in-flight pipeline is left
untouched. Because every step is idempotent, re-driving a document is always safe.

## Provider interfaces (swappability)

`EmbeddingProvider` and `StorageProvider` are small interfaces selected by env. M2 ships a
local Transformers.js embedder (`bge-small-en-v1.5`, 384-dim, mean-pooled + L2-normalized;
the retrieval instruction is applied to queries only) and a local-filesystem storage
backend. Swapping in OpenAI embeddings (1536-dim) or R2 later is an env change plus one
class, with no call-site edits. The embedding dimension change drove migration `0001`,
which drops the HNSW index, alters `embedding` to `vector(384)`, and recreates the index.
