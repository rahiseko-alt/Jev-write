import { describe, it, expect, afterEach, vi } from "vitest";
import { runFactPipeline } from "@/lib/pipeline/fact-pipeline";
import { runOrchestrator } from "@/lib/pipeline/orchestrator";
import { createTimeBudget } from "@/lib/pipeline/time-budget";
import { KIND_WORDS, RELEVANCE_WORDING, aspectOf } from "@/lib/pipeline/relevance-question";
import { CLAIM_QUERY_SYSTEM_PROMPT } from "@/lib/providers/llm/search-queries";
import { SUPPORT_QUESTION } from "@/lib/pipeline/support-question";
import { RELEVANCE_THRESHOLD } from "@/lib/jev/bands";
import { JEVRequestError } from "@/lib/providers/jev/types";
import { JobStore } from "@/lib/jobs/job-store";
import {
  FakeClock,
  FakePage,
  JevCall,
  answering,
  claimOf,
  fakeProviders,
  isRelevanceCall,
  isSupportCall,
  sentUrls,
} from "./fakes";

/**
 * North star ③ (ADR-0021): every page in the pool is a candidate; JEV judges,
 * section by section, whether it speaks to each claim's own point; the
 * claims take turns; the clock, not an estimate, decides how far this gets;
 * what never got judged is listed; the 信頼度 question is asked with what JEV
 * judged related.
 */

/** Relevance calls stop at 14 s, end by 16 s; the 信頼度 questions have until 20 s. */
const SMALL_BUDGET = { deadlineMs: 20_000, supportReserveMs: 4_000, attemptTimeoutMs: 2_000, minAttemptMs: 500 };
/** One request at a time, and no rate limit in the way: the clock alone decides. */
const ONE_AT_A_TIME = { maxInFlight: 1, requestsPerMinute: 1e9, tokensPerSecond: 1e12 };

const page = (url: string, body = `${url} の本文。`, title = url): FakePage => ({ url, title, body });

afterEach(() => {
  vi.restoreAllMocks();
});

function quiet() {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  return vi.spyOn(console, "info").mockImplementation(() => {});
}

describe("時間の予算は時計で守る（ADR-0021）", () => {
  it("締め切りを過ぎたら新しい関連の判定を始めず、判定中のものが終わってから信頼度を問う", async () => {
    quiet();
    const clock = new FakeClock();
    const pages = Array.from({ length: 30 }, (_, i) => page(`https://p${String(i).padStart(2, "0")}.example/`));
    const { options, calls } = fakeProviders({
      clock,
      claims: [claimOf("claim-1")],
      results: (query) => (query === "claim-1 一次資料" ? pages : []),
      answer: answering(0.7, () => 0.9),
      latency: { jev: (call) => (isRelevanceCall(call) ? 1_000 : 100) },
    });
    const budget = createTimeBudget(clock, SMALL_BUDGET);

    const { claims, timings } = await clock.run(
      runFactPipeline("本文", { ...options, budget, jevLimits: ONE_AT_A_TIME })
    );

    const relevance = calls.filter(isRelevanceCall);
    const support = calls.filter(isSupportCall);
    // One a second from 0 s; none starts after the stop time of 14 s.
    expect(budget.relevanceStopAt).toBe(14_000);
    expect(relevance.map((call) => call.at)).toEqual(Array.from({ length: 15 }, (_, i) => i * 1_000));
    expect(relevance.every((call) => call.at <= budget.relevanceStopAt)).toBe(true);
    // The 信頼度 question comes after the last judgment ended, within the deadline.
    expect(support).toHaveLength(1);
    expect(support[0].at).toBe(15_000);
    expect(support[0].at + 100).toBeLessThanOrEqual(budget.deadlineAt);
    // It is asked with what was judged, and its answer is shown as returned.
    expect(sentUrls(support[0])).toEqual(pages.slice(0, 15).map((p) => p.url).sort());
    expect(claims[0].confidence).toBe(0.7);
    expect(claims[0].lookupFailed).toBe(false);

    const relevanceTiming = timings.find((t) => t.stage === "relevanceJudging")!;
    expect(relevanceTiming).toMatchObject({ jevCalls: 15, jevNotStarted: 15, jevFailures: 0 });
  });

  it("判定されなかった候補は、主張ごとに理由（時間切れ）と一緒に evidenceTrace とログに残す", async () => {
    const info = quiet();
    const clock = new FakeClock();
    const pages = Array.from({ length: 30 }, (_, i) => page(`https://p${String(i).padStart(2, "0")}.example/`));
    const { options } = fakeProviders({
      clock,
      claims: [claimOf("claim-1")],
      results: (query) => (query === "claim-1 一次資料" ? pages : []),
      answer: answering(0.7, () => 0.9),
      latency: { jev: (call) => (isRelevanceCall(call) ? 1_000 : 100) },
    });

    const { claims } = await clock.run(
      runFactPipeline("本文", {
        ...options,
        budget: createTimeBudget(clock, SMALL_BUDGET),
        jevLimits: ONE_AT_A_TIME,
      })
    );

    const trace = claims[0].evidenceTrace!;
    expect(trace).toMatchObject({ found: 30, sections: 30, judged: 15, relevant: 15, overCap: 0 });
    expect(trace.unjudged).toEqual([
      {
        reason: "時間切れ（開始から14秒までに関連の判定を始められなかった）",
        sections: 15,
        // In the order they were due to be judged.
        urls: pages.slice(15).map((p) => p.url),
      },
    ]);
    const logged = info.mock.calls.map((args) => String(args[0]));
    expect(logged.some((line) => line.includes("Claim claim-1") && line.includes("時間切れ"))).toBe(true);
    expect(logged.some((line) => line.startsWith("Unjudged pages (時間切れ") && line.includes(pages[15].url))).toBe(
      true
    );
  });

  it("判定中に締め切りに達したものは打ち切り、時間切れとして残す（JEVの失敗には数えない）", async () => {
    quiet();
    const clock = new FakeClock();
    let attempts = 0;
    const { options, calls } = fakeProviders({
      clock,
      claims: [claimOf("claim-1")],
      results: (query) => (query === "claim-1 一次資料" ? [page("https://a.example/")] : []),
      answer: (call) => {
        // Busy at first, asking for 15 s; the retry, sent at 15 s, is still
        // out when the relevance judgments must end (16 s).
        if (isRelevanceCall(call) && attempts++ === 0) {
          throw new JEVRequestError("529 Overloaded", { status: 529, retryAfterMs: 15_000 });
        }
        return answering(0.4)(call);
      },
      latency: { jev: (call) => (!isRelevanceCall(call) ? 100 : call.at === 0 ? 0 : 5_000) },
    });
    const budget = createTimeBudget(clock, SMALL_BUDGET);

    const { claims, timings } = await clock.run(
      runFactPipeline("本文", { ...options, budget, jevLimits: ONE_AT_A_TIME })
    );

    const relevance = calls.filter(isRelevanceCall);
    expect(relevance.map((call) => [call.at, call.timeoutMs])).toEqual([
      [0, 2_000],
      // Given only what is left before 16 s.
      [15_000, 1_000],
    ]);
    expect(claims[0].evidenceTrace?.unjudged).toEqual([
      {
        reason: "時間切れ（関連の判定の途中で、開始から16秒に達した）",
        sections: 1,
        urls: ["https://a.example/"],
      },
    ]);
    // The 信頼度 question is still asked, with what was judged: nothing.
    expect(calls.filter(isSupportCall)[0].at).toBe(16_000);
    expect(claims[0].confidence).toBe(0.4);
    expect(timings.find((t) => t.stage === "relevanceJudging")).toMatchObject({
      jevCalls: 1,
      jevRetries: 1,
      jevCutOff: 1,
      jevFailures: 0,
    });
    expect(options.jev.failureCount ?? 0).toBe(0);
  });

  it("信頼度の問いが答えを得られなければ、数値を作らず失敗として残す", async () => {
    quiet();
    const clock = new FakeClock();
    const { options } = fakeProviders({
      clock,
      claims: [claimOf("claim-1")],
      results: () => [page("https://a.example/")],
      answer: (call) => {
        if (isSupportCall(call)) throw new Error("JEV 503");
        return answering(0.9)(call);
      },
    });

    const { claims, timings } = await clock.run(runFactPipeline("本文", { ...options, clock }));

    expect(claims[0].confidence).toBeUndefined();
    expect(claims[0].lookupFailed).toBe(true);
    expect(claims[0].reason).toContain("JEV 503");
    expect(timings.find((t) => t.stage === "supportJudging")).toMatchObject({ jevCalls: 1, jevFailures: 1 });
  });

  it("JEVが混んでいる（429・5xx）と言えば、締め切りの内でだけ間を空けて送り直す", async () => {
    quiet();
    const clock = new FakeClock();
    let refusals = 0;
    const { options, calls } = fakeProviders({
      clock,
      claims: [claimOf("claim-1")],
      results: () => [page("https://a.example/")],
      answer: (call) => {
        if (isRelevanceCall(call) && refusals++ === 0) {
          throw new JEVRequestError("429 Too Many Requests", { status: 429, retryAfterMs: 1_200 });
        }
        return answering(0.66)(call);
      },
    });

    const { claims, timings } = await clock.run(runFactPipeline("本文", { ...options, clock }));

    const relevance = calls.filter(isRelevanceCall);
    expect(relevance.map((call) => call.at)).toEqual([0, 1_200]);
    expect(claims[0].confidence).toBe(0.66);
    expect(claims[0].evidenceTrace?.unjudged).toBeUndefined();
    expect(timings.find((t) => t.stage === "relevanceJudging")).toMatchObject({ jevCalls: 1, jevRetries: 1 });
    expect(options.jev.retryCount).toBe(1);
    expect(options.jev.failureCount ?? 0).toBe(0);
  });
});

describe("候補の順（ADR-0021）", () => {
  it("主張は順番に候補を出し合い、どの主張も最初の候補から判定される（取り残される主張が無い）", async () => {
    quiet();
    const clock = new FakeClock();
    const claims = ["claim-1", "claim-2", "claim-3"].map((id) => claimOf(id));
    const own = (id: string) => Array.from({ length: 4 }, (_, k) => page(`https://${id}-${k}.example/`));
    const { options, calls } = fakeProviders({
      clock,
      claims,
      results: (query) => own(query.split(" ")[0]),
      answer: answering(0.5),
      latency: { jev: (call) => (isRelevanceCall(call) ? 1_000 : 100) },
    });
    // Room for six judgments: 0 s … 5 s.
    const budget = createTimeBudget(clock, {
      deadlineMs: 11_000,
      supportReserveMs: 4_000,
      attemptTimeoutMs: 2_000,
      minAttemptMs: 500,
    });

    const result = await clock.run(runFactPipeline("本文", { ...options, budget, jevLimits: ONE_AT_A_TIME }));

    const judged = calls.filter(isRelevanceCall);
    expect(judged.map((call) => call.state.section.url)).toEqual([
      "https://claim-1-0.example/",
      "https://claim-2-0.example/",
      "https://claim-3-0.example/",
      "https://claim-1-1.example/",
      "https://claim-2-1.example/",
      "https://claim-3-1.example/",
    ]);
    // Each section is asked of every claim at once, one question each.
    for (const call of judged) expect(Object.keys(call.questions)).toEqual(["claim-1", "claim-2", "claim-3"]);
    // Every claim got its own first candidates judged; none went without.
    for (const claim of result.claims) {
      expect(claim.evidenceTrace?.judged).toBe(6);
      expect(claim.confidence).toBe(0.5);
    }
  });

  it("検索や取得が返ってくる順が違っても、JEVに問う順と渡す資料は同じ", async () => {
    quiet();
    const reprinted = "受動喫煙の防止のための基準は、所管官庁が定めている。".repeat(20);
    const results: Record<string, FakePage[]> = {
      "claim-1 一次資料": [
        page("https://blog.example.com/own-1", "ブログの本文1。"),
        page("https://news.example.net/copy", `転載記事\n${reprinted}`),
        page("https://blog.example.com/own-2", "ブログの本文2。"),
      ],
      記事の検索語: [
        page("https://shop.example.org/a", "店の本文。"),
        page("https://other.example.org/b", "別の本文。"),
        page("https://www.mhlw.go.jp/a", reprinted),
      ],
    };
    const run = async (slow: boolean) => {
      const clock = new FakeClock();
      const { options, calls } = fakeProviders({
        clock,
        claims: [claimOf("claim-1")],
        documentQueries: ["記事の検索語"],
        results: (query) => results[query] ?? [],
        answer: answering(0.6, (section) => (section.url.includes("other") ? 0.1 : 0.8)),
        latency: slow
          ? {
              search: (query) => (query === "記事の検索語" ? 900 : 10),
              fetch: (url) => 1_000 - url.length * 7,
              jev: (call) => (isRelevanceCall(call) ? 300 - call.state.section.text.length % 250 : 50),
            }
          : {},
      });
      const { claims } = await clock.run(runFactPipeline("本文", { ...options, clock }));
      return { calls, claims };
    };

    const first = await run(false);
    const second = await run(true);

    const judged = (calls: JevCall[]) => calls.filter(isRelevanceCall).map((call) => call.state);
    expect(judged(second.calls)).toEqual(judged(first.calls));
    expect(second.calls.filter(isSupportCall).map((c) => c.state)).toEqual(
      first.calls.filter(isSupportCall).map((c) => c.state)
    );
    // The primary source first, though the article's search ranked it third;
    // its reprint right after it (one origin); then this claim's own searches.
    expect(judged(first.calls).map((state) => state.section.url)).toEqual([
      "https://www.mhlw.go.jp/a",
      "https://news.example.net/copy",
      "https://blog.example.com/own-1",
      "https://blog.example.com/own-2",
      "https://shop.example.org/a",
      "https://other.example.org/b",
    ]);
    // The 信頼度 question keeps ADR-0016's fixed order, by origin.
    const [support] = first.calls.filter(isSupportCall);
    expect(support.state.sources.map((origin: any) => origin.origin)).toEqual([
      "example.net、mhlw.go.jp",
      "example.com",
      "example.org",
    ]);
    expect(first.claims[0].evidenceTrace?.origins).toBe(3);
  });

  it("関連判定の前に上限で候補を落とさない: 長いページが5つあっても全節を問う", async () => {
    quiet();
    const clock = new FakeClock();
    // About 45,000 estimated tokens each: the old ceiling (120,000) kept out three of them.
    const pages = Array.from({ length: 5 }, (_, i) => page(`https://site${i}.example/p`, `ページ${i}。` + "い".repeat(30000)));
    const { options, calls } = fakeProviders({
      clock,
      claims: [claimOf("claim-1")],
      results: () => pages,
      answer: answering(0.3, () => 0.01),
    });

    const { claims } = await clock.run(runFactPipeline("本文", { ...options, clock }));

    const asked = new Set(calls.filter(isRelevanceCall).map((call) => call.state.section.url));
    expect([...asked].sort()).toEqual(pages.map((p) => p.url).sort());
    const trace = claims[0].evidenceTrace!;
    expect(trace.overCap).toBe(0);
    expect(trace.judged).toBe(trace.sections);
    expect(trace.unjudged).toBeUndefined();
    expect(trace.saidNothing).toBe(5);
    // Sent whole: the sections asked about join back into the pages.
    const text = (url: string) =>
      calls
        .filter((call) => isRelevanceCall(call) && call.state.section.url === url)
        .map((call) => call.state.section.text)
        .join("");
    for (const p of pages) expect(text(p.url)).toBe(p.body);
  });
});

describe("信頼度の問いの上限（ADR-0021）", () => {
  it("関連ありの節は、判定した順（一次資料→この主張の検索→…）に1主張4回分まで。入り切らない分は理由と一緒に残す", async () => {
    const info = quiet();
    const clock = new FakeClock();
    // Eight pages of about 12,000 characters: some 32 sections of about
    // 4,700 estimated tokens, more than four requests hold.
    const pages = Array.from({ length: 8 }, (_, i) =>
      page(`https://site${i}.example/p`, `ページ${i}。` + "あ".repeat(12_000))
    );
    const { options, calls } = fakeProviders({
      clock,
      claims: [claimOf("claim-1")],
      results: () => pages,
      answer: answering(0.55, () => 0.9),
    });

    const { claims } = await clock.run(runFactPipeline("本文", { ...options, clock }));

    const support = calls.filter(isSupportCall);
    expect(support).toHaveLength(4);
    const trace = claims[0].evidenceTrace!;
    expect(trace.relevant).toBe(trace.sections);
    expect(trace.heldBack?.reason).toBe("信頼度の問いに入り切らなかった（関連ありと判定済み。1主張4回分の上限）");
    // What was held back is what came last in the order the claim's
    // candidates were judged in (here, the search's rank).
    const sent = new Set(support.flatMap(sentUrls));
    expect(sent.has(pages[0].url)).toBe(true);
    expect(trace.heldBack?.urls.at(-1)).toBe(pages[7].url);
    expect(trace.heldBack!.sections + support.flatMap(sentUrls).length).toBe(trace.relevant);
    // The bubble shows the pages the 信頼度 question was asked with.
    for (const evidence of claims[0].evidence) expect(sent.has(evidence.sourceUrl)).toBe(true);
    expect(claims[0].confidence).toBe(0.55);
    expect(info.mock.calls.some((args) => String(args[0]).includes("held back"))).toBe(true);
  });

  it("上限は1か所の設定値（BudgetSettings.supportRequestsPerClaim）で動く", async () => {
    quiet();
    const clock = new FakeClock();
    const pages = Array.from({ length: 3 }, (_, i) => page(`https://site${i}.example/p`, "い".repeat(12_000)));
    const { options, calls } = fakeProviders({
      clock,
      claims: [claimOf("claim-1")],
      results: () => pages,
      answer: answering(0.5),
    });

    await clock.run(
      runFactPipeline("本文", { ...options, budget: createTimeBudget(clock, { supportRequestsPerClaim: 1 }) })
    );

    expect(calls.filter(isSupportCall)).toHaveLength(1);
  });
});

describe("関連の問い（ADR-0021）", () => {
  const claim = claimOf("claim-1", {
    originalText: "申請書の提出期限は、寄附した翌年の1月10日です。",
    subject: "申請書",
  });
  const aspects = new Map([
    ["claim-1", { about: "ワンストップ特例 申請書", kind: "time", content: ["1月10日"], queries: ["ワンストップ特例 申請 期限 総務省"] }],
  ]);

  it("主張の側面（②の about と kind）を、Noul と criteria で問う。state は節だけ", async () => {
    quiet();
    const clock = new FakeClock();
    const { options, calls } = fakeProviders({
      clock,
      claims: [claim],
      claimQueries: aspects,
      results: () => [page("https://www.soumu.go.jp/a", "ワンストップ特例の申請書は、翌年1月10日までに提出します。")],
      answer: answering(0.8),
    });

    await clock.run(runFactPipeline("本文", { ...options, clock }));

    const [relevance] = calls.filter(isRelevanceCall);
    expect(relevance.state).toEqual({
      section: {
        title: "https://www.soumu.go.jp/a",
        url: "https://www.soumu.go.jp/a",
        text: "ワンストップ特例の申請書は、翌年1月10日までに提出します。",
      },
    });
    expect(relevance.questions).toEqual({
      "claim-1": {
        type: "noul",
        instructions: {
          claim: "申請書の提出期限は、寄附した翌年の1月10日です。",
          aspect: "「ワンストップ特例 申請書」の「時期・開始年・施行日・期間」",
          question: RELEVANCE_WORDING.withAspect.question,
        },
        criteria: { true: RELEVANCE_WORDING.withAspect.true, false: RELEVANCE_WORDING.withAspect.false },
      },
    });
    // Agreeing or contradicting is yes; another point of the same subject, or
    // a namesake, is no.
    expect(RELEVANCE_WORDING.withAspect.true).toContain("whether it agrees with `claim` or contradicts it");
    expect(RELEVANCE_WORDING.withAspect.false).toContain("only other points of the same broad subject");
    expect(RELEVANCE_WORDING.withAspect.false).toContain("a different target with a similar name");
    // The 信頼度 question is as it was (ADR-0011).
    const [support] = calls.filter(isSupportCall);
    expect(support.questions).toEqual({ support: SUPPORT_QUESTION });
    expect(support.state.claim).toEqual({ original: claim.originalText });
  });

  it("関連は JEV の数値だけで決まる: 主張の文をそのまま含む節も JEV が否と言えば渡さず、語の重ならない節も是と言えば渡す", async () => {
    quiet();
    const clock = new FakeClock();
    const echo = page("https://echo.example/", `${claim.originalText}ワンストップ特例の申請書について。`);
    const foreign = page("https://foreign.example/", "Lorem ipsum dolor sit amet.");
    const contra = page("https://contra.example/", "申請書の提出期限は、寄附した翌年の1月31日です。");
    // JEV's answer depends on the address alone: nothing of the text can decide it.
    const byUrl: Record<string, number> = { [echo.url]: 0.05, [foreign.url]: 0.95, [contra.url]: 0.6 };
    const { options, calls } = fakeProviders({
      clock,
      claims: [claim],
      claimQueries: aspects,
      results: () => [echo, foreign, contra],
      answer: answering(0.42, (section) => byUrl[section.url]),
    });

    const { claims } = await clock.run(runFactPipeline("本文", { ...options, clock }));

    const [support] = calls.filter(isSupportCall);
    // The contradicting section is kept (ADR-0016); the one repeating the claim is not.
    expect(sentUrls(support)).toEqual([contra.url, foreign.url]);
    expect(claims[0].evidence.map((e) => e.sourceUrl)).toEqual([contra.url, foreign.url]);
    expect(claims[0].evidence.map((e) => e.confidence)).toEqual([0.6, 0.95]);
    expect(claims[0].evidenceTrace).toMatchObject({ judged: 3, relevant: 2, used: 2, saidNothing: 1 });
    expect(claims[0].confidence).toBe(0.42);
  });

  it("側面の種類の語は、②の指示文（ADR-0019）が種類ごとに挙げた語と同じ", () => {
    expect(Object.keys(KIND_WORDS)).toEqual([
      "definition",
      "composition",
      "time",
      "quantity",
      "scope",
      "degree",
      "cause",
      "origin",
    ]);
    for (const [kind, words] of Object.entries(KIND_WORDS)) {
      expect(CLAIM_QUERY_SYSTEM_PROMPT).toContain(`${kind} (${words.split("・").join(", ")})`);
    }
    expect(aspectOf(claimOf("c", { subject: "申請書" }), { about: "ワンストップ特例", kind: "time" })).toBe(
      "「ワンストップ特例」の「時期・開始年・施行日・期間」"
    );
    // ② wrote nothing: what extraction named the subject stands in; nothing at all, no aspect.
    expect(aspectOf(claimOf("c", { subject: "申請書" }))).toBe("「申請書」");
    expect(aspectOf(claimOf("c", { subject: undefined }))).toBeUndefined();
  });

  it("関連の線は設定値（0.45）で、線ちょうどは関連あり・線未満は関連なし", async () => {
    quiet();
    const clock = new FakeClock();
    const on = page("https://on.example/", "線上の節。");
    const under = page("https://under.example/", "線未満の節。");
    const { options, calls } = fakeProviders({
      clock,
      claims: [claimOf("claim-1")],
      results: () => [on, under],
      answer: answering(0.7, (section) =>
        section.url === on.url ? RELEVANCE_THRESHOLD : RELEVANCE_THRESHOLD - 0.01
      ),
    });

    await clock.run(runFactPipeline("本文", { ...options, clock }));

    expect(RELEVANCE_THRESHOLD).toBe(0.45);
    expect(sentUrls(calls.filter(isSupportCall)[0])).toEqual([on.url]);
  });

  it("関連する節が1つも無ければ、sources を空にして同じ信頼度の問いを立てる", async () => {
    quiet();
    const clock = new FakeClock();
    const { options, calls } = fakeProviders({
      clock,
      claims: [claimOf("claim-1")],
      results: () => [page("https://a.example/")],
      answer: answering(0.12, () => 0.02),
    });

    const { claims } = await clock.run(runFactPipeline("本文", { ...options, clock }));

    const [support] = calls.filter(isSupportCall);
    expect(support.state.sources).toEqual([]);
    expect(claims[0].confidence).toBe(0.12);
    expect(claims[0].evidence).toEqual([]);
  });
});

describe("段ごとの時間（ADR-0021、観測のためだけ）", () => {
  it("抽出・問いの作成・検索・取得・関連の判定・信頼度の判定の時間と、JEVの呼び出し回数が result.timings に入る", async () => {
    quiet();
    const clock = new FakeClock();
    const claims = [claimOf("claim-1"), claimOf("claim-2")];
    const { options, calls } = fakeProviders({
      clock,
      claims,
      documentQueries: ["記事の検索語"],
      results: (query) => [page(`https://${encodeURIComponent(query)}.example/`)],
      answer: answering(0.5),
      latency: { extraction: 3_000, documentQueries: 2_000, claimQueries: 1_500, search: 200, fetch: 300, jev: 100 },
    });

    const result = await clock.run(
      runOrchestrator("本文", { ...options, clock, jobStore: new JobStore({ ttlMs: 60_000 }) })
    );

    const stage = (name: string) => result.timings.find((t) => t.stage === name);
    for (const name of ["extraction", "queryGeneration", "search", "pageFetch", "relevanceJudging", "supportJudging"]) {
      expect(stage(name)?.durationMs, name).toEqual(expect.any(Number));
    }
    expect(stage("extraction")).toMatchObject({ durationMs: 3_000, startMs: 0, endMs: 3_000 });
    // The article's queries (0–2 s) alongside the extraction, then the claims' (3–4.5 s).
    expect(stage("queryGeneration")).toMatchObject({ durationMs: 3_500, startMs: 0, endMs: 4_500 });
    // The article's search (3–3.2 s) while the claims' queries are written, then theirs (4.5–4.7 s).
    expect(stage("search")).toMatchObject({ durationMs: 400, startMs: 3_000, endMs: 4_700 });
    expect(stage("pageFetch")).toMatchObject({ durationMs: 600, startMs: 3_200, endMs: 5_000 });
    expect(stage("relevanceJudging")).toMatchObject({
      jevCalls: calls.filter(isRelevanceCall).length,
      jevRetries: 0,
      jevFailures: 0,
      jevNotStarted: 0,
    });
    expect(stage("supportJudging")).toMatchObject({ jevCalls: 2, jevFailures: 0 });
    expect(stage("FactVerification")?.durationMs).toBe(clock.now());
  });
});
