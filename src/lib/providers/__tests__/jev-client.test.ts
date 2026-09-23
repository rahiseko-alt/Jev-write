import { describe, it, expect, afterEach, vi } from "vitest";
import { HTTPJEVClient } from "@/lib/providers/jev/client";

/**
 * Where a real JEV is configured, its Atomic Judgment is the judgment.
 * Nothing local may overrule it, and nothing local may stand in for it.
 */

const realFetch = globalThis.fetch;

function answers(value: string) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: "200",
    json: async () => ({ answers: { q1: { value, confidence: 0.91 } } }),
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

  it("reports that it could not tell when the call fails", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const result = await client().evaluateAtomicJudgment(YEAR_MISMATCH);

    // Undecided, so the claim comes back unverified — not a verdict nobody made.
    expect(result.choice).toBe("says_nothing");
    expect(result.confidence).toBeLessThan(0.5);
  });

  it("reports no rule as detected when a batch call fails", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const result = await client().evaluateBatchRules({
      text: "まとめると、まとめると、こうなる。",
      questions: [{ id: "AI001", question: "反復がありますか？" }],
    });

    expect(result.results.AI001?.detected).toBe(false);
  });
});
