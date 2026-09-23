import { SourcePool, createSourcePool } from "./source-pool";
import { RELEVANCE_THRESHOLD } from "@/lib/jev/bands";
import {
  SourcePage,
  planRelevanceRequests,
  planSupportRequests,
  sectionsOf,
} from "./support-question";
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

/**
 * How many candidates one claim asks JEV about. They ride in one request, so
 * a few more cost little: raised from five after a run where the subject's own
 * page was crowded out by a booking listing and the listing decided the answer.
 */
const MAX_SOURCES_PER_CLAIM = 8;

/** How many ways of asking the web about the whole text, before any claim. */
const QUERIES_PER_DOCUMENT = 6;

/**
 * How many pages each of those asks for. The pool is shared by every claim,
 * so this is the whole run's reading list; too short a list and the page one
 * sentence needs never gets found.
 */
const RESULTS_PER_QUERY = 7;

const SOURCE_PRIORITY: Record<SourceType, number> = {
  primary: 1,
  official: 2,
  research: 3,
  secondary: 4,
  ugc: 5,
  unknown: 6,
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
  // The pool already holds what this claim's own questions found, next to
  // what the article's queries found (ADR-0015). Which of them go to JEV is
  // decided as before.
  let pooled = pool.candidatesFor(claim, MAX_SOURCES_PER_CLAIM);

  // No page names the claim's subject word for word — the subject can come
  // back paraphrased or in another language. The pages are still read, and
  // JEV says which of them speak to the claim (ADR-0007: nothing is dropped
  // on this side before JEV is asked).
  if (pooled.length === 0) {
    pooled = pool.closestFor(claim, MAX_SOURCES_PER_CLAIM);
  }

  trace.query = queries.join(" / ");
  trace.found = pooled.length;
  // What the reader is told about is the web search: the fact-check lookup
  // failing on its own leaves the pages to ask with.
  lookupFailed = pool.searchFailed() && pooled.length === 0;

  const readable = pooled
    .slice()
    .sort(
      (a, b) =>
        (SOURCE_PRIORITY[mapDomainToSourceType(a.url)] || 6) -
        (SOURCE_PRIORITY[mapDomainToSourceType(b.url)] || 6)
    )
    .filter((page) => page.text.trim().length > 0);
  trace.unreadable = pooled.length - readable.length;

  // Every page collected, and every fact-check review, is cut into sections
  // (ADR-0014). Nothing is cut away: the sections of a page are its text.
  const factCheckPages: SourcePage[] = claimEvidences.map((item) => ({
    title: item.sourceTitle,
    url: item.sourceUrl,
    text: item.excerpt,
  }));
  const pages: SourcePage[] = [
    ...factCheckPages,
    ...readable.map((page) => ({ title: page.title, url: page.url, text: page.text })),
  ];
  const sections = sectionsOf(pages);

  if (typeof jev.ask !== "function") {
    throw new Error("JEVに問いを送る手段がありません（ask が未実装）。");
  }
  const ask = jev.ask.bind(jev);

  // First: JEV says, section by section, which ones speak to the sentence.
  // Every section is asked; none is dropped on this side (ADR-0007).
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

  // Only the sections JEV judged related go on, in their original order.
  // Unrelated material costs the next answer accuracy (docs.typesafe.ai/
  // model-jaggedness: large state full of irrelevant detail).
  const related = sections
    .map((section, index) => ({ section, index }))
    .filter(({ index }) => (relevance.get(index) ?? 0) >= RELEVANCE_THRESHOLD);

  // Second: the 信頼度 question, as worded before, with those sections as
  // the sources. None related: the same question with no sources.
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

  const factCheckEvidence = claimEvidences.splice(0, claimEvidences.length);
  factCheckEvidence.forEach((item, at) => {
    if (best.has(at)) claimEvidences.push(item);
  });

  readable.forEach((page, i) => {
    const at = factCheckPages.length + i;
    const read = best.get(at);
    if (!read) {
      trace.saidNothing++;
      return;
    }
    trace.used++;
    claimEvidences.push({
      id: `ev-${claim.id}-web-${i}`,
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

