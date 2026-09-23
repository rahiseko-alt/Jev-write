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
  StyleIssue,
} from "@/types";
import { splitIntoBlocks } from "@/lib/text/blocks";
import { mergeAnalyses } from "@/lib/pipeline/merge-results";
import {
  attentionOf,
  buildRevisedDocument,
  isUnplaced,
  sortByAttention,
  type Finding,
  type MarkKind,
  type Segment,
} from "@/lib/revised-document";

// Each kind of mark is told apart by shape as well as by colour: a glyph
// before the span and a distinct underline, so the distinction survives for a
// reader who cannot separate the hues.
const MARK_STYLES: Record<
  MarkKind,
  { className: string; rejectedClassName: string; glyph: string; label: string }
> = {
  fact: {
    className:
      "bg-red-50 text-red-900 underline decoration-red-400 decoration-2 underline-offset-4",
    rejectedClassName:
      "bg-slate-50 text-red-800/70 underline decoration-red-300 decoration-dashed underline-offset-4",
    glyph: "✎",
    label: "資料と食い違い",
  },
  style: {
    className:
      "bg-purple-50 text-purple-900 underline decoration-purple-400 decoration-wavy underline-offset-4",
    rejectedClassName:
      "bg-slate-50 text-purple-800/70 underline decoration-purple-300 decoration-dashed underline-offset-4",
    glyph: "✦",
    label: "AIっぽい表現",
  },
  unverified: {
    className:
      "bg-amber-50 text-amber-900 underline decoration-amber-500 decoration-dotted decoration-2 underline-offset-4",
    rejectedClassName:
      "bg-slate-50 text-amber-800/70 underline decoration-amber-400 decoration-dashed underline-offset-4",
    glyph: "?",
    label: "裏付けが見つかりません",
  },
};

/** Below this width the Finding opens as a sheet rather than in the side panel. */
const NARROW_SCREEN = "(max-width: 1023px)";

function MarkedText({
  segment,
  onSelect,
}: {
  segment: Segment;
  onSelect: (findingIds: string[]) => void;
}) {
  if (!segment.mark) return <>{segment.text}</>;

  const mark = segment.mark;
  const style = MARK_STYLES[mark.kind];
  const rejected = mark.rejected;

  return (
    <button
      type="button"
      onClick={() => onSelect(mark.findingIds)}
      aria-haspopup="dialog"
      className={`inline rounded px-0.5 text-left ${
        rejected ? style.rejectedClassName : style.className
      } hover:brightness-95 transition`}
    >
      <span aria-hidden className="mr-0.5 text-[0.7em] align-super font-bold select-none">
        {style.glyph}
        {rejected ? "↩" : ""}
      </span>
      <span className="sr-only">
        {rejected ? `${style.label}（元に戻しました）` : style.label}:{" "}
      </span>
      {segment.text}
    </button>
  );
}

/** The leading number as a percentage, or null when JEV gave none. */
function attentionPercent(finding: Finding): number | null {
  const value = attentionOf(finding);
  return value === null ? null : Math.round(value * 100);
}

export default function HomePage() {
  // Navigation & View Mode
  const [inputText, setInputText] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // A long article is checked a block at a time, and the reader watches it go.
  const [blockProgress, setBlockProgress] = useState<{ done: number; total: number } | null>(null);

  // Result View Controls
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);
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

  // Track user adoption state for each Finding
  const [adoptedOverrides, setAdoptedOverrides] = useState<Record<string, boolean>>({});
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [sheetOpen, setSheetOpen] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);

  // Everything the result screen renders comes from this one place.
  const revisedDocument = useMemo(
    () =>
      analysisResult
        ? buildRevisedDocument({
            analysis: analysisResult,
            adoption: adoptedOverrides,
          })
        : null,
    [analysisResult, adoptedOverrides]
  );

  const originalLines = useMemo(
    () => revisedDocument?.comparison.map((pair) => pair.original) ?? [],
    [revisedDocument]
  );

  const findings: Finding[] = useMemo(
    () => revisedDocument?.findings ?? [],
    [revisedDocument]
  );

  // Findings the category filter lets through, weakest first: the reader works
  // down the numbers rather than through the document.
  const filteredFindings = useMemo(() => {
    const kept =
      categoryFilter === "fact"
        ? findings.filter((i) => i.kind === "corrected")
        : categoryFilter === "warning"
        ? findings.filter((i) => i.kind === "unverified")
        : categoryFilter === "style"
        ? findings.filter((i) => i.kind === "ai-tell")
        : categoryFilter === "verified"
        ? findings.filter((i) => i.kind === "confirmed")
        : findings;
    return sortByAttention(kept);
  }, [findings, categoryFilter]);

  // The Finding on show, and where it sits in the list the reader is paging.
  const currentFinding =
    filteredFindings.find((finding) => finding.id === selectedFindingId) ??
    filteredFindings[0] ??
    null;
  const selectedFindingIndex = currentFinding
    ? filteredFindings.findIndex((finding) => finding.id === currentFinding.id)
    : -1;

  const selectFindingAt = (at: number) => {
    const finding = filteredFindings[at];
    if (finding) setSelectedFindingId(finding.id);
  };

  const revisedLines = useMemo(
    () => revisedDocument?.comparison.map((pair) => pair.revised) ?? [],
    [revisedDocument]
  );

  // Copy reports on the button itself rather than behind a dialog, and
  // reports failure there too: the error banner lives on the input screen.
  const handleCopyRevised = async () => {
    if (!revisedDocument) return;
    try {
      await navigator.clipboard.writeText(revisedDocument.clipboardText);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  // The sheet is how a narrow screen opens a Finding. It has no business
  // surviving a change of view, or a window grown past the breakpoint.
  useEffect(() => {
    setSheetOpen(false);
  }, [categoryFilter]);

  useEffect(() => {
    if (!sheetOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSheetOpen(false);
    };
    const narrow = window.matchMedia(NARROW_SCREEN);
    const onWidthChange = () => {
      if (!narrow.matches) setSheetOpen(false);
    };

    document.addEventListener("keydown", onKeyDown);
    narrow.addEventListener("change", onWidthChange);
    sheetRef.current?.focus();

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      narrow.removeEventListener("change", onWidthChange);
    };
  }, [sheetOpen]);

  useEffect(() => {
    if (copyState === "idle") return;
    const timer = setTimeout(() => setCopyState("idle"), 2500);
    return () => clearTimeout(timer);
  }, [copyState]);

  // Handle Form Submission
  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!inputText.trim() || isSubmitting) return;

    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      // One run has a time limit, so a long article is cut into blocks and
      // checked one after another. Each finished block is shown straight
      // away, and the finished blocks are assembled into one document.
      const blocks = splitIntoBlocks(inputText.trim());
      setBlockProgress({ done: 0, total: blocks.length });
      setAnalysisResult(null);
      setAdoptedOverrides({});
      setSelectedFindingId(null);

      const finished: AnalysisResult[] = [];

      for (const block of blocks) {
        const response = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: block }),
        });

        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          // The reason is the useful part: which service could not answer, and
          // what it said. Nothing is checked in its place.
          const reason = [data.error, data.details].filter(Boolean).join(" / ");
          const where =
            blocks.length > 1 ? `${finished.length + 1}ブロック目で止まりました。` : "";
          throw new Error(where + (reason || "チェックの実行に失敗しました。"));
        }

        const resData = await response.json();
        let blockResult = resData.result;
        if (!blockResult && resData.jobId) {
          const checkRes = await fetch(`/api/analyze/${resData.jobId}`);
          const checkData = await checkRes.json();
          blockResult = checkData.job?.result;
        }

        if (blockResult) {
          finished.push(blockResult);
          setBlockProgress({ done: finished.length, total: blocks.length });
          setAnalysisResult(mergeAnalyses(finished));
        }
      }

      const finalResult = finished.length > 0 ? mergeAnalyses(finished) : null;

      if (finalResult) {
        setAnalysisResult(finalResult);
        setAdoptedOverrides({});
        setSelectedFindingId(null);
        setSheetOpen(false);

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
      setBlockProgress(null);
    }
  };

  // Selecting a mark opens its Finding: a sheet on a phone, the panel on a
  // wide screen. The document is never scrolled on the reader's behalf.
  const handleSelectMark = (findingIds: string[]) => {
    const finding = findings.find((candidate) => findingIds.includes(candidate.id));
    if (!finding) return;

    // The mark is drawn for every Finding, so a filter that hides this one
    // must give way rather than leave the mark inert.
    if (!filteredFindings.some((visible) => visible.id === finding.id)) {
      setCategoryFilter("all");
    }

    setSelectedFindingId(finding.id);
    if (!isWideScreen()) setSheetOpen(true);
  };

  const isWideScreen = () =>
    typeof window !== "undefined" && !window.matchMedia(NARROW_SCREEN).matches;

  // Adoption toggles
  const handleAdoptToggle = (findingId: string, adopt: boolean) => {
    setAdoptedOverrides((prev) => ({ ...prev, [findingId]: adopt }));
  };

  const findingDetail = currentFinding ? (
                <div className="p-6 space-y-5">
                  {/* Top Pagination Control */}
                  <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                    <span className="text-xs font-mono font-bold text-slate-600">
                      {selectedFindingIndex + 1} / {filteredFindings.length}
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        disabled={selectedFindingIndex === 0}
                        onClick={() => selectFindingAt(selectedFindingIndex - 1)}
                        className="p-1 text-slate-500 hover:text-slate-800 disabled:opacity-30 rounded hover:bg-slate-100"
                      >
                        <ChevronLeft className="w-4 h-4" />
                      </button>
                      <button
                        disabled={selectedFindingIndex === filteredFindings.length - 1}
                        onClick={() =>
                          selectFindingAt(selectedFindingIndex + 1)
                        }
                        className="p-1 text-slate-500 hover:text-slate-800 disabled:opacity-30 rounded hover:bg-slate-100"
                      >
                        <ChevronRight className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  {/* 裏付けの強さ。この数値が主役で、札はその下の説明にすぎない。 */}
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-1">
                    <div className="flex items-end gap-2">
                      <span className="text-4xl font-bold tabular-nums text-slate-900 leading-none">
                        {attentionPercent(currentFinding) ?? "—"}
                        {attentionPercent(currentFinding) !== null && (
                          <span className="text-xl font-bold">%</span>
                        )}
                      </span>
                      <span className="text-[11px] text-slate-500 pb-1">
                        {currentFinding.consistency
                          ? "記事と資料に照らして辻褄が合う確率"
                          : currentFinding.confidence !== null
                          ? "JEVの確信度"
                          : "JEVの数値なし"}
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-500 leading-snug">
                      この数値が低いほど、人が確かめる値打ちがあります。低い順に並べています。
                    </p>
                    {currentFinding.lookupFailed && (
                      <p className="text-[11px] font-bold text-red-600 leading-snug">
                        ウェブ検索ができませんでした。この数値は記事の中だけを見たものです。
                        外部の資料とは突き合わせていません。
                      </p>
                    )}
                  </div>

                  {/* 本文に印が無い指摘。黙って落とさず、そう言う。 */}
                  {isUnplaced(currentFinding) && (
                    <div className="flex items-start gap-2 rounded-xl border border-slate-300 bg-slate-100 px-4 py-3 text-xs text-slate-800">
                      <HelpCircle className="w-4 h-4 shrink-0 text-slate-600 mt-0.5" />
                      <span>
                        <span className="font-bold">場所不明</span>
                        ：本文のどの文の話か特定できず、本文に印を付けられませんでした。
                        下の主張の文面を手がかりに、本文の該当箇所をお探しください。
                      </span>
                    </div>
                  )}

                  {/* Header Title & Category Badge */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      {currentFinding.kind === "corrected" ? (
                        <AlertCircle className="w-5 h-5 text-red-500 shrink-0" />
                      ) : currentFinding.kind === "ai-tell" ? (
                        <Star className="w-5 h-5 text-purple-500 shrink-0" />
                      ) : (
                        <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0" />
                      )}
                      <h3 className="font-bold text-slate-900 text-sm">{currentFinding.title}</h3>
                    </div>
                    <span
                      className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                        currentFinding.kind === "corrected"
                          ? "bg-red-50 text-red-600"
                          : currentFinding.kind === "ai-tell"
                          ? "bg-purple-50 text-purple-600"
                          : "bg-amber-50 text-amber-600"
                      }`}
                    >
                      {currentFinding.categoryLabel}
                    </span>
                  </div>

                  {/* Details Table */}
                  <div className="space-y-3.5 text-xs">
                    {/* 判定 */}
                    <div className="flex items-center justify-between py-1 border-b border-slate-50">
                      <span className="text-slate-400 font-medium">判定</span>
                      <span
                        className={`font-bold px-2 py-0.5 rounded ${
                          currentFinding.kind === "corrected"
                            ? "bg-red-100 text-red-700"
                            : currentFinding.kind === "ai-tell"
                            ? "bg-purple-100 text-purple-700"
                            : "bg-amber-100 text-amber-700"
                        }`}
                      >
                        {currentFinding.kind === "corrected"
                          ? "資料と食い違い"
                          : currentFinding.kind === "ai-tell"
                          ? "AI癖表現"
                          : currentFinding.kind === "confirmed"
                          ? "資料と一致"
                          : "裏付けなし"}
                      </span>
                    </div>

                    {/* JEV信頼度 */}
                    <div className="py-1 border-b border-slate-50 space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-slate-400 font-medium">信頼度</span>
                        <span className="flex items-center gap-2">
                          {currentFinding.bandLabel && (
                            <span
                              className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                                currentFinding.band === "act"
                                  ? "bg-emerald-100 text-emerald-700"
                                  : currentFinding.band === "caution"
                                  ? "bg-amber-100 text-amber-700"
                                  : "bg-slate-200 text-slate-600"
                              }`}
                            >
                              {currentFinding.bandLabel}
                            </span>
                          )}
                          <span className="font-bold text-slate-900 text-sm">
                            {currentFinding.confidence === null
                              ? "数値なし"
                              : `${currentFinding.confidence}%`}
                          </span>
                        </span>
                      </div>
                      <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
                        <div
                          className={`h-full ${
                            currentFinding.kind === "corrected"
                              ? "bg-red-500"
                              : currentFinding.kind === "ai-tell"
                              ? "bg-purple-500"
                              : "bg-amber-500"
                          }`}
                          style={{ width: `${currentFinding.confidence ?? 0}%` }}
                        />
                      </div>
                      {currentFinding.consistency && (
                        <p className="text-[10px] text-slate-500 leading-tight pt-0.5">
                          記事の中での筋の通り方（JEVの判定）: 成り立つ確率{" "}
                          {Math.round(currentFinding.consistency.probabilityTrue * 100)}% ／ 確信度{" "}
                          {Math.round(currentFinding.consistency.confidence * 100)}%
                        </p>
                      )}
                      <p className="text-[10px] text-slate-400 leading-tight pt-0.5">
                        数値はすべてJEVが返したものをそのまま表示しています。こちらで数字を作ることは
                        しません。判定に数値が付かなかった場合は「数値なし」と出ます。
                      </p>
                    </div>

                    {/* 原文 */}
                    <div className="space-y-1">
                      <span className="text-slate-400 font-medium">
                        {isUnplaced(currentFinding) ? "主張の文面（本文の言葉とは異なります）" : "この文"}
                      </span>
                      <div className="bg-red-50 text-red-900 border border-red-200 rounded-lg p-2 leading-relaxed">
                        {currentFinding.sentenceBefore || currentFinding.originalText}
                      </div>
                    </div>

                    {currentFinding.sourceUrl && (
                      <div className="flex items-center justify-between py-1 border-b border-slate-50">
                        <span className="text-slate-400 font-medium">根拠</span>
                        <a
                          href={currentFinding.sourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:underline flex items-center gap-1 font-medium"
                        >
                          <span>{currentFinding.sourceTitle || currentFinding.sourceUrl}</span>
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      </div>
                    )}

                    {/* 種別 */}
                    <div className="flex items-center justify-between py-1 border-b border-slate-50">
                      <span className="text-slate-400 font-medium">種別</span>
                      <span className="text-slate-700 font-medium">{currentFinding.categoryLabel}</span>
                    </div>

                    {/* 説明 */}
                    <div className="space-y-1">
                      <span className="text-slate-400 font-medium">説明</span>
                      <p className="text-slate-600 leading-relaxed bg-slate-50 p-2.5 rounded-lg border border-slate-100">
                        {currentFinding.explanation}
                      </p>
                    </div>

                    {/* 根拠がどこで消えたか。「何も無い」には理由がいくつもある。 */}
                    {currentFinding.evidenceTrace && (
                      <details className="space-y-1">
                        <summary className="text-slate-400 font-medium cursor-pointer select-none">
                          根拠の探し方を見る
                        </summary>
                        <div className="mt-1 space-y-1 bg-slate-50 p-2.5 rounded-lg border border-slate-100 text-slate-600">
                          <p className="break-all">
                            検索語: 「{currentFinding.evidenceTrace.query || "（なし）"}」
                          </p>
                          <p>
                            候補 {currentFinding.evidenceTrace.found} 件 ／ 本文を読めず{" "}
                            {currentFinding.evidenceTrace.unreadable} 件 ／ 主張に触れていないと判定{" "}
                            {currentFinding.evidenceTrace.saidNothing} 件 ／ 判定が弱く不採用{" "}
                            {currentFinding.evidenceTrace.weak ?? 0} 件 ／ 根拠に採用{" "}
                            {currentFinding.evidenceTrace.used} 件
                          </p>
                          {currentFinding.evidence && currentFinding.evidence.length > 0 && (
                            <ul className="space-y-0.5 pt-1">
                              {currentFinding.evidence.map((item, i) => (
                                <li key={`${item.url}-${i}`} className="break-all">
                                  <span className="font-medium">
                                    {item.relation === "contradicts"
                                      ? "食い違い"
                                      : item.relation === "supports"
                                      ? "裏付け"
                                      : "参考"}
                                    {typeof item.confidence === "number" &&
                                      `（確信度 ${Math.round(item.confidence * 100)}%）`}
                                  </span>
                                  : {item.title || item.url}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </details>
                    )}
                  </div>

                  {/* この道具は書き換えない。どう直すかは書き手が決める。 */}
                  {currentFinding.kind === "unverified" ? (
                    <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
                      <AlertTriangle className="w-4 h-4 shrink-0 text-amber-600 mt-0.5" />
                      <span>
                        裏付けが取れなかった箇所です。ご自身で一次情報をお確かめください。
                      </span>
                    </div>
                  ) : currentFinding.kind === "confirmed" ? (
                    <div className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-900">
                      <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600 mt-0.5" />
                      <span>集めた資料と一致していた箇所です。</span>
                    </div>
                  ) : null}

                </div>
              ) : (
                <div className="p-8 text-center text-xs text-slate-400">
                  検出項目が選択されていません。
                </div>
  );

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-slate-800 flex flex-col font-sans">
      {/* 1. Global Header */}
      <header className="h-14 bg-white border-b border-slate-200 px-6 flex items-center justify-between z-20 shrink-0">
        <div
          onClick={() => {
            setAnalysisResult(null);
            setSheetOpen(false);
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
                  onClick={() => alert("入力した文章のファクトチェック、AI表現の検査を行い、裏付けの弱い箇所を知らせます。文章は書き換えません。")}
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
                    placeholder="ここに原文を貼り付ける\n事実の正確さ、AIっぽい表現、根拠の有無をチェックし、裏付けの弱い箇所を知らせます。文章は書き換えません。"
                    className="w-full h-80 resize-none border-0 p-0 text-slate-800 placeholder:text-slate-300 focus:ring-0 text-sm leading-relaxed bg-transparent"
                  />

                  <div className="flex justify-end pt-2 text-xs text-slate-400 font-mono">
                    {inputText.length} / 10,000文字
                    {inputText.trim().length > 700 && (
                      <span className="ml-2 text-slate-400">
                        （{splitIntoBlocks(inputText.trim()).length}ブロックに分けて順番に処理します）
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Error Alert if any */}
              {blockProgress && blockProgress.total > 1 && (
                <div className="flex items-center gap-2 px-4 py-3 rounded-xl border border-blue-200 bg-blue-50 text-xs text-blue-900">
                  <span className="font-bold">
                    {blockProgress.done} / {blockProgress.total} ブロック完了
                  </span>
                  <span className="text-blue-700">
                    終わったところから結果に反映されます。
                  </span>
                </div>
              )}

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
          <div className="flex-1 flex flex-col lg:flex-row overflow-y-auto lg:overflow-hidden">
            {/* Center Comparison Area */}
            <main className="flex-1 flex flex-col bg-white lg:overflow-hidden lg:border-r border-slate-200">
              {/* Document Header Bar */}
              <div className="p-4 border-b border-slate-200 flex items-center justify-between shrink-0">
                <div>
                  <h2 className="text-sm font-bold text-slate-900 truncate max-w-md">
                    {revisedDocument?.title ?? "文章の品質検証レポート"}
                  </h2>
                  <div className="flex items-center gap-3 text-[11px] text-slate-400 mt-0.5">
                    <span>文字数: {revisedDocument?.originalText.length ?? 0}</span>
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

              {/* この道具は書き換えない。読むのは一つ、書かれた文章そのもの。 */}
              <div className="flex-1 overflow-y-auto p-6">
                <div className="max-w-3xl mx-auto space-y-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-xs font-bold text-slate-600">
                        本文{" "}
                        <span className="font-normal text-slate-400">
                          (文字数: {revisedDocument?.clipboardText.length ?? 0})
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={handleCopyRevised}
                        className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-medium text-slate-700 transition shadow-sm shrink-0"
                      >
                        {copyState === "copied" ? (
                          <>
                            <Check className="w-3.5 h-3.5 text-emerald-600" />
                            <span>コピーしました</span>
                          </>
                        ) : copyState === "failed" ? (
                          <>
                            <AlertCircle className="w-3.5 h-3.5 text-red-500" />
                            <span>コピーできませんでした</span>
                          </>
                        ) : (
                          <>
                            <FileText className="w-3.5 h-3.5 text-slate-500" />
                            <span>全文をコピー</span>
                          </>
                        )}
                      </button>
                    </div>

                    {blockProgress && blockProgress.done < blockProgress.total && (
                      <div className="flex items-center gap-2 px-4 py-3 rounded-xl border border-blue-200 bg-blue-50 text-xs text-blue-900">
                        <span className="font-bold">
                          {blockProgress.done} / {blockProgress.total} ブロック完了
                        </span>
                        <span className="text-blue-700">
                          残りを順番に処理しています。ここまでの結果を先に表示しています。
                        </span>
                      </div>
                    )}

                    {errorMessage && (
                      <div className="flex items-start gap-2 px-4 py-3 rounded-xl border border-red-200 bg-red-50 text-xs text-red-900">
                        <AlertTriangle className="w-4 h-4 shrink-0 text-red-600 mt-0.5" />
                        <span>{errorMessage}</span>
                      </div>
                    )}

                    {analysisResult?.providerStatuses?.some((s) => s.failureCount > 0) && (
                      <details className="rounded-xl border border-slate-200 bg-slate-50 text-xs text-slate-700">
                        <summary className="px-4 py-3 cursor-pointer font-bold select-none">
                          各サービスの状態を見る
                        </summary>
                        <div className="px-4 pb-3 space-y-2">
                          {analysisResult?.providerStatuses?.map((status) => (
                            <div key={status.service} className="space-y-0.5">
                              <div className="flex items-center gap-2">
                                <span
                                  className={
                                    status.failureCount > 0
                                      ? "text-amber-600 font-bold"
                                      : "text-emerald-600 font-bold"
                                  }
                                >
                                  {status.failureCount > 0 ? "✕" : "✓"}
                                </span>
                                <span className="font-bold">{status.service}</span>
                                <span className="text-slate-500">
                                  {status.failureCount > 0
                                    ? `${status.failureCount}件の呼び出しが失敗しました`
                                    : "応答しました"}
                                </span>
                              </div>
                              {status.lastError && (
                                <p className="pl-6 text-[11px] text-slate-500 break-all">
                                  {status.lastError}
                                </p>
                              )}
                            </div>
                          ))}
                        </div>
                      </details>
                    )}

                    {revisedDocument && !revisedDocument.hasFindings && (
                      <div className="flex items-center gap-2 px-4 py-3 rounded-xl border border-emerald-200 bg-emerald-50 text-xs text-emerald-800">
                        <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600" />
                        <span>気になる箇所は見つかりませんでした。</span>
                      </div>
                    )}

                    <article className="rounded-xl border border-slate-100 bg-white p-5 text-sm leading-loose text-slate-800">
                      {revisedDocument?.paragraphs.map((paragraph, idx) => (
                        <p
                          key={idx}
                          className={`whitespace-pre-wrap ${
                            paragraph.separator.includes("\n\n") ? "mb-4 last:mb-0" : "mb-0"
                          }`}
                        >
                          {paragraph.segments.map((segment, segIdx) => (
                            <MarkedText key={segIdx} segment={segment} onSelect={handleSelectMark} />
                          ))}
                        </p>
                      ))}
                    </article>
                </div>
              </div>

            </main>

            {/* =========================================
                RIGHT PANEL: INSPECTION & JEV CONFIDENCE
                (Image 2 - Component 4 & 5)
               ========================================= */}
            <aside className="hidden lg:flex w-96 shrink-0 bg-white border-l border-slate-200 flex-col justify-between overflow-y-auto">
              {findingDetail}
            </aside>
          </div>
        )}
      </div>

      {/* Finding sheet — phones only; wide screens use the panel beside the document */}
      {sheetOpen && currentFinding && (
        <div className="lg:hidden fixed inset-0 z-[60] flex flex-col justify-end">
          <button
            type="button"
            aria-label="閉じる"
            className="absolute inset-0 bg-slate-900/30 cursor-default"
            onClick={() => setSheetOpen(false)}
          />
          <div
            ref={sheetRef}
            role="dialog"
            aria-modal="true"
            aria-label={currentFinding.title}
            tabIndex={-1}
            className="relative bg-white rounded-t-2xl shadow-2xl max-h-[75vh] overflow-y-auto outline-none"
          >
            <div className="sticky top-0 bg-white flex items-center justify-between px-4 py-3 border-b border-slate-100">
              <span className="text-xs font-bold text-slate-800">{currentFinding.title}</span>
              <button
                type="button"
                onClick={() => setSheetOpen(false)}
                className="text-slate-400 hover:text-slate-700 text-sm px-2 py-1 rounded hover:bg-slate-100"
              >
                閉じる
              </button>
            </div>
            {findingDetail}
          </div>
        </div>
      )}

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
                    // The result on screen belongs to the article it was run
                    // on, not to the one just restored.
                    setAnalysisResult(null);
                    setAdoptedOverrides({});
                    setSelectedFindingId(null);
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
                <div className="font-bold text-purple-900">2. AI癖・不自然な表現の検知</div>
                <p>機械的な同語反復やAI特有の紋切り型フレーズを抽出し、その箇所に印を付けて知らせます。文章は書き換えません。</p>
              </div>

              <div className="p-3 bg-emerald-50/50 rounded-xl border border-emerald-100 space-y-1">
                <div className="font-bold text-emerald-900">3. 書き換えはしません</div>
                <p>この道具は文章を書き換えません。裏付けの弱い箇所を数値で示すだけです。どう直すかは書き手が決めます。</p>
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
