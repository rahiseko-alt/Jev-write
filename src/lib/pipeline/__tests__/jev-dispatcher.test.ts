import { describe, it, expect } from "vitest";
import { JevDispatcher } from "@/lib/pipeline/jev-dispatcher";
import {
  DEFAULT_JEV_LIMITS,
  JEV_MAX_IN_FLIGHT,
  JEV_REQUESTS_PER_MINUTE,
  JEV_TOKENS_PER_SECOND,
  JevLimits,
  RELEVANCE_END_MS,
  RELEVANCE_STOP_MS,
  RUN_DEADLINE_MS,
  createTimeBudget,
} from "@/lib/pipeline/time-budget";
import { JEVRequestError } from "@/lib/providers/jev/types";
import { FakeClock } from "./fakes";

/**
 * ADR-0021: every JEV request goes through one dispatcher, which keeps to
 * JEV's official limits (docs.typesafe.ai/models) and lets the clock decide
 * what is still sent.
 */

const FAR = { stage: "test", startBy: 1_000_000, finishBy: 2_000_000 };

function setUp(limits: Partial<JevLimits> = {}, attemptTimeoutMs = 5_000, minAttemptMs = 500) {
  const clock = new FakeClock();
  const jev: any = {
    evaluateAtomicJudgment: async () => {
      throw new Error("not used");
    },
  };
  const dispatcher = new JevDispatcher(
    jev,
    clock,
    { ...DEFAULT_JEV_LIMITS, ...limits },
    attemptTimeoutMs,
    minAttemptMs
  );
  const starts: number[] = [];
  /** A request that takes `ms` and then answers, or throws what `fail` gives for that attempt. */
  const request = (ms = 0, fail?: (attempt: number) => unknown) => {
    let attempt = 0;
    return async () => {
      starts.push(clock.now());
      const mine = attempt++;
      if (ms > 0) await clock.sleep(ms);
      const error = fail?.(mine);
      if (error) throw error;
      return "ok";
    };
  };
  return { clock, jev, dispatcher, starts, request };
}

describe("JEVの公式の上限（1,200回/分・250,000トークン/秒）を守る", () => {
  it("上限の値は公式のまま。同時に送る数は1秒あたりの回数（1,200/60）", () => {
    expect(JEV_REQUESTS_PER_MINUTE).toBe(1_200);
    expect(JEV_TOKENS_PER_SECOND).toBe(250_000);
    expect(JEV_MAX_IN_FLIGHT).toBe(20);
  });

  it("1分あたりの回数は、1分の中にならして送る（1,200回/分なら1秒に20回まで）", async () => {
    const official = setUp();
    await official.clock.run(
      Promise.all(Array.from({ length: 45 }, () => official.dispatcher.send(1, FAR, official.request())))
    );
    expect(official.starts.filter((at) => at === 0)).toHaveLength(20);
    expect(official.starts.filter((at) => at === 1_000)).toHaveLength(20);
    expect(official.starts.filter((at) => at === 2_000)).toHaveLength(5);

    const { clock, dispatcher, starts, request } = setUp({ requestsPerMinute: 3 });
    await clock.run(Promise.all(Array.from({ length: 4 }, () => dispatcher.send(1, FAR, request()))));
    expect(starts).toEqual([0, 20_000, 40_000, 60_000]);
  });

  it("1秒あたりのトークン数を超えそうなら、1秒前の分が抜けるまで待つ", async () => {
    const { clock, dispatcher, starts, request } = setUp({ tokensPerSecond: 100 });

    await clock.run(Promise.all(Array.from({ length: 3 }, () => dispatcher.send(60, FAR, request()))));

    expect(starts).toEqual([0, 1_000, 2_000]);
  });

  it("同時に送るのは上限の数まで。あとは渡された順に待つ", async () => {
    const { clock, dispatcher, starts, request } = setUp({ maxInFlight: 2 });
    let inFlight = 0;
    let most = 0;
    const tracked = () => {
      const send = request(1_000);
      return async () => {
        most = Math.max(most, ++inFlight);
        try {
          return await send();
        } finally {
          inFlight--;
        }
      };
    };

    await clock.run(Promise.all(Array.from({ length: 5 }, () => dispatcher.send(1, FAR, tracked()))));

    expect(most).toBe(2);
    expect(starts).toEqual([0, 0, 1_000, 1_000, 2_000]);
  });
});

describe("締め切りは時計で守る", () => {
  it("始める締め切りまでに順番が来なかった依頼は送らず、not-started で返す", async () => {
    const { clock, dispatcher, starts, request } = setUp({ maxInFlight: 1 });
    const window = { stage: "relevanceJudging", startBy: 2_500, finishBy: 10_000 };

    const outcomes = await clock.run(
      Promise.all(Array.from({ length: 5 }, () => dispatcher.send(1, window, request(1_000))))
    );

    expect(starts).toEqual([0, 1_000, 2_000]);
    expect(outcomes.map((o) => o.status)).toEqual(["answered", "answered", "answered", "not-started", "not-started"]);
    expect(dispatcher.countsFor("relevanceJudging")).toMatchObject({ calls: 3, notStarted: 2 });
  });

  it("試行には、その段の締め切りまでの残りより長い時間を与えない。打ち切りは時間切れで、JEVの失敗に数えない", async () => {
    const { clock, jev, dispatcher, request } = setUp({}, 5_000);
    const timeouts: number[] = [];

    const [outcome] = await clock.run(
      Promise.all([
        dispatcher.send(1, { stage: "supportJudging", startBy: 10_000, finishBy: 2_000 }, (timeoutMs) => {
          timeouts.push(timeoutMs);
          return request(3_000)();
        }),
      ])
    );

    expect(timeouts).toEqual([2_000]);
    expect(outcome).toMatchObject({ status: "failed", cutOff: true });
    expect(clock.now()).toBe(2_000);
    expect(dispatcher.countsFor("supportJudging")).toMatchObject({ cutOff: 1, failures: 0 });
    expect(jev.failureCount ?? 0).toBe(0);
  });

  it("予算の値: 締め切り270秒、関連の判定は225秒で新規を止め240秒までに終わる", () => {
    expect(RUN_DEADLINE_MS).toBe(270_000);
    expect(RELEVANCE_STOP_MS).toBe(225_000);
    expect(RELEVANCE_END_MS).toBe(240_000);
    const clock = new FakeClock(1_000);
    const budget = createTimeBudget(clock);
    expect(budget.relevanceStopAt - budget.startedAt).toBe(225_000);
    expect(budget.relevanceEndAt - budget.startedAt).toBe(240_000);
    expect(budget.deadlineAt - budget.startedAt).toBe(270_000);
    expect(budget.supportStopAt - budget.startedAt).toBe(265_000);
  });
});

describe("混んでいる（429・5xx）と言われたら、間を空けて送り直す（締め切りの内でだけ）", () => {
  it("retry-after が無ければ JEV の SDK の既定（0.5秒から倍々）で待つ", async () => {
    const { clock, jev, dispatcher, starts, request } = setUp();
    const busy = new JEVRequestError("503 Service Unavailable", { status: 503 });

    const [outcome] = await clock.run(
      Promise.all([dispatcher.send(1, FAR, request(0, (attempt) => (attempt < 2 ? busy : undefined)))])
    );

    expect(outcome.status).toBe("answered");
    expect(starts).toEqual([0, 500, 1_500]);
    expect(dispatcher.countsFor("test")).toMatchObject({ calls: 1, retries: 2, failures: 0 });
    expect(jev.retryCount).toBe(2);
    expect(jev.failureCount ?? 0).toBe(0);
  });

  it("retry-after があればその時間を待ち、その間はほかの依頼も送らない", async () => {
    const { clock, dispatcher, starts, request } = setUp();
    const limited = new JEVRequestError("429 Too Many Requests", { status: 429, retryAfterMs: 3_000 });

    await clock.run(
      Promise.all([
        dispatcher.send(1, FAR, request(0, (attempt) => (attempt === 0 ? limited : undefined))),
        // Handed in just after the first was refused.
        clock.sleep(10).then(() => dispatcher.send(1, FAR, request())),
      ])
    );

    expect(starts).toEqual([0, 3_000, 3_000]);
  });

  it("送り直しても締め切りまでに答えが届かないなら送り直さず、失敗として記録する", async () => {
    const { clock, jev, dispatcher, starts, request } = setUp({}, 5_000, 1_000);
    const limited = new JEVRequestError("429 Too Many Requests", { status: 429, retryAfterMs: 2_500 });

    const [outcome] = await clock.run(
      Promise.all([
        dispatcher.send(1, { stage: "test", startBy: 1_000, finishBy: 3_000 }, request(0, () => limited)),
      ])
    );

    expect(starts).toEqual([0]);
    expect(outcome).toMatchObject({ status: "failed", cutOff: false });
    expect(jev.failureCount).toBe(1);
    expect(jev.lastError).toContain("429");
  });

  it("送り直しは2回まで（SDK の既定）。それでも混んでいれば失敗", async () => {
    const { clock, dispatcher, starts, request } = setUp();
    const overloaded = new JEVRequestError("529 Overloaded", { status: 529 });

    const [outcome] = await clock.run(Promise.all([dispatcher.send(1, FAR, request(0, () => overloaded))]));

    expect(starts).toEqual([0, 500, 1_500]);
    expect(outcome.status).toBe("failed");
  });

  it("混雑以外の断り（401・422 など）と、答えの無いまま過ぎた試行は送り直さない", async () => {
    const { clock, dispatcher, starts, request } = setUp({}, 2_000);
    const invalid = new JEVRequestError("422 Unprocessable Entity", { status: 422 });

    const outcomes = await clock.run(
      Promise.all([
        dispatcher.send(1, FAR, request(0, () => invalid)),
        dispatcher.send(1, FAR, request(10_000)),
      ])
    );

    expect(starts).toEqual([0, 0]);
    expect(outcomes.map((o) => o.status)).toEqual(["failed", "failed"]);
    expect(dispatcher.countsFor("test")).toMatchObject({ retries: 0, failures: 2 });
  });
});
