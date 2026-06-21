import "../lib/env";

import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { organizations, documents, documentChunks } from "../db/schema";
import { LocalEmbeddingProvider } from "../lib/embeddings/local";
import { LocalReranker } from "../lib/reranking/local";
import { splitDocument, runEmbedBatch, type PipelineDeps } from "../lib/ingestion/pipeline";
import { vectorSearch, keywordSearch } from "../lib/retrieval/search";
import { retrieve } from "../lib/retrieval";

const embeddingProvider = new LocalEmbeddingProvider();
const reranker = new LocalReranker();

interface SampleDoc {
  key: string;
  title: string;
  docType: string;
  text: string;
}

// Three properties, each with the same five policy topics but different specifics. This
// produces near-duplicate chunks across properties (e.g. three "quiet hours" notes) — the
// case where pure vector similarity gets confused and the cross-encoder reranker, which
// reads the property name jointly with the question, pulls ahead.
const SAMPLE_DOCS: SampleDoc[] = [
  // Oakwood Apartments
  { key: "oak-quiet", title: "Oakwood Apartments — Quiet Hours", docType: "house_rules",
    text: "Oakwood Apartments — Quiet Hours. At Oakwood Apartments, quiet hours run from 10pm to 7am on weekdays and from 11pm to 8am at weekends. Keep music and television low during these hours." },
  { key: "oak-bins", title: "Oakwood Apartments — Rubbish Collection", docType: "house_rules",
    text: "Oakwood Apartments — Rubbish Collection. At Oakwood Apartments, general waste is collected on Tuesday and Friday, and recycling on Wednesday. Move bins to the kerb the night before." },
  { key: "oak-pets", title: "Oakwood Apartments — Pets", docType: "house_rules",
    text: "Oakwood Apartments — Pets. At Oakwood Apartments, dogs are allowed with prior written approval, and cats are always welcome in every unit." },
  { key: "oak-rent", title: "Oakwood Apartments — Rent", docType: "lease",
    text: "Oakwood Apartments — Rent. At Oakwood Apartments, rent is due on the first of each month, and a late fee of fifty dollars applies after five days." },
  { key: "oak-deposit", title: "Oakwood Apartments — Deposit", docType: "lease",
    text: "Oakwood Apartments — Deposit. At Oakwood Apartments, the security deposit is one and a half months of rent, returned within thirty days of move-out." },

  // Maple Court
  { key: "maple-quiet", title: "Maple Court — Quiet Hours", docType: "house_rules",
    text: "Maple Court — Quiet Hours. At Maple Court, quiet hours run from 9pm to 6am on weekdays. Avoid using washing machines and vacuum cleaners during this time." },
  { key: "maple-bins", title: "Maple Court — Rubbish Collection", docType: "house_rules",
    text: "Maple Court — Rubbish Collection. At Maple Court, general waste is collected on Monday and Thursday, with garden waste on the first Monday of the month." },
  { key: "maple-pets", title: "Maple Court — Pets", docType: "house_rules",
    text: "Maple Court — Pets. At Maple Court, dogs are not permitted anywhere in the building; only small caged animals are allowed." },
  { key: "maple-rent", title: "Maple Court — Rent", docType: "lease",
    text: "Maple Court — Rent. At Maple Court, rent is due on the fifth of the month, and a late fee of seventy-five dollars applies after three days." },
  { key: "maple-deposit", title: "Maple Court — Deposit", docType: "lease",
    text: "Maple Court — Deposit. At Maple Court, the security deposit is two months of rent, paid in full before move-in." },

  // Riverside Lofts
  { key: "river-quiet", title: "Riverside Lofts — Quiet Hours", docType: "house_rules",
    text: "Riverside Lofts — Quiet Hours. At Riverside Lofts, quiet hours run from 11pm to 8am every day. Please be considerate of neighbours in adjacent lofts." },
  { key: "river-bins", title: "Riverside Lofts — Rubbish Collection", docType: "house_rules",
    text: "Riverside Lofts — Rubbish Collection. At Riverside Lofts, all waste and recycling is collected on Wednesday only. Bins left out on other days may be fined." },
  { key: "river-pets", title: "Riverside Lofts — Pets", docType: "house_rules",
    text: "Riverside Lofts — Pets. At Riverside Lofts, both cats and dogs are welcome, with no breed restrictions." },
  { key: "river-rent", title: "Riverside Lofts — Rent", docType: "lease",
    text: "Riverside Lofts — Rent. At Riverside Lofts, rent is due on the first day, and a late fee of forty dollars applies after seven days." },
  { key: "river-deposit", title: "Riverside Lofts — Deposit", docType: "lease",
    text: "Riverside Lofts — Deposit. At Riverside Lofts, the security deposit equals one month of rent." },
];

interface EvalCase {
  question: string;
  expect: string;
  // A phrase that appears only in the target chunk, used to resolve the expected chunk id
  // after ingestion (chunk ids are generated, so the fixture pins content, not ids).
  answerContains: string;
}

// A mix of exact questions (property + topic words present — the near-duplicate chunks make
// vector alone err) and paraphrased questions (topic words absent, e.g. "noise"/"garbage" —
// keyword alone matches only the property name and picks the wrong topic). Neither single
// retriever is perfect; hybrid + rerank covers both failure modes.
const FIXTURE: EvalCase[] = [
  { question: "What are the quiet hours at Maple Court?", expect: "maple-quiet", answerContains: "9pm to 6am" },
  { question: "Which days is rubbish collected at Oakwood Apartments?", expect: "oak-bins", answerContains: "Tuesday and Friday" },
  { question: "Are dogs welcome at Riverside Lofts?", expect: "river-pets", answerContains: "both cats and dogs are welcome" },
  { question: "What is the late fee at Maple Court?", expect: "maple-rent", answerContains: "seventy-five dollars" },
  { question: "How large is the security deposit at Riverside Lofts?", expect: "river-deposit", answerContains: "one month of rent" },
  { question: "When should residents keep the noise down at Oakwood Apartments?", expect: "oak-quiet", answerContains: "10pm to 7am" },
  { question: "How is garbage handled at Maple Court?", expect: "maple-bins", answerContains: "Monday and Thursday" },
  { question: "How much must I pay upfront before moving in at Maple Court?", expect: "maple-deposit", answerContains: "two months of rent" },
  { question: "When does rent need to be paid at Oakwood Apartments?", expect: "oak-rent", answerContains: "first of each month" },
  { question: "What is the late fee at Riverside Lofts?", expect: "river-rent", answerContains: "forty dollars" },
  { question: "What penalty applies for paying rent late at Oakwood Apartments?", expect: "oak-rent", answerContains: "first of each month" },
  { question: "Is there a charge for paying late at Riverside Lofts?", expect: "river-rent", answerContains: "forty dollars" },
  { question: "What refundable amount is held at Oakwood Apartments?", expect: "oak-deposit", answerContains: "one and a half months" },
];

async function findExpectedChunkId(
  organizationId: string,
  documentId: string,
  phrase: string
): Promise<string> {
  const rows = await db
    .select({ id: documentChunks.id, content: documentChunks.content })
    .from(documentChunks)
    .where(
      and(
        eq(documentChunks.organizationId, organizationId),
        eq(documentChunks.documentId, documentId)
      )
    );
  const match = rows.find((r) => r.content.includes(phrase));
  if (!match) throw new Error(`No ingested chunk contains phrase: "${phrase}"`);
  return match.id;
}

async function ingestSamples(organizationId: string): Promise<Map<string, string>> {
  const keyToId = new Map<string, string>();
  const textById = new Map<string, string>();
  for (const d of SAMPLE_DOCS) {
    const id = randomUUID();
    keyToId.set(d.key, id);
    textById.set(id, d.text);
    await db.insert(documents).values({
      id,
      organizationId,
      title: d.title,
      docType: d.docType,
      storageKey: `${organizationId}/${id}.pdf`,
      mimeType: "application/pdf",
      status: "pending",
    });
  }

  const deps: PipelineDeps = {
    embeddingProvider,
    loadPages: async (documentId) => [textById.get(documentId)!],
  };
  for (const id of keyToId.values()) {
    const batches = await splitDocument({ documentId: id, organizationId }, deps);
    for (const b of batches) {
      await runEmbedBatch(
        {
          documentId: id,
          organizationId,
          batchIndex: b.batchIndex,
          fromChunkIndex: b.fromChunkIndex,
          toChunkIndex: b.toChunkIndex,
        },
        deps
      );
    }
  }
  return keyToId;
}

type RankFn = (question: string, organizationId: string) => Promise<string[]>;

const vectorOnly: RankFn = async (q, org) => {
  const qVec = await embeddingProvider.embedQuery(q);
  const hits = await vectorSearch(qVec, { organizationId: org, limit: 20 });
  return hits.slice(0, 5).map((h) => h.id);
};

const keywordOnly: RankFn = async (q, org) => {
  const hits = await keywordSearch(q, { organizationId: org, limit: 20 });
  return hits.slice(0, 5).map((h) => h.id);
};

const hybridRerank: RankFn = async (q, org) => {
  const top = await retrieve(q, { embeddingProvider, reranker }, { organizationId: org, topN: 5 });
  return top.map((c) => c.id);
};

// Metric is at chunk granularity (§7.3, "question -> expected source chunk"): hit-rate@5 is
// whether the exact answer chunk appears in the top 5; MRR rewards ranking it higher.
async function evalConfig(
  name: string,
  rank: RankFn,
  expectedByQuestion: Map<string, string>,
  organizationId: string
): Promise<{ name: string; hitRate: number; mrr: number }> {
  let hits = 0;
  let rrSum = 0;
  for (const c of FIXTURE) {
    const expectedChunkId = expectedByQuestion.get(c.question)!;
    const chunkIds = await rank(c.question, organizationId);
    const idx = chunkIds.indexOf(expectedChunkId);
    if (idx >= 0) {
      hits++;
      rrSum += 1 / (idx + 1);
    }
  }
  return { name, hitRate: hits / FIXTURE.length, mrr: rrSum / FIXTURE.length };
}

async function main() {
  const [org] = await db
    .insert(organizations)
    .values({ name: `eval-${randomUUID()}` })
    .returning();

  try {
    console.log(`Ingesting ${SAMPLE_DOCS.length} sample documents...`);
    const keyToId = await ingestSamples(org.id);

    const expectedByQuestion = new Map<string, string>();
    for (const c of FIXTURE) {
      expectedByQuestion.set(
        c.question,
        await findExpectedChunkId(org.id, keyToId.get(c.expect)!, c.answerContains)
      );
    }

    console.log(
      `Evaluating ${FIXTURE.length} questions (chunk-level) across 3 retrieval configs...\n`
    );

    const results = [
      await evalConfig("vector-only", vectorOnly, expectedByQuestion, org.id),
      await evalConfig("keyword-only", keywordOnly, expectedByQuestion, org.id),
      await evalConfig("hybrid+rerank", hybridRerank, expectedByQuestion, org.id),
    ];

    const pad = (s: string, n: number) => s.padEnd(n);
    console.log(`${pad("config", 16)}${pad("hit-rate@5", 14)}MRR`);
    console.log("-".repeat(38));
    for (const r of results) {
      console.log(
        `${pad(r.name, 16)}${pad(r.hitRate.toFixed(2), 14)}${r.mrr.toFixed(3)}`
      );
    }
    console.log("");
  } finally {
    // Cascade-deletes the eval documents and chunks.
    await db.delete(organizations).where(eq(organizations.id, org.id));
  }
}

main().catch((err) => {
  console.error("eval failed:", err);
  process.exit(1);
});
