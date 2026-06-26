import { describe, it, expect } from "vitest";
import { reciprocalRankFusion } from "../lib/retrieval/rrf";
import { composeAnswer, REFUSAL } from "../lib/answer";
import type { RetrievedChunk } from "../lib/retrieval";
import type { LLMProvider, LLMCompletion, LLMChatResult } from "../lib/llm";

class SpyLLM implements LLMProvider {
  readonly id = "spy";
  calls = 0;
  async complete(): Promise<LLMCompletion> {
    this.calls++;
    return { text: "The bins go out on Tuesday [1].", model: "spy" };
  }
  async chat(): Promise<LLMChatResult> {
    return { text: null, toolCalls: [], finishReason: "stop" };
  }
}

function chunk(partial: Partial<RetrievedChunk> & { id: string; rerankScore: number }): RetrievedChunk {
  return {
    documentId: "doc-1",
    content: "content",
    metadata: null,
    ...partial,
  };
}

describe("reciprocal rank fusion", () => {
  it("ranks a doc returned by both retrievers above one returned by only one", () => {
    // A is rank 2 in both lists; B and C are each rank 1 in a single list.
    const vector = ["B", "A"];
    const keyword = ["C", "A"];
    const fused = reciprocalRankFusion([vector, keyword]);
    expect(fused[0].id).toBe("A");
    const a = fused.find((f) => f.id === "A")!;
    const b = fused.find((f) => f.id === "B")!;
    const c = fused.find((f) => f.id === "C")!;
    expect(a.score).toBeGreaterThan(b.score);
    expect(a.score).toBeGreaterThan(c.score);
  });

  it("sums contributions and orders by fused score", () => {
    const fused = reciprocalRankFusion([
      ["x", "y", "z"],
      ["y", "x"],
    ]);
    // x: 1/61 + 1/62 ; y: 1/62 + 1/61  -> equal; both above z (1/63)
    expect(fused.map((f) => f.id).slice(0, 2).sort()).toEqual(["x", "y"]);
    expect(fused[fused.length - 1].id).toBe("z");
  });
});

describe("answer refusal gate", () => {
  it("refuses without calling the LLM when no chunk clears the threshold", async () => {
    const llm = new SpyLLM();
    const ranked = [
      chunk({ id: "c1", rerankScore: 0.08 }),
      chunk({ id: "c2", rerankScore: 0.12 }),
    ];
    const result = await composeAnswer("when is rubbish collected?", ranked, new Map(), llm, 0.3);

    expect(result.usedFallback).toBe(true);
    expect(result.answer).toBe(REFUSAL);
    expect(result.sources).toHaveLength(0);
    expect(llm.calls).toBe(0); // the LLM must not be called on refusal
  });

  it("calls the LLM and returns cited sources when a chunk clears the threshold", async () => {
    const llm = new SpyLLM();
    const ranked = [
      chunk({ id: "c1", documentId: "d1", rerankScore: 0.92, metadata: { page: 3, section: "Waste" } }),
      chunk({ id: "c2", documentId: "d2", rerankScore: 0.10 }),
    ];
    const titles = new Map([["d1", "Oakwood House Rules"]]);
    const result = await composeAnswer("when is rubbish collected?", ranked, titles, llm, 0.3);

    expect(result.usedFallback).toBe(false);
    expect(llm.calls).toBe(1);
    expect(result.sources).toHaveLength(1); // only the chunk above threshold
    expect(result.sources[0]).toMatchObject({
      ref: 1,
      documentId: "d1",
      title: "Oakwood House Rules",
      page: 3,
      section: "Waste",
    });
  });
});
