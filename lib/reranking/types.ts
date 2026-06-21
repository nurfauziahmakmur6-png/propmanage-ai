export interface Reranker {
  readonly id: string;
  // Returns a relevance score in [0, 1] for each passage, aligned to the input order.
  rerank(query: string, passages: string[]): Promise<number[]>;
}
