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
  /**
   * Search these, keep what comes back, and read each page once. Safe to
   * call again while an earlier call is still running.
   */
  seed(queries: string[]): Promise<void>;
  /** One more search. */
  addQuery(query: string): Promise<void>;
  /** The pages that mention this claim's subject, most on-point first. */
  candidatesFor(claim: Claim, limit: number): PooledSource[];
  /**
   * Every page in the pool, closest to the claim's own wording first. For a
   * claim no page names by its subject: JEV decides what a page says about
   * it, so it is never left with nothing to read (ADR-0007).
   */
  closestFor(claim: Claim, limit: number): PooledSource[];
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
    closestFor(claim, limit) {
      const wanted = pairsOf(`${claim.originalText}${claim.normalizedText}`);
      return [...pages.values()]
        .map((page, order) => ({ page, order, score: sharedPairs(wanted, page) }))
        .sort((a, b) => b.score - a.score || a.order - b.order)
        .slice(0, limit)
        .map((scored) => scored.page);
    },
  };
}

/**
 * Two-character runs of a text. Japanese has no spaces to split on, and the
 * subject a claim is filed under can come back in another language, so the
 * claim's own wording is compared a pair of characters at a time.
 */
function pairsOf(text: string): Set<string> {
  const compact = text.replace(/\s+/g, "");
  const pairs = new Set<string>();
  for (let i = 0; i < compact.length - 1; i++) pairs.add(compact.slice(i, i + 2));
  return pairs;
}

function sharedPairs(wanted: Set<string>, page: PooledSource): number {
  const found = pairsOf(`${page.title}${page.text}`);
  let shared = 0;
  for (const pair of wanted) if (found.has(pair)) shared++;
  return shared;
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

/**
 * How much of the page is about this claim's subject.
 *
 * Counting mentions rather than presence, because a directory or booking
 * listing names the subject once in passing while its own site names it
 * throughout — and a passing mention decided a judgement it had no business
 * deciding. Each term is capped so one repeated word cannot carry a page.
 */
const MENTIONS_PER_TERM_CAP = 6;

function scoreOf(page: PooledSource, terms: string[]): number {
  const haystack = `${page.title}\n${page.title}\n${page.text}`;

  return terms.reduce((score, term) => score + Math.min(mentions(haystack, term), MENTIONS_PER_TERM_CAP), 0);
}

function mentions(haystack: string, term: string): number {
  let count = 0;
  let at = haystack.indexOf(term);
  while (at !== -1) {
    count++;
    at = haystack.indexOf(term, at + term.length);
  }
  return count;
}
