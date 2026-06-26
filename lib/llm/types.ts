export interface LLMCompletion {
  text: string;
  model: string;
  usage?: { promptTokens?: number; completionTokens?: number };
}

export interface LLMCompleteOptions {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
}

export interface LLMToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema for the tool arguments
}

export interface LLMToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type LLMMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: LLMToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface LLMChatOptions {
  messages: LLMMessage[];
  tools?: LLMToolSpec[];
  toolChoice?: "auto" | "required" | "none";
  temperature?: number;
  maxTokens?: number;
}

export interface LLMChatResult {
  text: string | null;
  toolCalls: LLMToolCall[];
  finishReason: string;
  usage?: { promptTokens?: number; completionTokens?: number };
}

export interface LLMProvider {
  readonly id: string;
  complete(opts: LLMCompleteOptions): Promise<LLMCompletion>;
  chat(opts: LLMChatOptions): Promise<LLMChatResult>;
}
