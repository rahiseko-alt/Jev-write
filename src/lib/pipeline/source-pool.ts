import { Claim } from "@/types";
import { FetchProvider, SearchProvider, SearchResultItem } from "@/lib/providers";

/** A page found once and then used by every claim it can speak to. */
export interface PooledSource {
  url: string;
  title: string;
  text: string;
  siteName?: string;
  author?: string;
  publishedAt?: string;
}

export interface SourcePool {
  /** Search these, keep what comes back, and read each page once. */
  seed(queries: string[]): Promise<void>;
  /** One more search, for a claim the pool has nothing for. */
  addQuery(query: string): Promise<void>;
  /** The pages that mention this claim's subject, most on-point first. */
  candidatesFor(claim: Claim, limit: number): PooledSource[];
  /** The queries that built this pool, in the order they were made. */
  queries(): string[];
  /** True when a search could not be made at all (ADR-0003, ADR-0006 layer 3). */
  searchFailed(): boolean;
  /** The first failure's message, for the reader. */
  failure(): string | undefined;
  /** How many pages the pool holds. */
  size(): number;
}

/**
 * One pool of pages per run, instead of a fresh search for every claim.
 *
 * A checked article is mostly about one subject, so searching per claim asked
 * the same questions over and over: one 630-character block spent 34 searches
 * and fetched the same pages a dozen times. The pool searches the article's
 * topics once, reads each page once, and hands the same pages to every claim.
 */
export function createSourcePool(deps: {
  search: SearchProvider;
  fetchProvider: FetchProvider;
  resultsPerQuery: number;
}): SourcePool {
  const { search, fetchProvider, resultsPerQuery } = deps;

  const asked: string[] = [];
  const pages = new Map<string, PooledSource>();
  let failed = false;
  let failureMessage: string | undefined;

  async function read(result: SearchResultItem): Promise<void> {
    if (pages.has(result.url)) return;

    let fetched: any = { url: result.url, title: result.title };
    try {
      fetched =
        typeof fetchProvider.fetchUrl === "function"
          ? await fetchProvider.fetchUrl(result.url)
          : await (fetchProvider as any).fetch(result.url);
    } catch (err) {
      console.warn(`Fetch failed for ${result.url}:`, err);
    }

    const pageText: string = fetched.content || fetched.text || "";
    const snippet: string = (result as any).content || (result as any).snippet || "";
    const text = pageText.trim().length > 0 ? pageText : snippet;
    if (text.trim().length === 0) return;

    pages.set(result.url, {
      url: fetched.url || result.url,
      title: fetched.title || result.title || "",
      text,
      siteName: fetched.siteName,
      author: fetched.author,
      publishedAt: fetched.publishedAt,
    });
  }

  async function run(queries: string[]): Promise<void> {
    const fresh = queries.map((q) => q.trim()).filter((q) => q && !asked.includes(q));
    if (fresh.length === 0) return;
    asked.push(...fresh);

    const found: SearchResultItem[] = [];
    await Promise.all(
      fresh.map(async (query) => {
        try {
          const response = await search.search(query, { maxResults: resultsPerQuery });
          for (const result of response.results || []) found.push(result);
        } catch (err) {
          // ADR-0003: the lookup failed and says so. Nothing stands in for it.
          failed = true;
          failureMessage = failureMessage ?? (err instanceof Error ? err.message : String(err));
          console.warn(`Web search failed for "${query}":`, err);
        }
      })
    );

    const unseen = found.filter(
      (result, index) =>
        !pages.has(result.url) && found.findIndex((r) => r.url === result.url) === index
    );
    await Promise.all(unseen.map(read));
  }

  return {
    seed: run,
    addQuery: (query: string) => run([query]),
    queries: () => [...asked],
    searchFailed: () => failed,
    failure: () => failureMessage,
    size: () => pages.size,
    candidatesFor(claim, limit) {
      const terms = termsOf(claim);
      if (terms.length === 0) return [...pages.values()].slice(0, limit);

      return [...pages.values()]
        .map((page) => ({ page, score: scoreOf(page, terms) }))
        .filter((scored) => scored.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((scored) => scored.page);
    },
  };
}

/**
 * The words that say what this claim is about. Figures are left out on
 * purpose: a fabricated number appears on no page, so scoring by it would
 * bury the very page that carries the true one.
 */
function termsOf(claim: Claim): string[] {
  const terms = [claim.subject ?? "", ...(claim.entities ?? [])]
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);

  return Array.from(new Set(terms));
}

function scoreOf(page: PooledSource, terms: string[]): number {
  const haystack = `${page.title}\n${page.text}`;
  return terms.reduce((score, term) => (haystack.includes(term) ? score + 1 : score), 0);
}
