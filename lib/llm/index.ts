import type { LLMProvider } from "./types";
import { GroqProvider, OpenAIProvider, AnthropicProvider } from "./providers";

export type { LLMProvider, LLMCompletion, LLMCompleteOptions } from "./types";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

// Default is Groq (free tier); swappable to OpenAI/Anthropic via LLM_PROVIDER. All return
// the same LLMProvider interface so call sites and tests never depend on the vendor.
export function getLLMProvider(): LLMProvider {
  const choice = process.env.LLM_PROVIDER ?? "groq";
  switch (choice) {
    case "groq":
      return new GroqProvider(requireEnv("GROQ_API_KEY"), process.env.GROQ_MODEL);
    case "openai":
      return new OpenAIProvider(requireEnv("OPENAI_API_KEY"), process.env.OPENAI_MODEL);
    case "anthropic":
      return new AnthropicProvider(requireEnv("ANTHROPIC_API_KEY"), process.env.ANTHROPIC_MODEL);
    default:
      throw new Error(`Unknown LLM_PROVIDER: ${choice}`);
  }
}
