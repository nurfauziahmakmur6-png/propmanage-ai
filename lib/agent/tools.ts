import { and, asc, eq } from "drizzle-orm";
import { db } from "../../db";
import { tickets, ticketMessages } from "../../db/schema";
import { retrieve } from "../retrieval";
import { getDocumentTitles } from "../retrieval/search";
import type { EmbeddingProvider } from "../embeddings";
import type { Reranker } from "../reranking";
import type { LLMToolSpec } from "../llm";
import { isSensitive } from "./sensitive";

export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;

export const AGENT_TOOLS: LLMToolSpec[] = [
  {
    name: "search_knowledge_base",
    description:
      "Search the company's property documents for relevant policy or facts. Returns ranked snippets with source titles you can cite.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look up" },
        scope: {
          type: "string",
          enum: ["property", "all"],
          description: "Limit to this ticket's property, or search all documents",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_ticket_history",
    description: "Get the prior messages on this ticket for context.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "classify_ticket",
    description: "Set the ticket's category and priority.",
    parameters: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description: "Single lowercase word, e.g. plumbing, hvac, noise, rubbish, parking, rent, lease",
        },
        priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
      },
      required: ["category", "priority"],
    },
  },
  {
    name: "draft_reply",
    description:
      "Draft a reply to the tenant for human approval. Only for routine, low-risk questions. Never for money, rent, deposits, contracts, or legal matters.",
    parameters: {
      type: "object",
      properties: {
        body: { type: "string", description: "The reply text, citing sources inline like [1]" },
        citations: {
          type: "array",
          items: {
            type: "object",
            properties: { title: { type: "string" }, page: { type: "number" } },
          },
        },
      },
      required: ["body"],
    },
  },
  {
    name: "escalate_to_human",
    description:
      "Flag this ticket for a human. Use for anything sensitive (money, rent, deposits, contracts, legal, eviction) or anything you are unsure about.",
    parameters: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
    },
  },
];

export interface AgentToolContext {
  organizationId: string;
  ticketId: string;
  triggeringMessageId: string;
  propertyId: string | null;
}

export interface AgentToolDeps {
  embeddingProvider: EmbeddingProvider;
  reranker: Reranker;
}

export interface ToolOutcome {
  content: string; // returned to the LLM as the tool result
  drafted?: boolean;
  escalated?: boolean;
  output?: string; // human-facing summary (draft body or escalation reason)
}

interface MutableTicketState {
  category: string | null;
  triggerText: string;
}

interface SearchState {
  lastSources: Array<{ title: string; page?: number }>;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function escalateTicket(ctx: AgentToolContext, reason: string): Promise<void> {
  await db
    .update(tickets)
    .set({ escalatedAt: nowIso(), escalationReason: reason, updatedAt: nowIso() })
    .where(and(eq(tickets.organizationId, ctx.organizationId), eq(tickets.id, ctx.ticketId)));
}

async function clearDrafts(ctx: AgentToolContext): Promise<void> {
  await db
    .delete(ticketMessages)
    .where(
      and(
        eq(ticketMessages.organizationId, ctx.organizationId),
        eq(ticketMessages.ticketId, ctx.ticketId),
        eq(ticketMessages.status, "draft")
      )
    );
}

/**
 * Builds the tool dispatcher for one triage run. Closures hold the run's context, the
 * mutable ticket state (category can change mid-run via classify_ticket), and the last
 * search results so draft_reply can default its citations.
 */
export function createToolExecutor(
  ctx: AgentToolContext,
  deps: AgentToolDeps,
  ticket: MutableTicketState
) {
  const search: SearchState = { lastSources: [] };

  return async function execute(
    name: string,
    args: Record<string, unknown>
  ): Promise<ToolOutcome> {
    switch (name) {
      case "search_knowledge_base": {
        const query = String(args.query ?? "");
        const propertyId = args.scope === "property" ? ctx.propertyId : null;
        const chunks = await retrieve(
          query,
          { embeddingProvider: deps.embeddingProvider, reranker: deps.reranker },
          { organizationId: ctx.organizationId, propertyId, topN: 4 }
        );
        const titles = await getDocumentTitles(
          ctx.organizationId,
          [...new Set(chunks.map((c) => c.documentId))]
        );
        const results = chunks.map((c, i) => ({
          ref: i + 1,
          title: titles.get(c.documentId) ?? "Untitled document",
          page: c.metadata?.page ?? null,
          snippet: c.content.slice(0, 240),
          score: Number(c.rerankScore.toFixed(3)),
        }));
        search.lastSources = results.map((r) => ({
          title: r.title,
          page: r.page ?? undefined,
        }));
        return {
          content: results.length
            ? JSON.stringify(results)
            : "No relevant documents found.",
        };
      }

      case "get_ticket_history": {
        const rows = await db
          .select({ authorRole: ticketMessages.authorRole, body: ticketMessages.body })
          .from(ticketMessages)
          .where(
            and(
              eq(ticketMessages.organizationId, ctx.organizationId),
              eq(ticketMessages.ticketId, ctx.ticketId)
            )
          )
          .orderBy(asc(ticketMessages.createdAt));
        return { content: JSON.stringify(rows.map((r) => ({ from: r.authorRole, body: r.body }))) };
      }

      case "classify_ticket": {
        const category = String(args.category ?? "").trim().toLowerCase();
        const priorityArg = String(args.priority ?? "normal");
        const priority = (PRIORITIES as readonly string[]).includes(priorityArg)
          ? priorityArg
          : "normal";
        await db
          .update(tickets)
          .set({ category, priority, updatedAt: nowIso() })
          .where(and(eq(tickets.organizationId, ctx.organizationId), eq(tickets.id, ctx.ticketId)));
        ticket.category = category;
        return { content: `Classified as ${category} / ${priority}.` };
      }

      case "draft_reply": {
        const body = String(args.body ?? "").trim();
        // Code-enforced guardrail: sensitive tickets never get an auto-draft, regardless of
        // what the model decided. They escalate instead.
        if (isSensitive(ticket.category, ticket.triggerText)) {
          const reason =
            "Sensitive topic (money, contract, or legal) — routed to a human instead of an AI draft.";
          await escalateTicket(ctx, reason);
          return {
            content: `This ticket is sensitive and cannot be auto-drafted. Escalated to a human.`,
            escalated: true,
            output: reason,
          };
        }
        const citations =
          Array.isArray(args.citations) && args.citations.length > 0
            ? args.citations
            : search.lastSources;
        await clearDrafts(ctx);
        await db.insert(ticketMessages).values({
          ticketId: ctx.ticketId,
          organizationId: ctx.organizationId,
          authorRole: "agent",
          status: "draft",
          body,
          citations,
        });
        return { content: "Draft reply saved for human approval.", drafted: true, output: body };
      }

      case "escalate_to_human": {
        const reason = String(args.reason ?? "Escalated by the triage agent.");
        await escalateTicket(ctx, reason);
        return { content: `Escalated to a human: ${reason}`, escalated: true, output: reason };
      }

      default:
        return { content: `Unknown tool: ${name}` };
    }
  };
}
