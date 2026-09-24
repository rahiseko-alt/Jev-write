import type { Claim, Evidence, UnjudgedCandidates } from "@/types";
import type { CallLimit, JEVAnswer, JEVQuestion } from "@/lib/providers";
import { RELEVANCE_THRESHOLD } from "@/lib/jev/bands";
import { describeFailure } from "@/lib/providers/diagnostics";
import type { PooledSource } from "./source-pool";
import { originsOf } from "./source-origin";
import { SourcePage, readingSections } from "./support-question";
import {
  ClaimAspect,
  RelevanceRequest,
  aspectOf,
  planRelevanceRequests,
  prepareTargets,
} from "./relevance-question";
import { OrderedPage, interleave, judgingOrder } from "./candidate-order";
import type { JevDispatcher } from "./jev-dispatcher";
import { TIME_UP } from "./time-budget";

/**
 * Which material reaches the 信頼度 question (north star ③, ADR-0022), in
 * the order it is done:
 *
 *  1. Every page of the pool is a candidate for every claim, and each
 *     claim's own fact-check results are candidates for that claim. Nothing
 *     is left out before JEV has judged it: no cap, no score of this side's.
 *  2. Each page is cut into its reading sections (support-question.ts): the
 *     sections of ADR-0014, joined in reading order up to 3,122 characters.
 *  3. Each claim's candidate pages go in a fixed order (candidate-order.ts):
 *     its own fact-check results, then primary sources, then its own
 *     searches, the article's, the rest, each by rank; one origin's pages
 *     together. The claims take turns, so every claim's first candidates are
 *     judged before any claim's deep ones.
 *  4. Each section is judged in one request that asks every claim it is a
 *     candidate of whether it states a fact about the claim's aspect
 *     (relevance-question.ts). The requests go out in that order, as fast as
 *     JEV's limits allow (jev-dispatcher.ts), until the relevance cut-off
 *     (ADR-0021). What the clock left unjudged is listed for each claim with
 *     the reason 時間切れ; what JEV failed to answer, with the failure.
 *  5. For each claim, the sections JEV judged at or above the line
 *     (RELEVANCE_THRESHOLD), in the fixed order of ADR-0016, are what the
 *     信頼度 question is asked with (fact-pipeline.ts).
 *
 * The same pool gives the same requests in the same order and the same
 * lines, so the same answers put the same sections before the 信頼度
 * question. Nothing here is random.
 */

/** Asking JEV: one state, named questions, the answers under the same names. */
export type Ask = (
  state: unknown,
  questions: Record<string, JEVQuestion>,
  limit?: CallLimit
) => Promise<Record<string, JEVAnswer>>;

/** A candidate page: one of the pool's, or one claim's fact-check result. */
export interface CandidatePage extends SourcePage {
  origin: string;
  primary: boolean;
  primaryKind?: string;
  /** The pooled page, for a web page. */
  web?: PooledSource;
  /** The fact-check result it stands for, for one claim's own. */
  review?: Evidence;
}

/** What became of one candidate section for one claim. */
export type SectionOutcome =
  /** JEV answered: `relevance` is its probability that the section states a fact about the aspect. */
  | "judged"
  /** Not judged by the relevance cut-off: not started, or stopped (時間切れ, ADR-0021). */
  | "timeUp"
  /** JEV failed to answer the request, after its retries. */
  | "failed"
  /** The section and the claim's question together are over JEV's input limit. */
  | "unaskable";

/** One of a claim's candidate sections, with what JEV made of it. */
export interface JudgedSection {
  /** Its page's place in the claim's `pages`. */
  page: number;
  source: SourcePage;
  outcome: SectionOutcome;
  /** JEV's answer, when it judged the section. */
  relevance?: number;
}

/** One claim's material after the relevance judgment. */
export interface ClaimMaterial {
  /** What the relevance question asked about (relevance-question.ts, aspectOf). */
  aspect?: string;
  /** The claim's candidate pages in the fixed order of ADR-0016. */
  pages: CandidatePage[];
  /** Their sections: page by page in that order, each page's in reading order. */
  sections: JudgedSection[];
  /** Sections the clock left unjudged (時間切れ), with their pages in the order they were due. */
  unjudged?: UnjudgedCandidates;
  /** Sections JEV failed to judge, with their pages in the order they were due. */
  unanswered?: UnjudgedCandidates;
  /** The first failure JEV gave for this claim's candidates. */
  failure?: unknown;
  /** Pages with a section that could not be put to JEV at all (over its input limit). */
  overCap: number;
}

export interface RelevanceInput {
  claims: Claim[];
  /** Every page of the pool, each once, in the pool's own order. */
  pool: PooledSource[];
  /** Each claim's candidates in its search order (source-pool.ts candidatesFor), by claim id. */
  ranked: Map<string, PooledSource[]>;
  /** Each claim's own fact-check results, by claim id. */
  reviews: Map<string, Evidence[]>;
  /** What ② wrote about each claim (ADR-0019), by claim id. */
  aspects: Map<string, ClaimAspect>;
  ask: Ask;
  dispatcher: JevDispatcher;
}

/** Every candidate section, judged for every claim it is a candidate of, as the time allows. */
export async function judgeRelevance(input: RelevanceInput): Promise<Map<string, ClaimMaterial>> {
  const { claims, ask, dispatcher } = input;
  if (claims.length === 0) return new Map();

  // 1. The candidates: the pool's pages (by address, once each), then each
  //    claim's own fact-check results. Origins and primary sources are read
  //    over all of them at once (ADR-0016); that does not depend on order.
  const pages: (CandidatePage & { owner?: number })[] = [];
  const idOf = new Map<string, number>();
  for (const page of input.pool) {
    if (idOf.has(page.url) || page.text.trim().length === 0) continue;
    idOf.set(page.url, pages.length);
    pages.push({ title: page.title, url: page.url, text: page.text, web: page, origin: page.url, primary: false });
  }
  const reviewIds: number[][] = claims.map((claim, c) =>
    (input.reviews.get(claim.id) ?? []).map((review) => {
      pages.push({
        title: review.sourceTitle,
        url: review.sourceUrl,
        text: review.excerpt,
        review,
        owner: c,
        origin: review.sourceUrl,
        primary: false,
      });
      return pages.length - 1;
    })
  );
  originsOf(pages).forEach((origin, id) => {
    pages[id].origin = origin.origin;
    pages[id].primary = origin.primary;
    if (origin.primaryKind !== undefined) pages[id].primaryKind = origin.primaryKind;
  });

  // 2. Each page's reading sections, nothing cut away.
  const sectionTexts: string[][] = pages.map((page) => readingSections(page.text));

  // 3. Each claim's order, and the claims taking turns.
  const ordered = (id: number): OrderedPage => ({ id, primary: pages[id].primary, origin: pages[id].origin });
  const candidateIds: number[][] = claims.map((claim) => {
    const ids: number[] = [];
    for (const page of input.ranked.get(claim.id) ?? []) {
      const id = idOf.get(page.url);
      if (id !== undefined && !ids.includes(id)) ids.push(id);
    }
    return ids;
  });
  const orders = claims.map((_, c) => judgingOrder(reviewIds[c].map(ordered), candidateIds[c].map(ordered)));
  const schedule = interleave(orders);

  // 4. One request per section, every claim it is a candidate of asked at
  //    once, sent in the schedule's order.
  const aspects = claims.map((claim) => aspectOf(claim, input.aspects.get(claim.id)));
  const targets = prepareTargets(
    claims.map((claim, c) => ({ key: claim.id, original: claim.originalText, aspect: aspects[c] }))
  );
  const claimIndex = new Map(claims.map((claim, c) => [claim.id, c]));
  const candidateOf = claims.map((_, c) => new Set([...reviewIds[c], ...candidateIds[c]]));

  /** Per claim: section key `${page}:${index}` → what became of it. */
  const outcomes = claims.map(() => new Map<string, { outcome: SectionOutcome; relevance?: number }>());
  const failures: unknown[] = claims.map(() => undefined);
  const record = (c: number, key: string, outcome: SectionOutcome, relevance?: number, error?: unknown) => {
    outcomes[c].set(key, relevance === undefined ? { outcome } : { outcome, relevance });
    if (outcome === "failed" && failures[c] === undefined) failures[c] = error;
  };

  const pending: Promise<void>[] = [];
  for (const pageId of schedule) {
    const asked = pages[pageId].owner !== undefined
      ? [targets[pages[pageId].owner!]]
      : targets.filter((_, c) => candidateOf[c].has(pageId));
    sectionTexts[pageId].forEach((text, index) => {
      const key = `${pageId}:${index}`;
      const source = { title: pages[pageId].title, url: pages[pageId].url, text };
      const { requests, unaskable } = planRelevanceRequests(source, asked);
      for (const name of unaskable) record(claimIndex.get(name)!, key, "unaskable");
      for (const request of requests) pending.push(sendRelevance(request, key));
    });
  }

  function sendRelevance(request: RelevanceRequest, key: string): Promise<void> {
    return dispatcher
      .send("relevanceJudging", request.tokens, (signal) => ask(request.state, request.questions, { signal }))
      .then(
        (outcome) => {
          for (const name of request.keys) {
            const c = claimIndex.get(name)!;
            if (outcome.status !== "done") {
              record(c, key, "timeUp");
              continue;
            }
            const answer = outcome.value?.[name];
            if (answer && answer.type === "noul" && typeof answer.noul === "number") {
              record(c, key, "judged", answer.noul);
            } else {
              record(c, key, "failed", undefined, new Error("JEVの答えに、この主張への問いの答えがありませんでした。"));
            }
          }
        },
        (error: unknown) => {
          for (const name of request.keys) record(claimIndex.get(name)!, key, "failed", undefined, error);
        }
      );
  }
  await Promise.all(pending);

  // 5. Each claim's material, in the fixed order of ADR-0016.
  const dueAt = new Map(schedule.map((pageId, at) => [pageId, at]));
  const result = new Map<string, ClaimMaterial>();
  claims.forEach((claim, c) => {
    const mine = [...reviewIds[c], ...candidateIds[c]];
    const primaryOrigins = new Set(mine.filter((id) => pages[id].primary).map((id) => pages[id].origin));
    const inOrder = mine.slice().sort((a, b) => fixedOrder(pages[a], pages[b], primaryOrigins) || a - b);

    const sections: JudgedSection[] = [];
    const leftForTime = new Set<number>();
    const leftByJev = new Set<number>();
    let timeUp = 0;
    let failed = 0;
    let overCap = 0;
    inOrder.forEach((pageId, at) => {
      let unaskable = false;
      sectionTexts[pageId].forEach((text, index) => {
        const judged = outcomes[c].get(`${pageId}:${index}`) ?? { outcome: "timeUp" as const };
        sections.push({
          page: at,
          source: { title: pages[pageId].title, url: pages[pageId].url, text },
          ...judged,
        });
        if (judged.outcome === "timeUp") {
          timeUp++;
          leftForTime.add(pageId);
        } else if (judged.outcome === "failed") {
          failed++;
          leftByJev.add(pageId);
        } else if (judged.outcome === "unaskable") {
          unaskable = true;
        }
      });
      if (unaskable) overCap++;
    });

    const due = (ids: Set<number>) =>
      [...ids].sort((a, b) => (dueAt.get(a) ?? 0) - (dueAt.get(b) ?? 0)).map((id) => pages[id].url);
    const material: ClaimMaterial = {
      ...(aspects[c] !== undefined ? { aspect: aspects[c] } : {}),
      pages: inOrder.map((id) => {
        const { owner: _owner, ...page } = pages[id];
        return page;
      }),
      sections,
      overCap,
    };
    if (timeUp > 0) material.unjudged = { reason: TIME_UP, sections: timeUp, urls: due(leftForTime) };
    if (failed > 0) {
      material.unanswered = {
        reason: `JEVの失敗: ${describeFailure(failures[c])}`,
        sections: failed,
        urls: due(leftByJev),
      };
      material.failure = failures[c];
    }
    result.set(claim.id, material);
  });
  return result;
}

/** The sections of a claim's material that JEV judged at or above the line, in its fixed order. */
export function relatedSections(material: ClaimMaterial, threshold: number = RELEVANCE_THRESHOLD): JudgedSection[] {
  return material.sections.filter(
    (section) => section.outcome === "judged" && (section.relevance ?? 0) >= threshold
  );
}

/**
 * The fixed order pages go to JEV in (ADR-0016, step 5): origins holding a
 * primary source first, then origin by origin, and within an origin primary
 * pages first, then by address. Strings are compared code unit by code unit
 * so the order is the same on every run and every machine. An origin's pages
 * stay together, so it reaches JEV as one entry.
 */
function fixedOrder(a: CandidatePage, b: CandidatePage, primaryOrigins: Set<string>): number {
  const primaryOrigin = Number(primaryOrigins.has(b.origin)) - Number(primaryOrigins.has(a.origin));
  if (primaryOrigin !== 0) return primaryOrigin;
  const origin = compare(a.origin, b.origin);
  if (origin !== 0) return origin;
  const primary = Number(b.primary) - Number(a.primary);
  if (primary !== 0) return primary;
  return compare(a.url, b.url);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
