import { NextResponse } from "next/server";
import { reenqueueDocument } from "@/lib/ops/actions";
import { logEvent, newRequestId } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function orgId(): string {
  const id = process.env.DEMO_ORG_ID;
  if (!id) throw new Error("DEMO_ORG_ID is not set");
  return id;
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const organizationId = orgId();
  const { id } = await params;
  const requestId = newRequestId();
  const result = await reenqueueDocument(organizationId, id);
  logEvent("ops.reenqueue_document", { requestId, documentId: id, result });
  if (result === "not-found") {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }
  return NextResponse.json({ result });
}
