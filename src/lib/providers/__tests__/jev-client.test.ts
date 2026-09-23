import { describe, it, expect, afterEach, vi } from "vitest";
import { HTTPJEVClient } from "@/lib/providers/jev/client";

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
