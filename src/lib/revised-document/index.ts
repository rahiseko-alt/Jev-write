import type { AnalysisResult, ClaimResult, ClaimVerdict, StyleIssue } from "@/types";

/**
 * The Revised Document and everything derived from it, built in one place.
 *
 * The page component renders this output and owns nothing but view state:
 * no splitting, matching or diffing lives in the component.
 */

/** What a mark says about the text it covers. */
export type MarkKind = "fact" | "style" | "unverified";

export type Mark = {
  /** Every Finding covering this text; more than one can share a span. */
  findingIds: string[];
  /** The most pressing kind among them. */
  kind: MarkKind;
  /** The reader refused this correction, so the text is as they wrote it. */
  rejected: boolean;
};

export type Segment = {
  text: string;
  /** Absent on the text the tool did not touch and had no doubt about. */
  mark?: Mark;
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

/**
 * What a Finding says about its text. Kept apart from the pipeline's
 * ClaimVerdict, which answers a different question.
 */
export type FindingKind = "corrected" | "unverified" | "ai-tell" | "confirmed";

/** One judgement tied to one place in the document. */
export type Finding = {
  id: string;
  type: "fact" | "style";
  title: string;
  categoryLabel: string;
  kind: FindingKind;
  confidence: number;
  originalText: string;
  revisedText: string;
  sourceTitle: string;
  sourceUrl: string;
  explanation: string;
  /** Index into `comparison` — the sentence this Finding sits in, or -1 when it could not be placed. */
  lineIndex: number;
  adopted: boolean;
  /** How this Finding marks the document, or null when it leaves no mark. */
  markKind: MarkKind | null;
  /** Whether there is a correction to accept or refuse at all. */
  adoptable: boolean;
  /**
   * The sentence this Finding sits in, as the reader wrote it and as the
   * document now shows it. The claim's own text is a machine paraphrase and
   * can read nothing like the article, so what is shown beside the document
   * is the document's own wording.
   */
  sentenceBefore: string;
  sentenceAfter: string;
};

/** Everything that follows from a Finding's kind, in one place. */
const FINDING_KINDS: Record<
  FindingKind,
  {
    label: string;
    heading: string;
    markKind: MarkKind | null;
    confidence: number;
    explanation: string;
  }
> = {
  corrected: {
    label: "事実の修正",
    heading: "事実の誤り",
    markKind: "fact",
    confidence: 0.94,
    explanation:
      "公的発表・一次ソースと照合した結果、数値または日付の記述に明確な食い違いが確認されました。",
  },
  unverified: {
    label: "要確認",
    heading: "根拠が見つかりません",
    markKind: "unverified",
    confidence: 0.68,
    explanation: "十分な一次証拠が確認できませんでした。専門情報源による再確認を推奨します。",
  },
  "ai-tell": {
    label: "文章表現",
    heading: "AIっぽい言い回し",
    markKind: "style",
    confidence: 0.85,
    explanation: "AI特有の紋切り型表現または重複が検出されました。",
  },
  confirmed: {
    label: "確認済み",
    heading: "確認済み",
    markKind: null,
    confidence: 0.97,
    explanation: "公式ソースの記述と整合しており、事実の正しさが確認されています。",
  },
};

/** A MIXED claim is not confirmed: it still needs a person to look at it. */
const KIND_BY_VERDICT: Record<ClaimVerdict, FindingKind> = {
  CONTRADICTED: "corrected",
  INSUFFICIENT: "unverified",
  MIXED: "unverified",
  SUPPORTED: "confirmed",
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
  /** A short name for the document, taken from its opening. */
  title: string;
  /** Whether the pipeline found anything at all — false means a clean run, not a failed one. */
  hasFindings: boolean;
};

export type RevisedDocumentInput = {
  /**
   * The analysis to render. The document it marks up is the text this
   * analysis ran on, which the analysis carries itself — never whatever is
   * in the editor at the moment, which may by now be another article.
   */
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
function factFindingId(index: number): string {
  return `fact-${index}`;
}

function styleFindingId(index: number): string {
  return `style-${index}`;
}

/** The sentence a Finding sits in, or -1 when it cannot be placed. */
function sentenceIndexOf(sentences: string[], target: string): number {
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
  const kind = KIND_BY_VERDICT[result.verdict];
  const shape = FINDING_KINDS[kind];
  const id = factFindingId(index);
  const firstEvidence = result.evidence?.[0];
  const corrected = result.correctedClaim || text;
  const at = sentenceIndexOf(sentences, text);

  return {
    id,
    type: "fact",
    title: compose(
      shape.heading,
      kind === "corrected" ? changedWording(corrected, text) || text : text
    ),
    categoryLabel: shape.label,
    kind,
    confidence: toPercent(result.confidence ?? shape.confidence),
    originalText: text,
    revisedText: corrected,
    sourceTitle: firstEvidence?.sourceTitle || "",
    sourceUrl: firstEvidence?.sourceUrl || "",
    explanation: result.reason || shape.explanation,
    lineIndex: at,
    adopted: isAdopted(adoption, id),
    markKind: shape.markKind,
    adoptable: kind === "corrected" && at >= 0 && corrected !== text,
    sentenceBefore: "",
    sentenceAfter: "",
  };
}

function styleFinding(
  styleIssue: StyleIssue,
  index: number,
  sentences: string[],
  revised: string[],
  adoption: Record<string, boolean>
): Finding {
  const id = styleFindingId(index);
  const shape = FINDING_KINDS["ai-tell"];
  const at = sentenceIndexOf(sentences, styleIssue.targetText ?? "");
  const before = at >= 0 ? sentences[at] : styleIssue.targetText || "";
  const after = at >= 0 ? revised[at] ?? before : before;

  return {
    id,
    type: "style",
    title: compose(styleIssue.ruleName || shape.heading, styleIssue.targetText ?? ""),
    categoryLabel: shape.label,
    kind: "ai-tell",
    confidence: toPercent(styleIssue.confidence || shape.confidence),
    originalText: before,
    revisedText: after,
    sourceTitle: "",
    sourceUrl: "",
    explanation: styleIssue.repairInstruction || shape.explanation,
    lineIndex: at,
    adopted: isAdopted(adoption, id),
    markKind: isRaised(styleIssue) ? shape.markKind : null,
    adoptable: isRaised(styleIssue) && at >= 0 && after !== before,
    sentenceBefore: "",
    sentenceAfter: "",
  };
}

function buildFindings(
  analysis: AnalysisResult,
  sentences: string[],
  revised: string[],
  adoption: Record<string, boolean>
): Finding[] {
  return [
    ...analysis.claims.map((result, index) =>
      factFinding(result, index, sentences, adoption)
    ),
    ...analysis.styleIssues.map((styleIssue, index) =>
      styleFinding(styleIssue, index, sentences, revised, adoption)
    ),
  ];
}

/**
 * The sentence as it stands once the reader has had their say. Refusing one
 * correction puts back the words it replaced — and only those, so another
 * correction accepted in the same sentence survives it. An AI-tell covers the
 * whole sentence, so refusing that one restores all of it.
 */
function resolveSentence(
  original: string,
  revised: string,
  findings: Finding[],
  sentenceIndex: number
): string {
  const refused = findings.filter(
    (finding) => finding.lineIndex === sentenceIndex && !finding.adopted
  );

  if (refused.length === 0) return revised;
  if (refused.some((finding) => finding.type === "style")) return original;

  let text = revised;
  for (const finding of refused) {
    const located = locateChange(text, finding.originalText, finding.revisedText);
    if (!located) return original; // cannot put back only part of it
    const restored = changedWording(finding.revisedText, finding.originalText);
    text = text.slice(0, located[0]) + restored + text.slice(located[1]);
  }

  return text;
}

export function buildRevisedDocument(
  input: RevisedDocumentInput
): RevisedDocumentView {
  const { analysis, adoption } = input;
  const originalText = analysis.originalText ?? "";

  const sourceParagraphs = splitParagraphs(originalText);
  const originalSentences = sourceParagraphs.flatMap((p) => p.sentences);
  const revisedSentences = splitRevised(analysis.revisedText ?? "");
  const findings = buildFindings(
    analysis,
    originalSentences,
    revisedSentences,
    adoption
  );

  // The pipeline rewrites sentence for sentence, so position carries the
  // mapping. A rewrite that runs short leaves the tail as it was written.
  // A rewrite that merges or splits sentences shifts the tail — the pipeline
  // is expected not to, and nothing here can detect it.
  const comparison: SentencePair[] = originalSentences.map((original, index) => ({
    original,
    revised: resolveSentence(
      original,
      revisedSentences[index] ?? original,
      findings,
      index
    ),
  }));

  for (const finding of findings) {
    const pair = comparison[finding.lineIndex];
    finding.sentenceBefore = pair?.original ?? finding.originalText;
    finding.sentenceAfter = pair?.revised ?? finding.revisedText;
  }

  let cursor = 0;
  const paragraphs: Paragraph[] = sourceParagraphs.map((paragraph) => ({
    segments: paragraph.sentences.flatMap(() => {
      const index = cursor++;
      return markSentence(comparison[index].revised, findings, index);
    }),
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
    title: documentTitle(originalSentences),
    hasFindings: findings.some((finding) => finding.markKind !== null),
  };
}

type Span = {
  start: number;
  end: number;
  findingIds: string[];
  kind: MarkKind;
  rejected: boolean;
};

/** Which mark wins where two cover the same text. */
const MARK_PRECEDENCE: MarkKind[] = ["fact", "unverified", "style"];

function strongest(kinds: MarkKind[]): MarkKind {
  return MARK_PRECEDENCE.find((kind) => kinds.includes(kind)) ?? kinds[0];
}

/**
 * The words a correction actually changed: what is left of the corrected
 * claim once the wording it shares with the original is stripped from both
 * ends. "価格は10万円" → "価格は12万円" leaves "12".
 */
function changedWording(original: string, corrected: string): string {
  let head = 0;
  while (
    head < original.length &&
    head < corrected.length &&
    original[head] === corrected[head]
  ) {
    head++;
  }

  let tail = 0;
  while (
    tail < original.length - head &&
    tail < corrected.length - head &&
    original[original.length - 1 - tail] === corrected[corrected.length - 1 - tail]
  ) {
    tail++;
  }

  return expandToToken(corrected, head, corrected.length - tail);
}

const ALPHANUMERIC = /[0-9A-Za-z\uFF10-\uFF19\uFF21-\uFF3A\uFF41-\uFF5A]/;

/**
 * A single changed digit is not a word. Grow the span out over the figure or
 * word it sits inside, so "1[2]日" marks "12" rather than the "2" alone.
 */
function expandToToken(text: string, start: number, end: number): string {
  let from = start;
  let to = end;

  while (from > 0 && ALPHANUMERIC.test(text[from - 1]) && ALPHANUMERIC.test(text[from])) {
    from--;
  }
  while (to < text.length && ALPHANUMERIC.test(text[to]) && ALPHANUMERIC.test(text[to - 1])) {
    to++;
  }

  return text.slice(from, to);
}

const ANCHOR_LENGTH = 8;

/**
 * Where a correction's changed wording sits in the sentence as it now reads.
 * The words just before the change anchor the search, so a figure that also
 * appears elsewhere in the sentence is not marked by mistake.
 */
function locateChange(sentence: string, from: string, to: string): [number, number] | null {
  const changed = changedWording(from, to);

  if (changed.length > 0) {
    const anchor = anchorFor(to, changed);
    const anchored = sentence.indexOf(anchor + changed);
    if (anchored >= 0) {
      const start = anchored + anchor.length;
      return [start, start + changed.length];
    }

    const alone = sentence.indexOf(changed);
    if (alone >= 0 && sentence.indexOf(changed, alone + 1) < 0) {
      return [alone, alone + changed.length];
    }
  }

  const whole = to ? sentence.indexOf(to) : -1;
  return whole >= 0 ? [whole, whole + to.length] : null;
}

function anchorFor(wording: string, changed: string): string {
  const head = wording.indexOf(changed);
  if (head <= 0) return "";
  return wording.slice(Math.max(0, head - ANCHOR_LENGTH), head);
}

/**
 * A corrected fact marks the words that changed; an AI-tell repair and an
 * unverified claim mark the sentence they sit in. Where a correction's span
 * cannot be found in the sentence — the pipeline rephrased more than the
 * claim, or the reader refused it — the mark widens to the sentence rather
 * than disappearing.
 */
function markSentence(
  text: string,
  findings: Finding[],
  sentenceIndex: number
): Segment[] {
  const onThisSentence = findings.filter(
    (finding) => finding.lineIndex === sentenceIndex && finding.markKind !== null
  );

  const spans: Span[] = [];
  const wholeSentence: Finding[] = [];

  for (const finding of onThisSentence) {
    // A refused correction leaves the sentence as it was written, so the mark
    // follows the reader's own wording rather than the one they turned down.
    const located =
      finding.markKind === "fact"
        ? finding.adopted
          ? locateChange(text, finding.originalText, finding.revisedText)
          : locateChange(text, finding.revisedText, finding.originalText)
        : null;

    if (located) {
      spans.push({
        start: located[0],
        end: located[1],
        findingIds: [finding.id],
        kind: finding.markKind!,
        rejected: !finding.adopted,
      });
    } else {
      wholeSentence.push(finding);
    }
  }

  spans.sort((a, b) => a.start - b.start);
  const merged = mergeOverlaps(spans);
  const background: Mark | undefined = wholeSentence.length
    ? {
        findingIds: wholeSentence.map((finding) => finding.id),
        kind: strongest(wholeSentence.map((finding) => finding.markKind!)),
        rejected: wholeSentence.every((finding) => !finding.adopted),
      }
    : undefined;

  if (merged.length === 0) {
    return background ? [{ text, mark: background }] : [{ text }];
  }

  const segments: Segment[] = [];
  let at = 0;

  for (const span of merged) {
    if (span.start > at) segments.push(gap(text.slice(at, span.start), background));
    segments.push({
      text: text.slice(span.start, span.end),
      mark: { findingIds: span.findingIds, kind: span.kind, rejected: span.rejected },
    });
    at = span.end;
  }

  if (at < text.length) segments.push(gap(text.slice(at), background));

  return segments;
}

/** Spans that overlap become one mark carrying both Findings, never one dropped. */
function mergeOverlaps(spans: Span[]): Span[] {
  const merged: Span[] = [];

  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.start < last.end) {
      last.end = Math.max(last.end, span.end);
      last.findingIds.push(...span.findingIds);
      last.kind = strongest([last.kind, span.kind]);
      last.rejected = last.rejected && span.rejected;
      continue;
    }
    merged.push({ ...span, findingIds: [...span.findingIds] });
  }

  return merged;
}

function gap(text: string, background?: Mark): Segment {
  return background ? { text, mark: background } : { text };
}

const SPAN_LENGTH = 20;

/** "事実の誤り: 12万円" — the kind, then what it points at. */
function compose(heading: string, span: string): string {
  const target = span.trim();
  if (!target) return heading;
  const shown =
    target.length > SPAN_LENGTH ? `${target.slice(0, SPAN_LENGTH)}…` : target;
  return `${heading}: ${shown}`;
}

const TITLE_LENGTH = 36;

function documentTitle(sentences: string[]): string {
  const opening = sentences[0]?.trim() ?? "";
  return opening.slice(0, TITLE_LENGTH) || "文章の品質検証レポート";
}

function paragraphText(paragraph: Paragraph): string {
  return paragraph.segments.map((segment) => segment.text).join("");
}
