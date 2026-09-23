import { ExternalLink, HelpCircle } from "lucide-react";
import { Finding, FindingKind, attentionOf, isUnplaced } from "@/lib/revised-document";

const KIND_LABEL: Record<FindingKind, { text: string; className: string }> = {
  corrected: { text: "資料と食い違い", className: "bg-red-100 text-red-700" },
  unverified: { text: "裏付けなし", className: "bg-amber-100 text-amber-700" },
  "ai-tell": { text: "AIっぽい表現", className: "bg-purple-100 text-purple-700" },
  confirmed: { text: "資料と一致", className: "bg-emerald-100 text-emerald-700" },
};

const RELATION_LABEL = {
  contradicts: "食い違い",
  supports: "裏付け",
} as const;

/**
 * One Finding, sized for a small popover. Shows a single number (ADR-0008):
 * no band label or second confidence row beside it.
 */
export function FindingCard({ finding }: { finding: Finding }): JSX.Element {
  const attention = attentionOf(finding);
  const percent = attention === null ? null : Math.round(attention * 100);
  const meaning = finding.consistency
    ? "記事と資料に照らして辻褄が合う確率"
    : finding.confidence !== null
    ? "JEVの確信度"
    : "JEVの数値なし";
  const unplaced = isUnplaced(finding);
  const kind = KIND_LABEL[finding.kind];

  const sources =
    finding.evidence && finding.evidence.length > 0
      ? finding.evidence
      : finding.sourceUrl
      ? [{ url: finding.sourceUrl, title: finding.sourceTitle }]
      : [];
  const trace = finding.evidenceTrace;

  return (
    <div className="space-y-2.5 text-xs text-slate-700">
      <div className="space-y-1">
        <div className="flex items-end gap-2">
          <span className="text-3xl font-bold tabular-nums text-slate-900 leading-none">
            {percent ?? "—"}
            {percent !== null && <span className="text-base font-bold">%</span>}
          </span>
          <span className="text-[11px] text-slate-500 leading-tight pb-0.5">{meaning}</span>
        </div>
        {finding.lookupFailed && (
          <p className="text-[11px] font-bold text-red-600 leading-snug">
            ウェブ検索ができませんでした。この数値は記事の中だけを見たものです。
          </p>
        )}
      </div>

      <span className={`inline-block font-bold px-2 py-0.5 rounded ${kind.className}`}>
        {kind.text}
      </span>

      {unplaced && (
        <div className="flex items-start gap-1.5 rounded-lg border border-slate-300 bg-slate-100 px-2.5 py-2 text-slate-800 leading-snug">
          <HelpCircle className="w-3.5 h-3.5 shrink-0 text-slate-600 mt-0.5" />
          <span>
            <span className="font-bold">場所不明</span>
            ：本文のどの文の話か特定できませんでした。下の主張の文面を手がかりに、本文の該当箇所をお探しください。
          </span>
        </div>
      )}

      <div className="space-y-1">
        <span className="text-slate-400 font-medium">
          {unplaced ? "主張の文面（本文の言葉とは異なります）" : "この文"}
        </span>
        <div className="bg-slate-50 text-slate-800 border border-slate-200 rounded-lg p-2 leading-relaxed">
          {finding.sentenceBefore || finding.originalText}
        </div>
      </div>

      {sources.length > 0 && (
        <div className="space-y-1">
          <span className="text-slate-400 font-medium">根拠</span>
          <ul className="space-y-1">
            {sources.map((item, i) => {
              const relation = "relation" in item ? item.relation : undefined;
              const confidence = "confidence" in item ? item.confidence : undefined;
              return (
                <li key={`${item.url}-${i}`} className="leading-snug">
                  <span className="font-medium text-slate-500">
                    {relation ? RELATION_LABEL[relation] : "参考"}
                    {typeof confidence === "number" && ` ${Math.round(confidence * 100)}%`}
                  </span>{" "}
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline break-all"
                  >
                    {item.title || item.url}
                    <ExternalLink className="inline w-3 h-3 ml-0.5 align-[-2px]" />
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {finding.explanation && (
        <p className="text-slate-600 leading-relaxed">{finding.explanation}</p>
      )}

      {trace && (
        <details>
          <summary className="text-slate-400 font-medium cursor-pointer select-none">
            根拠の探し方を見る
          </summary>
          <div className="mt-1 space-y-1 bg-slate-50 p-2 rounded-lg border border-slate-100 text-slate-600">
            <p className="break-all">検索語: 「{trace.query || "（なし）"}」</p>
            <p>
              候補 {trace.found} 件 ／ 本文を読めず {trace.unreadable} 件 ／ 主張に触れていないと判定{" "}
              {trace.saidNothing} 件 ／ 判定が弱く不採用 {trace.weak ?? 0} 件 ／ 根拠に採用{" "}
              {trace.used} 件
            </p>
          </div>
        </details>
      )}
    </div>
  );
}
