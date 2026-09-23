import { SearchProvider } from "./types";
import { TavilySearchOptions, TavilySearchProvider } from "./tavily";

export * from "./types";
export * from "./tavily";

/**
 * Returns a TavilySearchProvider. There is no stand-in: a search nobody could
 * run must never come back as a search that found something.
 */
export function getSearchProvider(options: TavilySearchOptions = {}): SearchProvider {
  const apiKey =
    options.apiKey !== undefined
      ? options.apiKey
      : process.env.TAVILY_API_KEY || process.env.tavily || process.env.NEXT_PUBLIC_TAVILY_API_KEY;
  return new TavilySearchProvider(apiKey ? { ...options, apiKey } : options);
}
