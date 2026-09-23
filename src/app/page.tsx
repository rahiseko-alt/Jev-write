"use client";

import React, { useState, useEffect, useRef, useMemo } from "react";
import {
  Feather,
  FileText,
  Search,
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  RotateCcw,
  Check,
  MoreHorizontal,
  Loader2,
} from "lucide-react";
import {
  AnalysisResult,
  ClaimResult,
  StyleIssue,
} from "@/types";
import { splitIntoBlocks } from "@/lib/text/blocks";
import { mergeAnalyses } from "@/lib/pipeline/merge-results";
import {
  buildRevisedDocument,
  type Finding,
  type MarkKind,
  type Segment,
} from "@/lib/revised-document";
import { MarginNotes } from "@/components/margin-notes";
import { FindingCard } from "@/components/finding-card";
import {
  noticeForError,
  noticeForResponse,
  type FailureNotice,
} from "@/lib/failure-explanation";

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

/** Below this width the margin shrinks to its arrows and a note spans the page. */
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
      data-finding-ids={mark.findingIds.join(" ")}
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

// 失敗の知らせ。主文で「何が起きて、何をすればよいか」を伝え、
// 止まったサービスと元の文言は隠さずに残す（ADR-0006）。
function FailureNoticeBody({ notice }: { notice: FailureNotice & { where?: string } }) {
  return (
    <div className="min-w-0 space-y-1">
      <p>
        {notice.where}
        {notice.headline}
      </p>
      {notice.service && <p className="text-[0.92em] opacity-90">止まったところ：{notice.service}</p>}
      {notice.details && (
        <details className="text-[0.85em] opacity-90">
          <summary className="cursor-pointer select-none">詳しい情報</summary>
          <p className="mt-1 break-all font-mono whitespace-pre-wrap">{notice.details}</p>
        </details>
      )}
    </div>
  );
}

export default function HomePage() {
  // Navigation & View Mode
  const [inputText, setInputText] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  // 主文は書き手向けの日本語。どのサービスが何と言ったかは詳しい情報に畳んで残す。
  const [errorMessage, setErrorMessage] = useState<
    (FailureNotice & { where?: string }) | null
  >(null);
  // A long article is checked a block at a time, and the reader watches it go.
  const [blockProgress, setBlockProgress] = useState<{ done: number; total: number } | null>(null);

  // The notes open in the margin, in the order they were opened. Each stays
  // open until the reader closes it.
  const [openFindingIds, setOpenFindingIds] = useState<string[]>([]);
  const [narrow, setNarrow] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const [showMoreMenu, setShowMoreMenu] = useState(false);

  // Track user adoption state for each Finding
  const [adoptedOverrides, setAdoptedOverrides] = useState<Record<string, boolean>>({});
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

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

  const findings: Finding[] = useMemo(
    () => revisedDocument?.findings ?? [],
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

  useEffect(() => {
    const query = window.matchMedia(NARROW_SCREEN);
    const onChange = () => setNarrow(query.matches);
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

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
      setOpenFindingIds([]);

      const finished: AnalysisResult[] = [];

      for (const block of blocks) {
        const response = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: block }),
        });

        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          // The writer first reads what happened and what to do; which service
          // could not answer, and what it said, stays under 詳しい情報.
          // Nothing is checked in its place.
          const where =
            blocks.length > 1 ? `${finished.length + 1}ブロック目で止まりました。` : undefined;
          setErrorMessage({ ...noticeForResponse(response.status, data), where });
          return;
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
          setAnalysisResult(mergeAnalyses(finished, blocks));
        }
      }

      const finalResult = finished.length > 0 ? mergeAnalyses(finished, blocks) : null;

      if (finalResult) {
        setAnalysisResult(finalResult);
        setAdoptedOverrides({});
        setOpenFindingIds([]);
      }
    } catch (err: any) {
      console.error(err);
      setErrorMessage(noticeForError(err));
    } finally {
      setIsSubmitting(false);
      setBlockProgress(null);
    }
  };

  // An arrow or a mark opens its note in the margin, and the same again
  // closes it. The document itself never changes.
  const toggleNote = (id: string) =>
    setOpenFindingIds((ids) =>
      ids.includes(id) ? ids.filter((open) => open !== id) : [...ids, id]
    );

  const handleSelectMark = (findingIds: string[]) => {
    const finding = findings.find((candidate) => findingIds.includes(candidate.id));
    if (finding) toggleNote(finding.id);
  };

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-slate-800 flex flex-col font-sans">
      {/* Only the name: anything else up here is one more thing to look at. */}
      <header className="h-14 bg-white border-b border-slate-200 px-4 sm:px-6 flex items-center z-20 shrink-0">
        <button
          type="button"
          onClick={() => {
            setAnalysisResult(null);
            setOpenFindingIds([]);
          }}
          className="flex items-center gap-2.5 select-none hover:opacity-80 transition"
        >
          <span className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center text-blue-600">
            <Feather className="w-5 h-5" />
          </span>
          {/* "Proof" says what it is; the coloured "ee" takes the stiffness off. */}
          <span className="font-bold tracking-tight text-xl whitespace-nowrap">
            <span className="text-slate-900">Proof</span>
            <span className="text-blue-500">ee</span>
          </span>
        </button>
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

              {/* Text Input Card */}
              <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden focus-within:border-blue-400 transition">
                <div className="relative p-6">
                  {/* The only guidance for the empty input (no textarea placeholder, so it is not shown twice). */}
                  {!inputText && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none text-slate-400 gap-2 p-6">
                      <FileText className="w-12 h-12 text-slate-300" strokeWidth={1.5} />
                      <p className="text-sm text-slate-400 text-center leading-relaxed">
                        ここに原文を貼り付けるか、入力してください
                        <br />
                        裏付けの弱い文に印を付けてお知らせします。文章は書き換えません。
                      </p>
                    </div>
                  )}

                  <textarea
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    aria-label="原文"
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
                <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0 text-red-500 mt-0.5" />
                  <FailureNoticeBody notice={errorMessage} />
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
          <div className="flex-1 flex flex-col overflow-hidden">
            <main className="flex-1 flex flex-col bg-white overflow-hidden">
              {/* Document Header Bar */}
              <div className="p-4 border-b border-slate-200 flex items-center justify-between gap-2 shrink-0">
                <div className="min-w-0">
                  <h2 className="text-sm font-bold text-slate-900 truncate max-w-md">
                    {revisedDocument?.title ?? "文章の品質検証レポート"}
                  </h2>
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

              {/* この道具は書き換えない。本文はそのまま、指摘は左の余白に出す。 */}
              <div className="flex-1 overflow-y-auto p-4 sm:p-6">
                <div className="mx-auto max-w-6xl flex items-start gap-2 lg:gap-6">
                  <div className={narrow ? "w-9 shrink-0" : "w-96 shrink-0"}>
                    <MarginNotes
                      bodyRef={bodyRef}
                      findings={findings}
                      openIds={openFindingIds}
                      onToggle={toggleNote}
                      renderCard={(finding) => <FindingCard finding={finding} />}
                      narrow={narrow}
                    />
                  </div>
                <div ref={bodyRef} className="min-w-0 flex-1 max-w-3xl space-y-4">
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
                        <FailureNoticeBody notice={errorMessage} />
                      </div>
                    )}

                    {analysisResult?.providerStatuses?.some((s) => s.failureCount > 0) && (
                      // どのサービスが何と言って失敗したかは、不具合を切り分ける唯一の手がかり
                      // （ADR-0006 の層0・3）。畳んで残し、次にできることを横に置く。
                      <div className="flex items-start justify-between gap-3 px-4 py-3 rounded-xl border border-amber-200 bg-amber-50 text-xs text-amber-900">
                        <div className="flex items-start gap-2 min-w-0">
                          <AlertTriangle className="w-4 h-4 shrink-0 text-amber-600 mt-0.5" />
                          <details className="min-w-0">
                            <summary className="cursor-pointer select-none">
                              一部の確認ができませんでした。結果が不完全な可能性があります。
                            </summary>
                            <ul className="mt-1.5 space-y-1">
                              {analysisResult?.providerStatuses
                                ?.filter((s) => s.failureCount > 0)
                                .map((s) => (
                                  <li key={s.service} className="break-all">
                                    <span className="font-bold">{s.service}</span>
                                    ：{s.failureCount}件失敗
                                    {s.lastError && (
                                      <span className="block text-[11px] text-amber-800">{s.lastError}</span>
                                    )}
                                  </li>
                                ))}
                            </ul>
                          </details>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleSubmit()}
                          disabled={isSubmitting}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-amber-300 bg-white hover:bg-amber-100 text-xs font-medium text-amber-900 transition shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <RotateCcw className="w-3.5 h-3.5 text-amber-600" />
                          <span>もう一度確かめる</span>
                        </button>
                      </div>
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
              </div>

            </main>
          </div>
        )}
      </div>
    </div>
  );
}
