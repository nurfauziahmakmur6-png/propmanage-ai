import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import type { EmbeddingProvider } from "./types";

const MODEL_ID = "Xenova/bge-small-en-v1.5";
const DIMENSIONS = 384;
const SUB_BATCH = 16;

// bge-small-en-v1.5 only requires an instruction on the QUERY side; passages are
// embedded as-is. See the model card.
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

// The model weights are downloaded once on first use and cached on disk, then the
// pipeline is reused across all jobs in this worker process.
let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorPromise) {
    extractorPromise = pipeline("feature-extraction", MODEL_ID);
  }
  return extractorPromise;
}

async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const extractor = await getExtractor();
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += SUB_BATCH) {
    const batch = texts.slice(i, i + SUB_BATCH);
    // pooling: "mean" + normalize: true => mean-pooled, L2-normalized vectors.
    const tensor = await extractor(batch, { pooling: "mean", normalize: true });
    out.push(...(tensor.tolist() as number[][]));
  }
  return out;
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly id = MODEL_ID;
  readonly dimensions = DIMENSIONS;

  async embedPassages(texts: string[]): Promise<number[][]> {
    return embed(texts);
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vec] = await embed([QUERY_PREFIX + text]);
    return vec;
  }
}
