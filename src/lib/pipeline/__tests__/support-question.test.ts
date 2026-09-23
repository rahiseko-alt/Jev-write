import { describe, it, expect } from "vitest";
import { runFactPipeline } from "@/lib/pipeline/fact-pipeline";
import {
  SECTION_MAX_CHARS,
  SUPPORT_QUESTION,
  planSupportRequests,
  splitSections,
} from "@/lib/pipeline/support-question";
import { RELEVANCE_THRESHOLD } from "@/lib/jev/bands";
import {
  ARTICLE,
  CLAIM,
  Page,
  fakes,
  sectionCalls,
  sentUrls,
  supportCalls,
} from "./pipeline-fakes";

/**
 * ADR-0011: every sentence is asked one question — is the sentence as
 * written backed by the sources — and the answer is the 信頼度 as returned.
 * ADR-0018: before it, JEV says page by page and then section by section
 * which parts of the pages are about what the sentence is about, and only
 * those go into that question. ADR-0016: they go grouped by origin, in a
 * fixed order.
 */

describe("信頼度の問い（ADR-0011）", () => {
  it("段2で関連ありとされた節だけを sources にして、同じ文面の信頼度の問いを1回立てる。記事全体は渡さない", async () => {
    const related = "フリノバの会員は9月に120人だった。";
    const unrelated = "この町の天気は晴れが多い。";
    const body = `${related}\n■別の話題\n${"あ".repeat(300)}。\n■天気\n${unrelated}`;
    const { options, calls } = fakes([{ url: "https://example.com/a", title: "フリノバのお知らせ", body }], {
      section: (section) => (section.text.includes("フリノバ") ? 0.9 : 0.1),
      support: 0.23,
    });

    const { claims } = await runFactPipeline(ARTICLE, options);

    // Every section of the page was asked about, and nothing was cut away.
    expect(sectionCalls(calls).map((call) => call.state.section.text).join("")).toBe(body);

    const [support] = supportCalls(calls);
    expect(supportCalls(calls)).toHaveLength(1);
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

  it("段2の線は設定値で、線ちょうどは関連あり・線未満は関連なし", async () => {
    expect(RELEVANCE_THRESHOLD).toBe(0.45);
    const pages: Page[] = [
      { url: "https://example.com/on", title: "フリノバ 線上", body: "フリノバの線上の節。" },
      { url: "https://example.com/under", title: "フリノバ 線未満", body: "フリノバの線未満の節。" },
    ];
    const { options, calls } = fakes(pages, {
      section: (section) => (section.text.includes("線上") ? RELEVANCE_THRESHOLD : RELEVANCE_THRESHOLD - 0.01),
      support: 0.7,
    });

    const { claims } = await runFactPipeline(ARTICLE, options);

    const [support] = supportCalls(calls);
    expect(sentUrls(support)).toEqual(["https://example.com/on"]);
    // The bubble lists the page holding a related section, and only it.
    expect(claims[0].evidence.map((e) => e.sourceUrl)).toEqual(["https://example.com/on"]);
    expect(claims[0].evidence[0].confidence).toBe(RELEVANCE_THRESHOLD);
    expect(claims[0].evidenceTrace).toMatchObject({ used: 1, saidNothing: 1 });
    expect(claims[0].confidence).toBe(0.7);
  });

  it("関連する節が1つも無ければ、sources を空にして同じ問いを立てる", async () => {
    const { options, calls } = fakes(
      [{ url: "https://example.com/a", title: "フリノバ", body: "フリノバとは関係のない話。" }],
      { section: () => 0.02, support: 0.12 }
    );

    const { claims } = await runFactPipeline(ARTICLE, options);

    expect(sectionCalls(calls)).toHaveLength(1);
    const [support] = supportCalls(calls);
    expect(support.state.sources).toEqual([]);
    expect(support.questions).toEqual({ support: SUPPORT_QUESTION });
    expect(claims[0].confidence).toBe(0.12);
    expect(claims[0].evidence).toEqual([]);
  });

  it("資料が0件なら段1・段2は立てず、sources を空にして同じ問いを立てる", async () => {
    const { options, calls } = fakes([], { support: 0.05 });

    const { claims } = await runFactPipeline(ARTICLE, options);

    expect(calls).toHaveLength(1);
    expect(calls[0].state.sources).toEqual([]);
    expect(calls[0].state.claim).toEqual({ original: CLAIM.originalText });
    expect(calls[0].questions).toEqual({ support: SUPPORT_QUESTION });
    expect(claims[0].confidence).toBe(0.05);
  });

  it("JEVが答えられなければ数値を作らず、失敗として残す", async () => {
    const { options } = fakes([{ url: "https://example.com/a", title: "フリノバ", body: "フリノバ。" }], {
      fails: () => true,
    });

    const { claims } = await runFactPipeline(ARTICLE, options);

    expect(claims[0].confidence).toBeUndefined();
    expect(claims[0].lookupFailed).toBe(true);
    expect(claims[0].reason).toContain("JEV 503");
  });
});

describe("信頼度の問いへの渡し方（ADR-0016）", () => {
  const reprinted = "厚生労働省は、受動喫煙の防止のための基準を定めている。".repeat(20);

  it("同じサイトのページと、本文がほぼ同じ転載は1つの出所にまとめ、一次資料かどうかを付けて、一次資料→出所→URLの順で渡す", async () => {
    const pages: Page[] = [
      { url: "https://blog.example.com/1", title: "ブログ1", body: "フリノバのブログ1。" },
      { url: "https://www.mhlw.go.jp/a", title: "厚労省", body: reprinted },
      { url: "https://news.example.net/copy", title: "転載", body: `転載記事\n${reprinted}` },
      { url: "https://example.com/2", title: "ブログ2", body: "フリノバのブログ2。" },
    ];
    const { options, calls } = fakes(pages, { support: 0.6 });

    const { claims } = await runFactPipeline(ARTICLE, options);

    const [support] = supportCalls(calls);
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
    // Four pages, two independent origins.
    expect(claims[0].evidenceTrace).toMatchObject({ used: 4, origins: 2, overCap: 0 });
    // The 信頼度 is still JEV's one number, as returned (ADR-0011).
    expect(claims[0].confidence).toBe(0.6);
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

describe("planSupportRequests", () => {
  it("節が無ければ、信頼度の問いは sources を空にして1回立てる", () => {
    const support = planSupportRequests({ original: CLAIM.originalText, sections: [] });

    expect(support).toHaveLength(1);
    expect(support[0].state).toEqual({ claim: { original: CLAIM.originalText }, sources: [] });
    expect(support[0].questions).toEqual({ support: SUPPORT_QUESTION });
  });
});
