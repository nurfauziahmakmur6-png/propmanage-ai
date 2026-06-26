import { NextResponse } from "next/server";
import { persistInboundEmail } from "@/lib/email/process";
import { enqueueEmailProcessing } from "@/lib/queue/queues";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function orgId(): string {
  const id = process.env.DEMO_ORG_ID;
  if (!id) throw new Error("DEMO_ORG_ID is not set");
  return id;
}

// Simulated inbound-email webhook: accepts a JSON payload, persists it (deduped on
// messageId), and enqueues processing. A real provider (Postmark/Resend inbound) would post
// here; wiring DNS/signature verification is a later config step.
export async function POST(req: Request) {
  const organizationId = orgId();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const messageId = String(body.messageId ?? "").trim();
  const from = String(body.from ?? "").trim();

  if (!messageId || !from) {
    return NextResponse.json({ error: "messageId and from are required" }, { status: 400 });
  }

  const { inboundEmailId, duplicate } = await persistInboundEmail(organizationId, {
    messageId,
    from,
    subject: body.subject ? String(body.subject) : null,
    body: body.body ? String(body.body) : null,
    to: body.to ? String(body.to) : null,
  });

  if (duplicate) {
    return NextResponse.json({ status: "duplicate", inboundEmailId });
  }

  await enqueueEmailProcessing({ organizationId, inboundEmailId, messageId });
  return NextResponse.json({ status: "accepted", inboundEmailId }, { status: 202 });
}
