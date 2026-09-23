import { LLMProvider } from "./types";
import { OpenAILLMProvider, OpenAILLMOptions } from "./openai";
import { AnthropicLLMProvider, AnthropicLLMOptions } from "./anthropic";

export * from "./types";
export * from "./openai";
export * from "./anthropic";

export type LLMOptions = (OpenAILLMOptions | AnthropicLLMOptions) & {
  provider?: "openai" | "anthropic" | "mock";
};

/**
 * Returns an Anthropic or OpenAI LLMProvider based on available environment variables or options.
 * Prioritizes Anthropic if ANTHROPIC_API_KEY or CLAUDE_API_KEY is present,
 * or OpenAI if OPENAI_API_KEY is present,
 * Without a credential it reports that, rather than answering with a stand-in.
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

  // Check Anthropic Claude environment variables
  const anthropicKey =
    process.env.ANTHROPIC_API_KEY ||
    process.env.CLAUDE_API_KEY ||
    process.env.anthropic ||
    "";
  if (anthropicKey.trim().length > 0) {
    return new AnthropicLLMProvider({ apiKey: anthropicKey, ...options });
  }

  // Check OpenAI environment variables
  const openAiKey = process.env.OPENAI_API_KEY || process.env.openai || "";
  if (openAiKey.trim().length > 0) {
    return new OpenAILLMProvider({ apiKey: openAiKey, ...options });
  }

  throw new Error(
    "文章の生成に使う提供元が設定されていません（ANTHROPIC_API_KEY または OPENAI_API_KEY）。"
  );
}
