import { createSourcePool } from "./source-pool";
import { estimateTokens } from "./support-question";
import { ClaimSelection, selectSources } from "./source-selection";
import type { ClaimAspect } from "./relevance-question";
import { DispatchWindow, JevDispatcher } from "./jev-dispatcher";
import {
  Clock,
  DEFAULT_JEV_LIMITS,
  JevLimits,
  TimeBudget,
  createTimeBudget,
  systemClock,
} from "./time-budget";
import { StageTimer } from "./stage-timings";
import { describeFailure } from "@/lib/providers/diagnostics";
import {
  CheckedQueries,
  checkClaimQueries,
  checkDocumentQueries,
} from "@/lib/providers/llm/search-queries";
import {
  Claim,
  ClaimResult,
  ClaimVerdict,
  Evidence,
  StageTiming,
} from "@/types";
import {
  FetchProvider,
  GoogleFactCheckClaim,
  GoogleFactCheckClient,
  JEVAtomicJudgmentRequest,
  JEVAtomicJudgmentResult,
  JEVClient,
  LLMProvider,
  SearchProvider,
  getFetchProvider,
  getGoogleFactCheckClient,
  getJEVClient,
  getLLMProvider,
  getSearchProvider,
} from "@/lib/providers";

export interface FactPipelineOptions {
  llm?: LLMProvider;
  factCheck?: GoogleFactCheckClient;
  jev?: JEVClient;
  search?: SearchProvider;
  fetch?: FetchProvider;
  onProgress?: (progress: {
    stage: "EXTRACTING" | "FACTCHECK_DB" | "WEB_SEARCH" | "SYNTHESIZING";
    percent: number;
    message: string;
    claimsCount?: number;
    factHits?: number;
  }) => void;
  /** Where the time comes from. A test hands in a clock it moves itself. */
  clock?: Clock;
  /** The run's time budget (time-budget.ts); by default one that starts now. */
  budget?: TimeBudget;
  /** JEV's limits, when a test narrows them; by default the official ones. */
  jevLimits?: Partial<JevLimits>;
}

export interface FactPipelineOutput {
  claims: ClaimResult[];
  evidences: Evidence[];
  /** How long each stage took, with the JEV requests it sent (ADR-0021). Observability only. */
  timings: StageTiming[];
}

/** How many ways of asking the web about the whole text, before any claim. */
const QUERIES_PER_DOCUMENT = 6;

/**
 * How many pages each of those asks for. The pool is shared by every claim,
 * so this is the whole run's reading list; too short a list and the page one
 * sentence needs never gets found.
 */
const RESULTS_PER_QUERY = 7;

/** What the fact-check lookup found for one claim, or why it could not be made. */
type FactCheckOutcome =
  | { ok: true; evidences: Evidence[]; isFactCheckHit: boolean; verdict: ClaimVerdict; reason?: string }
  | { ok: false; error: unknown };

/**
 * Execute Fact Verification Pipeline (Sections 7-17 of specification)
 */
export async function runFactPipeline(
  text: string,
  options?: FactPipelineOptions
): Promise<FactPipelineOutput> {
  const llm = options?.llm ?? getLLMProvider();
  const factCheck = options?.factCheck ?? getGoogleFactCheckClient();
  const jev = options?.jev ?? getJEVClient();
  const search = options?.search ?? getSearchProvider();
  const fetchProvider = options?.fetch ?? getFetchProvider();
  const onProgress = options?.onProgress;

  // The clock the whole run keeps to (ADR-0021). Every JEV request goes
  // through the one dispatcher, which holds JEV's limits and the budget.
  const clock = options?.budget?.clock ?? options?.clock ?? systemClock;
  const budget = options?.budget ?? createTimeBudget(clock);
  const timer = new StageTimer(clock, budget.startedAt);
  const dispatcher = new JevDispatcher(
    jev,
    clock,
    { ...DEFAULT_JEV_LIMITS, ...options?.jevLimits },
    budget.settings.attemptTimeoutMs,
    budget.settings.minAttemptMs
  );
  const timings = () =>
    timer.timings({
      factCheck: dispatcher.countsFor("factCheck"),
      relevanceJudging: dispatcher.countsFor("relevanceJudging"),
      supportJudging: dispatcher.countsFor("supportJudging"),
    });

  // 1. Extract Claims
  onProgress?.({
    stage: "EXTRACTING",
    percent: 10,
    message: "主張（Claim）の抽出中...",
  });

  // The article's own queries need only the text, so they are written while
  // the claims are being extracted rather than after.
  const documentQueriesPending = timer.time("queryGeneration", () => writeDocumentQueries(llm, text));

  // No stand-in: a generation that failed is the run failing, said out loud.
  const extractedClaims: Claim[] = await timer.time("extraction", () => llm.extractClaims(text));

  onProgress?.({
    stage: "FACTCHECK_DB",
    percent: 25,
    message: `主張 ${extractedClaims.length} 件の検証を開始`,
    claimsCount: extractedClaims.length,
  });

  // The fact-check lookups need only the claims, so they run while the
  // searches are written and made.
  const factWindow: DispatchWindow = {
    stage: "factCheck",
    startBy: budget.relevanceStopAt,
    finishBy: budget.relevanceEndAt,
  };
  const judge = judgeThrough(dispatcher, jev, factWindow);
  const factChecksPending = timer.time("factCheck", () =>
    Promise.all(
      extractedClaims.map((claim) =>
        lookUpFactChecks(claim, factCheck, judge).catch(
          (error): FactCheckOutcome => ({ ok: false, error })
        )
      )
    )
  );

  // One pool of pages for the whole run. Every claim's own searches and the
  // article's searches all fill it, and every claim picks from all of it.
  const pool = createSourcePool({
    search,
    fetchProvider,
    resultsPerQuery: RESULTS_PER_QUERY,
    timer,
  });

  // The article's searches start as soon as their queries exist, while the
  // claims' questions are still being written.
  const { queries: documentQueries, violations: documentViolations } = await documentQueriesPending;
  const documentSeeded = documentQueries.length > 0 ? pool.seed(documentQueries) : Promise.resolve();

  // For every claim, the questions that would settle it, primary source first
  // (ADR-0015), naming only what it is about and what is to be found out
  // (ADR-0019). One generation for all claims; all their searches at once.
  const {
    queries: claimQueries,
    violations: claimViolations,
    aspects,
  } = await timer.time("queryGeneration", () => writeClaimQueries(llm, extractedClaims));
  await Promise.all([
    documentSeeded,
    pool.seed(extractedClaims.flatMap((claim) => claimQueries.get(claim.id) ?? [])),
  ]);
  const factChecks = await factChecksPending;

  // 2. The sources (north star ③, ADR-0021): every page of the pool is a
  //    candidate, JEV judges which sections speak to each claim's point, in
  //    a fixed order and by the clock, and the 信頼度 question is asked with
  //    those sections. A claim whose fact-check lookup failed is not asked:
  //    it is reported as the failure it is.
  const checkable = extractedClaims.filter((_, i) => factChecks[i].ok);
  let selections = new Map<string, ClaimSelection>();
  let selectionError: unknown;
  try {
    selections = await selectSources({
      claims: checkable,
      pages: pool.candidatesFor([]),
      searches: pool.searches(),
      own: claimQueries,
      article: documentQueries,
      aspects,
      factChecks: new Map(
        extractedClaims.map((claim, i) => {
          const outcome = factChecks[i];
          return [claim.id, outcome.ok ? outcome.evidences : []];
        })
      ),
      jev,
      dispatcher,
      budget,
      timer,
    });
  } catch (err) {
    // A fault in the selection itself (JEV cannot be asked at all, say):
    // every claim is reported unverified with it, none is given a number.
    console.warn("The sources could not be selected:", err);
    selectionError = err;
  }

  // What the reader is told about is the web search: the fact-check lookup
  // failing on its own leaves the pages to ask with.
  const searchFailed = pool.searchFailed() && pool.size() === 0;

  const claimResults: ClaimResult[] = [];
  const allEvidences: Evidence[] = [];
  let factHitsCount = 0;

  extractedClaims.forEach((claim, i) => {
    const fact = factChecks[i];
    const queries = [...(claimQueries.get(claim.id) ?? []), ...documentQueries];
    const selection = selections.get(claim.id);
    const failure = !fact.ok
      ? describeFailure(fact.error)
      : selectionError !== undefined
      ? describeFailure(selectionError)
      : selection?.failure ?? (selection ? undefined : "資料の選別の結果がありません");

    if (failure !== undefined || !fact.ok || !selection) {
      // ADR-0003: one claim that could not be checked leaves that claim
      // unverified; it does not throw away the others. Nothing is invented
      // in its place, and the failure is reported — on the claim and in the
      // run's service report — rather than passed off as a check.
      console.warn(`Claim ${claim.id} could not be checked: ${failure}`);
      claimResults.push({
        claim,
        verdict: "INSUFFICIENT",
        reason: `この主張の検証中に問題が起きたため、確認できませんでした（${failure}）。`,
        evidence: [],
        // No judgement was made, so there is no number to show. An invented
        // one would be the very thing this product exists to replace.
        confidence: undefined,
        lookupFailed: true,
        ...(selection ? { evidenceTrace: { query: queries.join(" / "), ...selection.trace } } : {}),
      });
      return;
    }

    if (fact.isFactCheckHit) factHitsCount++;
    // No verdict is drawn from the pages: the screen shows the 信頼度 and
    // nothing else (ADR-0009, ADR-0011).
    const verdict: ClaimVerdict = fact.isFactCheckHit ? fact.verdict : "INSUFFICIENT";
    const reason = fact.isFactCheckHit
      ? fact.reason
      : searchFailed
      ? "外部の確認サービスに接続できなかったため、渡せた資料だけで問いました。"
      : undefined;

    claimResults.push({
      claim,
      verdict,
      reason,
      evidence: selection.evidence,
      confidence: selection.confidence,
      lookupFailed: searchFailed,
      evidenceTrace: { query: queries.join(" / "), ...selection.trace },
    });
    allEvidences.push(...selection.evidence);
  });

  // A search written against the rules stays on the record of every claim it
  // was written for, as it was written (ADR-0019): the claim's own, and the
  // article's, which every claim searched with.
  for (const result of claimResults) {
    const broken = [...(claimViolations.get(result.claim.id) ?? []), ...documentViolations];
    if (broken.length > 0 && result.evidenceTrace) result.evidenceTrace.queryViolations = broken;
  }

  onProgress?.({
    stage: "SYNTHESIZING",
    percent: 50,
    message: `ファクト台帳の構築完了 (一致情報: ${factHitsCount}件)`,
    claimsCount: extractedClaims.length,
    factHits: factHitsCount,
  });

  return {
    claims: claimResults,
    evidences: allEvidences,
    timings: timings(),
  };
}

/**
 * JEV's atomic judgments for the fact-check lookup, sent through the run's
 * dispatcher like every other JEV request. No answer is a failure, thrown.
 */
function judgeThrough(
  dispatcher: JevDispatcher,
  jev: JEVClient,
  window: DispatchWindow
): (request: JEVAtomicJudgmentRequest) => Promise<JEVAtomicJudgmentResult> {
  return async (request) => {
    const outcome = await dispatcher.send(estimateTokens(JSON.stringify(request)), window, (timeoutMs) =>
      jev.evaluateAtomicJudgment({ ...request, timeoutMs })
    );
    if (outcome.status === "answered") return outcome.value;
    if (outcome.status === "not-started") {
      throw new Error("時間切れ: ファクトチェックとの照合をJEVに送れませんでした");
    }
    throw outcome.error;
  };
}

/**
 * Step 2 of the specification: the Google Fact Check Tools lookup for one
 * claim, and JEV's judgment of whether a hit is about the same thing. A hit
 * becomes a candidate page for this claim alone (ADR-0021).
 */
async function lookUpFactChecks(
  claim: Claim,
  factCheck: GoogleFactCheckClient,
  judge: (request: JEVAtomicJudgmentRequest) => Promise<JEVAtomicJudgmentResult>
): Promise<FactCheckOutcome> {
  const evidences: Evidence[] = [];
  let verdict: ClaimVerdict = "INSUFFICIENT";
  let reason: string | undefined;
  let isFactCheckHit = false;

  const query = buildFactCheckQuery(claim);
  let factHits: GoogleFactCheckClaim[] = [];

  try {
    if (typeof (factCheck as any).search === "function") {
      factHits = await (factCheck as any).search(query);
    } else if (typeof factCheck.searchClaims === "function") {
      const res = await factCheck.searchClaims(query);
      factHits = res.claims || [];
    }
  } catch (err) {
    // ADR-0003: the lookup failed, so the claim stays unverified and the run
    // carries on to the web search. Nothing is filled in for it.
    console.warn(`Fact check lookup failed for claim ${claim.id}:`, err);
  }

  for (const hit of factHits ?? []) {
    const hitClaimText = hit.text || (hit as any).claim || "";

    // JEV Atomic Judgment: claim matching
    const matchResult = await judge({
      state: { claimA: claim.normalizedText || claim.originalText, claimB: hitClaimText },
      instructions: "主張Aと主張Bは同じ対象・事象についての事実主張ですか？",
      criteria: ["same", "close_but_different", "different"],
    });

    const isMatch =
      matchResult.choice === "same" ||
      (matchResult.choice === "close_but_different" && (matchResult.confidence ?? 0) >= 0.7);
    if (!isMatch) continue;

    isFactCheckHit = true;
    const reviews = hit.claimReview || [];

    for (let i = 0; i < reviews.length; i++) {
      const review = reviews[i];
      const ratingText = review.textualRating || "";

      // Rating normalization via JEV or textual rating keywords
      const isFalse = /not true|false|不正確|誤り|unverified|incorrect|misleading|誤|嘘/i.test(ratingText);
      const isTrue = /^true$|正しい|事実|^verified$|^correct$/i.test(ratingText);

      if (isFalse) {
        verdict = "CONTRADICTED";
        reason = `FactCheck評価: ${ratingText} (${review.publisher?.name || "検証機関"})`;
      } else if (isTrue) {
        verdict = "SUPPORTED";
        reason = `FactCheck評価: ${ratingText} (${review.publisher?.name || "検証機関"})`;
      } else {
        const normResult = await judge({
          state: { rating: ratingText },
          instructions: "この検証判定は主張を肯定していますか、否定していますか？",
          criteria: ["supports", "contradicts", "mixed", "insufficient"],
        });
        verdict = mapChoiceToClaimVerdict(normResult.choice);
        reason = normResult.explanation || `FactCheck評価: ${ratingText}`;
      }

      evidences.push({
        id: `ev-${claim.id}-fc-${i}`,
        claimId: claim.id,
        sourceUrl: review.url,
        sourceTitle: review.title || hitClaimText,
        publisher: review.publisher?.name || "Fact Check Organization",
        publishedAt: review.reviewDate || hit.claimDate,
        excerpt: `[FactCheck: ${review.textualRating}] ${review.title || hitClaimText}`,
        sourceType: "official",
      });
    }

    break; // Matched primary fact check hit
  }

  return { ok: true, evidences, isFactCheckHit, verdict, reason };
}

/**
 * The article's queries, held to the rules (ADR-0019), or none when they
 * could not be written.
 */
async function writeDocumentQueries(llm: LLMProvider, text: string): Promise<CheckedQueries> {
  if (typeof llm.generateDocumentQueries !== "function") return { queries: [], violations: [] };
  try {
    const checked = checkDocumentQueries(await llm.generateDocumentQueries(text), QUERIES_PER_DOCUMENT);
    reportViolations("The article", checked.violations);
    return checked;
  } catch (err) {
    console.warn("Document-level search queries could not be written:", err);
    return { queries: [], violations: [] };
  }
}

/**
 * Each claim's questions, held to the rules (ADR-0019), and the record of
 * those that broke them, by claim id; and what the generation wrote each
 * claim is about and the kind of fact it states, which ③ asks about
 * (ADR-0021). When they could not be written the claims are still checked,
 * against the pages the article's queries found; the claim's sentence is
 * never searched in their place.
 */
async function writeClaimQueries(
  llm: LLMProvider,
  claims: Claim[]
): Promise<{
  queries: Map<string, string[]>;
  violations: Map<string, CheckedQueries["violations"]>;
  aspects: Map<string, ClaimAspect>;
}> {
  const queries = new Map<string, string[]>();
  const violations = new Map<string, CheckedQueries["violations"]>();
  const aspects = new Map<string, ClaimAspect>();
  if (claims.length === 0 || typeof llm.generateClaimQueries !== "function") {
    return { queries, violations, aspects };
  }
  try {
    const written = await llm.generateClaimQueries(claims);
    for (const claim of claims) {
      const plan = written.get(claim.id);
      const checked = checkClaimQueries(claim, plan ?? []);
      queries.set(claim.id, checked.queries);
      violations.set(claim.id, checked.violations);
      if (plan && !Array.isArray(plan)) aspects.set(claim.id, { about: plan.about, kind: plan.kind });
      reportViolations(`Claim ${claim.id}`, checked.violations);
    }
    return { queries, violations, aspects };
  } catch (err) {
    console.warn("Search questions for the claims could not be written:", err);
    return { queries: new Map(), violations: new Map(), aspects: new Map() };
  }
}

/** A search written against the rules is said out loud, not dropped without a word (ADR-0019). */
function reportViolations(whose: string, violations: CheckedQueries["violations"]): void {
  for (const violation of violations) {
    const done = violation.searched ? `searched as "${violation.searched}"` : "not searched";
    console.warn(
      `${whose}: the search "${violation.query}" broke the rules (${violation.broke.join(", ")}; ADR-0019) and was ${done}.`
    );
  }
}

function buildFactCheckQuery(claim: Claim): string {
  const parts: string[] = [];
  if (claim.entities && claim.entities.length > 0) {
    parts.push(claim.entities[0]);
  }
  if (claim.dates && claim.dates.length > 0) {
    parts.push(claim.dates[0]);
  }
  if (parts.length === 0) {
    return claim.normalizedText.slice(0, 50);
  }
  return parts.join(" ");
}


function mapChoiceToClaimVerdict(choice?: string): ClaimVerdict {
  switch (choice) {
    case "supports":
      return "SUPPORTED";
    case "contradicts":
      return "CONTRADICTED";
    case "mixed":
      return "MIXED";
    default:
      return "INSUFFICIENT";
  }
}
