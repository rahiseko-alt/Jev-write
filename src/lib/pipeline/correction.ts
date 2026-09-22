import type { Claim } from "@/types";

/**
 * What correction the Evidence justifies for a Claim — and nothing more.
 *
 * A correction is only offered where the Evidence states the same thing the
 * Claim does, about the same subject, with a different figure. Where that
 * cannot be shown, there is no correction: the Finding reports the conflict
 * and leaves the reader's wording alone. Guessing here writes one article's
 * facts into another's sentence.
 */

/** A number with the unit it was written with, and the words that introduce it. */
type Figure = {
  text: string;
  value: string;
  unit: string;
  label: string;
};

const UNITS = [
  "円",
  "ドル",
  "人",
  "個",
  "倍",
  "%",
  "％",
  "mm",
  "cm",
  "kg",
  "g",
  "インチ",
  "Hz",
  "GB",
  "TB",
  "MB",
  "MP",
  "fps",
  "Gbps",
  "mAh",
];

const LABEL_LENGTH = 12;

function figurePattern(): RegExp {
  return new RegExp(`(\\d[\\d,.]*)\\s*(${UNITS.join("|")})`, "gi");
}

/** Every figure in a text, each carrying the words that precede it. */
function figuresIn(text: string): Figure[] {
  const found: Figure[] = [];
  const pattern = figurePattern();
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const start = match.index;
    found.push({
      text: match[0],
      value: match[1].replace(/,/g, ""),
      unit: match[2].toLowerCase(),
      label: labelBefore(text, start),
    });
  }

  return found;
}

/** The words immediately before a figure, which say what it is a figure of. */
function labelBefore(text: string, at: number): string {
  const run = text.slice(Math.max(0, at - LABEL_LENGTH), at);
  const words = run.match(/[^\s、。（）()「」『』:：,]+$/);
  return words ? words[0] : "";
}

/**
 * The Evidence's figure for the same thing: same unit, and introduced by the
 * same words. Without a shared label there is no way to tell a body price
 * from a bundle price, so nothing is claimed.
 */
function counterpart(figure: Figure, evidence: Figure[]): Figure | undefined {
  if (!figure.label) return undefined;
  return evidence.find(
    (candidate) => candidate.unit === figure.unit && candidate.label === figure.label
  );
}

/**
 * The claim rewritten with the Evidence's figures, or undefined when the
 * Evidence does not justify a rewrite.
 */
export function correctionFromEvidence(
  claim: Claim,
  evidenceText: string
): string | undefined {
  const claimText = claim.normalizedText || claim.originalText;
  if (!claimText || !evidenceText) return undefined;

  const inEvidence = figuresIn(evidenceText);
  if (inEvidence.length === 0) return undefined;

  let corrected = claimText;
  let changed = false;

  for (const figure of figuresIn(claimText)) {
    const match = counterpart(figure, inEvidence);
    if (!match || match.value === figure.value) continue;
    if (!corrected.includes(figure.text)) continue;
    corrected = corrected.replace(figure.text, match.text);
    changed = true;
  }

  return changed ? corrected : undefined;
}
