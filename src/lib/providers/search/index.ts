import { SearchProvider } from "./types";
import { TavilySearchOptions, TavilySearchProvider } from "./tavily";
import { MockSearchProvider } from "./mock";

export * from "./types";
export * from "./tavily";
export * from "./mock";

/**
 * Returns a TavilySearchProvider. The stand-in is returned only where it was
 * asked for (USE_MOCK_SEARCH, or a test run): a search nobody could run must
 * not come back as a search that found something.
 */
export function getSearchProvider(options: TavilySearchOptions = {}): SearchProvider {
  const apiKey =
    options.apiKey !== undefined
      ? options.apiKey
      : process.env.TAVILY_API_KEY || process.env.tavily || process.env.NEXT_PUBLIC_TAVILY_API_KEY;
  // An explicitly supplied credential always means the real service.
  if (
    !options.apiKey &&
    (process.env.NODE_ENV === "test" || process.env.USE_MOCK_SEARCH === "true")
  ) {
    return new MockSearchProvider();
  }
  return new TavilySearchProvider(apiKey ? { ...options, apiKey } : options);
}
