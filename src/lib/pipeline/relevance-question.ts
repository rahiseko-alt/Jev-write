import type { Claim } from "@/types";
import type { JEVQuestion } from "@/lib/providers";
import {
  REQUEST_TOKEN_BUDGET,
  STATE_TOKEN_BUDGET,
  SourcePage,
  estimateTokens,
} from "./support-question";

/**
 * The relevance question (ADR-0021): does this section speak to the point
 * the claim makes — its own aspect, not merely the article's broad subject?
 *
 * In a one-subject article (ふるさと納税) every page is about the same thing
 * as every claim, so "is it about the same thing" passes everything (#84:
 * 0 of 50 pages dropped). The question is instead about the claim's aspect,
 * as ② named it for the claim: what it is about and the kind of fact
 * (ADR-0019), e.g. 「ワンストップ特例」の「時期・開始年・施行日・期間」.
 *
 * One Noul, one judgment, with criteria for the boundary:
 *  - yes: the section says something about that aspect, agreeing with the
 *    claim or contradicting it — a contradicting section is kept, never
 *    dropped here (ADR-0016);
 *  - no: the section is on the same broad subject but only on other points,
 *    or on a different target with a similar name.
 *
 * JEV answers it; this side only compares the number with the line
 * (RELEVANCE_THRESHOLD). No word of the claim is matched against the section
 * in code.
 *
 * The state is the section alone. The claim goes into the question's
 * structured instructions, so one request asks every claim about the same
 * section, one question each (docs.typesafe.ai/primitives/noul, "Structured
 * instructions"; ADR-0007: questions on one state are not split up).
 *
 * The wording is English, the data (the claim, the aspect, the section) as
 * written: English is where JEV is most accurate (docs.typesafe.ai/models,
 * "Language support"), and the question is sent once per claim in every
 * request, so its length is paid many times over.
 */
export const RELEVANCE_WORDING = {
  withAspect: {
    question: "Does `section` state anything about `aspect`, the point that `claim` makes?",
    true: "`section` states something about `aspect` for the same target as `claim`, whether it agrees with `claim` or contradicts it.",
    false:
      "`section` states nothing about `aspect`: it covers only other points of the same broad subject, or a different target with a similar name.",
  },
  // When ② wrote nothing for the claim and extraction named no subject.
  withoutAspect: {
    question: "Does `section` state anything about the point that `claim` makes?",
    true: "`section` states something about that point for the same target as `claim`, whether it agrees with `claim` or contradicts it.",
    false:
      "`section` states nothing about that point: it covers only other points of the same broad subject, or a different target with a similar name.",
  },
} as const;

/**
 * The kinds of fact ② sorts every claim into (ADR-0019), in the words its
 * instruction gives for each (search-queries.ts KINDS).
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
 * The claim's aspect as the question names it: 「about」の「kind」. ② named
 * both for the claim; when it did not, what extraction named the subject
 * stands for `about`. A kind ② wrote outside its list is used as written.
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

/** A claim's question, built once and reused for every section. */
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
  /** Its estimated size, for keeping to JEV's rate limit. */
  tokens: number;
}

/**
 * The requests that ask every given claim about one section: normally one.
 * More only when the questions together would go over JEV's input limit
 * (docs.typesafe.ai/models: 64k per request, 32k for the state plus the
 * longest question); then the claims are split, in order, over requests with
 * the same state. Nothing of the section is cut.
 */
export function planRelevanceRequests(
  section: SourcePage,
  targets: PreparedTarget[],
  budgets: { state?: number; request?: number } = {}
): RelevanceRequest[] {
  const stateBudget = budgets.state ?? STATE_TOKEN_BUDGET;
  const requestBudget = budgets.request ?? REQUEST_TOKEN_BUDGET;
  const state = relevanceState(section);
  const stateCost = cost(state);

  const requests: RelevanceRequest[] = [];
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
      throw new Error(
        `資料の1節と関連の問いが、JEVの入力上限（状態と最長の問いで32kトークン）に収まりません（見積もり ${stateCost + target.tokens}）。`
      );
    }
    if (keys.length > 0 && stateCost + asked + target.tokens > requestBudget) flush();
    questions[target.key] = target.question;
    keys.push(target.key);
    asked += target.tokens;
  }
  flush();
  return requests;
}
