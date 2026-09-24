import { PooledSource, createSourcePool } from "./source-pool";
import { TIME_UP, TimeBudget, createTimeBudget } from "./time-budget";
import { Section, estimateTokens, planSupportRequests } from "./support-question";
import { JevDispatcher } from "./jev-dispatcher";
import { ClaimAspect } from "./relevance-question";
import { Ask, ClaimMaterial, judgeRelevance, relatedSections } from "./source-selection";
import { describeFailure } from "@/lib/providers/diagnostics";
import {
  CheckedQueries,
  checkClaimQueries,
  checkDocumentQueries,
} from "@/lib/providers/llm/search-queries";
import {
  Claim,
  ClaimResult,
  EvidenceTrace,
  ClaimVerdict,
  Evidence,
  SourceType,
} from "@/types";
import {
  FetchProvider,
  GoogleFactCheckClaim,
  GoogleFactCheckClient,
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
  /**
   * The run's time (ADR-0021): every call to an outside service keeps to its
   * stage's cut-off. Without one, a budget starting now.
   */
  budget?: TimeBudget;
  onProgress?: (progress: {
    stage: "EXTRACTING" | "FACTCHECK_DB" | "WEB_SEARCH" | "SYNTHESIZING";
    percent: number;
    message: string;
    claimsCount?: number;
    factHits?: number;
  }) => void;
}

export interface FactPipelineOutput {
  claims: ClaimResult[];
  evidences: Evidence[];
}

/** How many ways of asking the web about the whole text, before any claim. */
const QUERIES_PER_DOCUMENT = 6;

/**
 * How many pages each of those asks for. The pool is shared by every claim,
 * so this is the whole run's reading list; too short a list and the page one
 * sentence needs never gets found.
 */
const RESULTS_PER_QUERY = 7;

/** What one claim's own lookup in the fact-check database found. */
type FactCheckLookup = {
  reviews: Evidence[];
  verdict: ClaimVerdict;
  reason?: string;
  isFactCheckHit: boolean;
};

type ClaimOutcome = {
  claimResult: ClaimResult;
  evidences: Evidence[];
  isFactCheckHit: boolean;
};

/**
 * Execute Fact Verification Pipeline (Sections 7-17 of specification)
 */
export async function runFactPipeline(
  text: string,
  options?: FactPipelineOptions
): Promise<FactPipelineOutput> {
  if (options?.budget) return checkText(text, options, options.budget);
  // A run's time made here is this run's to end (ADR-0021).
  const budget = createTimeBudget();
  try {
    return await checkText(text, options, budget);
  } finally {
    budget.dispose();
  }
}

async function checkText(
  text: string,
  options: FactPipelineOptions | undefined,
  budget: TimeBudget
): Promise<FactPipelineOutput> {
  const llm = options?.llm ?? getLLMProvider();
  const factCheck = options?.factCheck ?? getGoogleFactCheckClient();
  const jev = options?.jev ?? getJEVClient();
  const search = options?.search ?? getSearchProvider();
  const fetchProvider = options?.fetch ?? getFetchProvider();
  const onProgress = options?.onProgress;

  // 1. Extract Claims
  onProgress?.({
    stage: "EXTRACTING",
    percent: 10,
    message: "主張（Claim）の抽出中...",
  });

  // The article's own queries need only the text, so they are written while
  // the claims are being extracted rather than after.
  const documentQueriesPending = writeDocumentQueries(llm, text, budget);

  // No stand-in: a generation that failed is the run failing, said out loud.
  // One that the clock stopped leaves no claims to check: the run returns
  // with none, and the budget says the extraction was cut short (ADR-0021).
  const extraction = await budget.within("extraction", (signal) =>
    llm.extractClaims(text, { signal })
  );
  if (extraction.status !== "done") {
    console.warn(
      `${TIME_UP}（ADR-0021）: 主張の取り出しが締め切り（開始から ${budget.cutoffAt("extraction") - budget.startedAt} ms）までに終わらなかったため、どの文も確かめていない。`
    );
    return { claims: [], evidences: [] };
  }
  const extractedClaims: Claim[] = extraction.value;

  onProgress?.({
    stage: "FACTCHECK_DB",
    percent: 25,
    message: `主張 ${extractedClaims.length} 件の検証を開始`,
    claimsCount: extractedClaims.length,
  });

  // One pool of pages for the whole run. Every claim's own searches and the
  // article's searches all fill it, and every claim picks from all of it.
  const pool = createSourcePool({
    search,
    fetchProvider,
    resultsPerQuery: RESULTS_PER_QUERY,
    budget,
  });

  // The article's searches start as soon as their queries exist, while the
  // claims' questions are still being written.
  const { queries: documentQueries, violations: documentViolations } = await documentQueriesPending;
  const documentSeeded = documentQueries.length > 0 ? pool.seed(documentQueries) : Promise.resolve();

  // For every claim, the questions that would settle it, primary source first
  // (ADR-0015), naming only what it is about and what is to be found out
  // (ADR-0019). One generation for all claims; all their searches at once.
  // What ② named each claim to be about, and the kind of fact, is kept too:
  // it is the aspect ③ asks JEV about (ADR-0022).
  const {
    queries: claimQueries,
    violations: claimViolations,
    aspects,
  } = await writeClaimQueries(llm, extractedClaims, budget);
  await Promise.all([
    documentSeeded,
    pool.seed(extractedClaims.flatMap((claim) => claimQueries.get(claim.id) ?? [])),
  ]);

  // Step 2: each claim's own lookup in the fact-check database, all at once.
  // A lookup that throws leaves its claim, and only its claim, unverified.
  const lookups = await Promise.all(
    extractedClaims.map((claim) =>
      lookUpFactChecks({ claim, factCheck, jev, budget }).then(
        (found): { found: FactCheckLookup } => ({ found }),
        (error: unknown): { error: unknown } => ({ error })
      )
    )
  );

  // Step 3 (③, ADR-0022): every page of the pool is a candidate for every
  // claim; JEV judges every candidate section against each claim's aspect,
  // in a fixed order, as fast as its limits allow, until the relevance
  // cut-off. The searches made with a claim in mind come first in its order:
  // its own, then the article's.
  const queriesOf = (claim: Claim) => [...(claimQueries.get(claim.id) ?? []), ...documentQueries];
  const pooledFor = new Map(extractedClaims.map((claim) => [claim.id, pool.candidatesFor(queriesOf(claim))]));
  const ask: Ask | undefined = typeof jev.ask === "function" ? jev.ask.bind(jev) : undefined;
  // Every JEV request of the run from here on goes through one dispatcher,
  // which keeps to JEV's published limits (jev-dispatcher.ts).
  const dispatcher = new JevDispatcher(budget);
  const judgedClaims = extractedClaims.filter((_, c) => "found" in lookups[c]);
  let materials: Map<string, ClaimMaterial> | undefined;
  // Should the selection itself fail, every claim is left unverified with
  // that failure, said so (ADR-0003); the run still returns.
  let selectionFailure: { error: unknown } | undefined;
  if (ask) {
    try {
      materials = await judgeRelevance({
        claims: judgedClaims,
        pool: pool.candidatesFor([]),
        ranked: pooledFor,
        reviews: new Map(
          extractedClaims.map((claim, c) => {
            const lookup = lookups[c];
            return [claim.id, "found" in lookup ? lookup.found.reviews : []];
          })
        ),
        aspects,
        ask,
        dispatcher,
      });
    } catch (error) {
      selectionFailure = { error };
    }
  }

  // Step 4: the 信頼度 question for every claim (ADR-0011), claim by claim in
  // the article's order, each claim's requests together: if the time runs
  // out, as many claims as possible have every answer they need.
  const resolved = await Promise.all(
    extractedClaims.map(async (claim, c): Promise<ClaimOutcome> => {
      try {
        const lookup = lookups[c];
        if ("error" in lookup) throw lookup.error;
        if (selectionFailure) throw selectionFailure.error;
        const material = materials?.get(claim.id);
        if (!ask || !material) {
          throw new Error("JEVに問いを送る手段がありません（ask が未実装）。");
        }
        return await concludeClaim({
          claim,
          queries: queriesOf(claim),
          pooled: pooledFor.get(claim.id) ?? [],
          lookup: lookup.found,
          material,
          searchFailed: pool.searchFailed(),
          ask,
          dispatcher,
        });
      } catch (err) {
        // ADR-0003: one claim that could not be checked leaves that claim
        // unverified; it does not throw away the other twenty. Nothing is
        // invented in its place, and the failure is reported — on the claim
        // and in the run's service report — rather than passed off as a check.
        console.warn(`Claim ${claim.id} could not be checked:`, err);
        const reason = `この主張の検証中に問題が起きたため、確認できませんでした（${describeFailure(err)}）。`;

        return {
          claimResult: {
            claim,
            verdict: "INSUFFICIENT" as ClaimVerdict,
            reason,
            evidence: [],
            // No judgement was made, so there is no number to show. An invented
            // one would be the very thing this product exists to replace.
            confidence: undefined,
            lookupFailed: true,
          },
          evidences: [],
          isFactCheckHit: false,
        };
      }
    })
  );

  const claimResults: ClaimResult[] = [];
  const allEvidences: Evidence[] = [];
  let factHitsCount = 0;
  for (const item of resolved) {
    claimResults.push(item.claimResult);
    allEvidences.push(...item.evidences);
    if (item.isFactCheckHit) {
      factHitsCount++;
    }
  }

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
  };
}

/**
 * One claim's lookup in the fact-check database (Google Fact Check Tools).
 * A match is decided by JEV. The reviews it finds are this claim's own
 * candidates. A lookup the service could not make leaves the claim to the
 * web's pages, and says so; one the clock stopped is left out (時間切れ,
 * counted by the budget).
 */
async function lookUpFactChecks(params: {
  claim: Claim;
  factCheck: GoogleFactCheckClient;
  jev: JEVClient;
  budget: TimeBudget;
}): Promise<FactCheckLookup> {
  const { claim, factCheck, jev, budget } = params;
  const reviews: Evidence[] = [];
  let verdict: ClaimVerdict = "INSUFFICIENT";
  let reason: string | undefined;
  let isFactCheckHit = false;

  const query = buildFactCheckQuery(claim);
  let factHits: GoogleFactCheckClaim[] = [];

  const lookUp: ((signal: AbortSignal) => Promise<GoogleFactCheckClaim[]>) | undefined =
    typeof (factCheck as any).search === "function"
      ? (signal) => (factCheck as any).search(query, undefined, { signal })
      : typeof factCheck.searchClaims === "function"
      ? async (signal) => (await factCheck.searchClaims(query, undefined, { signal })).claims || []
      : undefined;

  try {
    // Not looked up by the fact-check cut-off (時間切れ, counted by the
    // budget): the claim goes on without it, as with no hits.
    const lookup = lookUp ? await budget.within("factCheck", lookUp) : undefined;
    if (lookup?.status === "done") factHits = lookup.value;
  } catch (err) {
    // ADR-0003: the lookup failed, so the claim stays unverified by it and
    // the run carries on to the web's pages. Nothing is filled in for it.
    console.warn(`Fact check lookup failed for claim ${claim.id}:`, err);
  }

  for (const hit of factHits ?? []) {
    const hitClaimText = hit.text || (hit as any).claim || "";

    // JEV Atomic Judgment: claim matching. The hits not matched by the
    // cut-off are left unmatched (時間切れ, counted by the budget).
    const matched = await budget.within(
      "factCheck",
      (signal) =>
        jev.evaluateAtomicJudgment(
          {
            state: { claimA: claim.normalizedText || claim.originalText, claimB: hitClaimText },
            instructions: "主張Aと主張Bは同じ対象・事象についての事実主張ですか？",
            criteria: ["same", "close_but_different", "different"],
          },
          { signal }
        ),
      { jev: true }
    );
    if (matched.status !== "done") break;
    const matchResult = matched.value;

    const isMatch =
      matchResult.choice === "same" ||
      (matchResult.choice === "close_but_different" && (matchResult.confidence ?? 0) >= 0.7);
    if (!isMatch) continue;

    isFactCheckHit = true;
    const claimReviews = hit.claimReview || [];
    for (let i = 0; i < claimReviews.length; i++) {
      const review = claimReviews[i];
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
        const normalized = await budget.within(
          "factCheck",
          (signal) =>
            jev.evaluateAtomicJudgment(
              {
                state: { rating: ratingText },
                instructions: "この検証判定は主張を肯定していますか、否定していますか？",
                criteria: ["supports", "contradicts", "mixed", "insufficient"],
              },
              { signal }
            ),
          { jev: true }
        );
        if (normalized.status === "done") {
          verdict = mapChoiceToClaimVerdict(normalized.value.choice);
          reason = normalized.value.explanation || `FactCheck評価: ${ratingText}`;
        } else {
          // Not read by the cut-off (時間切れ): the rating is kept as written.
          reason = `FactCheck評価: ${ratingText}`;
        }
      }

      reviews.push({
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

  return { reviews, verdict, reason, isFactCheckHit };
}

/**
 * One claim, once JEV has judged its candidates (ADR-0022): the 信頼度
 * question on the sections it judged related, the grounds for the bubble,
 * and the trace of where every candidate went.
 *
 * Its 信頼度 requests are handed to the dispatcher before anything is
 * awaited, so the claims' requests queue claim by claim.
 */
async function concludeClaim(params: {
  claim: Claim;
  /** The searches that were made with this claim in mind: its own, then the article's. */
  queries: string[];
  /** Every page of the pool, in this claim's order. */
  pooled: PooledSource[];
  lookup: FactCheckLookup;
  material: ClaimMaterial;
  searchFailed: boolean;
  ask: Ask;
  dispatcher: JevDispatcher;
}): Promise<ClaimOutcome> {
  const { claim, queries, pooled, lookup, material, ask, dispatcher } = params;
  const readable = pooled.filter((page) => page.text.trim().length > 0);

  // Where this claim's evidence went. "Nothing found" has several causes and
  // they look identical on screen unless they are counted apart (ADR-0006).
  const judged = material.sections.filter((section) => section.outcome === "judged");
  const related = relatedSections(material);
  const trace: EvidenceTrace = {
    query: queries.join(" / "),
    found: pooled.length,
    offSubject: 0,
    unreadable: pooled.length - readable.length,
    saidNothing: 0,
    weak: 0,
    used: 0,
    // No cap stands before JEV (ADR-0022): 0 unless a candidate could not
    // be put to JEV at all.
    overCap: material.overCap,
    origins: 0,
    ...(material.aspect !== undefined ? { aspect: material.aspect } : {}),
    sections: { candidates: material.sections.length, judged: judged.length, related: related.length },
  };
  if (material.unjudged) {
    trace.unjudged = material.unjudged;
    console.warn(
      `Claim ${claim.id}: ${TIME_UP} — ${material.unjudged.sections} of ${material.sections.length} sections, on ${material.unjudged.urls.length} pages, were not judged for relevance by the cut-off (ADR-0021): ${material.unjudged.urls.join(" ")}`
    );
  }
  if (material.unanswered) {
    trace.unanswered = material.unanswered;
    console.warn(
      `Claim ${claim.id}: ${material.unanswered.sections} of ${material.sections.length} sections, on ${material.unanswered.urls.length} pages, were not judged: ${material.unanswered.reason} (ADR-0022): ${material.unanswered.urls.join(" ")}`
    );
  }
  // What the reader is told about is the web search: the fact-check lookup
  // failing on its own leaves the pages to ask with.
  const lookupFailed = params.searchFailed && pooled.length === 0;

  // The 信頼度 question, as worded before (ADR-0011), with the sections JEV
  // judged related as the sources, in the fixed order of ADR-0016, grouped by
  // origin and each saying whether it is a primary source. None related: the
  // same question with no sources. A section that says otherwise than the
  // sentence states a fact about the same point, so it is related and goes
  // on: nothing contradicting is dropped here.
  //
  // When nothing at all could be judged it is not asked: sources emptied for
  // want of time would put the question to the clock, not to the pages
  // (ADR-0021), and emptied for want of an answer, to JEV's failure — which
  // leaves the claim unverified, said so, as any failure does (ADR-0003).
  /** Why the time left this claim without a number, in the reader's words. */
  let timedOut: string | undefined;
  let confidence: number | undefined;
  const leftUnjudged = material.unjudged?.sections ?? 0;
  if (judged.length === 0 && material.failure !== undefined) {
    throw material.failure;
  } else if (judged.length === 0 && leftUnjudged > 0) {
    timedOut = `時間内に資料を判定できなかったため、確認できませんでした（${TIME_UP}）。`;
  } else {
    const supportRequests = planSupportRequests({
      original: claim.originalText,
      sections: related.map((section): Section => {
        const page = material.pages[section.page];
        return {
          page: section.page,
          source: section.source,
          origin: page.origin,
          primary: page.primary,
          ...(page.primaryKind !== undefined ? { primaryKind: page.primaryKind } : {}),
        };
      }),
    });
    const supportReplies = await Promise.all(
      supportRequests.map((request) =>
        dispatcher.send(
          "supportJudging",
          estimateTokens(JSON.stringify({ state: request.state, questions: request.questions })),
          (signal) => ask(request.state, request.questions, { signal })
        )
      )
    );

    // The 信頼度 is a number JEV returned, as it returned it (ADR-0008,
    // ADR-0011). When the sections had to be spread over several requests,
    // each answer says whether the sentence is backed by the sections in that
    // request; backed by some of them is backed by them, so the highest of
    // those answers is the one shown. Nothing is averaged or adjusted. With
    // any of those requests unanswered for time, there is no number: the
    // highest of the rest could be lower than the answer that did not come.
    const supportAnswers: number[] = [];
    for (const reply of supportReplies) {
      if (reply.status !== "done") {
        timedOut = `時間内に信頼度の判定が終わらなかったため、確認できませんでした（${TIME_UP}）。`;
        continue;
      }
      const answer = reply.value.support;
      if (answer && answer.type === "noul" && typeof answer.noul === "number") {
        supportAnswers.push(answer.noul);
      }
    }
    confidence = !timedOut && supportAnswers.length > 0 ? Math.max(...supportAnswers) : undefined;
  }
  if (timedOut) {
    console.warn(`Claim ${claim.id}: ${TIME_UP} — no number is shown (ADR-0021): ${timedOut}`);
  }

  // The grounds in the bubble: the pages that hold a section judged related,
  // each with its most related section, in the fixed order.
  const best = new Map<number, { text: string; relevance: number }>();
  for (const section of related) {
    const score = section.relevance ?? 0;
    const previous = best.get(section.page);
    if (!previous || score > previous.relevance) {
      best.set(section.page, { text: section.source.text, relevance: score });
    }
  }
  // Pages with sections left unjudged (time, or JEV's failure) did not say
  // nothing: they are counted under `unjudged` and `unanswered` instead.
  const notHeardOut = new Set(
    material.sections.filter((section) => section.outcome !== "judged").map((section) => section.page)
  );

  const evidences: Evidence[] = [];
  const usedOrigins = new Set<string>();
  material.pages.forEach((page, at) => {
    const read = best.get(at);
    if (read) usedOrigins.add(page.origin);
    if (page.review) {
      if (read) evidences.push(page.review);
      return;
    }
    const web = page.web;
    if (!web) return;
    if (!read) {
      if (!notHeardOut.has(at)) trace.saidNothing++;
      return;
    }
    trace.used++;
    evidences.push({
      id: `ev-${claim.id}-web-${at}`,
      claimId: claim.id,
      sourceUrl: web.url,
      sourceTitle: web.title,
      publisher: web.siteName || web.author,
      publishedAt: web.publishedAt,
      excerpt: read.text.slice(0, 350),
      sourceType: mapDomainToSourceType(web.url),
      confidence: read.relevance,
    });
  });
  trace.origins = usedOrigins.size;

  // No verdict is drawn from the pages: the screen shows the 信頼度 and
  // nothing else (ADR-0009, ADR-0011).
  let verdict = lookup.verdict;
  let reason = lookup.reason;
  if (!lookup.isFactCheckHit) {
    verdict = "INSUFFICIENT";
    reason = lookupFailed
      ? "外部の確認サービスに接続できなかったため、渡せた資料だけで問いました。"
      : undefined;
  }
  // No number for want of time: the claim stays, said to be unconfirmed and
  // why, as a claim that could not be checked is (ADR-0021, ADR-0008).
  if (timedOut) reason = timedOut;

  return {
    claimResult: {
      claim,
      verdict,
      reason,
      evidence: evidences,
      confidence,
      lookupFailed,
      evidenceTrace: trace,
    },
    evidences,
    isFactCheckHit: lookup.isFactCheckHit,
  };
}

/**
 * The article's queries, held to the rules (ADR-0019), or none when they
 * could not be written, by the query-generation cut-off among other things.
 */
async function writeDocumentQueries(
  llm: LLMProvider,
  text: string,
  budget: TimeBudget
): Promise<CheckedQueries> {
  if (typeof llm.generateDocumentQueries !== "function") return { queries: [], violations: [] };
  const generate = llm.generateDocumentQueries.bind(llm);
  try {
    const written = await budget.within("queryGeneration", (signal) => generate(text, { signal }));
    if (written.status !== "done") {
      console.warn(
        `${TIME_UP}（ADR-0021）: 記事全体の検索語が締め切りまでに書けなかった。主張ごとの問いで集めた資料だけで確かめる。`
      );
      return { queries: [], violations: [] };
    }
    const checked = checkDocumentQueries(written.value, QUERIES_PER_DOCUMENT);
    reportViolations("The article", checked.violations);
    return checked;
  } catch (err) {
    console.warn("Document-level search queries could not be written:", err);
    return { queries: [], violations: [] };
  }
}

/**
 * Each claim's questions, held to the rules (ADR-0019), and the record of
 * those that broke them, by claim id. When they could not be written the
 * claims are still checked, against the pages the article's queries found;
 * the claim's sentence is never searched in their place. Not written by the
 * query-generation cut-off is the same (ADR-0021).
 *
 * With them, what the generation named each claim to be about and the kind
 * of fact it states (ADR-0019), as written: the aspect the relevance
 * question asks about (ADR-0022). Nothing of the queries depends on it.
 */
async function writeClaimQueries(
  llm: LLMProvider,
  claims: Claim[],
  budget: TimeBudget
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
  const generate = llm.generateClaimQueries.bind(llm);
  try {
    const outcome = await budget.within("queryGeneration", (signal) => generate(claims, { signal }));
    if (outcome.status !== "done") {
      console.warn(
        `${TIME_UP}（ADR-0021）: 主張ごとの検索の問いが締め切りまでに書けなかった。記事全体の検索語で集めた資料だけで確かめる。`
      );
      return { queries, violations, aspects };
    }
    const written = outcome.value;
    for (const claim of claims) {
      const plan = written.get(claim.id) ?? [];
      const checked = checkClaimQueries(claim, plan);
      queries.set(claim.id, checked.queries);
      violations.set(claim.id, checked.violations);
      if (!Array.isArray(plan)) aspects.set(claim.id, { about: plan.about, kind: plan.kind });
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

/**
 * What kind of source a URL is, from what can be told about the address
 * itself. A named company's own site cannot be recognised this way without
 * knowing every company, so only the kinds that are recognisable are named.
 */
function mapDomainToSourceType(url: string): SourceType {
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
