import { describe, it, expect, afterEach } from "vitest";
import { runFactPipeline } from "@/lib/pipeline/fact-pipeline";
import { createSourcePool } from "@/lib/pipeline/source-pool";
import { AnthropicLLMProvider } from "@/lib/providers/llm/anthropic";
import {
  CLAIM_QUERY_SYSTEM_PROMPT,
  QUERIES_PER_CLAIM,
  buildClaimQueryUserPrompt,
  cleanClaimQueries,
  readClaimQueries,
} from "@/lib/providers/llm/search-queries";
import type { Claim } from "@/types";

/**
 * ADR-0015 (north star ②): every claim gets the questions that would settle
 * it as its own searches — primary source first — written for all claims in
 * one generation. The claim's sentence is never the search, and a figure
 * under scrutiny never goes into one (#31).
 */

function claim(id: string, over: Partial<Claim> = {}): Claim {
  return {
    id,
    originalText: `${id}の原文。`,
    normalizedText: `${id}の言い換え。`,
    subject: "フリノバ",
    entities: ["フリノバ"],
    numbers: [],
    dates: [],
    importance: "normal",
    factCheckRequired: true,
    ...over,
  };
}

describe("検索の問いの指示文（ADR-0015）", () => {
  it("手順・ガイドライン・禁止事項・出力形式の順に書かれている", () => {
    const order = ["## Procedure", "## Guidelines", "## Prohibitions", "## Output"].map((heading) =>
      CLAIM_QUERY_SYSTEM_PROMPT.indexOf(heading)
    );
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("一次の出所を狙うこと、文をそのまま検索しないこと、数値を入れないことを指示している", () => {
    expect(CLAIM_QUERY_SYSTEM_PROMPT).toMatch(/primary source/);
    expect(CLAIM_QUERY_SYSTEM_PROMPT).toMatch(/Never use the claim's sentence/);
    expect(CLAIM_QUERY_SYSTEM_PROMPT).toMatch(/Never put a number, date, amount or proportion/);
    expect(CLAIM_QUERY_SYSTEM_PROMPT).toMatch(/Never invent a domain/);
    expect(CLAIM_QUERY_SYSTEM_PROMPT).toMatch(/Never put two matters into one query/);
  });

  it("全主張を1つの依頼に並べ、ID と検査中の数値を添える", () => {
    const prompt = buildClaimQueryUserPrompt([
      claim("claim-1", { numbers: ["142人"], dates: ["2025年9月"] }),
      claim("claim-2"),
    ]);
    expect(prompt).toContain("id: claim-1");
    expect(prompt).toContain("id: claim-2");
    expect(prompt).toMatch(/do NOT put these in a query\): 142人, 2025年9月/);
  });
});

describe("問いの後始末（コード側でも守る規則）", () => {
  it("検査中の数値・日付を検索語から取り除く", () => {
    const c = claim("claim-1", { numbers: ["142人"], dates: ["2004年"] });
    expect(cleanClaimQueries(c, ["フリノバ 会員数 142人", "AISAS 電通 2004年 提唱"])).toEqual([
      "フリノバ 会員数",
      "AISAS 電通 提唱",
    ]);
  });

  it("主張の文そのものは検索語にしない", () => {
    const c = claim("claim-1", {
      originalText: "フリノバの会員は増えた。",
      normalizedText: "フリノバの会員数は増加した。",
    });
    expect(cleanClaimQueries(c, ["フリノバの会員は増えた", "フリノバの会員数は増加した。", "フリノバ 会員数 公式"])).toEqual([
      "フリノバ 会員数 公式",
    ]);
  });

  it(`重複を除き、1主張あたり ${QUERIES_PER_CLAIM} 本まで`, () => {
    const c = claim("claim-1");
    expect(cleanClaimQueries(c, ["a", "a", "b", "c"])).toEqual(["a", "b"]);
  });

  it("応答を主張IDごとに読む。応答に無い主張は問い0本", () => {
    const claims = [claim("claim-1"), claim("claim-2")];
    const read = readClaimQueries({ claims: [{ id: "claim-1", queries: ["q1", "q2"] }] }, claims);
    expect(read.get("claim-1")).toEqual(["q1", "q2"]);
    expect(read.get("claim-2")).toEqual([]);
  });
});

describe("生成の呼び出しは全主張で1回", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("Anthropic に1回だけ送り、主張ごとの問いを返す", async () => {
    const bodies: any[] = [];
    globalThis.fetch = (async (_url: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => null },
        text: async () => "",
        json: async () => ({
          stop_reason: "end_turn",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                claims: [
                  { id: "claim-1", queries: ["フリノバ 公式 会員数", "フリノバ 会員 条件"] },
                  { id: "claim-2", queries: ["フリノバ 所在地 公式"] },
                ],
              }),
            },
          ],
        }),
      };
    }) as any;

    const provider = new AnthropicLLMProvider({ apiKey: "test-key" });
    const result = await provider.generateClaimQueries([claim("claim-1"), claim("claim-2")]);

    expect(bodies).toHaveLength(1);
    expect(bodies[0].system).toBe(CLAIM_QUERY_SYSTEM_PROMPT);
    expect(bodies[0]).not.toHaveProperty("temperature");
    expect(result.get("claim-1")).toEqual(["フリノバ 公式 会員数", "フリノバ 会員 条件"]);
    expect(result.get("claim-2")).toEqual(["フリノバ 所在地 公式"]);
  });
});

function pipelineFakes(opts: {
  claims: Claim[];
  claimQueries?: (claims: Claim[]) => Promise<Map<string, string[]>>;
}) {
  const searched: string[] = [];
  const claimQueryCalls: Claim[][] = [];
  const llm = {
    async extractClaims() {
      return opts.claims;
    },
    async generateDocumentQueries() {
      return ["フリノバ"];
    },
    async generateClaimQueries(claims: Claim[]) {
      claimQueryCalls.push(claims);
      if (opts.claimQueries) return opts.claimQueries(claims);
      return new Map(claims.map((c) => [c.id, [`${c.id} 一次資料`, `${c.id} 条件`]]));
    },
  };
  const search = {
    async search(query: string) {
      searched.push(query);
      // Every search finds a page that names the subject, so the article's
      // pages alone would already give every claim candidates.
      return { results: [{ url: `https://example.com/${encodeURIComponent(query)}`, title: "フリノバ" }] };
    },
  } as any;
  const fetchProvider = {
    async fetchUrl(url: string) {
      return { url, title: "フリノバ", content: "フリノバについての本文。" };
    },
  } as any;
  const factCheck = {
    async searchClaims() {
      return { claims: [] };
    },
  } as any;
  const jev = {
    async evaluateAtomicJudgment() {
      throw new Error("not used");
    },
    async ask(_state: unknown, questions: Record<string, unknown>) {
      const answers: Record<string, any> = {};
      for (const name of Object.keys(questions)) answers[name] = { type: "noul", noul: 0.9 };
      return answers;
    },
  };
  return { options: { llm, search, fetch: fetchProvider, factCheck, jev }, searched, claimQueryCalls };
}

describe("資料の探し方（ADR-0015）", () => {
  it("記事の検索語に加え、すべての主張の問いで検索する（候補があっても）", async () => {
    const claims = [claim("claim-1"), claim("claim-2"), claim("claim-3")];
    const { options, searched, claimQueryCalls } = pipelineFakes({ claims });

    const output = await runFactPipeline("本文", options as any);

    expect(claimQueryCalls).toHaveLength(1);
    expect(claimQueryCalls[0].map((c) => c.id)).toEqual(["claim-1", "claim-2", "claim-3"]);
    expect([...searched].sort()).toEqual(
      [
        "フリノバ",
        "claim-1 一次資料",
        "claim-1 条件",
        "claim-2 一次資料",
        "claim-2 条件",
        "claim-3 一次資料",
        "claim-3 条件",
      ].sort()
    );
    // The claim's sentence is never a search.
    for (const c of claims) {
      expect(searched).not.toContain(c.originalText);
      expect(searched).not.toContain(c.normalizedText);
    }
    // The trace names this claim's own questions first, then the article's.
    expect(output.claims[1].evidenceTrace?.query).toBe("claim-2 一次資料 / claim-2 条件 / フリノバ");
  });

  it("主張の問いを書けなかったときも止まらず、主張の文で検索し直さない", async () => {
    const claims = [claim("claim-1")];
    const { options, searched } = pipelineFakes({
      claims,
      claimQueries: async () => {
        throw new Error("生成に失敗");
      },
    });

    const output = await runFactPipeline("本文", options as any);

    expect(searched).toEqual(["フリノバ"]);
    expect(output.claims).toHaveLength(1);
    expect(output.claims[0].confidence).toBe(0.9);
  });
});

describe("資料の池（並行して検索しても1ページは1回だけ読む）", () => {
  it("同じページが2つの検索に同時に出ても、取得は1回", async () => {
    let fetches = 0;
    const pool = createSourcePool({
      search: {
        async search() {
          return { results: [{ url: "https://example.com/same", title: "同じ" }] };
        },
      } as any,
      fetchProvider: {
        async fetchUrl(url: string) {
          fetches++;
          await new Promise((resolve) => setTimeout(resolve, 5));
          return { url, title: "同じ", content: "本文" };
        },
      } as any,
      resultsPerQuery: 7,
    });

    await Promise.all([pool.seed(["記事の検索語"]), pool.seed(["主張の問い"])]);

    expect(fetches).toBe(1);
    expect(pool.size()).toBe(1);
    expect(pool.queries()).toEqual(["記事の検索語", "主張の問い"]);
  });
});
