import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { documents } from "@/db/schema";
import { listDocumentsWithChunkCounts } from "@/lib/documents";
import { getStorageProvider, documentStorageKey } from "@/lib/storage";
import { enqueueIngestion } from "@/lib/queue/queues";

// bullmq/ioredis and fs require the Node.js runtime, not edge.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 25 * 1024 * 1024;

function orgId(): string {
  const id = process.env.DEMO_ORG_ID;
  if (!id) throw new Error("DEMO_ORG_ID is not set");
  return id;
}

export async function GET() {
  const rows = await listDocumentsWithChunkCounts(orgId());
  return NextResponse.json({ documents: rows });
}

export async function POST(req: Request) {
  const organizationId = orgId();

  const form = await req.formData();
  const file = form.get("file");
  const title = (form.get("title") as string | null)?.trim();

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing file" }, { status: 400 });
  }
  const isPdf =
    file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  if (!isPdf) {
    return NextResponse.json({ error: "Only PDF files are accepted" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "File exceeds 25MB limit" }, { status: 400 });
  }

  const documentId = randomUUID();
  const storageKey = documentStorageKey(organizationId, documentId);
  const buffer = Buffer.from(await file.arrayBuffer());

  // Persist the file first; if storage fails we never create a dangling pending row.
  await getStorageProvider().save(storageKey, buffer);

  await db.insert(documents).values({
    id: documentId,
    organizationId,
    title: title && title.length > 0 ? title : file.name,
    storageKey,
    mimeType: file.type || "application/pdf",
    status: "pending",
  });

  // Deterministic job id makes a double-submit a no-op.
  const result = await enqueueIngestion({ documentId, organizationId });

  return NextResponse.json({ id: documentId, status: "pending", enqueue: result }, { status: 201 });
}
