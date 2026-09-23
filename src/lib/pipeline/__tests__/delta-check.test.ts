import { describe, it, expect } from "vitest";
import { runDeltaCheck } from "@/lib/pipeline/delta-check";
import type { RewritePlan } from "@/types";
import type { JEVClient, JEVDeltaMeaningResult } from "@/lib/providers";
import type { LLMProvider } from "@/lib/providers";

/**
 * The Delta Check is the last gate before the reader. Whatever it flags must
 * be put right or taken back out; nothing it flagged may be handed over as
 * checked text.
 */

const EMPTY_PLAN: RewritePlan = {
  corrections: [],
  styleIssues: [],
  immutableFacts: [],
  protectedQuotes: [],
  protectedNames: [],
};

function jevSaying(result: Partial<JEVDeltaMeaningResult>): JEVClient {
  const flagged = result.hasUnauthorizedChange === true;
  return {
    evaluateAtomicJudgment: async () => ({ confidence: 0 }),
    evaluateBatchRules: async () => ({ results: {} }),
    evaluateDeltaMeaningChange: async () => ({
      hasUnauthorizedChange: flagged,
      unauthorizedChangeDetected: flagged,
      unauthorizedChanges: [],
      authorized: !flagged,
      ...result,
    }),
  } as unknown as JEVClient;
}

/** A JEV that reaches no conclusion, so the local checks stand alone. */
const SILENT_JEV = jevSaying({ hasUnauthorizedChange: false });

/** A rewriter whose repair never takes. */
const LLM_THAT_CANNOT_FIX = {
  surgicalFix: async (input: { text: string }) => input.text,
} as unknown as LLMProvider;

describe("Delta Check", () => {
  it("does not flag figures it kept just because a sentence was dropped", async () => {
    const original =
      "初代は2017年に発売された。価格は799ドルです。次期モデルは2024年に登場する。";
    const revised = "初代は2017年に発売された。次期モデルは2024年に登場する。";

    const delta = await runDeltaCheck(original, revised, EMPTY_PLAN, {
      jev: SILENT_JEV,
      llm: LLM_THAT_CANNOT_FIX,
    });

    expect(delta.unauthorizedChangeDetected).toBe(false);
    expect(delta.verifiedText).toBe(revised);
  });

  it("restores a figure the rewrite invented", async () => {
    const original = "価格は799ドルです。";
    const revised = "価格は1299ドルです。";

    const delta = await runDeltaCheck(original, revised, EMPTY_PLAN, {
      jev: SILENT_JEV,
    });

    expect(delta.unauthorizedChangeDetected).toBe(true);
    expect(delta.verifiedText).not.toContain("1299");
    expect(delta.verifiedText).toContain("799ドル");
  });

  it("takes the rewrite back when the invented figure cannot be traced", async () => {
    const original = "この製品は高い評価を受けています。";
    const revised = "この製品は利用者の92%から高い評価を受けています。";

    const delta = await runDeltaCheck(original, revised, EMPTY_PLAN, {
      jev: SILENT_JEV,
      llm: LLM_THAT_CANNOT_FIX,
    });

    expect(delta.unauthorizedChangeDetected).toBe(true);
    expect(delta.verifiedText).toBe(original);
  });

  it("never hands back text it flagged, even when the repair fails", async () => {
    const original = "価格は799ドルです。";
    const revised = "価格は1299ドルです。";

    const delta = await runDeltaCheck(original, revised, EMPTY_PLAN, {
      jev: SILENT_JEV,
      llm: LLM_THAT_CANNOT_FIX,
    });

    expect(delta.verifiedText).not.toContain("1299");
  });

  it("takes back a change with no figure in it when JEV says it was not authorised", async () => {
    const original = "本社は東京にあります。";
    const revised = "本社は大阪にあります。";

    const delta = await runDeltaCheck(original, revised, EMPTY_PLAN, {
      jev: jevSaying({
        hasUnauthorizedChange: true,
        unauthorizedChanges: [
          { segment: "大阪", reason: "原文にない地名に書き換えられています。" },
        ],
        explanation: "原文にない地名に書き換えられています。",
      }),
      llm: LLM_THAT_CANNOT_FIX,
    });

    expect(delta.unauthorizedChangeDetected).toBe(true);
    expect(delta.verifiedText).toBe(original);
    expect(delta.unauthorizedChanges.map((c) => c.segment)).toContain("大阪");
  });

  it("leaves an authorised correction in place", async () => {
    const original = "価格は799ドルです。";
    const revised = "価格は699ドルです。";
    const plan: RewritePlan = { ...EMPTY_PLAN, corrections: [] };
    plan.corrections = [
      {
        claimId: "c1",
        originalClaim: "価格は799ドルです",
        correctedClaim: "価格は699ドルです",
        verdict: "CONTRADICTED",
        evidenceIds: [],
      },
    ] as unknown as RewritePlan["corrections"];

    const delta = await runDeltaCheck(original, revised, plan, {
      jev: SILENT_JEV,
      llm: LLM_THAT_CANNOT_FIX,
    });

    expect(delta.unauthorizedChangeDetected).toBe(false);
    expect(delta.verifiedText).toBe(revised);
  });
});
