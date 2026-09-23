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
  /**
   * Aborted at the page-fetch stage's cut-off (ADR-0021). The fetch then
   * throws what the signal was aborted with, rather than coming back as a
   * page that could not be read: the page did not fail, the time ran out.
   */
  signal?: AbortSignal;
}

export interface FetchProvider {
  /** How many calls to the real service failed during this run. */
  failureCount?: number;
  /** The first failure's message, with anything credential-shaped removed. */
  lastError?: string;
  fetchUrl(url: string, options?: FetchOptions): Promise<FetchedPage>;
  fetch(url: string, options?: FetchOptions): Promise<FetchedPage>;
}
