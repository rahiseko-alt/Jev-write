import { RewritePlan } from "@/types";
import { JEVClient, LLMProvider, getJEVClient, getLLMProvider } from "@/lib/providers";

export interface DeltaCheckOptions {
  jev?: JEVClient;
  llm?: LLMProvider;
  onProgress?: (progress: {
    percent: number;
    message: string;
  }) => void;
}

export interface DeltaCheckResult {
  verifiedText: string;
  unauthorizedChangeDetected: boolean;
  unauthorizedChanges: Array<{
    segment: string;
    reason: string;
    expectedFact?: string;
  }>;
  surgicalFixApplied: boolean;
}

/**
 * Execute Delta Check (Sections 26-28 of specification)
 * Verifies post-rewrite text against unauthorized factual modifications,
 * and performs surgical corrections if necessary.
 */
export async function runDeltaCheck(
  originalText: string,
  revisedText: string,
  plan: RewritePlan,
  options?: DeltaCheckOptions
): Promise<DeltaCheckResult> {
  const jev = options?.jev ?? getJEVClient();
  const llm = options?.llm ?? getLLMProvider();
  const onProgress = options?.onProgress;

  onProgress?.({
    percent: 88,
    message: "改変差分の事実検査（Delta Check）を実行中...",
  });

  // Extract authorized changes list from plan
  const authorizedChanges: string[] = [];
  for (const correction of plan.corrections) {
    if (correction.correctedClaim) {
      authorizedChanges.push(correction.correctedClaim);
    }
  }

  // Also extract differences in numbers, dates, or entities
  const origNumbers: string[] = originalText.match(/\d+[\d,]*(?:万|億|兆|%|円|ドル|人|個|GB|MB)?/g) || [];
  const revNumbers: string[] = revisedText.match(/\d+[\d,]*(?:万|億|兆|%|円|ドル|人|個|GB|MB)?/g) || [];

  const candidateUnauthorizedSegments: Array<{
    segment: string;
    reason: string;
    expectedFact?: string;
  }> = [];

  for (const num of revNumbers) {
    if (origNumbers.indexOf(num) === -1) {
      const isAuthorized = authorizedChanges.some((c) => c.includes(num));
      if (!isAuthorized) {
        candidateUnauthorizedSegments.push({
          segment: num,
          reason: `新しく追加された数値「${num}」は、ファクト台帳の訂正として承認されていません。`,
          expectedFact: origNumbers[0],
        });
      }
    }
  }

  let hasUnauthorizedChange = candidateUnauthorizedSegments.length > 0;
  let explanation: string | undefined;

  try {
    const deltaRes = await jev.evaluateDeltaMeaningChange(
      originalText,
      revisedText,
      authorizedChanges
    );

    if (deltaRes.hasUnauthorizedChange) {
      hasUnauthorizedChange = true;
      explanation = deltaRes.explanation;
    }
  } catch (err) {
    console.warn("JEV Delta check evaluation failed:", err);
  }

  let verifiedText = revisedText;
  let surgicalFixApplied = false;

  // If unauthorized modifications are detected, perform targeted surgical correction
  if (hasUnauthorizedChange && candidateUnauthorizedSegments.length > 0) {
    onProgress?.({
      percent: 92,
      message: `未承認の変更 (${candidateUnauthorizedSegments.length}件) に対する局所外科的修正中...`,
    });

    for (const unauthorized of candidateUnauthorizedSegments) {
      if (llm.surgicalFix) {
        try {
          verifiedText = await llm.surgicalFix({
            text: verifiedText,
            issueDescription: unauthorized.reason,
            targetSegment: unauthorized.segment,
            expectedFact: unauthorized.expectedFact || originalText,
          });
          surgicalFixApplied = true;
        } catch (err) {
          console.warn("Surgical fix failed for segment:", unauthorized.segment, err);
        }
      } else if (unauthorized.expectedFact && verifiedText.includes(unauthorized.segment)) {
        // Fallback targeted replacement: restore expected fact
        verifiedText = verifiedText.replace(
          unauthorized.segment,
          unauthorized.expectedFact
        );
        surgicalFixApplied = true;
      }
    }
  }

  onProgress?.({
    percent: 95,
    message: "Delta Check 完了",
  });

  return {
    verifiedText,
    unauthorizedChangeDetected: hasUnauthorizedChange,
    unauthorizedChanges: candidateUnauthorizedSegments,
    surgicalFixApplied,
  };
}
