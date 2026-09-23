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
import { Clock, JevLimits, TimeBudget, createTimeBudget, systemClock } from "./time-budget";
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
  /** Where the time comes from. A test hands in a clock it moves itself. */
  clock?: Clock;
  /** The run's time budget (time-budget.ts); by default one that starts now. */
  budget?: TimeBudget;
  /** JEV's limits, when a test narrows them; by default the official ones. */
  jevLimits?: Partial<JevLimits>;
}

/**
 * Main Quality Assurance Pipeline Orchestrator (Sections 29-33 of specification)
 * Runs the Fact pipeline and streams progress updates.
 */
export async function runOrchestrator(
  text: string,
  options?: OrchestratorOptions
): Promise<AnalysisResult> {
  const store = options?.jobStore ?? defaultJobStore;
  const jobId = options?.jobId ?? `job-${Date.now()}`;
  const onProgress = options?.onProgress;

  // The run's clock starts here, as early as the run itself (ADR-0021): every
  // deadline of the budget is counted from this moment.
  const clock = options?.budget?.clock ?? options?.clock ?? systemClock;
  const budget = options?.budget ?? createTimeBudget(clock);

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
    extra?: { claimsCount?: number; factHits?: number }
  ) => {
    const event: JobProgressEvent = {
      jobId,
      status,
      progressPercent,
      currentMessage,
      claimsCount: extra?.claimsCount,
      factHits: extra?.factHits,
      timestamp: new Date().toISOString(),
    };

    store.emitProgress(event);
    onProgress?.(event);
  };

  try {
    emit("ANALYZING", 5, "文章の構造解析と主張（Claim）の抽出を開始...");

    const factStart = clock.now();
    const factResult = await runFactPipeline(text, {
      llm,
      factCheck,
      jev,
      search,
      fetch: fetchProvider,
      budget,
      jevLimits: options?.jevLimits,
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
    // Each stage on its own (extraction, query generation, search, page
    // fetch, fact-check lookup, relevance and 信頼度 judgments), with the JEV
    // requests it sent; then the whole of it. Observability only (ADR-0021).
    const factEnd = clock.now();
    timings.push(...factResult.timings);
    timings.push({
      stage: "FactVerification",
      durationMs: factEnd - factStart,
      startMs: factStart - budget.startedAt,
      endMs: factEnd - budget.startedAt,
    });

    // No rewriting. This tool reports how well each sentence is held up and
    // leaves the writing to the writer: nothing here changes their words.
    emit("ANALYZING", 85, "結果をまとめています...");

    const providerStatuses: ProviderStatus[] = [
      { service: "文章の生成", provider: llm },
      { service: "判定（JEV）", provider: jev },
      { service: "ファクトチェック照会", provider: factCheck },
      { service: "ウェブ検索", provider: search },
      { service: "ページの取得", provider: fetchProvider },
    ].map(({ service, provider }) => ({
      service,
      failureCount: provider.failureCount ?? 0,
      lastError: provider.lastError,
      retryCount: (provider as { retryCount?: number }).retryCount ?? 0,
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
      // The document as written. Nothing was rewritten.
      revisedText: text,
      summary: {
        claimsChecked: factResult.claims.length,
        supported,
        contradicted,
        mixed,
        insufficient,
        // AI-tell detection was removed: there are no style findings.
        styleIssuesFixed: 0,
      },
      claims: factResult.claims,
      styleIssues: [],
      sources: factResult.evidences,
      timings,
      providerStatuses,
      // What became of every sentence the code cut: claims, set aside with a
      // reason, or missing from the answer (ADR-0020). Kept with the result
      // so a missing sentence is on record, and two runs can be compared.
      extraction: llm.lastExtraction,
    };

    store.updateJob(jobId, {
      status: "COMPLETED",
      progressPercent: 100,
      currentMessage: "文章品質保証の全プロセスが完了しました",
      claimsCount: factResult.claims.length,
      result: finalResult,
    });

    emit("COMPLETED", 100, "文章品質保証の全プロセスが完了しました", {
      claimsCount: factResult.claims.length,
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
