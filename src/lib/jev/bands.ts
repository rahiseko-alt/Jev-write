/**
 * The three bands of ADR-0008. JEV returns a confidence with every judgement;
 * where the line falls decides whether the answer is acted on, shown as
 * something to look at, or handed to a person. The numbers themselves are
 * never hidden from the reader: the band is a label on top of the number,
 * not a replacement for it.
 *
 * The bands follow docs.typesafe.ai/confidence.
 */
export type ConfidenceBand = "act" | "caution" | "review";

/** At or above this, the answer is acted on. */
export const ACT_THRESHOLD = 0.8;

/** At or above this, the answer is shown but not acted on. Below it, a person decides. */
export const CAUTION_THRESHOLD = 0.5;

export function bandOf(confidence: number): ConfidenceBand {
  if (confidence >= ACT_THRESHOLD) return "act";
  if (confidence >= CAUTION_THRESHOLD) return "caution";
  return "review";
}

/** What the band is called on screen. Plain Japanese: the reader is not an engineer. */
export const BAND_LABEL: Record<ConfidenceBand, string> = {
  act: "確信あり（80%以上）",
  caution: "要確認（50〜80%）",
  review: "人が見てください（50%未満）",
};
