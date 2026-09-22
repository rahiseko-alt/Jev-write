import type { AnalysisResult, ClaimResult, StyleIssue } from "@/types";

/**
 * Everything the result screen renders, derived in one place.
 *
 * The page component renders this output and owns nothing but view state:
 * no splitting, matching or diffing lives in the component.
 */

export type Segment = {
  text: string;
};

export type Paragraph = {
  segments: Segment[];
};

export type SentencePair = {
  original: string;
  revised: string;
};

export type ResultView = {
  /** The Revised Document, laid out in the paragraphs the writer typed. */
  paragraphs: Paragraph[];
  /** The article body alone, with the original paragraph breaks and nothing else. */
  clipboardText: string;
  /** Original and revised sentences side by side, for the wide-screen comparison views. */
  comparison: SentencePair[];
  /** Whether the pipeline found anything at all — false means a clean run, not a failed one. */
  hasFindings: boolean;
};

export type ResultViewInput = {
  originalText: string;
  analysis: AnalysisResult;
  /** Finding id to whether its correction is adopted. Missing means adopted. */
  adoption: Record<string, boolean>;
};

type SourceParagraph = {
  sentences: string[];
  /** The line breaks that followed this paragraph in the original, or "" at the end. */
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

function splitSentences(text: string): string[] {
  return text
    .split(SENTENCE_BOUNDARY)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/** Every sentence of the pipeline's rewrite, flattened across paragraphs. */
function splitRevised(revisedText: string): string[] {
  return revisedText.split(/\n+/).flatMap((line) => splitSentences(line));
}

function claimText(result: ClaimResult): string {
  return result.claim.normalizedText || result.claim.originalText;
}

/** The sentence a Finding sits in, or -1 when it cannot be placed. */
function sentenceIndexOf(sentences: string[], target: string): number {
  if (!target) return -1;
  return sentences.findIndex(
    (sentence) => sentence.includes(target) || target.includes(sentence)
  );
}

function isRaised(issue: StyleIssue): boolean {
  return issue.detected !== false;
}

/**
 * The sentences whose correction the reader refused. A refusal restores that
 * sentence as it was written, everywhere the document is rendered or copied.
 */
function rejectedSentences(
  analysis: AnalysisResult,
  sentences: string[],
  adoption: Record<string, boolean>
): Set<number> {
  const rejected = new Set<number>();

  analysis.claims.forEach((result, index) => {
    if (adoption[`fact-${index}`] !== false) return;
    const sentenceIndex = sentenceIndexOf(sentences, claimText(result));
    if (sentenceIndex >= 0) rejected.add(sentenceIndex);
  });

  analysis.styleIssues.forEach((issue, index) => {
    if (adoption[`style-${index}`] !== false) return;
    const sentenceIndex = sentenceIndexOf(sentences, issue.targetText ?? "");
    if (sentenceIndex >= 0) rejected.add(sentenceIndex);
  });

  return rejected;
}

function foundAnything(analysis: AnalysisResult): boolean {
  const unresolvedClaim = analysis.claims.some(
    (result) => result.verdict !== "SUPPORTED"
  );

  return unresolvedClaim || analysis.styleIssues.some(isRaised);
}

export function buildResultView(input: ResultViewInput): ResultView {
  const { originalText, analysis, adoption } = input;

  const sourceParagraphs = splitParagraphs(originalText);
  const originalSentences = sourceParagraphs.flatMap((p) => p.sentences);
  const revisedSentences = splitRevised(analysis.revisedText ?? "");
  const rejected = rejectedSentences(analysis, originalSentences, adoption);

  // The pipeline rewrites sentence for sentence, so position carries the
  // mapping. A rewrite that runs short leaves the tail as it was written.
  const comparison: SentencePair[] = originalSentences.map((original, index) => ({
    original,
    revised: rejected.has(index) ? original : revisedSentences[index] ?? original,
  }));

  let cursor = 0;
  const paragraphs: Paragraph[] = sourceParagraphs.map((paragraph) => ({
    segments: paragraph.sentences.map(() => ({
      text: comparison[cursor++].revised,
    })),
  }));

  const clipboardText = sourceParagraphs
    .map((paragraph, index) => paragraphText(paragraphs[index]) + paragraph.separator)
    .join("");

  return {
    paragraphs,
    clipboardText,
    comparison,
    hasFindings: foundAnything(analysis),
  };
}

function paragraphText(paragraph: Paragraph): string {
  return paragraph.segments.map((segment) => segment.text).join("");
}
