import type { JEVQuestion } from "@/lib/providers";

/**
 * The one question each sentence is asked (ADR-0011). Its answer, as JEV
 * returns it, is the 信頼度 on screen: higher means "yes, the sources back it".
 */
export const SUPPORT_QUESTION: JEVQuestion = {
  type: "noul",
  instructions: "記事の原文のこの文（claim.original）は、sources の内容で裏付けられているか。",
};

/**
 * The question asked of every section before the one above (ADR-0014): does
 * this section speak to the sentence at all. One judgment per question, one
 * question per section, all in the same request (docs.typesafe.ai/patterns/
 * fan-out). Yes means related. Which sections are passed on is decided in
 * code from the answers, not here.
 */
export function relevanceQuestion(index: number): JEVQuestion {
  return {
    type: "noul",
    instructions: `sources[${index}] のこの節は、claim.original と同じ事柄について述べているか。`,
  };
}

/**
 * How large a section is, taken from the official citation cookbook, whose
 * sections ran from 270 to 3,122 characters (docs.typesafe.ai/cookbooks/
 * citation_check). A section is closed at a heading once it has reached the
 * smaller size, and before it would grow past the larger one.
 */
export const SECTION_MIN_CHARS = 270;
export const SECTION_MAX_CHARS = 3122;

/**
 * JEV's input limits (docs.typesafe.ai/models): 64k tokens per request, and
 * 32k tokens for the state plus the single longest question. The budgets
 * below keep a margin under both, on top of an estimate that already
 * over-counts.
 */
export const STATE_TOKEN_BUDGET = 30000;
export const REQUEST_TOKEN_BUDGET = 60000;

/**
 * A deliberately high estimate of how many tokens a text costs: one and a
 * half per character outside ASCII (Japanese), one per three ASCII
 * characters. Too high only splits a request that would have fitted; too low
 * gets it refused.
 */
export function estimateTokens(text: string): number {
  let wide = 0;
  let narrow = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 0x80) narrow++;
    else wide++;
  }
  return Math.ceil(wide * 1.5 + narrow / 3);
}

/** A page as it was collected, or one section of it as it goes into the state. */
export type SourcePage = { title: string; url: string; text: string };

/** One section, and the page it came from (the order the pages were given). */
export type Section = { page: number; source: SourcePage };

/**
 * Whether a line reads as a heading: marked as one, or short and not ending
 * the way a sentence does. Pages arrive as one line per block element, so
 * this is all there is to go on.
 */
function isHeading(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^#{1,6}\s/.test(trimmed)) return true;
  if (/^[■□◆◇●▼▽【]/.test(trimmed) && trimmed.length <= 60) return true;
  return trimmed.length <= 40 && !/[。．.!?！？、,，」』）)]$/.test(trimmed);
}

/**
 * A page's text in sections, cut at headings and paragraph breaks. Nothing is
 * dropped: the sections joined back together are the text, character for
 * character. A single paragraph longer than a section is cut at the ends of
 * its sentences, and a sentence longer than that at the size itself.
 */
export function splitSections(
  text: string,
  minChars: number = SECTION_MIN_CHARS,
  maxChars: number = SECTION_MAX_CHARS
): string[] {
  if (!text) return [];

  // Lines, each keeping its own line break, so joining them gives the text back.
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [text];
  const pieces = lines.flatMap((line) => (length(line) > maxChars ? splitLong(line, maxChars) : [line]));

  const sections: string[] = [];
  let current = "";
  for (const piece of pieces) {
    const size = length(current);
    const atHeading = isHeading(piece) && size >= minChars;
    const tooLong = size > 0 && size + length(piece) > maxChars;
    if (current && (atHeading || tooLong)) {
      sections.push(current);
      current = "";
    }
    current += piece;
  }
  if (current) sections.push(current);
  return sections;
}

function length(text: string): number {
  return Array.from(text).length;
}

/** A paragraph too long for one section, at sentence ends, each piece within `maxChars`. */
function splitLong(line: string, maxChars: number): string[] {
  const sentences = line.match(/[^。．.!?！？]*[。．.!?！？]+|[^。．.!?！？]+$/g) ?? [line];
  const pieces: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    const chars = Array.from(sentence);
    if (chars.length > maxChars) {
      if (current) pieces.push(current);
      current = "";
      for (let at = 0; at < chars.length; at += maxChars) {
        pieces.push(chars.slice(at, at + maxChars).join(""));
      }
      continue;
    }
    if (length(current) + chars.length > maxChars) {
      pieces.push(current);
      current = "";
    }
    current += sentence;
  }
  if (current) pieces.push(current);
  return pieces;
}

/** Every page in sections, in page order and then in reading order. */
export function sectionsOf(pages: SourcePage[]): Section[] {
  return pages.flatMap((page, index) =>
    splitSections(page.text).map((text) => ({
      page: index,
      source: { title: page.title, url: page.url, text },
    }))
  );
}

export type JEVRequest = {
  state: {
    claim: { original: string };
    sources: SourcePage[];
  };
  /** Which of the given sections `state.sources` holds, in the same order. */
  sections: number[];
  questions: Record<string, JEVQuestion>;
};

/**
 * The first step: every section is asked whether it speaks to the sentence.
 * Normally one request; more only when the sections together would go over
 * JEV's limit. Every section is asked (ADR-0007: none is left out here).
 */
export function planRelevanceRequests(params: {
  original: string;
  sections: Section[];
  stateBudget?: number;
  requestBudget?: number;
}): JEVRequest[] {
  if (params.sections.length === 0) return [];
  return pack({
    ...params,
    fixed: {},
    perSection: relevanceQuestion,
  });
}

/**
 * The second step: the 信頼度 question, with only the sections judged to
 * speak to the sentence as `sources`. With none, it is still asked with
 * `sources` empty — the same as a sentence nothing was found for. Spread over
 * more than one request only when the sections would go over JEV's limit.
 */
export function planSupportRequests(params: {
  original: string;
  sections: Section[];
  stateBudget?: number;
  requestBudget?: number;
}): JEVRequest[] {
  return pack({
    ...params,
    fixed: { support: SUPPORT_QUESTION },
  });
}

function pack(params: {
  original: string;
  sections: Section[];
  fixed: Record<string, JEVQuestion>;
  perSection?: (index: number) => JEVQuestion;
  stateBudget?: number;
  requestBudget?: number;
}): JEVRequest[] {
  const {
    original,
    sections,
    fixed,
    perSection,
    stateBudget = STATE_TOKEN_BUDGET,
    requestBudget = REQUEST_TOKEN_BUDGET,
  } = params;

  const base = { claim: { original } };
  const cost = (value: unknown) => estimateTokens(JSON.stringify(value));
  const fixedCost = Object.values(fixed).reduce((sum, q) => sum + cost(q), 0);
  // The longest question: a fixed one, or a per-section one with a wide index.
  const longest = Math.max(
    0,
    ...Object.values(fixed).map(cost),
    perSection ? cost(perSection(9999)) : 0
  );
  const baseCost = cost({ ...base, sources: [] });

  const requests: JEVRequest[] = [];
  let current: number[] = [];
  let used = 0;
  let asked = fixedCost;

  const flush = () => {
    const questions: Record<string, JEVQuestion> = { ...fixed };
    if (perSection) {
      current.forEach((_, i) => {
        questions[`relevant${i}`] = perSection(i);
      });
    }
    requests.push({
      state: { ...base, sources: current.map((i) => sections[i].source) },
      sections: current,
      questions,
    });
    current = [];
    used = 0;
    asked = fixedCost;
  };

  sections.forEach((section, index) => {
    // A separator's worth on top of the section itself.
    const size = cost(section.source) + 1;
    const extra = perSection ? cost(perSection(current.length)) : 0;
    if (baseCost + size + longest > stateBudget) {
      throw new Error(
        `資料の1節が、JEVの入力上限（状態と最長の問いで32kトークン）に収まりません（見積もり ${baseCost + size + longest}）。`
      );
    }
    const fits =
      baseCost + used + size + longest <= stateBudget &&
      baseCost + used + size + asked + extra <= requestBudget;
    if (!fits && current.length > 0) flush();
    current.push(index);
    used += size;
    asked += perSection ? cost(perSection(current.length - 1)) : 0;
  });

  if (current.length > 0 || requests.length === 0) flush();
  return requests;
}
