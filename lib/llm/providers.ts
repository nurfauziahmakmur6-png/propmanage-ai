import type { LLMProvider, LLMCompleteOptions, LLMCompletion } from "./types";

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
}
