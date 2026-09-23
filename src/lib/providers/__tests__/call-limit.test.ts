import { describe, it, expect, afterEach, vi } from "vitest";
import { AnthropicLLMProvider } from "@/lib/providers/llm/anthropic";
import { HTTPJEVClient } from "@/lib/providers/jev/client";
import { TavilySearchProvider } from "@/lib/providers/search/tavily";
import { HTTPFetchProvider } from "@/lib/providers/fetch/fetcher";
import { HTTPGoogleFactCheckClient } from "@/lib/providers/google-factcheck/client";
import { TimeUpError } from "@/lib/pipeline/time-budget";

/**
 * ADR-0021: every call to an outside service ends when its stage's time
 * does, its retries and their waits included. Stopped that way, it throws
 * what it was stopped with, and it is not counted as the service failing:
 * the service did not fail, the time ran out.
 */

const realFetch = globalThis.fetch;

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

/** A service that never answers: its request ends only when its signal is aborted. */
function neverAnswers() {
  return vi.fn(
    (_url: unknown, init: { signal?: AbortSignal } = {}) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      })
  ) as unknown as typeof fetch;
}

/** The signal of a stage whose time has just run out. */
function timeUp(): AbortController {
  const controller = new AbortController();
  setTimeout(() => controller.abort(new TimeUpError("search", 220_000)), 0);
  return controller;
}

describe("外部への呼び出しは、段の残り時間で止まる（ADR-0021）", () => {
  it("Anthropic: 再試行の待ちの途中で時間が切れたら、それ以上送らず、失敗にも再試行にも数えない", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 529,
      statusText: "Overloaded",
      headers: { get: (name: string) => (name === "retry-after" ? "30" : null) },
      text: async () => "overloaded_error",
      json: async () => ({}),
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const provider = new AnthropicLLMProvider({ apiKey: "test-key" });
    const stage = new AbortController();

    const pending = provider.extractClaims("本文。", { signal: stage.signal });
    const outcome = expect(pending).rejects.toBeInstanceOf(TimeUpError);
    // Busy, asked to wait 30 s; the stage's time runs out 5 s into the wait.
    await vi.advanceTimersByTimeAsync(5_000);
    stage.abort(new TimeUpError("extraction", 170_000));
    await outcome;

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(provider.retryCount).toBe(0);
    expect(provider.failureCount).toBe(0);
  });

  it("Anthropic: 生成の途中で時間が切れたら、要求を止める", async () => {
    const fetchMock = neverAnswers();
    globalThis.fetch = fetchMock;
    const provider = new AnthropicLLMProvider({ apiKey: "test-key" });
    const stage = timeUp();

    await expect(
      provider.generateClaimQueries([{ id: "c1", originalText: "文。", normalizedText: "文。", importance: "normal", factCheckRequired: true }], {
        signal: stage.signal,
      })
    ).rejects.toBeInstanceOf(TimeUpError);
    expect(provider.failureCount).toBe(0);
  });

  it("JEV: 時間が切れたら止め、JEV の失敗に数えない。JEV 自身の時間切れ（15秒）はこれまでどおり失敗", async () => {
    globalThis.fetch = neverAnswers();
    const client = new HTTPJEVClient({ apiKey: "test-key" });
    const stage = timeUp();

    await expect(
      client.ask({ claim: { original: "文。" }, sources: [] }, { support: { type: "noul", instructions: "問い" } }, {
        signal: stage.signal,
      })
    ).rejects.toBeInstanceOf(TimeUpError);
    expect(client.failureCount).toBe(0);

    vi.useFakeTimers();
    const own = client.ask({ claim: { original: "文。" }, sources: [] }, { support: { type: "noul", instructions: "問い" } }, {
      signal: new AbortController().signal,
    });
    const failed = expect(own).rejects.toThrow("timed out after 15000ms");
    await vi.advanceTimersByTimeAsync(15_000);
    await failed;
    expect(client.failureCount).toBe(1);
  });

  it("JEV: ファクトチェックの照合（Atomic Judgment）も同じ", async () => {
    globalThis.fetch = neverAnswers();
    const client = new HTTPJEVClient({ apiKey: "test-key" });
    const stage = timeUp();

    await expect(
      client.evaluateAtomicJudgment({ state: { a: 1 }, instructions: "問い" }, { signal: stage.signal })
    ).rejects.toBeInstanceOf(TimeUpError);
    expect(client.failureCount).toBe(0);
  });

  it("Tavily: 時間が切れたら検索を止め、検索の失敗に数えない", async () => {
    globalThis.fetch = neverAnswers();
    const provider = new TavilySearchProvider({ apiKey: "test-key" });
    const stage = timeUp();

    await expect(provider.search("問い", { signal: stage.signal })).rejects.toBeInstanceOf(TimeUpError);
    expect(provider.failureCount).toBe(0);
  });

  it("ページの取得: 時間が切れたら止めて投げる（読めなかったページとして返さない）。失敗に数えない", async () => {
    globalThis.fetch = neverAnswers();
    const provider = new HTTPFetchProvider();
    const stage = timeUp();

    await expect(provider.fetchUrl("https://example.com/a", { signal: stage.signal })).rejects.toBeInstanceOf(
      TimeUpError
    );
    expect(provider.failureCount).toBe(0);
  });

  it("Google Fact Check: 時間が切れたら照会を止め、失敗に数えない", async () => {
    globalThis.fetch = neverAnswers();
    const client = new HTTPGoogleFactCheckClient({ apiKey: "test-key" });
    const stage = timeUp();

    await expect(client.search("問い", undefined, { signal: stage.signal })).rejects.toBeInstanceOf(TimeUpError);
    expect(client.failureCount).toBe(0);
  });
});
