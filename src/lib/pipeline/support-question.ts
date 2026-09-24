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
 * How large a section is, taken from the official citation cookbook, whose
 * sections ran from 270 to 3,122 characters (docs.typesafe.ai/cookbooks/
 * citation_check). A section is closed at a heading once it has reached the
 * smaller size, and before it would grow past the larger one.
 *
 * The relevance question (relevance-question.ts, ADR-0022) is asked of the
 * reading sections below, which keep to the larger size.
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

/**
 * Where a page comes from (ADR-0016): its origin (a site, or sites carrying
 * the same text), and whether its address is a primary source's. Handed to
 * JEV as attributes; nothing is weighed by them here.
 */
export type SourceOrigin = { origin: string; primary: boolean; primaryKind?: string };

/** A collected page with its origin, when it is known. */
export type OriginPage = SourcePage & Partial<SourceOrigin>;

/** One section, the page it came from (the order the pages were given), and that page's origin. */
export type Section = { page: number; source: SourcePage } & Partial<SourceOrigin>;

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

/**
 * A page's text as the sections JEV judges and reads (ADR-0022): the
 * sections splitSections cuts, joined again in reading order for as long as
 * the joined text stays within `maxChars` (the largest section of ADR-0014).
 * Nothing is dropped or reordered: joined back together they are the text.
 *
 * Why joined: pages arrive one line per block element, and most short lines
 * read as headings, so splitSections closes a section at nearly every one
 * once it has 270 characters. On nine real pages fetched as the run fetches
 * them (国税庁・総務省・政府広報オンライン・証券会社・ふるさと納税と通販の
 * 仲介サイト、2026-09-24) that gave 162 sections, 327 characters on average,
 * 18 a page. Every section is one relevance request carrying every claim's
 * question (relevance-question.ts), so sections that small would make the
 * questions most of what is sent, and a pool of some 200 pages would take
 * thousands of requests: more than JEV's rate limit lets through in the time
 * the run has (ADR-0022 has the numbers).
 */
export function readingSections(text: string, maxChars: number = SECTION_MAX_CHARS): string[] {
  const joined: string[] = [];
  let current = "";
  let size = 0;
  for (const section of splitSections(text)) {
    const length = Array.from(section).length;
    if (current && size + length > maxChars) {
      joined.push(current);
      current = "";
      size = 0;
    }
    current += section;
    size += length;
  }
  if (current) joined.push(current);
  return joined;
}

/** Every page in reading sections, in page order and then in reading order. */
export function sectionsOf(pages: OriginPage[]): Section[] {
  return pages.flatMap((page, index) =>
    readingSections(page.text).map((text) => ({
      page: index,
      source: { title: page.title, url: page.url, text },
      ...(page.origin !== undefined ? { origin: page.origin } : {}),
      ...(page.primary !== undefined ? { primary: page.primary } : {}),
      ...(page.primaryKind !== undefined ? { primaryKind: page.primaryKind } : {}),
    }))
  );
}

/**
 * One origin in the 信頼度 question's `sources` (ADR-0016): the related
 * sections of the pages that share it, each saying whether it comes from a
 * primary source. Pages of one site, or copies of one text, arrive as one
 * origin, so a reprint is never read as a second, independent source.
 */
export type OriginSources = {
  origin: string;
  sections: (SourcePage & { primary: boolean; primaryKind?: string })[];
};

/** Consecutive sections of the same origin, as one entry each. */
export function groupByOrigin(sections: Section[]): OriginSources[] {
  const groups: OriginSources[] = [];
  for (const section of sections) {
    const origin = section.origin ?? section.source.url;
    const entry = {
      ...section.source,
      primary: section.primary ?? false,
      ...(section.primaryKind !== undefined ? { primaryKind: section.primaryKind } : {}),
    };
    const last = groups[groups.length - 1];
    if (last && last.origin === origin) last.sections.push(entry);
    else groups.push({ origin, sections: [entry] });
  }
  return groups;
}

/** One 信頼度 request: the sentence and origins holding their sections. */
export type JEVRequest = {
  state: {
    claim: { original: string };
    /** Origins holding their sections (ADR-0016). */
    sources: OriginSources[];
  };
  /** Which of the given sections `state.sources` holds, in the same order. */
  sections: number[];
  questions: Record<string, JEVQuestion>;
};

/**
 * The 信頼度 question, with only the sections JEV judged to speak to the
 * sentence as `sources`. With none, it is still asked with `sources` empty —
 * the same as a sentence nothing was found for. Spread over more than one
 * request only when the sections would go over JEV's limit (ADR-0014).
 */
export function planSupportRequests(params: {
  original: string;
  sections: Section[];
  stateBudget?: number;
  requestBudget?: number;
}): JEVRequest[] {
  const {
    original,
    sections,
    stateBudget = STATE_TOKEN_BUDGET,
    requestBudget = REQUEST_TOKEN_BUDGET,
  } = params;
  const fixed: Record<string, JEVQuestion> = { support: SUPPORT_QUESTION };

  const base = { claim: { original } };
  const cost = (value: unknown) => estimateTokens(JSON.stringify(value));
  const questionCost = cost(SUPPORT_QUESTION);
  const baseCost = cost({ ...base, sources: [] });

  const requests: JEVRequest[] = [];
  let current: number[] = [];
  let used = 0;

  const flush = () => {
    const chosen = current.map((i) => sections[i]);
    requests.push({
      state: { ...base, sources: groupByOrigin(chosen) },
      sections: current,
      questions: { ...fixed },
    });
    current = [];
    used = 0;
  };

  sections.forEach((section, index) => {
    // What the section adds: its origin's entry is counted with every
    // section, and a separator's worth on top. Too high only splits a
    // request that would have fitted.
    const size = cost(groupByOrigin([section])[0]) + 1;
    if (baseCost + size + questionCost > stateBudget) {
      throw new Error(
        `資料の1節が、JEVの入力上限（状態と最長の問いで32kトークン）に収まりません（見積もり ${baseCost + size + questionCost}）。`
      );
    }
    const fits =
      baseCost + used + size + questionCost <= stateBudget &&
      baseCost + used + size + questionCost <= requestBudget;
    if (!fits && current.length > 0) flush();
    current.push(index);
    used += size;
  });

  if (current.length > 0 || requests.length === 0) flush();
  return requests;
}
