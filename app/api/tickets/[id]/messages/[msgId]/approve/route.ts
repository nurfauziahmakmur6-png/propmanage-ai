import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { ticketMessages } from "@/db/schema";
import { withOrgFilter } from "@/lib/withOrg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function orgId(): string {
  const id = process.env.DEMO_ORG_ID;
  if (!id) throw new Error("DEMO_ORG_ID is not set");
  return id;
}

// Human-in-the-loop approval: flips an AI draft message to sent (simulated send). An
// optional edited body lets the reviewer tweak the draft before approving. Only a draft on
// the named ticket can be approved.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; msgId: string }> }
) {
  const organizationId = orgId();
  const { id, msgId } = await params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const edited = typeof body.body === "string" ? body.body.trim() : undefined;

  const updated = await db
    .update(ticketMessages)
    .set({ status: "sent", ...(edited ? { body: edited } : {}) })
    .where(
      withOrgFilter(
        organizationId,
        ticketMessages,
        eq(ticketMessages.id, msgId),
        eq(ticketMessages.ticketId, id),
        eq(ticketMessages.status, "draft")
      )
    )
    .returning({ id: ticketMessages.id, body: ticketMessages.body, status: ticketMessages.status });

  if (updated.length === 0) {
    return NextResponse.json({ error: "No draft message found to approve" }, { status: 404 });
  }
  return NextResponse.json({ status: "sent", message: updated[0] });
}
