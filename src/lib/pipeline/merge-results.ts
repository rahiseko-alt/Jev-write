import type { AnalysisResult, ClaimResult, ProviderStatus } from "@/types";

/**
 * One article's result, assembled from the blocks it was checked in.
 *
 * A long article does not fit in a single run, so it is cut into blocks and
 * checked one after another. What the reader gets back is one document, in
 * the order they wrote it: the blocks are concatenated exactly as they were
 * cut, so the text comes back whole.
 *
 * The server trims the text it is sent, so a block's result lacks the blank
 * lines its cut fell on. Given the blocks as they were sent, those line
 * breaks are put back around each block's text; without them, a heading that
 * began a block would run on from the end of the previous paragraph.
 */

/** The block as it was sent, when the server returned it unchanged apart from trimming. */
function restoreEdges(text: string, block: string | undefined): string {
  if (block === undefined || block.trim() !== text.trim()) return text;
  return block;
}

/** Findings from different blocks must not collide: each block numbered its own from one. */
function withBlockId(result: ClaimResult, block: number): ClaimResult {
  return {
    ...result,
    claim: { ...result.claim, id: `b${block}-${result.claim.id}` },
    evidence: result.evidence.map((item) => ({
      ...item,
      id: `b${block}-${item.id}`,
      claimId: `b${block}-${item.claimId}`,
    })),
  };
}

/** A service is in trouble if it was in trouble in any block. */
function mergeStatuses(results: AnalysisResult[]): ProviderStatus[] {
  const byService = new Map<string, ProviderStatus>();

  for (const result of results) {
    for (const status of result.providerStatuses ?? []) {
      const seen = byService.get(status.service);
      if (!seen) {
        byService.set(status.service, { ...status });
        continue;
      }
      seen.failureCount += status.failureCount;
      seen.lastError = seen.lastError || status.lastError;
    }
  }

  return Array.from(byService.values());
}

export function mergeAnalyses(
  results: AnalysisResult[],
  blocks: string[] = []
): AnalysisResult {
  const claims = results.flatMap((result, block) =>
    result.claims.map((claim) => withBlockId(claim, block))
  );

  return {
    originalText: results.map((r, i) => restoreEdges(r.originalText, blocks[i])).join(""),
    revisedText: results.map((r, i) => restoreEdges(r.revisedText, blocks[i])).join(""),
    summary: {
      claimsChecked: results.reduce((n, r) => n + r.summary.claimsChecked, 0),
      supported: results.reduce((n, r) => n + r.summary.supported, 0),
      contradicted: results.reduce((n, r) => n + r.summary.contradicted, 0),
      mixed: results.reduce((n, r) => n + r.summary.mixed, 0),
      insufficient: results.reduce((n, r) => n + r.summary.insufficient, 0),
      styleIssuesFixed: results.reduce((n, r) => n + r.summary.styleIssuesFixed, 0),
    },
    claims,
    styleIssues: results.flatMap((r) => r.styleIssues),
    sources: results.flatMap((r, block) =>
      r.sources.map((source) => ({
        ...source,
        id: `b${block}-${source.id}`,
        claimId: `b${block}-${source.claimId}`,
      }))
    ),
    timings: results.flatMap((r) => r.timings),
    providerStatuses: mergeStatuses(results),
    unauthorizedChangeDetected: results.some((r) => r.unauthorizedChangeDetected),
    revisionRolledBack: results.some((r) => r.revisionRolledBack),
  };
}
