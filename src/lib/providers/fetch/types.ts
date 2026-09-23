export interface FetchedPage {
  url: string;
  title: string;
  content: string;
  text?: string; // alias for content
  publishedAt?: string;
  author?: string;
  siteName?: string;
  statusCode: number;
}

export interface FetchOptions {
  timeoutMs?: number;
  maxContentLength?: number;
  headers?: Record<string, string>;
}

export interface FetchProvider {
  /** How many calls to the real service failed during this run. */
  failureCount?: number;
  /** The first failure's message, with anything credential-shaped removed. */
  lastError?: string;
  fetchUrl(url: string, options?: FetchOptions): Promise<FetchedPage>;
  fetch(url: string, options?: FetchOptions): Promise<FetchedPage>;
}
