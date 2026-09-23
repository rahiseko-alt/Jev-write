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

/**
 * At or above this, the answer is acted on. Raised deliberately: on a
 * checked article the correct sentences came back at 92% and above while
 * every planted falsehood sat below 90%, so the line is drawn where that
 * separation is. `JEV_ACT_THRESHOLD` moves it without a code change.
 */
export const ACT_THRESHOLD = readThreshold("JEV_ACT_THRESHOLD", 0.9);

/** At or above this, the answer is shown but not acted on. Below it, a person decides. */
export const CAUTION_THRESHOLD = readThreshold("JEV_CAUTION_THRESHOLD", 0.5);

/**
 * At or below this 信頼度, a sentence gets a ▶ (ADR-0011: the user's line).
 * The 信頼度 is JEV's own probability that the sentence is backed by the
 * sources it was given. `NEXT_PUBLIC_JEV_FLAG_THRESHOLD` moves it without a
 * code change. It is a public variable because the marks are drawn in the
 * browser, and Next.js carries only variables named that way — written out
 * in full, as here — into the browser's code; a change takes effect on the
 * next deployment.
 */
export const FLAG_THRESHOLD = thresholdOf(process.env.NEXT_PUBLIC_JEV_FLAG_THRESHOLD, 0.8);

/**
 * Whether a 信頼度 (0–1) is low enough to point the reader at it. Compared as
 * the whole percentage the reader sees, so a sentence shown at 80% is marked.
 */
export function isFlagged(confidence: number): boolean {
  return Math.round(confidence * 100) <= Math.round(FLAG_THRESHOLD * 100);
}

/** A threshold from the environment, or the default when it is absent or unusable. */
function readThreshold(name: string, fallback: number): number {
  return thresholdOf(process.env[name], fallback);
}

function thresholdOf(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 && value <= 1 ? value : fallback;
}

export function bandOf(confidence: number): ConfidenceBand {
  if (confidence >= ACT_THRESHOLD) return "act";
  if (confidence >= CAUTION_THRESHOLD) return "caution";
  return "review";
}

/** What the band is called on screen. Plain Japanese: the reader is not an engineer. */
export const BAND_LABEL: Record<ConfidenceBand, string> = {
  act: `確信あり（${pct(ACT_THRESHOLD)}%以上）`,
  caution: `要確認（${pct(CAUTION_THRESHOLD)}〜${pct(ACT_THRESHOLD)}%）`,
  review: `人が見てください（${pct(CAUTION_THRESHOLD)}%未満）`,
};

function pct(ratio: number): number {
  return Math.round(ratio * 100);
}
