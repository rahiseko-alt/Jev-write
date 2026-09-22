"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  ShieldCheck,
  CheckCircle2,
  AlertTriangle,
  HelpCircle,
  Sparkles,
  Copy,
  Check,
  RotateCcw,
  ExternalLink,
  Columns,
  Eye,
  FileCheck,
  FileText,
  Wand2,
  Database,
  ArrowRight,
  Info,
  Loader2,
  Search,
  CheckCheck,
  AlertCircle,
} from "lucide-react";
import { AnalysisResult, ClaimResult, Evidence, JobProgressEvent, JobStatus, StyleIssue } from "@/types";

// Samples
const SAMPLE_1 = `近年、目覚ましい進化を遂げるテクノロジーの波は、私たちの日常生活に劇的な変革をもたらしています。OpenAIは2025年6月に次世代モデルGPT-5を全世界で正式リリースし、人々の知的生産性を飛躍的に高める革新的で先進的なブレイクスルーの技術革新を達成しました。一方で利便性が享受される半面、他方ではリスクへの懸念も叫ばれており、光と影のコントラストが際立っています。

現在のAI導入企業率は日本国内において98%に達しており、業務の自動化が急速に加速しています。文部科学省は初等中等教育における生成AI利用ガイドラインを改定し活用を推進しているものの、専門家の間ではAIによる完全自動化ですべての知的労働が代替されると言われています。未来の扉を開く唯一無二の鍵となることは想像に難くありません。`;

const SAMPLE_2 = `洗練された極上のデザインと息をのむような圧倒的パフォーマンスが完璧な調和を奏でています。新型スマートフォンは、従来比でバッテリー容量が500%向上し、連続使用時間は3週間に達するという驚異的なスペックを誇ります。

耐久性についても抜かりはなく、IP68相当の防塵防水性能を備えており水深1.5mで30分間の浸水に耐えられます。ただし、一部のユーザーから高温環境下でディスプレイの輝度低下が報告されている点には注意が必要です。なお、同端末は競合他社のすべてのフラッグシップ機より圧倒的に低価格であると謳われています。

あなたのデジタルライフを一新する相棒として、ぜひ手に取ってみてはいかがでしょうか。`;

// Pipeline stage definitions
interface StageInfo {
  id: JobStatus;
  step: number;
  label: string;
  sublabel: string;
}

const STAGES: StageInfo[] = [
  { id: "ANALYZING", step: 1, label: "Claim抽出", sublabel: "主張の検出" },
  { id: "FACTCHECK_DATABASE", step: 2, label: "Google Fact Check", sublabel: "公的ファクトチェック照合" },
  { id: "WEB_SEARCH", step: 3, label: "Web検索 & 本文取得", sublabel: "追加情報確認" },
  { id: "STYLE_ANALYSIS", step: 4, label: "文章表現検査", sublabel: "AI-tell 12ルール並列評価" },
  { id: "REWRITING", step: 5, label: "文章修正", sublabel: "Fact Ledgerに基づく自然な再構成" },
  { id: "VERIFYING", step: 6, label: "差分再検証", sublabel: "新ハルシネーション検査" },
];

function getStageIndex(status: JobStatus): number {
  switch (status) {
    case "QUEUED":
      return 0;
    case "ANALYZING":
      return 1;
    case "FACTCHECK_DATABASE":
      return 2;
    case "WEB_SEARCH":
      return 3;
    case "STYLE_ANALYSIS":
      return 4;
    case "REWRITING":
      return 5;
    case "VERIFYING":
      return 6;
    case "COMPLETED":
      return 7;
    default:
      return 0;
  }
}

export default function HomePage() {
  // Input state
  const [inputText, setInputText] = useState("");
  const [activeJobId, setActiveJobId] = useState<string | null>(null);

  // Execution state
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [progressEvent, setProgressEvent] = useState<JobProgressEvent | null>(null);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Result UI state
  const [activeTab, setActiveTab] = useState<"revised" | "claims" | "style" | "sources">("revised");
  const [diffMode, setDiffMode] = useState<"clean" | "side-by-side">("clean");
  const [copied, setCopied] = useState(false);
  const [claimFilter, setClaimFilter] = useState<"ALL" | "CONTRADICTED" | "SUPPORTED" | "MIXED" | "INSUFFICIENT">("ALL");

  const eventSourceRef = useRef<EventSource | null>(null);

  // Cleanup SSE on unmount
  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, []);

  // Poll for result or fetch when completed
  const fetchFinalJobResult = useCallback(async (jobId: string) => {
    try {
      const res = await fetch(`/api/analyze/${jobId}`);
      if (!res.ok) throw new Error("ジョブ結果の取得に失敗しました");
      const data = await res.json();
      if (data.job?.result) {
        setAnalysisResult(data.job.result);
      }
    } catch (err) {
      console.error(err);
      setErrorMessage("結果の読み込み中にエラーが発生しました。");
    }
  }, []);

  // Handle Form Submit
  const handleStartAnalysis = async () => {
    if (!inputText.trim()) return;
    setErrorMessage(null);
    setAnalysisResult(null);
    setProgressEvent(null);
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: inputText }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "リクエストに失敗しました");
      }

      const resData = await response.json();
      const { jobId, result } = resData;
      setActiveJobId(jobId);

      if (result) {
        setAnalysisResult(result);
        setIsSubmitting(false);
        return;
      }

      // Connect to SSE
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }

      const es = new EventSource(`/api/analyze/${jobId}/events`);
      eventSourceRef.current = es;

      es.onmessage = (event) => {
        try {
          const data: JobProgressEvent = JSON.parse(event.data);
          setProgressEvent(data);

          if (data.status === "COMPLETED") {
            es.close();
            fetchFinalJobResult(jobId);
          } else if (data.status === "FAILED") {
            es.close();
            setErrorMessage(data.currentMessage || "処理が失敗しました。");
          }
        } catch (e) {
          console.error("SSE parse error", e);
        }
      };

      es.onerror = (e) => {
        console.error("SSE error, falling back to polling", e);
        es.close();
        // Fallback poll
        const interval = setInterval(async () => {
          try {
            const res = await fetch(`/api/analyze/${jobId}`);
            if (!res.ok) return;
            const resData = await res.json();
            if (resData.job) {
              setProgressEvent({
                jobId: resData.job.id,
                status: resData.job.status,
                progressPercent: resData.job.progressPercent,
                currentMessage: resData.job.currentMessage,
                timestamp: new Date().toISOString(),
              });
              if (resData.job.status === "COMPLETED") {
                clearInterval(interval);
                setAnalysisResult(resData.job.result);
              } else if (resData.job.status === "FAILED") {
                clearInterval(interval);
                setErrorMessage(resData.job.error || "処理に失敗しました");
              }
            }
          } catch {
            clearInterval(interval);
          }
        }, 1000);
      };
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "送信中にエラーが発生しました");
    } finally {
      setIsSubmitting(false);
    }
  };

  // Copy to clipboard
  const handleCopy = () => {
    if (!analysisResult) return;
    navigator.clipboard.writeText(analysisResult.revisedText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  // Reset to initial screen
  const handleReset = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }
    setActiveJobId(null);
    setProgressEvent(null);
    setAnalysisResult(null);
    setErrorMessage(null);
    setActiveTab("revised");
  };

  // Filtered claims
  const filteredClaims = analysisResult?.claims.filter((c) => {
    if (claimFilter === "ALL") return true;
    return c.verdict === claimFilter;
  }) || [];

  const currentStageIndex = progressEvent ? getStageIndex(progressEvent.status) : 0;
  const isProcessing = activeJobId !== null && analysisResult === null && !errorMessage;

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      {/* Top Navigation Bar */}
      <header className="sticky top-0 z-40 w-full border-b border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-900/80 backdrop-blur-md">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-blue-600 to-indigo-600 text-white shadow-md shadow-blue-500/20">
              <ShieldCheck className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-lg tracking-tight bg-gradient-to-r from-blue-600 via-indigo-600 to-violet-600 bg-clip-text text-transparent">
                  Jev-write
                </span>
                <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 font-medium border border-blue-200 dark:border-blue-800">
                  文章品質保証システム
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 hidden sm:block">
                事実確認・AI表現検査・安全修正・差分再検証
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {analysisResult && (
              <button
                onClick={handleReset}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs sm:text-sm font-medium border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>別の文章を検査</span>
              </button>
            )}
            <div className="hidden md:flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 pl-2 border-l border-slate-200 dark:border-slate-800">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
              JEV Engine Ready
            </div>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Error Alert */}
        {errorMessage && (
          <div className="mb-6 p-4 rounded-xl border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300 flex items-start justify-between">
            <div className="flex items-start gap-3">
              <AlertCircle className="w-5 h-5 mt-0.5 flex-shrink-0 text-red-500" />
              <div>
                <h4 className="font-semibold text-sm">エラーが発生しました</h4>
                <p className="text-sm mt-0.5">{errorMessage}</p>
              </div>
            </div>
            <button
              onClick={handleReset}
              className="text-xs underline hover:no-underline text-red-600 dark:text-red-400 font-medium"
            >
              最初に戻る
            </button>
          </div>
        )}

        {/* 1. INITIAL STATE VIEW */}
        {!activeJobId && !analysisResult && (
          <div className="max-w-4xl mx-auto space-y-8 animate-fadeIn">
            {/* Hero Header */}
            <div className="text-center space-y-3 pt-4 pb-2">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 text-xs font-semibold border border-blue-200/60 dark:border-blue-800/60">
                <Sparkles className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
                JEV 原子判定 × 事実台帳 (Fact Ledger) 技術搭載
              </div>
              <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-slate-900 dark:text-white">
                文章品質保証システム{" "}
                <span className="bg-gradient-to-r from-blue-600 via-indigo-600 to-violet-600 bg-clip-text text-transparent">
                  Jev-write
                </span>
              </h1>
              <p className="text-slate-600 dark:text-slate-300 text-sm sm:text-base max-w-2xl mx-auto leading-relaxed">
                外部公的ファクトチェックと12のAI-tellルールによる並列評価。事実を絶対に壊さずに自然な日本語へと推敲・再検証します。
              </p>
            </div>

            {/* Input Card */}
            <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-xl shadow-slate-200/50 dark:shadow-none border border-slate-200 dark:border-slate-800 p-5 sm:p-6 transition-all">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-slate-100 dark:border-slate-800">
                <label
                  htmlFor="input-textarea"
                  className="font-semibold text-sm text-slate-700 dark:text-slate-200 flex items-center gap-2"
                >
                  <FileText className="w-4 h-4 text-blue-600" />
                  検査対象の文章を入力
                </label>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-400 dark:text-slate-500 font-mono">
                    {inputText.length.toLocaleString()} / 10,000文字
                  </span>
                  {inputText.length > 0 && (
                    <button
                      onClick={() => setInputText("")}
                      className="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 underline"
                    >
                      クリア
                    </button>
                  )}
                </div>
              </div>

              <div className="mt-3">
                <textarea
                  id="input-textarea"
                  rows={9}
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  placeholder="ここに検査したい文章を貼り付けてください（ニュース記事、製品レビュー、オウンドメディア記事、レポートなど）..."
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-950/50 focus:bg-white dark:focus:bg-slate-900 text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 text-sm sm:text-base leading-relaxed resize-y font-sans transition"
                />
              </div>

              {/* Sample Buttons & Action */}
              <div className="mt-4 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4 pt-3 border-t border-slate-100 dark:border-slate-800">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium text-slate-500 dark:text-slate-400 mr-1">
                    サンプル挿入:
                  </span>
                  <button
                    type="button"
                    onClick={() => setInputText(SAMPLE_1)}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 transition flex items-center gap-1.5"
                  >
                    <span>サンプル 1</span>
                    <span className="text-[11px] text-slate-500 dark:text-slate-400">
                      (AI表現と誤情報のニュース)
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setInputText(SAMPLE_2)}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 transition flex items-center gap-1.5"
                  >
                    <span>サンプル 2</span>
                    <span className="text-[11px] text-slate-500 dark:text-slate-400">
                      (ガジェットレビュー)
                    </span>
                  </button>
                </div>

                <button
                  type="button"
                  onClick={handleStartAnalysis}
                  disabled={!inputText.trim() || isSubmitting}
                  className="px-6 py-3 rounded-xl font-semibold text-sm text-white bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 shadow-lg shadow-blue-500/25 active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none flex items-center justify-center gap-2"
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>準備中...</span>
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-4 h-4" />
                      <span>検査して修正</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Feature Highlights Grid */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-4">
              <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white/60 dark:bg-slate-900/60 backdrop-blur-sm space-y-2">
                <div className="w-8 h-8 rounded-lg bg-emerald-100 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 flex items-center justify-center">
                  <CheckCircle2 className="w-5 h-5" />
                </div>
                <h3 className="font-semibold text-sm text-slate-800 dark:text-slate-200">
                  公的DB & Web事実確認
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                  Google Fact Checkや公的統計・白書と自動照合。誤りや不確かな数値を検出し根拠を提示します。
                </p>
              </div>

              <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white/60 dark:bg-slate-900/60 backdrop-blur-sm space-y-2">
                <div className="w-8 h-8 rounded-lg bg-indigo-100 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 flex items-center justify-center">
                  <Wand2 className="w-5 h-5" />
                </div>
                <h3 className="font-semibold text-sm text-slate-800 dark:text-slate-200">
                  AI-tell 12ルール検査
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                  空疎な汎用導入、過剰な二項対比、同義語の無意味な反復など、読者に違和感を与えるAI癖を検出。
                </p>
              </div>

              <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white/60 dark:bg-slate-900/60 backdrop-blur-sm space-y-2">
                <div className="w-8 h-8 rounded-lg bg-blue-100 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 flex items-center justify-center">
                  <ShieldCheck className="w-5 h-5" />
                </div>
                <h3 className="font-semibold text-sm text-slate-800 dark:text-slate-200">
                  事実台帳と差分再検証
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                  検証済み事実をFact Ledgerに固定して修正。修正後の文章を再検査し新ハルシネーションを遮断します。
                </p>
              </div>
            </div>
          </div>
        )}

        {/* 2. PROCESSING STATE VIEW */}
        {isProcessing && (
          <div className="max-w-3xl mx-auto space-y-6 py-6 animate-fadeIn">
            <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-xl shadow-slate-200/50 dark:shadow-none border border-slate-200 dark:border-slate-800 p-6 sm:p-8 space-y-6">
              {/* Header */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="relative">
                    <div className="w-10 h-10 rounded-xl bg-blue-600/10 text-blue-600 flex items-center justify-center">
                      <Loader2 className="w-5 h-5 animate-spin" />
                    </div>
                    <span className="absolute -top-1 -right-1 flex h-3 w-3">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-3 w-3 bg-blue-500"></span>
                    </span>
                  </div>
                  <div>
                    <h3 className="font-bold text-base text-slate-900 dark:text-white">
                      品質保証検査と文章推敲を実行中...
                    </h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      パイプラインが各ステップを順次処理しています
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <span className="text-2xl font-bold font-mono text-blue-600 dark:text-blue-400">
                    {progressEvent?.progressPercent ?? 10}%
                  </span>
                </div>
              </div>

              {/* Progress Bar */}
              <div className="w-full bg-slate-100 dark:bg-slate-800 rounded-full h-2.5 overflow-hidden">
                <div
                  className="bg-gradient-to-r from-blue-600 to-indigo-600 h-2.5 rounded-full transition-all duration-500 ease-out"
                  style={{ width: `${progressEvent?.progressPercent ?? 10}%` }}
                ></div>
              </div>

              {/* Live Status Message */}
              <div className="p-3 rounded-xl bg-blue-50/70 dark:bg-blue-950/40 border border-blue-100 dark:border-blue-900/50 text-blue-900 dark:text-blue-200 text-xs sm:text-sm flex items-center gap-2">
                <Info className="w-4 h-4 flex-shrink-0 text-blue-600 dark:text-blue-400" />
                <span className="font-medium animate-pulse">
                  {progressEvent?.currentMessage || "初期処理を準備中..."}
                </span>
              </div>

              {/* 6 Stage Indicators */}
              <div className="space-y-2.5 pt-2">
                <h4 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                  処理パイプライン進捗
                </h4>
                <div className="grid grid-cols-1 gap-2">
                  {STAGES.map((stage) => {
                    const isPassed = currentStageIndex > stage.step;
                    const isCurrent = currentStageIndex === stage.step;
                    const isPending = currentStageIndex < stage.step;

                    return (
                      <div
                        key={stage.id}
                        className={`flex items-center justify-between p-3 rounded-xl border transition-all ${
                          isCurrent
                            ? "border-blue-400 dark:border-blue-600 bg-blue-50/40 dark:bg-blue-950/30 shadow-sm"
                            : isPassed
                            ? "border-emerald-200 dark:border-emerald-900/40 bg-emerald-50/30 dark:bg-emerald-950/10 opacity-90"
                            : "border-slate-200/60 dark:border-slate-800/60 bg-slate-50/30 dark:bg-slate-900/30 opacity-40"
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <div
                            className={`w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold ${
                              isPassed
                                ? "bg-emerald-500 text-white"
                                : isCurrent
                                ? "bg-blue-600 text-white animate-pulse"
                                : "bg-slate-200 dark:bg-slate-800 text-slate-500"
                            }`}
                          >
                            {isPassed ? <Check className="w-4 h-4" /> : stage.step}
                          </div>
                          <div>
                            <div className="text-sm font-semibold text-slate-800 dark:text-slate-200 flex items-center gap-2">
                              {stage.label}
                              {isCurrent && (
                                <span className="text-[10px] px-1.5 py-0.2 rounded bg-blue-600 text-white font-normal">
                                  実行中
                                </span>
                              )}
                            </div>
                            <div className="text-xs text-slate-500 dark:text-slate-400">
                              {stage.sublabel}
                            </div>
                          </div>
                        </div>

                        {/* Status Icon */}
                        <div>
                          {isPassed && (
                            <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                              <CheckCircle2 className="w-4 h-4" />
                              完了
                            </span>
                          )}
                          {isCurrent && (
                            <Loader2 className="w-4 h-4 animate-spin text-blue-600 dark:text-blue-400" />
                          )}
                          {isPending && (
                            <span className="text-xs text-slate-400 dark:text-slate-600">
                              待機中
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 3. RESULTS STATE VIEW */}
        {analysisResult && (
          <div className="space-y-6 animate-fadeIn">
            {/* Top Summary Header Cards */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              {/* Claims Checked */}
              <div className="p-4 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm">
                <div className="flex items-center justify-between text-slate-500 dark:text-slate-400">
                  <span className="text-xs font-medium">総確認事実数</span>
                  <Search className="w-4 h-4" />
                </div>
                <div className="mt-2 text-2xl font-bold font-mono text-slate-900 dark:text-white">
                  {analysisResult.summary.claimsChecked}
                </div>
                <div className="text-[11px] text-slate-400 mt-1">抽出されたClaim数</div>
              </div>

              {/* Supported */}
              <div className="p-4 rounded-2xl bg-emerald-50/50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-900/50 shadow-sm">
                <div className="flex items-center justify-between text-emerald-700 dark:text-emerald-400">
                  <span className="text-xs font-semibold">支持 (Supported)</span>
                  <CheckCircle2 className="w-4 h-4" />
                </div>
                <div className="mt-2 text-2xl font-bold font-mono text-emerald-600 dark:text-emerald-400">
                  {analysisResult.summary.supported}
                </div>
                <div className="text-[11px] text-emerald-600/80 dark:text-emerald-500/80 mt-1">
                  公的情報で一致
                </div>
              </div>

              {/* Contradicted */}
              <div className="p-4 rounded-2xl bg-rose-50/50 dark:bg-rose-950/20 border border-rose-200 dark:border-rose-900/50 shadow-sm">
                <div className="flex items-center justify-between text-rose-700 dark:text-rose-400">
                  <span className="text-xs font-semibold">修正 (Contradicted)</span>
                  <AlertTriangle className="w-4 h-4" />
                </div>
                <div className="mt-2 text-2xl font-bold font-mono text-rose-600 dark:text-rose-400">
                  {analysisResult.summary.contradicted}
                </div>
                <div className="text-[11px] text-rose-600/80 dark:text-rose-500/80 mt-1">
                  誤り・数値相違
                </div>
              </div>

              {/* Mixed */}
              <div className="p-4 rounded-2xl bg-amber-50/50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900/50 shadow-sm">
                <div className="flex items-center justify-between text-amber-700 dark:text-amber-400">
                  <span className="text-xs font-semibold">混在 (Mixed)</span>
                  <HelpCircle className="w-4 h-4" />
                </div>
                <div className="mt-2 text-2xl font-bold font-mono text-amber-600 dark:text-amber-400">
                  {analysisResult.summary.mixed}
                </div>
                <div className="text-[11px] text-amber-600/80 dark:text-amber-500/80 mt-1">
                  一部過度の断定
                </div>
              </div>

              {/* Insufficient */}
              <div className="p-4 rounded-2xl bg-sky-50/50 dark:bg-sky-950/20 border border-sky-200 dark:border-sky-900/50 shadow-sm">
                <div className="flex items-center justify-between text-sky-700 dark:text-sky-400">
                  <span className="text-xs font-semibold">確認不足</span>
                  <Info className="w-4 h-4" />
                </div>
                <div className="mt-2 text-2xl font-bold font-mono text-sky-600 dark:text-sky-400">
                  {analysisResult.summary.insufficient}
                </div>
                <div className="text-[11px] text-sky-600/80 dark:text-sky-500/80 mt-1">
                  一次情報不足
                </div>
              </div>

              {/* Style Issues Fixed */}
              <div className="p-4 rounded-2xl bg-violet-50/50 dark:bg-violet-950/20 border border-violet-200 dark:border-violet-900/50 shadow-sm">
                <div className="flex items-center justify-between text-violet-700 dark:text-violet-400">
                  <span className="text-xs font-semibold">AI表現修正</span>
                  <Sparkles className="w-4 h-4" />
                </div>
                <div className="mt-2 text-2xl font-bold font-mono text-violet-600 dark:text-violet-400">
                  {analysisResult.summary.styleIssuesFixed}
                </div>
                <div className="text-[11px] text-violet-600/80 dark:text-violet-500/80 mt-1">
                  AI癖の解消箇所
                </div>
              </div>
            </div>

            {/* Main Tabs Container */}
            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xl shadow-slate-200/40 dark:shadow-none overflow-hidden">
              {/* Tab Navigation */}
              <div className="flex border-b border-slate-200 dark:border-slate-800 overflow-x-auto scrollbar-none bg-slate-50/70 dark:bg-slate-950/50 px-4 pt-2">
                <button
                  type="button"
                  onClick={() => setActiveTab("revised")}
                  className={`flex items-center gap-2 px-5 py-3 text-sm font-semibold border-b-2 transition-all whitespace-nowrap ${
                    activeTab === "revised"
                      ? "border-blue-600 text-blue-600 dark:text-blue-400 bg-white dark:bg-slate-900 rounded-t-xl"
                      : "border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
                  }`}
                >
                  <FileCheck className="w-4 h-4" />
                  <span>修正済み文章</span>
                </button>

                <button
                  type="button"
                  onClick={() => setActiveTab("claims")}
                  className={`flex items-center gap-2 px-5 py-3 text-sm font-semibold border-b-2 transition-all whitespace-nowrap ${
                    activeTab === "claims"
                      ? "border-blue-600 text-blue-600 dark:text-blue-400 bg-white dark:bg-slate-900 rounded-t-xl"
                      : "border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
                  }`}
                >
                  <ShieldCheck className="w-4 h-4" />
                  <span>事実確認</span>
                  <span className="ml-1 px-1.5 py-0.2 rounded-full text-xs bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                    {analysisResult.claims.length}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => setActiveTab("style")}
                  className={`flex items-center gap-2 px-5 py-3 text-sm font-semibold border-b-2 transition-all whitespace-nowrap ${
                    activeTab === "style"
                      ? "border-blue-600 text-blue-600 dark:text-blue-400 bg-white dark:bg-slate-900 rounded-t-xl"
                      : "border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
                  }`}
                >
                  <Wand2 className="w-4 h-4" />
                  <span>文章修正 (AI-tell)</span>
                  <span className="ml-1 px-1.5 py-0.2 rounded-full text-xs bg-violet-100 dark:bg-violet-950 text-violet-700 dark:text-violet-300">
                    {analysisResult.styleIssues.length}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => setActiveTab("sources")}
                  className={`flex items-center gap-2 px-5 py-3 text-sm font-semibold border-b-2 transition-all whitespace-nowrap ${
                    activeTab === "sources"
                      ? "border-blue-600 text-blue-600 dark:text-blue-400 bg-white dark:bg-slate-900 rounded-t-xl"
                      : "border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
                  }`}
                >
                  <Database className="w-4 h-4" />
                  <span>出典一覧</span>
                  <span className="ml-1 px-1.5 py-0.2 rounded-full text-xs bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                    {analysisResult.sources.length}
                  </span>
                </button>
              </div>

              {/* Tab 1: 修正済み文章 */}
              {activeTab === "revised" && (
                <div className="p-6 space-y-6">
                  {/* Toolbar */}
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-100 dark:border-slate-800">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase">
                        表示形式:
                      </span>
                      <div className="inline-flex p-1 rounded-xl bg-slate-100 dark:bg-slate-800 text-xs font-medium">
                        <button
                          onClick={() => setDiffMode("clean")}
                          className={`px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition ${
                            diffMode === "clean"
                              ? "bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-400 shadow-sm font-semibold"
                              : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
                          }`}
                        >
                          <Eye className="w-3.5 h-3.5" />
                          <span>修正後テキスト</span>
                        </button>
                        <button
                          onClick={() => setDiffMode("side-by-side")}
                          className={`px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition ${
                            diffMode === "side-by-side"
                              ? "bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-400 shadow-sm font-semibold"
                              : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
                          }`}
                        >
                          <Columns className="w-3.5 h-3.5" />
                          <span>原文との差分比較</span>
                        </button>
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      <span className="text-xs text-slate-400 font-mono">
                        原文 {analysisResult.originalText.length}字 → 修正後 {analysisResult.revisedText.length}字
                      </span>
                      <button
                        type="button"
                        onClick={handleCopy}
                        className={`px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold transition-all flex items-center gap-2 ${
                          copied
                            ? "bg-emerald-600 text-white"
                            : "bg-blue-600 hover:bg-blue-700 text-white shadow-md shadow-blue-500/20"
                        }`}
                      >
                        {copied ? (
                          <>
                            <CheckCheck className="w-4 h-4" />
                            <span>コピーしました！</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-4 h-4" />
                            <span>クリップボードにコピー</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>

                  {/* Mode 1: Clean Revised View */}
                  {diffMode === "clean" && (
                    <div className="p-6 rounded-2xl bg-slate-50/60 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800">
                      <div className="prose dark:prose-invert max-w-none text-slate-800 dark:text-slate-200 leading-loose text-base font-sans whitespace-pre-line select-text">
                        {analysisResult.revisedText}
                      </div>
                    </div>
                  )}

                  {/* Mode 2: Side-by-side Diff View */}
                  {diffMode === "side-by-side" && (
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                      {/* Left: Original */}
                      <div className="p-5 rounded-2xl bg-rose-50/20 dark:bg-rose-950/10 border border-rose-200/70 dark:border-rose-900/40 space-y-3">
                        <div className="flex items-center justify-between pb-2 border-b border-rose-200/50 dark:border-rose-900/40">
                          <span className="text-xs font-bold text-rose-700 dark:text-rose-400 uppercase tracking-wider flex items-center gap-1.5">
                            <span className="w-2 h-2 rounded-full bg-rose-500"></span>
                            原文（検査前）
                          </span>
                          <span className="text-xs text-rose-600/70 font-mono">
                            {analysisResult.originalText.length} 文字
                          </span>
                        </div>
                        <div className="text-slate-700 dark:text-slate-300 text-sm leading-relaxed whitespace-pre-line font-sans">
                          {analysisResult.originalText}
                        </div>
                      </div>

                      {/* Right: Revised */}
                      <div className="p-5 rounded-2xl bg-emerald-50/20 dark:bg-emerald-950/10 border border-emerald-200/70 dark:border-emerald-900/40 space-y-3">
                        <div className="flex items-center justify-between pb-2 border-b border-emerald-200/50 dark:border-emerald-900/40">
                          <span className="text-xs font-bold text-emerald-700 dark:text-emerald-400 uppercase tracking-wider flex items-center gap-1.5">
                            <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                            修正後（Fact Ledger 反映）
                          </span>
                          <span className="text-xs text-emerald-600/70 font-mono">
                            {analysisResult.revisedText.length} 文字
                          </span>
                        </div>
                        <div className="text-slate-800 dark:text-slate-200 text-sm leading-relaxed whitespace-pre-line font-sans">
                          {analysisResult.revisedText}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Tab 2: 事実確認 */}
              {activeTab === "claims" && (
                <div className="p-6 space-y-6">
                  {/* Filter Pills */}
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium text-slate-500 dark:text-slate-400 mr-1">
                      判定で絞り込み:
                    </span>
                    {(
                      [
                        { key: "ALL", label: "すべて", count: analysisResult.claims.length },
                        { key: "CONTRADICTED", label: "修正", count: analysisResult.summary.contradicted },
                        { key: "MIXED", label: "混在", count: analysisResult.summary.mixed },
                        { key: "SUPPORTED", label: "支持", count: analysisResult.summary.supported },
                        { key: "INSUFFICIENT", label: "確認不足", count: analysisResult.summary.insufficient },
                      ] as const
                    ).map((f) => (
                      <button
                        key={f.key}
                        onClick={() => setClaimFilter(f.key)}
                        className={`px-3 py-1 rounded-lg text-xs font-semibold transition ${
                          claimFilter === f.key
                            ? "bg-blue-600 text-white shadow-sm"
                            : "bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300"
                        }`}
                      >
                        {f.label} ({f.count})
                      </button>
                    ))}
                  </div>

                  {/* Claims List */}
                  <div className="space-y-4">
                    {filteredClaims.length === 0 ? (
                      <div className="text-center py-8 text-slate-400 text-sm">
                        該当する判定のClaimはありません。
                      </div>
                    ) : (
                      filteredClaims.map((claimResult) => {
                        const { claim, verdict, correctedClaim, reason, evidence } = claimResult;

                        let verdictBadgeClass = "";
                        let verdictLabel = "";
                        let verdictIcon = null;

                        switch (verdict) {
                          case "SUPPORTED":
                            verdictBadgeClass = "bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800";
                            verdictLabel = "支持 (Supported)";
                            verdictIcon = <CheckCircle2 className="w-3.5 h-3.5" />;
                            break;
                          case "CONTRADICTED":
                            verdictBadgeClass = "bg-rose-100 dark:bg-rose-950/60 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-800";
                            verdictLabel = "修正 / 矛盾 (Contradicted)";
                            verdictIcon = <AlertTriangle className="w-3.5 h-3.5" />;
                            break;
                          case "MIXED":
                            verdictBadgeClass = "bg-amber-100 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800";
                            verdictLabel = "混在 (Mixed)";
                            verdictIcon = <HelpCircle className="w-3.5 h-3.5" />;
                            break;
                          case "INSUFFICIENT":
                            verdictBadgeClass = "bg-sky-100 dark:bg-sky-950/60 text-sky-700 dark:text-sky-300 border-sky-200 dark:border-sky-800";
                            verdictLabel = "確認不足 (Insufficient)";
                            verdictIcon = <Info className="w-3.5 h-3.5" />;
                            break;
                        }

                        return (
                          <div
                            key={claim.id}
                            className="p-5 rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50/40 dark:bg-slate-950/40 space-y-4 shadow-sm"
                          >
                            {/* Card Header */}
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="flex items-center gap-2">
                                <span className="font-mono text-xs font-bold text-slate-400">
                                  #{claim.id}
                                </span>
                                <span
                                  className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold border ${verdictBadgeClass}`}
                                >
                                  {verdictIcon}
                                  {verdictLabel}
                                </span>
                                {claim.importance === "critical" && (
                                  <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-red-100 dark:bg-red-950/50 text-red-600 dark:text-red-400">
                                    重要度: Critical
                                  </span>
                                )}
                              </div>
                            </div>

                            {/* Original Text Claim */}
                            <div className="space-y-1">
                              <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                                原文の主張 (Original Claim):
                              </div>
                              <p className="text-sm sm:text-base font-medium text-slate-900 dark:text-slate-100 bg-white dark:bg-slate-900 p-3 rounded-xl border border-slate-200 dark:border-slate-800">
                                「{claim.originalText}」
                              </p>
                            </div>

                            {/* Correction if needed */}
                            {correctedClaim && (
                              <div className="space-y-1">
                                <div className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                                  <ArrowRight className="w-3.5 h-3.5" />
                                  事実台帳に基づく修正 (Corrected Claim):
                                </div>
                                <p className="text-sm font-medium text-emerald-900 dark:text-emerald-200 bg-emerald-50/70 dark:bg-emerald-950/30 p-3 rounded-xl border border-emerald-200 dark:border-emerald-900/50">
                                  {correctedClaim}
                                </p>
                              </div>
                            )}

                            {/* Reason */}
                            {reason && (
                              <div className="text-xs text-slate-600 dark:text-slate-300 bg-slate-100/70 dark:bg-slate-900/70 p-3 rounded-xl border border-slate-200/50 dark:border-slate-800/50">
                                <span className="font-semibold text-slate-700 dark:text-slate-200">
                                  判定理由:{" "}
                                </span>
                                {reason}
                              </div>
                            )}

                            {/* Linked Evidence */}
                            {evidence.length > 0 && (
                              <div className="pt-2 border-t border-slate-200/70 dark:border-slate-800/70 space-y-2">
                                <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 flex items-center gap-1">
                                  <Database className="w-3.5 h-3.5" />
                                  照合された外部証拠 (Evidence):
                                </div>
                                <div className="space-y-2">
                                  {evidence.map((ev) => (
                                    <div
                                      key={ev.id}
                                      className="p-3 rounded-xl bg-white dark:bg-slate-900 border border-slate-200/60 dark:border-slate-800/60 text-xs space-y-1.5"
                                    >
                                      <div className="flex items-center justify-between">
                                        <span className="font-semibold text-blue-600 dark:text-blue-400 flex items-center gap-1">
                                          {ev.sourceTitle}
                                          <a
                                            href={ev.sourceUrl}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="hover:underline inline-flex items-center text-slate-400 hover:text-blue-500"
                                          >
                                            <ExternalLink className="w-3 h-3 ml-0.5" />
                                          </a>
                                        </span>
                                        <span className="text-[11px] px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 font-medium">
                                          {ev.publisher || ev.sourceType}
                                        </span>
                                      </div>
                                      <p className="text-slate-600 dark:text-slate-300 italic bg-slate-50 dark:bg-slate-950 p-2 rounded border border-slate-100 dark:border-slate-800/50">
                                        &ldquo;{ev.excerpt}&rdquo;
                                      </p>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              )}

              {/* Tab 3: 文章修正 (AI-tell) */}
              {activeTab === "style" && (
                <div className="p-6 space-y-6">
                  {/* Explanatory Banner */}
                  <div className="p-4 rounded-xl bg-violet-50/70 dark:bg-violet-950/30 border border-violet-200 dark:border-violet-900/50 text-xs sm:text-sm text-violet-900 dark:text-violet-200 space-y-1">
                    <div className="font-bold flex items-center gap-1.5">
                      <Sparkles className="w-4 h-4 text-violet-600 dark:text-violet-400" />
                      AI-tell 12ルール並列評価エンジンによる推敲結果
                    </div>
                    <p className="text-violet-700 dark:text-violet-300 leading-relaxed">
                      AI特有の紋切り型な導入、過剰な対比構造、大げさなクリシェ、同義語の重複などを検出し、事実に影響を与えずに自然な日本語へと修正しました。
                    </p>
                  </div>

                  <div className="space-y-4">
                    {analysisResult.styleIssues.length === 0 ? (
                      <div className="text-center py-8 text-slate-400 text-sm">
                        指摘されたAI表現はありません。
                      </div>
                    ) : (
                      analysisResult.styleIssues.map((issue, idx) => (
                        <div
                          key={issue.ruleId + idx}
                          className="p-5 rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50/40 dark:bg-slate-950/40 space-y-3 shadow-sm"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-xs font-bold text-violet-600 dark:text-violet-400">
                                {issue.ruleId}
                              </span>
                              <h4 className="font-bold text-sm text-slate-900 dark:text-white">
                                {issue.ruleName || "AI特有表現の検出"}
                              </h4>
                            </div>
                            <span
                              className={`px-2 py-0.5 rounded text-[11px] font-semibold uppercase ${
                                issue.severity === "high"
                                  ? "bg-rose-100 dark:bg-rose-950/50 text-rose-600 dark:text-rose-400"
                                  : "bg-violet-100 dark:bg-violet-950/50 text-violet-600 dark:text-violet-400"
                              }`}
                            >
                              重要度: {issue.severity}
                            </span>
                          </div>

                          {issue.targetText && (
                            <div className="space-y-1">
                              <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                                指摘箇所 (原文):
                              </div>
                              <div className="p-2.5 rounded-xl bg-rose-50/60 dark:bg-rose-950/20 border border-rose-200/50 dark:border-rose-900/30 text-xs sm:text-sm text-rose-800 dark:text-rose-300 font-sans">
                                「{issue.targetText}」
                              </div>
                            </div>
                          )}

                          <div className="space-y-1">
                            <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                              適用された修正指針:
                            </div>
                            <div className="p-2.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-xs sm:text-sm text-slate-700 dark:text-slate-300">
                              {issue.repairInstruction}
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}

              {/* Tab 4: 出典 */}
              {activeTab === "sources" && (
                <div className="p-6 space-y-4">
                  <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                    検証に使用した外部ソース一覧 ({analysisResult.sources.length}件)
                  </div>

                  <div className="grid grid-cols-1 gap-3">
                    {analysisResult.sources.map((source) => (
                      <div
                        key={source.id}
                        className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 shadow-sm space-y-2"
                      >
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                          <a
                            href={source.sourceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sm font-semibold text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1.5"
                          >
                            <span>{source.sourceTitle}</span>
                            <ExternalLink className="w-3.5 h-3.5 flex-shrink-0" />
                          </a>
                          <div className="flex items-center gap-2">
                            <span className="text-xs px-2.5 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-medium">
                              {source.publisher || "外部ソース"}
                            </span>
                            <span className="text-xs px-2 py-0.5 rounded bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400 font-mono">
                              {source.sourceType}
                            </span>
                          </div>
                        </div>

                        <div className="text-xs text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-950/70 p-3 rounded-lg border border-slate-100 dark:border-slate-800 leading-relaxed font-sans">
                          {source.excerpt}
                        </div>

                        <div className="flex items-center justify-between text-[11px] text-slate-400">
                          <span>照合対象Claim: #{source.claimId}</span>
                          {source.publishedAt && <span>公表日: {source.publishedAt}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Bottom Reset Action */}
            <div className="text-center pt-4 pb-12">
              <button
                type="button"
                onClick={handleReset}
                className="px-6 py-2.5 rounded-xl font-medium text-sm border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 transition inline-flex items-center gap-2"
              >
                <RotateCcw className="w-4 h-4" />
                <span>別の文章を検査する</span>
              </button>
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-200 dark:border-slate-800 py-6 text-center text-xs text-slate-400 bg-white/50 dark:bg-slate-900/50">
        <p>Jev-write: Document Quality Assurance & Safety Rewriting Architecture</p>
      </footer>
    </div>
  );
}
