import { describe, it, expect, afterEach, vi } from "vitest";
import { runFactPipeline } from "@/lib/pipeline/fact-pipeline";
import {
  REQUEST_TOKEN_BUDGET,
  SECTION_MAX_CHARS,
  STATE_TOKEN_BUDGET,
  SUPPORT_QUESTION,
  estimateTokens,
  planSupportRequests,
  sectionsOf,
  splitSections,
} from "@/lib/pipeline/support-question";
import {
  RELEVANCE_WORDING,
  aspectOf,
  planRelevanceRequests,
  prepareTargets,
  relevanceQuestion,
} from "@/lib/pipeline/relevance-question";
import type { Claim } from "@/types";
import type { JEVQuestion } from "@/lib/providers";
import {
  FakeClock,
  FakePage,
  answering,
  fakeProviders,
  isRelevanceCall,
  isSupportCall,
  sentUrls,
} from "./fakes";

/**
 * ADR-0011: every sentence is asked one question — is the sentence as
 * written backed by the sources — and the answer is the 信頼度 as returned.
 * ADR-0014: before it, JEV says section by section which parts of the pages
 * speak to the sentence, and only those go into that question. ADR-0021:
 * that first question is about the point the sentence makes, one section per
 * request, a question per claim.
 */

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

afterEach(() => {
  vi.restoreAllMocks();
});

/** Runs the pipeline on the given pages, every search finding all of them. */
async function run(pages: FakePage[], answer: Parameters<typeof fakeProviders>[0]["answer"]) {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const clock = new FakeClock();
  const { options, calls } = fakeProviders({ clock, claims: [CLAIM], results: () => pages, answer });
  const output = await clock.run(runFactPipeline("前置き。フリノバの会員は9月に142人に到達した。", { ...options, clock }));
  return { ...output, calls };
}

describe("JEVへの問い（ADR-0011・ADR-0014）", () => {
  it("1回目は節ごとに1リクエストで関連を問い、2回目は関連する節だけで信頼度を問う", async () => {
    const related = "フリノバの会員は9月に120人だった。";
    const unrelated = "この町の天気は晴れが多い。";
    const body = `${related}\n■別の話題\n${"あ".repeat(300)}。\n■天気\n${unrelated}`;

    const { claims, calls } = await run(
      [{ url: "https://example.com/a", title: "フリノバのお知らせ", body }],
      answering(0.23, (section) => (section.text.includes("フリノバ") ? 0.9 : 0.1))
    );

    const relevance = calls.filter(isRelevanceCall);
    // Every section, one request each, the claim's question in it; nothing else.
    expect(relevance.length).toBeGreaterThan(1);
    expect(relevance.map((call) => call.state.section.text).join("")).toBe(body);
    for (const call of relevance) {
      expect(call.state).toEqual({ section: { title: "フリノバのお知らせ", url: "https://example.com/a", text: call.state.section.text } });
      expect(call.questions).toEqual({ c1: relevanceQuestion({ original: CLAIM.originalText, aspect: aspectOf(CLAIM) }) });
    }

    // Second: the same 信頼度 question, with the related section only.
    const [support] = calls.filter(isSupportCall);
    expect(support.questions).toEqual({ support: SUPPORT_QUESTION });
    expect(SUPPORT_QUESTION.instructions).toBe(
      "記事の原文のこの文（claim.original）は、sources の内容で裏付けられているか。"
    );
    expect(support.state.claim).toEqual({ original: CLAIM.originalText });
    expect(support.state.article).toBeUndefined();
    // One origin, holding the one related section (ADR-0016).
    expect(support.state.sources).toHaveLength(1);
    expect(support.state.sources[0].origin).toBe("example.com");
    expect(support.state.sources[0].sections).toHaveLength(1);
    expect(support.state.sources[0].sections[0].text).toContain(related);
    expect(support.state.sources[0].sections[0].text).not.toContain(unrelated);
    expect(support.state.sources[0].sections[0]).toMatchObject({
      title: "フリノバのお知らせ",
      url: "https://example.com/a",
      primary: false,
    });

    expect(claims[0].confidence).toBe(0.23);
  });

  it("資料が0件なら関連の問いは立てず、sources を空にして同じ問いを立てる", async () => {
    const { claims, calls } = await run([], answering(0.05));

    expect(calls).toHaveLength(1);
    expect(calls[0].state.sources).toEqual([]);
    expect(calls[0].state.claim).toEqual({ original: CLAIM.originalText });
    expect(calls[0].questions).toEqual({ support: SUPPORT_QUESTION });
    expect(claims[0].confidence).toBe(0.05);
  });

  it("失敗したら数値を作らず、失敗として残す", async () => {
    const { claims } = await run([{ url: "https://example.com/a", title: "フリノバ", body: "フリノバ。" }], () => {
      throw new Error("JEV 503");
    });

    expect(claims[0].confidence).toBeUndefined();
    expect(claims[0].lookupFailed).toBe(true);
    expect(claims[0].reason).toContain("JEV 503");
    // The section JEV never answered for is on the record, not dropped.
    expect(claims[0].evidenceTrace?.unjudged?.[0]).toMatchObject({
      sections: 1,
      urls: ["https://example.com/a"],
    });
    expect(claims[0].evidenceTrace?.unjudged?.[0].reason).toContain("判定の失敗");
  });
});

describe("資料の選び方（ADR-0016）", () => {
  const reprinted = "厚生労働省は、受動喫煙の防止のための基準を定めている。".repeat(20);

  it("同じサイトのページと、本文がほぼ同じ転載は1つの出所にまとめ、一次資料かどうかを付けて、一次資料→出所→URLの順で渡す", async () => {
    const pages: FakePage[] = [
      { url: "https://blog.example.com/1", title: "ブログ1", body: "フリノバのブログ1。" },
      { url: "https://www.mhlw.go.jp/a", title: "厚労省", body: reprinted },
      { url: "https://news.example.net/copy", title: "転載", body: `転載記事\n${reprinted}` },
      { url: "https://example.com/2", title: "ブログ2", body: "フリノバのブログ2。" },
    ];

    const { claims, calls } = await run(pages, answering(0.6));

    const [support] = calls.filter(isSupportCall);
    expect(support.state.sources.map((origin: any) => origin.origin)).toEqual([
      "example.net、mhlw.go.jp",
      "example.com",
    ]);
    expect(support.state.sources[0].sections.map((s: any) => [s.url, s.primary, s.primaryKind])).toEqual([
      ["https://www.mhlw.go.jp/a", true, "官公庁"],
      ["https://news.example.net/copy", false, undefined],
    ]);
    expect(sentUrls(support)).toEqual([
      "https://www.mhlw.go.jp/a",
      "https://news.example.net/copy",
      "https://blog.example.com/1",
      "https://example.com/2",
    ]);
    // Four pages, two independent origins; nothing held back before JEV.
    expect(claims[0].evidenceTrace).toMatchObject({ used: 4, origins: 2, overCap: 0 });
    // The 信頼度 is still JEV's one number, as returned (ADR-0011).
    expect(claims[0].confidence).toBe(0.6);
  });

  it("主語に触れていないページも、JEVの関連の問いにかける（こちらの点数で捨てない）", async () => {
    const pages: FakePage[] = [{ url: "https://example.org/x", title: "受動喫煙", body: "主語の語を含まない本文。" }];

    const { calls } = await run(pages, answering(0.4));

    const [relevance] = calls.filter(isRelevanceCall);
    expect(relevance.state.section.url).toBe("https://example.org/x");
  });

  it("検索が返す順が変わっても、JEVに渡る資料と順番は同じ", async () => {
    const pages: FakePage[] = [
      { url: "https://c.example/1", title: "c", body: "フリノバc。" },
      { url: "https://www.city.nagoya.jp/1", title: "市", body: "フリノバ市。" },
      { url: "https://a.example/1", title: "a", body: "フリノバa。" },
      { url: "https://b.example/1", title: "b", body: "フリノバb。" },
    ];

    const first = await run(pages, answering(0.5));
    const second = await run(pages.slice().reverse(), answering(0.5));

    expect(second.calls.filter(isSupportCall).map((call) => call.state)).toEqual(
      first.calls.filter(isSupportCall).map((call) => call.state)
    );
    expect(sentUrls(first.calls.filter(isSupportCall)[0])).toEqual([
      "https://www.city.nagoya.jp/1",
      "https://a.example/1",
      "https://b.example/1",
      "https://c.example/1",
    ]);
    // The primary source is judged first either way; the rest by rank.
    expect(first.calls.filter(isRelevanceCall)[0].state.section.url).toBe("https://www.city.nagoya.jp/1");
    expect(second.calls.filter(isRelevanceCall)[0].state.section.url).toBe("https://www.city.nagoya.jp/1");
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
  const section = { title: "a", url: "https://example.com/a", text: "短い本文。" };

  it("1つの節は、すべての主張の問いを1回のリクエストにまとめる（主張1件につき1問）", () => {
    const targets = prepareTargets([
      { key: "claim-1", original: "一つ目の文。", aspect: "「制度」の「時期・開始年・施行日・期間」" },
      { key: "claim-2", original: "二つ目の文。" },
    ]);

    const requests = planRelevanceRequests(section, targets);

    expect(requests).toHaveLength(1);
    expect(requests[0].state).toEqual({ section });
    expect(requests[0].keys).toEqual(["claim-1", "claim-2"]);
    expect(requests[0].questions["claim-2"]).toEqual({
      type: "noul",
      instructions: { claim: "二つ目の文。", question: RELEVANCE_WORDING.withoutAspect.question },
      criteria: { true: RELEVANCE_WORDING.withoutAspect.true, false: RELEVANCE_WORDING.withoutAspect.false },
    });
  });

  it("主張が多くて入力上限を超えるときだけ、同じ節のまま主張を複数のリクエストに分ける", () => {
    // About 300 estimated tokens a question: 300 of them are more than one request holds.
    const targets = prepareTargets(
      Array.from({ length: 300 }, (_, i) => ({ key: `claim-${i}`, original: `${i}番目の主張の文。`.repeat(10) }))
    );

    const requests = planRelevanceRequests(section, targets);

    expect(requests.length).toBeGreaterThan(1);
    expect(requests.flatMap((r) => r.keys)).toEqual(targets.map((t) => t.key));
    const cost = (value: unknown) => estimateTokens(JSON.stringify(value));
    for (const request of requests) {
      expect(request.state).toEqual({ section });
      const questions = Object.values(request.questions) as JEVQuestion[];
      expect(cost(request.state) + Math.max(...questions.map(cost))).toBeLessThanOrEqual(STATE_TOKEN_BUDGET);
      expect(request.tokens).toBeLessThanOrEqual(REQUEST_TOKEN_BUDGET);
    }
  });

  it("節が無ければ信頼度の問いは sources を空にして1回立てる", () => {
    const support = planSupportRequests({ original: CLAIM.originalText, sections: [] });

    expect(support).toHaveLength(1);
    expect(support[0].state).toEqual({ claim: { original: CLAIM.originalText }, sources: [] });
    expect(support[0].questions).toEqual({ support: SUPPORT_QUESTION });
  });

  it("信頼度の問いは、入力上限を超える分量のときだけ節を削らずに複数のリクエストに分ける", () => {
    const sections = sectionsOf(
      Array.from({ length: 4 }, (_, i) => ({
        title: `フリノバ ${i}`,
        url: `https://example.com/${i}`,
        text: `フリノバ${i}。` + "い".repeat(12000),
      }))
    );

    const requests = planSupportRequests({ original: CLAIM.originalText, sections });

    expect(requests.length).toBeGreaterThan(1);
    for (const request of requests) {
      const state = estimateTokens(JSON.stringify(request.state));
      expect(state + estimateTokens(JSON.stringify(SUPPORT_QUESTION))).toBeLessThanOrEqual(STATE_TOKEN_BUDGET);
    }
    const sent = requests.flatMap((r) => r.state.sources.flatMap((o) => o.sections.map((s) => s.text))).join("");
    expect(sent).toBe(sections.map((s) => s.source.text).join(""));
  });
});
