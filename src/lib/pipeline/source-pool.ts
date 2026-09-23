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
  /**
   * Search these, keep what comes back, and read each page once. Safe to
   * call again while an earlier call is still running.
   */
  seed(queries: string[]): Promise<void>;
  /** One more search. */
  addQuery(query: string): Promise<void>;
  /**
   * Every page in the pool, none left out (ADR-0007, ADR-0016). First the
   * pages the given searches returned, search by search in the order given
   * and each in the order the search ranked it; then the rest of the pool in
   * the same way, by the order its searches were made. No score of this
   * side's is involved, and the order does not depend on which search or
   * page happened to come back first.
   */
  candidatesFor(queries: string[]): PooledSource[];
  /**
   * Every search made, in the order made, with the pages it found in its own
   * ranked order (each page once). What the candidates are ordered by
   * (ADR-0021); nothing about completion order is in it.
   */
  searches(): PoolSearch[];
  /** The queries that built this pool, in the order they were made. */
  queries(): string[];
  /** True when a search could not be made at all (ADR-0003, ADR-0006 layer 3). */
  searchFailed(): boolean;
  /** The first failure's message, for the reader. */
  failure(): string | undefined;
  /** How many pages the pool holds. */
  size(): number;
}

/** One search and the pages it found, in its own ranked order. */
export interface PoolSearch {
  query: string;
  pages: PooledSource[];
}

/** Marks the searches and the page reads as they run, for the run's timings. */
export interface PoolTimer {
  begin(stage: "search" | "pageFetch"): () => void;
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
  timer?: PoolTimer;
}): SourcePool {
  const { search, fetchProvider, resultsPerQuery, timer } = deps;

  const asked: string[] = [];
  const pages = new Map<string, PooledSource>();
  /** Each search's results, as the addresses it returned, in its order. */
  const resultsOf = new Map<string, string[]>();
  let failed = false;
  let failureMessage: string | undefined;

  // Searches for the article and for each claim run side by side (ADR-0015),
  // so the same page can turn up in two of them at once: it is read once.
  const reading = new Map<string, Promise<void>>();

  function read(result: SearchResultItem): Promise<void> {
    if (pages.has(result.url)) return Promise.resolve();
    const pending = reading.get(result.url);
    if (pending) return pending;
    const started = readPage(result);
    reading.set(result.url, started);
    return started;
  }

  async function readPage(result: SearchResultItem): Promise<void> {

    let fetched: any = { url: result.url, title: result.title };
    const fetchEnded = timer?.begin("pageFetch");
    try {
      fetched =
        typeof fetchProvider.fetchUrl === "function"
          ? await fetchProvider.fetchUrl(result.url)
          : await (fetchProvider as any).fetch(result.url);
    } catch (err) {
      console.warn(`Fetch failed for ${result.url}:`, err);
    } finally {
      fetchEnded?.();
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
        const searchEnded = timer?.begin("search");
        try {
          const response = await search.search(query, { maxResults: resultsPerQuery });
          // Kept per search, in the search's own order: which search came
          // back first must not decide where a page stands.
          resultsOf.set(
            query,
            (response.results || []).map((result) => result.url)
          );
          for (const result of response.results || []) found.push(result);
        } catch (err) {
          // ADR-0003: the lookup failed and says so. Nothing stands in for it.
          failed = true;
          failureMessage = failureMessage ?? (err instanceof Error ? err.message : String(err));
          console.warn(`Web search failed for "${query}":`, err);
        } finally {
          searchEnded?.();
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
    searches() {
      return asked.map((query) => {
        const found: PooledSource[] = [];
        const seen = new Set<string>();
        for (const url of resultsOf.get(query) ?? []) {
          const page = pages.get(url);
          // Two addresses that led to the same page are one page, at its first rank.
          if (!page || seen.has(page.url)) continue;
          seen.add(page.url);
          found.push(page);
        }
        return { query, pages: found };
      });
    },
    candidatesFor(queries) {
      const ordered: PooledSource[] = [];
      const seen = new Set<string>();
      for (const query of [...queries.map((q) => q.trim()), ...asked]) {
        for (const url of resultsOf.get(query) ?? []) {
          const page = pages.get(url);
          // Two addresses that led to the same page are one page.
          if (!page || seen.has(page.url)) continue;
          seen.add(page.url);
          ordered.push(page);
        }
      }
      return ordered;
    },
  };
}
