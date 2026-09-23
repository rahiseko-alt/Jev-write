import { describe, it, expect } from "vitest";
import { mergeAnalyses } from "@/lib/pipeline/merge-results";
import type { AnalysisResult } from "@/types";

function analysis(original: string, revised: string, claimId: string): AnalysisResult {
  return {
    originalText: original,
    revisedText: revised,
    summary: {
      claimsChecked: 1,
      supported: 1,
      contradicted: 0,
      mixed: 0,
      insufficient: 0,
      styleIssuesFixed: 0,
    },
    claims: [
      {
        claim: {
          id: claimId,
          originalText: original,
          normalizedText: original,
          importance: "normal",
          factCheckRequired: true,
        },
        verdict: "SUPPORTED",
        evidence: [],
      },
    ],
    styleIssues: [],
    sources: [],
    timings: [{ stage: "FactVerification", durationMs: 100 }],
    providerStatuses: [{ service: "ウェブ検索", failureCount: 0 }],
  };
}

describe("mergeAnalyses", () => {
  it("puts the blocks back together in the order they were checked", () => {
    const merged = mergeAnalyses([
      analysis("一つ目。", "一つ目（修正）。", "claim-1"),
      analysis("二つ目。", "二つ目（修正）。", "claim-1"),
    ]);

    expect(merged.originalText).toBe("一つ目。二つ目。");
    expect(merged.revisedText).toBe("一つ目（修正）。二つ目（修正）。");
  });

  it("keeps each block's findings apart, even when a block numbered them the same", () => {
    const merged = mergeAnalyses([
      analysis("一つ目。", "一つ目。", "claim-1"),
      analysis("二つ目。", "二つ目。", "claim-1"),
    ]);

    const ids = merged.claims.map((c) => c.claim.id);
    expect(new Set(ids).size).toBe(2);
  });

  it("adds the counts up", () => {
    const merged = mergeAnalyses([
      analysis("一つ目。", "一つ目。", "claim-1"),
      analysis("二つ目。", "二つ目。", "claim-2"),
    ]);

    expect(merged.summary.claimsChecked).toBe(2);
    expect(merged.summary.supported).toBe(2);
  });

  it("reports a service as failing when it failed in any block", () => {
    const first = analysis("一つ目。", "一つ目。", "claim-1");
    const second = analysis("二つ目。", "二つ目。", "claim-2");
    second.providerStatuses = [
      { service: "ウェブ検索", failureCount: 2, lastError: "network down" },
    ];

    const merged = mergeAnalyses([first, second]);

    expect(merged.providerStatuses?.[0]).toMatchObject({
      service: "ウェブ検索",
      failureCount: 2,
      lastError: "network down",
    });
  });

  it("says an unauthorized change happened when any block had one", () => {
    const first = analysis("一つ目。", "一つ目。", "claim-1");
    const second = analysis("二つ目。", "二つ目。", "claim-2");
    second.unauthorizedChangeDetected = true;
    second.revisionRolledBack = true;

    const merged = mergeAnalyses([first, second]);

    expect(merged.unauthorizedChangeDetected).toBe(true);
    expect(merged.revisionRolledBack).toBe(true);
  });
});
