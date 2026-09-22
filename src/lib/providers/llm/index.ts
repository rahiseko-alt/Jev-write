import { LLMProvider } from "./types";
import { OpenAILLMProvider, OpenAILLMOptions } from "./openai";
import { AnthropicLLMProvider, AnthropicLLMOptions } from "./anthropic";
import { MockLLMProvider } from "./mock";

export * from "./types";
export * from "./openai";
export * from "./anthropic";
export * from "./mock";

export type LLMOptions = (OpenAILLMOptions | AnthropicLLMOptions) & {
  provider?: "openai" | "anthropic" | "mock";
};

/**
 * Returns an Anthropic or OpenAI LLMProvider based on available environment variables or options.
 * Prioritizes Anthropic if ANTHROPIC_API_KEY or CLAUDE_API_KEY is present,
 * or OpenAI if OPENAI_API_KEY is present,
 * otherwise falls back gracefully to MockLLMProvider for offline testing and development.
 */
export function getLLMProvider(options: LLMOptions = {}): LLMProvider {
  // Explicit option
  if (options.apiKey) {
    if (
      options.provider === "anthropic" ||
      options.apiKey.startsWith("sk-ant-")
    ) {
      return new AnthropicLLMProvider(options);
    }
    return new OpenAILLMProvider(options);
  }

  if (process.env.NODE_ENV === "test" || process.env.USE_MOCK_LLM === "true") {
    return new MockLLMProvider();
  }

  // Check Anthropic Claude environment variables
  const anthropicKey =
    process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || "";
  if (anthropicKey.trim().length > 0) {
    return new AnthropicLLMProvider({ apiKey: anthropicKey, ...options });
  }

  // Check OpenAI environment variables
  const openAiKey = process.env.OPENAI_API_KEY || "";
  if (openAiKey.trim().length > 0) {
    return new OpenAILLMProvider({ apiKey: openAiKey, ...options });
  }

  return new MockLLMProvider();
}
