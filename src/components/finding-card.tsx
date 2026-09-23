import { ExternalLink, HelpCircle, Search } from "lucide-react";
import { Finding, FindingKind, isUnplaced } from "@/lib/revised-document";

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

function searchUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

/**
 * One Finding, sized for a popover. Only what the reader acts on next: the
 * sentence is already marked and the number already sits on the arrow, so
 * neither is repeated here. What is left is where to go to check it.
 */
export function FindingCard({ finding }: { finding: Finding }): JSX.Element {
  const unplaced = isUnplaced(finding);
  const kind = KIND_LABEL[finding.kind];

  const sources =
    finding.evidence && finding.evidence.length > 0
      ? finding.evidence
      : finding.sourceUrl
      ? [{ url: finding.sourceUrl, title: finding.sourceTitle }]
      : [];

  return (
    <div className="space-y-2.5 text-xs text-slate-700">
      <span className={`inline-block font-bold px-2 py-0.5 rounded ${kind.className}`}>
        {kind.text}
      </span>

      {finding.lookupFailed && (
        <p className="text-[11px] font-bold text-red-600 leading-snug">
          ウェブ検索ができませんでした。数値は記事の中だけを見たものです。
        </p>
      )}

      {/* With no mark in the document, the claim's own wording is all there is to go on. */}
      {unplaced && (
        <div className="space-y-1">
          <div className="flex items-start gap-1.5 text-slate-600 leading-snug">
            <HelpCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>本文のどの文の話か特定できませんでした。主張の文面:</span>
          </div>
          <div className="bg-slate-50 text-slate-800 border border-slate-200 rounded-lg p-2 leading-relaxed">
            {finding.originalText}
          </div>
        </div>
      )}

      {sources.length > 0 && (
        <div className="space-y-1">
          <span className="text-slate-400 font-medium">根拠のページ</span>
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

      {finding.checkQueries.length > 0 && (
        <div className="space-y-1">
          <span className="text-slate-400 font-medium">ご自身で確かめる</span>
          <ul className="space-y-1">
            {finding.checkQueries.map((query) => (
              <li key={query}>
                <a
                  href={searchUrl(query)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-start gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-2 py-1.5 text-blue-800 hover:bg-blue-100 break-all leading-snug"
                >
                  <Search className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>{query}</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* A wording finding has nothing to look up; its hint is what to change. */}
      {finding.type === "style" && finding.explanation && (
        <p className="text-slate-600 leading-relaxed">{finding.explanation}</p>
      )}
    </div>
  );
}
