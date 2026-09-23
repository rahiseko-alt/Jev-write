import type { JEVAnswer, JEVQuestion } from "@/lib/providers";
import { StatedValue, compareValues, findValues, sameKind } from "./stated-values";

/**
 * Checking the dates and amounts a sentence states against what the pages
 * say, with each part done by what does it well
 * (docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook,
 * docs.typesafe.ai/model-jaggedness/jev-1.13):
 *
 * - code finds the values in the sentence, and the candidate values of the
 *   same kind in each page, by pattern;
 * - JEV picks which candidate is the page's value for the matter the
 *   sentence's value is about, or none;
 * - code compares the pick with the sentence's value.
 *
 * JEV is never asked whether two dates or numbers are equal: it reads them
 * as text, and that is how a sentence one year off came back 88% backed by
 * seven pages that all said otherwise.
 */

/** The way out on every pick: nothing on the page is the value asked about. */
export const NONE = "none";

/** A Choice takes at most 255 options (docs.typesafe.ai/primitives/choice); one is NONE. */
export const MAX_CANDIDATES = 254;

/** What the sentence states, found by pattern in the sentence as written. */
export function statedValues(original: string): StatedValue[] {
  return findValues(original);
}

function kindWord(value: StatedValue): string {
  return value.kind === "date" ? "日付" : "数値";
}

function questionName(k: number, index: number): string {
  return `value${k}_${index}`;
}

/**
 * The spans in a page's text that could stand for the stated value: every
 * value of the same kind, as written, in the order they appear. Only JEV's
 * option limit bounds them.
 */
export function candidatesFor(stated: StatedValue, text: string): string[] {
  return findValues(text)
    .filter((found) => sameKind(stated, found))
    .map((found) => found.span)
    .slice(0, MAX_CANDIDATES);
}

/**
 * The pick: which of the page's values is the one for the same matter.
 * Whether it equals the sentence's value is not asked — that is code's.
 */
export function valueQuestion(stated: StatedValue, candidates: string[], index: number): JEVQuestion {
  const word = kindWord(stated);
  const criteria: Record<string, string | null> = {};
  for (const span of candidates) criteria[span] = null;
  criteria[NONE] = `sources[${index}] には、その事柄についての${word}が書かれていない（別の事柄の${word}しかない）`;

  return {
    type: "choice",
    instructions:
      `claim.original は「${stated.span}」という${word}で、ある事柄（いつ起きたか・いくつか等）を述べている。` +
      `sources[${index}] の本文で、その同じ事柄について書かれている${word}はどれか。` +
      `claim.original と同じ値かどうかは問わない。`,
    criteria,
  };
}

/**
 * Every pick to ask of one entry of `sources`, named so the answers can be
 * found again. A value with no candidate on the page asks nothing: there is
 * nothing to choose from.
 */
export function valueQuestionsFor(
  stated: StatedValue[],
  text: string,
  index: number
): Record<string, JEVQuestion> {
  const questions: Record<string, JEVQuestion> = {};
  stated.forEach((value, k) => {
    const candidates = candidatesFor(value, text);
    if (candidates.length > 0) questions[questionName(k, index)] = valueQuestion(value, candidates, index);
  });
  return questions;
}

/** A page's value that differs from the sentence's, as the page writes it. */
export type ValueConflict = {
  /** The sentence's value, as written in the article. */
  stated: string;
  /** The page's value for the same matter, as written on the page. */
  found: string;
  /** Which page, in the order the pages were given. */
  page: number;
  /** How sure JEV was of its pick, as returned. */
  confidence: number;
};

/** One request's answers, and where each entry of its `sources` came from. */
export type AnsweredRequest = {
  pages: number[];
  questions: Record<string, JEVQuestion>;
  answers: Record<string, JEVAnswer>;
};

/**
 * The pages whose value for the matter differs from the sentence's.
 *
 * Per page and stated value, JEV's surest pick across the parts of the page
 * is taken, if it is sure enough to act on (ADR-0008); code then compares.
 * A pick that is NONE, not one of the options sent, or only partly
 * comparable (no shared year, month or day) is not a difference.
 */
export function readValueConflicts(
  stated: StatedValue[],
  replies: AnsweredRequest[],
  threshold: number
): ValueConflict[] {
  const best = new Map<string, { found: string; page: number; k: number; confidence: number }>();

  for (const reply of replies) {
    reply.pages.forEach((page, index) => {
      stated.forEach((_, k) => {
        const name = questionName(k, index);
        const question = reply.questions[name];
        const answer = reply.answers[name];
        if (!question || question.type !== "choice") return;
        if (!answer || answer.type !== "choice") return;
        if (answer.choice === NONE || !(answer.choice in question.criteria)) return;
        const confidence = answer.confidence ?? 0;
        if (confidence < threshold) return;
        const key = `${page}:${k}`;
        const previous = best.get(key);
        if (!previous || confidence > previous.confidence) {
          best.set(key, { found: answer.choice, page, k, confidence });
        }
      });
    });
  }

  const conflicts: ValueConflict[] = [];
  for (const pick of Array.from(best.values())) {
    const value = stated[pick.k];
    const found = findValues(pick.found).find((candidate) => candidate.span === pick.found);
    if (!found || compareValues(value, found) !== "different") continue;
    conflicts.push({ stated: value.span, found: pick.found, page: pick.page, confidence: pick.confidence });
  }
  return conflicts.sort((a, b) => a.page - b.page);
}
