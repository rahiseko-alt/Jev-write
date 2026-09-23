import { SearchOptions, SearchProvider, SearchResponse, SearchResultItem } from "./types";

export interface TavilySearchOptions {
  apiKey?: string;
  baseUrl?: string;
  defaultMaxResults?: number;
  timeoutMs?: number;
}

function createSearchResponse(query: string, results: SearchResultItem[]): SearchResponse {
  const response = Object.assign(
    {
      query,
      results,
      length: results.length,
      [Symbol.iterator]() {
        return results[Symbol.iterator]();
      },
    },
    results
  ) as SearchResponse;

  return response;
}

export class TavilySearchProvider implements SearchProvider {
  private apiKey: string;
  private baseUrl: string;
  private defaultMaxResults: number;
  private timeoutMs: number;

  constructor(options: TavilySearchOptions = {}) {
    this.apiKey =
      options.apiKey ||
      process.env.TAVILY_API_KEY ||
      process.env.tavily ||
      process.env.NEXT_PUBLIC_TAVILY_API_KEY ||
      "";
    this.baseUrl = (options.baseUrl || process.env.TAVILY_BASE_URL || "https://api.tavily.com").replace(/\/$/, "");
    this.defaultMaxResults = options.defaultMaxResults || 5;
    this.timeoutMs = options.timeoutMs || 10000;
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
    // A search nobody can run is a search that failed. ADR-0003 turns that
    // into an INSUFFICIENT verdict upstream; it must not become invented
    // Evidence down here.
    if (!this.apiKey) {
      throw new Error("Tavily search is not configured: no API key");
    }

    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      return createSearchResponse("", []);
    }

    const timeout = options.timeoutMs || this.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const payload: Record<string, any> = {
        api_key: this.apiKey,
        query: trimmedQuery,
        max_results: options.maxResults || this.defaultMaxResults,
        search_depth: options.searchDepth || "basic",
      };

      if (options.includeDomains && options.includeDomains.length > 0) {
        payload.include_domains = options.includeDomains;
      }
      if (options.excludeDomains && options.excludeDomains.length > 0) {
        payload.exclude_domains = options.excludeDomains;
      }

      const response = await fetch(`${this.baseUrl}/search`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(`Tavily search API error (${response.status} ${response.statusText}): ${errorText}`);
      }

      const data = await response.json();
      const rawResults = Array.isArray(data.results) ? data.results : [];

      if (rawResults.length === 0) {
        return createSearchResponse(trimmedQuery, []);
      }

      const results: SearchResultItem[] = rawResults.map((item: any) => ({
        title: String(item.title || ""),
        url: String(item.url || ""),
        content: String(item.content || ""),
        score: typeof item.score === "number" ? item.score : undefined,
        publishedDate: item.published_date ? String(item.published_date) : undefined,
        sourceType: "secondary",
      }));

      return createSearchResponse(trimmedQuery, results);
    } catch (err) {
      console.warn("Tavily search failed:", err);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
