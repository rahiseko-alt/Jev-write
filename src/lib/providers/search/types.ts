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
  /** True when this provider answered with a stand-in rather than the real service. */
  servedByFallback?: boolean;
  search(query: string, options?: SearchOptions): Promise<SearchResponse>;
}
