import { PooledSource, SourcePool, createSourcePool } from "./source-pool";
import { RELEVANCE_THRESHOLD } from "@/lib/jev/bands";
import {
  OriginPage,
  planRelevanceRequests,
  planSupportRequests,
  sectionsOf,
  takeWithinBudget,
} from "./support-question";
import { originsOf } from "./source-origin";
import { describeFailure } from "@/lib/providers/diagnostics";
import { QUERIES_PER_CLAIM } from "@/lib/providers/llm/search-queries";
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
  const documentQueries = await documentQueriesPending;
  const documentSeeded = documentQueries.length > 0 ? pool.seed(documentQueries) : Promise.resolve();

  // For every claim, the questions that would settle it, primary source first
  // (ADR-0015). One generation for all claims; all their searches at once.
  const claimQueries = await writeClaimQueries(llm, extractedClaims);
  await Promise.all([
    documentSeeded,
    pool.seed(extractedClaims.flatMap((claim) => claimQueries.get(claim.id) ?? [])),
  ]);

  const claimResults: ClaimResult[] = [];
  const allEvidences: Evidence[] = [];
  let factHitsCount = 0;

  // Process claims in parallel
  const claimPromises = extractedClaims.map(async (claim) => {
    try {
      return await verifyClaim({
        claim,
        pool,
        queries: [...(claimQueries.get(claim.id) ?? []), ...documentQueries],
        factCheck,
        jev,
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
        ledgerItem: {
          claimId: claim.id,
          originalClaim: claim.normalizedText || claim.originalText,
          verdict: "INSUFFICIENT" as ClaimVerdict,
          correctionReason: reason,
          lockedFacts: [],
          evidenceIds: [],
          confidence: undefined,
        },
        evidences: [],
        isFactCheckHit: false,
      };
    }
  });

  const resolved = await Promise.all(claimPromises);

  for (const item of resolved) {
    claimResults.push(item.claimResult);
    allEvidences.push(...item.evidences);
    if (item.isFactCheckHit) {
      factHitsCount++;
    }
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

async function verifyClaim(params: {
  claim: Claim;
  /** The pages this run has already found and read, shared by every claim. */
  pool: SourcePool;
  /** The searches that were made with this claim in mind: its own, then the article's. */
  queries: string[];
  factCheck: GoogleFactCheckClient;
  jev: JEVClient;
}): Promise<{
  claimResult: ClaimResult;
  evidences: Evidence[];
  isFactCheckHit: boolean;
}> {
  const { claim, pool, queries, factCheck, jev } = params;
  const claimEvidences: Evidence[] = [];
  // A lookup that could not be made at all, as opposed to one that ran and
  // found nothing. The reader is told which of the two happened.
  let lookupFailed = false;

  // Where this claim's evidence went. "Nothing found" has several causes and
  // they look identical on screen unless they are counted apart (ADR-0006).
  const trace: EvidenceTrace = {
    query: "",
    found: 0,
    offSubject: 0,
    unreadable: 0,
    saidNothing: 0,
    weak: 0,
    used: 0,
    overCap: 0,
    origins: 0,
  };
  let verdict: ClaimVerdict = "INSUFFICIENT";
  let reason: string | undefined;
  let isFactCheckHit = false;
  /**
   * JEV's number for this claim, or nothing. Every value here comes from an
   * answer; nothing is filled in to make the screen look decided (ADR-0008).
   */
  let confidence: number | undefined;

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
    // ADR-0003: the lookup failed, so the claim stays unverified and the run
    // carries on to the web search. Nothing is filled in for it.
    console.warn(`Fact check lookup failed for claim ${claim.id}:`, err);
    lookupFailed = true;
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
            const normResult = await jev.evaluateAtomicJudgment({
              state: { rating: ratingText },
              instructions: "この検証判定は主張を肯定していますか、否定していますか？",
              criteria: ["supports", "contradicts", "mixed", "insufficient"],
            });
            verdict = mapChoiceToClaimVerdict(normResult.choice);
            reason = normResult.explanation || `FactCheck評価: ${ratingText}`;
          }

          const evidence: Evidence = {
            id: `ev-${claim.id}-fc-${i}`,
            claimId: claim.id,
            sourceUrl: review.url,
            sourceTitle: review.title || hitClaimText,
            publisher: review.publisher?.name || "Fact Check Organization",
            publishedAt: review.reviewDate || hit.claimDate,
            excerpt: `[FactCheck: ${review.textualRating}] ${review.title || hitClaimText}`,
            sourceType: "official",
          };
          claimEvidences.push(evidence);
        }

        break; // Matched primary fact check hit
      }
    }
  }

  // Step 3: the pages. Gathered for every claim, whatever the fact-check
  // lookup found: the one question below is asked of every sentence, and it
  // is asked of everything that was collected (ADR-0011).
  //
  // The selection, step by step (ADR-0016):
  //  1. Every page in the pool is a candidate. This claim's own searches
  //     first, then the article's, then the rest, each in search order. No
  //     score of this side's orders or cuts them (not the subject's mentions,
  //     #39).
  //  2. Only JEV's input ceiling keeps a candidate out, and what it keeps out
  //     is counted and reported.
  const pooled = pool.candidatesFor(queries);
  const readable = pooled.filter((page) => page.text.trim().length > 0);
  const { taken, overCap } = takeWithinBudget(readable);

  trace.query = queries.join(" / ");
  trace.found = pooled.length;
  trace.unreadable = pooled.length - readable.length;
  trace.overCap = overCap.length;
  if (overCap.length > 0) {
    console.info(
      `Claim ${claim.id}: ${overCap.length} of ${readable.length} candidate pages were over the JEV budget and not asked about (ADR-0016).`
    );
  }
  // What the reader is told about is the web search: the fact-check lookup
  // failing on its own leaves the pages to ask with.
  lookupFailed = pool.searchFailed() && pooled.length === 0;

  //  3. Each page gets its origin (one site, or the sites carrying the same
  //     text) and whether its address is a primary source's.
  //  4. The pages go in a fixed order that does not change from run to run:
  //     primary sources first, then by origin, then by address.
  //  5. They are cut into sections (ADR-0014); nothing is cut away.
  type Collected = { page: OriginPage; factCheck?: Evidence; web?: PooledSource };
  const collected: Collected[] = [
    ...claimEvidences.map((item) => ({
      page: { title: item.sourceTitle, url: item.sourceUrl, text: item.excerpt },
      factCheck: item,
    })),
    ...taken.map((page) => ({
      page: { title: page.title, url: page.url, text: page.text },
      web: page,
    })),
  ];
  const origins = originsOf(collected.map(({ page }) => page));
  collected.forEach((item, i) => Object.assign(item.page, origins[i]));
  const primaryOrigins = new Set(
    collected.filter(({ page }) => page.primary).map(({ page }) => page.origin ?? page.url)
  );
  const ordered = collected
    .slice()
    .sort((a, b) => fixedOrder(a.page, b.page, primaryOrigins));
  const sections = sectionsOf(ordered.map(({ page }) => page));

  if (typeof jev.ask !== "function") {
    throw new Error("JEVに問いを送る手段がありません（ask が未実装）。");
  }
  const ask = jev.ask.bind(jev);

  //  6. JEV says, section by section, which ones speak to the sentence.
  //     Every section is asked; none is dropped on this side (ADR-0007).
  const relevanceRequests = planRelevanceRequests({
    original: claim.originalText,
    sections,
  });
  const relevanceReplies = await Promise.all(
    relevanceRequests.map((request) => ask(request.state, request.questions))
  );

  const relevance = new Map<number, number>();
  relevanceReplies.forEach((answers, r) => {
    relevanceRequests[r].sections.forEach((section, i) => {
      const answer = answers[`relevant${i}`];
      if (answer && answer.type === "noul" && typeof answer.noul === "number") {
        relevance.set(section, answer.noul);
      }
    });
  });

  //  7. Only the sections JEV judged related go on, in the fixed order of
  //     step 4. Unrelated material costs the next answer accuracy
  //     (docs.typesafe.ai/model-jaggedness: large state full of irrelevant
  //     detail). A section that says otherwise than the sentence is about
  //     the same thing, so it is related and goes on: nothing contradicting
  //     is dropped here.
  const related = sections
    .map((section, index) => ({ section, index }))
    .filter(({ index }) => (relevance.get(index) ?? 0) >= RELEVANCE_THRESHOLD);

  //  8. The 信頼度 question, as worded before (ADR-0011), with those
  //     sections as the sources, grouped by origin and each saying whether
  //     it is a primary source. Whether that matters is JEV's to weigh. None
  //     related: the same question with no sources.
  const supportRequests = planSupportRequests({
    original: claim.originalText,
    sections: related.map(({ section }) => section),
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
  confidence = supportAnswers.length > 0 ? Math.max(...supportAnswers) : undefined;

  // The grounds in the bubble: the pages that hold a section judged related,
  // each with its most related section.
  const best = new Map<number, { text: string; relevance: number }>();
  for (const { section, index } of related) {
    const score = relevance.get(index) ?? 0;
    const previous = best.get(section.page);
    if (!previous || score > previous.relevance) {
      best.set(section.page, { text: section.source.text, relevance: score });
    }
  }

  claimEvidences.splice(0, claimEvidences.length);
  const usedOrigins = new Set<string>();
  ordered.forEach(({ page: collectedPage, factCheck: review, web: page }, at) => {
    const read = best.get(at);
    if (read) usedOrigins.add(collectedPage.origin ?? collectedPage.url);
    if (review) {
      if (read) claimEvidences.push(review);
      return;
    }
    if (!page) return;
    if (!read) {
      trace.saidNothing++;
      return;
    }
    trace.used++;
    claimEvidences.push({
      id: `ev-${claim.id}-web-${at}`,
      claimId: claim.id,
      sourceUrl: page.url,
      sourceTitle: page.title,
      publisher: page.siteName || page.author,
      publishedAt: page.publishedAt,
      excerpt: read.text.slice(0, 350),
      sourceType: mapDomainToSourceType(page.url),
      confidence: read.relevance,
    });
  });
  trace.origins = usedOrigins.size;

  // No verdict is drawn from the pages: the screen shows the 信頼度 and
  // nothing else (ADR-0009, ADR-0011).
  if (!isFactCheckHit) {
    verdict = "INSUFFICIENT";
    reason = lookupFailed
      ? "外部の確認サービスに接続できなかったため、渡せた資料だけで問いました。"
      : undefined;
  }

  const claimResult: ClaimResult = {
    claim,
    verdict,
    reason,
    evidence: claimEvidences,
    confidence,
    lookupFailed,
    evidenceTrace: trace,
  };

  return {
    claimResult,
    evidences: claimEvidences,
    isFactCheckHit,
  };
}

/** The article's queries, or none when they could not be written. */
async function writeDocumentQueries(llm: LLMProvider, text: string): Promise<string[]> {
  if (typeof llm.generateDocumentQueries !== "function") return [];
  try {
    return (await llm.generateDocumentQueries(text))
      .map((query) => query.trim())
      .filter(Boolean)
      .slice(0, QUERIES_PER_DOCUMENT);
  } catch (err) {
    console.warn("Document-level search queries could not be written:", err);
    return [];
  }
}

/**
 * Each claim's questions, by claim id. When they could not be written the
 * claims are still checked, against the pages the article's queries found;
 * the claim's sentence is never searched in their place.
 */
async function writeClaimQueries(
  llm: LLMProvider,
  claims: Claim[]
): Promise<Map<string, string[]>> {
  if (claims.length === 0 || typeof llm.generateClaimQueries !== "function") return new Map();
  try {
    const written = await llm.generateClaimQueries(claims);
    const byId = new Map<string, string[]>();
    for (const claim of claims) {
      const queries = (written.get(claim.id) ?? [])
        .map((query) => query.trim())
        .filter(Boolean)
        .slice(0, QUERIES_PER_CLAIM);
      byId.set(claim.id, queries);
    }
    return byId;
  } catch (err) {
    console.warn("Search questions for the claims could not be written:", err);
    return new Map();
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
 * The fixed order pages go to JEV in (ADR-0016, step 4): origins holding a
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

