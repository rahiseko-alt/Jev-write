import { PooledSource, createSourcePool } from "./source-pool";
import { PAGE_RELEVANCE_THRESHOLD, RELEVANCE_THRESHOLD } from "@/lib/jev/bands";
import { OriginPage, Section, planSupportRequests } from "./support-question";
import {
  Ask,
  Candidate,
  SECTION_STAGE_TOKEN_BUDGET,
  Selection,
  readSections,
  screenPages,
} from "./source-selection";
import { originsOf } from "./source-origin";
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

  // 1. Extract Claims
  onProgress?.({
    stage: "EXTRACTING",
    percent: 10,
    message: "主張（Claim）の抽出中...",
  });

  // The article's own queries need only the text, so they are written while
  // the claims are being extracted rather than after.
  const documentQueriesPending = writeDocumentQueries(llm, text);

  // No stand-in: a generation that failed is the run failing, said out loud.
  const extractedClaims: Claim[] = await llm.extractClaims(text);

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
  });

  // The article's searches start as soon as their queries exist, while the
  // claims' questions are still being written.
  const { queries: documentQueries, violations: documentViolations } = await documentQueriesPending;
  const documentSeeded = documentQueries.length > 0 ? pool.seed(documentQueries) : Promise.resolve();

  // For every claim, the questions that would settle it, primary source first
  // (ADR-0015), naming only what it is about and what is to be found out
  // (ADR-0019). One generation for all claims; all their searches at once.
  const { queries: claimQueries, violations: claimViolations } = await writeClaimQueries(
    llm,
    extractedClaims
  );
  await Promise.all([
    documentSeeded,
    pool.seed(extractedClaims.flatMap((claim) => claimQueries.get(claim.id) ?? [])),
  ]);

  // The searches that were made with each claim in mind: its own, then the article's.
  const queriesOf = (claim: Claim) => [...(claimQueries.get(claim.id) ?? []), ...documentQueries];

  // The candidates (ADR-0016 step 1, ADR-0018 step 1): every page in the
  // pool, for every claim. Each claim has them in its own order: its own
  // searches first, then the article's, then the rest, each in the order the
  // search ranked them. No score of this side's orders or cuts them.
  const poolPages = pool.candidatesFor([]).filter((page) => page.text.trim().length > 0);
  const webByKey = new Map<string, PooledSource>(poolPages.map((page) => [page.url, page]));
  const pooledFor = extractedClaims.map((claim) => pool.candidatesFor(queriesOf(claim)));
  const sentences = extractedClaims.map((claim) => claim.originalText);

  const ask: Ask | undefined = typeof jev.ask === "function" ? jev.ask.bind(jev) : undefined;

  // Each claim's own lookup in the fact-check database, and the page stage
  // for every page and every claim (ADR-0018 step 2), at the same time. A
  // lookup that fails leaves its claim, and only its claim, unverified.
  const [lookups, screened] = await Promise.all([
    Promise.all(
      extractedClaims.map((claim) =>
        lookUpFactChecks({ claim, factCheck, jev }).then(
          (found): { found: FactCheckLookup } => ({ found }),
          (error: unknown): { error: unknown } => ({ error })
        )
      )
    ),
    ask
      ? screenPages({
          claims: sentences,
          pages: poolPages.map((page) => ({ ...candidateOf(page), excerpts: pool.excerptsOf(page.url) })),
          ask,
        })
      : undefined,
  ]);

  if (screened && (screened.failures.length > 0 || screened.unaskable.length > 0)) {
    // Not screened is not ruled out: those pages go on to the section stage
    // for every claim (ADR-0018 step 3). The failures are JEV's, and the run
    // reports them (ADR-0006, layer 4).
    console.warn(
      `JEV could not screen ${screened.failures.length} page request(s) and ${screened.unaskable.length} page(s) were too large to screen; they go on to the section stage unscreened (ADR-0018).`,
      screened.failures[0]
    );
  }

  // Each claim's own fact-check reviews, as candidates of that claim alone.
  const factByKey = new Map<string, Evidence>();
  const candidates = extractedClaims.map((_, c) => {
    const lookup = lookups[c];
    const own: Candidate[] = ("found" in lookup ? lookup.found.reviews : []).map((review, i) => {
      const key = `factcheck:${c}:${i}`;
      factByKey.set(key, review);
      return { key, title: review.sourceTitle, url: review.sourceUrl, text: review.excerpt };
    });
    const readable = pooledFor[c].filter((page) => page.text.trim().length > 0);
    return { own, pool: readable.map(candidateOf) };
  });

  // The section stage (ADR-0018 steps 3–5): the pages JEV did not rule out
  // for a claim, within the budget, section by section.
  const selections: Selection[] | undefined =
    ask && screened ? await readSections({ claims: sentences, candidates, screened, ask }) : undefined;

  const claimResults: ClaimResult[] = [];
  const allEvidences: Evidence[] = [];
  let factHitsCount = 0;

  // The 信頼度 question for every claim, in parallel.
  const resolved = await Promise.all(
    extractedClaims.map(async (claim, c) => {
      try {
        const lookup = lookups[c];
        if ("error" in lookup) throw lookup.error;
        if (!ask || !selections) {
          throw new Error("JEVに問いを送る手段がありません（ask が未実装）。");
        }
        return await concludeClaim({
          claim,
          queries: queriesOf(claim),
          pooled: pooledFor[c],
          lookup: lookup.found,
          selection: selections[c],
          searchFailed: pool.searchFailed(),
          webByKey,
          factByKey,
          ask,
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

/** A pool page as a candidate: its address is its key. */
function candidateOf(page: PooledSource): Candidate {
  return { key: page.url, title: page.title, url: page.url, text: page.text };
}

/** 240000 as "240,000", the same on every machine. */
function withCommas(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * One claim's lookup in the fact-check database. A match is decided by JEV;
 * the reviews it finds are this claim's own candidates (ADR-0018: they skip
 * the page stage, having been matched to the claim already).
 */
async function lookUpFactChecks(params: {
  claim: Claim;
  factCheck: GoogleFactCheckClient;
  jev: JEVClient;
}): Promise<FactCheckLookup> {
  const { claim, factCheck, jev } = params;
  const reviews: Evidence[] = [];
  let verdict: ClaimVerdict = "INSUFFICIENT";
  let reason: string | undefined;
  let isFactCheckHit = false;

  // Step 2: Query Google Fact Check Tools API
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
    // ADR-0003: the lookup failed, so the claim stays unverified by it and the
    // run carries on to the web's pages. Nothing is filled in for it.
    console.warn(`Fact check lookup failed for claim ${claim.id}:`, err);
  }

  if (factHits && factHits.length > 0) {
    for (const hit of factHits) {
      const hitClaimText = hit.text || (hit as any).claim || "";

      // JEV Atomic Judgment: claim matching
      const matchResult = await jev.evaluateAtomicJudgment({
        state: { claimA: claim.normalizedText || claim.originalText, claimB: hitClaimText },
        instructions: "主張Aと主張Bは同じ対象・事象についての事実主張ですか？",
        criteria: ["same", "close_but_different", "different"],
      });

      const isMatch =
        matchResult.choice === "same" ||
        (matchResult.choice === "close_but_different" &&
          (matchResult.confidence ?? 0) >= 0.7);

      if (isMatch) {
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
            const normResult = await jev.evaluateAtomicJudgment({
              state: { rating: ratingText },
              instructions: "この検証判定は主張を肯定していますか、否定していますか？",
              criteria: ["supports", "contradicts", "mixed", "insufficient"],
            });
            verdict = mapChoiceToClaimVerdict(normResult.choice);
            reason = normResult.explanation || `FactCheck評価: ${ratingText}`;
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
    }
  }

  return { reviews, verdict, reason, isFactCheckHit };
}

/**
 * One claim, once JEV has said which of its candidates are about what it is
 * about: the 信頼度 question on those sections, the grounds for the bubble,
 * and the trace of where every candidate went.
 */
async function concludeClaim(params: {
  claim: Claim;
  /** The searches that were made with this claim in mind: its own, then the article's. */
  queries: string[];
  /** Every page in the pool, in this claim's order. */
  pooled: PooledSource[];
  lookup: FactCheckLookup;
  selection: Selection;
  searchFailed: boolean;
  webByKey: Map<string, PooledSource>;
  factByKey: Map<string, Evidence>;
  ask: Ask;
}): Promise<{
  claimResult: ClaimResult;
  evidences: Evidence[];
  isFactCheckHit: boolean;
}> {
  const { claim, queries, pooled, lookup, selection, webByKey, factByKey, ask } = params;
  const readable = pooled.filter((page) => page.text.trim().length > 0);

  // Where this claim's candidates went (ADR-0018 step 8). "Nothing found" has
  // several causes and they look identical on screen unless they are counted
  // apart (ADR-0006). Every candidate that does not reach the 信頼度 question
  // is counted here, with the reason: JEV judged it about something else
  // (offSubject), it was over the budget (overCap), or its sections were
  // judged unrelated (saidNothing). None is dropped without saying so.
  const trace: EvidenceTrace = {
    query: queries.join(" / "),
    found: pooled.length,
    offSubject: selection.offTarget.length,
    unreadable: pooled.length - readable.length,
    saidNothing: 0,
    weak: 0,
    used: 0,
    overCap: selection.overCap.length,
    unscreened: selection.unscreened.length,
    origins: 0,
  };
  if (selection.overCap.length > 0) {
    trace.overCapReason = `JEVが段1で主張の対象について述べていると判定したページのうち、段2の上限（1主張あたり見積もり${withCommas(SECTION_STAGE_TOKEN_BUDGET)}トークン）を超えた分。この主張の検索→記事全体の検索→ほかの主張の検索の順、各検索の順位の順で上限まで入れた（ADR-0018）。`;
  }
  console.info(
    `Claim ${claim.id}: ${pooled.length} candidate pages; page stage: ${selection.offTarget.length} about something else (below ${PAGE_RELEVANCE_THRESHOLD}), ${selection.unscreened.length} unscreened; ${selection.overCap.length} over the section-stage budget; ${selection.asked.length} read section by section (ADR-0018).`
  );
  if (selection.overCap.length > 0) {
    console.info(
      `Claim ${claim.id}: over the section-stage budget, in the claim's order (ADR-0018): ${selection.overCap.map((candidate) => candidate.url).join(" ")}`
    );
  }

  // A section-stage question for this claim got no answer (ADR-0018 step 6):
  // its material was not judged, so no 信頼度 is given on it (ADR-0003,
  // ADR-0006).
  if (selection.failure !== undefined) throw selection.failure;

  // What the reader is told about is the web search: the fact-check lookup
  // failing on its own leaves the pages to ask with.
  const lookupFailed = params.searchFailed && pooled.length === 0;

  // Each page that was read section by section gets its origin (one site, or
  // the sites carrying the same text) and whether its address is a primary
  // source's, and the pages go in the fixed order that does not change from
  // run to run: primary sources first, then by origin, then by address
  // (ADR-0016 steps 3–5, ADR-0018 step 7).
  const asked = selection.asked;
  const origins = originsOf(asked.map(({ candidate }) => candidate));
  const pages: OriginPage[] = asked.map(({ candidate }, i) => ({
    title: candidate.title,
    url: candidate.url,
    text: candidate.text,
    ...origins[i],
  }));
  const primaryOrigins = new Set(
    pages.filter((page) => page.primary).map((page) => page.origin ?? page.url)
  );
  const order = asked
    .map((_, i) => i)
    .sort((a, b) => fixedOrder(pages[a], pages[b], primaryOrigins) || a - b);

  // Only the sections JEV judged to be about the claim's target (at or above
  // the section stage's line) go on, in that order (ADR-0018 step 6).
  // Unrelated material costs the next answer accuracy (docs.typesafe.ai/
  // model-jaggedness: large state full of irrelevant detail). A section that
  // says otherwise than the sentence is about the same thing, so it goes on:
  // nothing contradicting is dropped.
  const related: (Section & { relevance: number })[] = [];
  order.forEach((i, at) => {
    const page = pages[i];
    for (const { text, relevance } of asked[i].sections) {
      if (relevance < RELEVANCE_THRESHOLD) continue;
      related.push({
        page: at,
        source: { title: page.title, url: page.url, text },
        origin: page.origin,
        primary: page.primary,
        primaryKind: page.primaryKind,
        relevance,
      });
    }
  });

  // The 信頼度 question, as worded before (ADR-0011), with those sections as
  // the sources, grouped by origin and each saying whether it is a primary
  // source (ADR-0018 step 7). Whether that matters is JEV's to weigh. None
  // related: the same question with no sources.
  const supportRequests = planSupportRequests({
    original: claim.originalText,
    sections: related,
  });
  const supportReplies = await Promise.all(
    supportRequests.map((request) => ask(request.state, request.questions))
  );

  // The 信頼度 is a number JEV returned, as it returned it (ADR-0008,
  // ADR-0011). When the sections had to be spread over several requests,
  // each answer says whether the sentence is backed by the sections in that
  // request; backed by some of them is backed by them, so the highest of
  // those answers is the one shown. Nothing is averaged or adjusted.
  const supportAnswers: number[] = [];
  for (const answers of supportReplies) {
    const answer = answers.support;
    if (answer && answer.type === "noul" && typeof answer.noul === "number") {
      supportAnswers.push(answer.noul);
    }
  }
  const confidence = supportAnswers.length > 0 ? Math.max(...supportAnswers) : undefined;

  // The grounds in the bubble: the pages that hold a section judged related,
  // each with its most related section.
  const best = new Map<number, { text: string; relevance: number }>();
  for (const section of related) {
    const previous = best.get(section.page);
    if (!previous || section.relevance > previous.relevance) {
      best.set(section.page, { text: section.source.text, relevance: section.relevance });
    }
  }

  const evidences: Evidence[] = [];
  const usedOrigins = new Set<string>();
  order.forEach((i, at) => {
    const page = pages[i];
    const key = asked[i].candidate.key;
    const read = best.get(at);
    if (read) usedOrigins.add(page.origin ?? page.url);
    const review = factByKey.get(key);
    if (review) {
      if (read) evidences.push(review);
      return;
    }
    const web = webByKey.get(key);
    if (!web) return;
    if (!read) {
      trace.saidNothing++;
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
  const verdict: ClaimVerdict = lookup.isFactCheckHit ? lookup.verdict : "INSUFFICIENT";
  const reason = lookup.isFactCheckHit
    ? lookup.reason
    : lookupFailed
      ? "外部の確認サービスに接続できなかったため、渡せた資料だけで問いました。"
      : undefined;

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
 * those that broke them, by claim id. When they could not be written the
 * claims are still checked, against the pages the article's queries found;
 * the claim's sentence is never searched in their place.
 */
async function writeClaimQueries(
  llm: LLMProvider,
  claims: Claim[]
): Promise<{ queries: Map<string, string[]>; violations: Map<string, CheckedQueries["violations"]> }> {
  const queries = new Map<string, string[]>();
  const violations = new Map<string, CheckedQueries["violations"]>();
  if (claims.length === 0 || typeof llm.generateClaimQueries !== "function") {
    return { queries, violations };
  }
  try {
    const written = await llm.generateClaimQueries(claims);
    for (const claim of claims) {
      const checked = checkClaimQueries(claim, written.get(claim.id) ?? []);
      queries.set(claim.id, checked.queries);
      violations.set(claim.id, checked.violations);
      reportViolations(`Claim ${claim.id}`, checked.violations);
    }
    return { queries, violations };
  } catch (err) {
    console.warn("Search questions for the claims could not be written:", err);
    return { queries: new Map(), violations: new Map() };
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
 * The fixed order pages go to JEV in (ADR-0016, step 5): origins holding a
 * primary source first, then origin by origin, and within an origin primary
 * pages first, then by address. Strings are compared code unit by code unit
 * so the order is the same on every run and every machine. An origin's pages
 * stay together, so it reaches JEV as one entry. Ties (the same address
 * twice) keep the order they came in, which is itself fixed.
 */
function fixedOrder(a: OriginPage, b: OriginPage, primaryOrigins: Set<string>): number {
  const originA = a.origin ?? a.url;
  const originB = b.origin ?? b.url;
  const primaryOrigin = Number(primaryOrigins.has(originB)) - Number(primaryOrigins.has(originA));
  if (primaryOrigin !== 0) return primaryOrigin;
  const origin = compare(originA, originB);
  if (origin !== 0) return origin;
  const primary = Number(b.primary ?? false) - Number(a.primary ?? false);
  if (primary !== 0) return primary;
  return compare(a.url, b.url);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
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
