import { describe, it, expect, vi, afterEach } from "vitest";
import { runFactPipeline } from "@/lib/pipeline/fact-pipeline";
import {
  PAGE_QUESTION,
  SAME_TARGET_CRITERIA,
  SECTION_QUESTION,
  SECTION_STAGE_TOKEN_BUDGET,
  pageQuestion,
  planPageRequests,
  routeClaim,
  sectionQuestion,
} from "@/lib/pipeline/source-selection";
import { STATE_TOKEN_BUDGET, pageTokens } from "@/lib/pipeline/support-question";
import { PAGE_RELEVANCE_THRESHOLD, RELEVANCE_THRESHOLD } from "@/lib/jev/bands";
import {
  ARTICLE,
  CLAIM,
  Page,
  askedSentences,
  claimNamed,
  fakes,
  pageCalls,
  sectionCalls,
  sentUrls,
  supportCalls,
} from "./pipeline-fakes";

/**
 * ADR-0018 (north star ③): every candidate is judged by JEV before anything
 * is left out. First each page, from its title, address and search excerpts;
 * then, section by section, the pages JEV did not rule out; then the 信頼度
 * question on the sections judged about the sentence's target. The code only
 * routes by the lines; it never matches strings to decide what is related.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe("段1: ページごとに「同じ対象か」を問う（ADR-0018）", () => {
  it("池の全ページを、1ページ1回、題名・URL・検索の抜粋だけを state にして、主張ごとの Noul で問う", async () => {
    const claims = [
      claimNamed("c1", "SIPSは2011年に電通が発表した消費行動モデルである。"),
      claimNamed("c2", "ステマ規制は2023年10月1日に施行された。"),
    ];
    const pages: Page[] = [
      { url: "https://b.example/sips", title: "SIPSとは", body: "SIPSの本文。", excerpt: "SIPSは共感から始まる。" },
      { url: "https://a.example/stema", title: "ステマ規制", body: "ステマ規制の本文。", excerpt: "ステマ告示の概要。" },
    ];
    const { options, calls } = fakes(pages, {}, { claims });

    await runFactPipeline(ARTICLE, options);

    const firsts = pageCalls(calls);
    // One request per page, in address order; nothing but the page in the state.
    expect(firsts.map((call) => call.state)).toEqual([
      { page: { title: "ステマ規制", url: "https://a.example/stema", excerpts: ["ステマ告示の概要。"] } },
      { page: { title: "SIPSとは", url: "https://b.example/sips", excerpts: ["SIPSは共感から始まる。"] } },
    ]);
    // Every claim asked of every page: one judgment each, the claim in the instructions.
    for (const call of firsts) {
      expect(call.questions).toEqual({
        c0: pageQuestion(claims[0].originalText),
        c1: pageQuestion(claims[1].originalText),
      });
    }
  });

  it("問いは「同じ対象か」の1つの判断で、境界は criteria の true/false で決める", () => {
    expect(pageQuestion("文")).toEqual({
      type: "noul",
      instructions: { claim: "文", question: PAGE_QUESTION },
      criteria: SAME_TARGET_CRITERIA,
    });
    expect(sectionQuestion("文")).toEqual({
      type: "noul",
      instructions: { claim: "文", question: SECTION_QUESTION },
      criteria: SAME_TARGET_CRITERIA,
    });
    expect(PAGE_QUESTION).toBe("`page` は、`claim` が述べている対象について述べているか。");
    expect(SECTION_QUESTION).toBe("`section` は、`claim` が述べている対象について述べているか。");
    // Same name, same field: yes, whether or not it agrees. A look-alike name, or only something else: no.
    expect(SAME_TARGET_CRITERIA.true).toContain("同じ名前で、同じ分野のもの");
    expect(SAME_TARGET_CRITERIA.true).toContain("同じか違うかは問わない");
    expect(SAME_TARGET_CRITERIA.false).toContain("名前や略語が似ているだけの別の対象");
    expect(SAME_TARGET_CRITERIA.false).toContain("別の対象だけを説明していて");
  });

  it("検索の抜粋が無いページは、本文の最初の節を抜粋の代わりに見せる", () => {
    const { requests } = planPageRequests(
      ["文"],
      [{ key: "https://x.example", title: "t", url: "https://x.example", text: "最初の段落。", excerpts: [] }]
    );

    expect(requests[0].state).toEqual({
      page: { title: "t", url: "https://x.example", excerpts: ["最初の段落。"] },
    });
  });

  it("段1の線は設定値（0.2）で、線ちょうどは通し、線未満は通さない。通さなかった数を記録に出す", async () => {
    expect(PAGE_RELEVANCE_THRESHOLD).toBe(0.2);
    expect(PAGE_RELEVANCE_THRESHOLD).toBeLessThan(RELEVANCE_THRESHOLD);
    const pages: Page[] = [
      { url: "https://example.com/on", title: "線ちょうど", body: "線ちょうどのページ。" },
      { url: "https://example.com/under", title: "線未満", body: "線未満のページ。" },
    ];
    const { options, calls } = fakes(pages, {
      page: (page) => (page.title === "線ちょうど" ? PAGE_RELEVANCE_THRESHOLD : PAGE_RELEVANCE_THRESHOLD - 0.01),
    });

    const { claims } = await runFactPipeline(ARTICLE, options);

    expect(pageCalls(calls)).toHaveLength(2);
    expect(sectionCalls(calls).map((call) => call.state.section.url)).toEqual(["https://example.com/on"]);
    expect(claims[0].evidenceTrace).toMatchObject({ found: 2, offSubject: 1, overCap: 0, unscreened: 0 });
  });
});

describe("段2: 段1を通ったページだけを節ごとに問う（ADR-0018）", () => {
  it("節ごとに1回、その節だけを state にし、そのページを通した主張だけに問う。段2を通った節だけで信頼度を問う", async () => {
    const claims = [
      claimNamed("c1", "SIPSのIはInterestである。"),
      claimNamed("c2", "ステマ規制は2023年10月1日に施行された。"),
    ];
    const sipsBody = `SIPSのIはIdentifyである。\n■AISASの説明\n${"あ".repeat(300)}。\n■別の話\nAISASは検索と共有を含む。`;
    const pages: Page[] = [
      { url: "https://example.com/sips", title: "SIPSとAISAS", body: sipsBody },
      { url: "https://example.org/stema", title: "ステマ規制", body: "ステマ告示の本文。" },
    ];
    const { options, calls } = fakes(
      pages,
      {
        page: (page, sentence) =>
          (page.title.includes("SIPS") && sentence.includes("SIPS")) ||
          (page.title.includes("ステマ") && sentence.includes("ステマ"))
            ? 0.9
            : 0.05,
        section: (section) => (section.text.includes("SIPS") || section.text.includes("ステマ") ? 0.9 : 0.1),
        support: 0.4,
      },
      { claims }
    );

    const { claims: results } = await runFactPipeline(ARTICLE, options);

    const seconds = sectionCalls(calls);
    const sipsSections = seconds.filter((call) => call.state.section.url === "https://example.com/sips");
    // The SIPS page, section by section, asked of the SIPS claim only; nothing cut away.
    expect(sipsSections.length).toBeGreaterThan(1);
    expect(sipsSections.map((call) => call.state.section.text).join("")).toBe(sipsBody);
    for (const call of sipsSections) {
      expect(Object.keys(call.state)).toEqual(["section"]);
      expect(call.state.section.title).toBe("SIPSとAISAS");
      expect(call.questions).toEqual({ c0: sectionQuestion(claims[0].originalText) });
    }
    // The page on the other matter was never read section by section for the SIPS claim.
    const stemaSections = seconds.filter((call) => call.state.section.url === "https://example.org/stema");
    expect(stemaSections.map(askedSentences)).toEqual([[claims[1].originalText]]);

    // The 信頼度 question gets the section about SIPS, not the one only about AISAS.
    const [sipsSupport, stemaSupport] = supportCalls(calls);
    expect(sipsSupport.state.claim.original).toBe(claims[0].originalText);
    const sent = sipsSupport.state.sources.flatMap((origin: any) => origin.sections.map((s: any) => s.text));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("SIPSのIはIdentify");
    expect(sent[0]).not.toContain("AISASは検索と共有");
    expect(sentUrls(stemaSupport)).toEqual(["https://example.org/stema"]);

    expect(results[0].evidenceTrace).toMatchObject({ found: 2, offSubject: 1, used: 1 });
    expect(results[1].evidenceTrace).toMatchObject({ found: 2, offSubject: 1, used: 1 });
  });

  it("文字列で対象を決めない: 主語の語を含まないページもJEVが同じ対象と答えれば通し、同じ略語を含むページもJEVが別の対象と答えれば通さない", async () => {
    const claim = claimNamed("c1", "SIPSは共感から始まる消費行動モデルである。");
    const pages: Page[] = [
      // Names the subject nowhere, yet JEV says it is about it.
      { url: "https://example.com/model", title: "共感起点の消費行動モデル", body: "共感から始まるモデルの解説。" },
      // Carries the very letters, yet JEV says it is about something else.
      { url: "https://example.com/sip", title: "SIP（Share Incentive Plan）とは", body: "SIPS制度の説明。株式報酬。" },
    ];
    const { options, calls } = fakes(
      pages,
      { page: (page) => (page.title.startsWith("共感") ? 0.8 : 0.03) },
      { claims: [claim] }
    );

    const { claims } = await runFactPipeline(ARTICLE, options);

    expect(pageCalls(calls)).toHaveLength(2);
    expect(sectionCalls(calls).map((call) => call.state.section.url)).toEqual(["https://example.com/model"]);
    expect(claims[0].evidenceTrace).toMatchObject({ offSubject: 1 });
  });

  it("段1の問いが失敗したページは捨てずに、段2で全主張に問い、判定できなかった数を記録に出す", async () => {
    const claims = [claimNamed("c1", "一つ目の文。"), claimNamed("c2", "二つ目の文。")];
    const { options, calls } = fakes(
      [{ url: "https://example.com/a", title: "a", body: "本文。" }],
      { fails: (call) => "page" in call.state, support: 0.66 },
      { claims }
    );

    const { claims: results } = await runFactPipeline(ARTICLE, options);

    expect(sectionCalls(calls).map(askedSentences)).toEqual([["一つ目の文。", "二つ目の文。"]]);
    for (const result of results) {
      expect(result.evidenceTrace).toMatchObject({ unscreened: 1, offSubject: 0 });
      expect(result.confidence).toBe(0.66);
    }
  });

  it("段2の問いが失敗したら、その問いに含まれた主張だけ数値を出さず失敗として残す", async () => {
    const claims = [claimNamed("c1", "Aについての文。"), claimNamed("c2", "Bについての文。")];
    const pages: Page[] = [
      { url: "https://example.com/a", title: "A", body: "Aの本文。" },
      { url: "https://example.com/b", title: "B", body: "Bの本文。" },
    ];
    const { options } = fakes(
      pages,
      {
        page: (page, sentence) => (sentence.startsWith(page.title) ? 0.9 : 0.01),
        fails: (call) => "section" in call.state && call.state.section.url === "https://example.com/a",
        support: 0.8,
      },
      { claims }
    );

    const { claims: results } = await runFactPipeline(ARTICLE, options);

    expect(results[0].confidence).toBeUndefined();
    expect(results[0].lookupFailed).toBe(true);
    expect(results[0].reason).toContain("JEV 503");
    expect(results[1].confidence).toBe(0.8);
  });
});

describe("段2の上限（ADR-0018）", () => {
  it("段1で対象と判定されたページが上限を超えたら、主張の検索→記事全体の検索の順と各検索の順位で入れ、残りは数と理由を記録に出す。段1にはすべてかける", async () => {
    expect(SECTION_STAGE_TOKEN_BUDGET).toBe(8 * STATE_TOKEN_BUDGET);
    // About 45,000 estimated tokens each: five fit in 240,000, the rest do not.
    // The claim's own pages sort after the article's by address, so the
    // order kept is the searches', not the addresses'.
    const long = (n: string) => `${n}。` + "い".repeat(30000);
    const own: Page[] = [0, 1, 2].map((i) => ({ url: `https://z-own${i}.example/p`, title: `own${i}`, body: long(`own${i}`) }));
    const article: Page[] = [0, 1, 2, 3, 4].map((i) => ({
      url: `https://a-doc${i}.example/p`,
      title: `doc${i}`,
      body: long(`doc${i}`),
    }));
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { options, calls } = fakes((query) => (query === "主張の問い" ? own : article), { support: 0.3 }, {
      claimQueries: () => ["主張の問い"],
      documentQueries: ["記事の検索語"],
    });

    const { claims } = await runFactPipeline(ARTICLE, options);

    // Every page was judged at the page stage.
    expect(pageCalls(calls).map((call) => call.state.page.url).sort()).toEqual(
      [...own, ...article].map((page) => page.url).sort()
    );
    // Section by section: the claim's own three, then the article's first two.
    const read = [...new Set(sectionCalls(calls).map((call) => call.state.section.url))].sort();
    expect(read).toEqual(
      [...own, article[0], article[1]].map((page) => page.url).sort()
    );
    expect(claims[0].evidenceTrace).toMatchObject({ found: 8, overCap: 3, offSubject: 0 });
    expect(claims[0].evidenceTrace?.overCapReason).toContain("段2の上限");
    expect(claims[0].evidenceTrace?.overCapReason).toContain("この主張の検索→記事全体の検索");
    // The ones left out are named in the log, in the claim's order.
    const logged = info.mock.calls.map((args) => String(args[0])).join("\n");
    expect(logged).toContain(article.slice(2).map((page) => page.url).join(" "));
  });

  it("上限は段1を通ったページにだけ、主張の順のまま当てる（自分の事実確認の結果が先。答えの無いページは通す）", () => {
    const page = (key: string, chars = 10) => ({ key, title: key, url: `https://${key}.example`, text: "あ".repeat(chars) });
    const own = [page("review")];
    const pool = [page("p1"), page("p2", 2000), page("p3"), page("p4"), page("p5")];
    const answers: Record<string, number | undefined> = { p1: 0.9, p2: 0.9, p3: 0.1, p4: undefined, p5: 0.5 };
    const budget = pageTokens(own[0]) + pageTokens(pool[0]) + pageTokens(pool[3]) + pageTokens(pool[4]);

    const routed = routeClaim({ own, pool, answerOf: (c) => answers[c.key], budget });

    expect(routed.offTarget.map((c) => c.key)).toEqual(["p3"]);
    expect(routed.unscreened.map((c) => c.key)).toEqual(["p4"]);
    // p2 is too long for what is left; the shorter ones after it still go in.
    expect(routed.taken.map((c) => c.key)).toEqual(["review", "p1", "p4", "p5"]);
    expect(routed.overCap.map((c) => c.key)).toEqual(["p2"]);
  });
});

describe("同じ入力なら、同じ資料が同じ順でJEVに渡る（ADR-0016・ADR-0018）", () => {
  it("検索が返す順が変わっても、段1・段2・信頼度の問いは同じものが同じ順で渡る", async () => {
    const pages: Page[] = [
      { url: "https://c.example/1", title: "c", body: "フリノバc。", excerpt: "c の抜粋" },
      { url: "https://www.city.nagoya.jp/1", title: "市", body: "フリノバ市。", excerpt: "市の抜粋" },
      { url: "https://a.example/1", title: "a", body: "フリノバa。", excerpt: "a の抜粋" },
      { url: "https://b.example/1", title: "b", body: "フリノバb。", excerpt: "b の抜粋" },
    ];
    const first = fakes(pages, {});
    const second = fakes(pages.slice().reverse(), {});

    await runFactPipeline(ARTICLE, first.options);
    await runFactPipeline(ARTICLE, second.options);

    expect(second.calls).toEqual(first.calls);
    expect(pageCalls(first.calls).map((call) => call.state.page.url)).toEqual([
      "https://a.example/1",
      "https://b.example/1",
      "https://c.example/1",
      "https://www.city.nagoya.jp/1",
    ]);
    expect(sentUrls(supportCalls(first.calls)[0])).toEqual([
      "https://www.city.nagoya.jp/1",
      "https://a.example/1",
      "https://b.example/1",
      "https://c.example/1",
    ]);
  });

  it("主張の文は記事の原文のまま問い、言い換えは渡さない", async () => {
    const { options, calls } = fakes([{ url: "https://example.com/a", title: "a", body: "本文。" }], {});

    await runFactPipeline(ARTICLE, options);

    for (const call of [...pageCalls(calls), ...sectionCalls(calls)]) {
      expect(askedSentences(call)).toEqual([CLAIM.originalText]);
    }
  });
});
