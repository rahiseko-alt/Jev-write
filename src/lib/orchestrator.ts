import { runOrchestrator } from "./pipeline/orchestrator";
import { jobStore } from "./job-store";

/**
 * Executes the full Quality Assurance analysis for a given job.
 */
export async function runAnalysis(jobId: string, text: string): Promise<void> {
  try {
    await runOrchestrator(text, {
      jobId,
      jobStore: jobStore as any,
    });
  } catch (error) {
    console.error(`Analysis failed for job ${jobId}:`, error);
    const errorMsg = error instanceof Error ? `${error.message} [Stack: ${error.stack}]` : "予期せぬエラーが発生しました";
    jobStore.updateJob(jobId, {
      status: "FAILED",
      currentMessage: `エラー: ${errorMsg}`,
      error: errorMsg,
    });
  }
}
