import { RewritePlan } from "@/types";
import { JEVClient, LLMProvider, getJEVClient, getLLMProvider } from "@/lib/providers";
import { Figure, figuresIn } from "@/lib/text/figures";

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
  /** True when the rewrite was taken back wholesale because it could not be made safe. */
  rolledBack: boolean;
}

/**
 * The figures in `text` that the original does not account for.
 *
 * Counted rather than lined up by position: a sentence the rewrite dropped
 * shortens the list without shifting anything, so the figures that survived
 * are still recognised as the original's own.
 */
function unaccountedFigures(
  originalText: string,
  text: string,
  authorizedChanges: string[]
): Figure[] {
  const budget = new Map<string, number>();
  for (const figure of figuresIn(originalText)) {
    budget.set(figure.text, (budget.get(figure.text) ?? 0) + 1);
  }

  const unaccounted: Figure[] = [];
  for (const figure of figuresIn(text)) {
    const left = budget.get(figure.text) ?? 0;
    if (left > 0) {
      budget.set(figure.text, left - 1);
      continue;
    }
    if (authorizedChanges.some((change) => change.includes(figure.text))) {
      continue;
    }
    unaccounted.push(figure);
  }

  return unaccounted;
}

/**
 * The original figure this one stands in for: same unit, introduced by the
 * same words, and itself missing from the rewrite. Where that is not a single
 * unambiguous figure there is nothing to restore, and the rewrite is taken
 * back instead of guessing.
 */
function displacedFigure(
  figure: Figure,
  originalText: string,
  revisedText: string
): Figure | undefined {
  if (!figure.label) return undefined;

  const kept = new Set(figuresIn(revisedText).map((f) => f.text));
  const candidates = figuresIn(originalText).filter(
    (f) => !kept.has(f.text) && f.unit === figure.unit && f.label === figure.label
  );

  return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * Execute Delta Check (Sections 26-28 of specification)
 * Verifies post-rewrite text against unauthorized factual modifications,
 * and performs surgical corrections if necessary.
 *
 * Whatever this finds is put right or taken back out. Text it flagged is
 * never returned as verified.
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

  const candidateUnauthorizedSegments: Array<{
    segment: string;
    reason: string;
    expectedFact?: string;
    index?: number;
  }> = unaccountedFigures(originalText, revisedText, authorizedChanges).map(
    (figure) => ({
      segment: figure.text,
      reason: `新しく現れた数値「${figure.text}」は、ファクト台帳の訂正として承認されていません。`,
      expectedFact: displacedFigure(figure, originalText, revisedText)?.text,
      index: figure.index,
    })
  );

  const reportedChanges: DeltaCheckResult["unauthorizedChanges"] =
    candidateUnauthorizedSegments.map(({ segment, reason, expectedFact }) => ({
      segment,
      reason,
      expectedFact,
    }));

  let hasUnauthorizedChange = candidateUnauthorizedSegments.length > 0;
  let jevHasUnauthorizedChange = false;

  try {
    const deltaRes = await jev.evaluateDeltaMeaningChange(
      originalText,
      revisedText,
      authorizedChanges
    );

    if (deltaRes.hasUnauthorizedChange) {
      hasUnauthorizedChange = true;
      jevHasUnauthorizedChange = true;

      const explanation =
        deltaRes.explanation || "原文にない事実の書き換えが見つかりました。";

      for (const change of deltaRes.unauthorizedChanges ?? []) {
        if (!change?.segment) continue;
        if (reportedChanges.some((r) => r.segment === change.segment)) continue;
        reportedChanges.push({
          segment: change.segment,
          reason: change.reason || explanation,
          expectedFact: change.expectedFact,
        });
      }

      if (reportedChanges.length === 0) {
        reportedChanges.push({ segment: revisedText, reason: explanation });
      }
    }
  } catch (err) {
    console.warn("JEV Delta check evaluation failed:", err);
  }

  let verifiedText = revisedText;
  let surgicalFixApplied = false;
  let rolledBack = false;

  if (jevHasUnauthorizedChange) {
    // JEV names a meaning change that the figure check cannot localise, so the
    // only text known to be safe is the one the reader wrote.
    verifiedText = originalText;
    rolledBack = true;
  } else if (candidateUnauthorizedSegments.length > 0) {
    onProgress?.({
      percent: 92,
      message: `未承認の変更 (${candidateUnauthorizedSegments.length}件) に対する局所外科的修正中...`,
    });

    for (const unauthorized of candidateUnauthorizedSegments) {
      // Without the figure it displaced there is nothing to put back, and
      // inventing one would be the very thing this check exists to stop.
      if (!unauthorized.expectedFact) continue;

      if (llm.surgicalFix) {
        try {
          verifiedText = await llm.surgicalFix({
            text: verifiedText,
            issueDescription: unauthorized.reason,
            targetSegment: unauthorized.segment,
            expectedFact: unauthorized.expectedFact,
          });
          surgicalFixApplied = true;
        } catch (err) {
          console.warn("Surgical fix failed for segment:", unauthorized.segment, err);
        }
      } else if (verifiedText.includes(unauthorized.segment)) {
        // Fallback targeted replacement: restore expected fact
        let targetIndex = -1;
        if (unauthorized.index !== undefined) {
          const searchStart = Math.max(0, unauthorized.index - 10);
          targetIndex = verifiedText.indexOf(unauthorized.segment, searchStart);
        }

        if (targetIndex === -1) {
          targetIndex = verifiedText.indexOf(unauthorized.segment);
        }

        if (targetIndex !== -1) {
          verifiedText =
            verifiedText.slice(0, targetIndex) +
            unauthorized.expectedFact +
            verifiedText.slice(targetIndex + unauthorized.segment.length);
          surgicalFixApplied = true;
        }
      }
    }

    // A repair counts only if it held. Anything still unaccounted for means the
    // rewrite goes back, rather than reaching the reader marked as checked.
    if (unaccountedFigures(originalText, verifiedText, authorizedChanges).length > 0) {
      verifiedText = originalText;
      surgicalFixApplied = false;
      rolledBack = true;
    }
  }

  onProgress?.({
    percent: 95,
    message: "Delta Check 完了",
  });

  return {
    verifiedText,
    unauthorizedChangeDetected: hasUnauthorizedChange,
    unauthorizedChanges: reportedChanges,
    surgicalFixApplied,
    rolledBack,
  };
}
