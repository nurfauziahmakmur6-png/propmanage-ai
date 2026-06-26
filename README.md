# PropManage AI

An AI-first backend for property-management companies — a portfolio project mirroring the
problem space of products like **hausverwalter.ai**. Property managers upload documents
(house rules, leases, utility guides); tenants and staff raise tickets or send email; and an
**AI agent triages every inbound message** — classifying it, retrieving grounded answers from
the company's own documents, and drafting a reply that a human approves before it is sent.
The emphasis is deliberately on systems-design depth rather than feature breadth: a
multi-tenant data layer with considered indexing, a crash-safe background-processing
pipeline, retrieval-augmented generation with a measurable eval, and a tool-using agent with
human-in-the-loop guardrails and first-class cost/latency observability.

## What this demonstrates

- **Schema & indexing judgement** — multi-tenant Postgres, org-scoped on every query, indexed
  for the actual read paths (composite, partial, HNSW vector, GIN full-text).
- **Reliable background work** — BullMQ workers in a *separate* process; idempotent under
  retries and crashes (deterministic job ids, upserts, a status state machine, a stuck-job
  sweeper).
- **RAG that's measured, not eyeballed** — hybrid (vector + keyword) retrieval, RRF fusion, a
  local cross-encoder reranker, cited answers with a pre-LLM refusal gate, and an eval that
  reports hit-rate@5 + MRR.
- **A constrained, auditable agent** — five tools, draft-only with human approval,
  code-enforced escalation of sensitive topics, every run logged for cost and latency.

## Architecture

```
                         ┌──────────────────────────────┐
        Browser ───────▶ │  Next.js (App Router)        │
                         │  UI + API route handlers     │
                         └───────┬─────────────┬────────┘
                                 │ read/write  │ enqueue
                                 ▼             ▼
                    ┌────────────────┐   ┌───────────────┐
                    │ Postgres (Neon)│   │ Redis (BullMQ │
                    │  + pgvector    │   │  + limiter)   │
                    └──────▲─────────┘   └──────┬────────┘
                           │ read/write         │ consume
                           │                    ▼
                           │           ┌──────────────────────────┐
   Inbound email webhook ──┼─────────▶ │  Worker process (tsx)    │
                           │           │  - document-ingestion    │
                           └───────────┤  - embed-batch           │
                                       │  - email-processing      │
                                       │  - agent-triage          │
                                       └───────┬──────────────────┘
                                               │ calls (behind interfaces)
                          ┌────────────────────┼────────────────────┐
                          ▼                    ▼                     ▼
              Transformers.js (embed)  Transformers.js (rerank)   Groq (agent)
                  bge-small-en-v1.5      ms-marco-MiniLM-L-6        llama-3.3-70b
```

The web tier is stateless; all slow/spiky/retry-prone work runs on queues in a separate
long-running worker. Every external capability (embeddings, reranking, LLM, storage) sits
behind a small interface — the defaults are **local and free** (Transformers.js) plus Groq's
free tier, and each is swappable to OpenAI / Cohere / Anthropic / R2 via env with no
call-site changes. See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design record.

## Features by milestone

1. **Data layer** — 11-table Drizzle schema, pgvector, the §4.3 indexes, seed data, org-scoped
   ticket list (keyset pagination) + detail. Enforced multi-tenancy via `withOrg()`.
2. **Ingestion pipeline** — PDF upload → BullMQ fan-out flow (parent splits, children embed) →
   chunk → embed (local, 384-dim) → `ready`. Idempotent, retried with backoff+jitter, with a
   stuck-job sweeper. `/documents` UI.
3. **RAG query** — hybrid retrieval + RRF + local cross-encoder rerank → cited answers with a
   refusal gate. `/kb` UI, `POST /api/kb/query`, and a retrieval eval (`npm run eval`).
4. **Agent + email** — simulated inbound-email webhook → ticket; a tool-calling triage agent
   (5 tools) that classifies, retrieves, and **drafts** a reply; human-in-the-loop
   Approve/Edit/Escalate on the ticket page; sensitive topics escalate, never auto-draft.
5. **Observability + ops** — `/ops` view: queue health, document pipeline, agent
   cost/latency from `agent_runs`, with re-enqueue / retry actions and a request→queue→job
   correlation id.

## Tech stack

Next.js 14 (App Router, TypeScript strict) · PostgreSQL (Neon) + pgvector · Drizzle ORM ·
BullMQ on Redis · Transformers.js (local embeddings + reranker) · Groq (agent LLM) ·
Tailwind CSS · Vitest.

## How to run

**Prerequisites:** Node 20+, a [Neon](https://neon.tech) Postgres database, Docker (for local
Redis), and a free [Groq](https://console.groq.com) API key (only needed for answer/agent
generation — retrieval and the eval run without it).

```bash
# 1. Install
npm install

# 2. Configure — copy the example and fill in your secrets
cp .env.example .env.local
#   set DATABASE_URL=...  GROQ_API_KEY=...   (REDIS_URL defaults to redis://localhost:6379)

# 3. Database — apply migrations and seed demo data (writes DEMO_ORG_ID into .env.local)
npm run db:migrate
npm run db:seed

# 4. Local Redis (for the worker)
docker run -d --name propmanage-redis -p 6379:6379 redis:7-alpine

# 5. Run — web and worker are two processes
npm run dev      # http://localhost:3000   (tickets, documents, kb, ops)
npm run worker   # ingestion + email + triage workers (separate terminal)
```

Then: `/documents` to upload a PDF, `/kb` to ask a grounded question, `/tickets` to see
AI-drafted replies, `/ops` for queue/agent health. To drive the agent end-to-end, POST a
simulated email (see [docs/demo-ingestion.md](docs/demo-ingestion.md) and the demo below).

**Scripts:** `npm run typecheck` · `npm run lint` · `npm test` · `npm run eval`.

## Design decisions

Full decision records are in [docs/decisions.md](docs/decisions.md). Highlights:

- **Schema indexing** — the hot ticket-list path is served by a composite
  `(organization_id, status, created_at desc)` index plus a partial open-tickets index;
  vector search by HNSW (`vector_cosine_ops`), keyword by a GIN index on a generated
  `tsvector`. Keyset pagination, not `OFFSET`, so deep pages stay fast.
- **Queue idempotency & retries** — at-least-once delivery is made safe with deterministic
  job ids, `on conflict` upserts, and a `pending → processing → ready | failed` state
  machine; a 200-page PDF fans out into independently-retried embed batches; failures are
  retried with exponential backoff + jitter and retained in the failed set.
- **Hybrid retrieval + rerank** — dense and sparse retrieval fail in opposite ways; RRF
  (k=60) fuses them rank-wise (no score calibration), and a cross-encoder reranks the fused
  candidates. Measured on 15 near-duplicate property docs / 13 chunk-level questions:

  | config         | hit-rate@5 | MRR   |
  |----------------|-----------:|------:|
  | vector-only    |       1.00 | 0.962 |
  | keyword-only   |       1.00 | 0.900 |
  | hybrid+rerank  |       1.00 | 0.962 |

  Honest reading: on a small clean corpus dense retrieval is already strong, so hybrid+rerank
  *ties* the best single retriever while clearly beating keyword-only — its value is
  robustness (it can't do worse than the better signal, whichever the query needs), and it
  pulls ahead on noisier/exact-token corpora.

- **Human-in-the-loop agent guardrails** — the agent only ever produces a **draft**; a human
  approves sending. Sensitive topics (money/rent/deposit/contract/legal/eviction) are
  escalated, never drafted — enforced in code (`draft_reply` re-checks sensitivity and
  escalates regardless of what the model decided), not just in the prompt. Every run is
  logged to `agent_runs` (tools, tokens, latency, status), making cost and behaviour
  auditable.

### Agent, verified end-to-end

| Scenario | Result |
|---|---|
| Routine email (tenant → property) | `search_knowledge_base → classify_ticket → draft_reply`, grounded draft with `[1]` citation, ~2.9s / ~1019 tokens |
| Approve | draft → **sent** |
| Rent/legal email | **escalated** (`escalate_to_human` only, ~0.6s), no draft |
| Duplicate `messageId` | de-duplicated → exactly one ticket |

## Testing

`npm test` (Vitest) covers the parts most likely to break silently: ingestion idempotency &
failure-exhaustion, RRF ranking & the refusal gate, inbound-email dedupe, sensitive-topic
escalation enforcement, and ops metrics aggregation / re-enqueue idempotency. Integration
tests use real Postgres + Redis with mocked LLM/embeddings.

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — the full technical design and the reasoning behind it.
- [docs/decisions.md](docs/decisions.md) — focused decision records for every milestone.
