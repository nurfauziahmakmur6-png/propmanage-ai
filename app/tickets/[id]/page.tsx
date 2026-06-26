import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { tickets, ticketMessages, agentRuns, properties, units, tenants, users } from "@/db/schema";
import { withOrgFilter } from "@/lib/withOrg";
import { eq, desc, asc } from "drizzle-orm";
import { TriagePanel, type Citation } from "./triage-panel";

const DEMO_ORG_ID = process.env.DEMO_ORG_ID ?? "";

export const dynamic = "force-dynamic";

const STATUS_COLORS: Record<string, string> = {
  open: "bg-green-100 text-green-800",
  in_progress: "bg-blue-100 text-blue-800",
  waiting: "bg-yellow-100 text-yellow-800",
  closed: "bg-gray-100 text-gray-600",
};

const PRIORITY_BADGE: Record<string, string> = {
  low: "bg-gray-100 text-gray-600",
  normal: "bg-gray-100 text-gray-700",
  high: "bg-orange-100 text-orange-700",
  urgent: "bg-red-100 text-red-700",
};

const AUTHOR_LABEL: Record<string, string> = {
  staff: "Staff",
  tenant: "Tenant",
  agent: "AI Agent",
};

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function TicketDetailPage({ params }: PageProps) {
  const { id } = await params;

  // Fetch ticket — org-scoped so a wrong ID for a different org returns 404
  const [ticket] = await db
    .select({
      id: tickets.id,
      title: tickets.title,
      status: tickets.status,
      priority: tickets.priority,
      category: tickets.category,
      source: tickets.source,
      escalatedAt: tickets.escalatedAt,
      escalationReason: tickets.escalationReason,
      createdAt: tickets.createdAt,
      updatedAt: tickets.updatedAt,
      propertyName: properties.name,
      unitNumber: units.unitNumber,
      tenantName: tenants.name,
      tenantEmail: tenants.email,
      assigneeName: users.name,
    })
    .from(tickets)
    .leftJoin(properties, eq(tickets.propertyId, properties.id))
    .leftJoin(units, eq(tickets.unitId, units.id))
    .leftJoin(tenants, eq(tickets.tenantId, tenants.id))
    .leftJoin(users, eq(tickets.assignedTo, users.id))
    .where(withOrgFilter(DEMO_ORG_ID, tickets, eq(tickets.id, id)))
    .limit(1);

  if (!ticket) notFound();

  // Fetch messages — explicitly org-scoped even though ticket_id already identifies it,
  // so the org predicate is always present per the withOrg contract.
  const allMessages = await db
    .select({
      id: ticketMessages.id,
      body: ticketMessages.body,
      authorRole: ticketMessages.authorRole,
      status: ticketMessages.status,
      citations: ticketMessages.citations,
      createdAt: ticketMessages.createdAt,
      authorName: users.name,
    })
    .from(ticketMessages)
    .leftJoin(users, eq(ticketMessages.authorId, users.id))
    .where(withOrgFilter(DEMO_ORG_ID, ticketMessages, eq(ticketMessages.ticketId, id)))
    .orderBy(asc(ticketMessages.createdAt));

  // The AI draft is shown in the triage panel, not the message thread.
  const draftRow = allMessages.find((m) => m.authorRole === "agent" && m.status === "draft");
  const messages = allMessages.filter((m) => m.id !== draftRow?.id);

  // Latest triage run for the agent-trace display.
  const [latestRun] = await db
    .select({
      status: agentRuns.status,
      toolCalls: agentRuns.toolCalls,
      tokensUsed: agentRuns.tokensUsed,
      latencyMs: agentRuns.latencyMs,
      createdAt: agentRuns.createdAt,
    })
    .from(agentRuns)
    .where(withOrgFilter(DEMO_ORG_ID, agentRuns, eq(agentRuns.ticketId, id)))
    .orderBy(desc(agentRuns.createdAt))
    .limit(1);

  const draft = draftRow
    ? {
        id: draftRow.id,
        body: draftRow.body,
        citations: (draftRow.citations as Citation[]) ?? [],
        createdAt: draftRow.createdAt,
      }
    : null;

  const escalation = ticket.escalatedAt
    ? { reason: ticket.escalationReason, at: ticket.escalatedAt }
    : null;

  const agentRun = latestRun
    ? {
        status: latestRun.status,
        toolsCalled: Array.isArray(latestRun.toolCalls)
          ? (latestRun.toolCalls as Array<{ name?: string }>).map((c) => c.name ?? "?")
          : [],
        tokensUsed: latestRun.tokensUsed,
        latencyMs: latestRun.latencyMs,
        createdAt: latestRun.createdAt,
      }
    : null;

  return (
    <div>
      <div className="mb-6">
        <Link href="/tickets" className="text-sm text-blue-600 hover:underline">
          ← Back to tickets
        </Link>
      </div>

      {/* Ticket header */}
      <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
        <div className="flex items-start justify-between gap-4">
          <h1 className="text-xl font-bold text-gray-900">{ticket.title}</h1>
          <div className="flex items-center gap-2 shrink-0">
            <span
              className={`text-xs px-2 py-0.5 rounded-full font-medium ${PRIORITY_BADGE[ticket.priority] ?? "bg-gray-100 text-gray-700"}`}
            >
              {ticket.priority}
            </span>
            <span
              className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[ticket.status] ?? "bg-gray-100 text-gray-600"}`}
            >
              {ticket.status.replace("_", " ")}
            </span>
          </div>
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
          {ticket.propertyName && (
            <>
              <dt className="text-gray-500">Property</dt>
              <dd className="text-gray-900">
                {ticket.propertyName}
                {ticket.unitNumber ? ` · Unit ${ticket.unitNumber}` : ""}
              </dd>
            </>
          )}
          {ticket.tenantName && (
            <>
              <dt className="text-gray-500">Tenant</dt>
              <dd className="text-gray-900">
                {ticket.tenantName}
                {ticket.tenantEmail ? ` (${ticket.tenantEmail})` : ""}
              </dd>
            </>
          )}
          {ticket.assigneeName && (
            <>
              <dt className="text-gray-500">Assigned to</dt>
              <dd className="text-gray-900">{ticket.assigneeName}</dd>
            </>
          )}
          {ticket.category && (
            <>
              <dt className="text-gray-500">Category</dt>
              <dd className="text-gray-900">{ticket.category}</dd>
            </>
          )}
          <dt className="text-gray-500">Source</dt>
          <dd className="text-gray-900">{ticket.source}</dd>
          <dt className="text-gray-500">Created</dt>
          <dd className="text-gray-900">
            {new Date(ticket.createdAt).toLocaleString("en-US", {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </dd>
        </dl>
      </div>

      {/* AI triage: draft reply, escalation, agent-run trace, and approve controls */}
      {(draft || escalation || agentRun) && (
        <TriagePanel
          ticketId={ticket.id}
          draft={draft}
          escalation={escalation}
          agentRun={agentRun}
        />
      )}

      {/* Message thread */}
      <h2 className="text-base font-semibold text-gray-800 mb-3">
        Messages ({messages.length})
      </h2>

      {messages.length === 0 ? (
        <p className="text-gray-500 text-sm">No messages yet.</p>
      ) : (
        <div className="space-y-4">
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`rounded-lg p-4 ${
                msg.authorRole === "agent"
                  ? "bg-purple-50 border border-purple-100"
                  : msg.authorRole === "tenant"
                    ? "bg-blue-50 border border-blue-100"
                    : "bg-white border border-gray-200"
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-gray-800">
                  {msg.authorName ?? AUTHOR_LABEL[msg.authorRole] ?? msg.authorRole}
                  <span className="ml-2 text-xs font-normal text-gray-400">
                    {AUTHOR_LABEL[msg.authorRole] ?? msg.authorRole}
                  </span>
                </span>
                <span className="text-xs text-gray-400">
                  {new Date(msg.createdAt).toLocaleString("en-US", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </span>
              </div>
              <p className="text-sm text-gray-700 whitespace-pre-wrap">{msg.body}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
