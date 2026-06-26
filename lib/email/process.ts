import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { inboundEmails, tickets, ticketMessages, tenants, units } from "../../db/schema";
import type { TriageJobData } from "../queue/queues";

export interface EmailPayload {
  messageId: string;
  from: string;
  subject?: string | null;
  body?: string | null;
  to?: string | null;
}

export interface InboundResult {
  inboundEmailId: string;
  duplicate: boolean;
}

/**
 * Persists an inbound email, deduped on (organization_id, message_id). A re-delivered
 * message returns duplicate=true and inserts nothing, so the provider retrying its webhook
 * never creates a second pipeline.
 */
export async function persistInboundEmail(
  organizationId: string,
  payload: EmailPayload
): Promise<InboundResult> {
  const inserted = await db
    .insert(inboundEmails)
    .values({
      organizationId,
      messageId: payload.messageId,
      fromAddr: payload.from,
      subject: payload.subject ?? null,
      body: payload.body ?? null,
      status: "received",
    })
    .onConflictDoNothing({ target: [inboundEmails.organizationId, inboundEmails.messageId] })
    .returning({ id: inboundEmails.id });

  if (inserted.length > 0) return { inboundEmailId: inserted[0].id, duplicate: false };

  const [existing] = await db
    .select({ id: inboundEmails.id })
    .from(inboundEmails)
    .where(
      and(
        eq(inboundEmails.organizationId, organizationId),
        eq(inboundEmails.messageId, payload.messageId)
      )
    );
  return { inboundEmailId: existing.id, duplicate: true };
}

export interface ProcessEmailDeps {
  enqueueTriage: (data: TriageJobData) => Promise<unknown>;
}

export interface ProcessEmailResult {
  status: "created" | "already-processed";
  ticketId: string;
  triggeringMessageId?: string;
}

function deriveTitle(payload: { subject?: string | null; body?: string | null }): string {
  const subject = payload.subject?.trim();
  if (subject) return subject.slice(0, 120);
  const body = payload.body?.trim();
  if (body) return body.split("\n")[0].slice(0, 120);
  return "Email enquiry";
}

/**
 * Turns a received inbound email into a ticket (source=email) plus the tenant's message,
 * then enqueues triage. Idempotent: once the inbound row has a ticket_id, re-running is a
 * no-op, so at-least-once redelivery yields exactly one ticket.
 */
export async function processInboundEmail(
  organizationId: string,
  inboundEmailId: string,
  deps: ProcessEmailDeps
): Promise<ProcessEmailResult> {
  const [email] = await db
    .select()
    .from(inboundEmails)
    .where(
      and(
        eq(inboundEmails.organizationId, organizationId),
        eq(inboundEmails.id, inboundEmailId)
      )
    );
  if (!email) throw new Error(`inbound email ${inboundEmailId} not found`);
  if (email.ticketId) {
    return { status: "already-processed", ticketId: email.ticketId };
  }

  // Match the sender to a tenant, and through them a unit and property.
  const [tenant] = await db
    .select({ id: tenants.id, unitId: tenants.unitId })
    .from(tenants)
    .where(and(eq(tenants.organizationId, organizationId), eq(tenants.email, email.fromAddr)));

  let tenantId: string | null = null;
  let unitId: string | null = null;
  let propertyId: string | null = null;
  if (tenant) {
    tenantId = tenant.id;
    unitId = tenant.unitId;
    const [unit] = await db
      .select({ propertyId: units.propertyId })
      .from(units)
      .where(and(eq(units.organizationId, organizationId), eq(units.id, tenant.unitId)));
    propertyId = unit?.propertyId ?? null;
  }

  const [ticket] = await db
    .insert(tickets)
    .values({
      organizationId,
      source: "email",
      title: deriveTitle(email),
      status: "open",
      priority: "normal",
      tenantId,
      unitId,
      propertyId,
    })
    .returning({ id: tickets.id });

  const [message] = await db
    .insert(ticketMessages)
    .values({
      ticketId: ticket.id,
      organizationId,
      authorRole: "tenant",
      status: "sent",
      body: email.body ?? "(no content)",
    })
    .returning({ id: ticketMessages.id });

  await db
    .update(inboundEmails)
    .set({ status: "processed", ticketId: ticket.id })
    .where(
      and(
        eq(inboundEmails.organizationId, organizationId),
        eq(inboundEmails.id, inboundEmailId)
      )
    );

  await deps.enqueueTriage({
    organizationId,
    ticketId: ticket.id,
    triggeringMessageId: message.id,
  });

  return { status: "created", ticketId: ticket.id, triggeringMessageId: message.id };
}
