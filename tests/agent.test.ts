import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { organizations, tickets, ticketMessages, agentRuns } from "../db/schema";
import { persistInboundEmail, processInboundEmail } from "../lib/email/process";
import { runTriage } from "../lib/agent/agent";
import type { EmbeddingProvider } from "../lib/embeddings";
import type { Reranker } from "../lib/reranking";
import type { LLMProvider, LLMChatResult, LLMCompletion } from "../lib/llm";

interface ScriptStep {
  text?: string | null;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
}

// A scripted LLM: each chat() call returns the next step's tool calls, then stops.
function mockLLM(script: ScriptStep[]): LLMProvider {
  let i = 0;
  return {
    id: "mock",
    async complete(): Promise<LLMCompletion> {
      return { text: "", model: "mock" };
    },
    async chat(): Promise<LLMChatResult> {
      const step = script[i++] ?? {};
      const toolCalls = (step.toolCalls ?? []).map((tc, idx) => ({
        id: `call_${i}_${idx}`,
        name: tc.name,
        arguments: tc.arguments,
      }));
      return {
        text: step.text ?? null,
        toolCalls,
        finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
        usage: { promptTokens: 10, completionTokens: 5 },
      };
    },
  };
}

const stubEmbedder: EmbeddingProvider = {
  id: "stub",
  dimensions: 384,
  embedPassages: async () => [],
  embedQuery: async () => [],
};
const stubReranker: Reranker = { id: "stub", rerank: async () => [] };

async function freshOrg(name: string): Promise<string> {
  const [org] = await db.insert(organizations).values({ name }).returning({ id: organizations.id });
  return org.id;
}
async function dropOrg(id: string): Promise<void> {
  await db.delete(organizations).where(eq(organizations.id, id));
}

describe("inbound email", () => {
  it("dedupes the same messageId to a single ticket", async () => {
    const org = await freshOrg(`test-dedupe-${Date.now()}`);
    try {
      const payload = {
        messageId: "msg-DUP-001",
        from: "unmatched@example.com",
        subject: "Leaky kitchen tap",
        body: "The kitchen tap has been dripping for two days.",
      };
      const noopEnqueue = async () => undefined;

      const first = await persistInboundEmail(org, payload);
      expect(first.duplicate).toBe(false);
      await processInboundEmail(org, first.inboundEmailId, { enqueueTriage: noopEnqueue });

      // Re-deliver the same message.
      const second = await persistInboundEmail(org, payload);
      expect(second.duplicate).toBe(true);
      if (!second.duplicate) {
        await processInboundEmail(org, second.inboundEmailId, { enqueueTriage: noopEnqueue });
      }

      const ticketRows = await db.select().from(tickets).where(eq(tickets.organizationId, org));
      expect(ticketRows.length).toBe(1);
      expect(ticketRows[0].source).toBe("email");
    } finally {
      await dropOrg(org);
    }
  });
});

describe("triage agent guardrails", () => {
  it("escalates a sensitive ticket instead of drafting, even if the model tries to draft", async () => {
    const org = await freshOrg(`test-sensitive-${Date.now()}`);
    try {
      const [ticket] = await db
        .insert(tickets)
        .values({ organizationId: org, source: "email", title: "Rent and deposit dispute" })
        .returning({ id: tickets.id });
      const [msg] = await db
        .insert(ticketMessages)
        .values({
          ticketId: ticket.id,
          organizationId: org,
          authorRole: "tenant",
          body: "I am withholding rent and considering legal action over my deposit.",
        })
        .returning({ id: ticketMessages.id });

      // The model (wrongly) tries to draft a reply; the code guardrail must override it.
      const llm = mockLLM([
        { toolCalls: [{ name: "draft_reply", arguments: { body: "Here is some advice..." } }] },
      ]);

      const result = await runTriage(
        { organizationId: org, ticketId: ticket.id, triggeringMessageId: msg.id },
        { llm, embeddingProvider: stubEmbedder, reranker: stubReranker }
      );

      expect(result.escalated).toBe(true);
      expect(result.drafted).toBe(false);

      const drafts = await db
        .select()
        .from(ticketMessages)
        .where(and(eq(ticketMessages.ticketId, ticket.id), eq(ticketMessages.status, "draft")));
      expect(drafts.length).toBe(0);

      const [t] = await db.select().from(tickets).where(eq(tickets.id, ticket.id));
      expect(t.escalatedAt).not.toBeNull();

      const runs = await db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.ticketId, ticket.id));
      expect(runs.length).toBe(1);
      expect(runs[0].status).toBe("escalated");
    } finally {
      await dropOrg(org);
    }
  });

  it("drafts a reply for a routine ticket and logs the run", async () => {
    const org = await freshOrg(`test-draft-${Date.now()}`);
    try {
      const [ticket] = await db
        .insert(tickets)
        .values({ organizationId: org, source: "email", title: "Bin collection day" })
        .returning({ id: tickets.id });
      const [msg] = await db
        .insert(ticketMessages)
        .values({
          ticketId: ticket.id,
          organizationId: org,
          authorRole: "tenant",
          body: "Which day are the rubbish bins collected?",
        })
        .returning({ id: ticketMessages.id });

      const llm = mockLLM([
        { toolCalls: [{ name: "classify_ticket", arguments: { category: "rubbish", priority: "low" } }] },
        { toolCalls: [{ name: "draft_reply", arguments: { body: "Bins are collected on Tuesday and Friday [1]." } }] },
      ]);

      const result = await runTriage(
        { organizationId: org, ticketId: ticket.id, triggeringMessageId: msg.id },
        { llm, embeddingProvider: stubEmbedder, reranker: stubReranker }
      );

      expect(result.drafted).toBe(true);
      expect(result.escalated).toBe(false);

      const drafts = await db
        .select()
        .from(ticketMessages)
        .where(and(eq(ticketMessages.ticketId, ticket.id), eq(ticketMessages.status, "draft")));
      expect(drafts.length).toBe(1);
      expect(drafts[0].authorRole).toBe("agent");

      const runs = await db.select().from(agentRuns).where(eq(agentRuns.ticketId, ticket.id));
      expect(runs.length).toBe(1);
      expect(runs[0].status).toBe("succeeded");
    } finally {
      await dropOrg(org);
    }
  });
});
