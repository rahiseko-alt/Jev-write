import { SourcePool, createSourcePool } from "./source-pool";
import { readEvidence } from "./evidence-reading";
import { CAUTION_THRESHOLD } from "@/lib/jev/bands";
import { SUPPORT_QUESTION, SourcePage, planSupportRequests } from "./support-question";
import { describeFailure } from "@/lib/providers/diagnostics";
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
  JEVQuestion,
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

/** One more search, for a claim the shared pages have nothing for. */
const QUERIES_PER_CLAIM = 1;

/**
 * How many pages each of those asks for. The pool is shared by every claim,
 * so this is the whole run's reading list; too short a list and the page one
 * sentence needs never gets found.
 */
const RESULTS_PER_QUERY = 7;

/**
 * A relation JEV is less sure of than this is not acted on: below it the
 * answer belongs to a person, not to the pipeline (ADR-0008).
 */
const RELATION_CONFIDENCE_THRESHOLD = CAUTION_THRESHOLD;

const SOURCE_PRIORITY: Record<SourceType, number> = {
  primary: 1,
  official: 2,
  research: 3,
  secondary: 4,
  ugc: 5,
  unknown: 6,
};

/**
 * What one page says about the sentence. Asked beside the support question in
 * the same request (ADR-0007), and used only to choose which pages are listed
 * as the grounds — never for the 信頼度 on screen (ADR-0011).
 */
function relationQuestion(index: number): JEVQuestion {
  return {
    type: "choice",
    instructions: `sources[${index}] の内容は、claim.original をどう扱っているか。`,
    criteria: {
      supports: "claim.original と同じ事実を述べている",
      contradicts:
        "claim.original と異なる事実を述べている（数値・日付・名称の食い違いを含む）",
      says_nothing:
        "claim.original については何も述べていない。別の組織・製品・出来事についての記述である場合もこれにあたる",
    },
  };
}

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

  // No stand-in: a generation that failed is the run failing, said out loud.
  const extractedClaims: Claim[] = await llm.extractClaims(text);

  onProgress?.({
    stage: "FACTCHECK_DB",
    percent: 25,
    message: `主張 ${extractedClaims.length} 件の検証を開始`,
    claimsCount: extractedClaims.length,
  });

  // One pool of pages for the whole run. Searching per claim asked the same
  // questions over and over and spent the search budget on duplicates.
  const pool = createSourcePool({
    search,
    fetchProvider,
    resultsPerQuery: RESULTS_PER_QUERY,
  });

  let documentQueries: string[] = [];
  try {
    if (typeof llm.generateDocumentQueries === "function") {
      documentQueries = (await llm.generateDocumentQueries(text))
        .map((query) => query.trim())
        .filter(Boolean)
        .slice(0, QUERIES_PER_DOCUMENT);
    }
  } catch (err) {
    console.warn("Document-level search queries could not be written:", err);
  }

  if (documentQueries.length > 0) {
    await pool.seed(documentQueries);
  }

  const claimResults: ClaimResult[] = [];
  const allEvidences: Evidence[] = [];
  let factHitsCount = 0;

  // Process claims in parallel
  const claimPromises = extractedClaims.map(async (claim, index) => {
    try {
      return await verifyClaim({
        claim,
        articleText: text,
        pool,
        index,
        llm,
        factCheck,
        jev,
        search,
        fetchProvider,
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
  /** The whole block being checked: what the claim has to hold together with. */
  articleText: string;
  /** The pages this run has already found and read, shared by every claim. */
  pool: SourcePool;
  index: number;
  llm: LLMProvider;
  factCheck: GoogleFactCheckClient;
  jev: JEVClient;
  search: SearchProvider;
  fetchProvider: FetchProvider;
}): Promise<{
  claimResult: ClaimResult;
  evidences: Evidence[];
  isFactCheckHit: boolean;
}> {
  const { claim, articleText, pool, index, llm, factCheck, jev, fetchProvider } = params;
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
  // The pages were gathered for the whole text before any claim was looked
  // at, so most claims cost no search at all. Only a claim the pool has
  // nothing for pays for one of its own (ADR-0007: ask once, not per claim).
  let pooled = pool.candidatesFor(claim, MAX_SOURCES_PER_CLAIM);

  if (pooled.length === 0) {
    let queries: string[] = [];
    try {
      queries = (await llm.generateSearchQueries(claim))
        .map((query) => query.trim())
        .filter(Boolean)
        .slice(0, QUERIES_PER_CLAIM);
    } catch (err) {
      console.warn(`Search queries could not be written for claim ${claim.id}:`, err);
    }

    const query = queries[0] || claim.normalizedText || claim.originalText;
    await pool.addQuery(query);
    pooled = pool.candidatesFor(claim, MAX_SOURCES_PER_CLAIM);
  }

  // No page names the claim's subject word for word — the subject can come
  // back paraphrased or in another language. The pages are still read, and
  // JEV says which of them speak to the claim (ADR-0007: nothing is dropped
  // on this side before JEV is asked).
  if (pooled.length === 0) {
    pooled = pool.closestFor(claim, MAX_SOURCES_PER_CLAIM);
  }

  trace.query = pool.queries().join(" / ");
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

  // Everything collected goes into the state whole: the fact-check reviews
  // first, then every page's full text. Nothing is cut to an excerpt.
  const factCheckPages: SourcePage[] = claimEvidences.map((item) => ({
    title: item.sourceTitle,
    url: item.sourceUrl,
    text: item.excerpt,
  }));
  const pages: SourcePage[] = [
    ...factCheckPages,
    ...readable.map((page) => ({ title: page.title, url: page.url, text: page.text })),
  ];

  if (typeof jev.ask !== "function") {
    throw new Error("JEVに問いを送る手段がありません（ask が未実装）。");
  }

  // Per page, JEV is also asked what the page says about the sentence, in the
  // same request. Those answers only decide which pages are listed as the
  // grounds; the 信頼度 is the support question's answer alone.
  const requests = planSupportRequests({
    original: claim.originalText,
    article: articleText,
    pages,
    questionFor: relationQuestion,
  });

  const ask = jev.ask.bind(jev);
  const replies = await Promise.all(
    requests.map((request) => {
      const questions: Record<string, JEVQuestion> = { support: SUPPORT_QUESTION };
      request.pages.forEach((_, index) => {
        questions[`relation${index}`] = relationQuestion(index);
      });
      return ask(request.state, questions);
    })
  );

  // The 信頼度 is a number JEV returned, as it returned it (ADR-0008,
  // ADR-0011). When the pages had to be spread over several requests, each
  // answer says whether the sentence is backed by the pages in that request;
  // backed by some of the pages is backed by the pages, so the highest of
  // those answers is the one shown. Nothing is averaged or adjusted.
  const supportAnswers: number[] = [];
  for (const answers of replies) {
    const answer = answers.support;
    if (answer && answer.type === "noul" && typeof answer.noul === "number") {
      supportAnswers.push(answer.noul);
    }
  }
  confidence = supportAnswers.length > 0 ? Math.max(...supportAnswers) : undefined;

  // Which pages speak to the sentence, and how: one reading per page, the
  // surest of its parts when it was long enough to be cut.
  const reading = new Map<
    number,
    { relation: "supports" | "contradicts"; certainty: number; text: string }
  >();
  const heard = new Set<number>();

  replies.forEach((answers, r) => {
    requests[r].pages.forEach((page, index) => {
      const answer = answers[`relation${index}`];
      if (!answer || answer.type !== "choice") return;
      if (answer.choice !== "supports" && answer.choice !== "contradicts") return;
      heard.add(page);
      const certainty = answer.confidence ?? 0;
      // An answer JEV is unsure of is not acted on (docs.typesafe.ai/confidence).
      if (certainty < RELATION_CONFIDENCE_THRESHOLD) return;
      const previous = reading.get(page);
      if (!previous || certainty > previous.certainty) {
        reading.set(page, {
          relation: answer.choice,
          certainty,
          text: requests[r].state.sources[index].text,
        });
      }
    });
  });

  const relationCounts = { supports: 0, contradicts: 0 };
  const contradictingSites = new Set<string>();

  readable.forEach((page, i) => {
    const at = factCheckPages.length + i;
    const read = reading.get(at);
    if (!read) {
      if (heard.has(at)) trace.weak++;
      else trace.saidNothing++;
      return;
    }

    relationCounts[read.relation]++;
    trace.used++;
    if (read.relation === "contradicts") contradictingSites.add(siteOf(page.url));

    claimEvidences.push({
      id: `ev-${claim.id}-web-${i}`,
      claimId: claim.id,
      sourceUrl: page.url,
      sourceTitle: page.title,
      publisher: page.siteName || page.author,
      publishedAt: page.publishedAt,
      excerpt: read.text.slice(0, 350),
      sourceType: mapDomainToSourceType(page.url),
      confidence: read.certainty,
      relation: read.relation,
    });
  });

  // What the pages add up to, kept for the run's summary counts only. The
  // screen shows the 信頼度 and nothing else (ADR-0011).
  if (!isFactCheckHit) {
    const summary = readEvidence({
      supports: relationCounts.supports,
      contradicts: relationCounts.contradicts,
      contradictingSites: contradictingSites.size,
    });
    verdict =
      summary === "conflict"
        ? "CONTRADICTED"
        : summary === "mixed"
          ? "MIXED"
          : summary === "supported"
            ? "SUPPORTED"
            : "INSUFFICIENT";
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

/** The site a page belongs to. Two pages of one site are one voice. */
function siteOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
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

