import { correctionFromEvidence } from "./correction";
import { ACT_THRESHOLD, CAUTION_THRESHOLD, bandOf } from "@/lib/jev/bands";
import { describeFailure } from "@/lib/providers/diagnostics";
import {
  Claim,
  ClaimResult,
  EvidenceTrace,
  ClaimVerdict,
  Evidence,
  FactLedgerItem,
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
  SearchResultItem,
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
  factLedger: FactLedgerItem[];
  evidences: Evidence[];
}

/** How many candidates one claim asks JEV about. They ride in one request. */
const MAX_SOURCES_PER_CLAIM = 5;

/** How many ways of asking the web about one claim. */
const QUERIES_PER_CLAIM = 2;

/** How many pages each of those asks for. */
const RESULTS_PER_QUERY = 4;

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

  const claimResults: ClaimResult[] = [];
  const factLedger: FactLedgerItem[] = [];
  const allEvidences: Evidence[] = [];
  let factHitsCount = 0;

  // Process claims in parallel
  const claimPromises = extractedClaims.map(async (claim, index) => {
    try {
      return await verifyClaim({
        claim,
        articleText: text,
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
    factLedger.push(item.ledgerItem);
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
    factLedger,
    evidences: allEvidences,
  };
}

async function verifyClaim(params: {
  claim: Claim;
  /** The whole block being checked: what the claim has to hold together with. */
  articleText: string;
  index: number;
  llm: LLMProvider;
  factCheck: GoogleFactCheckClient;
  jev: JEVClient;
  search: SearchProvider;
  fetchProvider: FetchProvider;
}): Promise<{
  claimResult: ClaimResult;
  ledgerItem: FactLedgerItem;
  evidences: Evidence[];
  isFactCheckHit: boolean;
}> {
  const { claim, articleText, index, llm, factCheck, jev, search, fetchProvider } =
    params;
  /** JEV's reading of whether the claim holds up, kept whatever the sources said. */
  let consistency: ClaimResult["consistency"];
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
  let correctedClaim: string | undefined;
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
            // A published rating decided this, not JEV. There is no number.
            confidence = undefined;
            reason = `FactCheck評価: ${ratingText} (${review.publisher?.name || "検証機関"})`;
          } else if (isTrue) {
            verdict = "SUPPORTED";
            confidence = undefined;
            reason = `FactCheck評価: ${ratingText} (${review.publisher?.name || "検証機関"})`;
          } else {
            const normResult = await jev.evaluateAtomicJudgment({
              state: { rating: ratingText },
              instructions: "この検証判定は主張を肯定していますか、否定していますか？",
              criteria: ["supports", "contradicts", "mixed", "insufficient"],
            });
            verdict = mapChoiceToClaimVerdict(normResult.choice);
            confidence = normResult.confidence;
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

        if (verdict === "CONTRADICTED") {
          // A review's headline is an article title, not a replacement
          // sentence. The conflict is reported; the wording stays.
          correctedClaim = undefined;
        }
        break; // Matched primary fact check hit
      }
    }
  }

  // Step 3: Fallback to Web Search if no usable Google Fact Check hit
  if (!isFactCheckHit) {
    // What to search for is a writing job, and the generation side has one
    // for it. A query assembled here out of the claim's parts asked for
    // "フリノバギルド 登録者数の推移 2026年4月 公式" and found nothing.
    let queries: string[] = [];
    try {
      queries = (await llm.generateSearchQueries(claim))
        .map((query) => query.trim())
        .filter(Boolean)
        .slice(0, QUERIES_PER_CLAIM);
    } catch (err) {
      console.warn(`Search queries could not be written for claim ${claim.id}:`, err);
    }

    if (queries.length === 0) {
      queries = [claim.normalizedText || claim.originalText];
    }

    trace.query = queries.join(" / ");

    let searchResults: SearchResultItem[] = [];
    try {
      const responses = await Promise.all(
        queries.map((query) => search.search(query, { maxResults: RESULTS_PER_QUERY }))
      );

      // The same page found by two queries is one candidate, not two.
      const seen = new Set<string>();
      for (const response of responses) {
        for (const result of response.results || []) {
          if (seen.has(result.url)) continue;
          seen.add(result.url);
          searchResults.push(result);
        }
      }
      trace.found = searchResults.length;
    } catch (err) {
      // ADR-0003: the lookup failed, so the claim stays unverified and the
      // pipeline carries on. It does not get made up for.
      console.warn(`Web search failed for claim ${claim.id}:`, err);
      lookupFailed = true;
    }

    // Sort by source priority
    const sortedResults = [...searchResults]
      .sort(
      (a, b) => {
        const typeA = mapDomainToSourceType(a.url);
        const typeB = mapDomainToSourceType(b.url);
        return (SOURCE_PRIORITY[typeA] || 6) - (SOURCE_PRIORITY[typeB] || 6);
      }
    );

    const relationCounts = {
      supports: 0,
      contradicts: 0,
      says_nothing: 0,
      ambiguous: 0,
    };

    let bestExplanation: string | undefined;

    // Every candidate is read first, then JEV is asked about all of them in
    // one request (ADR-0007): questions are answered in parallel, so asking
    // about five pages costs about what asking about one costs. Nothing is
    // discarded before JEV sees it, and the numbers it returns are kept.
    const candidates = await Promise.all(
      sortedResults.slice(0, MAX_SOURCES_PER_CLAIM).map(async (res) => {
        let fetched: any = {
          url: res.url,
          title: res.title,
          siteName: "",
          author: "",
          publishedAt: "",
          statusCode: 200,
        };

        try {
          fetched =
            typeof fetchProvider.fetchUrl === "function"
              ? await fetchProvider.fetchUrl(res.url)
              : await (fetchProvider as any).fetch(res.url);
        } catch (err) {
          console.warn(`Fetch failed for ${res.url}:`, err);
        }

        const pageText = fetched.content || (fetched as any).text || "";
        const snippet = res.content || (res as any).snippet || "";
        const text = pageText.trim().length > 0 ? pageText : snippet;

        return {
          res,
          fetched,
          text,
          excerpt: extractRelevantExcerpt(text, claim, 2500),
        };
      })
    );

    const readable = candidates.filter((candidate) => candidate.text.trim().length > 0);
    trace.unreadable = candidates.length - readable.length;

    if (typeof jev.ask === "function") {
      const questions: Record<string, JEVQuestion> = {};

      // Asked whatever the search turned up. A figure nobody published has no
      // page to contradict it, but the rest of the article is state JEV can
      // read, and it answers with a number instead of silence (ADR-0008).
      //
      // The claim's own sentence is taken out of that state first. Left in,
      // the question answers itself: a fabricated figure always agrees with
      // the article that carries it, and JEV rightly said so.
      questions.holdsUp = {
        type: "noul",
        instructions:
          "claim.text の数値や事実関係は、others（この主張の文を取り除いた記事の残り）および " +
          "sources の記述と突き合わせたとき、辻褄が合うか。" +
          "数値の辻褄が合わない場合は合わないとする。" +
          "どちらにも関連する記述が無く判断材料が無い場合は、どちらとも言えない側に寄せること。",
      };

      readable.forEach((candidate, index) => {
        questions[`relation${index}`] = {
          type: "choice",
          instructions: `sources[${index}] の内容は、claim.text をどう扱っているか。`,
          criteria: {
            supports: "claim.text と同じ事実を述べている",
            contradicts:
              "claim.text と異なる事実を述べている（数値・日付・名称の食い違いを含む）",
            says_nothing:
              "claim.text については何も述べていない。別の組織・製品・出来事についての記述である場合もこれにあたる",
          },
        };
      });

      const answers = await jev.ask(
        {
          others: articleWithoutClaim(articleText, claim),
          claim: {
            text: claim.normalizedText || claim.originalText,
            subject: claim.subject || claim.entities?.[0] || "",
          },
          sources: readable.map((candidate) => ({
            title: candidate.fetched.title || candidate.res.title || "",
            url: candidate.res.url,
            text: candidate.excerpt,
          })),
        },
        questions
      );

      const holdsUp = answers.holdsUp;
      if (holdsUp && holdsUp.type === "noul") {
        // A noul answer carries the probability alone. Its confidence is how
        // far that probability sits from a coin toss, which is the same
        // reading the client uses elsewhere (docs.typesafe.ai/confidence).
        consistency = {
          probabilityTrue: holdsUp.noul,
          confidence: holdsUp.noul >= 0.5 ? holdsUp.noul : 1 - holdsUp.noul,
        };
      }

      for (let index = 0; index < readable.length; index++) {
        const candidate = readable[index];
        const relationAnswer = answers[`relation${index}`];

        if (!relationAnswer || relationAnswer.type !== "choice") {
          trace.saidNothing++;
          continue;
        }

        const relation = relationAnswer.choice as keyof typeof relationCounts;
        const certainty = relationAnswer.confidence ?? 0;

        if (relation !== "supports" && relation !== "contradicts") {
          trace.saidNothing++;
          continue;
        }

        // An answer JEV is unsure of is not a verdict. It is counted as a
        // weak reading rather than acted on (docs.typesafe.ai/confidence).
        if (certainty < RELATION_CONFIDENCE_THRESHOLD) {
          trace.weak++;
          continue;
        }

        relationCounts[relation]++;
        trace.used++;

        claimEvidences.push({
          id: `ev-${claim.id}-web-${index}`,
          claimId: claim.id,
          sourceUrl: candidate.fetched.url || candidate.res.url,
          sourceTitle: candidate.fetched.title || candidate.res.title,
          publisher: candidate.fetched.siteName || candidate.fetched.author,
          publishedAt: candidate.fetched.publishedAt,
          excerpt: candidate.excerpt.slice(0, 350),
          sourceType: mapDomainToSourceType(candidate.res.url),
          confidence: certainty,
          relation,
        });

        if (!bestExplanation) {
          bestExplanation = `JEVの判定: ${relation}（確信度 ${(certainty * 100).toFixed(0)}%）`;
        }

        if (relation === "contradicts" && !correctedClaim) {
          correctedClaim = await deriveCorrectionFromText(candidate.text, claim, llm);
        }
      }
    }

    // The verdict's strength is JEV's, not a number chosen here (ADR-0007).
    const strongest = (kind: "supports" | "contradicts") =>
      Math.max(
        0,
        ...claimEvidences
          .filter((item) => (item.confidence ?? 0) > 0 && item.relation === kind)
          .map((item) => item.confidence ?? 0)
      );

    if (claimEvidences.length === 0) {
      // No page carried the figure. That is not the same as nothing being
      // known: JEV was still asked whether the claim holds together with the
      // article, and its answer is used rather than a number chosen here
      // (ADR-0008).
      const held = consistency;
      if (held && held.probabilityTrue < 0.5 && held.confidence >= ACT_THRESHOLD) {
        verdict = "CONTRADICTED";
        confidence = held.confidence;
        reason = `裏付けとなるページは見つかりませんでしたが、JEVは記事内の他の記述と噛み合わないと判定しました（成り立つ確率 ${(held.probabilityTrue * 100).toFixed(0)}%、確信度 ${(held.confidence * 100).toFixed(0)}%）。`;
      } else if (held) {
        verdict = "INSUFFICIENT";
        confidence = held.confidence;
        reason = lookupFailed
          ? "外部の確認サービスに接続できなかったため、確認できませんでした。"
          : `裏付けとなるページが見つかりませんでした。JEVの読みは、成り立つ確率 ${(held.probabilityTrue * 100).toFixed(0)}%、確信度 ${(held.confidence * 100).toFixed(0)}% です。`;
      } else {
        verdict = "INSUFFICIENT";
        confidence = undefined;
        reason = lookupFailed
          ? "外部の確認サービスに接続できなかったため、確認できませんでした。"
          : "検証に足る明確な裏付け情報が確認できませんでした（証拠0件）。";
      }
    } else if (relationCounts.contradicts > 0 && relationCounts.supports === 0) {
      verdict = "CONTRADICTED";
      confidence = strongest("contradicts");
      reason = bestExplanation || "外部ソースの情報と矛盾する内容が確認されました。";
    } else if (relationCounts.contradicts > 0 && relationCounts.supports > 0) {
      verdict = "MIXED";
      confidence = Math.max(strongest("contradicts"), strongest("supports"));
      reason = bestExplanation || "裏付け情報と矛盾する情報の双方が存在します。";
    } else if (relationCounts.supports > 0) {
      verdict = "SUPPORTED";
      confidence = strongest("supports");
      reason = bestExplanation || "信頼できる外部ソースによって事実の裏付けが得られました。";
    } else {
      verdict = "INSUFFICIENT";
      confidence = consistency?.confidence;
      reason = lookupFailed
        ? "外部の確認サービスに接続できなかったため、確認できませんでした。"
        : "検証に足る明確な裏付け情報が確認できませんでした。";
    }
  }

  // Locked facts for Fact Ledger (immutable facts that rewriting LLM must not modify)
  const lockedFacts: string[] = [];
  if (verdict === "SUPPORTED") {
    lockedFacts.push(claim.normalizedText);
    if (claim.numbers) lockedFacts.push(...claim.numbers);
    if (claim.dates) lockedFacts.push(...claim.dates);
    if (claim.entities) lockedFacts.push(...claim.entities);
  }

  const ledgerItem: FactLedgerItem = {
    claimId: claim.id,
    originalClaim: claim.normalizedText || claim.originalText,
    verdict,
    // No correction the Evidence justifies means no correction. The claim's
    // own paraphrase is not one, and offering it would authorise a change
    // nobody checked.
    correctedClaim: verdict === "CONTRADICTED" ? correctedClaim : undefined,
    correctionReason: reason,
    lockedFacts: Array.from(new Set(lockedFacts)),
    evidenceIds: claimEvidences.map((e) => e.id),
    confidence,
  };

  const claimResult: ClaimResult = {
    claim,
    verdict,
    correctedClaim: ledgerItem.correctedClaim,
    reason,
    evidence: claimEvidences,
    confidence,
    band: confidence === undefined ? undefined : bandOf(confidence),
    consistency,
    lookupFailed,
    evidenceTrace: trace,
  };

  return {
    claimResult,
    ledgerItem,
    evidences: claimEvidences,
    isFactCheckHit,
  };
}

/**
 * The article with the claim's own sentence taken out, so that asking whether
 * the claim fits the article is not asking whether it fits itself.
 */
function articleWithoutClaim(articleText: string, claim: Claim): string {
  const sentence = claim.originalText?.trim();
  if (!sentence) return articleText;
  const at = articleText.indexOf(sentence);
  if (at === -1) return articleText;
  return articleText.slice(0, at) + articleText.slice(at + sentence.length);
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

async function deriveCorrectionFromText(
  text: string,
  claim: Claim,
  llm?: LLMProvider
): Promise<string | undefined> {
  // The LLM reads the Evidence and states the corrected fact, where it can.
  if (llm && typeof (llm as any).deriveCorrection === "function") {
    try {
      const res = await (llm as any).deriveCorrection(claim, text);
      if (res && res.trim().length > 0) {
        return res.trim();
      }
    } catch (e) {
      console.warn("LLM deriveCorrection failed:", e);
    }
  }

  // Otherwise the Evidence's own figures, and only where they answer the same
  // question the Claim asks. Anything less specific is a guess, and a guess
  // here rewrites the reader's article with another document's facts.
  return correctionFromEvidence(claim, text);
}

function extractRelevantExcerpt(content: string, claim: Claim, maxLength = 2500): string {
  if (content.length <= maxLength) return content;

  // Collect keywords from claim
  const keywords: string[] = [];
  if (claim.subject) keywords.push(claim.subject);
  if (claim.entities) keywords.push(...claim.entities);
  if (claim.numbers) keywords.push(...claim.numbers);
  if (claim.dates) keywords.push(...claim.dates);

  const textTokens = (claim.normalizedText || claim.originalText)
    .replace(/[、。！？\s\(\)（）「」『』]/g, " ")
    .split(" ")
    .filter((w) => w.length >= 2);
  keywords.push(...textTokens);

  let bestIndex = 0;
  let maxMatches = 0;

  for (let i = 0; i < content.length; i += 200) {
    const chunk = content.slice(i, i + maxLength).toLowerCase();
    let matches = 0;
    for (const kw of keywords) {
      if (kw && chunk.includes(kw.toLowerCase())) {
        matches++;
      }
    }
    if (matches > maxMatches) {
      maxMatches = matches;
      bestIndex = i;
    }
  }

  return content.slice(bestIndex, bestIndex + maxLength);
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

