import type {
  LLMProvider,
  LLMCompleteOptions,
  LLMCompletion,
  LLMChatOptions,
  LLMChatResult,
  LLMMessage,
  LLMToolCall,
} from "./types";

// Map our provider-neutral messages to the OpenAI chat-completions shape.
function toOpenAIMessages(messages: LLMMessage[]): unknown[] {
  return messages.map((m) => {
    switch (m.role) {
      case "assistant":
        return {
          role: "assistant",
          content: m.content,
          ...(m.toolCalls && m.toolCalls.length > 0
            ? {
                tool_calls: m.toolCalls.map((tc) => ({
                  id: tc.id,
                  type: "function",
                  function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
                })),
              }
            : {}),
        };
      case "tool":
        return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
      default:
        return { role: m.role, content: m.content };
    }
  });
}

async function openAICompatibleChat(
  baseUrl: string,
  apiKey: string,
  model: string,
  opts: LLMChatOptions
): Promise<LLMChatResult> {
  const tools = opts.tools?.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: opts.temperature ?? 0.1,
      max_tokens: opts.maxTokens ?? 1024,
      messages: toOpenAIMessages(opts.messages),
      ...(tools ? { tools, tool_choice: opts.toolChoice ?? "auto" } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`LLM chat failed (${res.status}): ${await res.text()}`);
  }
  interface RawToolCall {
    id: string;
    function?: { name?: string; arguments?: string };
  }
  const data = await res.json();
  const choice = data.choices?.[0];
  const rawToolCalls: RawToolCall[] = choice?.message?.tool_calls ?? [];
  const toolCalls: LLMToolCall[] = rawToolCalls.map((tc) => {
    let args: Record<string, unknown> = {};
    try {
      args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
    } catch {
      args = {};
    }
    return { id: tc.id, name: tc.function?.name ?? "", arguments: args };
  });
  return {
    text: choice?.message?.content ?? null,
    toolCalls,
    finishReason: choice?.finish_reason ?? "stop",
    usage: {
      promptTokens: data.usage?.prompt_tokens,
      completionTokens: data.usage?.completion_tokens,
    },
  };
}

// Groq and OpenAI share the OpenAI chat-completions shape, so one client covers both.
async function openAICompatibleComplete(
  baseUrl: string,
  apiKey: string,
  model: string,
  opts: LLMCompleteOptions
): Promise<LLMCompletion> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 1024,
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`LLM request failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  return {
    text: data.choices?.[0]?.message?.content ?? "",
    model,
    usage: {
      promptTokens: data.usage?.prompt_tokens,
      completionTokens: data.usage?.completion_tokens,
    },
  };
}

export class GroqProvider implements LLMProvider {
  readonly id: string;
  constructor(
    private readonly apiKey: string,
    private readonly model = "llama-3.3-70b-versatile",
    private readonly baseUrl = "https://api.groq.com/openai/v1"
  ) {
    this.id = `groq:${model}`;
  }
  complete(opts: LLMCompleteOptions): Promise<LLMCompletion> {
    return openAICompatibleComplete(this.baseUrl, this.apiKey, this.model, opts);
  }
  chat(opts: LLMChatOptions): Promise<LLMChatResult> {
    return openAICompatibleChat(this.baseUrl, this.apiKey, this.model, opts);
  }
}

export class OpenAIProvider implements LLMProvider {
  readonly id: string;
  constructor(
    private readonly apiKey: string,
    private readonly model = "gpt-4o-mini",
    private readonly baseUrl = "https://api.openai.com/v1"
  ) {
    this.id = `openai:${model}`;
  }
  complete(opts: LLMCompleteOptions): Promise<LLMCompletion> {
    return openAICompatibleComplete(this.baseUrl, this.apiKey, this.model, opts);
  }
  chat(opts: LLMChatOptions): Promise<LLMChatResult> {
    return openAICompatibleChat(this.baseUrl, this.apiKey, this.model, opts);
  }
}

export class AnthropicProvider implements LLMProvider {
  readonly id: string;
  constructor(
    private readonly apiKey: string,
    private readonly model = "claude-3-5-sonnet-latest"
  ) {
    this.id = `anthropic:${model}`;
  }
  async complete(opts: LLMCompleteOptions): Promise<LLMCompletion> {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: opts.maxTokens ?? 1024,
        temperature: opts.temperature ?? 0.2,
        system: opts.system,
        messages: [{ role: "user", content: opts.user }],
      }),
    });
    if (!res.ok) {
      throw new Error(`Anthropic request failed (${res.status}): ${await res.text()}`);
    }
    const data = await res.json();
    return {
      text: data.content?.[0]?.text ?? "",
      model: this.model,
      usage: {
        promptTokens: data.usage?.input_tokens,
        completionTokens: data.usage?.output_tokens,
      },
    };
  }
  // Anthropic's tool-use API differs from OpenAI's; wire it when swapping the agent to
  // Claude. The default agent provider is Groq, which is OpenAI-compatible.
  async chat(_opts: LLMChatOptions): Promise<LLMChatResult> {
    void _opts;
    throw new Error("Anthropic tool-calling chat is not implemented; use LLM_PROVIDER=groq");
  }
}
