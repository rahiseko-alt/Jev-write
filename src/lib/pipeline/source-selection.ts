import type { Claim, Evidence, EvidenceTrace, SourceType, UnjudgedCandidates } from "@/types";
import type { JEVAnswer, JEVClient } from "@/lib/providers";
import { RELEVANCE_THRESHOLD } from "@/lib/jev/bands";
import { describeFailure } from "@/lib/providers/diagnostics";
import type { PoolSearch, PooledSource } from "./source-pool";
import { originsOf } from "./source-origin";
import {
  JEVRequest,
  Section,
  SourcePage,
  estimateTokens,
  planSupportRequests,
  splitSections,
  supportSectionTokens,
  supportStateCapacity,
} from "./support-question";
import {
  ClaimAspect,
  aspectOf,
  planRelevanceRequests,
  prepareTargets,
} from "./relevance-question";
import { interleave, orderForClaim } from "./candidate-order";
import type { Dispatched, DispatchWindow, JevDispatcher } from "./jev-dispatcher";
import type { TimeBudget } from "./time-budget";
import type { StageTimer } from "./stage-timings";

/**
 * How the sources for JEV are selected (north star ③, ADR-0021), in the order
 * it is done:
 *
 *  1. Every page in the pool is a candidate for every claim, and so is each
 *     claim's own fact-check result for that claim. Nothing is dropped before
 *     JEV has judged it.
 *  2. Pages are cut into sections (ADR-0014), and each claim's candidates are
 *     put in a fixed order (candidate-order.ts): primary sources first, then
 *     this claim's searches, the article's, the rest, each by rank, one
 *     origin's pages together.
 *  3. The claims take turns, so every claim's first candidates are judged
 *     before any claim's deep ones. Each section is judged in one request
 *     that asks every claim about it (relevance-question.ts).
 *  4. The clock decides how far this gets (time-budget.ts): no judgment
 *     starts after the stop time, and what never got judged is listed, for
 *     each claim, with the reason (時間切れ).
 *  5. The 信頼度 question (ADR-0011, as worded) is asked with the sections JEV
 *     judged at or above the line, in the fixed order of ADR-0016, grouped by
 *     origin. A question that gets no answer is a failure, never a number.
 */

export interface SelectionInput {
  claims: Claim[];
  /** Every page in the pool, each once. */
  pages: PooledSource[];
  /** Every search, in the order made, with the pages it found in rank order. */
  searches: PoolSearch[];
  /** Each claim's own queries, by claim id, in the order written. */
  own: Map<string, string[]>;
  /** The article's queries, in the order written. */
  article: string[];
  /** What ② wrote about each claim (ADR-0019): what it is about, and the kind of fact. */
  aspects: Map<string, ClaimAspect>;
  /** Each claim's fact-check results, by claim id. */
  factChecks: Map<string, Evidence[]>;
  jev: JEVClient;
  dispatcher: JevDispatcher;
  budget: TimeBudget;
  timer: StageTimer;
}

/** What selection made of one claim. */
export interface ClaimSelection {
  /** JEV's 信頼度 as returned (ADR-0011); absent when the question got no answer. */
  confidence?: number;
  /** Why the 信頼度 question got no answer, when it did not. */
  failure?: string;
  /** The pages holding a section JEV judged related, in the fixed order (ADR-0016). */
  evidence: Evidence[];
  /** Where the candidates went. */
  trace: Omit<EvidenceTrace, "query" | "queryViolations">;
}

/** Why a candidate section was not judged for a claim. */
export const UNJUDGED = {
  notStarted: (budget: TimeBudget) =>
    `時間切れ（開始から${seconds(budget.relevanceStopAt - budget.startedAt)}秒までに関連の判定を始められなかった）`,
  cutOff: (budget: TimeBudget) =>
    `時間切れ（関連の判定の途中で、開始から${seconds(budget.relevanceEndAt - budget.startedAt)}秒に達した）`,
  failed: (error: unknown) => `判定の失敗（JEVが答えを返さなかった: ${describeFailure(error)}）`,
  noAnswer: "判定の失敗（JEVの答えにこの主張の分が無かった）",
} as const;

/** Why a section JEV judged related did not go into the 信頼度 question. */
export const HELD_BACK = (limit: number) =>
  `信頼度の問いに入り切らなかった（関連ありと判定済み。1主張${limit}回分の上限）`;

/** Why the 信頼度 question got no answer, in the words shown to the reader. */
export const SUPPORT_FAILURE = {
  notStarted: (budget: TimeBudget) =>
    `時間切れ: 信頼度の問いを、開始から${seconds(budget.deadlineAt - budget.startedAt)}秒の締め切りまでに送れませんでした`,
  cutOff: (budget: TimeBudget) =>
    `時間切れ: 信頼度の問いの答えが、開始から${seconds(budget.deadlineAt - budget.startedAt)}秒の締め切りまでに返りませんでした`,
  noAnswer: "JEVの答えに信頼度が含まれていませんでした",
} as const;

function seconds(ms: number): number {
  return Math.round(ms / 1000);
}

/** A candidate page: one of the pool's, or one claim's fact-check result. */
type Candidate = SourcePage & {
  origin: string;
  primary: boolean;
  primaryKind?: string;
  /** The pooled page, for a web page. */
  web?: PooledSource;
  /** The fact-check result it stands for, and the claim it belongs to. */
  review?: Evidence;
  owner?: string;
};

type SectionRef = { pageId: number; source: SourcePage };

export async function selectSources(input: SelectionInput): Promise<Map<string, ClaimSelection>> {
  const { claims, dispatcher, budget, timer } = input;
  if (typeof input.jev.ask !== "function") {
    throw new Error("JEVに問いを送る手段がありません（ask が未実装）。");
  }
  const ask = input.jev.ask.bind(input.jev);

  // 1. The candidates: every page of the pool, then each claim's own
  //    fact-check results. Their origins and whether their addresses are a
  //    primary source's are read over all of them at once (ADR-0016).
  const pages: Candidate[] = [];
  const idOf = new Map<string, number>();
  for (const page of input.pages) {
    if (idOf.has(page.url)) continue;
    idOf.set(page.url, pages.length);
    pages.push({ title: page.title, url: page.url, text: page.text, web: page, origin: page.url, primary: false });
  }
  const poolIds = pages.map((_, id) => id);
  const reviewsOf = new Map<string, number[]>();
  for (const claim of claims) {
    const ids: number[] = [];
    for (const review of input.factChecks.get(claim.id) ?? []) {
      ids.push(pages.length);
      pages.push({
        title: review.sourceTitle,
        url: review.sourceUrl,
        text: review.excerpt,
        review,
        owner: claim.id,
        origin: review.sourceUrl,
        primary: false,
      });
    }
    reviewsOf.set(claim.id, ids);
  }
  originsOf(pages).forEach((origin, id) => Object.assign(pages[id], origin));

  // 2. Sections (ADR-0014: nothing cut away), and each claim's order.
  const sections: SectionRef[] = [];
  const sectionsOf: number[][] = pages.map((page, pageId) =>
    splitSections(page.text).map((text) => {
      sections.push({ pageId, source: { title: page.title, url: page.url, text } });
      return sections.length - 1;
    })
  );
  const searches = input.searches.map((search) => ({
    query: search.query,
    pageIds: search.pages.map((page) => idOf.get(page.url)).filter((id): id is number => id !== undefined),
  }));
  const allReviews = new Set([...reviewsOf.values()].flat());
  const orderOf = new Map<string, number[]>();
  for (const claim of claims) {
    const first = reviewsOf.get(claim.id) ?? [];
    const pageOrder = orderForClaim({
      pages,
      searches,
      own: input.own.get(claim.id) ?? [],
      article: input.article,
      first,
      exclude: new Set([...allReviews].filter((id) => !first.includes(id))),
    });
    orderOf.set(
      claim.id,
      pageOrder.flatMap((id) => sectionsOf[id])
    );
  }

  // 3–4. The relevance judgments: in turns, one request per section asking
  //      every claim it is a candidate for, until the clock says stop.
  const relevance = new Map<string, Map<number, number>>(claims.map((claim) => [claim.id, new Map()]));
  const unjudged = new Map<string, Map<number, string>>(claims.map((claim) => [claim.id, new Map()]));
  const targets = prepareTargets(
    claims.map((claim) => ({
      key: claim.id,
      original: claim.originalText,
      aspect: aspectOf(claim, input.aspects.get(claim.id)),
    }))
  );
  const relevanceWindow: DispatchWindow = {
    stage: "relevanceJudging",
    startBy: budget.relevanceStopAt,
    finishBy: budget.relevanceEndAt,
  };

  const judged = timer.begin("relevanceJudging");
  const pending: Promise<void>[] = [];
  const schedule = interleave(claims.map((claim) => orderOf.get(claim.id) ?? []));
  for (const sectionId of schedule) {
    const section = sections[sectionId];
    const owner = pages[section.pageId].owner;
    const asked = owner ? targets.filter((target) => target.key === owner) : targets;
    for (const request of planRelevanceRequests(section.source, asked)) {
      pending.push(
        dispatcher
          .send(request.tokens, relevanceWindow, (timeoutMs) =>
            ask(request.state, request.questions, { timeoutMs })
          )
          .then((outcome) => {
            if (outcome.status === "answered") {
              for (const key of request.keys) {
                const noul = noulOf(outcome.value[key]);
                if (noul === undefined) unjudged.get(key)!.set(sectionId, UNJUDGED.noAnswer);
                else relevance.get(key)!.set(sectionId, noul);
              }
              return;
            }
            const why =
              outcome.status === "not-started"
                ? UNJUDGED.notStarted(budget)
                : outcome.cutOff
                ? UNJUDGED.cutOff(budget)
                : UNJUDGED.failed(outcome.error);
            for (const key of request.keys) unjudged.get(key)!.set(sectionId, why);
          })
      );
    }
  }
  await Promise.all(pending);
  judged();
  reportRelevance(input, dispatcher, budget, schedule, unjudged, sections);

  // 5. The 信頼度 question for every claim, with the sections JEV judged
  //    related: taken in the order the claim's candidates were judged in, up
  //    to SUPPORT_REQUESTS_PER_CLAIM requests' worth, and sent in the fixed
  //    order of ADR-0016, by origin. The claims take turns here too.
  const indexInPage = new Map<number, number>();
  sectionsOf.forEach((ids) => ids.forEach((id, index) => indexInPage.set(id, index)));
  type Plan = { claim: Claim; order: number[]; requests: JEVRequest[]; passed: Set<number>; heldBack: number[] };
  const plans: Plan[] = claims.map((claim) => {
    const order = fixedOrderOf([...poolIds, ...(reviewsOf.get(claim.id) ?? [])], pages);
    const position = new Map(order.map((pageId, at) => [pageId, at]));
    const scores = relevance.get(claim.id)!;
    const toSection = (sectionId: number): Section => {
      const page = pages[sections[sectionId].pageId];
      return {
        page: position.get(sections[sectionId].pageId)!,
        source: sections[sectionId].source,
        origin: page.origin,
        primary: page.primary,
        ...(page.primaryKind !== undefined ? { primaryKind: page.primaryKind } : {}),
      };
    };
    const byFixedOrder = (a: number, b: number) =>
      position.get(sections[a].pageId)! - position.get(sections[b].pageId)! ||
      indexInPage.get(a)! - indexInPage.get(b)!;
    const related = (orderOf.get(claim.id) ?? []).filter(
      (sectionId) => (scores.get(sectionId) ?? -1) >= RELEVANCE_THRESHOLD
    );
    return {
      claim,
      order,
      ...fitSupport(claim.originalText, related, toSection, byFixedOrder, budget.settings.supportRequestsPerClaim),
    };
  });

  const supportWindow: DispatchWindow = {
    stage: "supportJudging",
    startBy: budget.supportStopAt,
    finishBy: budget.deadlineAt,
  };
  // Each claim's outcomes in the order of its requests, whatever order they come back in.
  const answers = new Map<string, Dispatched<Record<string, JEVAnswer>>[]>(claims.map((c) => [c.id, []]));
  const turns = interleave(
    plans.map((plan) => plan.requests.map((request, index) => ({ plan, request, index })))
  );
  const supported = timer.begin("supportJudging");
  await Promise.all(
    turns.map(({ plan, request, index }) =>
      dispatcher
        .send(
          estimateTokens(JSON.stringify({ state: request.state, questions: request.questions })),
          supportWindow,
          (timeoutMs) => ask(request.state, request.questions, { timeoutMs })
        )
        .then((outcome) => {
          answers.get(plan.claim.id)![index] = outcome;
        })
    )
  );
  supported();

  // What became of each claim.
  const result = new Map<string, ClaimSelection>();
  for (const { claim, order, passed, heldBack } of plans) {
    result.set(
      claim.id,
      assemble({
        claim,
        order,
        pages,
        poolSize: poolIds.length,
        sectionsOf,
        candidates: orderOf.get(claim.id) ?? [],
        scores: relevance.get(claim.id)!,
        passed,
        heldBack,
        unjudged: unjudged.get(claim.id)!,
        sections,
        outcomes: answers.get(claim.id)!,
        budget,
      })
    );
  }
  return result;
}

/**
 * The related sections that go into one claim's 信頼度 question: in the order
 * the claim's candidates were judged in (primary sources first, then its own
 * searches, …), for as long as they fit `limit` requests. The rest are held
 * back, to be listed. The ones that go are packed in the fixed order of
 * ADR-0016, so the same sections always make the same requests.
 */
function fitSupport(
  original: string,
  related: number[],
  toSection: (sectionId: number) => Section,
  byFixedOrder: (a: number, b: number) => number,
  limit: number
): { requests: JEVRequest[]; passed: Set<number>; heldBack: number[] } {
  const room = limit * supportStateCapacity(original);
  const kept: number[] = [];
  const heldBack: number[] = [];
  let used = 0;
  for (const sectionId of related) {
    const size = supportSectionTokens(toSection(sectionId));
    // One too large for what is left does not keep out the smaller ones after it.
    if (used + size <= room) {
      kept.push(sectionId);
      used += size;
    } else {
      heldBack.push(sectionId);
    }
  }
  const plan = () =>
    planSupportRequests({ original, sections: kept.slice().sort(byFixedOrder).map(toSection) });
  let requests = plan();
  // Packing leaves some room unused in each request: when that makes one
  // request too many, the last taken go back until it fits.
  while (requests.length > limit && kept.length > 0) {
    heldBack.push(kept.pop()!);
    requests = plan();
  }
  const at = new Map(related.map((sectionId, i) => [sectionId, i]));
  heldBack.sort((a, b) => at.get(a)! - at.get(b)!);
  return { requests, passed: new Set(kept), heldBack };
}

/** A Noul's number as returned, or nothing when there is none to read. */
function noulOf(answer: JEVAnswer | undefined): number | undefined {
  return answer && answer.type === "noul" && Number.isFinite(answer.noul) ? answer.noul : undefined;
}

function assemble(params: {
  claim: Claim;
  /** The claim's candidate pages in the fixed order of ADR-0016. */
  order: number[];
  pages: Candidate[];
  poolSize: number;
  sectionsOf: number[][];
  /** The claim's candidate sections in the order they were due to be judged. */
  candidates: number[];
  scores: Map<number, number>;
  /** The related sections that went into the 信頼度 question. */
  passed: Set<number>;
  /** The related sections that did not fit it, in the order they were judged. */
  heldBack: number[];
  unjudged: Map<number, string>;
  sections: SectionRef[];
  outcomes: Dispatched<Record<string, JEVAnswer>>[];
  budget: TimeBudget;
}): ClaimSelection {
  const { claim, order, pages, sectionsOf, candidates, scores, passed, sections } = params;

  // The 信頼度: every request answered, or no number at all. Spread over
  // several requests, the sentence is backed by the sections if it is backed
  // by some of them, so the highest answer is the one shown (ADR-0014).
  // Nothing is averaged or adjusted.
  let failure: string | undefined;
  const numbers: number[] = [];
  for (const outcome of params.outcomes) {
    if (outcome.status === "answered") {
      const noul = noulOf(outcome.value.support);
      if (noul === undefined) failure = failure ?? SUPPORT_FAILURE.noAnswer;
      else numbers.push(noul);
    } else if (outcome.status === "not-started") {
      failure = failure ?? SUPPORT_FAILURE.notStarted(params.budget);
    } else {
      failure =
        failure ?? (outcome.cutOff ? SUPPORT_FAILURE.cutOff(params.budget) : describeFailure(outcome.error));
    }
  }
  const confidence = failure === undefined && numbers.length > 0 ? Math.max(...numbers) : undefined;
  if (failure === undefined && numbers.length === 0) failure = SUPPORT_FAILURE.noAnswer;

  // The candidates JEV never judged for this claim, by reason, in the order
  // they were due. Said, never dropped without a word.
  const byReason = new Map<string, { sections: number; urls: Set<string> }>();
  for (const sectionId of candidates) {
    const why = params.unjudged.get(sectionId);
    if (why === undefined) continue;
    const entry = byReason.get(why) ?? { sections: 0, urls: new Set<string>() };
    entry.sections++;
    entry.urls.add(sections[sectionId].source.url);
    byReason.set(why, entry);
  }
  const unjudged: UnjudgedCandidates[] = [...byReason.entries()].map(([reason, entry]) => ({
    reason,
    sections: entry.sections,
    urls: [...entry.urls],
  }));
  if (unjudged.length > 0) {
    const total = unjudged.reduce((sum, entry) => sum + entry.sections, 0);
    console.info(
      `Claim ${claim.id}: ${total} of ${candidates.length} candidate sections were not judged for relevance (ADR-0021): ` +
        unjudged.map((entry) => `${entry.reason} ${entry.sections} sections on ${entry.urls.length} pages`).join("; ")
    );
  }

  // The related sections that did not fit the 信頼度 question: listed too.
  const heldBack: UnjudgedCandidates | undefined =
    params.heldBack.length > 0
      ? {
          reason: HELD_BACK(params.budget.settings.supportRequestsPerClaim),
          sections: params.heldBack.length,
          urls: [...new Set(params.heldBack.map((sectionId) => sections[sectionId].source.url))],
        }
      : undefined;
  if (heldBack) {
    console.info(
      `Claim ${claim.id}: ${heldBack.sections} related sections on ${heldBack.urls.length} pages were held back ` +
        `from the 信頼度 question (ADR-0021): ${heldBack.reason}: ${heldBack.urls.join(" ")}`
    );
  }

  // The grounds in the bubble: the pages holding a section that went into
  // the 信頼度 question, each with its most related one, in the fixed order.
  const evidence: Evidence[] = [];
  const usedOrigins = new Set<string>();
  let used = 0;
  let saidNothing = 0;
  order.forEach((pageId, at) => {
    const page = pages[pageId];
    let best: { text: string; relevance: number } | undefined;
    let open = false;
    let related = false;
    for (const sectionId of sectionsOf[pageId]) {
      const score = scores.get(sectionId);
      if (score === undefined) {
        open = true;
        continue;
      }
      if (score >= RELEVANCE_THRESHOLD) related = true;
      if (passed.has(sectionId) && (!best || score > best.relevance)) {
        best = { text: sections[sectionId].source.text, relevance: score };
      }
    }
    if (best) usedOrigins.add(page.origin);
    if (page.review) {
      if (best) evidence.push(page.review);
      return;
    }
    if (!page.web) return;
    if (!best) {
      if (!open && !related) saidNothing++;
      return;
    }
    used++;
    evidence.push({
      id: `ev-${claim.id}-web-${at}`,
      claimId: claim.id,
      sourceUrl: page.web.url,
      sourceTitle: page.web.title,
      publisher: page.web.siteName || page.web.author,
      publishedAt: page.web.publishedAt,
      excerpt: best.text.slice(0, 350),
      sourceType: sourceTypeOf(page.web.url),
      confidence: best.relevance,
    });
  });

  const judgedCount = candidates.filter((sectionId) => scores.has(sectionId)).length;
  const relevantCount = candidates.filter((sectionId) => (scores.get(sectionId) ?? -1) >= RELEVANCE_THRESHOLD).length;

  return {
    ...(confidence !== undefined ? { confidence } : {}),
    ...(failure !== undefined ? { failure } : {}),
    evidence,
    trace: {
      found: params.poolSize,
      offSubject: 0,
      unreadable: 0,
      saidNothing,
      weak: 0,
      used,
      overCap: 0,
      origins: usedOrigins.size,
      sections: candidates.length,
      judged: judgedCount,
      relevant: relevantCount,
      ...(unjudged.length > 0 ? { unjudged } : {}),
      ...(heldBack ? { heldBack } : {}),
    },
  };
}

/** How many addresses go on one log line, so no line grows past what a log keeps. */
const URLS_PER_LOG_LINE = 20;

/**
 * For the run: how far the relevance judgments got and why they stopped, and
 * every page left unjudged, by reason, once (the pool's pages are asked of
 * every claim at once, so they are unjudged for all of them alike; each
 * claim's own list is in its evidenceTrace).
 */
function reportRelevance(
  input: SelectionInput,
  dispatcher: JevDispatcher,
  budget: TimeBudget,
  /** Every candidate section, in the order it was due to be judged. */
  schedule: number[],
  unjudged: Map<string, Map<number, string>>,
  sections: SectionRef[]
): void {
  const counts = dispatcher.countsFor("relevanceJudging");
  console.info(
    `Relevance (ADR-0021): ${counts.calls} requests sent, ${counts.notStarted} not started (時間切れ, stop at ` +
      `${seconds(budget.relevanceStopAt - budget.startedAt)}s), ${counts.cutOff} cut off, ${counts.failures} failed, ` +
      `${counts.retries} retries; ${input.claims.length} claims, ${input.pages.length} pages; ` +
      `${seconds(budget.elapsed())}s into the run.`
  );

  const byReason = new Map<string, Set<string>>();
  for (const sectionId of schedule) {
    for (const claimUnjudged of unjudged.values()) {
      const why = claimUnjudged.get(sectionId);
      if (why === undefined) continue;
      const urls = byReason.get(why) ?? new Set<string>();
      urls.add(sections[sectionId].source.url);
      byReason.set(why, urls);
    }
  }
  for (const [why, set] of byReason) {
    const urls = [...set];
    for (let at = 0; at < urls.length; at += URLS_PER_LOG_LINE) {
      console.info(
        `Unjudged pages (${why}) ${at + 1}–${Math.min(at + URLS_PER_LOG_LINE, urls.length)} of ${urls.length}: ` +
          urls.slice(at, at + URLS_PER_LOG_LINE).join(" ")
      );
    }
  }
}

/**
 * The fixed order pages go to JEV in (ADR-0016, step 5): origins holding a
 * primary source first, then origin by origin, and within an origin primary
 * pages first, then by address. Strings are compared code unit by code unit
 * so the order is the same on every run and every machine. An origin's pages
 * stay together, so it reaches JEV as one entry. Ties (the same address
 * twice) keep the order of their ids, which is itself fixed.
 */
function fixedOrderOf(ids: number[], pages: Candidate[]): number[] {
  const primaryOrigins = new Set(ids.filter((id) => pages[id].primary).map((id) => pages[id].origin));
  return ids.slice().sort((a, b) => {
    const pa = pages[a];
    const pb = pages[b];
    const primaryOrigin = Number(primaryOrigins.has(pb.origin)) - Number(primaryOrigins.has(pa.origin));
    if (primaryOrigin !== 0) return primaryOrigin;
    const origin = compare(pa.origin, pb.origin);
    if (origin !== 0) return origin;
    const primary = Number(pb.primary) - Number(pa.primary);
    if (primary !== 0) return primary;
    return compare(pa.url, pb.url) || a - b;
  });
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * What kind of source a URL is, from what can be told about the address
 * itself. A named company's own site cannot be recognised this way without
 * knowing every company, so only the kinds that are recognisable are named.
 */
export function sourceTypeOf(url: string): SourceType {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (hostname.endsWith(".go.jp") || hostname.endsWith(".gov") || hostname.endsWith(".lg.jp")) {
      return "official";
    }
    if (hostname.includes("factcheck") || hostname.includes("reuters.com")) {
      return "research";
    }
    if (hostname.includes("itmedia.co.jp") || hostname.includes("nikkei.com") || hostname.includes("wikipedia.org")) {
      return "secondary";
    }
  } catch {}
  return "unknown";
}
