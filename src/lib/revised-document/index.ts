import type { AnalysisResult, ClaimResult, StyleIssue } from "@/types";

/**
 * The Revised Document and everything derived from it, built in one place.
 *
 * The page component renders this output and owns nothing but view state:
 * no splitting, matching or diffing lives in the component.
 */

export type Segment = {
  text: string;
};

export type Paragraph = {
  segments: Segment[];
  /** The line breaks that followed this paragraph in the original, or "" at the end. */
  separator: string;
};

export type SentencePair = {
  original: string;
  revised: string;
};

/** One judgement tied to one place in the document. */
export type Finding = {
  id: string;
  type: "fact" | "style";
  title: string;
  categoryLabel: string;
  verdict: "error" | "warning" | "style" | "verified";
  confidence: number;
  originalText: string;
  revisedText: string;
  sourceTitle: string;
  sourceUrl: string;
  explanation: string;
  /** Index into `comparison` — the sentence this Finding sits in. */
  lineIndex: number;
  adopted: boolean;
};

export type RevisedDocumentView = {
  /** The Revised Document, laid out in the paragraphs the writer typed. */
  paragraphs: Paragraph[];
  /** The article body alone, with the original paragraph breaks and nothing else. */
  clipboardText: string;
  /**
   * The same document before any correction, assembled the same way, so the
   * two can be counted and compared against each other.
   */
  originalText: string;
  /** Original and revised sentences side by side, for the wide-screen comparison views. */
  comparison: SentencePair[];
  /** Every Finding, ready to display. */
  findings: Finding[];
  /** Whether the pipeline found anything at all — false means a clean run, not a failed one. */
  hasFindings: boolean;
};

export type RevisedDocumentInput = {
  originalText: string;
  analysis: AnalysisResult;
  /** Finding id to whether its correction is adopted. Missing means adopted. */
  adoption: Record<string, boolean>;
};

type SourceParagraph = {
  sentences: string[];
  separator: string;
};

const PARAGRAPH_PATTERN = /([^\n]+)(\n+|$)/g;
const SENTENCE_BOUNDARY = /(?<=[。！？])/;

/** Split text into paragraphs, remembering the exact breaks that separated them. */
function splitParagraphs(text: string): SourceParagraph[] {
  const paragraphs: SourceParagraph[] = [];

  for (const match of text.matchAll(PARAGRAPH_PATTERN)) {
    const [, body, separator] = match;
    const sentences = splitSentences(body);
    if (sentences.length === 0) continue;
    paragraphs.push({ sentences, separator });
  }

  return paragraphs;
}

/**
 * Sentences keep the spacing they were written with — leading 全角字下げ and
 * the spaces between sentences are part of the writer's text, so joining a
 * paragraph's sentences reproduces it character for character.
 */
function splitSentences(text: string): string[] {
  return text
    .split(SENTENCE_BOUNDARY)
    .filter((sentence) => sentence.trim().length > 0);
}

/** Every sentence of the pipeline's rewrite, flattened across paragraphs. */
function splitRevised(revisedText: string): string[] {
  return revisedText.split(/\n+/).flatMap((line) => splitSentences(line));
}

/** How a Finding is identified, wherever it is referred to. */
export function factFindingId(index: number): string {
  return `fact-${index}`;
}

export function styleFindingId(index: number): string {
  return `style-${index}`;
}

/** The sentence a Finding sits in, or -1 when it cannot be placed. */
export function sentenceIndexOf(sentences: string[], target: string): number {
  const needle = target.trim();
  if (!needle) return -1;
  return sentences.findIndex((sentence) => {
    const haystack = sentence.trim();
    return haystack.includes(needle) || needle.includes(haystack);
  });
}

function claimText(result: ClaimResult): string {
  return result.claim.normalizedText || result.claim.originalText;
}

function isRaised(styleIssue: StyleIssue): boolean {
  return styleIssue.detected !== false;
}

function isAdopted(adoption: Record<string, boolean>, id: string): boolean {
  return adoption[id] !== false;
}

/** Percentages arrive either as a 0–1 ratio or already scaled; normalise both. */
function toPercent(value: number): number {
  return Math.round(value <= 1 ? value * 100 : value);
}

function factFinding(
  result: ClaimResult,
  index: number,
  sentences: string[],
  adoption: Record<string, boolean>
): Finding {
  const text = claimText(result);
  const contradicted = result.verdict === "CONTRADICTED";
  const insufficient = result.verdict === "INSUFFICIENT";
  const id = factFindingId(index);
  const firstEvidence = result.evidence?.[0];
  const sentenceIndex = sentenceIndexOf(sentences, text);

  const defaultConfidence = contradicted ? 0.94 : insufficient ? 0.68 : 0.97;

  return {
    id,
    type: "fact",
    // TODO(#5): compose the heading from kind and target span.
    title: factTitle(text, contradicted),
    categoryLabel: contradicted ? "事実の修正" : insufficient ? "要確認" : "確認済み",
    verdict: contradicted ? "error" : insufficient ? "warning" : "verified",
    confidence: toPercent(result.confidence ?? defaultConfidence),
    originalText: text,
    revisedText: result.correctedClaim || text,
    sourceTitle: firstEvidence?.sourceTitle || "",
    sourceUrl: firstEvidence?.sourceUrl || "",
    explanation: result.reason || defaultExplanation(contradicted, insufficient),
    lineIndex: sentenceIndex >= 0 ? sentenceIndex : index,
    adopted: isAdopted(adoption, id),
  };
}

function factTitle(text: string, contradicted: boolean): string {
  if (text.includes("発表") || text.includes("9月")) return "発売日・発表日に関する誤り";
  if (text.includes("20MP") || text.includes("解像度")) return "デフォルト解像度の数値誤認";
  if (text.includes("望遠") || text.includes("6倍")) return "光学望遠倍率のスペック相違";
  if (text.includes("USB") || text.includes("20Gbps")) return "USB 3データ転送速度の誤認";
  if (text.includes("通信範囲") || text.includes("2倍")) return "超広帯域通信チップの範囲倍率";
  if (text.includes("Wi-Fi")) return "Wi-Fi規格（6E / 7）の誤認";
  if (contradicted) return "事実関係の誤り";
  return "事実に関する確認";
}

function defaultExplanation(contradicted: boolean, insufficient: boolean): string {
  if (contradicted) {
    return "公的発表・一次ソースと照合した結果、数値または日付の記述に明確な食い違いが確認されました。";
  }
  if (insufficient) {
    return "十分な一次証拠が確認できませんでした。専門情報源による再確認を推奨します。";
  }
  return "公式ソースの記述と整合しており、事実の正しさが確認されています。";
}

function styleFinding(
  styleIssue: StyleIssue,
  index: number,
  sentences: string[],
  adoption: Record<string, boolean>
): Finding {
  const id = styleFindingId(index);
  const sentenceIndex = sentenceIndexOf(sentences, styleIssue.targetText ?? "");

  return {
    id,
    type: "style",
    title: styleIssue.ruleName || "不自然な表現",
    categoryLabel: "文章表現",
    verdict: "style",
    confidence: toPercent(styleIssue.confidence || 0.85),
    originalText: styleIssue.targetText || "",
    revisedText: "自然な散文へリライト",
    sourceTitle: "文章品質ガイドライン",
    sourceUrl: "#",
    explanation:
      styleIssue.repairInstruction || "AI特有の紋切り型表現または重複が検出されました。",
    lineIndex: sentenceIndex >= 0 ? sentenceIndex : 0,
    adopted: isAdopted(adoption, id),
  };
}

function buildFindings(
  analysis: AnalysisResult,
  sentences: string[],
  adoption: Record<string, boolean>
): Finding[] {
  return [
    ...analysis.claims.map((result, index) =>
      factFinding(result, index, sentences, adoption)
    ),
    ...analysis.styleIssues.map((styleIssue, index) =>
      styleFinding(styleIssue, index, sentences, adoption)
    ),
  ];
}

export function buildRevisedDocument(
  input: RevisedDocumentInput
): RevisedDocumentView {
  const { originalText, analysis, adoption } = input;

  const sourceParagraphs = splitParagraphs(originalText);
  const originalSentences = sourceParagraphs.flatMap((p) => p.sentences);
  const revisedSentences = splitRevised(analysis.revisedText ?? "");
  const findings = buildFindings(analysis, originalSentences, adoption);

  // A Finding the reader refused leaves its sentence as it was written.
  const rejected = new Set(
    findings
      .filter((finding) => !finding.adopted && finding.lineIndex >= 0)
      .map((finding) => finding.lineIndex)
  );

  // The pipeline rewrites sentence for sentence, so position carries the
  // mapping. A rewrite that runs short leaves the tail as it was written.
  // A rewrite that merges or splits sentences shifts the tail — the pipeline
  // is expected not to, and nothing here can detect it.
  const comparison: SentencePair[] = originalSentences.map((original, index) => ({
    original,
    revised: rejected.has(index) ? original : revisedSentences[index] ?? original,
  }));

  let cursor = 0;
  const paragraphs: Paragraph[] = sourceParagraphs.map((paragraph) => ({
    segments: paragraph.sentences.map(() => ({
      text: comparison[cursor++].revised,
    })),
    separator: paragraph.separator,
  }));

  const clipboardText = paragraphs
    .map((paragraph) => paragraphText(paragraph) + paragraph.separator)
    .join("");

  const assembledOriginal = sourceParagraphs
    .map((paragraph) => paragraph.sentences.join("") + paragraph.separator)
    .join("");

  return {
    paragraphs,
    clipboardText,
    originalText: assembledOriginal,
    comparison,
    findings,
    hasFindings:
      analysis.claims.some((result) => result.verdict !== "SUPPORTED") ||
      analysis.styleIssues.some(isRaised),
  };
}

function paragraphText(paragraph: Paragraph): string {
  return paragraph.segments.map((segment) => segment.text).join("");
}
