import type { EmbeddingProvider } from "./types";
import { LocalEmbeddingProvider } from "./local";

export type { EmbeddingProvider } from "./types";

let cached: EmbeddingProvider | null = null;

// Provider is selected by env so OpenAI (1536-dim) can be swapped in later without
// touching call sites. Defaults to the free local model.
export function getEmbeddingProvider(): EmbeddingProvider {
  if (cached) return cached;
  const choice = process.env.EMBEDDING_PROVIDER ?? "local";
  switch (choice) {
    case "local":
      cached = new LocalEmbeddingProvider();
      return cached;
    default:
      throw new Error(`Unknown EMBEDDING_PROVIDER: ${choice}`);
  }
}
