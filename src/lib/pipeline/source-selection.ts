import type { JEVAnswer, JEVQuestion } from "@/lib/providers";
import { PAGE_RELEVANCE_THRESHOLD } from "@/lib/jev/bands";
import {
  REQUEST_TOKEN_BUDGET,
  STATE_TOKEN_BUDGET,
  SourcePage,
  estimateTokens,
  splitSections,
  takeWithinBudget,
} from "./support-question";

/**
 * Which pages, and which parts of them, reach the 信頼度 question (ADR-0018).
 *
 * JEV judges every candidate; the code here only routes by its answers. The
 * judgement is made in stages, from cheap to thorough, the way the official
 * patterns do it (docs.typesafe.ai/patterns/fan-out; cookbooks/
 * skill_suggestion reads every candidate briefly, then the survivors in full):
 *
 *  1. Page stage. Every page in the pool, one request each. Its title,
 *     address and search excerpts are the state, and every claim is asked
 *     whether the page is about what the claim is about.
 *  2. Section stage. The pages JEV did not rule out for a claim, cut into
 *     sections with nothing cut away; one request per section, asking the
 *     same of each claim that kept the page.
 *  3. The sections judged to be about the claim's target go to the 信頼度
 *     question, which is not changed (support-question.ts, ADR-0011).
 *
 * Each request holds one page or one section and nothing else, so what JEV
 * says of a page and a claim does not depend on what else was found
 * (docs.typesafe.ai/model-jaggedness: a large state full of irrelevant
 * detail costs accuracy). Each claim is its own question, carried in the
 * question's structured instructions (docs.typesafe.ai/primitives/noul,
 * "Structured instructions"): one judgment per question.
 */

/** Asking JEV: one state, named questions, the answers under the same names. */
export type Ask = (
  state: unknown,
  questions: Record<string, JEVQuestion>
) => Promise<Record<string, JEVAnswer>>;

/** A candidate: a page from the pool, or a claim's own fact-check review. */
export type Candidate = SourcePage & {
  /** Unique within the run: the page's address, or the review's own key. */
  key: string;
};

/**
 * What a yes and a no mean, at both stages. The one judgment is whether the
 * page or section is about the very thing the sentence is about. A name or an
 * abbreviation that merely looks alike is something else (SIPS the model of
 * consumer behaviour is not SIP the share plan), and a page that explains
 * only something else is not about it. Whether it agrees with the sentence is
 * not part of the question: a page that says otherwise is about the same
 * thing, and it is kept (ADR-0016: nothing contradicting is dropped).
 * No string of the sentence is matched against the page in code (ADR-0007).
 */
export const SAME_TARGET_CRITERIA = {
  true: "`claim` が述べている対象そのもの（同じ名前で、同じ分野のもの）について述べている。述べている内容が `claim` と同じか違うかは問わない。",
  false:
    "名前や略語が似ているだけの別の対象について述べている。または、別の対象だけを説明していて、`claim` が述べている対象には触れていない。",
};

/** The page stage's question. `page` is the state; `claim` is in the instructions. */
export const PAGE_QUESTION = "`page` は、`claim` が述べている対象について述べているか。";

/** The section stage's question. `section` is the state; `claim` is in the instructions. */
export const SECTION_QUESTION = "`section` は、`claim` が述べている対象について述べているか。";

/** The page stage's question about one sentence (the article's own words, ADR-0011). */
export function pageQuestion(claim: string): JEVQuestion {
  return {
    type: "noul",
    instructions: { claim, question: PAGE_QUESTION },
    criteria: { ...SAME_TARGET_CRITERIA },
  };
}

/** The section stage's question about one sentence. */
export function sectionQuestion(claim: string): JEVQuestion {
  return {
    type: "noul",
    instructions: { claim, question: SECTION_QUESTION },
    criteria: { ...SAME_TARGET_CRITERIA },
  };
}

/**
 * The ceiling on what one claim sends on to the section stage (ADR-0018):
 * eight requests' worth of state, 240,000 estimated tokens (some 160,000
 * Japanese characters, or twenty pages of 8,000). It applies only after the
 * page stage, to pages JEV judged to be about the claim's target, in the
 * claim's own order (its own searches, then the article's, then the rest,
 * each in the order the search ranked them), and what it keeps out is
 * counted and logged. It keeps the worst case of a run inside the
 * 300-second limit: without it, a sentence about something every page
 * mentions would send every page on, and its 信頼度 question would be spread
 * over dozens of requests.
 */
export const SECTION_STAGE_REQUESTS_PER_CLAIM = 8;
export const SECTION_STAGE_TOKEN_BUDGET = SECTION_STAGE_REQUESTS_PER_CLAIM * STATE_TOKEN_BUDGET;

/** One request of either stage. */
export type StageRequest = {
  /** The candidate whose page (page stage) or section (section stage) is the state. */
  candidate: string;
  /** Which of its sections, at the section stage. */
  section?: number;
  state: unknown;
  questions: Record<string, JEVQuestion>;
  /** The claim each question is about, by question id. */
  claims: Record<string, number>;
};

const cost = (value: unknown) => estimateTokens(JSON.stringify(value));

/** Code-unit order: the same on every run and every machine, whatever the locale. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byAddress<T>(items: T[], of: (item: T) => Candidate): T[] {
  return items
    .slice()
    .sort((a, b) => compare(of(a).url, of(b).url) || compare(of(a).key, of(b).key));
}

/**
 * The questions about one state, in as few requests as JEV's limits allow
 * (64k tokens for the state and every question; 32k for the state and the
 * longest one): normally one. Undefined when the state and a single question
 * would not fit even on their own.
 */
function packQuestions(
  state: unknown,
  entries: { claim: number; question: JEVQuestion }[]
): { questions: Record<string, JEVQuestion>; claims: Record<string, number> }[] | undefined {
  const stateCost = cost(state);
  const chunks: { questions: Record<string, JEVQuestion>; claims: Record<string, number> }[] = [];
  let questions: Record<string, JEVQuestion> = {};
  let claims: Record<string, number> = {};
  let used = stateCost;
  let count = 0;
  for (const { claim, question } of entries) {
    const size = cost(question);
    if (stateCost + size > STATE_TOKEN_BUDGET) return undefined;
    if (count > 0 && used + size > REQUEST_TOKEN_BUDGET) {
      chunks.push({ questions, claims });
      questions = {};
      claims = {};
      used = stateCost;
      count = 0;
    }
    const id = `c${claim}`;
    questions[id] = question;
    claims[id] = claim;
    used += size;
    count++;
  }
  if (count > 0) chunks.push({ questions, claims });
  return chunks;
}

/** A pool page as the page stage sees it: its title, its address, and what the searches said of it. */
export type ScreenedPage = Candidate & { excerpts: string[] };

/**
 * The page stage (ADR-0018 step 2): one request per page, with every claim
 * asked of it. The state is the page's title, address and search excerpts;
 * a page the searches gave no excerpt for shows its first section instead.
 * The pages go in address order, so the requests are the same, in the same
 * order, whatever order the searches returned the pages in. A page whose
 * state would not fit is not asked, and is listed so it can go on unscreened.
 */
export function planPageRequests(
  claims: string[],
  pages: ScreenedPage[]
): { requests: StageRequest[]; unaskable: string[] } {
  const requests: StageRequest[] = [];
  const unaskable: string[] = [];
  if (claims.length === 0) return { requests, unaskable };

  for (const page of byAddress(pages, (p) => p)) {
    const excerpts = page.excerpts.length > 0 ? page.excerpts : splitSections(page.text).slice(0, 1);
    const state = { page: { title: page.title, url: page.url, excerpts } };
    const chunks = packQuestions(
      state,
      claims.map((claim, index) => ({ claim: index, question: pageQuestion(claim) }))
    );
    if (!chunks) {
      unaskable.push(page.key);
      continue;
    }
    for (const chunk of chunks) requests.push({ candidate: page.key, state, ...chunk });
  }
  return { requests, unaskable };
}

/** A candidate going on to the section stage, its sections, and the claims that kept it. */
export type SectionItem = { candidate: Candidate; sections: string[]; claims: number[] };

/**
 * The section stage (ADR-0018 step 5): one request per section, asking each
 * claim that kept the page. The state is the section with its page's title
 * and address. Candidates go in address order, sections in reading order.
 */
export function planSectionRequests(
  claims: string[],
  items: SectionItem[]
): { requests: StageRequest[]; unaskable: { candidate: string; section: number; claims: number[] }[] } {
  const requests: StageRequest[] = [];
  const unaskable: { candidate: string; section: number; claims: number[] }[] = [];

  for (const item of byAddress(items, (i) => i.candidate)) {
    item.sections.forEach((text, section) => {
      const state = { section: { title: item.candidate.title, url: item.candidate.url, text } };
      const chunks = packQuestions(
        state,
        item.claims.map((claim) => ({ claim, question: sectionQuestion(claims[claim]) }))
      );
      if (!chunks) {
        unaskable.push({ candidate: item.candidate.key, section, claims: item.claims });
        return;
      }
      for (const chunk of chunks) {
        requests.push({ candidate: item.candidate.key, section, state, ...chunk });
      }
    });
  }
  return { requests, unaskable };
}

/** What became of one claim's candidates at the page stage and at the budget. */
export type Routed = {
  /** Going on to the section stage, in the claim's order. */
  taken: Candidate[];
  /** Judged at the page stage to be about something else. */
  offTarget: Candidate[];
  /** Not judged at the page stage (the request failed or could not be made), and gone on unscreened. */
  unscreened: Candidate[];
  /** Kept by the page stage, but over the section stage's budget, in the claim's order. */
  overCap: Candidate[];
};

/**
 * One claim's candidates after the page stage (ADR-0018 steps 3–4). A page
 * goes on if JEV's answer is at or above the line, or if there is no answer:
 * not screened is not ruled out, and nothing is dropped that JEV did not
 * rule out. Then, in the claim's own order, as many as the budget holds. The
 * claim's own fact-check reviews come first; they were matched to the claim
 * by JEV when they were looked up, and skip the page stage.
 */
export function routeClaim(params: {
  own: Candidate[];
  /** The pool's pages, in the claim's order (ADR-0016 step 1). */
  pool: Candidate[];
  answerOf: (candidate: Candidate) => number | undefined;
  threshold?: number;
  budget?: number;
}): Routed {
  const {
    own,
    pool,
    answerOf,
    threshold = PAGE_RELEVANCE_THRESHOLD,
    budget = SECTION_STAGE_TOKEN_BUDGET,
  } = params;
  const onward: Candidate[] = [...own];
  const offTarget: Candidate[] = [];
  const unscreened: Candidate[] = [];
  for (const candidate of pool) {
    const answer = answerOf(candidate);
    if (answer === undefined) {
      unscreened.push(candidate);
      onward.push(candidate);
    } else if (answer >= threshold) {
      onward.push(candidate);
    } else {
      offTarget.push(candidate);
    }
  }
  const { taken, overCap } = takeWithinBudget(onward, budget);
  return { taken, offTarget, unscreened, overCap };
}

/** A noul answer's value, or undefined when none came back for the question. */
function noulOf(answer: JEVAnswer | undefined): number | undefined {
  return answer && answer.type === "noul" && typeof answer.noul === "number" ? answer.noul : undefined;
}

/** Every request, all at once (JEV's client keeps to its own limit), each settled on its own. */
function askAll(
  requests: StageRequest[],
  ask: Ask
): Promise<({ answers: Record<string, JEVAnswer> } | { error: unknown })[]> {
  return Promise.all(
    requests.map((request) =>
      ask(request.state, request.questions).then(
        (answers) => ({ answers: answers ?? {} }),
        (error: unknown) => ({ error })
      )
    )
  );
}

/** The page stage's answers: by candidate, then by claim. */
export type PageAnswers = {
  answerOf(candidate: string, claim: number): number | undefined;
  /** Requests that got no answer, after JEV's client had retried them. */
  failures: unknown[];
  /** Pages too large to ask about at all. */
  unaskable: string[];
};

/** The page stage, run: every page, every claim. */
export async function screenPages(params: {
  claims: string[];
  pages: ScreenedPage[];
  ask: Ask;
}): Promise<PageAnswers> {
  const { requests, unaskable } = planPageRequests(params.claims, params.pages);
  const replies = await askAll(requests, params.ask);

  const answers = new Map<string, Map<number, number>>();
  const failures: unknown[] = [];
  replies.forEach((reply, r) => {
    const request = requests[r];
    if ("error" in reply) {
      failures.push(reply.error);
      return;
    }
    const byClaim = answers.get(request.candidate) ?? new Map<number, number>();
    for (const [id, claim] of Object.entries(request.claims)) {
      const value = noulOf(reply.answers[id]);
      if (value !== undefined) byClaim.set(claim, value);
    }
    answers.set(request.candidate, byClaim);
  });

  return {
    answerOf: (candidate, claim) => answers.get(candidate)?.get(claim),
    failures,
    unaskable,
  };
}

/** One claim's material after both stages. */
export type Selection = Routed & {
  /** What was asked at the section stage, in the claim's order, each section with JEV's answer. */
  asked: { candidate: Candidate; sections: { text: string; relevance: number }[] }[];
  /**
   * Why this claim's material could not be judged: a section-stage question
   * for it got no answer. The claim is then left unverified rather than
   * given a 信頼度 on material nobody judged (ADR-0003, ADR-0006).
   */
  failure?: unknown;
};

/**
 * The routing after the page stage, and the section stage, run (ADR-0018
 * steps 3–5). `candidates` is per claim, in claim order.
 */
export async function readSections(params: {
  claims: string[];
  candidates: { own: Candidate[]; pool: Candidate[] }[];
  screened: PageAnswers;
  ask: Ask;
  threshold?: number;
  budget?: number;
}): Promise<Selection[]> {
  const { claims, candidates, screened, ask } = params;

  const routed = candidates.map((claimCandidates, claim) =>
    routeClaim({
      ...claimCandidates,
      answerOf: (candidate) => screened.answerOf(candidate.key, claim),
      threshold: params.threshold,
      budget: params.budget,
    })
  );

  // Each candidate once, with every claim that kept it, in claim order.
  const items = new Map<string, SectionItem>();
  routed.forEach(({ taken }, claim) => {
    for (const candidate of taken) {
      const item = items.get(candidate.key) ?? {
        candidate,
        sections: splitSections(candidate.text),
        claims: [],
      };
      item.claims.push(claim);
      items.set(candidate.key, item);
    }
  });

  const { requests, unaskable } = planSectionRequests(claims, [...items.values()]);
  const replies = await askAll(requests, ask);

  // JEV's answers: by candidate, then section, then claim.
  const relevance = new Map<string, Map<number, Map<number, number>>>();
  const answersAt = (candidate: string, section: number) => {
    const bySection = relevance.get(candidate) ?? new Map<number, Map<number, number>>();
    relevance.set(candidate, bySection);
    const byClaim = bySection.get(section) ?? new Map<number, number>();
    bySection.set(section, byClaim);
    return byClaim;
  };
  const failures = new Map<number, unknown>();

  for (const { claims: kept } of unaskable) {
    for (const claim of kept) {
      if (!failures.has(claim)) {
        failures.set(
          claim,
          new Error("資料の1節が、JEVの入力上限（状態と最長の問いで32kトークン）に収まりません。")
        );
      }
    }
  }
  replies.forEach((reply, r) => {
    const request = requests[r];
    const byClaim = answersAt(request.candidate, request.section ?? 0);
    for (const [id, claim] of Object.entries(request.claims)) {
      if ("error" in reply) {
        if (!failures.has(claim)) failures.set(claim, reply.error);
        continue;
      }
      const value = noulOf(reply.answers[id]);
      if (value !== undefined) byClaim.set(claim, value);
    }
  });

  return routed.map((route, claim) => {
    let failure = failures.get(claim);
    const asked = route.taken.map((candidate) => {
      const item = items.get(candidate.key)!;
      return {
        candidate,
        sections: item.sections.map((text, section) => {
          const value = relevance.get(candidate.key)?.get(section)?.get(claim);
          if (value === undefined && failure === undefined) {
            failure = new Error("JEVの答えに、問いの一部が欠けていました。");
          }
          return { text, relevance: value ?? 0 };
        }),
      };
    });
    return { ...route, asked, ...(failure !== undefined ? { failure } : {}) };
  });
}
