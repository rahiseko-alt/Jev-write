import { describe, it, expect } from "vitest";
import { runFactPipeline } from "@/lib/pipeline/fact-pipeline";
import {
  REQUEST_TOKEN_BUDGET,
  SECTION_MAX_CHARS,
  STATE_TOKEN_BUDGET,
  SUPPORT_QUESTION,
  estimateTokens,
  planRelevanceRequests,
  planSupportRequests,
  relevanceQuestion,
  sectionsOf,
  splitSections,
} from "@/lib/pipeline/support-question";
import { RELEVANCE_THRESHOLD } from "@/lib/jev/bands";
import type { Claim } from "@/types";
import type { JEVAnswer, JEVQuestion } from "@/lib/providers";

/**
 * ADR-0011: every sentence is asked one question — is the sentence as
 * written backed by the sources — and the answer is the 信頼度 as returned.
 * ADR-0014: before it, JEV says section by section which parts of the pages
 * speak to the sentence, and only those go into that question.
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
type Call = { state: any; questions: Record<string, JEVQuestion> };
type Answerer = (
  questions: Record<string, JEVQuestion>,
  call: number,
  state: any
) => Record<string, JEVAnswer>;

function fakes(pages: Page[], answer: Answerer) {
  const calls: Call[] = [];

  const llm = {
    async extractClaims() {
      return [CLAIM];
    },
    async generateClaimQueries(claims: Claim[]) {
      return new Map(claims.map((c) => [c.id, ["フリノバ 会員数"]]));
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
      return answer(questions, calls.length - 1, state);
    },
  };

  return { options: { llm, factCheck, search, fetch: fetchProvider, jev }, calls };
}

/**
 * Answers as JEV would give them: the support question gets `support`, and
 * each section's relevance question gets `relevant(text)` for the section it
 * points at.
 */
function answering(
  support: number | ((call: number) => number),
  relevant: (text: string) => number = () => 0.99
): Answerer {
  return (questions, call, state) => {
    const answers: Record<string, JEVAnswer> = {};
    for (const name of Object.keys(questions)) {
      if (name === "support") {
        answers[name] = { type: "noul", noul: typeof support === "number" ? support : support(call) };
      } else {
        const index = Number(name.replace("relevant", ""));
        answers[name] = { type: "noul", noul: relevant(state.sources[index].text) };
      }
    }
    return answers;
  };
}

const relevanceCalls = (calls: Call[]) => calls.filter((call) => !("support" in call.questions));
const supportCalls = (calls: Call[]) => calls.filter((call) => "support" in call.questions);

describe("JEVへの問い（ADR-0011・ADR-0014）", () => {
  it("1回目は節ごとに関連の Noul を1回のリクエストで問い、2回目は関連する節だけで信頼度を問う", async () => {
    const related = "フリノバの会員は9月に120人だった。";
    const unrelated = "この町の天気は晴れが多い。";
    const body = `${related}\n■別の話題\n${"あ".repeat(300)}。\n■天気\n${unrelated}`;
    const { options, calls } = fakes(
      [{ url: "https://example.com/a", title: "フリノバのお知らせ", body }],
      answering(0.23, (text) => (text.includes("フリノバ") ? 0.9 : 0.1))
    );

    const { claims } = await runFactPipeline(ARTICLE, options);

    expect(calls).toHaveLength(2);
    const [first, second] = calls;

    // First: every section, one Noul each, nothing else asked.
    expect(first.state.claim).toEqual({ original: CLAIM.originalText });
    expect(first.state.article).toBeUndefined();
    expect(first.state.sources.map((s: any) => s.text).join("")).toBe(body);
    expect(first.state.sources.length).toBeGreaterThan(1);
    expect(Object.keys(first.questions)).toHaveLength(first.state.sources.length);
    first.state.sources.forEach((_: unknown, i: number) => {
      expect(first.questions[`relevant${i}`]).toEqual({
        type: "noul",
        instructions: `sources[${i}] のこの節は、claim.original と同じ事柄について述べているか。`,
      });
    });

    // Second: the same 信頼度 question, with the related section only.
    expect(second.questions).toEqual({ support: SUPPORT_QUESTION });
    expect(SUPPORT_QUESTION.instructions).toBe(
      "記事の原文のこの文（claim.original）は、sources の内容で裏付けられているか。"
    );
    expect(second.state.claim).toEqual({ original: CLAIM.originalText });
    expect(second.state.article).toBeUndefined();
    expect(second.state.sources).toHaveLength(1);
    expect(second.state.sources[0].text).toContain(related);
    expect(second.state.sources[0].text).not.toContain(unrelated);
    expect(second.state.sources[0]).toMatchObject({
      title: "フリノバのお知らせ",
      url: "https://example.com/a",
    });

    expect(claims[0].confidence).toBe(0.23);
  });

  it("関連の線は設定値で、線ちょうどは関連あり・線未満は関連なし", async () => {
    expect(RELEVANCE_THRESHOLD).toBe(0.45);
    const pages: Page[] = [
      { url: "https://example.com/on", title: "フリノバ 線上", body: "フリノバの線上の節。" },
      { url: "https://example.com/under", title: "フリノバ 線未満", body: "フリノバの線未満の節。" },
    ];
    const { options, calls } = fakes(
      pages,
      answering(0.7, (text) => (text.includes("線上") ? RELEVANCE_THRESHOLD : RELEVANCE_THRESHOLD - 0.01))
    );

    const { claims } = await runFactPipeline(ARTICLE, options);

    const [support] = supportCalls(calls);
    expect(support.state.sources.map((s: any) => s.url)).toEqual(["https://example.com/on"]);
    // The bubble lists the page holding a related section, and only it.
    expect(claims[0].evidence.map((e) => e.sourceUrl)).toEqual(["https://example.com/on"]);
    expect(claims[0].evidence[0].confidence).toBe(RELEVANCE_THRESHOLD);
    expect(claims[0].evidenceTrace).toMatchObject({ used: 1, saidNothing: 1 });
    expect(claims[0].confidence).toBe(0.7);
  });

  it("関連する節が1つも無ければ、sources を空にして同じ問いを立てる", async () => {
    const { options, calls } = fakes(
      [{ url: "https://example.com/a", title: "フリノバ", body: "フリノバとは関係のない話。" }],
      answering(0.12, () => 0.02)
    );

    const { claims } = await runFactPipeline(ARTICLE, options);

    expect(relevanceCalls(calls)).toHaveLength(1);
    const [support] = supportCalls(calls);
    expect(support.state.sources).toEqual([]);
    expect(support.questions).toEqual({ support: SUPPORT_QUESTION });
    expect(claims[0].confidence).toBe(0.12);
    expect(claims[0].evidence).toEqual([]);
  });

  it("資料が0件なら関連の問いは立てず、sources を空にして同じ問いを立てる", async () => {
    const { options, calls } = fakes([], answering(0.05));

    const { claims } = await runFactPipeline(ARTICLE, options);

    expect(calls).toHaveLength(1);
    expect(calls[0].state.sources).toEqual([]);
    expect(calls[0].state.claim).toEqual({ original: CLAIM.originalText });
    expect(calls[0].questions).toEqual({ support: SUPPORT_QUESTION });
    expect(claims[0].confidence).toBe(0.05);
  });

  it("入力上限を超える分量は、節を削らずに関連の問いを複数のリクエストに分ける", async () => {
    const pages: Page[] = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/${i}`,
      title: `フリノバ ${i}`,
      body: `フリノバ${i}。` + "い".repeat(12000),
    }));
    const { options, calls } = fakes(pages, answering(0.3, () => 0.01));

    await runFactPipeline(ARTICLE, options);

    const firsts = relevanceCalls(calls);
    expect(firsts.length).toBeGreaterThan(1);
    for (const call of firsts) {
      const questions = Object.values(call.questions);
      const cost = (q: JEVQuestion) => estimateTokens(JSON.stringify(q));
      const longest = Math.max(...questions.map(cost));
      const all = questions.reduce((sum, q) => sum + cost(q), 0);
      const state = estimateTokens(JSON.stringify(call.state));
      expect(state + longest).toBeLessThanOrEqual(STATE_TOKEN_BUDGET);
      expect(state + all).toBeLessThanOrEqual(REQUEST_TOKEN_BUDGET);
    }
    const sent = firsts.flatMap((call) => call.state.sources.map((s: any) => s.text)).join("");
    expect(sent).toBe(pages.map((p) => p.body).join(""));
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

describe("splitSections", () => {
  it("節をつなぎ直すと元の本文に1文字も欠けずに戻り、どの節も上限以内", () => {
    const text = [
      "■はじめに",
      "あ".repeat(200) + "。",
      "い".repeat(200) + "。",
      "■次の見出し",
      "う".repeat(5000) + "。" + "え".repeat(100) + "。",
      "短い結び。",
    ].join("\n");

    const sections = splitSections(text);

    expect(sections.join("")).toBe(text);
    for (const section of sections) {
      expect(Array.from(section).length).toBeLessThanOrEqual(SECTION_MAX_CHARS);
    }
  });

  it("一定の長さに達した節は、見出しで区切る", () => {
    const text = `■一\n${"あ".repeat(300)}。\n■二\n${"い".repeat(300)}。`;

    const sections = splitSections(text);

    expect(sections).toHaveLength(2);
    expect(sections[1].startsWith("■二")).toBe(true);
  });

  it("短すぎる節は見出しで区切らず、次とまとめる", () => {
    const text = `■一\n短い。\n■二\n${"い".repeat(300)}。`;

    expect(splitSections(text)).toEqual([text]);
  });

  it("長い段落は文の終わりで区切る", () => {
    const sentence = "か".repeat(1999) + "。";
    const text = sentence.repeat(3);

    expect(splitSections(text)).toEqual([sentence, sentence, sentence]);
  });

  it("空の本文は節を作らない", () => {
    expect(splitSections("")).toEqual([]);
  });
});

describe("planRelevanceRequests / planSupportRequests", () => {
  it("収まる分量なら、関連の問いは1回にまとめる", () => {
    const sections = sectionsOf([
      { title: "a", url: "https://example.com/a", text: "短い本文。" },
      { title: "b", url: "https://example.com/b", text: "もう一つの短い本文。" },
    ]);

    const requests = planRelevanceRequests({ original: CLAIM.originalText, sections });

    expect(requests).toHaveLength(1);
    expect(requests[0].sections).toEqual([0, 1]);
    expect(requests[0].questions).toEqual({
      relevant0: relevanceQuestion(0),
      relevant1: relevanceQuestion(1),
    });
  });

  it("節が無ければ関連の問いは立てず、信頼度の問いは sources を空にして1回立てる", () => {
    expect(planRelevanceRequests({ original: CLAIM.originalText, sections: [] })).toEqual([]);

    const support = planSupportRequests({ original: CLAIM.originalText, sections: [] });

    expect(support).toHaveLength(1);
    expect(support[0].state).toEqual({ claim: { original: CLAIM.originalText }, sources: [] });
    expect(support[0].questions).toEqual({ support: SUPPORT_QUESTION });
  });
});
