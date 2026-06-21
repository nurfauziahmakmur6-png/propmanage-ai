export const RRF_K = 60;

export interface FusedItem {
  id: string;
  score: number;
}

/**
 * Reciprocal Rank Fusion. Each ranked list contributes 1/(k + rank) to an item's score
 * (rank is 1-based). An item that ranks well in *both* the vector and keyword lists thus
 * accumulates a higher fused score than one that appears in only a single list — which is
 * exactly why hybrid retrieval beats either retriever alone. k dampens the weight of low
 * ranks; 60 is the canonical default from the original RRF paper.
 */
export function reciprocalRankFusion(rankedLists: string[][], k: number = RRF_K): FusedItem[] {
  const scores = new Map<string, number>();
  for (const list of rankedLists) {
    list.forEach((id, index) => {
      const rank = index + 1;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank));
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}
