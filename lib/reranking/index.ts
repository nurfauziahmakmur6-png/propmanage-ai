import type { Reranker } from "./types";
import { LocalReranker } from "./local";

export type { Reranker } from "./types";

let cached: Reranker | null = null;

export function getReranker(): Reranker {
  if (cached) return cached;
  const choice = process.env.RERANKER ?? "local";
  switch (choice) {
    case "local":
      cached = new LocalReranker();
      return cached;
    default:
      throw new Error(`Unknown RERANKER: ${choice}`);
  }
}
