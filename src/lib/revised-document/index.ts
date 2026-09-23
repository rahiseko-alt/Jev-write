import type { AnalysisResult, ClaimResult, StyleIssue,
  EvidenceTrace,
  ValueConflict,
} from "@/types";
import { isFlagged } from "@/lib/jev/bands";

/**
 * The Revised Document and everything derived from it, built in one place.
 *
 * The page component renders this output and owns nothing but view state:
 * no splitting, matching or diffing lives in the component.
 */

/** What a mark says about the text it covers. */
export type MarkKind = "fact" | "style";

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
 * What a Finding is about: a sentence and its 信頼度, or a wording. There is
 * no kind for "agrees" or "disagrees" with the sources: the number is all
 * that is said (ADR-0011).
 */
export type FindingKind = "claim" | "ai-tell";

/** One judgement tied to one place in the document. */
export type Finding = {
  id: string;
  type: "fact" | "style";
  title: string;
  categoryLabel: string;
  kind: FindingKind;
  /**
   * The 信頼度 as a percentage: JEV's probability that the sentence is backed
   * by the sources, as returned (ADR-0011). Null when no answer came back,
   * shown as "数値なし": a made-up percentage is exactly the thing this
   * product replaces (ADR-0008).
   */
  confidence: number | null;
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
  /**
   * Where this Finding's evidence went. Present on a fact Finding, so a
   * reader looking at "unverified" can see whether nothing was found, or
   * what was found was thrown away, and at which step.
   */
  evidenceTrace?: EvidenceTrace;
  /**
   * True when the web lookup could not be made at all. The leading number then
   * stands on the article alone, so the screen has to say so: otherwise a run
   * that never searched reads like one that searched and found nothing.
   */
  lookupFailed?: boolean;
  /**
   * Search queries a person can run to check the claim themselves. Empty on a
   * wording finding, which has nothing to look up.
   */
  checkQueries: string[];
  /** Every source JEV judged, with its answer and how sure it was. */
  evidence?: Array<{
    url: string;
    title: string;
    relation?: "supports" | "contradicts";
    confidence?: number;
  }>;
  /**
   * Pages that give another value for a date or amount in the sentence, as
   * the page writes it: 「資料では 2023年10月1日」. The sentence is marked
   * whatever its 信頼度, which is shown unchanged (ADR-0011, ADR-0012).
   */
  valueConflicts?: ValueConflict[];
};

/**
 * The number that decides where a reader should look first: the 信頼度, on
 * JEV's scale of 0 to 1.
 *
 * This tool does not rule on true and false. It shows how well each sentence
 * is backed and lets the reader decide, so the list is ordered by that number
 * and the weakest comes first. A Finding JEV gave no number for is weakest of
 * all: nothing was measured, so nobody has looked at it yet.
 */
export function attentionOf(finding: Finding): number | null {
  return finding.confidence === null ? null : finding.confidence / 100;
}

/**
 * A Finding that should mark the document but found no sentence to mark.
 * Without saying so, it would drop out of the document silently: the reader
 * counts the marks, not the list. A sentence above the line leaves no mark anyway.
 */
export function isUnplaced(finding: Finding): boolean {
  return finding.lineIndex < 0 && finding.markKind !== null;
}

/**
 * The Findings in the order a reader should work through them. The unplaced
 * come first whatever their number: nothing in the document points to them.
 */
export function sortByAttention(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const lost = Number(isUnplaced(b)) - Number(isUnplaced(a));
    if (lost !== 0) return lost;
    const left = attentionOf(a);
    const right = attentionOf(b);
    if (left === null && right === null) return 0;
    if (left === null) return -1;
    if (right === null) return 1;
    return left - right;
  });
}

/** What a fact Finding is called: the number, and nothing else (ADR-0011). */
const CONFIDENCE_LABEL = "信頼度";

/** "信頼度 62%", or "信頼度 数値なし" when no answer came back. */
export function confidenceLabel(percent: number | null): string {
  return `${CONFIDENCE_LABEL} ${percent === null ? "数値なし" : `${percent}%`}`;
}

/** A wording finding's own heading and hint. */
const AI_TELL = {
  label: "文章表現",
  heading: "AIっぽい言い回し",
  explanation: "AI特有の紋切り型表現または重複が検出されました。",
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

  const contained = sentences.findIndex((sentence) => {
    const haystack = sentence.trim();
    return haystack.includes(needle) || needle.includes(haystack);
  });
  if (contained !== -1) return contained;

  // A claim is a machine's paraphrase of a sentence, not a quotation of it:
  // "フリノバの拠点は名古屋駅から徒歩8分" never appears in an article that
  // says "名古屋駅から徒歩8分、国際センター駅から徒歩3分。". Matched by the
  // wording they share, so the reader can still see which sentence a Finding
  // is about; a claim that shares too little is left unplaced rather than
  // pinned on the wrong sentence.
  const wanted = pairsOf(needle);
  if (wanted.size === 0) return -1;

  let best = -1;
  let bestScore = 0;
  sentences.forEach((sentence, index) => {
    const found = pairsOf(sentence.trim());
    let shared = 0;
    for (const pair of wanted) if (found.has(pair)) shared++;
    const score = shared / wanted.size;
    if (score > bestScore) {
      bestScore = score;
      best = index;
    }
  });

  return bestScore >= SENTENCE_MATCH_THRESHOLD ? best : -1;
}

/** How much of a claim's wording a sentence has to share to be its place. */
const SENTENCE_MATCH_THRESHOLD = 0.5;

/** The two-character runs of a string: enough to compare wording across a paraphrase. */
function pairsOf(text: string): Set<string> {
  const stripped = text.replace(/[\s、。「」『』（）()・,.]/g, "");
  const pairs = new Set<string>();
  for (let i = 0; i + 1 < stripped.length; i++) pairs.add(stripped.slice(i, i + 2));
  return pairs;
}

function claimText(result: ClaimResult): string {
  return result.claim.normalizedText || result.claim.originalText;
}

/**
 * The sentence a claim came from. The quote taken from the article is tried
 * first: the normalised statement is a paraphrase and can share too few words
 * with the sentence to find it.
 */
const SEARCH_TERM_LENGTH = 80;

/**
 * What the reader can search to check a claim: the sentence as written, with
 * the markup taken out. The queries the check itself ran were written for the
 * whole article, so they say nothing about this sentence in particular.
 */
function searchTermOf(sentence: string): string {
  return sentence
    .replace(/[#*_`>]+/g, " ")
    .replace(/-{3,}/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[。．.]$/, "")
    .slice(0, SEARCH_TERM_LENGTH);
}

function placeOf(sentences: string[], result: ClaimResult): number {
  const quoted = sentenceIndexOf(sentences, result.claim.originalText);
  return quoted !== -1 ? quoted : sentenceIndexOf(sentences, claimText(result));
}

function isRaised(styleIssue: StyleIssue): boolean {
  return styleIssue.detected !== false;
}

/**
 * Whether the reader has taken this suggestion.
 *
 * A fact suggestion starts refused: what a source says differently is not a
 * settled error, so the reader's own words stand until they choose otherwise.
 * A wording repair starts accepted — nothing factual rides on it.
 */
function isAdopted(
  adoption: Record<string, boolean>,
  id: string,
  byDefault: boolean
): boolean {
  return adoption[id] ?? byDefault;
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
  const id = factFindingId(index);
  const firstEvidence = result.evidence?.[0];
  // Nothing is rewritten, so the sentence the Finding points at is the
  // sentence as written (ADR-0010).
  const corrected = text;
  const at = placeOf(sentences, result);
  const ratio = result.confidence;
  const percent = ratio === undefined ? null : toPercent(ratio);
  // Every sentence at or below the line gets a ▶, and so does one with no
  // number: nothing was measured, so it has not been looked at (ADR-0011).
  // So does one a page gives another date or amount for (ADR-0012): JEV
  // reads those as text, and its number can stay high over them.
  const valueConflicts = result.valueConflicts ?? [];
  const flagged =
    ratio === undefined ||
    isFlagged(ratio <= 1 ? ratio : ratio / 100) ||
    valueConflicts.length > 0;

  return {
    id,
    type: "fact",
    title: compose(confidenceLabel(percent), text),
    categoryLabel: CONFIDENCE_LABEL,
    kind: "claim",
    confidence: percent,
    originalText: text,
    revisedText: corrected,
    sourceTitle: firstEvidence?.sourceTitle || "",
    sourceUrl: firstEvidence?.sourceUrl || "",
    explanation: result.reason || "",
    lineIndex: at,
    adopted: isAdopted(adoption, id, false),
    markKind: flagged ? "fact" : null,
    adoptable: false,
    sentenceBefore: "",
    sentenceAfter: "",
    evidenceTrace: result.evidenceTrace,
    checkQueries: [],
    lookupFailed: result.lookupFailed,
    evidence: (result.evidence ?? []).map((item) => ({
      url: item.sourceUrl,
      title: item.sourceTitle,
      relation: item.relation,
      confidence: item.confidence,
    })),
    ...(valueConflicts.length > 0 ? { valueConflicts } : {}),
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
  const shape = AI_TELL;
  const at = sentenceIndexOf(sentences, styleIssue.targetText ?? "");
  const before = at >= 0 ? sentences[at] : styleIssue.targetText || "";
  const after = at >= 0 ? revised[at] ?? before : before;

  return {
    id,
    type: "style",
    title: compose(styleIssue.ruleName || shape.heading, styleIssue.targetText ?? ""),
    categoryLabel: shape.label,
    kind: "ai-tell",
    confidence:
      typeof styleIssue.confidence === "number" ? toPercent(styleIssue.confidence) : null,
    originalText: before,
    revisedText: after,
    sourceTitle: "",
    sourceUrl: "",
    explanation: styleIssue.repairInstruction || shape.explanation,
    lineIndex: at,
    adopted: isAdopted(adoption, id, true),
    markKind: isRaised(styleIssue) ? "style" : null,
    adoptable: isRaised(styleIssue) && at >= 0 && after !== before,
    sentenceBefore: "",
    sentenceAfter: "",
    checkQueries: [],
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
  // Only a suggestion can be put back, and this tool makes none: a Finding
  // that was never adoptable leaves the sentence exactly as written.
  const refused = findings.filter(
    (finding) => finding.lineIndex === sentenceIndex && isRefused(finding)
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
    if (finding.type === "fact") {
      const term = searchTermOf(finding.sentenceBefore);
      finding.checkQueries = term ? [term] : [];
    }
  }

  let cursor = 0;
  const paragraphs: Paragraph[] = sourceParagraphs.map((paragraph) => ({
    segments: paragraph.sentences.flatMap(() => {
      const index = cursor++;
      return markSentence(comparison[index].revised, findings, index);
    }),
    separator: paragraph.separator,
  }));

  // The margin shows a Finding only where its mark is. One that should mark
  // the document but ended up on no mark is shown as unplaced rather than
  // dropped without a word.
  const marked = new Set(
    paragraphs.flatMap((p) => p.segments).flatMap((s) => s.mark?.findingIds ?? [])
  );
  for (const finding of findings) {
    if (finding.markKind !== null && finding.lineIndex >= 0 && !marked.has(finding.id)) {
      finding.lineIndex = -1;
    }
  }

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
const MARK_PRECEDENCE: MarkKind[] = ["fact", "style"];

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
/**
 * Whether the reader turned this suggestion down.
 *
 * Only a suggestion can be refused. A sentence marked because nothing backed
 * it was never a suggestion, so it is drawn plainly rather than faded: it is
 * not a correction the reader declined, it is a sentence nobody could check.
 */
function isRefused(finding: Finding): boolean {
  return finding.adoptable && !finding.adopted;
}

function markSentence(
  text: string,
  findings: Finding[],
  sentenceIndex: number
): Segment[] {
  const onThisSentence = findings.filter(
    (finding) => finding.lineIndex === sentenceIndex && finding.markKind !== null
  );

  // Nothing is rewritten, and the question is asked of the sentence as
  // written, so every mark covers the whole sentence (ADR-0010, ADR-0011).
  const spans: Span[] = [];
  const wholeSentence: Finding[] = onThisSentence;

  spans.sort((a, b) => a.start - b.start);
  const merged = mergeOverlaps(spans);
  const background: Mark | undefined = wholeSentence.length
    ? {
        findingIds: wholeSentence.map((finding) => finding.id),
        kind: strongest(wholeSentence.map((finding) => finding.markKind!)),
        rejected: wholeSentence.every(isRefused),
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

  // A span covering the whole sentence leaves no gap for the background to
  // show in. Its Findings ride on the first mark instead of vanishing.
  if (background && !segments.some((segment) => segment.mark === background)) {
    const first = segments.find((segment) => segment.mark)!.mark!;
    first.findingIds.push(...background.findingIds);
    first.kind = strongest([first.kind, background.kind]);
    first.rejected = first.rejected && background.rejected;
  }

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

/** "信頼度 62%: 価格は10万円" — the number, then what it points at. */
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
