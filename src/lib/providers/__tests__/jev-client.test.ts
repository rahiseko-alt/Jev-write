import { describe, it, expect, afterEach, vi } from "vitest";
import { HTTPJEVClient, JEV_RETRY_BACKOFF_MS, JEV_RETRY_STATUSES } from "@/lib/providers/jev/client";
import { TimeUpError } from "@/lib/pipeline/time-budget";

/**
 * Where a real JEV is configured, its Atomic Judgment is the judgment.
 * Nothing local may overrule it, and nothing local may stand in for it.
 */

const realFetch = globalThis.fetch;

/** A choice answer in the shape the published API returns. */
function answers(choice: string) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: "200",
    json: async () => ({
      model: "jev-latest",
      answers: {
        q1: {
          type: "choice",
          choice,
          confidence: 0.91,
          probabilities: { [choice]: 0.91 },
        },
      },
      usage: { input_tokens: 10, output_tokens: 2 },
    }),
    text: async () => "",
  })) as unknown as typeof fetch;
}

// A claim and evidence whose years differ: the demo heuristic calls this a
// contradiction on sight.
const YEAR_MISMATCH = {
  state: {
    claim: "この製品は2024年に発売されました",
    evidence: "この製品は2025年に発売されました",
  },
  instructions: "この証拠テキストは主張を肯定していますか、否定していますか？",
  criteria: ["supports", "contradicts", "says_nothing", "ambiguous"],
};

describe("HTTPJEVClient", () => {
  const client = () => new HTTPJEVClient({ apiKey: "test-key" });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("returns the verdict JEV gave", async () => {
    globalThis.fetch = answers("supports");

    const result = await client().evaluateAtomicJudgment(YEAR_MISMATCH);

    expect(result.choice).toBe("supports");
  });

  it("keeps JEV's verdict where a local heuristic would disagree", async () => {
    globalThis.fetch = answers("supports");

    const result = await client().evaluateAtomicJudgment({
      state: {
        claim: "本体価格は98,000円です",
        evidence: "希望小売価格についての記述はありません",
      },
      instructions: YEAR_MISMATCH.instructions,
      criteria: YEAR_MISMATCH.criteria,
    });

    expect(result.choice).toBe("supports");
  });

  it("returns JEV's contradiction as its own", async () => {
    globalThis.fetch = answers("contradicts");

    const result = await client().evaluateAtomicJudgment(YEAR_MISMATCH);

    expect(result.choice).toBe("contradicts");
  });

  it("reports a failed judgment as a failure, not as a verdict", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    await expect(client().evaluateAtomicJudgment(YEAR_MISMATCH)).rejects.toThrow();
  });

  it("sends the choices as the mapping the API takes", async () => {
    const sent: string[] = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init: { body?: string } = {}) => {
      sent.push(init.body ?? "");
      return {
        ok: true,
        status: 200,
        statusText: "200",
        json: async () => ({
          model: "jev-latest",
          answers: { q1: { type: "choice", choice: "supports", confidence: 0.9, probabilities: {} } },
          usage: {},
        }),
        text: async () => "",
      };
    }) as unknown as typeof fetch;

    await client().evaluateAtomicJudgment(YEAR_MISMATCH);

    const body = JSON.parse(sent[0]);
    // An array here is what the API rejects with 422.
    expect(Array.isArray(body.questions.q1.criteria)).toBe(false);
    expect(Object.keys(body.questions.q1.criteria)).toContain("contradicts");
  });

  it("reads a yes/no answer as the probability the API returns", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "200",
      json: async () => ({
        model: "jev-latest",
        answers: { q1: { type: "noul", noul: 0.98 } },
        usage: {},
      }),
      text: async () => "",
    })) as unknown as typeof fetch;

    const result = await client().evaluateAtomicJudgment({
      state: { text: "本文" },
      instructions: "未承認の書き換えがありますか？",
      mode: "noul",
    });

    expect(result.noul).toBe(0.98);
    expect(result.confidence).toBeGreaterThan(0.9);
  });
});

/**
 * ADR-0022: JEV's API reference says to retry 429 and 529 with backoff
 * (docs.typesafe.ai/api, "Handling rate limits"); its SDKs retry 408, 429
 * and 500–599, twice, from 500 ms. The same request goes to JEV again;
 * nothing answers in its place, and one still busy after the last try is
 * reported as the failure it is.
 */
describe("HTTPJEVClient retries a busy JEV", () => {
  const client = () => new HTTPJEVClient({ apiKey: "test-key" });
  const QUESTIONS = { relevant: { type: "noul" as const, instructions: "問い" } };

  function busy(status: number, retryAfter: string | null = null) {
    return {
      ok: false,
      status,
      statusText: status === 429 ? "Too Many Requests" : "Overloaded",
      headers: { get: (name: string) => (name === "retry-after" ? retryAfter : null) },
      text: async () => "busy",
      json: async () => ({}),
    };
  }
  const answered = () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => null },
    text: async () => "",
    json: async () => ({ model: "jev-latest", answers: { relevant: { type: "noul", noul: 0.8 } }, usage: {} }),
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("送り直すのは 408・429・500〜599 だけ。待ちは JEV の SDK の既定（2回、500ms から倍）", () => {
    expect(JEV_RETRY_STATUSES).toEqual(expect.arrayContaining([408, 429, 500, 529, 599]));
    expect(JEV_RETRY_STATUSES).not.toContain(400);
    expect(JEV_RETRY_STATUSES).not.toContain(422);
    expect(JEV_RETRY_BACKOFF_MS).toEqual([500, 1_000]);
  });

  it("429 のあと 500ms 待って同じ要求を送り、答えを返す。送り直しを数え、失敗には数えない", async () => {
    vi.useFakeTimers();
    const replies = [busy(429), answered()];
    const fetchMock = vi.fn(async () => replies.shift()!);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const jev = client();

    const pending = jev.ask({ section: { text: "節" } }, QUESTIONS);
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual({ relevant: { type: "noul", noul: 0.8 } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map((call: any[]) => call[1].body);
    expect(bodies[1]).toBe(bodies[0]);
    expect(jev.retryCount).toBe(1);
    expect(jev.failureCount).toBe(0);
  });

  it("529 が続けば2回まで送り直し（500ms・1秒）、最後の答えを失敗として返す", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => busy(529));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const jev = client();

    const pending = jev.ask({ section: { text: "節" } }, QUESTIONS);
    const outcome = expect(pending).rejects.toThrow(/529 Overloaded/);
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);

    await outcome;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(jev.retryCount).toBe(2);
    expect(jev.failureCount).toBe(1);
  });

  it("retry-after があれば、その秒数だけ待つ", async () => {
    vi.useFakeTimers();
    const replies = [busy(429, "2"), answered()];
    const fetchMock = vi.fn(async () => replies.shift()!);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const pending = client().ask({ section: { text: "節" } }, QUESTIONS);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("要求そのものへの答え（422 など）は送り直さない", async () => {
    const fetchMock = vi.fn(async () => ({ ...busy(422), statusText: "Unprocessable Entity" }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const jev = client();

    await expect(jev.ask({ section: { text: "節" } }, QUESTIONS)).rejects.toThrow(/422/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(jev.retryCount).toBe(0);
  });

  it("待っている間に段の締め切りが来たら、それ以上送らず、失敗にも送り直しにも数えない（ADR-0021）", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => busy(529, "30"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const jev = client();
    const stage = new AbortController();

    const pending = jev.ask({ section: { text: "節" } }, QUESTIONS, { signal: stage.signal });
    const outcome = expect(pending).rejects.toBeInstanceOf(TimeUpError);
    await vi.advanceTimersByTimeAsync(5_000);
    stage.abort(new TimeUpError("relevanceJudging", 245_000));
    await outcome;

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(jev.retryCount).toBe(0);
    expect(jev.failureCount).toBe(0);
  });
});
