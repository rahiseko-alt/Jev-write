import type { Claim } from "@/types";
import type { JEVQuestion } from "@/lib/providers";
import {
  REQUEST_TOKEN_BUDGET,
  STATE_TOKEN_BUDGET,
  SourcePage,
  estimateTokens,
} from "./support-question";

/**
 * The relevance question (ADR-0022): does this section state a fact about
 * the point the claim makes — its aspect, not merely the article's subject?
 *
 * In a one-subject article (ふるさと納税) every page is about what every
 * claim is about, so "is it about the same target" passed everything (#84:
 * 50 of 50 pages kept). The aspect is what ② wrote for the claim: what it is
 * about and the kind of fact (ADR-0019), e.g. 「ワンストップ特例制度」の
 * 「時期・開始年・施行日・期間」. The claim's own sentence (claim.original,
 * never a paraphrase: ADR-0011) is given with it, as the point in question.
 *
 * One Noul, one judgment, the boundary in the criteria
 * (docs.typesafe.ai/primitives/noul, "Writing a Noul question"):
 *  - yes: the section states a fact about that aspect, agreeing with the
 *    claim or contradicting it — a contradicting section is kept, never
 *    dropped here (ADR-0016);
 *  - no: the section covers only other points of the same broad subject, or
 *    a different target with a similar name, or names the aspect only as a
 *    heading or a link.
 *
 * JEV answers it; this side only compares the number with the line
 * (RELEVANCE_THRESHOLD). No word of the claim is matched against the
 * section in code (ADR-0007).
 *
 * The state is the section alone. The claim goes into the question's
 * structured instructions, so one request asks every claim about the same
 * section, one question each (docs.typesafe.ai/primitives/noul, "Structured
 * instructions": one record per question over one state).
 *
 * The wording is English and the data (the sentence, the aspect, the
 * section) is as written: English is where JEV is most accurate
 * (docs.typesafe.ai/models, "Language support"), and the wording goes out
 * once per claim in every request, so its length is paid many times over.
 */
export const RELEVANCE_WORDING = {
  withAspect: {
    question: "Does `section` state a fact about `aspect`, the point that `claim` makes?",
    true: "`section` states a fact about `aspect` for the same target as `claim` (a figure, a date, a name, a condition, or how it works), whether it agrees with `claim` or contradicts it.",
    false:
      "`section` states nothing about `aspect`: it covers only other points of the same broad subject, or a different target with a similar name, or names `aspect` only as a heading or a link.",
  },
  // When ② wrote nothing for the claim and extraction named no subject.
  withoutAspect: {
    question: "Does `section` state a fact about the point that `claim` makes?",
    true: "`section` states a fact about that point for the same target as `claim` (a figure, a date, a name, a condition, or how it works), whether it agrees with `claim` or contradicts it.",
    false:
      "`section` states nothing about that point: it covers only other points of the same broad subject, or a different target with a similar name, or names that point only as a heading or a link.",
  },
} as const;

/**
 * The kinds of fact ② sorts every claim into (ADR-0019), in the words its
 * instruction gives for each (search-queries.ts, KINDS).
 */
export const KIND_WORDS: Readonly<Record<string, string>> = {
  definition: "定義・意味・区分",
  composition: "構成・要素・頭文字・段階",
  time: "時期・開始年・施行日・期間",
  quantity: "数・規模・金額・割合",
  scope: "範囲・対象・要件・所在地",
  degree: "程度・効果・順位",
  cause: "原因・理由・影響",
  origin: "提唱者・発表元・運営者",
};

/** What ② wrote about one claim: what it is about and the kind of fact (ADR-0019). */
export interface ClaimAspect {
  about?: string;
  kind?: string;
}

/**
 * The claim's aspect as the question names it: 「about」の「kind」. When ②
 * named no `about`, the subject extraction named stands for it. A kind ②
 * wrote outside its list is used as written. Undefined when there is
 * neither: the question then asks about the point of the sentence alone.
 */
export function aspectOf(claim: Claim, written?: ClaimAspect): string | undefined {
  const about = (written?.about ?? "").trim() || (claim.subject ?? "").trim();
  const kind = (written?.kind ?? "").trim();
  const words = kind ? KIND_WORDS[kind.toLowerCase()] ?? kind : "";
  if (about && words) return `「${about}」の「${words}」`;
  if (about) return `「${about}」`;
  if (words) return `「${words}」`;
  return undefined;
}

/** One claim as the relevance question asks about it. */
export interface RelevanceTarget {
  /** The question's name in the request: the claim's id. Not sent to the model. */
  key: string;
  /** The sentence as the article has it (claim.original, ADR-0011). */
  original: string;
  aspect?: string;
}

/** The relevance question for one claim. */
export function relevanceQuestion(target: Pick<RelevanceTarget, "original" | "aspect">): JEVQuestion {
  const wording = target.aspect ? RELEVANCE_WORDING.withAspect : RELEVANCE_WORDING.withoutAspect;
  return {
    type: "noul",
    instructions: {
      claim: target.original,
      ...(target.aspect ? { aspect: target.aspect } : {}),
      question: wording.question,
    },
    criteria: { true: wording.true, false: wording.false },
  };
}

/** The state of a relevance request: the one section, with its page's title and address. */
export function relevanceState(section: SourcePage): { section: SourcePage } {
  return { section: { title: section.title, url: section.url, text: section.text } };
}

/** A claim's question, built once and asked of every section. */
export interface PreparedTarget {
  key: string;
  question: JEVQuestion;
  /** The question's estimated size, its name included. */
  tokens: number;
}

const cost = (value: unknown) => estimateTokens(JSON.stringify(value));

/** Every claim's question, built once: the same for every section it is asked of. */
export function prepareTargets(targets: RelevanceTarget[]): PreparedTarget[] {
  return targets.map((target) => {
    const question = relevanceQuestion(target);
    return { key: target.key, question, tokens: cost({ [target.key]: question }) };
  });
}

/** One relevance request: one section, a question per claim. */
export interface RelevanceRequest {
  state: { section: SourcePage };
  questions: Record<string, JEVQuestion>;
  /** The claims it asks about, by key, in order. */
  keys: string[];
  /** Its estimated size, state and questions, for keeping to JEV's rate limit. */
  tokens: number;
}

/**
 * The requests that ask the given claims about one section: normally one.
 * More only when the questions together would go over JEV's input limit
 * (docs.typesafe.ai/models: 64k per request, 32k for the state plus the
 * longest question); then the claims are split, in order, over requests
 * with the same state. Nothing of the section is cut. A claim whose question
 * cannot go with this section at all (the two over 32k) is listed as
 * `unaskable` rather than dropped without a word.
 */
export function planRelevanceRequests(
  section: SourcePage,
  targets: PreparedTarget[],
  budgets: { state?: number; request?: number } = {}
): { requests: RelevanceRequest[]; unaskable: string[] } {
  const stateBudget = budgets.state ?? STATE_TOKEN_BUDGET;
  const requestBudget = budgets.request ?? REQUEST_TOKEN_BUDGET;
  const state = relevanceState(section);
  const stateCost = cost(state);

  const requests: RelevanceRequest[] = [];
  const unaskable: string[] = [];
  let questions: Record<string, JEVQuestion> = {};
  let keys: string[] = [];
  let asked = 0;
  const flush = () => {
    if (keys.length === 0) return;
    requests.push({ state, questions, keys, tokens: stateCost + asked });
    questions = {};
    keys = [];
    asked = 0;
  };

  for (const target of targets) {
    if (stateCost + target.tokens > stateBudget) {
      unaskable.push(target.key);
      continue;
    }
    if (keys.length > 0 && stateCost + asked + target.tokens > requestBudget) flush();
    questions[target.key] = target.question;
    keys.push(target.key);
    asked += target.tokens;
  }
  flush();
  return { requests, unaskable };
}
