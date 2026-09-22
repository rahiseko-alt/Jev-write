import { SearchProvider } from "./types";
import { TavilySearchOptions, TavilySearchProvider } from "./tavily";
import { MockSearchProvider } from "./mock";

export * from "./types";
export * from "./tavily";
export * from "./mock";

/**
 * Returns a TavilySearchProvider if TAVILY_API_KEY is available,
 * otherwise returns a MockSearchProvider for offline development and testing.
 */
export function getSearchProvider(options: TavilySearchOptions = {}): SearchProvider {
  const apiKey = options.apiKey !== undefined ? options.apiKey : (process.env.TAVILY_API_KEY || process.env.tavily);
  if (apiKey && apiKey.trim().length > 0) {
    return new TavilySearchProvider({ ...options, apiKey });
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Tavily API key is required in production. Set TAVILY_API_KEY or tavily.');
  }
  return new MockSearchProvider();
}
