import { StyleIssue } from "@/types";
import { getEnabledStyleRules, getStyleRuleById } from "@/lib/rules/style-rules";
import { JEVClient, getJEVClient } from "@/lib/providers";

export interface StylePipelineOptions {
  jev?: JEVClient;
  confidenceThreshold?: number; // Default 0.65
  onProgress?: (progress: {
    percent: number;
    message: string;
    styleIssuesCount?: number;
  }) => void;
}

const SEVERITY_ORDER: Record<string, number> = {
  high: 1,
  medium: 2,
  low: 3,
};

/**
 * Execute Style Pipeline (Sections 18-21 of specification)
 * Evaluates text against AI-tell rules using JEV atomic batch evaluation.
 */
export async function runStylePipeline(
  text: string,
  options?: StylePipelineOptions
): Promise<StyleIssue[]> {
  const jev = options?.jev ?? getJEVClient();
  const threshold = options?.confidenceThreshold ?? 0.65;
  const onProgress = options?.onProgress;

  onProgress?.({
    percent: 30,
    message: "文章スタイル・AI特有表現（AI-tell）の並列検査中...",
  });

  const enabledRules = getEnabledStyleRules();

  const detectedIssues: StyleIssue[] = [];

  try {
    // Format request conforming to JEVBatchRulesRequest
    const batchReq = {
      text,
      questions: enabledRules.map((r) => ({
        id: r.id,
        question: r.jevQuestion,
      })),
    };

    const batchRes = await jev.evaluateBatchRules(batchReq as any);
    const results = batchRes?.results || {};

    for (const rule of enabledRules) {
      const res = results[rule.id];
      if (res && res.detected && (res.confidence ?? 1.0) >= threshold) {
        detectedIssues.push({
          ruleId: rule.id,
          ruleName: rule.name,
          detected: true,
          confidence: res.confidence,
          severity: rule.severity,
          targetText: res.targetSnippet,
          repairInstruction: rule.repairInstruction,
        });
      }
    }
  } catch (err) {
    // An inspection that could not run is not an article without AI-tells.
    // The run stops and says which service could not answer.
    throw err;
  }

  // Sort by severity (high -> medium -> low)
  detectedIssues.sort(
    (a, b) => (SEVERITY_ORDER[a.severity] || 4) - (SEVERITY_ORDER[b.severity] || 4)
  );

  onProgress?.({
    percent: 60,
    message: `スタイル検査完了 (検出: ${detectedIssues.length}件)`,
    styleIssuesCount: detectedIssues.length,
  });

  return detectedIssues;
}
