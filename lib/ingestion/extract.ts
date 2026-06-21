import { extractText, getDocumentProxy } from "unpdf";

// Returns the text of each page. Per-page text lets the chunker record which page a
// chunk starts on. OCR for scanned PDFs is noted as future work.
export async function extractPdfPages(data: Buffer): Promise<string[]> {
  const pdf = await getDocumentProxy(new Uint8Array(data));
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = Array.isArray(text) ? text : [text];
  return pages.map((p) => p ?? "");
}
