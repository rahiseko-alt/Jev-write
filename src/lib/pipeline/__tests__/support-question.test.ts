import { describe, it, expect } from "vitest";
import { runFactPipeline } from "@/lib/pipeline/fact-pipeline";
import {
  STATE_TOKEN_BUDGET,
  SUPPORT_QUESTION,
  estimateTokens,
  planSupportRequests,
} from "@/lib/pipeline/support-question";
import type { Claim } from "@/types";
import type { JEVAnswer, JEVQuestion } from "@/lib/providers";

/**
 * ADR-0011: every sentence is asked one question — is the sentence as
 * written backed by the sources — and the answer is the 信頼度 as returned.
 */

const ARTICLE = "前置きの一文。フリノバの会員は9月に142人に到達した。結びの一文。";

const CLAIM: Claim = {
  id: "c1",
  originalText: "フリノバの会員は9月に142人に到達した。",
  // A paraphrase: never what JEV is asked about.
  normalizedText: "フリノバの会員数は2025年9月時点で142人である。",
  subject: "フリノバ",
  entities: ["フリノバ"],
  importance: "normal",
  factCheckRequired: true,
};

type Page = { url: string; title: string; body: string };

function fakes(pages: Page[], answer: (questions: Record<string, JEVQuestion>, call: number) => Record<string, JEVAnswer>) {
  const calls: Array<{ state: any; questions: Record<string, JEVQuestion> }> = [];

  const llm = {
    async extractClaims() {
      return [CLAIM];
    },
    async generateSearchQueries() {
      return ["フリノバ 会員数"];
    },
    async generateDocumentQueries() {
      return ["フリノバ"];
    },
  };
  const factCheck = {
    async searchClaims() {
      return { claims: [] };
    },
    async search() {
      return [];
    },
  } as any;
  const search = {
    async search() {
      return { results: pages.map((p) => ({ url: p.url, title: p.title })) };
    },
  } as any;
  const fetchProvider = {
    async fetchUrl(url: string) {
      const page = pages.find((p) => p.url === url);
      return { url, title: page?.title ?? "", content: page?.body ?? "" };
    },
  } as any;
  const jev = {
    async evaluateAtomicJudgment() {
      throw new Error("not used");
    },
    async ask(state: unknown, questions: Record<string, JEVQuestion>) {
      calls.push({ state, questions });
      return answer(questions, calls.length - 1);
    },
  };

  return { options: { llm, factCheck, search, fetch: fetchProvider, jev }, calls };
}

/** Every page said to back the sentence, very surely; the support answer as given. */
function answering(support: number | ((call: number) => number)) {
  return (questions: Record<string, JEVQuestion>, call: number) => {
    const answers: Record<string, JEVAnswer> = {};
    for (const name of Object.keys(questions)) {
      answers[name] =
        name === "support"
          ? { type: "noul", noul: typeof support === "number" ? support : support(call) }
          : {
              type: "choice",
              choice: "supports",
              confidence: 0.99,
              probabilities: { supports: 0.99, contradicts: 0.005, says_nothing: 0.005 },
            };
    }
    return answers;
  };
}

describe("JEVへの問い（ADR-0011）", () => {
  it("原文の文・記事全体・ページの本文すべてを state に入れ、1つの問いを立てる", async () => {
    // Longer than the 2,500-character excerpt that used to be sent.
    const body = "フリノバの会員について。" + "あ".repeat(6000) + "末尾の記述。";
    const { options, calls } = fakes(
      [{ url: "https://example.com/a", title: "フリノバのお知らせ", body }],
      answering(0.23)
    );

    await runFactPipeline(ARTICLE, options);

    expect(calls).toHaveLength(1);
    const { state, questions } = calls[0];
    expect(state.claim).toEqual({ original: CLAIM.originalText });
    expect(state.article).toBe(ARTICLE);
    expect(state.sources).toEqual([
      { title: "フリノバのお知らせ", url: "https://example.com/a", text: body },
    ]);
    expect(questions.support).toEqual({
      type: "noul",
      instructions: "記事の原文のこの文（claim.original）は、sources の内容で裏付けられているか。",
    });
    // The old consistency question is gone.
    expect(questions.holdsUp).toBeUndefined();
    expect(Object.values(questions).filter((q) => q.type === "noul")).toHaveLength(1);
  });

  it("返ってきた確率をそのまま信頼度にし、ページごとの数値は使わない", async () => {
    const { options } = fakes(
      [{ url: "https://example.com/a", title: "フリノバのお知らせ", body: "フリノバの会員は120人。" }],
      answering(0.16)
    );

    const { claims } = await runFactPipeline(ARTICLE, options);

    expect(claims[0].confidence).toBe(0.16);
    // The page stays as grounds for the bubble.
    expect(claims[0].evidence.map((e) => e.sourceUrl)).toEqual(["https://example.com/a"]);
  });

  it("資料が0件でも同じ問いを立てる", async () => {
    const { options, calls } = fakes([], answering(0.05));

    const { claims } = await runFactPipeline(ARTICLE, options);

    expect(calls).toHaveLength(1);
    expect(calls[0].state.sources).toEqual([]);
    expect(calls[0].state.claim).toEqual({ original: CLAIM.originalText });
    expect(calls[0].questions.support).toEqual(SUPPORT_QUESTION);
    expect(claims[0].confidence).toBe(0.05);
  });

  it("入力上限を超える分量は、本文を削らずに複数のリクエストに分け、最も高い答えを信頼度にする", async () => {
    const pages: Page[] = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/${i}`,
      title: `フリノバ ${i}`,
      body: `フリノバ${i}。` + "い".repeat(12000),
    }));
    const { options, calls } = fakes(pages, answering((call) => [0.2, 0.9, 0.4, 0.3][call] ?? 0.1));

    const { claims } = await runFactPipeline(ARTICLE, options);

    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) {
      expect(call.state.article).toBe(ARTICLE);
      expect(call.state.claim).toEqual({ original: CLAIM.originalText });
      const longest = Math.max(
        ...Object.values(call.questions).map((q) => estimateTokens(JSON.stringify(q)))
      );
      expect(estimateTokens(JSON.stringify(call.state)) + longest).toBeLessThanOrEqual(STATE_TOKEN_BUDGET);
    }
    const sent = calls.flatMap((call) => call.state.sources.map((s: any) => s.text)).join("");
    expect(sent).toBe(pages.map((p) => p.body).join(""));
    expect(claims[0].confidence).toBe(0.9);
  });

  it("失敗したら数値を作らず、失敗として残す", async () => {
    const { options } = fakes([{ url: "https://example.com/a", title: "フリノバ", body: "フリノバ。" }], () => {
      throw new Error("JEV 503");
    });

    const { claims } = await runFactPipeline(ARTICLE, options);

    expect(claims[0].confidence).toBeUndefined();
    expect(claims[0].lookupFailed).toBe(true);
    expect(claims[0].reason).toContain("JEV 503");
  });
});

describe("planSupportRequests", () => {
  it("1ページが単独で上限を超えるときは、続きものの部分に分けて全部送る", () => {
    const text = "う".repeat(50000);
    const requests = planSupportRequests({
      original: CLAIM.originalText,
      article: ARTICLE,
      pages: [{ title: "長いページ", url: "https://example.com/long", text }],
    });

    expect(requests.length).toBeGreaterThan(1);
    expect(requests.flatMap((r) => r.state.sources.map((s) => s.text)).join("")).toBe(text);
    expect(requests.every((r) => r.pages.every((page) => page === 0))).toBe(true);
    expect(requests[0].state.sources[0].part).toBe(`1/${requests.length}`);
  });

  it("収まる分量なら1回にまとめる", () => {
    const requests = planSupportRequests({
      original: CLAIM.originalText,
      article: ARTICLE,
      pages: [
        { title: "a", url: "https://example.com/a", text: "短い本文。" },
        { title: "b", url: "https://example.com/b", text: "もう一つの短い本文。" },
      ],
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].pages).toEqual([0, 1]);
  });
});
