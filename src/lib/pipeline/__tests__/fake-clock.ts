import type { Claim } from "@/types";
import type { CallLimit, JEVAnswer, JEVQuestion } from "@/lib/providers";
import type { Clock } from "@/lib/pipeline/time-budget";

/**
 * A clock that moves only when told to: time stands still while anything can
 * still run, and jumps to the next timer only when everything is waiting for
 * one. A run driven by it takes the same course every time, whatever the
 * machine does, and 300 seconds of it pass in a few milliseconds.
 */
export class FakeClock implements Clock {
  private time: number;
  private seq = 0;
  private timers: { at: number; seq: number; fire: () => void }[] = [];

  constructor(start = 0) {
    this.time = start;
  }

  now(): number {
    return this.time;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const timer = { at: this.time + Math.max(0, ms), seq: this.seq++, fire: () => resolve() };
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
    for (;;) {
      await drain();
      if (settled) break;
      if (this.timers.length === 0) {
        throw new Error("FakeClock: the work waits on something other than the clock.");
      }
      this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this.timers.shift()!;
      this.time = Math.max(this.time, next.at);
      next.fire();
    }
    return work;
  }
}

/** Lets everything that can run now, run. */
async function drain(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

export type FakePage = { url: string; title: string; body: string };

/** One call a fake service was sent: which, when, and when it ended. */
export type ServiceCall = {
  service: "extraction" | "documentQueries" | "claimQueries" | "search" | "fetch" | "factCheck" | "jev";
  at: number;
  /** When it ended, answered or stopped. */
  endedAt?: number;
  /** True when it was stopped by its caller's signal. */
  stopped?: boolean;
  state?: any;
  questions?: Record<string, JEVQuestion>;
  query?: string;
  url?: string;
};

export const isSupportCall = (call: ServiceCall) => !!call.questions && "support" in call.questions;
export const isRelevanceCall = (call: ServiceCall) =>
  call.service === "jev" && !!call.questions && !("support" in call.questions);

type Latency<T> = number | ((value: T) => number);
const latencyOf = <T>(latency: Latency<T> | undefined, value: T): number =>
  typeof latency === "function" ? latency(value) : latency ?? 0;

export function claimOf(id: string, over: Partial<Claim> = {}): Claim {
  return {
    id,
    originalText: `${id}の原文です。`,
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

/**
 * Services that answer from fixed data, taking the time they are told to on
 * the given clock, and stopping (throwing what the signal was aborted with)
 * when their caller's signal is aborted, as the real ones do.
 */
export function fakeServices(params: {
  clock: FakeClock;
  claims: Claim[];
  /** The article's queries. Default: one, 記事の検索語. */
  documentQueries?: string[];
  /** Each claim's queries. Default: one of its own, `<id> 一次資料`. */
  claimQueries?: (claim: Claim) => string[];
  /** What each search finds, in rank order. */
  pages: (query: string) => FakePage[];
  /** JEV's answers. Default: every section related (0.9), 信頼度 0.7. */
  answer?: (call: ServiceCall) => Record<string, JEVAnswer>;
  latency?: {
    extraction?: number;
    documentQueries?: number;
    claimQueries?: number;
    search?: Latency<string>;
    fetch?: Latency<string>;
    factCheck?: number;
    jev?: Latency<ServiceCall>;
  };
}) {
  const { clock, claims, latency = {} } = params;
  const calls: ServiceCall[] = [];
  const known = new Map<string, FakePage>();

  /** Takes `ms` on the clock, or stops when the caller's signal is aborted. */
  async function take<T>(call: ServiceCall, ms: number, limit: CallLimit | undefined, value: () => T): Promise<T> {
    calls.push(call);
    await clock.sleep(ms, limit?.signal);
    call.endedAt = clock.now();
    if (limit?.signal?.aborted) {
      call.stopped = true;
      throw limit.signal.reason ?? new Error("aborted");
    }
    return value();
  }

  const answer =
    params.answer ??
    ((call: ServiceCall) =>
      Object.fromEntries(
        Object.keys(call.questions ?? {}).map((name) => [
          name,
          { type: "noul", noul: name === "support" ? 0.7 : 0.9 } as JEVAnswer,
        ])
      ));

  const llm = {
    extractClaims: (_text: string, limit?: CallLimit) =>
      take({ service: "extraction", at: clock.now() }, latency.extraction ?? 0, limit, () => claims),
    generateDocumentQueries: (_text: string, limit?: CallLimit) =>
      take(
        { service: "documentQueries", at: clock.now() },
        latency.documentQueries ?? 0,
        limit,
        () => params.documentQueries ?? ["記事の検索語"]
      ),
    generateClaimQueries: (asked: Claim[], limit?: CallLimit) =>
      take(
        { service: "claimQueries", at: clock.now() },
        latency.claimQueries ?? 0,
        limit,
        () =>
          new Map(
            asked.map((claim) => [
              claim.id,
              params.claimQueries ? params.claimQueries(claim) : [`${claim.id} 一次資料`],
            ])
          )
      ),
  };
  const search = {
    search: (query: string, options?: { signal?: AbortSignal }) =>
      take(
        { service: "search", at: clock.now(), query },
        latencyOf(latency.search, query),
        options,
        () => {
          const found = params.pages(query);
          for (const page of found) known.set(page.url, page);
          return { results: found.map((page) => ({ url: page.url, title: page.title })) } as any;
        }
      ),
  };
  const fetchProvider = {
    fetchUrl: (url: string, options?: { signal?: AbortSignal }) =>
      take({ service: "fetch", at: clock.now(), url }, latencyOf(latency.fetch, url), options, () => {
        const page = known.get(url);
        return { url, title: page?.title ?? "", content: page?.body ?? "", statusCode: 200 };
      }),
  };
  const factCheck = {
    searchClaims: (query: string, _language?: string, limit?: CallLimit) =>
      take({ service: "factCheck", at: clock.now(), query }, latency.factCheck ?? 0, limit, () => ({
        claims: [],
      })),
  };
  const jev = {
    async evaluateAtomicJudgment(): Promise<never> {
      throw new Error("not used");
    },
    ask(state: unknown, questions: Record<string, JEVQuestion>, limit?: CallLimit) {
      const call: ServiceCall = { service: "jev", at: clock.now(), state, questions };
      return take(call, latencyOf(latency.jev, call), limit, () => answer(call));
    },
  };

  return {
    options: { llm, search, fetch: fetchProvider, factCheck, jev } as any,
    calls,
  };
}
