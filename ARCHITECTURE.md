# PropManage AI — Technical Architecture

A small, AI-first platform for property management companies: managers upload property documents, tenants and staff raise tickets, and an AI agent triages tickets and answers questions grounded in the company's own documents.

This document is the design record for the system. It deliberately spends as much space on *why* as on *what*, because the goal is to demonstrate systems-design judgement (schema, indexing, queues, failure modes), not just a working demo.

---

## 1. Goals and non-goals

**Goals**

- A multi-tenant data layer designed from the ground up, with deliberate relationships and indexing that hold up as ticket and document volume grows.
- Reliable background processing for document ingestion and inbound email, correct under retries, crashes, and volume spikes.
- A RAG knowledge base over property documents with hybrid retrieval and reranking.
- An observable AI agent that triages tickets and drafts grounded replies, with a human in the loop for risky actions.

**Non-goals (explicitly out of scope, to keep the build focused)**

- Billing, accounting, and real payment flows.
- Full role/permission matrices beyond a basic `owner / manager / staff` distinction.
- Native mobile clients.
- Production-grade security hardening (documented as future work, not built).

Scoping these out is itself a design decision: the role values depth in the data layer, queues, and RAG over breadth of features.

---

## 2. Tech stack

| Layer | Choice | Rationale |
|---|---|---|
| Language | TypeScript (Node 20+) | Matches the target stack; one language across web and workers. |
| Web / API | Next.js 14 (App Router, route handlers) | Matches their frontend stack; route handlers serve the API. |
| Background workers | BullMQ on Node, deployed as a **separate** long-running process | Web and workers are different deployment units; conflating them is a common mistake this design avoids. |
| Database | PostgreSQL (Neon) + `pgvector` | One store for relational data *and* embeddings keeps the data layer coherent and avoids a second system to keep consistent. |
| ORM / migrations | Drizzle ORM | TS-native, thin over SQL, explicit migrations and indexes — better for showing query/index reasoning than a heavier ORM. Prisma is an acceptable substitute if preferred. |
| Queue backend / cache | Redis (Upstash) | Backs BullMQ and holds rate-limit counters. |
| Embeddings | OpenAI `text-embedding-3-small` (1536-dim) | Cheap, batchable, good enough for this corpus. Swappable behind an interface. |
| Reranker | Cohere Rerank (`rerank-v3.x`) | Cross-encoder reranking measurably lifts precision of the final context. A local cross-encoder is the fallback. |
| LLM / agent | Claude (current Sonnet) via Anthropic API, tool use | The company is AI-first with Claude; the agent uses Claude tool-calling. |
| File storage | Cloudflare R2 (or Cloudinary) | Stores uploaded PDFs; signed URLs for access. |
| Email | Inbound via webhook (Postmark/Resend inbound); outbound via Resend | Drives the email-to-ticket pipeline. |
| Auth | NextAuth v5 (org-scoped sessions) | Familiar, sufficient for the demo. |

Every external API (embeddings, rerank, LLM) sits behind a small interface so it can be mocked in tests and swapped without touching call sites.

---

## 3. System overview

```
                         ┌─────────────────────────────┐
        Browser ───────▶ │  Next.js (Vercel)           │
                         │  UI + API route handlers     │
                         └───────┬─────────────┬────────┘
                                 │ read/write  │ enqueue
                                 ▼             ▼
                    ┌────────────────┐   ┌──────────────┐
                    │ Postgres (Neon)│   │ Redis (BullMQ│
                    │  + pgvector    │   │  + limiter)  │
                    └──────▲─────────┘   └──────┬───────┘
                           │ read/write         │ consume
                           │                    ▼
                           │           ┌──────────────────────────┐
   Inbound email webhook ──┼─────────▶ │  Worker process (Railway)│
                           │           │  - document-ingestion    │
                           └───────────┤  - email-processing      │
                                       │  - agent-triage          │
                                       └───────┬──────────────────┘
                                               │ calls
                          ┌────────────────────┼───────────────────┐
                          ▼                    ▼                    ▼
                   OpenAI (embed)       Cohere (rerank)      Anthropic (agent)
```

The web tier is stateless and serverless. All slow, retry-prone, or spiky work (PDF parsing, embedding, email handling, agent runs) is pushed onto queues and handled by a separate worker process that can be scaled and restarted independently.

---

## 4. Data model

### 4.1 Entities and relationships

```
organizations 1───* users
organizations 1───* properties 1───* units 1───* tenants
organizations 1───* tickets ──┐ (property_id, unit_id, tenant_id are nullable FKs)
tickets       1───* ticket_messages
organizations 1───* documents 1───* document_chunks   (chunks hold the vectors)
organizations 1───* inbound_emails ──▶ may create a ticket
organizations 1───* agent_runs ──▶ references a ticket
```

`organization_id` is present on **every** business table. It is the tenant boundary and the leading column of most indexes (see §4.3 and §5).

### 4.2 Core tables (abridged DDL)

```sql
create extension if not exists vector;

create table organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

create table properties (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name            text not null,
  address         text,
  created_at      timestamptz not null default now()
);

create table tickets (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  property_id     uuid references properties(id) on delete set null,
  unit_id         uuid references units(id) on delete set null,
  tenant_id       uuid references tenants(id) on delete set null,
  title           text not null,
  status          text not null default 'open',     -- open | in_progress | waiting | closed
  priority        text not null default 'normal',    -- low | normal | high | urgent
  category        text,                              -- set by the agent
  source          text not null default 'web',       -- web | email | api
  assigned_to     uuid references users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table documents (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  property_id     uuid references properties(id) on delete set null,
  title           text not null,
  doc_type        text,                              -- hausordnung | mietvertrag | nebenkosten | other
  storage_key     text not null,                     -- R2 object key
  mime_type       text not null,
  status          text not null default 'pending',   -- pending | processing | ready | failed
  error           text,
  created_at      timestamptz not null default now()
);

create table document_chunks (
  id              uuid primary key default gen_random_uuid(),
  document_id     uuid not null references documents(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  chunk_index     int  not null,
  content         text not null,
  content_tsv     tsvector generated always as (to_tsvector('simple', content)) stored,
  embedding       vector(1536),
  token_count     int,
  metadata        jsonb not null default '{}',       -- { page, section, doc_type }
  unique (document_id, chunk_index)                   -- idempotent re-ingestion
);

create table inbound_emails (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  message_id      text not null,                      -- provider Message-ID, for dedupe
  from_addr       text not null,
  subject         text,
  body            text,
  status          text not null default 'received',   -- received | processed | failed
  ticket_id       uuid references tickets(id) on delete set null,
  received_at     timestamptz not null default now(),
  unique (organization_id, message_id)                -- dedupe duplicate deliveries
);

create table agent_runs (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  ticket_id       uuid references tickets(id) on delete set null,
  status          text not null,                      -- succeeded | failed | escalated
  tool_calls      jsonb not null default '[]',
  output          text,
  tokens_used     int,
  latency_ms      int,
  created_at      timestamptz not null default now()
);
```

### 4.3 Indexing strategy (this is where the design earns its keep)

The point is not to add indexes everywhere, but to index for the *actual read paths* the app uses.

- **Ticket list view** is the hottest query: "open tickets for this org, newest first." Serve it with a composite index whose column order matches the filter-then-sort pattern:
  ```sql
  create index tickets_org_status_created_idx
    on tickets (organization_id, status, created_at desc);
  ```
  A partial variant keeps the common case small:
  ```sql
  create index tickets_org_open_idx
    on tickets (organization_id, created_at desc)
    where status in ('open','in_progress','waiting');
  ```
- **Assignment view** ("my tickets"): `tickets (organization_id, assigned_to, status)`.
- **Foreign keys** that are filtered or joined get their own indexes (`document_chunks.document_id`, `ticket_messages.ticket_id`, etc.) — Postgres does not create these automatically.
- **Vector search** uses an HNSW index for cosine distance:
  ```sql
  create index document_chunks_embedding_idx
    on document_chunks using hnsw (embedding vector_cosine_ops);
  ```
  HNSW over IVFFlat here because recall/latency matter more than build time at this scale. The trade-off (HNSW costs more memory and slower builds) is acceptable for a read-heavy corpus.
- **Keyword search** for hybrid retrieval uses the generated `content_tsv` column with a GIN index:
  ```sql
  create index document_chunks_tsv_idx on document_chunks using gin (content_tsv);
  ```

**Filtered vector search** is the subtle part. Every vector query must be scoped to one organization. Naively, an HNSW search ignores the `WHERE organization_id = $1` filter and can return a page of neighbours that all get filtered out (low effective recall). Mitigations, in order of effort:
1. Rely on pgvector 0.8+ **iterative index scans**, which keep pulling candidates until enough pass the filter.
2. If a single tenant's corpus grows large, **partition `document_chunks` by `organization_id`** (or by a hash of it) so each tenant searches a smaller index.

This is documented as a known scaling axis rather than prematurely optimised.

---

## 5. Multi-tenancy and isolation

Isolation is enforced at two layers:

1. **Application layer:** a single `withOrg(session)` helper produces a scoped query builder; no handler queries a business table without an `organization_id` predicate. This is the primary mechanism.
2. **Database layer (documented, optionally enabled):** Postgres Row-Level Security policies keyed on a session variable give defence in depth, so a missing app-level filter cannot leak data across tenants.

Stating both, and being explicit that app-level scoping is the enforced one while RLS is the safety net, is a deliberate trade-off between demo simplicity and real isolation guarantees.

---

## 6. Background jobs and queues

Three queues, each owned by a worker in the separate worker process.

| Queue | Trigger | Work |
|---|---|---|
| `document-ingestion` | Document uploaded | Download → extract text → chunk → embed (batched) → upsert chunks → mark `ready`. |
| `email-processing` | Inbound email webhook | Dedupe → match tenant/property → create ticket or append message → enqueue `agent-triage`. |
| `agent-triage` | New ticket / new message | Run the agent: classify, retrieve, draft reply, decide auto-send vs escalate. |

### 6.1 Correctness under retries (the core requirement)

BullMQ gives **at-least-once** delivery: any job can run more than once (a worker can crash after doing the work but before acking). Every job is therefore designed to be **idempotent**:

- **Deterministic job IDs** prevent duplicate enqueues: `doc-ingest:{documentId}` so re-uploading or re-triggering does not create a second pipeline.
- **Idempotent side effects**: chunks are written with `insert ... on conflict (document_id, chunk_index) do update`, so a re-run overwrites rather than duplicates. Inbound emails carry a unique `(organization_id, message_id)`, so a duplicate delivery is a no-op.
- **Status as a state machine**: `documents.status` moves `pending → processing → ready | failed`. A crashed job leaves the row in `processing`; a sweeper re-enqueues rows stuck in `processing` past a timeout. Work is never silently lost.

### 6.2 Long-running work and volume spikes

A 200-page PDF is not embedded in one job. The ingestion pipeline uses a **BullMQ flow**: a parent job splits the document into chunk batches and fans out one child job per batch; the parent completes only when all children succeed. This keeps individual jobs short, parallelises embedding, and means a single failed batch retries on its own instead of restarting the whole document.

Volume spikes (a customer bulk-uploading their archive, or an email blast) are absorbed by the queue. Workers process at a controlled rate; the web tier never blocks on this work. Horizontal scaling is just running more worker instances.

### 6.3 Rate limiting and backpressure

The embedding and LLM APIs have rate limits, so:

- BullMQ **worker concurrency** is capped per queue.
- A **Redis-backed global limiter** caps embedding requests per second across all workers, so scaling workers horizontally does not blow the upstream API budget.
- **Retries use exponential backoff with jitter**; after `maxAttempts` a job lands in the failed set (dead-letter), which is surfaced on a small ops view and alerted on.

---

## 7. RAG pipeline

### 7.1 Ingestion

1. **Extract** text (`unpdf`/`pdf-parse`; OCR fallback noted as future work for scanned docs).
2. **Chunk** recursively at ~600 tokens with ~80-token overlap, preferring to break on headings/paragraphs. Each chunk stores `{ page, section, doc_type }` in `metadata`.
3. **Embed** in batches (e.g. 96 chunks/request) and upsert into `document_chunks`.

### 7.2 Retrieval (query time)

Hybrid retrieval, then rerank:

1. Embed the query.
2. **Vector search** (top ~20) scoped to the org and, when known, the property:
   ```sql
   select id, content, metadata
   from document_chunks
   where organization_id = $org
     and ($property is null or document_id in (select id from documents where property_id = $property))
   order by embedding <=> $queryEmbedding
   limit 20;
   ```
3. **Keyword search** (top ~20) over `content_tsv` for the same scope.
4. **Fuse** the two lists with Reciprocal Rank Fusion — this catches both semantic matches and exact-term matches (names, clause numbers) that pure vector search misses.
5. **Rerank** the fused candidates with the cross-encoder; keep the top 5.
6. **Generate** with Claude, passing the 5 chunks and requiring inline source citations. If nothing clears a relevance threshold, the agent says it cannot answer from the documents rather than guessing.

### 7.3 Evaluation

A small fixed eval set (`question → expected source chunk`) is checked in. A script reports **hit-rate@k** and **MRR** for retrieval and is run whenever chunking, embedding model, or fusion weights change. Being able to *measure* retrieval quality — not just eyeball it — is a deliberate signal of the "set up, train and measure" mindset the product is built around.

---

## 8. AI agent

The triage agent runs in the `agent-triage` worker and is given a constrained tool set:

- `search_knowledge_base(query, scope)` → hybrid+rerank retrieval from §7.
- `get_ticket_history(ticket_id)` → prior messages for context.
- `classify_ticket(category, priority)` → writes structured fields back.
- `draft_reply(body, citations)` → stores a **draft**, never auto-sends by default.
- `escalate_to_human(reason)` → flags for staff review.

**Guardrails and human-in-the-loop:** the agent drafts; a human approves sending. Auto-send is gated behind a confidence threshold and limited to low-risk categories (e.g. "where do I put my rubbish bins"), never anything touching money, contracts, or legal notices. Every run is written to `agent_runs` with its tool calls, token usage, and latency, so behaviour is auditable and cost is measurable.

---

## 9. API surface (representative)

All endpoints run behind auth + org-scoping middleware.

```
POST /api/documents            upload metadata, get signed URL, enqueue ingestion
GET  /api/documents/:id        status (pending|processing|ready|failed)
POST /api/tickets              create ticket (enqueues triage)
GET  /api/tickets?status=open  paginated, served by the composite index in §4.3
POST /api/tickets/:id/messages append message (enqueues triage)
POST /api/kb/query             ask the knowledge base, returns answer + sources
POST /api/webhooks/email       inbound email (enqueues email-processing)
```

Pagination is keyset (`where created_at < $cursor order by created_at desc`), not `OFFSET`, so deep pages stay fast as data grows.

---

## 10. Deployment topology

- **Web (Next.js):** Vercel — stateless, serverless.
- **Worker (BullMQ):** Railway / Render / Fly.io — a long-running process. Serverless functions are the wrong home for background workers; separating them is intentional.
- **Postgres:** Neon. **Redis:** Upstash. **Files:** R2.

Web and worker share the same repo and the same DB/queue clients but ship as two deploy targets.

---

## 11. Observability and cost

- **Structured logs** with a correlation id propagated from request → enqueue → job.
- **Metrics:** queue depth, job latency, job failure rate, and **token spend per agent run** (from `agent_runs`). Cost is a first-class metric because LLM/embedding usage is the main variable cost.
- **Ops view:** a minimal page listing failed jobs and documents stuck in `processing`, with a manual re-enqueue button.

---

## 12. Failure modes

| Failure | Behaviour by design |
|---|---|
| Embedding/LLM API down or rate-limited | Jobs retry with backoff; queue absorbs the backlog; documents stay `processing`, never lost. |
| Worker crashes mid-job | At-least-once redelivery; idempotent steps (`on conflict`, unique keys) prevent duplicates. |
| Duplicate inbound email | Unique `(organization_id, message_id)` makes reprocessing a no-op. |
| Poison job (always fails) | Capped attempts → dead-letter set → surfaced and alerted, doesn't block the queue. |
| Vector recall degrades as a tenant grows | Iterative index scans now; partition `document_chunks` by org later. |
| Cross-tenant data leak | App-level org scoping on every query; optional RLS as a second layer. |
| Agent hallucinates an answer | Mandatory citations + relevance threshold + human approval for sends. |
| Document stuck in `processing` | Timeout sweeper re-enqueues; ops view exposes it. |

---

## 13. Build roadmap

Phased so each milestone is independently demoable and the hardest-to-fake skills land first.

1. **Data layer** — schema, migrations, indexes, seed data, ticket list/detail UI. (Proves schema + indexing.)
2. **Ingestion pipeline** — upload → queue → chunk → embed → `ready`, with idempotency and retries. (Proves queues + reliability — the biggest gap to close.)
3. **RAG query** — hybrid retrieval + rerank + cited answers, plus the eval script. (Proves embeddings/semantic search/reranking.)
4. **Agent + email** — triage agent with tools and human-in-the-loop, inbound-email-to-ticket. (Proves agents + pipelines.)
5. **Observability + ops view + README/design write-up.** (Proves the maturity that gets you hired.)

Depth on milestones 1–3 beats breadth across all five.

---

## 14. How this maps to the role

| Job requirement | Where it shows up here |
|---|---|
| Own schema, relationships, indexing; reason about load | §4 data model and indexing strategy; §9 keyset pagination |
| Queues, background jobs, long-running workflows, correct under load | §6 idempotency, flows, rate limiting, backpressure |
| RAG / knowledge base (embeddings, semantic search, reranking) | §7 hybrid retrieval + rerank + eval |
| Agents for a template library | §8 tool-using triage agent with guardrails |
| Document & email pipelines, 3rd-party integrations | §6/§7 ingestion, §9 email webhook, external APIs behind interfaces |
| Reliability, scalability, maintainability as defaults | §11 observability, §12 failure modes, §5 isolation |
| AI-first with Claude | Built with Claude Code; agent runs on Claude |
