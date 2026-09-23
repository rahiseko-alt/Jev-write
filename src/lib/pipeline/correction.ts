import type { Claim } from "@/types";
import { Figure, figuresIn } from "@/lib/text/figures";

/**
 * What correction the Evidence justifies for a Claim — and nothing more.
 *
 * A correction is only offered where the Evidence states the same thing the
 * Claim does, about the same subject, with a different figure. Where that
 * cannot be shown, there is no correction: the Finding reports the conflict
 * and leaves the reader's wording alone. Guessing here writes one article's
 * facts into another's sentence.
 */

/** Only measurements are compared here: a year is not a figure of anything. */
function measurements(text: string): Figure[] {
  return figuresIn(text, { requireUnit: true });
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

  const inEvidence = measurements(evidenceText);
  if (inEvidence.length === 0) return undefined;

  let corrected = claimText;
  let changed = false;

  for (const figure of measurements(claimText)) {
    const match = counterpart(figure, inEvidence);
    if (!match || match.value === figure.value) continue;
    if (!corrected.includes(figure.text)) continue;
    corrected = corrected.replace(figure.text, match.text);
    changed = true;
  }

  return changed ? corrected : undefined;
}
