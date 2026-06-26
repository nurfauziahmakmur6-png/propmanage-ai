import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { tickets } from "@/db/schema";
import { withOrgFilter } from "@/lib/withOrg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function orgId(): string {
  const id = process.env.DEMO_ORG_ID;
  if (!id) throw new Error("DEMO_ORG_ID is not set");
  return id;
}

// Manual escalation from the human-in-the-loop UI: flags the ticket for staff review.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const organizationId = orgId();
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const reason = String(body.reason ?? "Escalated by a staff member.").trim();
  const now = new Date().toISOString();

  const updated = await db
    .update(tickets)
    .set({ escalatedAt: now, escalationReason: reason, updatedAt: now })
    .where(withOrgFilter(organizationId, tickets, eq(tickets.id, id)))
    .returning({ id: tickets.id });

  if (updated.length === 0) {
    return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
  }
  return NextResponse.json({ status: "escalated", reason });
}
