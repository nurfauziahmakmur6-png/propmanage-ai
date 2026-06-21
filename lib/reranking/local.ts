import {
  AutoTokenizer,
  AutoModelForSequenceClassification,
  type PreTrainedTokenizer,
  type PreTrainedModel,
} from "@huggingface/transformers";
import type { Reranker } from "./types";

const MODEL_ID = "Xenova/ms-marco-MiniLM-L-6-v2";
const SUB_BATCH = 16;

// Cross-encoder reranker: scores each (query, passage) pair jointly rather than via two
// independent embeddings, which is far more precise for the final ranking. The model
// outputs a single relevance logit per pair; we sigmoid it into [0, 1].
let loadPromise: Promise<{ tokenizer: PreTrainedTokenizer; model: PreTrainedModel }> | null = null;

function load() {
  if (!loadPromise) {
    loadPromise = Promise.all([
      AutoTokenizer.from_pretrained(MODEL_ID),
      AutoModelForSequenceClassification.from_pretrained(MODEL_ID),
    ]).then(([tokenizer, model]) => ({ tokenizer, model }));
  }
  return loadPromise;
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export class LocalReranker implements Reranker {
  readonly id = MODEL_ID;

  async rerank(query: string, passages: string[]): Promise<number[]> {
    if (passages.length === 0) return [];
    const { tokenizer, model } = await load();
    const scores: number[] = [];
    for (let i = 0; i < passages.length; i += SUB_BATCH) {
      const batch = passages.slice(i, i + SUB_BATCH);
      const inputs = tokenizer(new Array(batch.length).fill(query), {
        text_pair: batch,
        padding: true,
        truncation: true,
      });
      const output = await model(inputs);
      // logits shape [N, 1] for this regression-style cross-encoder.
      const logits = output.logits.tolist() as number[][];
      for (const row of logits) scores.push(sigmoid(row[0]));
    }
    return scores;
  }
}
