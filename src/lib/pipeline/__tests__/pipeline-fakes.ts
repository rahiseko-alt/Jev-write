import type { Claim } from "@/types";
import type { JEVAnswer, JEVQuestion } from "@/lib/providers";

/**
 * Stand-ins for the outside services, for the pipeline's tests: the searches
 * and pages are given, and JEV answers as each test says it would, stage by
 * stage (ADR-0018). Every request JEV is sent is recorded, in the order sent.
 */

export const ARTICLE = "前置きの一文。フリノバの会員は9月に142人に到達した。結びの一文。";

export const CLAIM: Claim = {
  id: "c1",
  originalText: "フリノバの会員は9月に142人に到達した。",
  // A paraphrase: never what JEV is asked about.
  normalizedText: "フリノバの会員数は2025年9月時点で142人である。",
  subject: "フリノバ",
  entities: ["フリノバ"],
  importance: "normal",
  factCheckRequired: true,
};

export function claimNamed(id: string, originalText: string): Claim {
  return { ...CLAIM, id, originalText, normalizedText: originalText };
}

/** A page as the searches find it: its excerpt is what the search result says of it. */
export type Page = { url: string; title: string; body: string; excerpt?: string };

export type Call = { state: any; questions: Record<string, JEVQuestion> };

/** How JEV answers, stage by stage. Anything not given is a yes (0.9); the 信頼度 defaults to 0.5. */
export type Judge = {
  /** The page stage: the page as shown to JEV, and the sentence asked about. */
  page?: (page: { title: string; url: string; excerpts: string[] }, sentence: string) => number;
  /** The section stage: the section as shown to JEV, and the sentence asked about. */
  section?: (section: { title: string; url: string; text: string }, sentence: string) => number;
  /** The 信頼度 question. */
  support?: number | ((call: Call) => number);
  /** Requests JEV fails on, after its client's retries. */
  fails?: (call: Call) => boolean;
};

export const pageCalls = (calls: Call[]) => calls.filter((call) => call.state && "page" in call.state);
export const sectionCalls = (calls: Call[]) => calls.filter((call) => call.state && "section" in call.state);
export const supportCalls = (calls: Call[]) => calls.filter((call) => "support" in call.questions);

/** The addresses of the sections in a 信頼度 question, origin by origin. */
export const sentUrls = (call: Call): string[] =>
  call.state.sources.flatMap((origin: any) => origin.sections.map((s: any) => s.url));

/** The sentence each question of a stage request asks about, by question id. */
export const askedSentences = (call: Call): string[] =>
  Object.values(call.questions).map((question: any) => question.instructions.claim);

export function fakes(
  pages: Page[] | ((query: string) => Page[]),
  judge: Judge,
  options: {
    claims?: Claim[];
    claimQueries?: (claim: Claim) => string[];
    documentQueries?: string[];
  } = {}
) {
  const calls: Call[] = [];
  const claims = options.claims ?? [CLAIM];
  const pagesFor = typeof pages === "function" ? pages : () => pages;
  const known = new Map<string, Page>();

  const llm = {
    async extractClaims() {
      return claims;
    },
    async generateClaimQueries(asked: Claim[]) {
      return new Map(
        asked.map((c) => [c.id, options.claimQueries ? options.claimQueries(c) : ["フリノバ 会員数"]])
      );
    },
    async generateDocumentQueries() {
      return options.documentQueries ?? ["フリノバ"];
    },
  };
  const factCheck = {
    async searchClaims() {
      return { claims: [] };
    },
    async search() {
      return [];
    },
  } as any;
  const search = {
    async search(query: string) {
      const found = pagesFor(query);
      for (const page of found) known.set(page.url, page);
      return {
        results: found.map((p) => ({ url: p.url, title: p.title, content: p.excerpt ?? "" })),
      };
    },
  } as any;
  const fetchProvider = {
    async fetchUrl(url: string) {
      const page = known.get(url);
      return { url, title: page?.title ?? "", content: page?.body ?? "" };
    },
  } as any;
  const jev = {
    async evaluateAtomicJudgment() {
      throw new Error("not used");
    },
    async ask(state: any, questions: Record<string, JEVQuestion>) {
      const call = { state, questions };
      calls.push(call);
      if (judge.fails?.(call)) throw new Error("JEV 503");
      const answers: Record<string, JEVAnswer> = {};
      for (const [name, question] of Object.entries(questions)) {
        const sentence = (question as any).instructions?.claim as string;
        let noul: number;
        if (name === "support") {
          noul = typeof judge.support === "function" ? judge.support(call) : judge.support ?? 0.5;
        } else if ("page" in state) {
          noul = (judge.page ?? (() => 0.9))(state.page, sentence);
        } else {
          noul = (judge.section ?? (() => 0.9))(state.section, sentence);
        }
        answers[name] = { type: "noul", noul };
      }
      return answers;
    },
  };

  return { options: { llm, factCheck, search, fetch: fetchProvider, jev }, calls };
}
