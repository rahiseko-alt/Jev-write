import { describe, it, expect } from "vitest";
import { runFactPipeline } from "@/lib/pipeline/fact-pipeline";
import {
  REQUEST_TOKEN_BUDGET,
  SECTION_MAX_CHARS,
  STATE_TOKEN_BUDGET,
  SUPPORT_QUESTION,
  estimateTokens,
  planSupportRequests,
  readingSections,
  sectionsOf,
  splitSections,
} from "@/lib/pipeline/support-question";
import { planRelevanceRequests, prepareTargets } from "@/lib/pipeline/relevance-question";
import { RELEVANCE_THRESHOLD } from "@/lib/jev/bands";
import type { Claim } from "@/types";
import type { JEVAnswer, JEVQuestion } from "@/lib/providers";

/**
 * ADR-0011: every sentence is asked one question — is the sentence as
 * written backed by the sources — and the answer is the 信頼度 as returned.
 * ADR-0014, ADR-0022: before it, JEV says section by section which parts of
 * the pages state a fact about the sentence's aspect, and only those go into
 * that question.
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
 * the relevance question — one per claim, over one section — gets
 * `relevant(text)` for the section in the state.
 */
function answering(
  support: number | ((call: number) => number),
  relevant: (text: string) => number = () => 0.99
): Answerer {
  return (questions, call, state) => {
    const answers: Record<string, JEVAnswer> = {};
    for (const name of Object.keys(questions)) {
      answers[name] =
        name === "support"
          ? { type: "noul", noul: typeof support === "number" ? support : support(call) }
          : { type: "noul", noul: relevant(state.section.text) };
    }
    return answers;
  };
}

const relevanceCalls = (calls: Call[]) => calls.filter((call) => !("support" in call.questions));
const supportCalls = (calls: Call[]) => calls.filter((call) => "support" in call.questions);
/** The addresses of the sections in a 信頼度 question, origin by origin. */
const sentUrls = (call: Call): string[] =>
  call.state.sources.flatMap((origin: any) => origin.sections.map((s: any) => s.url));

/** Two parts of about 2,000 characters under headings: two reading sections. */
function twoParts(first: string, second: string): string {
  return `■一\n${first}${"あ".repeat(2000)}。\n■二\n${second}${"い".repeat(2000)}。\n`;
}

describe("JEVへの問い（ADR-0011・ADR-0014・ADR-0022）", () => {
  it("関連は1節1回で主張ごとに問い、信頼度は関連ありの節だけで問う", async () => {
    const related = "フリノバの会員は9月に120人だった。";
    const unrelated = "この町の天気は晴れが多い。";
    const body = twoParts(related, unrelated);
    const { options, calls } = fakes(
      [{ url: "https://example.com/a", title: "フリノバのお知らせ", body }],
      answering(0.23, (text) => (text.includes("フリノバ") ? 0.9 : 0.1))
    );

    const { claims } = await runFactPipeline(ARTICLE, options);

    const firsts = relevanceCalls(calls);
    expect(firsts).toHaveLength(2);
    // One section each, the claim asked in the question; nothing else in the state.
    expect(firsts.map((call) => call.state.section.text).join("")).toBe(body);
    for (const call of firsts) {
      expect(Object.keys(call.state)).toEqual(["section"]);
      expect(Object.keys(call.questions)).toEqual(["c1"]);
      expect((call.questions.c1.instructions as Record<string, string>).claim).toBe(CLAIM.originalText);
    }

    // Then the same 信頼度 question, with the related section only.
    const [second] = supportCalls(calls);
    expect(second.questions).toEqual({ support: SUPPORT_QUESTION });
    expect(SUPPORT_QUESTION.instructions).toBe(
      "記事の原文のこの文（claim.original）は、sources の内容で裏付けられているか。"
    );
    expect(second.state.claim).toEqual({ original: CLAIM.originalText });
    expect(second.state.article).toBeUndefined();
    // One origin, holding the one related section (ADR-0016).
    expect(second.state.sources).toHaveLength(1);
    expect(second.state.sources[0].origin).toBe("example.com");
    expect(second.state.sources[0].sections).toHaveLength(1);
    expect(second.state.sources[0].sections[0].text).toContain(related);
    expect(second.state.sources[0].sections[0].text).not.toContain(unrelated);
    expect(second.state.sources[0].sections[0]).toMatchObject({
      title: "フリノバのお知らせ",
      url: "https://example.com/a",
      primary: false,
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

  it("長いページも節を削らずに全部を問い、どの関連の問いも JEV の入力上限に収まる", async () => {
    const pages: Page[] = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/${i}`,
      title: `フリノバ ${i}`,
      body: `フリノバ${i}。` + "い".repeat(12000),
    }));
    const { options, calls } = fakes(pages, answering(0.3, () => 0.01));

    await runFactPipeline(ARTICLE, options);

    const firsts = relevanceCalls(calls);
    for (const call of firsts) {
      const questions = Object.values(call.questions);
      const cost = (q: JEVQuestion) => estimateTokens(JSON.stringify(q));
      const longest = Math.max(...questions.map(cost));
      const all = questions.reduce((sum, q) => sum + cost(q), 0);
      const state = estimateTokens(JSON.stringify(call.state));
      expect(state + longest).toBeLessThanOrEqual(STATE_TOKEN_BUDGET);
      expect(state + all).toBeLessThanOrEqual(REQUEST_TOKEN_BUDGET);
    }
    const sent = pages.map((page) =>
      firsts
        .filter((call) => call.state.section.url === page.url)
        .map((call) => call.state.section.text)
        .join("")
    );
    expect(sent).toEqual(pages.map((p) => p.body));
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

describe("資料の選び方（ADR-0016・ADR-0022）", () => {
  const reprinted = "厚生労働省は、受動喫煙の防止のための基準を定めている。".repeat(20);

  it("同じサイトのページと、本文がほぼ同じ転載は1つの出所にまとめ、一次資料かどうかを付けて、一次資料→出所→URLの順で渡す", async () => {
    const pages: Page[] = [
      { url: "https://blog.example.com/1", title: "ブログ1", body: "フリノバのブログ1。" },
      { url: "https://www.mhlw.go.jp/a", title: "厚労省", body: reprinted },
      { url: "https://news.example.net/copy", title: "転載", body: `転載記事\n${reprinted}` },
      { url: "https://example.com/2", title: "ブログ2", body: "フリノバのブログ2。" },
    ];
    const { options, calls } = fakes(pages, answering(0.6));

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

  it("主語に触れていないページも、JEVの関連の問いにかける（こちらの点数で捨てない）", async () => {
    const pages: Page[] = [{ url: "https://example.org/x", title: "受動喫煙", body: "主語の語を含まない本文。" }];
    const { options, calls } = fakes(pages, answering(0.4));

    await runFactPipeline(ARTICLE, options);

    const [relevance] = relevanceCalls(calls);
    expect(relevance.state.section.url).toBe("https://example.org/x");
  });

  it("検索が返す順位が変わっても、判定される節の組と、信頼度の問いに渡る資料と順番は同じ", async () => {
    const pages: Page[] = [
      { url: "https://c.example/1", title: "c", body: "フリノバc。" },
      { url: "https://www.city.nagoya.jp/1", title: "市", body: "フリノバ市。" },
      { url: "https://a.example/1", title: "a", body: "フリノバa。" },
      { url: "https://b.example/1", title: "b", body: "フリノバb。" },
    ];
    const first = fakes(pages, answering(0.5));
    const second = fakes(pages.slice().reverse(), answering(0.5));

    await runFactPipeline(ARTICLE, first.options);
    await runFactPipeline(ARTICLE, second.options);

    const judged = (calls: Call[]) => relevanceCalls(calls).map((call) => JSON.stringify(call)).sort();
    expect(judged(second.calls)).toEqual(judged(first.calls));
    expect(supportCalls(second.calls).map((call) => call.state)).toEqual(supportCalls(first.calls).map((call) => call.state));
    expect(sentUrls(supportCalls(first.calls)[0])).toEqual([
      "https://www.city.nagoya.jp/1",
      "https://a.example/1",
      "https://b.example/1",
      "https://c.example/1",
    ]);
  });

  it("上限で候補を落とさない: 長いページが続いても全部を関連の問いにかけ、overCap は 0", async () => {
    // About 45,000 estimated tokens each: #80's cap (120,000 per claim) took two and left three out.
    const pages: Page[] = Array.from({ length: 5 }, (_, i) => ({
      url: `https://site${i}.example/p`,
      title: `p${i}`,
      body: `フリノバ${i}。` + "い".repeat(30000),
    }));
    const { options, calls } = fakes(pages, answering(0.3, () => 0.01));

    const { claims } = await runFactPipeline(ARTICLE, options);

    const asked = new Set(relevanceCalls(calls).map((call) => call.state.section.url));
    expect([...asked].sort()).toEqual(pages.map((p) => p.url).sort());
    expect(claims[0].evidenceTrace).toMatchObject({ found: 5, overCap: 0 });
    const sections = pages.reduce((sum, p) => sum + readingSections(p.body).length, 0);
    expect(claims[0].evidenceTrace?.sections).toEqual({ candidates: sections, judged: sections, related: 0 });
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

describe("readingSections（ADR-0022: JEV が判定して読む節）", () => {
  // Like the pages measured: a short heading line every ~300 characters.
  const page = Array.from({ length: 24 }, (_, i) => `見出し${i}\n${"本文".repeat(140)}。\n`).join("");

  it("splitSections の節を読む順に 3,122字までつなぐ。つなぎ直すと本文に戻り、節の途中では切らない", () => {
    const small = splitSections(page);
    const joined = readingSections(page);

    expect(small.length).toBe(24);
    expect(joined.length).toBe(3);
    expect(joined.join("")).toBe(page);
    for (const section of joined) {
      expect(Array.from(section).length).toBeLessThanOrEqual(SECTION_MAX_CHARS);
    }
    // Every joined section is whole small sections, in order.
    let at = 0;
    for (const section of joined) {
      let rebuilt = "";
      while (rebuilt.length < section.length) rebuilt += small[at++];
      expect(rebuilt).toBe(section);
    }
  });

  it("上限を超える1節はそのまま（splitSections が上限で切っている）。空の本文は節を作らない", () => {
    expect(readingSections("")).toEqual([]);
    const long = "か".repeat(1999) + "。";
    expect(readingSections(long.repeat(3))).toEqual([long, long, long]);
  });

  it("sectionsOf はページごとの読む節を、ページの順に並べる", () => {
    const sections = sectionsOf([
      { title: "a", url: "https://example.com/a", text: page },
      { title: "b", url: "https://example.com/b", text: "短い本文。" },
    ]);
    expect(sections.map((s) => s.page)).toEqual([0, 0, 0, 1]);
  });
});

describe("planRelevanceRequests / planSupportRequests", () => {
  const section = { title: "a", url: "https://example.com/a", text: "短い本文。" };

  it("関連の問いは1節1回。その節を候補にする主張の問いを、1回にまとめる", () => {
    const targets = prepareTargets([
      { key: "c1", original: "一つ目の文。", aspect: "「フリノバ」の「数・規模・金額・割合」" },
      { key: "c2", original: "二つ目の文。" },
    ]);

    const { requests, unaskable } = planRelevanceRequests(section, targets);

    expect(unaskable).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0].state).toEqual({ section });
    expect(requests[0].keys).toEqual(["c1", "c2"]);
    expect(requests[0].questions).toEqual({ c1: targets[0].question, c2: targets[1].question });
    expect(requests[0].tokens).toBe(
      estimateTokens(JSON.stringify({ section })) + targets[0].tokens + targets[1].tokens
    );
  });

  it("問いが入力上限を超えるときだけ、同じ節のまま主張を分ける。節と1問で32kを超える主張は問えないと返す", () => {
    const targets = prepareTargets(
      Array.from({ length: 4 }, (_, i) => ({ key: `c${i}`, original: "文。".repeat(100 * (i + 1)) }))
    );
    const perQuestion = targets[1].tokens;

    const { requests } = planRelevanceRequests(section, targets, { request: perQuestion * 2 + 50 });
    expect(requests.length).toBeGreaterThan(1);
    expect(requests.flatMap((request) => request.keys)).toEqual(["c0", "c1", "c2", "c3"]);
    for (const request of requests) expect(request.state).toEqual({ section });

    const stateCost = estimateTokens(JSON.stringify({ section }));
    const tooLong = planRelevanceRequests(section, targets, { state: stateCost + targets[0].tokens });
    expect(tooLong.unaskable).toEqual(["c1", "c2", "c3"]);
    expect(tooLong.requests.flatMap((request) => request.keys)).toEqual(["c0"]);
  });

  it("節が無ければ、信頼度の問いは sources を空にして1回立てる", () => {
    const support = planSupportRequests({ original: CLAIM.originalText, sections: [] });

    expect(support).toHaveLength(1);
    expect(support[0].state).toEqual({ claim: { original: CLAIM.originalText }, sources: [] });
    expect(support[0].questions).toEqual({ support: SUPPORT_QUESTION });
  });
});
