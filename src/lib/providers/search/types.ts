import { SourceType } from "@/types";

export interface SearchResultItem {
  title: string;
  url: string;
  content: string;
  score?: number;
  publishedDate?: string;
  sourceType?: SourceType;
}

export interface SearchResponse extends Iterable<SearchResultItem> {
  query: string;
  results: SearchResultItem[];
  length: number;
  [index: number]: SearchResultItem;
}

export interface SearchOptions {
  maxResults?: number;
  searchDepth?: "basic" | "advanced";
  includeDomains?: string[];
  excludeDomains?: string[];
  timeoutMs?: number;
}

export interface SearchProvider {
  /** How many calls to the real service failed during this run. */
  failureCount?: number;
  /** The first failure's message, with anything credential-shaped removed. */
  lastError?: string;
  search(query: string, options?: SearchOptions): Promise<SearchResponse>;
}
