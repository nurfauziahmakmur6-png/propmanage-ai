import { writeFileSync } from "fs";

// Minimal dependency-free PDF writer: enough to produce a multi-page text PDF that
// unpdf/pdf.js can extract, for the ingestion demo.
function escapePdfText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function buildPdf(pages: string[][]): Buffer {
  const objects: string[] = [];
  // 1: catalog, 2: pages, 3: font, then per page: a Page obj and a Contents obj.
  const pageRefs: number[] = [];
  const perPage: Array<{ pageObj: string; contentObj: string }> = [];

  pages.forEach((lines, k) => {
    const pageObjNum = 4 + 2 * k;
    const contentObjNum = 5 + 2 * k;
    pageRefs.push(pageObjNum);

    let content = "BT\n/F1 12 Tf\n14 TL\n50 760 Td\n";
    for (const line of lines) {
      content += `(${escapePdfText(line)}) Tj\nT*\n`;
    }
    content += "ET\n";

    const pageObj = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentObjNum} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`;
    const contentObj = `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`;
    perPage.push({ pageObj, contentObj });
  });

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageRefs.map((r) => `${r} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  perPage.forEach(({ pageObj, contentObj }, k) => {
    objects[4 + 2 * k] = pageObj;
    objects[5 + 2 * k] = contentObj;
  });

  const total = objects.length - 1; // objects is 1-indexed
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i <= total; i++) {
    offsets[i] = Buffer.byteLength(body, "latin1");
    body += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }

  const xrefStart = Buffer.byteLength(body, "latin1");
  let xref = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= total; i++) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(body + xref + trailer, "latin1");
}

function sampleLines(sectionStart: number): string[] {
  const lines: string[] = [];
  for (let i = sectionStart; i < sectionStart + 18; i++) {
    lines.push(
      `Section ${i}. Tenants must keep common areas clean and observe quiet hours between`
    );
    lines.push(
      "ten in the evening and eight in the morning on weekdays. Rubbish bins are emptied"
    );
    lines.push(
      "on Tuesday and Friday. Maintenance requests should be raised through the portal."
    );
    lines.push("");
  }
  return lines;
}

const outPath = process.argv[2] ?? "sample.pdf";
const pdf = buildPdf([sampleLines(1), sampleLines(19)]);
writeFileSync(outPath, pdf);
console.log(`Wrote ${outPath} (${pdf.length} bytes, 2 pages)`);
