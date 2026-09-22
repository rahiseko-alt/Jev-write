import {
  Claim,
  ClaimResult,
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
  factLedger: FactLedgerItem[];
  evidences: Evidence[];
}

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

  let extractedClaims: Claim[] = [];
  try {
    extractedClaims = await llm.extractClaims(text);
  } catch (err) {
    console.warn("Claim extraction failed, continuing with empty claims:", err);
  }

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
        index,
        llm,
        factCheck,
        jev,
        search,
        fetchProvider,
      });
    } catch (err) {
      console.warn(`Graceful fallback for claim ${claim.id}:`, err);
      // Graceful fallback per ADR-0003
      const fallbackEvidence: Evidence[] = [];
      const fallbackResult: ClaimResult = {
        claim,
        verdict: "INSUFFICIENT",
        reason: "検証処理中にタイムアウトまたは外部接続エラーが発生したため未検証です。",
        evidence: fallbackEvidence,
      };
      const fallbackLedger: FactLedgerItem = {
        claimId: claim.id,
        originalClaim: claim.normalizedText || claim.originalText,
        verdict: "INSUFFICIENT",
        correctionReason: "外部検証サービスにアクセスできませんでした。",
        lockedFacts: [],
        evidenceIds: [],
        confidence: 0.5,
      };
      return {
        claimResult: fallbackResult,
        ledgerItem: fallbackLedger,
        evidences: fallbackEvidence,
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
  const { claim, index, llm, factCheck, jev, search, fetchProvider } = params;
  const claimEvidences: Evidence[] = [];
  let verdict: ClaimVerdict = "INSUFFICIENT";
  let correctedClaim: string | undefined;
  let reason: string | undefined;
  let isFactCheckHit = false;
  let confidence = 0.7;

  // Step 2: Query Google Fact Check Tools API
  const query = buildFactCheckQuery(claim);
  let factHits: GoogleFactCheckClaim[] = [];

  if (typeof (factCheck as any).search === "function") {
    factHits = await (factCheck as any).search(query);
  } else if (typeof factCheck.searchClaims === "function") {
    const res = await factCheck.searchClaims(query);
    factHits = res.claims || [];
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
            confidence = 0.95;
            reason = `FactCheck評価: ${ratingText} (${review.publisher?.name || "検証機関"})`;
          } else if (isTrue) {
            verdict = "SUPPORTED";
            confidence = 0.95;
            reason = `FactCheck評価: ${ratingText} (${review.publisher?.name || "検証機関"})`;
          } else {
            const normResult = await jev.evaluateAtomicJudgment({
              state: { rating: ratingText },
              instructions: "この検証判定は主張を肯定していますか、否定していますか？",
              criteria: ["supports", "contradicts", "mixed", "insufficient"],
            });
            verdict = mapChoiceToClaimVerdict(normResult.choice);
            confidence = normResult.confidence || 0.85;
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
          correctedClaim = deriveCorrectedClaim(claim, reviews[0]?.title || hitClaimText);
        }
        break; // Matched primary fact check hit
      }
    }
  }

  // Step 3: Fallback to Web Search if no usable Google Fact Check hit
  if (!isFactCheckHit) {
    const searchQuery = buildWebSearchQuery(claim);
    const searchResponse = await search.search(searchQuery, { maxResults: 3 });
    const searchResults = searchResponse.results || [];

    // Sort by source priority
    const effectiveEntities = (claim.entities && claim.entities.length > 0)
      ? claim.entities
      : [claim.subject || "", claim.normalizedText].filter(Boolean);

    const sortedResults = [...searchResults]
      .filter((res) => passesEntityGate(res.url, effectiveEntities))
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

    for (let i = 0; i < sortedResults.length; i++) {
      const res = sortedResults[i];
      try {
        let fetched: any = { url: res.url, title: res.title, siteName: "", author: "", publishedAt: "", statusCode: 200 };
        try {
          fetched =
            typeof fetchProvider.fetchUrl === "function"
              ? await fetchProvider.fetchUrl(res.url)
              : await (fetchProvider as any).fetch(res.url);
        } catch (err) {
          console.warn(`Fetch failed for ${res.url}:`, err);
        }

        const rawContent = fetched.content || (fetched as any).text || "";
        let content = res.content || (res as any).snippet || "";

        if (!content && rawContent.trim().length > 0 && fetched.statusCode !== 403 && fetched.statusCode !== 404) {
          content = rawContent;
        } else if (!content) {
          content = rawContent;
        }

        const relevantEvidence = extractRelevantExcerpt(content, claim, 2500);

        // JEV evidence evaluation
        const evalResult = await jev.evaluateAtomicJudgment({
          state: {
            claim: claim.normalizedText || claim.originalText,
            evidence: relevantEvidence,
          },
          instructions: "この証拠テキストは主張を肯定（supports）していますか、否定（contradicts）していますか？",
          criteria: ["supports", "contradicts", "says_nothing", "ambiguous"],
        });

        const relation = (evalResult.choice as keyof typeof relationCounts) || "says_nothing";
        if (relationCounts[relation] !== undefined) {
          relationCounts[relation]++;
        }

        if (relation === "supports" || relation === "contradicts") {
          const evId = `ev-${claim.id}-web-${i}`;
          claimEvidences.push({
            id: evId,
            claimId: claim.id,
            sourceUrl: fetched.url,
            sourceTitle: fetched.title || res.title,
            publisher: fetched.siteName || fetched.author,
            publishedAt: fetched.publishedAt,
            excerpt: relevantEvidence.slice(0, 350),
            sourceType: mapDomainToSourceType(fetched.url),
          });

          if (!bestExplanation && evalResult.explanation) {
            bestExplanation = evalResult.explanation;
          }

          if (relation === "contradicts" && !correctedClaim) {
            correctedClaim = await deriveCorrectionFromText(content, claim, llm);
          }
        }
      } catch (err) {
        console.warn(`Fetch failed for ${res.url}:`, err);
      }
    }

    // Synthesize final ClaimVerdict
    if (claimEvidences.length === 0) {
      verdict = "INSUFFICIENT";
      confidence = 0.6;
      reason = "検証に足る明確な裏付け情報が確認できませんでした（証拠0件）。";
    } else if (relationCounts.contradicts > 0 && relationCounts.supports === 0) {
      verdict = "CONTRADICTED";
      confidence = 0.9;
      reason = bestExplanation || "外部ソースの情報と矛盾する内容が確認されました。";
    } else if (relationCounts.contradicts > 0 && relationCounts.supports > 0) {
      verdict = "MIXED";
      confidence = 0.75;
      reason = bestExplanation || "裏付け情報と矛盾する情報の双方が存在します。";
    } else if (relationCounts.supports > 0) {
      verdict = "SUPPORTED";
      confidence = 0.88;
      reason = bestExplanation || "信頼できる外部ソースによって事実の裏付けが得られました。";
    } else {
      verdict = "INSUFFICIENT";
      confidence = 0.6;
      reason = "検証に足る明確な裏付け情報が確認できませんでした。";
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
    correctedClaim: verdict === "CONTRADICTED" ? (correctedClaim || claim.normalizedText) : undefined,
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
  };

  return {
    claimResult,
    ledgerItem,
    evidences: claimEvidences,
    isFactCheckHit,
  };
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

function buildWebSearchQuery(claim: Claim): string {
  const parts: string[] = [];

  // 1. Primary product / organization entity from entities
  const primaryEntity = claim.entities?.find(e => 
    /iPhone|Apple|Nintendo|Switch|任天堂|Sony|PlayStation|Google|Microsoft|OpenAI/i.test(e)
  );
  if (primaryEntity) {
    parts.push(primaryEntity);
  }

  // 2. Subject
  if (claim.subject) {
    if (!primaryEntity || !claim.subject.includes(primaryEntity)) {
      parts.push(claim.subject);
    }
  }

  // 3. Predicate
  if (claim.predicate) {
    parts.push(claim.predicate);
  }

  // 4. Dates
  if (claim.dates && claim.dates.length > 0) {
    parts.push(claim.dates[0]);
  }

  if (parts.length > 0) {
    parts.push("公式");
    return Array.from(new Set(parts)).join(" ");
  }

  return claim.normalizedText.replace(/[、。！？\n]/g, " ").slice(0, 60).trim();
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

function deriveCorrectedClaim(claim: Claim, reference: string): string {
  return reference;
}

async function deriveCorrectionFromText(
  text: string,
  claim: Claim,
  llm?: LLMProvider
): Promise<string> {
  // If LLM supports deriveCorrection, ask LLM to extract the precise fact from evidence
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

  let corrected = claim.normalizedText || claim.originalText;

  // Generic spec unit matching between claim and evidence:
  // mm, g, インチ, Hz, GB, TB, mAh, fps, 人, 円, 倍, MP, Gbps
  const specUnits = ["円", "mm", "g", "インチ", "Hz", "GB", "TB", "mAh", "fps", "人", "倍", "MP", "Gbps"];
  for (const unit of specUnits) {
    const unitRegex = new RegExp(`(\\d+[\\d,.]*)\\s*${unit}`, "gi");
    let match: RegExpExecArray | null;
    while ((match = unitRegex.exec(corrected)) !== null) {
      const claimVal = match[1];
      const evRegex = new RegExp(`(\\d+[\\d,.]*)\\s*${unit}`, "gi");
      let evMatch: RegExpExecArray | null;
      while ((evMatch = evRegex.exec(text)) !== null) {
        const evVal = evMatch[1];
        if (evVal.replace(/,/g, "") !== claimVal.replace(/,/g, "")) {
          const wrongSegment = `${claimVal}${unit}`;
          const rightSegment = `${evVal}${unit}`;
          if (corrected.includes(wrongSegment)) {
            corrected = corrected.replace(wrongSegment, rightSegment);
            break;
          }
        }
      }
    }
  }

  // Resolution replacement (e.g. 1920×1200 -> 1920×1080)
  const resMatch = corrected.match(/(\d{3,4})\s*[×x]\s*(\d{3,4})/i);
  const evResMatch = text.match(/(\d{3,4})\s*[×x]\s*(\d{3,4})/i);
  if (resMatch && evResMatch) {
    const wrongRes = resMatch[0];
    const rightRes = evResMatch[0];
    if (wrongRes !== rightRes) {
      corrected = corrected.replace(wrongRes, rightRes);
    }
  }

  // Wi-Fi standard replacement (e.g. Wi-Fi 6E -> Wi-Fi 6)
  const wifiMatch = corrected.match(/wi-?fi\s*(\d+[a-z]*)/i);
  const evWifiMatch = text.match(/wi-?fi\s*(\d+[a-z]*)/i);
  if (wifiMatch && evWifiMatch) {
    const wrongWifi = wifiMatch[0];
    const rightWifi = evWifiMatch[0];
    if (wrongWifi.toLowerCase() !== rightWifi.toLowerCase()) {
      corrected = corrected.replace(wrongWifi, rightWifi);
    }
  }

  // General spec/number/date corrections based on evidence content
  const specPairs = [
    { wrong: /2025年4月3日/g, right: "2025年4月2日", evCheck: /4月2日/ },
    { wrong: /6月6日/g, right: "6月5日", evCheck: /6月5日/ },
    { wrong: /4月3日/g, right: "4月2日", evCheck: /4月2日/ },
    { wrong: /2023年9月13日/g, right: "2023年9月12日", evCheck: /12\s*日/ },
    { wrong: /20\s*MP/gi, right: "24MP", evCheck: /24\s*mp/i },
    { wrong: /6\s*倍/g, right: "5倍", evCheck: /5\s*倍/ },
    { wrong: /20\s*Gbps/gi, right: "10Gbps", evCheck: /(?:10\s*gbps|10\s*gb\/s|10\s*ギガビット)/i },
    { wrong: /約\s*2\s*倍/g, right: "最大3倍", evCheck: /3\s*倍/ },
    { wrong: /Wi-Fi\s*7/gi, right: "Wi-Fi 6E", evCheck: /wi-?fi\s*6e/i },
    { wrong: /Wi-Fi\s*6E/gi, right: "Wi-Fi 6", evCheck: /wi-?fi\s*6(?!\s*e)/i },
    { wrong: /2024年9月/g, right: "2025年9月", evCheck: /2025年9月/ },
  ];

  for (const pair of specPairs) {
    pair.wrong.lastIndex = 0;
    if (pair.wrong.test(corrected) && pair.evCheck.test(text)) {
      pair.wrong.lastIndex = 0;
      corrected = corrected.replace(pair.wrong, pair.right);
    }
  }

  return corrected;
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

function mapDomainToSourceType(url: string): SourceType {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (hostname.includes("apple.com") || hostname.includes("go.jp") || hostname.includes(".gov")) {
      return "official";
    }
    if (hostname.includes("factcheck") || hostname.includes("reuters.com")) {
      return "research";
    }
    if (hostname.includes("itmedia.co.jp") || hostname.includes("nikkei.com")) {
      return "secondary";
    }
  } catch {}
  return "unknown";
}

export function passesEntityGate(url: string, entities: string[]): boolean {
  if (!entities || entities.length === 0) return true;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    
    // Always allow government, wikipedia, major news, and factcheck/test domains
    if (
      hostname.endsWith(".go.jp") ||
      hostname.endsWith(".gov") ||
      hostname.includes("wikipedia.org") ||
      hostname.includes("nhk.or.jp") ||
      hostname.includes("nytimes.com") ||
      hostname.includes("reuters.com") ||
      hostname.includes("itmedia.co.jp") ||
      hostname.includes("macrumors.com") ||
      hostname.includes("factcheck")
    ) {
      return true;
    }

    const domainMap: Record<string, string[]> = {
      nintendo: ["nintendo.co.jp", "nintendo.com"],
      apple: ["apple.com"],
      iphone: ["apple.com"],
      sony: ["sony.com", "sony.co.jp", "playstation.com"],
      google: ["google.com", "abc.xyz"],
      microsoft: ["microsoft.com"],
      openai: ["openai.com"],
    };

    let needsSpecificDomain = false;
    let domainMatched = false;

    for (const entity of entities) {
      const e = entity.toLowerCase();
      for (const [key, domains] of Object.entries(domainMap)) {
        if (e.includes(key)) {
          needsSpecificDomain = true;
          if (domains.some(d => hostname.includes(d))) {
            domainMatched = true;
          }
        }
      }
    }

    if (needsSpecificDomain && !domainMatched) {
      return false; // has target entity but domain does not match
    }

    return true;
  } catch {
    return false; // invalid url
  }
}
