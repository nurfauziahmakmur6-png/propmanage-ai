export interface ChunkMetadata {
  page: number;
  section: string | null;
}

export interface Chunk {
  content: string;
  metadata: ChunkMetadata;
  tokenCount: number;
}

const MAX_TOKENS = 600;
const OVERLAP_TOKENS = 80;

// We have no model tokenizer here; ~4 chars/token is a good English approximation and
// only needs to be consistent, not exact, to bound chunk size.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const MAX_CHARS = MAX_TOKENS * 4;

interface Segment {
  text: string;
  page: number;
  section: string | null;
}

function isHeading(line: string): boolean {
  const t = line.trim();
  if (t.length === 0 || t.length > 80) return false;
  if (/[.!?,;:]$/.test(t)) return false;
  if (/^#{1,6}\s+\S/.test(t)) return true; // markdown heading
  if (/^\d+(\.\d+)*\.?\s+\S/.test(t)) return true; // "12.3 Repairs"
  if (t === t.toUpperCase() && /[A-Z]/.test(t)) return true; // ALL CAPS
  return false;
}

function splitParagraphs(pageText: string): string[] {
  return pageText
    .split(/\n\s*\n/)
    .map((p) => p.replace(/[ \t]+\n/g, "\n").trim())
    .filter((p) => p.length > 0);
}

// Break a paragraph that exceeds MAX_CHARS into sentence-sized pieces, hard-splitting
// any single sentence that is still too long.
function splitLongParagraph(paragraph: string): string[] {
  const sentences = paragraph.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [paragraph];
  const pieces: string[] = [];
  let buf = "";
  for (const s of sentences) {
    const sentence = s.trim();
    if (sentence.length === 0) continue;
    if (sentence.length > MAX_CHARS) {
      if (buf) {
        pieces.push(buf);
        buf = "";
      }
      for (let i = 0; i < sentence.length; i += MAX_CHARS) {
        pieces.push(sentence.slice(i, i + MAX_CHARS));
      }
      continue;
    }
    const candidate = buf ? `${buf} ${sentence}` : sentence;
    if (candidate.length > MAX_CHARS) {
      if (buf) pieces.push(buf);
      buf = sentence;
    } else {
      buf = candidate;
    }
  }
  if (buf) pieces.push(buf);
  return pieces;
}

function toSegments(pages: string[]): Segment[] {
  const segments: Segment[] = [];
  let section: string | null = null;
  pages.forEach((pageText, i) => {
    const page = i + 1;
    for (const paragraph of splitParagraphs(pageText)) {
      const firstLine = paragraph.split("\n")[0];
      if (isHeading(firstLine)) {
        section = firstLine.replace(/^#{1,6}\s+/, "").trim();
      }
      const pieces =
        paragraph.length > MAX_CHARS ? splitLongParagraph(paragraph) : [paragraph];
      for (const text of pieces) {
        segments.push({ text, page, section });
      }
    }
  });
  return segments;
}

function makeChunk(segs: Segment[]): Chunk {
  const content = segs.map((s) => s.text).join("\n\n");
  return {
    content,
    metadata: { page: segs[0].page, section: segs[0].section },
    tokenCount: estimateTokens(content),
  };
}

/**
 * Recursively chunk per-page text to ~600 tokens with ~80-token overlap, preferring
 * paragraph and heading boundaries. Overlap is carried as whole trailing segments so
 * chunk boundaries never cut mid-paragraph.
 */
export function chunkPages(pages: string[]): Chunk[] {
  const segments = toSegments(pages);
  const chunks: Chunk[] = [];
  let current: Segment[] = [];
  let currentTokens = 0;

  for (const seg of segments) {
    const segTokens = estimateTokens(seg.text);
    if (currentTokens + segTokens > MAX_TOKENS && current.length > 0) {
      chunks.push(makeChunk(current));
      const overlap: Segment[] = [];
      let overlapTokens = 0;
      for (let i = current.length - 1; i >= 0; i--) {
        const t = estimateTokens(current[i].text);
        if (overlapTokens + t > OVERLAP_TOKENS && overlap.length > 0) break;
        overlap.unshift(current[i]);
        overlapTokens += t;
      }
      current = [...overlap];
      currentTokens = overlapTokens;
    }
    current.push(seg);
    currentTokens += segTokens;
  }
  if (current.length > 0) chunks.push(makeChunk(current));
  return chunks;
}
