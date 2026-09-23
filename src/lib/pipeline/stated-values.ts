/**
 * Dates and amounts, found in text by pattern and compared in code.
 *
 * JEV reads dates and numbers as text: comparing them, counting and doing
 * arithmetic are its weak spots (docs.typesafe.ai/model-jaggedness/jev-1.13).
 * So the work is split the way the pre-parsed value extraction cookbook does
 * it: a pattern over-finds the candidate values, JEV picks which one plays the
 * role, and code compares the pick. This file is the two code halves — the
 * finding and the comparing. Nothing here decides what a value is about.
 *
 * The span of every value is the text exactly as written, so what the reader
 * is shown is what the page says.
 */

export type DateValue = {
  kind: "date";
  /** As written in the text. */
  span: string;
  year?: number;
  month?: number;
  day?: number;
};

export type AmountValue = {
  kind: "amount";
  /** As written in the text. */
  span: string;
  value: number;
  /** What is counted. Percentages and 割 share one unit, "%". */
  unit: string;
};

export type StatedValue = DateValue | AmountValue;

/** How two values compare, on what both of them state. */
export type Comparison = "same" | "different" | "unknown";

/**
 * Full-width digits and signs to their ASCII forms, one character for one,
 * so positions in the converted text are positions in the original.
 */
export function toHalfWidth(text: string): string {
  return text.replace(/[０-９％，．／－：]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
  );
}

const KANJI_DIGIT: Record<string, number> = {
  〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

/** "5", "十", "二十一", "元" (the first year of an era) to a number. */
function numberOf(token: string): number {
  if (token === "元") return 1;
  if (/^[0-9]+$/.test(token)) return Number(token);
  const ten = token.indexOf("十");
  if (ten >= 0) {
    const tens = ten === 0 ? 1 : KANJI_DIGIT[token.slice(0, ten)] ?? NaN;
    const ones = ten === token.length - 1 ? 0 : KANJI_DIGIT[token.slice(ten + 1)] ?? NaN;
    return tens * 10 + ones;
  }
  return Array.from(token).reduce((sum, ch) => sum * 10 + (KANJI_DIGIT[ch] ?? NaN), 0);
}

/** The Western year each era's first year falls in, less one. */
const ERA_BASE: Record<string, number> = { 令和: 2018, 平成: 1988, 昭和: 1925, 大正: 1911 };

const NUM = "(?:[0-9]{1,2}|[〇一二三四五六七八九十]{1,3})";
const ERA_YEAR = `(?:令和|平成|昭和|大正)\\s*(?:[0-9]{1,2}|[〇一二三四五六七八九十]{1,3}|元)\\s*年`;
const WEST_YEAR = "(?<![0-9])[0-9]{4}\\s*年";
const MONTH = `${NUM}\\s*月`;
const DAY = `${NUM}\\s*日`;

/**
 * A year with its month and day if they follow, a month and day with no year
 * (「10月1日」), or 2023/10/1. A month on its own is not taken: too many
 * sentences name one in passing.
 */
const DATE_PATTERN = new RegExp(
  [
    `(?:${ERA_YEAR}|${WEST_YEAR})(?:\\s*${MONTH}(?:\\s*${DAY})?)?`,
    `(?<![0-9])${MONTH}\\s*${DAY}`,
    "(?<![0-9])[0-9]{4}[/.\\-][0-9]{1,2}[/.\\-][0-9]{1,2}(?![0-9])",
  ].join("|"),
  "g"
);

function parseDate(span: string): DateValue | null {
  const text = toHalfWidth(span);
  const value: DateValue = { kind: "date", span };

  const slashed = text.match(/^([0-9]{4})[/.\-]([0-9]{1,2})[/.\-]([0-9]{1,2})$/);
  if (slashed) {
    value.year = Number(slashed[1]);
    value.month = Number(slashed[2]);
    value.day = Number(slashed[3]);
  } else {
    const era = text.match(/(令和|平成|昭和|大正)\s*([0-9]{1,2}|[〇一二三四五六七八九十]{1,3}|元)\s*年/);
    const west = text.match(/([0-9]{4})\s*年/);
    if (era) value.year = ERA_BASE[era[1]] + numberOf(era[2]);
    else if (west) value.year = Number(west[1]);
    const month = text.match(/([0-9]{1,2}|[〇一二三四五六七八九十]{1,3})\s*月/);
    const day = text.match(/([0-9]{1,2}|[〇一二三四五六七八九十]{1,3})\s*日/);
    if (month) value.month = numberOf(month[1]);
    if (day) value.day = numberOf(day[1]);
  }

  if (value.year !== undefined && !Number.isFinite(value.year)) return null;
  if (value.month !== undefined && !(value.month >= 1 && value.month <= 12)) return null;
  if (value.day !== undefined && !(value.day >= 1 && value.day <= 31)) return null;
  return value;
}

const NUMBER = "[0-9]+(?:,[0-9]{3})*(?:\\.[0-9]+)?";

/**
 * A number and what it counts: 15,000円, 1万5000円, 142人, 約6割, 5%, 3倍.
 * The unit is whatever follows — letters, or one character that is not a
 * kana particle, punctuation, or part of a date or time — so no list of
 * units has to be kept.
 */
const AMOUNT_PATTERN = new RegExp(
  `(?<![0-9.,])${NUMBER}(?:\\s*[兆億万千](?:${NUMBER})?)*\\s*([A-Za-z]+|%|[^\\s0-9A-Za-z\\u3041-\\u309f、。,.．，・:;!?！？()（）「」『』【】\\[\\]/\\-~〜～年月日時分秒])`,
  "g"
);

const MULTIPLIER: Record<string, number> = { 兆: 1e12, 億: 1e8, 万: 1e4, 千: 1e3 };

function parseAmount(span: string, unit: string): AmountValue | null {
  const text = toHalfWidth(span).slice(0, span.length - unit.length);
  let total = 0;
  const parts = text.matchAll(new RegExp(`(${NUMBER})\\s*([兆億万千])?`, "g"));
  for (const part of parts) {
    const n = Number(part[1].replace(/,/g, ""));
    total += part[2] ? n * MULTIPLIER[part[2]] : n;
  }
  if (!Number.isFinite(total)) return null;
  if (unit === "割") return { kind: "amount", span, value: total * 10, unit: "%" };
  return { kind: "amount", span, value: total, unit };
}

/**
 * Every date and amount in the text, in the order they appear, each span
 * once. Tuned to over-find: a value that is not the one asked about is for
 * JEV to pass over, and one that was never found can never be picked.
 */
export function findValues(text: string): StatedValue[] {
  const plain = toHalfWidth(text);
  const found: Array<{ at: number; value: StatedValue }> = [];
  const taken: Array<[number, number]> = [];

  for (const match of plain.matchAll(DATE_PATTERN)) {
    const at = match.index ?? 0;
    const span = text.slice(at, at + match[0].length);
    const value = parseDate(span);
    if (!value) continue;
    found.push({ at, value });
    taken.push([at, at + span.length]);
  }

  for (const match of plain.matchAll(AMOUNT_PATTERN)) {
    const at = match.index ?? 0;
    const end = at + match[0].length;
    if (taken.some(([from, to]) => at < to && end > from)) continue;
    const span = text.slice(at, end);
    // The unit as converted, so ％ and % are one unit.
    const value = parseAmount(span, match[1]);
    if (value) found.push({ at, value });
  }

  const seen = new Set<string>();
  return found
    .sort((a, b) => a.at - b.at)
    .map((item) => item.value)
    .filter((value) => {
      if (seen.has(value.span)) return false;
      seen.add(value.span);
      return true;
    });
}

/** Whether a found value is the same sort of thing as a stated one, so it can stand for it. */
export function sameKind(stated: StatedValue, found: StatedValue): boolean {
  if (stated.kind === "date" || found.kind === "date") return stated.kind === found.kind;
  return stated.unit === found.unit;
}

/**
 * Compare on what both values state. 「10月1日」 against 2023年10月1日 is
 * the same day as far as either says; a year on one side only is not a
 * difference. Values with nothing in common to compare are "unknown".
 */
export function compareValues(stated: StatedValue, found: StatedValue): Comparison {
  if (!sameKind(stated, found)) return "unknown";

  if (stated.kind === "amount" && found.kind === "amount") {
    return Math.abs(stated.value - found.value) < 1e-9 ? "same" : "different";
  }

  if (stated.kind === "date" && found.kind === "date") {
    let shared = 0;
    for (const part of ["year", "month", "day"] as const) {
      const a = stated[part];
      const b = found[part];
      if (a === undefined || b === undefined) continue;
      if (a !== b) return "different";
      shared++;
    }
    return shared > 0 ? "same" : "unknown";
  }

  return "unknown";
}
