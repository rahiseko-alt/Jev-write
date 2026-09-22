import { LLMProvider } from "./types";
import { OpenAILLMProvider, OpenAILLMOptions } from "./openai";
import { MockLLMProvider } from "./mock";

export * from "./types";
export * from "./openai";
export * from "./mock";

/**
 * Returns an OpenAILLMProvider if an API key is available in options or environment,
 * otherwise falls back gracefully to MockLLMProvider for offline testing and development.
 */
export function getLLMProvider(options: OpenAILLMOptions = {}): LLMProvider {
  if (options.apiKey !== undefined) {
    if (options.apiKey && options.apiKey.trim().length > 0) {
      return new OpenAILLMProvider(options);
    }
    return new MockLLMProvider();
  }

  if (process.env.NODE_ENV === "test" || process.env.USE_MOCK_LLM === "true") {
    return new MockLLMProvider();
  }

  const apiKey = process.env.OPENAI_API_KEY || "";
  if (apiKey.trim().length > 0) {
    return new OpenAILLMProvider(options);
  }
  return new MockLLMProvider();
}
