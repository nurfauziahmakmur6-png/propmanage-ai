import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { tickets, ticketMessages, properties, units, tenants, agentRuns } from "../../db/schema";
import type { LLMProvider, LLMMessage } from "../llm";
import type { EmbeddingProvider } from "../embeddings";
import type { Reranker } from "../reranking";
import {
  AGENT_TOOLS,
  createToolExecutor,
  type AgentToolContext,
} from "./tools";

const MAX_STEPS = 6;

export interface TriageContext {
  organizationId: string;
  ticketId: string;
  triggeringMessageId: string;
}

export interface TriageDeps {
  llm: LLMProvider;
  embeddingProvider: EmbeddingProvider;
  reranker: Reranker;
}

export type TriageStatus = "succeeded" | "escalated" | "failed";

export interface TriageResult {
  status: TriageStatus;
  drafted: boolean;
  escalated: boolean;
  toolsCalled: string[];
  tokensUsed: number;
  latencyMs: number;
}

function systemPrompt(): string {
  return [
    "You are the triage assistant for a property-management company.",
    "For each ticket: (1) optionally call search_knowledge_base to find relevant policy from the company's documents;",
    "(2) call classify_ticket with a concise lowercase category and a priority;",
    "(3) then EITHER call draft_reply with a helpful, document-grounded reply for routine low-risk questions,",
    "OR call escalate_to_human for anything sensitive — money, rent, payments, deposits, contracts, leases, legal or eviction matters — or anything you are unsure about.",
    "You only ever DRAFT a reply; a human approves sending. Never promise actions involving money, contracts, or legal notices — escalate those.",
    "Keep drafts concise and professional, and cite the document sources you used.",
  ].join(" ");
}

interface TicketContext {
  title: string;
  category: string | null;
  priority: string;
  propertyId: string | null;
  propertyName: string | null;
  unitNumber: string | null;
  tenantName: string | null;
  triggerText: string;
}

async function loadTicketContext(ctx: TriageContext): Promise<TicketContext> {
  const [t] = await db
    .select({
      title: tickets.title,
      category: tickets.category,
      priority: tickets.priority,
      propertyId: tickets.propertyId,
      propertyName: properties.name,
      unitNumber: units.unitNumber,
      tenantName: tenants.name,
    })
    .from(tickets)
    .leftJoin(properties, eq(tickets.propertyId, properties.id))
    .leftJoin(units, eq(tickets.unitId, units.id))
    .leftJoin(tenants, eq(tickets.tenantId, tenants.id))
    .where(and(eq(tickets.organizationId, ctx.organizationId), eq(tickets.id, ctx.ticketId)));
  if (!t) throw new Error(`ticket ${ctx.ticketId} not found`);

  const [msg] = await db
    .select({ body: ticketMessages.body })
    .from(ticketMessages)
    .where(
      and(
        eq(ticketMessages.organizationId, ctx.organizationId),
        eq(ticketMessages.id, ctx.triggeringMessageId)
      )
    );

  return { ...t, triggerText: msg?.body ?? "" };
}

function userPrompt(tc: TicketContext): string {
  return [
    `Ticket: "${tc.title}"`,
    `Property: ${tc.propertyName ?? "unknown"} | Unit: ${tc.unitNumber ?? "-"} | Tenant: ${tc.tenantName ?? "unknown"}`,
    `Current category: ${tc.category ?? "unset"} | priority: ${tc.priority}`,
    "",
    "The tenant wrote:",
    '"""',
    tc.triggerText,
    '"""',
    "",
    "Decide how to handle this ticket using the tools.",
  ].join("\n");
}

/**
 * Runs the triage agent: a bounded tool-calling loop over the constrained tool set, then
 * upserts an agent_runs record (tool calls, tokens, latency, status) keyed on
 * (ticket, triggering message) so a retried job updates one row rather than duplicating.
 */
export async function runTriage(ctx: TriageContext, deps: TriageDeps): Promise<TriageResult> {
  const start = Date.now();
  const tc = await loadTicketContext(ctx);

  const toolCtx: AgentToolContext = {
    organizationId: ctx.organizationId,
    ticketId: ctx.ticketId,
    triggeringMessageId: ctx.triggeringMessageId,
    propertyId: tc.propertyId,
  };
  const execute = createToolExecutor(toolCtx, deps, {
    category: tc.category,
    triggerText: tc.triggerText,
  });

  const messages: LLMMessage[] = [
    { role: "system", content: systemPrompt() },
    { role: "user", content: userPrompt(tc) },
  ];

  const callLog: Array<Record<string, unknown>> = [];
  const toolsCalled: string[] = [];
  let tokensUsed = 0;
  let drafted = false;
  let escalated = false;
  let output: string | null = null;
  let status: TriageStatus = "succeeded";

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const res = await deps.llm.chat({
        messages,
        tools: AGENT_TOOLS,
        toolChoice: "auto",
        temperature: 0.1,
      });
      tokensUsed += (res.usage?.promptTokens ?? 0) + (res.usage?.completionTokens ?? 0);

      if (res.toolCalls.length === 0) {
        if (res.text) output = output ?? res.text;
        break;
      }

      messages.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls });
      for (const call of res.toolCalls) {
        const outcome = await execute(call.name, call.arguments);
        toolsCalled.push(call.name);
        callLog.push({ step, name: call.name, arguments: call.arguments, result: outcome.content });
        if (outcome.drafted) drafted = true;
        if (outcome.escalated) escalated = true;
        if (outcome.output) output = outcome.output;
        messages.push({ role: "tool", toolCallId: call.id, content: outcome.content });
      }

      if (drafted || escalated) break; // terminal outcome reached
    }
  } catch (err) {
    status = "failed";
    output = err instanceof Error ? err.message : "agent error";
  }

  if (status !== "failed") status = escalated ? "escalated" : "succeeded";
  const latencyMs = Date.now() - start;

  await db
    .insert(agentRuns)
    .values({
      organizationId: ctx.organizationId,
      ticketId: ctx.ticketId,
      triggeringMessageId: ctx.triggeringMessageId,
      status,
      toolCalls: callLog,
      output,
      tokensUsed,
      latencyMs,
    })
    .onConflictDoUpdate({
      target: [agentRuns.ticketId, agentRuns.triggeringMessageId],
      set: {
        status,
        toolCalls: callLog,
        output,
        tokensUsed,
        latencyMs,
        createdAt: sql`now()`,
      },
    });

  if (status === "failed") {
    throw new Error(output ?? "triage failed");
  }

  return { status, drafted, escalated, toolsCalled, tokensUsed, latencyMs };
}
