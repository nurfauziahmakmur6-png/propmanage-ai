# Demo — Upload a PDF and watch it reach `ready`

Milestone 2 ingestion pipeline. Three terminals (Redis, worker, web) plus a curl.

## 0. Prerequisites (one-time)

```bash
# Local Redis via Docker
docker run -d --name propmanage-redis -p 6379:6379 redis:7-alpine
docker exec propmanage-redis redis-cli ping   # -> PONG

# .env.local must contain DATABASE_URL, DEMO_ORG_ID, and:
#   REDIS_URL=redis://localhost:6379
#   EMBEDDING_PROVIDER=local

npm install
npm run db:migrate     # applies the 384-dim embedding migration
```

## 1. Start the worker (separate process)

```bash
npm run worker
```

You'll see `{"event":"worker.started","embedder":"Xenova/bge-small-en-v1.5","dimensions":384,...}`.
The model (~30MB) downloads once on the first embed job.

## 2. Start the web app

```bash
npm run dev        # http://localhost:3000/documents
```

## 3. Upload a sample PDF

Generate a 2-page sample and upload it:

```bash
npx tsx scripts/make-sample-pdf.ts sample.pdf

curl -s -X POST http://localhost:3000/api/documents \
  -F "file=@sample.pdf;type=application/pdf" \
  -F "title=Oakwood House Rules (sample)"
# -> {"id":"<docId>","status":"pending","enqueue":"enqueued"}
```

Or just use the upload control on `/documents`.

## 4. Watch it reach `ready`

The `/documents` page auto-refreshes while anything is `pending`/`processing`. Or poll the API:

```bash
curl -s http://localhost:3000/api/documents | npx tsx -e \
  'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{for(const x of JSON.parse(d).documents)console.log(x.status,x.chunkCount,x.title)})'
```

You'll watch `pending → processing → ready`, and `chunkCount` become non-zero. The worker
log shows the structured lifecycle:

```
split.chunked        documentId=… chunkCount=4
embed.batch.done     documentId=… batchIndex=0 embedded=4
finalize.ready       documentId=…
ingestion.completed  documentId=…
```

## What to try next

- **Idempotency:** re-run the automated proof — `npm test` runs ingestion twice for one
  document and asserts the chunk count is unchanged, plus a failure test that drives a doc
  to `failed` (not stuck) after 5 attempts.
- **Crash recovery:** kill `npm run worker` mid-ingestion, restart it — the document
  finishes (BullMQ redelivery), and any document left in `processing` past 5 minutes is
  re-enqueued by the sweeper.
