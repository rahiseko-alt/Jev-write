/**
 * The order JEV judges the candidates in (ADR-0021). The order decides only
 * what is judged first when the time runs out; it never decides relevance,
 * and it never drops a candidate. Nothing in it is a score of this side's:
 * it is read off the addresses (primary or not), the searches (whose, which
 * one, what rank) and the origins (ADR-0016), and it is the same on every
 * run for the same pool — no completion order, no insertion order of a Map,
 * no locale-dependent comparison.
 */

/** A candidate page as far as the order is concerned. */
export interface OrderedPage {
  url: string;
  /** Whether the address is a primary source's (source-origin.ts primaryKindOf). */
  primary: boolean;
  /** Its origin (ADR-0016): its site, or the sites carrying the same text. */
  origin: string;
}

/** One search, in the order made, with the pages it found as their ids, in rank order. */
export interface RankedSearch {
  query: string;
  pageIds: number[];
}

/** Where a page stands for one claim: whose search found it, which, and at what rank. */
type Standing = [bucket: number, queryAt: number, rank: number];

const OWN = 0;
const ARTICLE = 1;
const REST = 2;
const UNSEARCHED = 3;

/**
 * One claim's candidate pages, in the order they are to be judged:
 *
 *  1. its own fact-check results (`first`), as given: JEV matched them to the claim;
 *  2. every primary source (go.jp, lg.jp, e-Gov, ac.jp, DOI, …) before any other page;
 *  3. within that and among the rest: the pages this claim's own searches found,
 *     then the article's searches, then every other search, each search in the
 *     order written and each page at its best rank;
 *  4. pages of one origin together, at the place of the first of them, so a
 *     reprint is judged with what it reprints (ADR-0016).
 *
 * Every page in `pages` is in the result, once.
 */
export function orderForClaim(params: {
  pages: OrderedPage[];
  searches: RankedSearch[];
  /** This claim's own queries, in the order written. */
  own: string[];
  /** The article's queries, in the order written. */
  article: string[];
  /** Page ids that are this claim's alone (fact-check results), put first. */
  first?: number[];
  /** Page ids to leave out: another claim's own fact-check results. */
  exclude?: Set<number>;
}): number[] {
  const { pages, searches, own, article } = params;
  const first = params.first ?? [];
  const leaveOut = new Set([...(params.exclude ?? []), ...first]);
  const ownAt = new Map(own.map((query, i) => [query.trim(), i]));
  const articleAt = new Map(article.map((query, i) => [query.trim(), i]));

  const standing = new Map<number, Standing>();
  searches.forEach((search, searchAt) => {
    const query = search.query.trim();
    const at: [number, number] = ownAt.has(query)
      ? [OWN, ownAt.get(query)!]
      : articleAt.has(query)
      ? [ARTICLE, articleAt.get(query)!]
      : [REST, searchAt];
    search.pageIds.forEach((id, rank) => {
      const candidate: Standing = [at[0], at[1], rank];
      const current = standing.get(id);
      if (!current || before(candidate, current)) standing.set(id, candidate);
    });
  });

  const ids = pages.map((_, id) => id).filter((id) => !leaveOut.has(id));
  const key = (id: number): [number, ...Standing] => [
    pages[id].primary ? 0 : 1,
    ...(standing.get(id) ?? ([UNSEARCHED, 0, 0] as Standing)),
  ];
  const sorted = ids.slice().sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] !== kb[i]) return ka[i] - kb[i];
    }
    return compare(pages[a].url, pages[b].url) || a - b;
  });

  return [...grouped(first, pages), ...grouped(sorted, pages)];
}

/** The ids with each origin's pages brought together at the place of its first. */
function grouped(ids: number[], pages: OrderedPage[]): number[] {
  const byOrigin = new Map<string, number[]>();
  for (const id of ids) {
    const origin = pages[id].origin;
    const members = byOrigin.get(origin) ?? [];
    members.push(id);
    byOrigin.set(origin, members);
  }
  const out: number[] = [];
  const done = new Set<string>();
  for (const id of ids) {
    const origin = pages[id].origin;
    if (done.has(origin)) continue;
    done.add(origin);
    out.push(...(byOrigin.get(origin) ?? []));
  }
  return out;
}

/**
 * Every claim's candidates in one sequence, taken in turns (ADR-0021): each
 * claim's first not-yet-taken candidate, claim by claim, then each claim's
 * next, and so on. A candidate already taken for one claim is not taken
 * again. So every claim has its first candidates judged before any claim has
 * deep ones, and no claim waits behind another's long list.
 */
export function interleave<T>(orders: T[][]): T[] {
  const taken = new Set<T>();
  const out: T[] = [];
  const next = orders.map(() => 0);
  for (;;) {
    let moved = false;
    orders.forEach((order, claim) => {
      while (next[claim] < order.length && taken.has(order[next[claim]])) next[claim]++;
      if (next[claim] >= order.length) return;
      const item = order[next[claim]++];
      taken.add(item);
      out.push(item);
      moved = true;
    });
    if (!moved) return out;
  }
}

function before(a: Standing, b: Standing): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

/** Code unit by code unit: the same on every machine and in every locale. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
