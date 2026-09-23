/**
 * Reading the figures out of a sentence.
 *
 * One reader, used everywhere a figure is compared: the correction that is
 * offered, the rewrite that applies it and the check that decides whether the
 * rewrite kept to it must all see the same figures. Where they disagree — a
 * unit one of them knows and another does not, a decimal one of them splits
 * in two — an authorised correction looks like an invented one, and the
 * reader's rewrite is thrown away.
 */

/** A number, the unit it was written in, and the words that introduce it. */
export type Figure = {
  /** The figure exactly as it appears, unit included. */
  text: string;
  /** Where it starts in the text it was read from. */
  index: number;
  /** The number alone, without separators. */
  value: string;
  /** The unit, lower-cased, or "" for a bare number. */
  unit: string;
  /** The words immediately before it, which say what it is a figure of. */
  label: string;
};

/**
 * Units are matched longest-first, so "Gbps" is never read as "G" and "MB"
 * never as "M".
 */
const UNITS = [
  "Gbps",
  "mAh",
  "インチ",
  "fps",
  "GB",
  "TB",
  "MB",
  "MP",
  "Hz",
  "mm",
  "cm",
  "km",
  "kg",
  "ドル",
  "万",
  "億",
  "兆",
  "円",
  "人",
  "個",
  "倍",
  "%",
  "％",
  "g",
];

const NUMBER = "\\d[\\d,]*(?:\\.\\d+)?";
const LABEL_LENGTH = 12;

function pattern(requireUnit: boolean): RegExp {
  const unit = `(?:${UNITS.join("|")})`;
  return new RegExp(`(${NUMBER})\\s*(${unit})${requireUnit ? "" : "?"}`, "g");
}

/**
 * The words immediately before a figure. Without them there is no telling a
 * body price from a bundle price, so callers that compare figures across two
 * texts require them to match.
 */
export function labelBefore(text: string, at: number): string {
  const run = text.slice(Math.max(0, at - LABEL_LENGTH), at);
  const words = run.match(/[^\s、。（）()「」『』:：,]+$/);
  return words ? words[0] : "";
}

/**
 * Every figure in a text, in the order it reads.
 *
 * With `requireUnit`, only figures carrying a unit are returned — a year or a
 * street number is not a measurement of anything.
 */
export function figuresIn(
  text: string,
  options: { requireUnit?: boolean } = {}
): Figure[] {
  const found: Figure[] = [];
  const regex = pattern(options.requireUnit === true);
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    found.push({
      text: match[0],
      index: match.index,
      value: match[1].replace(/,/g, ""),
      unit: (match[2] ?? "").toLowerCase(),
      label: labelBefore(text, match.index),
    });
  }

  return found;
}
