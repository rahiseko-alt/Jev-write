import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AnthropicLLMProvider } from "@/lib/providers/llm/anthropic";
import { parseRetryAfter } from "@/lib/providers/retry";

/**
 * A busy Anthropic (429 rate_limit_error / 529 overloaded_error) is asked the
 * same thing again. Nothing answers in its place, and a service still busy
 * after the last try is reported as the failure it is.
 */

const realFetch = globalThis.fetch;

function busy(status: 429 | 529, retryAfter: string | null = null) {
  const type = status === 429 ? "rate_limit_error" : "overloaded_error";
  return {
    ok: false,
    status,
    statusText: status === 429 ? "Too Many Requests" : "Overloaded",
    headers: { get: (name: string) => (name === "retry-after" ? retryAfter : null) },
    text: async () => JSON.stringify({ type: "error", error: { type, message: type } }),
    json: async () => ({}),
  };
}

function answered() {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => null },
    text: async () => "",
    json: async () => ({
      stop_reason: "end_turn",
      content: [{ type: "text", text: '{"claims":[]}' }],
    }),
  };
}

describe("AnthropicLLMProvider retries a busy service", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("retries a 429 and then succeeds, and records the retry", async () => {
    const replies = [busy(429), answered()];
    const fetchMock = vi.fn(async () => replies.shift()!);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = new AnthropicLLMProvider({ apiKey: "test-key" });
    const pending = provider.extractClaims("本文。");

    // No retry-after: the first wait is 2 seconds.
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(provider.retryCount).toBe(1);
    expect(provider.failureCount).toBe(0);
  });

  it("reports a 529 that lasts through every retry, with the original error", async () => {
    const fetchMock = vi.fn(async () => busy(529));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = new AnthropicLLMProvider({ apiKey: "test-key" });
    const pending = provider.extractClaims("本文。");
    const outcome = expect(pending).rejects.toThrow(
      /Anthropic API error \(529 Overloaded\): .*overloaded_error/
    );

    // 2s, 4s, 8s between the four tries.
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(8000);

    await outcome;
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(provider.retryCount).toBe(3);
    expect(provider.failureCount).toBe(1);
    expect(provider.lastError).toMatch(/529/);
  });

  it("waits as long as retry-after asks before trying again", async () => {
    const replies = [busy(429, "7"), answered()];
    const fetchMock = vi.fn(async () => replies.shift()!);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = new AnthropicLLMProvider({ apiKey: "test-key" });
    const pending = provider.extractClaims("本文。");

    await vi.advanceTimersByTimeAsync(6999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a request the service called wrong", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      headers: { get: () => null },
      text: async () => "invalid_request_error",
      json: async () => ({}),
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = new AnthropicLLMProvider({ apiKey: "test-key" });

    await expect(provider.extractClaims("本文。")).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(provider.retryCount).toBe(0);
  });
});

describe("parseRetryAfter", () => {
  it("reads seconds and HTTP dates, and ignores what it cannot read", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter("0")).toBe(0);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:05 GMT", now)).toBe(5000);
  });
});
