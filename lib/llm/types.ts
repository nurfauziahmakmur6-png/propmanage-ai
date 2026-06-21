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

export interface LLMProvider {
  readonly id: string;
  complete(opts: LLMCompleteOptions): Promise<LLMCompletion>;
}
