import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  HTTPJEVClient,
  JEV_MAX_CONCURRENT_REQUESTS,
  JEV_RETRY_STATUSES,
} from "@/lib/providers/jev/client";

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
 * ADR-0018: JEV is asked many more times than before, so a busy JEV (429,
 * 5xx) is asked the same thing again the way Anthropic is (retry.ts: 2s, 4s,
 * 8s or what retry-after asks, at most three times), and one run keeps only
 * so many requests in flight at once.
 */

function busy(status: number, retryAfter: string | null = null) {
  return {
    ok: false,
    status,
    statusText: status === 429 ? "Too Many Requests" : "Service Unavailable",
    headers: { get: (name: string) => (name === "retry-after" ? retryAfter : null) },
    text: async () => `{"detail":"busy ${status}"}`,
    json: async () => ({}),
  };
}

function answeredNoul(noul = 0.7) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => null },
    text: async () => "",
    json: async () => ({ model: "jev-1.13.0", answers: { q: { type: "noul", noul } }, usage: {} }),
  };
}

describe("HTTPJEVClient retries a busy JEV", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("retries 429 and every 5xx, and nothing else", () => {
    expect(JEV_RETRY_STATUSES).toContain(429);
    expect(JEV_RETRY_STATUSES).toContain(500);
    expect(JEV_RETRY_STATUSES).toContain(529);
    expect(JEV_RETRY_STATUSES).toContain(599);
    expect(JEV_RETRY_STATUSES).not.toContain(422);
    expect(JEV_RETRY_STATUSES).not.toContain(401);
  });

  it("asks again after a 429 and returns the answers, counting the retry", async () => {
    const replies = [busy(429), answeredNoul(0.7)];
    const fetchMock = vi.fn(async () => replies.shift()!);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const jev = new HTTPJEVClient({ apiKey: "test-key" });
    const pending = jev.ask({ page: {} }, { q: { type: "noul", instructions: "?" } });

    // No retry-after: the first wait is 2 seconds.
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual({ q: { type: "noul", noul: 0.7 } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(jev.retryCount).toBe(1);
    expect(jev.failureCount).toBe(0);
  });

  it("reports a 503 that lasts through three retries as the failure it is", async () => {
    const fetchMock = vi.fn(async () => busy(503));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const jev = new HTTPJEVClient({ apiKey: "test-key" });
    const outcome = expect(
      jev.ask({ page: {} }, { q: { type: "noul", instructions: "?" } })
    ).rejects.toThrow(/TypeSafe AI Jev request failed \(503 Service Unavailable\): .*busy 503/);

    await vi.advanceTimersByTimeAsync(2000 + 4000 + 8000);

    await outcome;
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(jev.retryCount).toBe(3);
    expect(jev.failureCount).toBe(1);
    expect(jev.lastError).toMatch(/503/);
  });

  it("waits as long as retry-after asks", async () => {
    const replies = [busy(529, "5"), answeredNoul()];
    const fetchMock = vi.fn(async () => replies.shift()!);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const jev = new HTTPJEVClient({ apiKey: "test-key" });
    const pending = jev.ask({ page: {} }, { q: { type: "noul", instructions: "?" } });

    await vi.advanceTimersByTimeAsync(4999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not ask again when the request itself was refused (422)", async () => {
    const fetchMock = vi.fn(async () => ({
      ...busy(422),
      statusText: "Unprocessable Entity",
      text: async () => '{"detail":[{"msg":"Field required"}]}',
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const jev = new HTTPJEVClient({ apiKey: "test-key" });

    await expect(
      jev.ask({ page: {} }, { q: { type: "noul", instructions: "?" } })
    ).rejects.toThrow(/422/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(jev.retryCount).toBe(0);
  });
});

describe("HTTPJEVClient keeps a limit on requests in flight", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it(`keeps at most ${JEV_MAX_CONCURRENT_REQUESTS} in flight by default, and the rest wait their turn in the order they were made`, async () => {
    let inFlight = 0;
    let most = 0;
    const started: string[] = [];
    const release: (() => void)[] = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init: { body?: string } = {}) => {
      inFlight++;
      most = Math.max(most, inFlight);
      started.push(JSON.parse(init.body ?? "{}").state.n);
      await new Promise<void>((resolve) => release.push(resolve));
      inFlight--;
      return answeredNoul();
    }) as unknown as typeof fetch;

    const jev = new HTTPJEVClient({ apiKey: "test-key" });
    const total = JEV_MAX_CONCURRENT_REQUESTS + 5;
    const pending = Array.from({ length: total }, (_, n) =>
      jev.ask({ n: String(n) }, { q: { type: "noul", instructions: "?" } })
    );

    // Let every request that can start, start; then finish them one by one.
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    await settle();
    expect(inFlight).toBe(JEV_MAX_CONCURRENT_REQUESTS);
    while (release.length > 0) {
      release.shift()!();
      await settle();
    }
    await Promise.all(pending);

    expect(most).toBe(JEV_MAX_CONCURRENT_REQUESTS);
    expect(started).toEqual(Array.from({ length: total }, (_, n) => String(n)));
  });

  it("frees the turn of a request that failed", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("network down");
      return answeredNoul();
    }) as unknown as typeof fetch;

    const jev = new HTTPJEVClient({ apiKey: "test-key", maxConcurrent: 1 });
    const first = jev.ask({}, { q: { type: "noul", instructions: "?" } });
    const second = jev.ask({}, { q: { type: "noul", instructions: "?" } });

    await expect(first).rejects.toThrow("network down");
    await expect(second).resolves.toEqual({ q: { type: "noul", noul: 0.7 } });
  });
});
