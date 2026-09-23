import { runOrchestrator } from "./pipeline/orchestrator";
import { jobStore } from "./job-store";

/**
 * Executes the full Quality Assurance analysis for a given job.
 * `startedAt` is when the request came in (Date.now()): the run's deadline
 * is counted from there (ADR-0021).
 */
export async function runAnalysis(
  jobId: string,
  text: string,
  options: { startedAt?: number } = {}
): Promise<void> {
  try {
    await runOrchestrator(text, {
      jobId,
      jobStore: jobStore as any,
      startedAt: options.startedAt,
    });
  } catch (error) {
    console.error(`Analysis failed for job ${jobId}:`, error);
    const errorMsg = error instanceof Error ? error.message : "予期せぬエラーが発生しました";
    jobStore.updateJob(jobId, {
      status: "FAILED",
      currentMessage: `エラー: ${errorMsg}`,
      error: errorMsg,
    });
  }
}
