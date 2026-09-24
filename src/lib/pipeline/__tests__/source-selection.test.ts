import { describe, it, expect, vi, afterEach } from "vitest";
import { runFactPipeline } from "@/lib/pipeline/fact-pipeline";
import { runOrchestrator } from "@/lib/pipeline/orchestrator";
import { STAGE_CUTOFF_MS, TIME_UP, createTimeBudget } from "@/lib/pipeline/time-budget";
import { RELEVANCE_WORDING } from "@/lib/pipeline/relevance-question";
import { readingSections } from "@/lib/pipeline/support-question";
import { RELEVANCE_THRESHOLD } from "@/lib/jev/bands";
import type { Claim } from "@/types";
import type { JEVAnswer } from "@/lib/providers";
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
 * ADR-0022 (north star ③): every page of the pool is a candidate for every
 * claim; JEV judges every candidate section against the claim's aspect, in
 * a fixed order that takes the claims in turns, until the relevance cut-off;
 * what the clock left unjudged is recorded; relevance is JEV's answer, never
 * a match of strings in code.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

function quiet() {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  return warn;
}

/**
 * A page body of `blocks` parts of 1,800–2,400 characters, each under a
 * heading: two of them are over 3,122, so each is a reading section of its own.
 */
function longBody(tag: string, blocks: number): string {
  return Array.from({ length: blocks }, (_, i) => `■${tag}の見出し${i}\n${`${tag}${i}の本文。`.repeat(300)}\n`).join("");
}

const page = (url: string, body: string, title = url): FakePage => ({ url, title, body });

type RunParams = Omit<Parameters<typeof fakeServices>[0], "clock">;

async function run(params: RunParams, settings?: NonNullable<Parameters<typeof createTimeBudget>[0]>["settings"]) {
  const clock = new FakeClock();
  const fakes = fakeServices({ clock, ...params });
  const budget = createTimeBudget({ clock, startedAt: 0, settings });
  const article = params.claims.map((claim) => claim.originalText).join("");
  const output = await clock.run(runFactPipeline(article, { ...fakes.options, budget }));
  budget.dispose();
  return { output, calls: fakes.calls, budget, clock };
}

/** The relevance requests, in the order they were sent: which section, and whom it asked. */
const relevanceSent = (calls: ServiceCall[]) =>
  calls.filter(isRelevanceCall).map((call) => ({
    url: call.state.section.url as string,
    text: call.state.section.text as string,
    asked: Object.keys(call.questions ?? {}),
  }));

/** The addresses of the sections in a 信頼度 question, origin by origin. */
const supportUrls = (call: ServiceCall): string[] =>
  call.state.sources.flatMap((origin: any) => origin.sections.map((s: any) => s.url));

describe("③ 候補は池の全ページ。時間があれば全部を判定する（ADR-0022）", () => {
  it("どの主張にも池の全ページが候補で、どの節も、候補にしている全主張について JEV に問う。上限で落とさない", async () => {
    quiet();
    const claims = [claimOf("claim-1"), claimOf("claim-2"), claimOf("claim-3")];
    const pages: Record<string, FakePage[]> = {
      記事の検索語: [page("https://doc.example/long", longBody("記事", 3)), page("https://doc.example/short", "短い本文。")],
      "claim-1 一次資料": [page("https://one.example/p", "一つ目の主張の検索で見つけた本文。")],
      "claim-2 一次資料": [page("https://two.example/p", longBody("二", 2))],
      "claim-3 一次資料": [page("https://three.example/p", "三つ目の主張の検索で見つけた本文。")],
    };
    const { output, calls, budget } = await run({ claims, pages: (query) => pages[query] ?? [] });

    const allSections = Object.values(pages)
      .flat()
      .flatMap((p) => readingSections(p.body).map((text) => `${p.url}|${text}`));
    expect(allSections).toHaveLength(3 + 1 + 1 + 2 + 1);

    // Every section once, each asking every claim.
    const sent = relevanceSent(calls);
    expect(sent.map((s) => `${s.url}|${s.text}`).sort()).toEqual(allSections.slice().sort());
    for (const request of sent) expect(request.asked).toEqual(["claim-1", "claim-2", "claim-3"]);

    for (const claim of output.claims) {
      const trace = claim.evidenceTrace!;
      expect(trace.found).toBe(5);
      expect(trace.overCap).toBe(0);
      expect(trace.sections).toEqual({ candidates: 8, judged: 8, related: 8 });
      expect(trace.unjudged).toBeUndefined();
      expect(trace.unanswered).toBeUndefined();
      expect(claim.confidence).toBe(0.7);
    }
    expect(budget.cutShort()).toEqual([]);
  });

  it("文字列の一致では関連を決めない。主張と同じ語を並べた節でも JEV が関連なしと答えれば渡さず、語の重ならない節でも関連ありと答えれば渡す。食い違う節も捨てない", async () => {
    quiet();
    const sentence = "申請書の提出期限は、寄附した翌年の1月10日です。";
    const claims = [claimOf("claim-1", { originalText: sentence, subject: "ワンストップ特例" })];
    const echo = page("https://echo.example/p", `${sentence}${sentence}`);
    const english = page("https://english.example/p", "Deadline: January 10 of the following year.");
    const contrary = page("https://contrary.example/p", "申請書の提出期限は2月末です。");
    // The fake JEV answers by address alone: nothing it says depends on the words.
    const judged: Record<string, number> = { [echo.url]: 0.1, [english.url]: 0.9, [contrary.url]: 0.8 };
    const { output, calls } = await run({
      claims,
      pages: () => [echo, english, contrary],
      answer: (call) =>
        Object.fromEntries(
          Object.keys(call.questions ?? {}).map((name) => [
            name,
            { type: "noul", noul: name === "support" ? 0.6 : judged[call.state.section.url] } as JEVAnswer,
          ])
        ),
    });

    // All three were asked; none was kept out on this side.
    expect(relevanceSent(calls).map((s) => s.url).sort()).toEqual([contrary.url, echo.url, english.url].sort());
    const [support] = calls.filter(isSupportCall);
    expect(supportUrls(support).sort()).toEqual([contrary.url, english.url].sort());
    const [claim] = output.claims;
    expect(claim.evidence.map((e) => e.sourceUrl).sort()).toEqual([contrary.url, english.url].sort());
    expect(claim.evidenceTrace).toMatchObject({ used: 2, saidNothing: 1 });
    expect(claim.confidence).toBe(0.6);
    // The line is the one fixed setting, not a score of this side's.
    expect(RELEVANCE_THRESHOLD).toBe(0.45);
  });

  it("関連の問いは、②の「何について」と「事実の種類」で主張の側面を名指しする Noul＋criteria。state は節だけ", async () => {
    quiet();
    const claims = [
      claimOf("claim-1", { originalText: "申請書の提出期限は、寄附した翌年の1月10日です。" }),
      claimOf("claim-2", { originalText: "ふるさと納税は2008年に始まった。" }),
      claimOf("claim-3", { originalText: "それは広く使われている。", subject: "" }),
    ];
    const { output, calls } = await run({
      claims,
      pages: () => [page("https://example.com/p", "本文。", "題名")],
      claimQueries: (claim) =>
        claim.id === "claim-1"
          ? {
              about: "ワンストップ特例制度 申請書",
              kind: "time",
              content: ["翌年", "1月10日"],
              queries: ["ワンストップ特例制度 申請書 期限 総務省"],
            }
          : [`${claim.id} 一次資料`],
    });

    const [request] = calls.filter(isRelevanceCall);
    expect(request.state).toEqual({ section: { title: "題名", url: "https://example.com/p", text: "本文。" } });
    expect(request.questions).toEqual({
      "claim-1": {
        type: "noul",
        instructions: {
          claim: "申請書の提出期限は、寄附した翌年の1月10日です。",
          aspect: "「ワンストップ特例制度 申請書」の「時期・開始年・施行日・期間」",
          question: RELEVANCE_WORDING.withAspect.question,
        },
        criteria: { true: RELEVANCE_WORDING.withAspect.true, false: RELEVANCE_WORDING.withAspect.false },
      },
      // ② named nothing: the subject extraction named stands for what it is about.
      "claim-2": {
        type: "noul",
        instructions: {
          claim: "ふるさと納税は2008年に始まった。",
          aspect: "「ふるさと納税」",
          question: RELEVANCE_WORDING.withAspect.question,
        },
        criteria: { true: RELEVANCE_WORDING.withAspect.true, false: RELEVANCE_WORDING.withAspect.false },
      },
      // Nothing to name: the point of the sentence alone.
      "claim-3": {
        type: "noul",
        instructions: { claim: "それは広く使われている。", question: RELEVANCE_WORDING.withoutAspect.question },
        criteria: { true: RELEVANCE_WORDING.withoutAspect.true, false: RELEVANCE_WORDING.withoutAspect.false },
      },
    });
    // One judgment per question, and a contradiction counts as yes.
    expect(RELEVANCE_WORDING.withAspect.true).toContain("contradicts");
    expect(RELEVANCE_WORDING.withAspect.false).toContain("same broad subject");
    expect(RELEVANCE_WORDING.withAspect.false).toContain("similar name");
    expect(output.claims.map((claim) => claim.evidenceTrace?.aspect)).toEqual([
      "「ワンストップ特例制度 申請書」の「時期・開始年・施行日・期間」",
      "「ふるさと納税」",
      undefined,
    ]);
  });
});

describe("③ 判定の順は決まっていて、主張が順番に取る（ADR-0022）", () => {
  /** Each claim's own search finds two pages of its own; the article's search finds one. */
  function turnsPool(claims: Claim[]) {
    return (query: string): FakePage[] => {
      if (query === "記事の検索語") return [page("https://doc.example/1", "記事の検索で見つけた本文。")];
      const id = query.split(" ")[0];
      if (!claims.some((claim) => claim.id === id)) return [];
      return [page(`https://${id}.example/1`, `${id}の1ページ目。`), page(`https://${id}.example/2`, `${id}の2ページ目。`)];
    };
  }

  it("主張が1ページずつ順番に取る。どの主張も最初の候補を、どの主張の深い候補よりも先に判定する", async () => {
    quiet();
    const claims = [claimOf("claim-1"), claimOf("claim-2"), claimOf("claim-3")];
    const { calls } = await run({ claims, pages: turnsPool(claims) });

    expect(relevanceSent(calls).map((s) => s.url)).toEqual([
      "https://claim-1.example/1",
      "https://claim-2.example/1",
      "https://claim-3.example/1",
      "https://claim-1.example/2",
      "https://claim-2.example/2",
      "https://claim-3.example/2",
      "https://doc.example/1",
    ]);
  });

  it("一次資料を先に。その後はこの主張の検索→記事全体の検索→残り、各検索の順位の順。同じ出所（同じサイト・転載）はまとめる", async () => {
    quiet();
    const reprinted = "厚生労働省は、受動喫煙の防止のための基準を定めている。".repeat(20);
    const claims = [claimOf("claim-1")];
    const pages: Record<string, FakePage[]> = {
      "claim-1 一次資料": [
        page("https://blog.example.com/1", "ブログの本文。"),
        page("https://www.mhlw.go.jp/a", reprinted),
        page("https://own-site.example/p", "この主張の検索の3件目。"),
      ],
      記事の検索語: [
        page("https://news.example.net/copy", `転載記事\n${reprinted}`),
        page("https://doc-site.example/p", "記事の検索の本文。"),
        page("https://blog.example.com/2", "同じブログの別のページ。"),
      ],
    };
    const { calls } = await run({ claims, pages: (query) => pages[query] ?? [] });

    expect(relevanceSent(calls).map((s) => s.url)).toEqual([
      // The primary source, and the reprint of it with it.
      "https://www.mhlw.go.jp/a",
      "https://news.example.net/copy",
      // Then the claim's own search, by rank; one site's pages together.
      "https://blog.example.com/1",
      "https://blog.example.com/2",
      "https://own-site.example/p",
      // Then the article's.
      "https://doc-site.example/p",
    ]);
  });

  it("検索や取得が返ってきた順が違っても、同じ池なら同じ問いが同じ順で送られ、同じ節が信頼度の問いに渡る", async () => {
    quiet();
    const claims = [claimOf("claim-1"), claimOf("claim-2")];
    const pool = turnsPool(claims);
    // JEV judges half the sections related, by address: the same every run.
    const answer = (call: ServiceCall) =>
      Object.fromEntries(
        Object.keys(call.questions ?? {}).map((name) => [
          name,
          {
            type: "noul",
            noul: name === "support" ? 0.7 : call.state.section.url.endsWith("/1") ? 0.9 : 0.2,
          } as JEVAnswer,
        ])
      );
    const fast = await run({ claims, pages: pool, answer, latency: { search: 1_000, fetch: 1_000, jev: 1_000 } });
    const slow = await run({
      claims,
      pages: pool,
      answer,
      latency: {
        // Searches and pages come back in another order.
        search: (query) => (query.startsWith("claim-1") ? 5_000 : 1_000),
        fetch: (url) => (url.endsWith("/1") ? 4_000 : 500),
        jev: (call) => (isSupportCall(call) ? 3_000 : 1_000),
      },
    });

    const asked = (calls: ServiceCall[]) =>
      calls.filter((call) => call.service === "jev").map((call) => [call.state, call.questions]);
    expect(asked(slow.calls)).toEqual(asked(fast.calls));
    expect(slow.output.claims.map((c) => c.evidence.map((e) => e.sourceUrl))).toEqual(
      fast.output.claims.map((c) => c.evidence.map((e) => e.sourceUrl))
    );
  });
});

describe("③ 関連の締め切りで判定できなかった候補は、主張ごとに時間切れとして残す（ADR-0021・0022）", () => {
  it("締め切りに走っていた判定は止めて、その節を全主張の unjudged に判定の予定順で残す。判定できた節で信頼度を問う", async () => {
    quiet();
    const claims = [claimOf("claim-1"), claimOf("claim-2")];
    const fast = page("https://fast.example/p", "すぐ判定される本文。");
    const slow = page("https://slow.example/p", longBody("遅い", 2));
    const { output, calls, budget } = await run({
      claims,
      pages: (query) => (query === "記事の検索語" ? [fast, slow] : []),
      // The slow page's requests are still running at the relevance cut-off.
      latency: { jev: (call) => (isRelevanceCall(call) && call.state.section.url === slow.url ? 1_000_000 : 1_000) },
    });

    for (const claim of output.claims) {
      expect(claim.evidenceTrace?.unjudged).toEqual({ reason: TIME_UP, sections: 2, urls: [slow.url] });
      expect(claim.evidenceTrace?.sections).toEqual({ candidates: 3, judged: 1, related: 1 });
      // Not heard out is not "said nothing".
      expect(claim.evidenceTrace?.saidNothing).toBe(0);
      expect(claim.confidence).toBe(0.7);
      expect(claim.evidence.map((e) => e.sourceUrl)).toEqual([fast.url]);
    }
    for (const call of calls.filter(isSupportCall)) expect(supportUrls(call)).toEqual([fast.url]);
    expect(budget.cutShort()).toEqual([
      { stage: "relevanceJudging", notStarted: 0, stopped: 2, cutoffMs: STAGE_CUTOFF_MS.relevanceJudging },
    ]);
  });

  it("締め切りの後に届いた判定は JEV に送らず、時間切れとして数える。1節も判定できなかった主張は信頼度を問わず、数値を出さない", async () => {
    const warn = quiet();
    const claims = [claimOf("claim-1"), claimOf("claim-2")];
    const { output, calls, budget } = await run(
      {
        claims,
        pages: (query) => [page(`https://example.com/${encodeURIComponent(query)}`, `${query}の本文。`)],
        latency: { extraction: 100_000, search: 1_000, fetch: 1_000, factCheck: 1_000, jev: 1_000 },
      },
      { cutoffMs: { relevanceJudging: 100_000 } }
    );

    expect(calls.filter(isRelevanceCall)).toEqual([]);
    expect(calls.filter(isSupportCall)).toEqual([]);
    for (const claim of output.claims) {
      expect(claim.confidence).toBeUndefined();
      expect(claim.reason).toBe("時間内に資料を判定できなかったため、確認できませんでした（時間切れ）。");
      expect(claim.evidenceTrace?.unjudged?.reason).toBe(TIME_UP);
      expect(claim.evidenceTrace?.unjudged?.sections).toBe(3);
    }
    // One request per section (3 pages, one section each), none sent.
    expect(budget.cutShort()).toEqual([{ stage: "relevanceJudging", notStarted: 3, stopped: 0, cutoffMs: 100_000 }]);
    expect(warn.mock.calls.some((args) => String(args[0]).includes("Claim claim-1:") && String(args[0]).includes(TIME_UP))).toBe(
      true
    );
  });

  it("JEV が答えなかった節は、時間切れとは分けて unanswered に残し、判定できた節で信頼度を問う", async () => {
    quiet();
    const claims = [claimOf("claim-1")];
    const good = page("https://good.example/p", "判定できる本文。");
    const bad = page("https://bad.example/p", "判定で失敗する本文。");
    const { output } = await run({
      claims,
      pages: (query) => (query === "記事の検索語" ? [good, bad] : []),
      answer: (call) => {
        if (isRelevanceCall(call) && call.state.section.url === bad.url) throw new Error("JEV 503");
        return Object.fromEntries(
          Object.keys(call.questions ?? {}).map((name) => [name, { type: "noul", noul: name === "support" ? 0.7 : 0.9 }])
        ) as Record<string, JEVAnswer>;
      },
    });

    const [claim] = output.claims;
    expect(claim.evidenceTrace?.unanswered).toEqual({ reason: "JEVの失敗: JEV 503", sections: 1, urls: [bad.url] });
    expect(claim.evidenceTrace?.unjudged).toBeUndefined();
    expect(claim.confidence).toBe(0.7);
    expect(claim.evidence.map((e) => e.sourceUrl)).toEqual([good.url]);
  });
});

describe("③ 記事05の規模でも、JEV の公式の上限のなかで締め切りより前に終わる（ADR-0022 の見積もり）", () => {
  /** A page like those measured: many short heading lines, so small sections that pack into ~3 reading sections. */
  function measuredLikeBody(n: number): string {
    const kana = "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん";
    let seed = n * 7919 + 17;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
    let body = "";
    for (let block = 0; block < 24; block++) {
      body += `ページ${n}の見出し${block}\n`;
      let sentence = "";
      while (sentence.length < 280) sentence += kana[next() % kana.length];
      body += `${sentence}。\n`;
    }
    return body;
  }

  it("29主張・池180ページ（1ページ約7,300字）: 関連の判定は全候補を終え、全主張に数値が付く。JEV の回数は節の数と信頼度の分だけ", async () => {
    quiet();
    const claims = Array.from({ length: 29 }, (_, i) =>
      claimOf(`claim-${i + 1}`, { originalText: `ふるさと納税の${i + 1}番目の事実を述べた文です。` })
    );
    const bodies = Array.from({ length: 180 }, (_, n) => measuredLikeBody(n));
    // Six article searches and two per claim, seven results each, overlapping: 180 pages in all.
    const queries = [
      ...Array.from({ length: 6 }, (_, i) => `記事の検索語${i}`),
      ...claims.flatMap((claim) => [`${claim.id} 一次資料`, `${claim.id} 条件`]),
    ];
    const pagesOf = (query: string): FakePage[] => {
      const at = queries.indexOf(query);
      return Array.from({ length: 7 }, (_, i) => {
        const n = (at * 3 + i) % 180;
        return page(`https://site${n % 60}.example/page/${n}`, bodies[n]);
      });
    };
    const clock = new FakeClock();
    const fakes = fakeServices({
      clock,
      claims,
      documentQueries: queries.slice(0, 6),
      claimQueries: (claim) => [`${claim.id} 一次資料`, `${claim.id} 条件`],
      pages: pagesOf,
      // About one section in ten is related, fixed by address and claim.
      answer: (call) =>
        Object.fromEntries(
          Object.keys(call.questions ?? {}).map((name) => {
            if (name === "support") return [name, { type: "noul", noul: 0.7 }];
            const n = Number(/\/page\/(\d+)/.exec(call.state.section.url)?.[1]);
            const c = Number(name.replace("claim-", ""));
            return [name, { type: "noul", noul: (n + c) % 10 === 0 ? 0.9 : 0.1 }];
          })
        ) as Record<string, JEVAnswer>,
      // Measured on article-05 with #89 (result.timings): extraction 106 s,
      // the claims' queries 43 s; replies within 1–2 s.
      latency: {
        extraction: 106_000,
        documentQueries: 10_000,
        claimQueries: 43_000,
        search: 2_000,
        fetch: 5_000,
        factCheck: 1_000,
        jev: (call) => (isSupportCall(call) ? 2_000 : 1_000),
      },
    });

    const result = await clock.run(
      runOrchestrator(claims.map((claim) => claim.originalText).join(""), { ...fakes.options, clock, startedAt: 0 })
    );

    const sections = bodies.reduce((sum, body) => sum + readingSections(body).length, 0);
    const byStage = Object.fromEntries(result.timings.map((timing) => [timing.stage, timing]));
    expect(result.cutShort).toBeUndefined();
    expect(result.claims.every((claim) => claim.confidence === 0.7)).toBe(true);
    for (const claim of result.claims) {
      expect(claim.evidenceTrace?.overCap).toBe(0);
      expect(claim.evidenceTrace?.sections?.candidates).toBe(sections);
      expect(claim.evidenceTrace?.sections?.judged).toBe(sections);
    }
    // One relevance request per section, every claim asked in it.
    expect(byStage.relevanceJudging.jevCalls).toBe(sections);
    // Well before the cut-offs (245 s and 270 s).
    expect(byStage.relevanceJudging.endMs!).toBeLessThan(STAGE_CUTOFF_MS.relevanceJudging - 30_000);
    expect(byStage.supportJudging.endMs!).toBeLessThan(STAGE_CUTOFF_MS.supportJudging - 30_000);
  });
});
