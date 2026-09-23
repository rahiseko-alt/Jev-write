import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TavilySearchProvider } from "@/lib/providers/search/tavily";
import { HTTPFetchProvider } from "@/lib/providers/fetch/fetcher";

/**
 * A lookup that failed is a lookup that failed. These tests hold the
 * production adapters to that: nothing they return may be text nobody
 * fetched, however convenient a stand-in would be.
 */

const realFetch = globalThis.fetch;

function respondWith(body: unknown, init: { status?: number } = {}) {
  const status = init.status ?? 200;
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  })) as unknown as typeof fetch;
}

describe("TavilySearchProvider", () => {
  const options = { apiKey: "test-key" };

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("returns what the search actually found", async () => {
    globalThis.fetch = respondWith({
      results: [{ title: "T", url: "https://example.com/a", content: "本文" }],
    });

    const response = await new TavilySearchProvider(options).search("query");

    expect(response.results).toHaveLength(1);
    expect(response.results[0].url).toBe("https://example.com/a");
  });

  it("returns nothing when the search found nothing", async () => {
    globalThis.fetch = respondWith({ results: [] });

    const response = await new TavilySearchProvider(options).search("存在しない話題");

    expect(response.results).toEqual([]);
  });

  it("reports an API error rather than answering with invented results", async () => {
    globalThis.fetch = respondWith("upstream is unwell", { status: 500 });

    await expect(new TavilySearchProvider(options).search("query")).rejects.toThrow();
  });

  it("reports a transport failure rather than answering with invented results", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    await expect(new TavilySearchProvider(options).search("query")).rejects.toThrow();
  });

  it("reports a missing credential rather than standing in for one", async () => {
    await expect(new TavilySearchProvider({ apiKey: "" }).search("query")).rejects.toThrow();
  });
});

describe("HTTPFetchProvider", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("returns the page it fetched", async () => {
    globalThis.fetch = respondWith("<html><title>題</title><body>本文です。</body></html>");

    const page = await new HTTPFetchProvider().fetchUrl("https://example.com/a");

    expect(page.statusCode).toBe(200);
    expect(page.content).toContain("本文");
  });

  it("returns no content for a page it could not fetch", async () => {
    globalThis.fetch = respondWith("not found", { status: 404 });

    const page = await new HTTPFetchProvider().fetchUrl("https://example.com/missing");

    expect(page.statusCode).toBe(404);
    expect(page.content).toBe("");
    expect(page.text).toBe("");
  });

  it("returns no content when the request never completed", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("timed out");
    }) as unknown as typeof fetch;

    const page = await new HTTPFetchProvider().fetchUrl("https://example.com/slow");

    expect(page.content).toBe("");
    expect(page.text).toBe("");
  });

  it("never returns prose for a URL it did not read", async () => {
    globalThis.fetch = respondWith("gone", { status: 410 });

    const page = await new HTTPFetchProvider().fetchUrl(
      "https://www.nintendo.co.jp/hardware/switch2/"
    );

    // The mock has a canned page for this very URL. Nothing may reach for it.
    expect(page.content).toBe("");
    expect(page.title).toBe("");
  });
});

describe("OpenAILLMProvider rate limiting", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("retries a rate-limited call and then succeeds", async () => {
    const { OpenAILLMProvider } = await import("@/lib/providers/llm/openai");
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        return {
          ok: false,
          status: 429,
          statusText: "Too Many Requests",
          headers: { get: () => "0" },
          text: async (): Promise<string> => "rate limited",
          json: async () => ({}),
        };
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => null },
        text: async (): Promise<string> => "",
        json: async () => ({ choices: [{ message: { content: '{"claims":[]}' } }] }),
      };
    }) as unknown as typeof fetch;

    const provider = new OpenAILLMProvider({ apiKey: "test-key" });
    await provider.extractClaims("本文。");

    expect(calls).toBe(2);
    expect(provider.servedByFallback).toBe(false);
  });

  it("does not retire the real provider for the next call", async () => {
    const { OpenAILLMProvider } = await import("@/lib/providers/llm/openai");
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      headers: { get: () => "0" },
      text: async (): Promise<string> => "rate limited",
      json: async () => ({}),
    })) as unknown as typeof fetch;

    const exhausted = new OpenAILLMProvider({ apiKey: "test-key" });
    await exhausted.extractClaims("本文。");
    expect(exhausted.servedByFallback).toBe(true);

    let reached = 0;
    globalThis.fetch = vi.fn(async () => {
      reached++;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => null },
        text: async (): Promise<string> => "",
        json: async () => ({ choices: [{ message: { content: '{"claims":[]}' } }] }),
      };
    }) as unknown as typeof fetch;

    const next = new OpenAILLMProvider({ apiKey: "test-key" });
    await next.extractClaims("本文。");

    expect(reached).toBeGreaterThan(0);
    expect(next.servedByFallback).toBe(false);
  });
});

describe("HTTPGoogleFactCheckClient", () => {
  const options = { apiKey: "test-key" };

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("returns the reviews the API actually returned", async () => {
    const { HTTPGoogleFactCheckClient } = await import(
      "@/lib/providers/google-factcheck/client"
    );
    globalThis.fetch = respondWith({
      claims: [
        {
          text: "ある主張",
          claimReview: [
            { url: "https://example.org/review/1", textualRating: "正しい" },
          ],
        },
      ],
    });

    const result = await new HTTPGoogleFactCheckClient(options).searchClaims("query");

    expect(result.claims ?? []).toHaveLength(1);
    expect(result.claims?.[0].claimReview?.[0].url).toBe("https://example.org/review/1");
  });

  it("returns nothing when no fact check covers the claim", async () => {
    const { HTTPGoogleFactCheckClient } = await import(
      "@/lib/providers/google-factcheck/client"
    );
    globalThis.fetch = respondWith({ claims: [] });

    const result = await new HTTPGoogleFactCheckClient(options).searchClaims(
      "誰も検証していない主張"
    );

    // Not one canned review, and not one fabricated publisher.
    expect(result.claims).toEqual([]);
  });

  it("reports an API error rather than answering with a canned review", async () => {
    const { HTTPGoogleFactCheckClient } = await import(
      "@/lib/providers/google-factcheck/client"
    );
    globalThis.fetch = respondWith("upstream is unwell", { status: 500 });

    await expect(
      new HTTPGoogleFactCheckClient(options).searchClaims("query")
    ).rejects.toThrow();
  });

  it("reports a missing credential rather than standing in for one", async () => {
    const { HTTPGoogleFactCheckClient } = await import(
      "@/lib/providers/google-factcheck/client"
    );

    await expect(
      new HTTPGoogleFactCheckClient({ apiKey: "" }).searchClaims("query")
    ).rejects.toThrow();
  });

  it("never returns a review for a claim it never looked up", async () => {
    const { HTTPGoogleFactCheckClient } = await import(
      "@/lib/providers/google-factcheck/client"
    );
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    // The stand-in holds a canned review for this very claim.
    await expect(
      new HTTPGoogleFactCheckClient(options).searchClaims("iPhone 17は2024年9月に発売された")
    ).rejects.toThrow();
  });
});
