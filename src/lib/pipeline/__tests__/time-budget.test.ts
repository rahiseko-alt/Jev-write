import { describe, it, expect, vi, afterEach } from "vitest";
import { runOrchestrator } from "@/lib/pipeline/orchestrator";
import { runFactPipeline } from "@/lib/pipeline/fact-pipeline";
import { createSourcePool } from "@/lib/pipeline/source-pool";
import {
  MIN_START_MS,
  PLATFORM_LIMIT_MS,
  RUN_DEADLINE_MS,
  STAGE_CUTOFF_MS,
  TIME_UP,
  createTimeBudget,
} from "@/lib/pipeline/time-budget";
import { STAGES, StageName, StageTimer } from "@/lib/pipeline/stage-timings";
import { noticeForCutShort } from "@/lib/failure-explanation";
import { buildRevisedDocument } from "@/lib/revised-document";
import {
  FakeClock,
  FakePage,
  ServiceCall,
  claimOf,
  fakeServices,
  isRelevanceCall,
  isSupportCall,
} from "./fake-clock";

/**
 * ADR-0021: the run always answers before Vercel's 300 s. Each stage has a
 * cut-off; after it no new work of the stage starts and work still running
 * is stopped; what the clock left undone is recorded as 時間切れ; no number
 * is made up; and a run whose stages end in time is not touched at all.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

/** Every query finds two pages of its own. */
function pagesFor(query: string): FakePage[] {
  const slug = encodeURIComponent(query);
  return [
    { url: `https://a.example/${slug}`, title: `${query} A`, body: `${query}について述べた本文。` },
    { url: `https://b.example/${slug}`, title: `${query} B`, body: `${query}について別に述べた本文。` },
  ];
}

/** claim-1, claim-2, …: their sentences are the article, so each marks its own sentence. */
function claimsOf(count: number) {
  return Array.from({ length: count }, (_, i) => claimOf(`claim-${i + 1}`));
}

function articleOf(claims: { originalText: string }[]): string {
  return claims.map((claim) => claim.originalText).join("");
}

/** Which claim a JEV request is about, by its number. */
function claimNumber(call: ServiceCall): number {
  return Number(/claim-(\d+)/.exec(call.state?.claim?.original ?? "")?.[1]);
}

/** When each stage's calls must have started by, on the clock. */
function lastStart(stage: StageName, cutoffs: Record<StageName, number> = STAGE_CUTOFF_MS): number {
  return cutoffs[stage] - MIN_START_MS;
}

/** A budget whose cut-offs never come: the run as it was before them. */
const UNBOUNDED = {
  deadlineMs: Number.MAX_SAFE_INTEGER,
  cutoffMs: Object.fromEntries(STAGES.map((stage) => [stage, Number.MAX_SAFE_INTEGER])),
};

/** An article like article-05 today: 29 claims, 184–195 s in all. */
const ARTICLE_05_LIKE = {
  extraction: 100_000,
  documentQueries: 10_000,
  claimQueries: 50_000,
  search: 2_000,
  fetch: 10_000,
  factCheck: 1_000,
  jev: 10_000,
};

function quiet() {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  return warn;
}

describe("時間の設定（ADR-0021）", () => {
  it("締め切りは300秒の手前で、段の締め切りは実行の順に並び、最後が締め切りと同じ", () => {
    expect(PLATFORM_LIMIT_MS).toBe(300_000);
    expect(RUN_DEADLINE_MS).toBe(270_000);
    const cutoffs = STAGES.map((stage) => STAGE_CUTOFF_MS[stage]);
    expect(cutoffs).toEqual([170_000, 210_000, 220_000, 230_000, 235_000, 245_000, 270_000]);
    // Each stage leaves the next at least enough to start one call.
    for (let i = 1; i < cutoffs.length; i++) {
      expect(cutoffs[i] - cutoffs[i - 1]).toBeGreaterThanOrEqual(MIN_START_MS);
    }
    expect(STAGE_CUTOFF_MS.supportJudging).toBe(RUN_DEADLINE_MS);
  });

  it("締め切りが来たら新しく始めず、走っているものは止め、どちらも時間切れとして数える", async () => {
    const clock = new FakeClock();
    const budget = createTimeBudget({ clock, startedAt: 0, settings: { cutoffMs: { search: 10_000 } } });

    const slow = budget.within("search", async (signal) => {
      await clock.sleep(20_000, signal);
      if (signal.aborted) throw signal.reason;
      return "答え";
    });
    expect(await clock.run(slow)).toEqual({ status: "stopped" });
    // Stopped at the cut-off, not when the call would have ended.
    expect(clock.now()).toBe(10_000);

    let called = false;
    const late = await budget.within("search", async () => {
      called = true;
      return "答え";
    });
    expect(late).toEqual({ status: "notStarted" });
    expect(called).toBe(false);

    expect(budget.cutShort()).toEqual([{ stage: "search", notStarted: 1, stopped: 1, cutoffMs: 10_000 }]);
    budget.dispose();
  });

  it("締め切りの3秒前を過ぎたら始めない。サービス自身の失敗は時間切れにせず、そのまま投げる", async () => {
    const clock = new FakeClock(7_001);
    const budget = createTimeBudget({ clock, startedAt: 0, settings: { cutoffMs: { pageFetch: 10_000 } } });

    expect(budget.canStart("pageFetch")).toBe(false);
    expect(await budget.within("pageFetch", async () => "答え")).toEqual({ status: "notStarted" });

    const early = createTimeBudget({ clock: new FakeClock(), startedAt: 0 });
    await expect(
      early.within("pageFetch", async () => {
        throw new Error("503 Service Unavailable");
      })
    ).rejects.toThrow("503");
    expect(early.cutShort()).toEqual([]);
    budget.dispose();
    early.dispose();
  });

  it("段の時間は、重なった呼び出しを一度だけ数え、JEVの回数を数える", () => {
    const clock = new FakeClock(1_000);
    const timer = new StageTimer(clock, 0);
    const first = timer.begin("relevanceJudging", { jev: true });
    (clock as any).time = 3_000;
    const second = timer.begin("relevanceJudging", { jev: true });
    (clock as any).time = 5_000;
    first();
    (clock as any).time = 8_000;
    second();

    const timings = timer.timings({ relevanceJudging: 245_000 });
    expect(timings.map((t) => t.stage)).toEqual([...STAGES]);
    expect(timings.find((t) => t.stage === "relevanceJudging")).toEqual({
      stage: "relevanceJudging",
      durationMs: 7_000,
      startMs: 1_000,
      endMs: 8_000,
      cutoffMs: 245_000,
      calls: 2,
      jevCalls: 2,
      notStarted: 0,
      stopped: 0,
    });
    // A stage that never ran is there, with nothing.
    expect(timings.find((t) => t.stage === "extraction")).toEqual({
      stage: "extraction",
      durationMs: 0,
      calls: 0,
      jevCalls: 0,
      notStarted: 0,
      stopped: 0,
    });
  });
});

describe("時間が足りるときは何も変わらない（ADR-0021）", () => {
  async function pipelineRun(settings?: NonNullable<Parameters<typeof createTimeBudget>[0]>["settings"]) {
    const clock = new FakeClock();
    const claims = claimsOf(3);
    const fakes = fakeServices({ clock, claims, pages: pagesFor, latency: ARTICLE_05_LIKE });
    const budget = createTimeBudget({ clock, startedAt: 0, settings });
    const output = await clock.run(runFactPipeline(articleOf(claims), { ...fakes.options, budget }));
    budget.dispose();
    return { output, calls: fakes.calls, budget };
  }

  it("締め切りがあってもなくても、結果も JEV への問いも同じ", async () => {
    quiet();

    const bounded = await pipelineRun();
    const unbounded = await pipelineRun(UNBOUNDED);

    expect(bounded.output).toEqual(unbounded.output);
    const asked = (calls: ServiceCall[]) =>
      calls.filter((call) => call.service === "jev").map((call) => [call.state, call.questions]);
    expect(asked(bounded.calls)).toEqual(asked(unbounded.calls));
    expect(bounded.calls.some((call) => call.stopped)).toBe(false);
    expect(bounded.budget.cutShort()).toEqual([]);
    for (const claim of bounded.output.claims) {
      expect(claim.confidence).toBe(0.7);
      expect(claim.evidenceTrace?.unjudged).toBeUndefined();
    }
  });

  it("記事05と同じ規模・同じくらいの時間（29主張・約180秒）の実行は、何も切られず全主張に数値が付く", async () => {
    quiet();
    const clock = new FakeClock();
    const claims = claimsOf(29);
    const fakes = fakeServices({ clock, claims, pages: pagesFor, latency: ARTICLE_05_LIKE });

    const result = await clock.run(
      runOrchestrator(articleOf(claims), { ...fakes.options, clock, startedAt: 0 })
    );

    // 183 s before ADR-0022; one second more now: the 60 pages' relevance
    // requests (each asking all 29 claims) are more estimated tokens than
    // JEV's 250,000 a second, so the last of them start a second later.
    expect(clock.now()).toBe(184_000);
    expect(result.cutShort).toBeUndefined();
    expect(result.claims).toHaveLength(29);
    expect(result.claims.every((claim) => claim.confidence === 0.7)).toBe(true);
    expect(noticeForCutShort(result)).toBeNull();
  });
});

describe("段ごとの時間（ADR-0021）", () => {
  it("result.timings に6つの段（と照会）の時間と JEV の回数が出る。全体の時間も今までどおり残る", async () => {
    quiet();
    const clock = new FakeClock();
    const claims = claimsOf(3);
    const fakes = fakeServices({ clock, claims, pages: pagesFor, latency: ARTICLE_05_LIKE });

    const result = await clock.run(
      runOrchestrator(articleOf(claims), { ...fakes.options, clock, startedAt: 0 })
    );

    const byStage = Object.fromEntries(result.timings.map((timing) => [timing.stage, timing]));
    expect(result.timings.map((timing) => timing.stage)).toEqual([...STAGES, "FactVerification"]);
    // 0–100 s: extraction (and the article's queries, 0–10 s). 100–150 s:
    // the claims' queries. The article's search and pages, 100–112 s; the
    // claims', 150–162 s. Fact-check 162–163 s, relevance 163–173 s,
    // 信頼度 173–183 s.
    expect(byStage.extraction).toMatchObject({ durationMs: 100_000, startMs: 0, endMs: 100_000, jevCalls: 0 });
    expect(byStage.queryGeneration).toMatchObject({ durationMs: 60_000, startMs: 0, endMs: 150_000 });
    expect(byStage.search).toMatchObject({ durationMs: 4_000, startMs: 100_000, endMs: 152_000 });
    expect(byStage.pageFetch).toMatchObject({ durationMs: 20_000, startMs: 102_000, endMs: 162_000 });
    expect(byStage.factCheck).toMatchObject({ durationMs: 1_000, calls: 3, jevCalls: 0 });
    // One relevance request per section (ADR-0022): the article's two pages
    // and each claim's two, one section each.
    expect(byStage.relevanceJudging).toMatchObject({
      durationMs: 10_000,
      startMs: 163_000,
      endMs: 173_000,
      jevCalls: 8,
      notStarted: 0,
      stopped: 0,
      cutoffMs: 245_000,
    });
    expect(byStage.supportJudging).toMatchObject({ durationMs: 10_000, jevCalls: 3, cutoffMs: 270_000 });
    const jevCalls = fakes.calls.filter((call) => call.service === "jev").length;
    expect(byStage.relevanceJudging.jevCalls! + byStage.supportJudging.jevCalls!).toBe(jevCalls);
    expect(byStage.FactVerification).toMatchObject({ durationMs: 183_000, startMs: 0, endMs: 183_000 });
  });
});

describe("長い入力でも締め切りまでに返り、途中までの結果を記録する（ADR-0021）", () => {
  it("問いの作成・関連・信頼度が締め切りにかかっても270秒で返し、どの主張も落とさず、数値を作らない", async () => {
    const warn = quiet();
    const clock = new FakeClock();
    const claims = claimsOf(40);
    const first = `https://a.example/${encodeURIComponent("記事の検索語")}`;
    const second = `https://b.example/${encodeURIComponent("記事の検索語")}`;
    const fakes = fakeServices({
      clock,
      claims,
      pages: pagesFor,
      latency: {
        extraction: 160_000,
        documentQueries: 20_000,
        // Started at 160 s, it would end at 240 s: stopped at 210 s.
        claimQueries: 80_000,
        search: 2_000,
        fetch: 3_000,
        factCheck: 1_000,
        // Relevance starts at 211 s, one request per section asking every
        // claim (ADR-0022): the first page's is answered at 221 s, the
        // second's would end at 251 s (stopped at 245 s). The 信頼度
        // questions start at 245 s; every third claim's would end at 305 s
        // (stopped at 270 s).
        jev: (call) => {
          if (isRelevanceCall(call)) return call.state.section.url === second ? 40_000 : 10_000;
          return claimNumber(call) % 3 === 2 ? 60_000 : 5_000;
        },
      },
    });

    const result = await clock.run(
      runOrchestrator(articleOf(claims), { ...fakes.options, clock, startedAt: 0 })
    );

    // Returned at the deadline, well before the platform's limit.
    expect(clock.now()).toBe(RUN_DEADLINE_MS);
    expect(clock.now()).toBeLessThan(PLATFORM_LIMIT_MS);

    // Every claim is there, in order; none dropped.
    expect(result.claims.map((claim) => claim.claim.id)).toEqual(claims.map((claim) => claim.id));

    for (const [i, claim] of result.claims.entries()) {
      const n = i + 1;
      // The second page was not judged by the cut-off: left, for every
      // claim, with the reason. Not heard out is not "said nothing".
      expect(claim.evidenceTrace?.unjudged).toEqual({ reason: TIME_UP, sections: 1, urls: [second] });
      expect(claim.evidenceTrace?.saidNothing).toBe(0);
      if (n % 3 === 2) {
        // The 信頼度 question stopped: no number, said so.
        expect(claim.confidence).toBeUndefined();
        expect(claim.reason).toBe("時間内に信頼度の判定が終わらなかったため、確認できませんでした（時間切れ）。");
      } else {
        // Asked with what was judged: the first page.
        expect(claim.confidence).toBe(0.7);
        expect(claim.reason).toBeUndefined();
        expect(claim.evidence.map((item) => item.sourceUrl)).toEqual([first]);
      }
    }

    // The run says what was cut, stage by stage.
    expect(result.cutShort).toEqual({
      reason: TIME_UP,
      stages: [
        { stage: "queryGeneration", notStarted: 0, stopped: 1, cutoffMs: 210_000 },
        { stage: "relevanceJudging", notStarted: 0, stopped: 1, cutoffMs: 245_000 },
        { stage: "supportJudging", notStarted: 0, stopped: 13, cutoffMs: 270_000 },
      ],
    });
    // No call started after its stage's cut-off (less the least time to start one).
    for (const call of fakes.calls) {
      const stage: StageName | undefined =
        call.service === "claimQueries" || call.service === "documentQueries"
          ? "queryGeneration"
          : call.service === "search"
          ? "search"
          : call.service === "fetch"
          ? "pageFetch"
          : call.service === "factCheck"
          ? "factCheck"
          : isRelevanceCall(call)
          ? "relevanceJudging"
          : isSupportCall(call)
          ? "supportJudging"
          : "extraction";
      expect(call.at).toBeLessThanOrEqual(lastStart(stage));
      if (call.endedAt !== undefined) expect(call.endedAt).toBeLessThanOrEqual(STAGE_CUTOFF_MS[stage]);
    }
    // In the logs, with the reason.
    const logged = warn.mock.calls.map((args) => args.map(String).join(" "));
    expect(logged.some((line) => line.includes("Claim claim-1:") && line.includes(TIME_UP))).toBe(true);
    expect(logged.some((line) => line.includes(TIME_UP) && line.includes("relevanceJudging"))).toBe(true);
  });

  it("画面: 数値の無い文にも▶が付き「数値なし」と時間切れの理由が出る。途中までの結果だと知らせる", async () => {
    quiet();
    const clock = new FakeClock();
    const claims = claimsOf(3);
    const fakes = fakeServices({
      clock,
      claims,
      pages: pagesFor,
      latency: {
        extraction: 150_000,
        search: 1_000,
        fetch: 1_000,
        jev: (call) => (isSupportCall(call) && claimNumber(call) === 2 ? 200_000 : 1_000),
      },
    });

    const result = await clock.run(
      runOrchestrator(articleOf(claims), { ...fakes.options, clock, startedAt: 0 })
    );

    const view = buildRevisedDocument({ analysis: result, adoption: {} });
    const timedOut = view.findings.find((finding) => finding.originalText.startsWith("claim-2"))!;
    expect(timedOut.confidence).toBeNull();
    expect(timedOut.markKind).toBe("fact");
    expect(timedOut.lineIndex).toBeGreaterThanOrEqual(0);
    expect(timedOut.title.startsWith("信頼度 数値なし")).toBe(true);
    expect(timedOut.explanation).toContain("確認できませんでした（時間切れ）");

    const notice = noticeForCutShort(result)!;
    expect(notice.headline).toContain("途中までの結果");
    expect(notice.details).toContain("信頼度の判定（JEV）：始めなかったもの 0件・途中で止めたもの 1件");
  });

  it("文の取り出しが締め切りまでに終わらなければ、主張0件のまま170秒で返し、どの文も確かめていないと知らせる", async () => {
    const warn = quiet();
    const clock = new FakeClock();
    const claims = claimsOf(3);
    const fakes = fakeServices({ clock, claims, pages: pagesFor, latency: { extraction: 400_000 } });

    const result = await clock.run(
      runOrchestrator(articleOf(claims), { ...fakes.options, clock, startedAt: 0 })
    );

    expect(clock.now()).toBe(STAGE_CUTOFF_MS.extraction);
    expect(result.claims).toEqual([]);
    expect(result.cutShort?.stages).toEqual([
      { stage: "extraction", notStarted: 0, stopped: 1, cutoffMs: 170_000 },
    ]);
    // Nothing searched or judged after the claims never came.
    expect(fakes.calls.filter((call) => call.service !== "extraction" && call.service !== "documentQueries")).toEqual([]);

    // The screen does not read "no marks" as "nothing to look at".
    const view = buildRevisedDocument({ analysis: result, adoption: {} });
    expect(view.hasFindings).toBe(false);
    const notice = noticeForCutShort(result)!;
    expect(notice.headline).toContain("どの文もまだ確かめていません");
    expect(warn.mock.calls.some((args) => String(args[0]).includes("主張の取り出し"))).toBe(true);
  });
});

describe("締め切りの後は新しい仕事を始めない（ADR-0021）", () => {
  it("検索の締め切りを過ぎた問いは検索せず、取得の締め切りを過ぎたページは取得しない。どちらも検索の失敗にしない", async () => {
    const clock = new FakeClock(500_000);
    const budget = createTimeBudget({ clock, startedAt: 0 });
    const searched: string[] = [];
    const fetched: string[] = [];
    const pool = createSourcePool({
      search: {
        async search(query: string) {
          searched.push(query);
          return { results: [{ url: "https://example.com/a", title: "a", content: "検索の抜粋。" }] };
        },
      } as any,
      fetchProvider: {
        async fetchUrl(url: string) {
          fetched.push(url);
          return { url, title: "a", content: "本文。" };
        },
      } as any,
      resultsPerQuery: 7,
      budget,
    });

    await pool.seed(["締め切り後の問い"]);

    expect(searched).toEqual([]);
    expect(pool.size()).toBe(0);
    expect(pool.searchFailed()).toBe(false);
    expect(budget.cutShort()).toEqual([
      { stage: "search", notStarted: 1, stopped: 0, cutoffMs: STAGE_CUTOFF_MS.search },
    ]);

    // Searched in time, but the pages come after the fetch cut-off: read
    // from the search's own excerpt, as a page that could not be fetched.
    const late = createTimeBudget({
      clock,
      startedAt: 0,
      settings: { deadlineMs: 1_000_000, cutoffMs: { search: 600_000, pageFetch: 400_000 } },
    });
    const pool2 = createSourcePool({
      search: {
        async search() {
          return { results: [{ url: "https://example.com/a", title: "a", content: "検索の抜粋。" }] };
        },
      } as any,
      fetchProvider: {
        async fetchUrl(url: string) {
          fetched.push(url);
          return { url, title: "a", content: "本文。" };
        },
      } as any,
      resultsPerQuery: 7,
      budget: late,
    });
    await pool2.seed(["問い"]);
    expect(fetched).toEqual([]);
    expect(pool2.candidatesFor(["問い"]).map((page) => page.text)).toEqual(["検索の抜粋。"]);
    expect(late.cutShort().map((stage) => [stage.stage, stage.notStarted])).toEqual([["pageFetch", 1]]);
    budget.dispose();
    late.dispose();
  });

  it("関連の締め切りの後に関連の判定が始まったら、JEV に問いを送らず、どの主張も時間切れとして記録して数値を出さない", async () => {
    const warn = quiet();
    const clock = new FakeClock();
    const claims = claimsOf(2);
    const cutoffs = { ...STAGE_CUTOFF_MS, factCheck: 400_000, relevanceJudging: 100_000 };
    const fakes = fakeServices({
      clock,
      claims,
      pages: pagesFor,
      latency: { extraction: 10_000, claimQueries: 10_000, search: 1_000, fetch: 1_000, jev: 5_000 },
    });
    // claim-2's fact-check lookup ends at 121 s, after the relevance cut-off.
    // The relevance judgment, one request per section for every claim
    // (ADR-0022), starts once every lookup is done.
    const lookUp = fakes.options.factCheck.searchClaims;
    fakes.options.factCheck.searchClaims = async (query: string, language: string, limit: any) => {
      if (query.startsWith("claim-2")) await clock.sleep(99_000);
      return lookUp(query, language, limit);
    };
    const budget = createTimeBudget({ clock, startedAt: 0, settings: { cutoffMs: cutoffs } });

    const output = await clock.run(runFactPipeline(articleOf(claims), { ...fakes.options, budget }));

    expect(fakes.calls.filter(isRelevanceCall)).toEqual([]);
    // No 信頼度 question for a claim nothing could be judged for.
    expect(fakes.calls.filter(isSupportCall)).toEqual([]);
    for (const claim of output.claims) {
      expect(claim.confidence).toBeUndefined();
      expect(claim.reason).toBe("時間内に資料を判定できなかったため、確認できませんでした（時間切れ）。");
      // The article's two pages and each claim's two, one section each.
      expect(claim.evidenceTrace?.unjudged?.reason).toBe(TIME_UP);
      expect(claim.evidenceTrace?.unjudged?.sections).toBe(6);
    }
    expect(budget.cutShort()).toEqual([
      { stage: "relevanceJudging", notStarted: 6, stopped: 0, cutoffMs: 100_000 },
    ]);
    expect(warn.mock.calls.some((args) => String(args[0]).includes("Claim claim-2:"))).toBe(true);
    budget.dispose();
  });

  it("関連の判定が一部だけ終わった主張は、判定できた資料で信頼度を問い、判定できなかった資料を時間切れとして残す", async () => {
    quiet();
    const clock = new FakeClock();
    const claims = claimsOf(1);
    // Four long pages, several reading sections each: one relevance request
    // per section (ADR-0022).
    const long: FakePage[] = [0, 1, 2, 3].map((i) => ({
      url: `https://site${i}.example/p`,
      title: `p${i}`,
      body: `ふるさと納税${i}。` + "い".repeat(12_000),
    }));
    const first = (call: ServiceCall) => isRelevanceCall(call) && call.state.section.url === long[0].url;
    const fakes = fakeServices({
      clock,
      claims,
      pages: () => long,
      // Only the first page speaks to the sentence.
      answer: (call) =>
        Object.fromEntries(
          Object.keys(call.questions ?? {}).map((name) => {
            const noul = name === "support" ? 0.7 : call.state.section.url === long[0].url ? 0.9 : 0.1;
            return [name, { type: "noul", noul }];
          })
        ),
      // The first page's requests answer; the rest are still running at the
      // relevance cut-off.
      latency: { jev: (call) => (!isRelevanceCall(call) || first(call) ? 1_000 : 1_000_000) },
    });
    const budget = createTimeBudget({ clock, startedAt: 0 });

    const output = await clock.run(runFactPipeline(articleOf(claims), { ...fakes.options, budget }));

    const [claim] = output.claims;
    const relevance = fakes.calls.filter(isRelevanceCall);
    const answered = relevance.filter(first);
    expect(answered.length).toBeGreaterThan(1);
    expect(relevance.length).toBeGreaterThan(answered.length);
    // Asked with what was judged and related: the first page, and only it.
    const [support] = fakes.calls.filter(isSupportCall);
    const sent = support.state.sources.flatMap((origin: any) => origin.sections.map((s: any) => s.url));
    expect([...new Set(sent)]).toEqual([long[0].url]);
    expect(claim.confidence).toBe(0.7);
    expect(claim.evidence.map((item) => item.sourceUrl)).toEqual([long[0].url]);
    expect(claim.evidenceTrace?.unjudged).toEqual({
      reason: TIME_UP,
      sections: relevance.length - answered.length,
      urls: [long[1].url, long[2].url, long[3].url],
    });
    // Pages not heard out did not "say nothing".
    expect(claim.evidenceTrace?.saidNothing).toBe(0);
    expect(budget.cutShort()).toEqual([
      { stage: "relevanceJudging", notStarted: 0, stopped: relevance.length - answered.length, cutoffMs: 245_000 },
    ]);
    budget.dispose();
  });
});

describe("途中までの結果の知らせ（画面、ADR-0021）", () => {
  it("切られなかった結果には何も出さない", () => {
    expect(noticeForCutShort({})).toBeNull();
    expect(noticeForCutShort({ cutShort: { stages: [] } })).toBeNull();
  });

  it("段の名前を書き手の言葉で、始めなかった数・止めた数・締め切りと一緒に出す", () => {
    const notice = noticeForCutShort({
      cutShort: {
        stages: [
          { stage: "search", notStarted: 3, stopped: 1, cutoffMs: 220_000 },
          { stage: "relevanceJudging", notStarted: 0, stopped: 2, cutoffMs: 245_000 },
        ],
      },
    })!;
    expect(notice.details).toBe(
      "ウェブ検索：始めなかったもの 3件・途中で止めたもの 1件（開始から220秒で締め切り）\n" +
        "資料の関連の判定（JEV）：始めなかったもの 0件・途中で止めたもの 2件（開始から245秒で締め切り）"
    );
  });
});
