import { describe, it, expect } from "vitest";
import {
  JEV_LIMITS,
  JEV_MAX_IN_FLIGHT,
  JEV_REQUESTS_PER_MINUTE,
  JEV_TOKENS_PER_SECOND,
  JevDispatcher,
  JevLimits,
} from "@/lib/pipeline/jev-dispatcher";
import { MIN_START_MS, createTimeBudget } from "@/lib/pipeline/time-budget";
import { FakeClock } from "./fake-clock";

/**
 * ADR-0022: every JEV request of a run goes out in the order handed in, as
 * fast as JEV's published limits allow (tokens a second, requests a minute),
 * with a bounded number in flight, and never after its stage's cut-off
 * (ADR-0021, through the budget as it is).
 */

function setup(limits: JevLimits, cutoffs: Record<string, number> = {}) {
  const clock = new FakeClock();
  const budget = createTimeBudget({ clock, startedAt: 0, settings: { cutoffMs: cutoffs } });
  const dispatcher = new JevDispatcher(budget, limits);
  const started: { id: number; at: number }[] = [];
  /** A request that takes `ms` on the clock, and stops when its signal is aborted. */
  const request = (id: number, ms: number) => async (signal: AbortSignal) => {
    started.push({ id, at: clock.now() });
    await clock.sleep(ms, signal);
    if (signal.aborted) throw signal.reason;
    return id;
  };
  return { clock, budget, dispatcher, started, request };
}

describe("JEV の公式の上限（docs.typesafe.ai/models）", () => {
  it("1秒 250,000トークン・1分 1,200回。同時に送るのは 1,200回/分（20回/秒）×実測の最長3秒＝60本", () => {
    expect(JEV_TOKENS_PER_SECOND).toBe(250_000);
    expect(JEV_REQUESTS_PER_MINUTE).toBe(1_200);
    expect(JEV_MAX_IN_FLIGHT).toBe((1_200 / 60) * 3);
    expect(JEV_LIMITS).toEqual({ tokensPerSecond: 250_000, requestsPerMinute: 1_200, maxInFlight: 60 });
  });
});

describe("JevDispatcher", () => {
  it("1秒に始める見積もりトークンが上限を超えないように、渡された順に始める", async () => {
    const { clock, budget, dispatcher, started, request } = setup({
      tokensPerSecond: 100,
      requestsPerMinute: 1_000,
      maxInFlight: 10,
    });

    const outcomes = await clock.run(
      Promise.all([0, 1, 2, 3, 4].map((id) => dispatcher.send("relevanceJudging", 40, request(id, 10))))
    );

    expect(outcomes.map((o) => o.status)).toEqual(["done", "done", "done", "done", "done"]);
    // 40 + 40 fit in a second; a third would make 120.
    expect(started).toEqual([
      { id: 0, at: 0 },
      { id: 1, at: 0 },
      { id: 2, at: 1_000 },
      { id: 3, at: 1_000 },
      { id: 4, at: 2_000 },
    ]);
    budget.dispose();
  });

  it("上限より大きい1件は、直前の1秒が空いてから1件だけで始める", async () => {
    const { clock, budget, dispatcher, started, request } = setup({
      tokensPerSecond: 100,
      requestsPerMinute: 1_000,
      maxInFlight: 10,
    });

    await clock.run(
      Promise.all([
        dispatcher.send("relevanceJudging", 60, request(0, 10)),
        dispatcher.send("relevanceJudging", 150, request(1, 10)),
        dispatcher.send("relevanceJudging", 10, request(2, 10)),
      ])
    );

    expect(started).toEqual([
      { id: 0, at: 0 },
      { id: 1, at: 1_000 },
      { id: 2, at: 2_000 },
    ]);
    budget.dispose();
  });

  it("1分に始める回数が上限を超えない", async () => {
    const { clock, budget, dispatcher, started, request } = setup(
      { tokensPerSecond: 1_000_000, requestsPerMinute: 3, maxInFlight: 10 },
      { relevanceJudging: 500_000 }
    );

    await clock.run(Promise.all([0, 1, 2, 3, 4].map((id) => dispatcher.send("relevanceJudging", 1, request(id, 10)))));

    expect(started.map((s) => s.at)).toEqual([0, 0, 0, 60_000, 60_000]);
    budget.dispose();
  });

  it("同時に送るのは上限の本数まで。終わった分だけ次を始める", async () => {
    const { clock, budget, dispatcher, started, request } = setup({
      tokensPerSecond: 1_000_000,
      requestsPerMinute: 1_000,
      maxInFlight: 2,
    });

    await clock.run(Promise.all([0, 1, 2, 3, 4].map((id) => dispatcher.send("relevanceJudging", 1, request(id, 5_000)))));

    expect(started).toEqual([
      { id: 0, at: 0 },
      { id: 1, at: 0 },
      { id: 2, at: 5_000 },
      { id: 3, at: 5_000 },
      { id: 4, at: 10_000 },
    ]);
    budget.dispose();
  });

  it("段の締め切りまで3秒を切ったら送らず、残りは時間切れ（始めなかった）として段に数える。上限の枠も使わない", async () => {
    const { clock, budget, dispatcher, started, request } = setup(
      { tokensPerSecond: 100, requestsPerMinute: 1_000, maxInFlight: 10 },
      { relevanceJudging: 10_000 }
    );

    const outcomes = await clock.run(
      Promise.all(Array.from({ length: 12 }, (_, id) => dispatcher.send("relevanceJudging", 100, request(id, 10))))
    );

    // One a second from 0 s; the last start is 7 s, the cut-off less 3 s.
    expect(started.map((s) => s.at)).toEqual([0, 1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000]);
    expect(started.every((s) => s.at <= 10_000 - MIN_START_MS)).toBe(true);
    expect(outcomes.map((o) => o.status)).toEqual([...Array(8).fill("done"), ...Array(4).fill("notStarted")]);
    expect(budget.cutShort()).toEqual([{ stage: "relevanceJudging", notStarted: 4, stopped: 0, cutoffMs: 10_000 }]);
    // Another stage, later cut off, still goes.
    const support = await clock.run(dispatcher.send("supportJudging", 100, request(99, 10)));
    expect(support.status).toBe("done");
    budget.dispose();
  });

  it("締め切りに走っていたものは止め、枠が空くのを待っていたものは始めずに返す", async () => {
    const { clock, budget, dispatcher, started, request } = setup(
      { tokensPerSecond: 1_000_000, requestsPerMinute: 1_000, maxInFlight: 1 },
      { relevanceJudging: 10_000 }
    );

    const outcomes = await clock.run(
      Promise.all([0, 1, 2].map((id) => dispatcher.send("relevanceJudging", 1, request(id, 20_000))))
    );

    expect(started).toEqual([{ id: 0, at: 0 }]);
    expect(outcomes.map((o) => o.status)).toEqual(["stopped", "notStarted", "notStarted"]);
    expect(clock.now()).toBe(10_000);
    expect(budget.cutShort()).toEqual([{ stage: "relevanceJudging", notStarted: 2, stopped: 1, cutoffMs: 10_000 }]);
    budget.dispose();
  });

  it("JEV の失敗は時間切れにせず、そのまま返す", async () => {
    const { clock, budget, dispatcher } = setup(JEV_LIMITS);

    const failed = dispatcher.send("relevanceJudging", 1, async () => {
      throw new Error("JEV 503");
    });

    await expect(clock.run(failed)).rejects.toThrow("JEV 503");
    expect(budget.cutShort()).toEqual([]);
    expect(budget.timings().find((t) => t.stage === "relevanceJudging")).toMatchObject({ calls: 1, jevCalls: 1 });
    budget.dispose();
  });
});
