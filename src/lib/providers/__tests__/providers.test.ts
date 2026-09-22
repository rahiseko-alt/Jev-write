import { describe, it, expect } from "vitest";
import {
  getLLMProvider,
  MockLLMProvider,
  OpenAILLMProvider,
} from "../llm";
import {
  getJEVClient,
  MockJEVClient,
  HTTPJEVClient,
} from "../jev";
import {
  getGoogleFactCheckClient,
  getFactCheckClient,
  MockGoogleFactCheckClient,
  HTTPGoogleFactCheckClient,
} from "../google-factcheck";
import {
  getSearchProvider,
  MockSearchProvider,
  TavilySearchProvider,
} from "../search";
import {
  getFetchProvider,
  MockFetchProvider,
  HTTPFetchProvider,
} from "../fetch";
import { RewritePlan } from "@/types";

describe("LLM Provider", () => {
  const mockLLM = new MockLLMProvider();

  it("extracts factual claims from text containing numbers and dates", async () => {
    const text =
      "近年、テクノロジーの進歩は著しく、iPhone 17は2024年9月に発売された。その一方で、価格は20万円と高価である。今後の動向から目が離せない。";
    const claims = await mockLLM.extractClaims(text);

    expect(claims.length).toBeGreaterThanOrEqual(1);
    const iphoneClaim = claims.find((c) => c.originalText.includes("iPhone 17"));
    expect(iphoneClaim).toBeDefined();
    expect(iphoneClaim?.entities).toContain("iPhone 17");
    expect(iphoneClaim?.dates).toContain("2024年9月");
    expect(iphoneClaim?.factCheckRequired).toBe(true);
  });

  it("generates effective search queries for a claim", async () => {
    const claims = await mockLLM.extractClaims("iPhone 17は2025年9月に発売された。");
    const queries = await mockLLM.generateSearchQueries(claims[0]);

    expect(queries.length).toBeGreaterThan(0);
    expect(queries.some((q) => q.includes("iPhone 17"))).toBe(true);
  });

  it("applies fact corrections and style pruning during rewrite", async () => {
    const originalText =
      "近年、スマートフォンの進化は目覚ましく、iPhone 17は2024年9月に発売されました。単なるスマートフォンのアップデートにとどまらず、価格は高騰している。今後の動向からも目が離せません。";

    const plan: RewritePlan = {
      corrections: [
        {
          claimId: "claim-1",
          originalClaim: "iPhone 17は2024年9月に発売されました",
          verdict: "CONTRADICTED",
          correctedClaim: "2024年9月に発売されたのはiPhone 16であり、iPhone 17は2025年秋の発売が見込まれています",
          correctionReason: "公式発表およびファクトチェックによる判定",
          lockedFacts: ["iPhone 17は未発売"],
          evidenceIds: ["ev-1"],
          confidence: 0.95,
        },
      ],
      styleIssues: [
        {
          ruleId: "AI003",
          ruleName: "内容のない汎用導入",
          detected: true,
          confidence: 0.95,
          severity: "medium",
          targetText: "近年、スマートフォンの進化は目覚ましく、",
          repairInstruction: "過剰な前置きを削除する",
        },
        {
          ruleId: "AI002",
          ruleName: "「単なる〜ではない」の過剰な対比",
          detected: true,
          confidence: 0.95,
          severity: "high",
          targetText: "単なるスマートフォンのアップデートにとどまらず、",
          repairInstruction: "陳腐な対比構文を取り除く",
        },
        {
          ruleId: "AI012",
          ruleName: "紋切り型の結びの言葉",
          detected: true,
          confidence: 0.95,
          severity: "high",
          targetText: "今後の動向からも目が離せません。",
          repairInstruction: "定型の結び文句を削除する",
        },
      ],
      immutableFacts: [],
      protectedQuotes: [],
      protectedNames: ["iPhone 17"],
    };

    const rewritten = await mockLLM.rewrite({ originalText, plan });
    expect(rewritten).toContain("iPhone 16");
    expect(rewritten).not.toContain("近年、スマートフォンの進化は目覚ましく、");
    expect(rewritten).not.toContain("単なるスマートフォンのアップデートにとどまらず、");
    expect(rewritten).not.toContain("今後の動向からも目が離せません");
  });

  it("factory returns MockLLMProvider when empty API key is passed", () => {
    const provider = getLLMProvider({ apiKey: "" });
    expect(provider).toBeInstanceOf(MockLLMProvider);
  });

  it("factory returns OpenAILLMProvider when API key is provided", () => {
    const provider = getLLMProvider({ apiKey: "sk-testkey123" });
    expect(provider).toBeInstanceOf(OpenAILLMProvider);
  });
});

describe("JEV Provider", () => {
  const mockJEV = new MockJEVClient();

  it("accurately detects contradiction between claim and debunking evidence", async () => {
    const result = await mockJEV.evaluateAtomicJudgment({
      state: {
        claim: { normalizedText: "iPhone 17は2025年9月に発売された" },
        evidence: {
          excerpt: "iPhone 17は未発売であり、2025年9月時点では発表されていない。",
        },
      },
      instructions: "Does the evidence support or contradict the claim?",
      criteria: ["supports", "contradicts", "says_nothing"],
    });

    expect(result.choice).toBe("contradicts");
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it("detects claim identity correctly", async () => {
    const result = await mockJEV.evaluateAtomicJudgment({
      state: {
        claimA: "iPhone 17の発売日は2026年9月である",
        claimB: "iPhone 17の発売日は2026年9月である",
      },
      instructions: "Are claim A and claim B the same fact?",
      criteria: ["same", "close_but_different", "different"],
    });

    expect(result.choice).toBe("same");
  });

  it("evaluates AI-tell style rules (AI001-AI012) via batch request", async () => {
    const textWithAITells =
      "近年、テクノロジーの進歩は著しく、私たちの生活を一変させています。単なるツールのアップデートにとどまらず、革命的です。要するに、AIは不可欠なのです。今後の動向からも目が離せません。";

    const batchReq = {
      text: textWithAITells,
      questions: [
        { id: "AI001", question: "意味の重複・結論反復" },
        { id: "AI002", question: "単なる〜ではないの対比" },
        { id: "AI003", question: "近年、〜の汎用導入" },
        { id: "AI012", question: "今後の動向から目が離せません" },
        { id: "AI005", question: "必要以上の箇条書き化" },
      ],
    };

    const batchRes = await mockJEV.evaluateBatchRules(batchReq);
    expect(batchRes.results["AI001"].detected).toBe(true);
    expect(batchRes.results["AI002"].detected).toBe(true);
    expect(batchRes.results["AI003"].detected).toBe(true);
    expect(batchRes.results["AI012"].detected).toBe(true);
    expect(batchRes.results["AI005"].detected).toBe(false);
  });

  it("supports batch evaluation called with style rules array", async () => {
    const textWithAITells = "単なるスマートフォンのアップデートにとどまらず、今後の動向からも目が離せません。";
    const rules = [
      { id: "AI002", name: "対比", jevQuestion: "単なる〜ではない" },
      { id: "AI012", name: "結び", jevQuestion: "目が離せません" },
    ];

    const results = await mockJEV.evaluateBatchRules(textWithAITells, rules);
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(2);
    expect(results.find((r: any) => r.ruleId === "AI002")?.detected).toBe(true);
    expect(results.find((r: any) => r.ruleId === "AI012")?.detected).toBe(true);
  });

  it("verifies delta meaning changes with authorization", async () => {
    const originalClaim = "iPhone 17は2024年9月に発売された";
    const revisedText = "2024年9月に発売されたのはiPhone 16であり、iPhone 17は未発売です。";
    const allowedChanges = ["2024年9月に発売されたのはiPhone 16であり、iPhone 17は未発売です。"];

    const authorizedCheck = await mockJEV.evaluateDeltaMeaningChange(
      originalClaim,
      revisedText,
      allowedChanges
    );
    expect(authorizedCheck.hasUnauthorizedChange).toBe(false);

    const unauthorizedCheck = await mockJEV.evaluateDeltaMeaningChange(
      "価格は799ドルです。",
      "価格は1299ドルです。",
      []
    );
    expect(unauthorizedCheck.hasUnauthorizedChange).toBe(true);
    expect(unauthorizedCheck.unauthorizedChangeDetected).toBe(true);
    expect(unauthorizedCheck.unauthorizedChanges.length).toBeGreaterThan(0);
  });

  it("factory returns HTTPJEVClient when URL is provided", () => {
    const client = getJEVClient({ apiUrl: "https://jev.internal.example.com" });
    expect(client).toBeInstanceOf(HTTPJEVClient);
  });

  it("factory falls back to MockJEVClient when empty URL is provided", () => {
    const client = getJEVClient({ apiUrl: "" });
    expect(client).toBeInstanceOf(MockJEVClient);
  });
});

describe("Google Fact Check Provider", () => {
  const mockFactCheck = new MockGoogleFactCheckClient();

  it("returns realistic fact checks for known claims via searchClaims and search", async () => {
    const res = await mockFactCheck.searchClaims("iPhone 17 発売日 2024年");
    expect(res.claims).toBeDefined();
    expect(res.claims!.length).toBeGreaterThan(0);

    const claim = res.claims![0];
    expect(claim.text).toContain("iPhone 17");
    expect(claim.claimReview).toBeDefined();
    expect(claim.claimReview![0].textualRating).toContain("誤り");

    const directHits = await mockFactCheck.search("iPhone 17 2024年9月");
    expect(directHits.length).toBeGreaterThan(0);
    expect(directHits[0].claim).toContain("iPhone 17");
  });

  it("returns empty result for unknown claims", async () => {
    const res = await mockFactCheck.searchClaims("まったく無関係な架空のクエリ987654321");
    expect(res.claims).toEqual([]);
  });

  it("factory returns HTTPGoogleFactCheckClient if API key is present", () => {
    const client = getGoogleFactCheckClient({ apiKey: "g-testkey" });
    expect(client).toBeInstanceOf(HTTPGoogleFactCheckClient);
  });

  it("factory returns MockGoogleFactCheckClient if API key is empty string", () => {
    const client = getGoogleFactCheckClient({ apiKey: "" });
    expect(client).toBeInstanceOf(MockGoogleFactCheckClient);
  });

  it("aliases getFactCheckClient to getGoogleFactCheckClient", () => {
    expect(getFactCheckClient).toBe(getGoogleFactCheckClient);
  });
});

describe("Search Provider", () => {
  const mockSearch = new MockSearchProvider();

  it("returns search results for iPhone 17 query", async () => {
    const res = await mockSearch.search("iPhone 17 発売日");
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results[0].content).toContain("未発売");
    // Verify iterable support
    const spread = [...res];
    expect(spread.length).toBe(res.results.length);
  });

  it("returns generic results for other queries", async () => {
    const res = await mockSearch.search("日本の人口動態 2024");
    expect(res.results.length).toBeGreaterThan(0);
  });

  it("factory returns TavilySearchProvider when API key is provided", () => {
    const provider = getSearchProvider({ apiKey: "tvly-testkey" });
    expect(provider).toBeInstanceOf(TavilySearchProvider);
  });

  it("factory falls back to MockSearchProvider when API key is empty string", () => {
    const provider = getSearchProvider({ apiKey: "" });
    expect(provider).toBeInstanceOf(MockSearchProvider);
  });
});

describe("Fetch Provider", () => {
  const mockFetch = new MockFetchProvider();

  it("fetches mock article text and metadata via fetchUrl and fetch", async () => {
    const page = await mockFetch.fetchUrl(
      "https://factcheckcenter.jp/fact-checks/iphone-17-release-date"
    );
    expect(page.statusCode).toBe(200);
    expect(page.title).toContain("iPhone 17");
    expect(page.content).toContain("誤り");
    expect(page.siteName).toBe("日本ファクトチェックセンター (JFC)");

    const page2 = await mockFetch.fetch(
      "https://factcheckcenter.jp/fact-checks/iphone-17-release-date"
    );
    expect(page2.content).toBe(page.content);
  });

  it("handles arbitrary URL gracefully", async () => {
    const page = await mockFetch.fetchUrl("https://example.com/custom/article");
    expect(page.statusCode).toBe(200);
    expect(page.content.length).toBeGreaterThan(0);
  });

  it("factory returns HTTPFetchProvider by default and MockFetchProvider when requested", () => {
    const httpProvider = getFetchProvider({}, false);
    expect(httpProvider).toBeInstanceOf(HTTPFetchProvider);

    const mockProvider = getFetchProvider({}, true);
    expect(mockProvider).toBeInstanceOf(MockFetchProvider);
  });
});
