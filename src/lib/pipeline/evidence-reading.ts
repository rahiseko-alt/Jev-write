/**
 * What the collected Evidence adds up to, before any wording is chosen.
 *
 * Kept apart from the pipeline so the rule can be read and tested on its own:
 * it is the rule that decides whether the reader is shown a conflict with the
 * record or a page to go and look at.
 */
export type EvidenceReading =
  | "supported"
  | "conflict"
  | "single-site-conflict"
  | "mixed"
  | "none";

/** How many different sites have to say otherwise before it is a conflict. */
export const CORROBORATING_SITES = 2;

export function readEvidence(counts: {
  supports: number;
  contradicts: number;
  /** Distinct sites among the pages that said otherwise. */
  contradictingSites: number;
}): EvidenceReading {
  const { supports, contradicts, contradictingSites } = counts;

  if (contradicts > 0 && supports > 0) return "mixed";
  if (contradicts > 0) {
    // One site, however many of its pages: a rental listing names the subject
    // a dozen times and still got a fact about it wrong, and two of its pages
    // agree because they are the same site.
    return contradictingSites >= CORROBORATING_SITES ? "conflict" : "single-site-conflict";
  }
  if (supports > 0) return "supported";
  return "none";
}
