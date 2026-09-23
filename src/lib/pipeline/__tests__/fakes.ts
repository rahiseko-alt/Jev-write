import type { Claim } from "@/types";
import type { JEVAnswer, JEVQuestion } from "@/lib/providers";
import type { Clock } from "@/lib/pipeline/time-budget";

/**
 * A clock that moves only when told to: time stands still while anything can
 * still run, and jumps to the next timer only when everything is waiting for
 * one. A run driven by it takes the same course every time, whatever the
 * machine does.
 */
export class FakeClock implements Clock {
  private time: number;
  private seq = 0;
  private timers: { at: number; seq: number; resolve: () => void }[] = [];

  constructor(start = 0) {
    this.time = start;
  }

  now(): number {
    return this.time;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const timer = { at: this.time + Math.max(0, ms), seq: this.seq++, resolve };
      this.timers.push(timer);
      signal?.addEventListener(
        "abort",
        () => {
          const at = this.timers.indexOf(timer);
          if (at >= 0) this.timers.splice(at, 1);
          resolve();
        },
        { once: true }
      );
    });
  }

  /** Runs `work` to its end, moving the time on whenever everything waits for it. */
  async run<T>(work: Promise<T>): Promise<T> {
    let settled = false;
    work.then(
      () => (settled = true),
      () => (settled = true)
    );
    let idle = 0;
    while (!settled) {
      await drain();
      if (settled) break;
      if (this.timers.length === 0) {
        if (++idle > 50) throw new Error("FakeClock: the work waits on something other than the clock.");
        continue;
      }
      idle = 0;
      this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this.timers.shift()!;
      this.time = Math.max(this.time, next.at);
      next.resolve();
    }
    return work;
  }
}

/** Lets everything that can run now, run. */
async function drain(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
}

export type FakePage = { url: string; title: string; body: string };

/** One request JEV was sent: what, when, and with how long to answer. */
export type JevCall = {
  state: any;
  questions: Record<string, JEVQuestion>;
  at: number;
  timeoutMs?: number;
};

export const isRelevanceCall = (call: JevCall) => call.state && "section" in call.state;
export const isSupportCall = (call: JevCall) => "support" in call.questions;

/** The addresses of the sections in a 信頼度 question, origin by origin. */
export const sentUrls = (call: JevCall): string[] =>
  call.state.sources.flatMap((origin: any) => origin.sections.map((s: any) => s.url));

export function claimOf(id: string, over: Partial<Claim> = {}): Claim {
  return {
    id,
    originalText: `${id}の原文。`,
    normalizedText: `${id}の言い換え。`,
    subject: "ふるさと納税",
    entities: [],
    numbers: [],
    dates: [],
    importance: "normal",
    factCheckRequired: true,
    ...over,
  };
}

type Latency<T> = number | ((value: T) => number);
const wait = <T>(latency: Latency<T> | undefined, value: T) =>
  typeof latency === "function" ? latency(value) : latency ?? 0;

/**
 * Providers that answer from fixed data, taking the time they are told to on
 * the given clock. JEV answers with `answer`, which may throw.
 */
export function fakeProviders(params: {
  clock: Clock;
  claims: Claim[];
  /** The article's queries, as the generation wrote them. */
  documentQueries?: unknown[];
  /** Each claim's queries, as the generation wrote them. Default: one of its own, `<id> 一次資料`. */
  claimQueries?: Map<string, unknown>;
  /** What each search finds, in rank order. */
  results: (query: string) => FakePage[];
  answer: (call: JevCall) => Record<string, JEVAnswer>;
  latency?: {
    extraction?: number;
    documentQueries?: number;
    claimQueries?: number;
    search?: Latency<string>;
    fetch?: Latency<string>;
    jev?: Latency<JevCall>;
  };
}) {
  const { clock, claims, latency = {} } = params;
  const calls: JevCall[] = [];
  const searched: string[] = [];
  const known = new Map<string, FakePage>();

  const pause = async (ms: number) => {
    if (ms > 0) await clock.sleep(ms);
  };

  const llm = {
    async extractClaims() {
      await pause(latency.extraction ?? 0);
      return claims;
    },
    async generateDocumentQueries() {
      await pause(latency.documentQueries ?? 0);
      return params.documentQueries ?? [];
    },
    async generateClaimQueries(asked: Claim[]) {
      await pause(latency.claimQueries ?? 0);
      return (
        params.claimQueries ?? new Map(asked.map((claim) => [claim.id, [`${claim.id} 一次資料`]]))
      );
    },
  };
  const search = {
    async search(query: string) {
      searched.push(query);
      await pause(wait(latency.search, query));
      const pages = params.results(query);
      for (const page of pages) known.set(page.url, page);
      return { results: pages.map((page) => ({ url: page.url, title: page.title })) };
    },
  };
  const fetchProvider = {
    async fetchUrl(url: string) {
      await pause(wait(latency.fetch, url));
      const page = known.get(url);
      return { url, title: page?.title ?? "", content: page?.body ?? "" };
    },
  };
  const factCheck = {
    async searchClaims() {
      return { claims: [] };
    },
    async search() {
      return [];
    },
  };
  const jev = {
    async evaluateAtomicJudgment(): Promise<never> {
      throw new Error("not used");
    },
    async ask(state: unknown, questions: Record<string, JEVQuestion>, options?: { timeoutMs?: number }) {
      const call: JevCall = { state, questions, at: clock.now(), timeoutMs: options?.timeoutMs };
      calls.push(call);
      await pause(wait(latency.jev, call));
      return params.answer(call);
    },
  };

  return {
    options: { llm, search, fetch: fetchProvider, factCheck, jev } as any,
    calls,
    searched,
  };
}

/**
 * Answers as JEV would: the 信頼度 question gets `support`, and every claim's
 * relevance question gets `relevant(section, claimId)`.
 */
export function answering(
  support: number | ((call: JevCall) => number),
  relevant: (section: { url: string; text: string }, claimId: string) => number = () => 0.9
): (call: JevCall) => Record<string, JEVAnswer> {
  return (call) => {
    const answers: Record<string, JEVAnswer> = {};
    for (const name of Object.keys(call.questions)) {
      if (name === "support") {
        answers[name] = { type: "noul", noul: typeof support === "number" ? support : support(call) };
      } else {
        answers[name] = { type: "noul", noul: relevant(call.state.section, name) };
      }
    }
    return answers;
  };
}
