/**
 * The order JEV judges the candidates in (ADR-0022). The order decides only
 * what is judged first, which matters only if the time runs out; it never
 * decides relevance and it never leaves a candidate out. Nothing in it is a
 * score of this side's: it is read off the addresses (a primary source's or
 * not), the searches (whose, which one, what rank) and the origins
 * (ADR-0016), and it is the same on every run for the same pool — no
 * completion order, no insertion order of a Map, no locale-dependent
 * comparison.
 */

/** A candidate page as far as the order is concerned. */
export interface OrderedPage {
  /** Its id among the run's candidate pages. */
  id: number;
  /** Whether its address is a primary source's (source-origin.ts, primaryKindOf). */
  primary: boolean;
  /** Its origin (ADR-0016): its site, or the sites carrying the same text. */
  origin: string;
}

/**
 * One claim's candidate pages, in the order they are to be judged:
 *
 *  1. `own`: the claim's own fact-check results, as given (JEV matched them
 *     to the claim when they were looked up);
 *  2. `ranked`: every page of the pool in this claim's search order — its own
 *     searches, then the article's, then every other search in the order they
 *     were made, each search's pages in the order it ranked them
 *     (source-pool.ts, candidatesFor) — with the primary sources first, each
 *     part keeping that order;
 *  3. in each of the two, the pages of one origin together, at the place of
 *     the first of them, so a reprint is judged next to what it reprints
 *     (ADR-0016).
 *
 * Every page given is in the result, once.
 */
export function judgingOrder(own: OrderedPage[], ranked: OrderedPage[]): number[] {
  const primaryFirst = [...ranked.filter((page) => page.primary), ...ranked.filter((page) => !page.primary)];
  return [...grouped(own), ...grouped(primaryFirst)];
}

/** The pages with each origin's pages brought together at the place of its first. */
function grouped(pages: OrderedPage[]): number[] {
  const members = new Map<string, number[]>();
  for (const page of pages) {
    const ids = members.get(page.origin) ?? [];
    if (!ids.includes(page.id)) ids.push(page.id);
    members.set(page.origin, ids);
  }
  const out: number[] = [];
  const done = new Set<string>();
  for (const page of pages) {
    if (done.has(page.origin)) continue;
    done.add(page.origin);
    out.push(...(members.get(page.origin) ?? []));
  }
  return out;
}

/**
 * Every claim's order in one sequence, the claims taking turns in their own
 * order: each claim's first candidate not yet taken, claim by claim, then
 * each claim's next, and so on. A candidate taken for one claim is not taken
 * again: it is judged for every claim it is a candidate of at once. So every
 * claim has its first candidates judged before any claim has its deep ones,
 * and no claim waits behind another's long list.
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
