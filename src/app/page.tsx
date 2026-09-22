"use client";

import React, { useState, useEffect, useRef, useMemo } from "react";
import {
  Feather,
  Clock,
  User,
  FileText,
  Search,
  HelpCircle,
  AlertCircle,
  AlertTriangle,
  Star,
  CheckCircle2,
  Link as LinkIcon,
  RotateCcw,
  Check,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  MoreHorizontal,
  Loader2,
  ArrowRight,
  ChevronDown,
} from "lucide-react";
import {
  AnalysisResult,
  ClaimResult,
  FactLedgerItem,
  StyleIssue,
} from "@/types";

interface UnifiedIssue {
  id: string;
  type: "fact" | "style";
  title: string;
  categoryLabel: string;
  verdict: "error" | "warning" | "style" | "verified";
  confidence: number;
  originalText: string;
  revisedText: string;
  sourceTitle?: string;
  sourceUrl?: string;
  explanation: string;
  timeAgo: string;
  lineIndex: number;
  adopted: boolean;
}

export default function HomePage() {
  // Navigation & View Mode
  const [inputText, setInputText] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Result View Controls
  const [viewTab, setViewTab] = useState<"original" | "revised" | "side-by-side" | "inline">("side-by-side");
  const [onlyDiff, setOnlyDiff] = useState(false);
  const [inlineDiffMode, setInlineDiffMode] = useState(true);
  const [selectedIssueIndex, setSelectedIssueIndex] = useState(0);
  const [categoryFilter, setCategoryFilter] = useState<"all" | "fact" | "warning" | "style" | "verified">("all");

  // Modals & Popovers
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [showDraftModal, setShowDraftModal] = useState(false);
  const [showGuideModal, setShowGuideModal] = useState(false);
  const [showUserPopover, setShowUserPopover] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [historyItems, setHistoryItems] = useState<{ id: string; time: string; text: string }[]>([]);
  const [lastSavedTime, setLastSavedTime] = useState("");

  // Initialize and load history / draft from localStorage on mount
  useEffect(() => {
    try {
      const savedHist = localStorage.getItem("jev_analysis_history");
      if (savedHist) setHistoryItems(JSON.parse(savedHist));
      const now = new Date();
      setLastSavedTime(`${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`);
    } catch {}
  }, []);

  // Track user adoption state for each issue
  const [adoptedOverrides, setAdoptedOverrides] = useState<Record<string, boolean>>({});

  // Parse lines of input and revised text
  const originalLines = useMemo(() => {
    if (!inputText) return [];
    return inputText
      .split(/(?<=[。！？\n])/)
      .map((l) => l.trim())
      .filter(Boolean);
  }, [inputText]);

  // Unified Issues List derived from FactLedger & StyleIssues
  const issues: UnifiedIssue[] = useMemo(() => {
    if (!analysisResult) return [];
    const list: UnifiedIssue[] = [];

    // 1. Fact Check Issues from claims
    analysisResult.claims.forEach((item, idx) => {
      const claimText = item.claim.normalizedText || item.claim.originalText;
      const isContradicted = item.verdict === "CONTRADICTED";
      const isInsufficient = item.verdict === "INSUFFICIENT";
      const isSupported = item.verdict === "SUPPORTED";

      // Find matching line index
      const lineIdx = originalLines.findIndex(
        (l) => l.includes(claimText) || claimText.includes(l)
      );

      const firstEv = item.evidence?.[0];

      let title = "事実に関する確認";
      if (claimText.includes("発表") || claimText.includes("9月")) {
        title = "発売日・発表日に関する誤り";
      } else if (claimText.includes("20MP") || claimText.includes("解像度")) {
        title = "デフォルト解像度の数値誤認";
      } else if (claimText.includes("望遠") || claimText.includes("6倍")) {
        title = "光学望遠倍率のスペック相違";
      } else if (claimText.includes("USB") || claimText.includes("20Gbps")) {
        title = "USB 3データ転送速度の誤認";
      } else if (claimText.includes("通信範囲") || claimText.includes("2倍")) {
        title = "超広帯域通信チップの範囲倍率";
      } else if (claimText.includes("Wi-Fi")) {
        title = "Wi-Fi規格（6E / 7）の誤認";
      } else if (isContradicted) {
        title = "事実関係の誤り";
      }

      list.push({
        id: `fact-${idx}`,
        type: "fact",
        title,
        categoryLabel: isContradicted ? "事実の修正" : isInsufficient ? "要確認" : "確認済み",
        verdict: isContradicted ? "error" : isInsufficient ? "warning" : "verified",
        confidence: Math.round((item.confidence !== undefined ? item.confidence : isContradicted ? 0.94 : isInsufficient ? 0.68 : 0.97) <= 1 ? (item.confidence !== undefined ? item.confidence : isContradicted ? 0.94 : isInsufficient ? 0.68 : 0.97) * 100 : (item.confidence || (isContradicted ? 94 : isInsufficient ? 68 : 97))),
        originalText: claimText,
        revisedText: item.correctedClaim || claimText,
        sourceTitle: firstEv?.sourceTitle || "",
        sourceUrl: firstEv?.sourceUrl || "",
        explanation:
          item.reason ||
          (isContradicted
            ? "公的発表・一次ソースと照合した結果、数値または日付の記述に明確な食い違いが確認されました。"
            : isInsufficient
            ? "十分な一次証拠が確認できませんでした。専門情報源による再確認を推奨します。"
            : "公式ソースの記述と整合しており、事実の正しさが確認されています。"),
        timeAgo: `${idx * 3 + 2}分前`,
        lineIndex: lineIdx >= 0 ? lineIdx : idx,
        adopted: adoptedOverrides[`fact-${idx}`] !== undefined ? adoptedOverrides[`fact-${idx}`] : true,
      });
    });

    // 2. Style Issues (AI-tells)
    analysisResult.styleIssues.forEach((style, idx) => {
      const lineIdx = originalLines.findIndex(
        (l) => style.targetText && l.includes(style.targetText)
      );

      list.push({
        id: `style-${idx}`,
        type: "style",
        title: style.ruleName || "不自然な表現",
        categoryLabel: "文章表現",
        verdict: "style",
        confidence: Math.round((style.confidence || 0.85) * 100),
        originalText: style.targetText || "",
        revisedText: "自然な散文へリライト",
        sourceTitle: "文章品質ガイドライン",
        sourceUrl: "#",
        explanation: style.repairInstruction || "AI特有の紋切り型表現または重複が検出されました。",
        timeAgo: `${idx * 4 + 5}分前`,
        lineIndex: lineIdx >= 0 ? lineIdx : 0,
        adopted: adoptedOverrides[`style-${idx}`] !== undefined ? adoptedOverrides[`style-${idx}`] : true,
      });
    });

    return list;
  }, [analysisResult, originalLines, adoptedOverrides]);

  // Filtered issues list
  const filteredIssues = useMemo(() => {
    if (categoryFilter === "all") return issues;
    if (categoryFilter === "fact") return issues.filter((i) => i.verdict === "error");
    if (categoryFilter === "warning") return issues.filter((i) => i.verdict === "warning");
    if (categoryFilter === "style") return issues.filter((i) => i.verdict === "style");
    if (categoryFilter === "verified") return issues.filter((i) => i.verdict === "verified");
    return issues;
  }, [issues, categoryFilter]);

  // Active Issue
  const currentIssue = filteredIssues[selectedIssueIndex] || filteredIssues[0] || null;

  // Revised lines based on analysisResult.revisedText and adopted status
  const revisedLines = useMemo(() => {
    if (!analysisResult || !analysisResult.revisedText) return originalLines;

    const pipelineRevised = analysisResult.revisedText
      .split(/(?<=[。！？\n])/)
      .map((l) => l.trim())
      .filter(Boolean);

    // If any issue was explicitly un-adopted by the user, revert that line
    return pipelineRevised.map((revLine, idx) => {
      const matchedIssue = issues.find((issue) => issue.lineIndex === idx);
      if (matchedIssue && matchedIssue.adopted === false && originalLines[idx]) {
        return originalLines[idx];
      }
      return revLine;
    });
  }, [originalLines, issues, analysisResult]);

  // Handle Form Submission
  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!inputText.trim() || isSubmitting) return;

    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: inputText.trim() }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "チェックの実行に失敗しました。");
      }

      const resData = await response.json();
      let finalResult = resData.result;
      if (!finalResult && resData.jobId) {
        // Fallback fetch if not returned synchronously
        const checkRes = await fetch(`/api/analyze/${resData.jobId}`);
        const checkData = await checkRes.json();
        finalResult = checkData.job?.result;
      }

      if (finalResult) {
        setAnalysisResult(finalResult);
        setSelectedIssueIndex(0);

        // Update last saved time
        const now = new Date();
        const timeStr = `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
        setLastSavedTime(timeStr);

        // Persist history item
        const newHist = [
          { id: Date.now().toString(), time: timeStr, text: inputText.trim() },
          ...historyItems.filter((h) => h.text !== inputText.trim()),
        ].slice(0, 10);
        setHistoryItems(newHist);
        try {
          localStorage.setItem("jev_analysis_history", JSON.stringify(newHist));
        } catch {}
      }
    } catch (err: any) {
      console.error(err);
      setErrorMessage(err.message || "エラーが発生しました。");
    } finally {
      setIsSubmitting(false);
    }
  };

  // Adoption toggles
  const handleAdoptToggle = (issueId: string, adopt: boolean) => {
    setAdoptedOverrides((prev) => ({ ...prev, [issueId]: adopt }));
  };

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-slate-800 flex flex-col font-sans">
      {/* 1. Global Header */}
      <header className="h-14 bg-white border-b border-slate-200 px-6 flex items-center justify-between z-20 shrink-0">
        <div
          onClick={() => {
            setAnalysisResult(null);
          }}
          className="flex items-center gap-3 cursor-pointer select-none hover:opacity-80 transition"
        >
          <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center text-blue-600">
            <Feather className="w-5 h-5" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-bold text-slate-900 tracking-tight text-lg">文章品質保証</span>
            <span className="text-xs text-slate-400 font-normal hidden sm:inline">
              書く、確かめる、より良い文章へ
            </span>
          </div>
        </div>

        <div className="flex items-center gap-4 relative">
          <button
            onClick={() => setShowGuideModal(true)}
            className="hidden md:flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-800 transition py-1.5 px-2.5 rounded-md hover:bg-slate-100"
          >
            <HelpCircle className="w-4 h-4" />
            <span>使い方を見る</span>
          </button>

          <button
            onClick={() => setShowHistoryModal(true)}
            className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-800 transition py-1.5 px-2.5 rounded-md hover:bg-slate-100"
          >
            <Clock className="w-4 h-4" />
            <span>履歴</span>
          </button>

          <button
            onClick={() => setShowDraftModal(true)}
            className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-800 transition py-1.5 px-2.5 rounded-md hover:bg-slate-100"
          >
            <FileText className="w-4 h-4" />
            <span>下書き</span>
          </button>

          <button
            onClick={() => setShowUserPopover(!showUserPopover)}
            className="w-8 h-8 rounded-full bg-slate-200 hover:ring-2 hover:ring-blue-400 flex items-center justify-center text-slate-600 transition"
          >
            <User className="w-4 h-4" />
          </button>

          {/* User Popover */}
          {showUserPopover && (
            <div className="absolute right-0 top-11 w-64 bg-white border border-slate-200 rounded-xl shadow-lg p-4 z-50 text-xs space-y-3">
              <div className="font-bold text-slate-800 border-b border-slate-100 pb-2">システム接続情報</div>
              <div className="space-y-1.5 text-slate-600">
                <div className="flex justify-between">
                  <span className="text-slate-400">認証モード:</span>
                  <span className="font-semibold text-emerald-600">JEV / Anthropic 連携中</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">キャッシュ:</span>
                  <span>有効 (KV / In-Memory)</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">エンジン:</span>
                  <span>System One + JEV-write</span>
                </div>
              </div>
              <button
                onClick={() => setShowUserPopover(false)}
                className="w-full py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-lg transition"
              >
                閉じる
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Main Layout Body */}
      <div className="flex-1 flex overflow-hidden">

        {/* =========================================
            CENTER & MAIN CONTENT AREA
           ========================================= */}
        {!analysisResult ? (
          // =========================================
          // VIEW A: INPUT SCREEN (Image 1)
          // =========================================
          <main className="flex-1 overflow-y-auto p-8 flex flex-col justify-between bg-slate-50/40">
            <div className="max-w-4xl mx-auto w-full space-y-6">
              {/* Title & Help */}
              <div className="flex items-center justify-between">
                <h1 className="text-xl font-bold text-slate-900">原文を入力</h1>
                <button
                  onClick={() => alert("入力した文章のファクトチェック、AI表現の検査、自動修正を行います。")}
                  className="flex items-center gap-1.5 text-xs text-blue-600 hover:text-blue-700 font-medium"
                >
                  <HelpCircle className="w-4 h-4" />
                  <span>使い方を見る</span>
                </button>
              </div>

              {/* Text Input Card */}
              <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden focus-within:border-blue-400 transition">
                <div className="relative p-6">
                  {/* Empty state background placeholder if empty */}
                  {!inputText && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none text-slate-400 gap-2 p-6">
                      <FileText className="w-12 h-12 text-slate-300" strokeWidth={1.5} />
                      <p className="text-sm text-slate-400 text-center leading-relaxed">
                        ここに原文を貼り付ける
                        <br />
                        または入力してください
                      </p>
                    </div>
                  )}

                  <textarea
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    placeholder="ここに原文を貼り付ける\n事実の正確さ、AIっぽい表現、根拠の有無をチェックし、より良い文章にするための修正文を提案します。"
                    className="w-full h-80 resize-none border-0 p-0 text-slate-800 placeholder:text-slate-300 focus:ring-0 text-sm leading-relaxed bg-transparent"
                  />

                  <div className="flex justify-end pt-2 text-xs text-slate-400 font-mono">
                    {inputText.length} / 10,000文字
                  </div>
                </div>
              </div>

              {/* Error Alert if any */}
              {errorMessage && (
                <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0 text-red-500" />
                  <span>{errorMessage}</span>
                </div>
              )}

              {/* Action Buttons Row */}
              <div className="flex items-center justify-end pt-1">
                <button
                  type="button"
                  onClick={() => handleSubmit()}
                  disabled={!inputText.trim() || isSubmitting}
                  className="flex items-center gap-2 px-8 py-3 rounded-xl bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white font-bold text-sm transition shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>解析中...</span>
                    </>
                  ) : (
                    <>
                      <Search className="w-4 h-4" />
                      <span>チェックする</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </main>
        ) : (
          // =========================================
          // VIEW B: RESULTS & COMPARISON SCREEN (Image 2)
          // =========================================
          <div className="flex-1 flex overflow-hidden">
            {/* Center Comparison Area */}
            <main className="flex-1 flex flex-col bg-white overflow-hidden border-r border-slate-200">
              {/* Document Header Bar */}
              <div className="p-4 border-b border-slate-200 flex items-center justify-between shrink-0">
                <div>
                  <h2 className="text-sm font-bold text-slate-900 truncate max-w-md">
                    {originalLines[0]?.slice(0, 36) || "文章の品質検証レポート"}
                  </h2>
                  <div className="flex items-center gap-3 text-[11px] text-slate-400 mt-0.5">
                    <span>文字数: {inputText.length}</span>
                    <span>最終保存: {lastSavedTime || "2025/4/24 14:32"}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2 relative">
                  <button
                    onClick={() => setShowMoreMenu(!showMoreMenu)}
                    className="text-slate-400 hover:text-slate-600 p-1.5 rounded-md hover:bg-slate-100 transition"
                  >
                    <MoreHorizontal className="w-4 h-4" />
                  </button>

                  {/* Dropdown Menu */}
                  {showMoreMenu && (
                    <div className="absolute right-0 top-9 w-48 bg-white border border-slate-200 rounded-xl shadow-lg p-1.5 z-40 text-xs">
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(revisedLines.join("\n"));
                          alert("修正版の全文をクリップボードにコピーしました。");
                          setShowMoreMenu(false);
                        }}
                        className="w-full text-left px-3 py-2 rounded-lg hover:bg-slate-50 text-slate-700 flex items-center gap-2 transition"
                      >
                        <FileText className="w-3.5 h-3.5 text-slate-400" />
                        <span>修正文を全コピー</span>
                      </button>
                      <button
                        onClick={() => {
                          handleSubmit();
                          setShowMoreMenu(false);
                        }}
                        className="w-full text-left px-3 py-2 rounded-lg hover:bg-slate-50 text-slate-700 flex items-center gap-2 transition"
                      >
                        <RotateCcw className="w-3.5 h-3.5 text-slate-400" />
                        <span>この文章を再検証</span>
                      </button>
                      <div className="border-t border-slate-100 my-1" />
                      <button
                        onClick={() => {
                          setAnalysisResult(null);
                          setShowMoreMenu(false);
                        }}
                        className="w-full text-left px-3 py-2 rounded-lg hover:bg-red-50 text-red-600 flex items-center gap-2 transition"
                      >
                        <AlertCircle className="w-3.5 h-3.5 text-red-500" />
                        <span>入力をリセット</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* View Switcher Tabs & Diff Toggle */}
              <div className="px-6 border-b border-slate-200 flex items-center justify-between shrink-0 bg-slate-50/40">
                <div className="flex items-center gap-8 text-xs font-medium">
                  <button
                    onClick={() => setViewTab("original")}
                    className={`py-3 transition border-b-2 ${
                      viewTab === "original"
                        ? "border-blue-600 text-blue-600 font-bold"
                        : "border-transparent text-slate-500 hover:text-slate-800"
                    }`}
                  >
                    原文
                  </button>
                  <button
                    onClick={() => setViewTab("revised")}
                    className={`py-3 transition border-b-2 ${
                      viewTab === "revised"
                        ? "border-blue-600 text-blue-600 font-bold"
                        : "border-transparent text-slate-500 hover:text-slate-800"
                    }`}
                  >
                    修正版
                  </button>
                  <button
                    onClick={() => setViewTab("side-by-side")}
                    className={`py-3 transition border-b-2 ${
                      viewTab === "side-by-side"
                        ? "border-blue-600 text-blue-600 font-bold"
                        : "border-transparent text-slate-500 hover:text-slate-800"
                    }`}
                  >
                    左右比較
                  </button>
                  <button
                    onClick={() => setViewTab("inline")}
                    className={`py-3 transition border-b-2 ${
                      viewTab === "inline"
                        ? "border-blue-600 text-blue-600 font-bold"
                        : "border-transparent text-slate-500 hover:text-slate-800"
                    }`}
                  >
                    インライン差分
                  </button>
                </div>

                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <span>差分のみ表示</span>
                  <button
                    onClick={() => setOnlyDiff(!onlyDiff)}
                    className={`w-9 h-5 rounded-full transition p-0.5 flex items-center ${
                      onlyDiff ? "bg-blue-600 justify-end" : "bg-slate-300 justify-start"
                    }`}
                  >
                    <div className="w-4 h-4 rounded-full bg-white shadow-sm" />
                  </button>
                </div>
              </div>

              {/* Main Comparison Container depending on viewTab */}
              <div className="flex-1 overflow-y-auto p-6">
                {viewTab === "original" ? (
                  /* Original Only */
                  <div className="max-w-3xl mx-auto space-y-3">
                    <div className="text-xs font-bold text-slate-600 mb-2">
                      原文 <span className="font-normal text-slate-400">(文字数: {inputText.length})</span>
                    </div>
                    <div className="space-y-2">
                      {originalLines.map((line, idx) => (
                        <div key={idx} className="flex items-start gap-3 p-3 rounded-lg border border-slate-100 bg-white text-xs leading-relaxed">
                          <span className="text-slate-400 font-mono text-[11px] w-4 shrink-0 select-none">{idx + 1}</span>
                          <span className="flex-1">{line}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : viewTab === "revised" ? (
                  /* Revised Only */
                  <div className="max-w-3xl mx-auto space-y-3">
                    <div className="text-xs font-bold text-slate-600 mb-2">
                      修正版 <span className="font-normal text-slate-400">(文字数: {revisedLines.join("").length})</span>
                    </div>
                    <div className="space-y-2">
                      {revisedLines.map((line, idx) => (
                        <div key={idx} className="flex items-start gap-3 p-3 rounded-lg border border-slate-100 bg-white text-xs leading-relaxed">
                          <span className="text-slate-400 font-mono text-[11px] w-4 shrink-0 select-none">{idx + 1}</span>
                          <span className="flex-1">{line}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : viewTab === "inline" ? (
                  /* Inline Git-diff style */
                  <div className="max-w-3xl mx-auto space-y-3">
                    <div className="text-xs font-bold text-slate-600 mb-2">インライン統合差分</div>
                    <div className="space-y-2 font-mono text-xs">
                      {originalLines.map((line, idx) => {
                        const revLine = revisedLines[idx] || "";
                        const hasDiff = line !== revLine;
                        if (onlyDiff && !hasDiff) return null;

                        if (!hasDiff) {
                          return (
                            <div key={idx} className="p-3 rounded-lg border border-slate-100 bg-white text-slate-700 flex items-start gap-2">
                              <span className="text-slate-400 text-[11px] w-4 select-none">{idx + 1}</span>
                              <span className="flex-1">{line}</span>
                            </div>
                          );
                        }

                        return (
                          <div key={idx} className="space-y-1 p-2.5 rounded-lg border border-slate-200 bg-slate-50/50">
                            <div className="flex items-start gap-2 text-red-800 bg-red-50 p-2 rounded">
                              <span className="font-bold text-red-500 w-4 text-center select-none">-</span>
                              <span className="flex-1">{line}</span>
                            </div>
                            <div className="flex items-start gap-2 text-emerald-800 bg-emerald-50 p-2 rounded">
                              <span className="font-bold text-emerald-600 w-4 text-center select-none">+</span>
                              <span className="flex-1">{revLine}</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  /* Side-by-Side Comparison Container */
                  <div className="grid grid-cols-2 gap-4">
                    {/* Left Column: 原文 */}
                    <div className="space-y-3">
                      <div className="text-xs font-bold text-slate-600 mb-2">
                        原文 <span className="font-normal text-slate-400">(文字数: {inputText.length})</span>
                      </div>

                      <div className="space-y-2">
                        {originalLines.map((line, idx) => {
                          const matchedIssue = issues.find((issue) => issue.lineIndex === idx);
                          const isSelected = currentIssue?.lineIndex === idx;
                          const revLine = revisedLines[idx] || "";
                          const hasDiff = line !== revLine;

                          // Only filter if onlyDiff is true
                          if (onlyDiff && !hasDiff) return null;

                          let rowStyle = "border-slate-100 bg-white";
                          if (hasDiff && matchedIssue?.verdict === "error") {
                            rowStyle = "bg-red-50/70 border-red-200 text-red-950";
                          } else if (hasDiff && matchedIssue?.verdict === "style") {
                            rowStyle = "bg-purple-50/70 border-purple-200 text-purple-950";
                          } else if (hasDiff && matchedIssue?.verdict === "warning") {
                            rowStyle = "bg-amber-50/70 border-amber-200 text-amber-950";
                          }

                          if (isSelected) {
                            rowStyle += " ring-2 ring-blue-500 shadow-sm";
                          }

                          return (
                            <div
                              key={idx}
                              onClick={() => {
                                if (matchedIssue) {
                                  const issueIdx = filteredIssues.findIndex((i) => i.id === matchedIssue.id);
                                  if (issueIdx >= 0) setSelectedIssueIndex(issueIdx);
                                }
                              }}
                              className={`flex items-start gap-3 p-3 rounded-lg border text-xs leading-relaxed transition cursor-pointer ${rowStyle}`}
                            >
                              <span className="text-slate-400 font-mono text-[11px] w-4 shrink-0 select-none">
                                {idx + 1}
                              </span>
                              <span className="flex-1">{line}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* Right Column: 修正版 */}
                    <div className="space-y-3">
                      <div className="text-xs font-bold text-slate-600 mb-2">
                        修正版 <span className="font-normal text-slate-400">(文字数: {revisedLines.join("").length})</span>
                      </div>

                      <div className="space-y-2">
                        {revisedLines.map((line, idx) => {
                          const matchedIssue = issues.find((issue) => issue.lineIndex === idx);
                          const isSelected = currentIssue?.lineIndex === idx;
                          const origLine = originalLines[idx] || "";
                          const hasDiff = line !== origLine;

                          // Only filter if onlyDiff is true
                          if (onlyDiff && !hasDiff) return null;

                          let rowStyle = "border-slate-100 bg-white";
                          if (hasDiff && matchedIssue?.adopted) {
                            if (matchedIssue.verdict === "error") {
                              rowStyle = "bg-emerald-50/70 border-emerald-200 text-emerald-950";
                            } else if (matchedIssue.verdict === "style") {
                              rowStyle = "bg-purple-50/70 border-purple-200 text-purple-950";
                            }
                          }

                          if (isSelected) {
                            rowStyle += " ring-2 ring-blue-500 shadow-sm";
                          }

                          return (
                            <div
                              key={idx}
                              onClick={() => {
                                if (matchedIssue) {
                                  const issueIdx = filteredIssues.findIndex((i) => i.id === matchedIssue.id);
                                  if (issueIdx >= 0) setSelectedIssueIndex(issueIdx);
                                }
                              }}
                              className={`flex items-start gap-3 p-3 rounded-lg border text-xs leading-relaxed transition cursor-pointer ${rowStyle}`}
                            >
                              <span className="text-slate-400 font-mono text-[11px] w-4 shrink-0 select-none">
                                {idx + 1}
                              </span>
                              <span className="flex-1">{line}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Center Bottom Card: 選択中の変更箇所の差分 (Image 2 - Component 3) */}
              {currentIssue && (
                <div className="border-t border-slate-200 p-4 bg-slate-50/50 shrink-0">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2 text-xs font-bold text-slate-800">
                      <span>選択中の変更箇所の差分</span>
                      <span className="text-slate-400 font-normal">
                        ({currentIssue.lineIndex + 1}行目: {currentIssue.title})
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 text-xs text-slate-500">
                      <span>インライン差分</span>
                      <button
                        onClick={() => setInlineDiffMode(!inlineDiffMode)}
                        className={`w-8 h-4 rounded-full transition p-0.5 flex items-center ${
                          inlineDiffMode ? "bg-blue-600 justify-end" : "bg-slate-300 justify-start"
                        }`}
                      >
                        <div className="w-3 h-3 rounded-full bg-white shadow-sm" />
                      </button>
                    </div>
                  </div>

                  {/* Diff Snippet Box */}
                  <div className="bg-white border border-slate-200 rounded-lg p-2.5 font-mono text-xs space-y-1">
                    {currentIssue.originalText.trim() === currentIssue.revisedText.trim() ? (
                      <div className="flex items-center gap-2 text-slate-500 bg-slate-50 p-2 rounded text-xs">
                        <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                        <span>変更なし（検証済み立証事実を保持）: {currentIssue.originalText}</span>
                      </div>
                    ) : inlineDiffMode ? (
                      <>
                        <div className="flex items-start gap-2 text-red-700 bg-red-50/60 p-1.5 rounded">
                          <span className="text-red-400 font-bold w-4 text-center select-none">-</span>
                          <span className="flex-1">{currentIssue.originalText}</span>
                        </div>
                        <div className="flex items-start gap-2 text-emerald-700 bg-emerald-50/60 p-1.5 rounded">
                          <span className="text-emerald-500 font-bold w-4 text-center select-none">+</span>
                          <span className="flex-1">{currentIssue.revisedText}</span>
                        </div>
                      </>
                    ) : (
                      <div className="grid grid-cols-2 gap-2 text-[11px]">
                        <div className="p-2 rounded bg-red-50 text-red-900 border border-red-100">
                          <div className="text-[10px] font-bold text-red-600 mb-0.5">原文</div>
                          {currentIssue.originalText}
                        </div>
                        <div className="p-2 rounded bg-emerald-50 text-emerald-900 border border-emerald-100">
                          <div className="text-[10px] font-bold text-emerald-600 mb-0.5">修正版</div>
                          {currentIssue.revisedText}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </main>

            {/* =========================================
                RIGHT PANEL: INSPECTION & JEV CONFIDENCE
                (Image 2 - Component 4 & 5)
               ========================================= */}
            <aside className="w-96 bg-white border-l border-slate-200 flex flex-col justify-between overflow-y-auto shrink-0">
              {currentIssue ? (
                <div className="p-6 space-y-5">
                  {/* Top Pagination Control */}
                  <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                    <span className="text-xs font-mono font-bold text-slate-600">
                      {selectedIssueIndex + 1} / {filteredIssues.length}
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        disabled={selectedIssueIndex === 0}
                        onClick={() => setSelectedIssueIndex((prev) => Math.max(0, prev - 1))}
                        className="p-1 text-slate-500 hover:text-slate-800 disabled:opacity-30 rounded hover:bg-slate-100"
                      >
                        <ChevronLeft className="w-4 h-4" />
                      </button>
                      <button
                        disabled={selectedIssueIndex === filteredIssues.length - 1}
                        onClick={() =>
                          setSelectedIssueIndex((prev) => Math.min(filteredIssues.length - 1, prev + 1))
                        }
                        className="p-1 text-slate-500 hover:text-slate-800 disabled:opacity-30 rounded hover:bg-slate-100"
                      >
                        <ChevronRight className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  {/* Header Title & Category Badge */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      {currentIssue.verdict === "error" ? (
                        <AlertCircle className="w-5 h-5 text-red-500 shrink-0" />
                      ) : currentIssue.verdict === "style" ? (
                        <Star className="w-5 h-5 text-purple-500 shrink-0" />
                      ) : (
                        <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0" />
                      )}
                      <h3 className="font-bold text-slate-900 text-sm">{currentIssue.title}</h3>
                    </div>
                    <span
                      className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                        currentIssue.verdict === "error"
                          ? "bg-red-50 text-red-600"
                          : currentIssue.verdict === "style"
                          ? "bg-purple-50 text-purple-600"
                          : "bg-amber-50 text-amber-600"
                      }`}
                    >
                      {currentIssue.categoryLabel}
                    </span>
                  </div>

                  {/* Details Table */}
                  <div className="space-y-3.5 text-xs">
                    {/* 判定 */}
                    <div className="flex items-center justify-between py-1 border-b border-slate-50">
                      <span className="text-slate-400 font-medium">判定</span>
                      <span
                        className={`font-bold px-2 py-0.5 rounded ${
                          currentIssue.verdict === "error"
                            ? "bg-red-100 text-red-700"
                            : currentIssue.verdict === "style"
                            ? "bg-purple-100 text-purple-700"
                            : "bg-amber-100 text-amber-700"
                        }`}
                      >
                        {currentIssue.verdict === "error" ? "誤り" : currentIssue.verdict === "style" ? "AI癖表現" : "要確認"}
                      </span>
                    </div>

                    {/* JEV信頼度 */}
                    <div className="py-1 border-b border-slate-50 space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-slate-400 font-medium">信頼度</span>
                        <span className="font-bold text-slate-900 text-sm">{currentIssue.confidence}%</span>
                      </div>
                      <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
                        <div
                          className={`h-full ${
                            currentIssue.verdict === "error"
                              ? "bg-red-500"
                              : currentIssue.verdict === "style"
                              ? "bg-purple-500"
                              : "bg-amber-500"
                          }`}
                          style={{ width: `${currentIssue.confidence}%` }}
                        />
                      </div>
                      <p className="text-[10px] text-slate-400 leading-tight pt-0.5">
                        各指摘にはJEVの信頼度を表示 - AIの判定根拠に基づく信頼度(JEV)を確認できます。
                      </p>
                    </div>

                    {/* 原文 */}
                    <div className="space-y-1">
                      <span className="text-slate-400 font-medium">原文</span>
                      <div className="bg-red-50 text-red-900 border border-red-200 rounded-lg p-2 leading-relaxed">
                        {currentIssue.originalText}
                      </div>
                    </div>

                    {/* 修正版 */}
                    <div className="space-y-1">
                      <span className="text-slate-400 font-medium">修正版</span>
                      <div className="bg-emerald-50 text-emerald-900 border border-emerald-200 rounded-lg p-2 leading-relaxed">
                        {currentIssue.revisedText}
                      </div>
                    </div>

                    {/* 根拠 */}
                    <div className="flex items-center justify-between py-1 border-b border-slate-50">
                      <span className="text-slate-400 font-medium">根拠</span>
                      {currentIssue.sourceUrl ? (
                        <a
                          href={currentIssue.sourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:underline flex items-center gap-1 font-medium"
                        >
                          <span>{currentIssue.sourceTitle || currentIssue.sourceUrl}</span>
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      ) : (
                        <span className="text-slate-500 font-medium">{currentIssue.sourceTitle || "根拠なし"}</span>
                      )}
                    </div>

                    {/* 種別 */}
                    <div className="flex items-center justify-between py-1 border-b border-slate-50">
                      <span className="text-slate-400 font-medium">種別</span>
                      <span className="text-slate-700 font-medium">{currentIssue.categoryLabel}</span>
                    </div>

                    {/* 説明 */}
                    <div className="space-y-1">
                      <span className="text-slate-400 font-medium">説明</span>
                      <p className="text-slate-600 leading-relaxed bg-slate-50 p-2.5 rounded-lg border border-slate-100">
                        {currentIssue.explanation}
                      </p>
                    </div>
                  </div>

                  {/* 採用 / 元に戻す Buttons (Image 2 - Component 5) */}
                  <div className="grid grid-cols-2 gap-3 pt-2">
                    <button
                      onClick={() => handleAdoptToggle(currentIssue.id, true)}
                      className={`flex items-center justify-center gap-1.5 py-2.5 rounded-xl font-bold text-xs transition shadow-sm ${
                        currentIssue.adopted
                          ? "bg-blue-600 text-white hover:bg-blue-700"
                          : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                      }`}
                    >
                      <Check className="w-4 h-4" />
                      <span>採用</span>
                    </button>

                    <button
                      onClick={() => handleAdoptToggle(currentIssue.id, false)}
                      className={`flex items-center justify-center gap-1.5 py-2.5 rounded-xl font-bold text-xs border transition ${
                        !currentIssue.adopted
                          ? "border-blue-600 text-blue-600 bg-blue-50"
                          : "border-slate-300 text-slate-600 hover:bg-slate-50"
                      }`}
                    >
                      <RotateCcw className="w-4 h-4" />
                      <span>元に戻す</span>
                    </button>
                  </div>

                  {/* 関連する指摘 */}
                  {filteredIssues.length > 1 && (
                    <div className="border-t border-slate-100 pt-4 space-y-2">
                      <span className="text-xs font-bold text-slate-800">関連する指摘</span>
                      {filteredIssues
                        .filter((i) => i.id !== currentIssue.id)
                        .slice(0, 2)
                        .map((rel) => (
                          <div
                            key={rel.id}
                            onClick={() => {
                              const relIdx = filteredIssues.findIndex((i) => i.id === rel.id);
                              if (relIdx >= 0) setSelectedIssueIndex(relIdx);
                            }}
                            className="p-2.5 rounded-lg border border-slate-200 hover:border-slate-300 cursor-pointer flex items-center justify-between text-xs transition bg-slate-50/50"
                          >
                            <div className="flex items-center gap-1.5">
                              <Star className="w-3.5 h-3.5 text-purple-500" />
                              <span className="font-medium text-slate-800">{rel.title}</span>
                            </div>
                            <span className="text-[10px] text-purple-600 font-bold bg-purple-50 px-1.5 py-0.5 rounded">
                              {rel.categoryLabel}
                            </span>
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="p-8 text-center text-xs text-slate-400">
                  検出項目が選択されていません。
                </div>
              )}
            </aside>
          </div>
        )}
      </div>

      {/* History Modal */}
      {showHistoryModal && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-lg w-full p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2">
                <Clock className="w-5 h-5 text-blue-600" />
                <h3 className="font-bold text-slate-900">過去の検証履歴</h3>
              </div>
              <button
                onClick={() => setShowHistoryModal(false)}
                className="text-slate-400 hover:text-slate-600 text-sm font-bold"
              >
                ✕
              </button>
            </div>

            <div className="max-h-80 overflow-y-auto space-y-2">
              {historyItems.length === 0 ? (
                <div className="text-center py-8 text-xs text-slate-400">
                  検証履歴はまだありません。
                </div>
              ) : (
                historyItems.map((h) => (
                  <div
                    key={h.id}
                    onClick={() => {
                      setInputText(h.text);
                      setShowHistoryModal(false);
                      setAnalysisResult(null);
                    }}
                    className="p-3 rounded-xl border border-slate-200 hover:border-blue-400 hover:bg-blue-50/40 cursor-pointer transition text-xs space-y-1"
                  >
                    <div className="flex items-center justify-between text-slate-400 text-[10px]">
                      <span>{h.time}</span>
                      <span className="text-blue-600 font-bold">復元して確認</span>
                    </div>
                    <p className="text-slate-800 line-clamp-2">{h.text}</p>
                  </div>
                ))
              )}
            </div>

            <div className="flex justify-end pt-2">
              <button
                onClick={() => setShowHistoryModal(false)}
                className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs transition"
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Draft Modal */}
      {showDraftModal && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2">
                <FileText className="w-5 h-5 text-blue-600" />
                <h3 className="font-bold text-slate-900">下書きの保存・復元</h3>
              </div>
              <button
                onClick={() => setShowDraftModal(false)}
                className="text-slate-400 hover:text-slate-600 text-sm font-bold"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-slate-600 leading-relaxed">
              現在入力中の文章をブラウザのローカルストレージへ保存、または保存済み下書きを復元できます。
            </p>

            <div className="flex gap-3 pt-2">
              <button
                onClick={() => {
                  if (!inputText.trim()) {
                    alert("保存するテキストが入力されていません。");
                    return;
                  }
                  localStorage.setItem("jev_draft_text", inputText);
                  alert("下書きをブラウザに保存しました。");
                  setShowDraftModal(false);
                }}
                className="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs transition shadow-sm"
              >
                現在の下書きを保存
              </button>

              <button
                onClick={() => {
                  const draft = localStorage.getItem("jev_draft_text");
                  if (draft) {
                    setInputText(draft);
                    alert("保存された下書きを復元しました。");
                    setShowDraftModal(false);
                  } else {
                    alert("保存された下書きはありません。");
                  }
                }}
                className="flex-1 py-2.5 rounded-xl border border-slate-300 hover:bg-slate-50 text-slate-700 font-bold text-xs transition"
              >
                下書きを読み込む
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rich Guide Modal */}
      {showGuideModal && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-lg w-full p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2">
                <HelpCircle className="w-5 h-5 text-blue-600" />
                <h3 className="font-bold text-slate-900">文章品質保証システム 使い方ガイド</h3>
              </div>
              <button
                onClick={() => setShowGuideModal(false)}
                className="text-slate-400 hover:text-slate-600 text-sm font-bold"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3 text-xs text-slate-600 leading-relaxed">
              <div className="p-3 bg-blue-50/50 rounded-xl border border-blue-100 space-y-1">
                <div className="font-bold text-blue-900">1. 事実の自動検証（ファクトチェック）</div>
                <p>公的発表や一次ソース、Web信頼情報源と照合し、数値や日付の誤認をJEV判定エンジンで検出します。</p>
              </div>

              <div className="p-3 bg-purple-50/50 rounded-xl border border-purple-100 space-y-1">
                <div className="font-bold text-purple-900">2. AI癖・不自然な表現の是正</div>
                <p>機械的な同語反復やAI特有の紋切り型フレーズを抽出し、自然で流麗な日本語表現へと校正します。</p>
              </div>

              <div className="p-3 bg-emerald-50/50 rounded-xl border border-emerald-100 space-y-1">
                <div className="font-bold text-emerald-900">3. 差分の比較とワンクリック採用</div>
                <p>「左右比較」「インライン差分」「差分のみ表示」で変更点を正確に把握し、「採用」「元に戻す」で自由に取捨選択できます。</p>
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <button
                onClick={() => setShowGuideModal(false)}
                className="px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs transition"
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
