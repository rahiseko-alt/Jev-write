import {
  AnalysisResult,
  ProviderStatus,
  JobProgressEvent,
  JobStatus,
  StageTiming,
} from "@/types";
import { JobStore, jobStore as defaultJobStore } from "@/lib/jobs/job-store";
import {
  getFetchProvider,
  getGoogleFactCheckClient,
  getJEVClient,
  getLLMProvider,
  getSearchProvider,
} from "../providers";
import { runFactPipeline } from "./fact-pipeline";
import { runStylePipeline } from "./style-pipeline";
import { runRewritePipeline } from "./rewrite-pipeline";
import { runDeltaCheck } from "./delta-check";
import {
  FetchProvider,
  GoogleFactCheckClient,
  JEVClient,
  LLMProvider,
  SearchProvider,
} from "@/lib/providers";

export interface OrchestratorOptions {
  jobId?: string;
  jobStore?: JobStore;
  llm?: LLMProvider;
  factCheck?: GoogleFactCheckClient;
  jev?: JEVClient;
  search?: SearchProvider;
  fetch?: FetchProvider;
  onProgress?: (event: JobProgressEvent) => void;
}

/**
 * Main Quality Assurance Pipeline Orchestrator (Sections 29-33 of specification)
 * Coordinates Fact & Style pipelines in parallel, executes Rewrite, Delta Check,
 * and streams progress updates.
 */
export async function runOrchestrator(
  text: string,
  options?: OrchestratorOptions
): Promise<AnalysisResult> {
  const store = options?.jobStore ?? defaultJobStore;
  const jobId = options?.jobId ?? `job-${Date.now()}`;
  const onProgress = options?.onProgress;

  const timings: StageTiming[] = [];

  // Every stage of one run shares one set of providers, so the run can say
  // afterwards whether any of it was answered by a stand-in.
  const llm = options?.llm ?? getLLMProvider();
  const factCheck = options?.factCheck ?? getGoogleFactCheckClient();
  const jev = options?.jev ?? getJEVClient();
  const search = options?.search ?? getSearchProvider();
  const fetchProvider = options?.fetch ?? getFetchProvider();

  const emit = (
    status: JobStatus,
    progressPercent: number,
    currentMessage: string,
    extra?: { claimsCount?: number; factHits?: number; styleIssuesCount?: number }
  ) => {
    const event: JobProgressEvent = {
      jobId,
      status,
      progressPercent,
      currentMessage,
      claimsCount: extra?.claimsCount,
      factHits: extra?.factHits,
      styleIssuesCount: extra?.styleIssuesCount,
      timestamp: new Date().toISOString(),
    };

    store.emitProgress(event);
    onProgress?.(event);
  };

  try {
    emit("ANALYZING", 5, "文章の構造解析と主張（Claim）の抽出を開始...");

    // Stage 1 & 2: Parallel Fact Pipeline and Style Pipeline
    const parallelStartTime = Date.now();

    const [factResult, styleResult] = await Promise.all([
      // Fact Pipeline
      (async () => {
        const factStart = Date.now();
        const res = await runFactPipeline(text, {
          llm,
          factCheck,
          jev,
          search,
          fetch: fetchProvider,
          onProgress: (p) => {
            if (p.stage === "FACTCHECK_DB") {
              emit("FACTCHECK_DATABASE", p.percent, p.message, {
                claimsCount: p.claimsCount,
              });
            } else if (p.stage === "WEB_SEARCH") {
              emit("WEB_SEARCH", p.percent, p.message, {
                claimsCount: p.claimsCount,
                factHits: p.factHits,
              });
            } else {
              emit("ANALYZING", p.percent, p.message, {
                claimsCount: p.claimsCount,
              });
            }
          },
        });
        timings.push({
          stage: "FactVerification",
          durationMs: Date.now() - factStart,
        });
        return res;
      })(),

      // Style Pipeline
      (async () => {
        const styleStart = Date.now();
        const res = await runStylePipeline(text, {
          jev,
          onProgress: (p) => {
            emit("STYLE_ANALYSIS", p.percent, p.message, {
              styleIssuesCount: p.styleIssuesCount,
            });
          },
        });
        timings.push({
          stage: "StyleAnalysis",
          durationMs: Date.now() - styleStart,
        });
        return res;
      })(),
    ]);

    timings.push({
      stage: "ParallelAnalysisPhase",
      durationMs: Date.now() - parallelStartTime,
    });

    emit(
      "REWRITING",
      65,
      `ファクト台帳とスタイル問題に基づく修正計画（RewritePlan）を策定中...`,
      {
        claimsCount: factResult.claims.length,
        styleIssuesCount: styleResult.length,
      }
    );

    // Stage 3: Rewrite Pipeline
    const rewriteStartTime = Date.now();
    const rewriteOutput = await runRewritePipeline(
      text,
      factResult.factLedger,
      styleResult,
      {
        llm,
        onProgress: (p) => {
          emit("REWRITING", p.percent, p.message);
        },
      }
    );
    timings.push({
      stage: "Rewrite",
      durationMs: Date.now() - rewriteStartTime,
    });

    // Stage 4: Delta Check & Final Verification
    emit("VERIFYING", 85, "リライト文章の差分検査（Delta Check）を実行中...");
    const deltaStartTime = Date.now();
    const deltaResult = await runDeltaCheck(
      text,
      rewriteOutput.revisedText,
      rewriteOutput.plan,
      {
        jev,
        llm,
        onProgress: (p) => {
          emit("VERIFYING", p.percent, p.message);
        },
      }
    );
    timings.push({
      stage: "DeltaCheck",
      durationMs: Date.now() - deltaStartTime,
    });

    const providerStatuses: ProviderStatus[] = [
      { service: "文章の生成", provider: llm },
      { service: "判定（JEV）", provider: jev },
      { service: "ファクトチェック照会", provider: factCheck },
      { service: "ウェブ検索", provider: search },
      { service: "ページの取得", provider: fetchProvider },
    ].map(({ service, provider }) => ({
      service,
      stoodIn: provider.servedByFallback === true,
      failureCount: provider.failureCount ?? 0,
      lastError: provider.lastError,
    }));

    // Synthesize final result summary
    let supported = 0;
    let contradicted = 0;
    let mixed = 0;
    let insufficient = 0;

    for (const c of factResult.claims) {
      switch (c.verdict) {
        case "SUPPORTED":
          supported++;
          break;
        case "CONTRADICTED":
          contradicted++;
          break;
        case "MIXED":
          mixed++;
          break;
        case "INSUFFICIENT":
          insufficient++;
          break;
      }
    }

    const finalResult: AnalysisResult = {
      originalText: text,
      revisedText: deltaResult.verifiedText,
      summary: {
        claimsChecked: factResult.claims.length,
        supported,
        contradicted,
        mixed,
        insufficient,
        styleIssuesFixed: styleResult.length,
      },
      claims: factResult.claims,
      styleIssues: styleResult,
      sources: factResult.evidences,
      timings,
      servedByFallback: providerStatuses.some((status) => status.stoodIn),
      providerStatuses,
      unauthorizedChangeDetected: deltaResult.unauthorizedChangeDetected,
      revisionRolledBack: deltaResult.rolledBack,
    };

    store.updateJob(jobId, {
      status: "COMPLETED",
      progressPercent: 100,
      currentMessage: "文章品質保証の全プロセスが完了しました",
      claimsCount: factResult.claims.length,
      styleIssuesCount: styleResult.length,
      result: finalResult,
    });

    emit("COMPLETED", 100, "文章品質保証の全プロセスが完了しました", {
      claimsCount: factResult.claims.length,
      styleIssuesCount: styleResult.length,
    });

    return finalResult;
  } catch (err: unknown) {
    const errorMessage =
      err instanceof Error ? err.message : "予期しないエラーが発生しました";

    console.error("Orchestrator encountered a fatal error:", err);

    store.updateJob(jobId, {
      status: "FAILED",
      currentMessage: `処理に失敗しました: ${errorMessage}`,
      error: errorMessage,
    });

    emit("FAILED", 100, `処理に失敗しました: ${errorMessage}`);
    throw err;
  }
}
