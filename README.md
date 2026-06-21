# PropManage AI

A portfolio project: an AI-first backend for property-management companies, mirroring the
problem space of products like hausverwalter.ai. Managers upload property documents,
tenants and staff raise tickets, and an AI agent triages those tickets and answers
questions grounded in the company's own documents. The emphasis is deliberately on
systems-design depth — a multi-tenant data layer with considered indexing, a crash-safe
background-processing pipeline, retrieval-augmented generation, and a tool-using agent —
rather than breadth of features.

## Stack

- **Web/API:** Next.js 14 (App Router, route handlers), TypeScript (strict)
- **Database:** PostgreSQL (Neon) + `pgvector`, Drizzle ORM with explicit migrations
- **Background work:** BullMQ on Redis, run as a **separate** worker process
- **Embeddings:** Transformers.js `bge-small-en-v1.5` (384-dim, local, no API key) behind a
  swappable `EmbeddingProvider`
- **Storage:** local filesystem behind a swappable `StorageProvider` (R2/Cloudinary later)
- **UI:** Tailwind CSS

## Milestones

1. **Data layer** — schema, migrations, indexes, seed, org-scoped ticket list/detail. ✅
2. **Ingestion pipeline** — upload → queue → chunk → embed → `ready`, idempotent and
   crash-safe. ✅
3. RAG query · 4. Agent + email · 5. Observability — _planned_.

## How to run

**Prerequisites:** Node 20+, a [Neon](https://neon.tech) Postgres database, and Docker (for
local Redis).

```bash
# 1. Install
npm install

# 2. Configure — copy the example and fill in your Neon connection string
cp .env.example .env.local
#   set DATABASE_URL=...   (REDIS_URL defaults to redis://localhost:6379)

# 3. Database — apply migrations and seed demo data
#    (db:seed writes DEMO_ORG_ID into .env.local)
npm run db:migrate
npm run db:seed

# 4. Local Redis (for the ingestion worker)
docker run -d --name propmanage-redis -p 6379:6379 redis:7-alpine

# 5. Run — web app and worker are two processes
npm run dev      # http://localhost:3000  (tickets + documents UI)
npm run worker   # ingestion worker (separate terminal)
```

Then open `/tickets` to browse seeded tickets, or `/documents` to upload a PDF and watch it
go `pending → processing → ready`. See [docs/demo-ingestion.md](docs/demo-ingestion.md) for a
step-by-step ingestion walkthrough.

**Useful scripts:** `npm run typecheck`, `npm run lint`, `npm test` (idempotency +
failure-handling tests for the pipeline).

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — the full technical design (data model, queues, RAG,
  agent, failure modes) and the reasoning behind each choice.
- [docs/decisions.md](docs/decisions.md) — focused decision records: why each index exists,
  how org-scoping is enforced, keyset vs OFFSET, the ingestion idempotency/retry/sweeper
  design.
