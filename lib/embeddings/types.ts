export interface EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;
  // Documents/passages are embedded without an instruction prefix.
  embedPassages(texts: string[]): Promise<number[][]>;
  // Queries get the model's retrieval instruction prefix where required.
  embedQuery(text: string): Promise<number[]>;
}
