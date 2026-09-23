import { setMaxListeners } from "events";
import type { StageCut, StageTiming } from "@/types";
import { STAGES, StageName, StageTimer } from "./stage-timings";

/**
 * The one place that holds the run's time settings (ADR-0021).
 *
 * Vercel stops a run at 300 s, and a run it stops returns nothing at all
 * (#84 did this). So the run keeps to a deadline before that, counted from
 * the moment the request came in, and each stage has a cut-off: after it,
 * no new work of that stage starts, work of that stage still running is
 * stopped, and the run moves on with what is done. What the clock left
 * undone is recorded as 時間切れ, never dropped without a word, and no
 * number is made up in its place.
 *
 * The cut-offs are read off the clock, never predicted: nothing here
 * estimates how long a stage will take. A run that finishes its stages
 * before their cut-offs is not touched by any of this.
 *
 * All times are ms from the start of the request.
 */

/** Vercel's limit for one run (`maxDuration`, in vercel.json and the analyze route). */
export const PLATFORM_LIMIT_MS = 300_000;

/**
 * Every call to an outside service has ended by now, answered or not, and
 * the result is put together. The 30 s left before the platform limit are
 * the margin for what the clock does not see: the function starting and the
 * request being read before it starts, and after it the result assembled,
 * serialised (twice: as the result and inside the job) and sent, with the
 * event loop late when dozens of claims finish at once. None of these was
 * measured, and a run over the limit returns nothing, so the margin errs on
 * the side of returning early.
 */
export const RUN_DEADLINE_MS = 270_000;

/**
 * Each stage's cut-off. Stages run in this order, and each keeps the stages
 * after it enough time to run once (ADR-0021 has the reasons for each).
 *
 *  - extraction 170 s: one generation; cut, there are no claims at all, so
 *    it is waited for longest. Article-05 (29 claims, 184–195 s in all)
 *    is estimated to finish it at about 90–110 s.
 *  - queryGeneration 210 s: one generation after the extraction (the
 *    article's queries are written alongside the extraction). Cut, the
 *    claims are checked against the pages the article's queries found, as
 *    when the generation fails today. Leaves 60 s for the stages below.
 *  - search 220 s, pageFetch 230 s: 10 s each, one call's own time limit.
 *  - factCheck 235 s: the Google lookup (about 1 s) and matching its hits.
 *  - relevanceJudging 245 s: at least 10 s, about 15 s as a rule.
 *  - supportJudging 270 s, the deadline: 25 s after the relevance cut-off,
 *    more than one whole JEV attempt (15 s).
 */
export const STAGE_CUTOFF_MS: Readonly<Record<StageName, number>> = {
  extraction: 170_000,
  queryGeneration: 210_000,
  search: 220_000,
  pageFetch: 230_000,
  factCheck: 235_000,
  relevanceJudging: 245_000,
  supportJudging: RUN_DEADLINE_MS,
};

/**
 * A call is started only with at least this much left before its stage's
 * cut-off. A search, a page or a JEV request usually takes 1–3 s; started
 * with less, it would be stopped before its answer could arrive.
 */
export const MIN_START_MS = 3_000;

/** The reason recorded for work the clock left undone, in the reader's words. */
export const TIME_UP = "時間切れ";

/** Where the time comes from. A test hands in a clock it moves by hand. */
export interface Clock {
  now(): number;
  /** Waits `ms`; an abort ends the wait early. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** The longest wait setTimeout takes (about 24.8 days); anything longer fires at once. */
const LONGEST_TIMER_MS = 2 ** 31 - 1;

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const timer = setTimeout(done, Math.min(Math.max(0, ms), LONGEST_TIMER_MS));
      // A wait for a cut-off must never keep the process alive on its own.
      (timer as { unref?: () => void }).unref?.();
      function done() {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      }
      signal?.addEventListener("abort", done, { once: true });
    }),
};

/** The budget's numbers: times in ms from the start of the request. */
export interface BudgetSettings {
  deadlineMs: number;
  cutoffMs: Record<StageName, number>;
  minStartMs: number;
}

export const DEFAULT_BUDGET: BudgetSettings = {
  deadlineMs: RUN_DEADLINE_MS,
  cutoffMs: { ...STAGE_CUTOFF_MS },
  minStartMs: MIN_START_MS,
};

/** What a call stopped by its stage's cut-off is stopped with. */
export class TimeUpError extends Error {
  constructor(readonly stage: StageName, readonly cutoffMs: number) {
    super(`${TIME_UP}: ${stage} の締め切り（開始から ${cutoffMs} ms）`);
    this.name = "TimeUpError";
  }
}

/**
 * How one call within a stage went. Only a failure of the service itself is
 * thrown; what the clock did is one of the other two.
 */
export type Within<T> =
  | { status: "done"; value: T }
  /** Its stage's cut-off had come, or too little was left before it: not started. 時間切れ. */
  | { status: "notStarted" }
  /** Still running at its stage's cut-off, and stopped. 時間切れ. */
  | { status: "stopped" };

/** One run's time: its settings as points on its clock, and what they did. */
export class TimeBudget {
  private readonly timer: StageTimer;
  private readonly controllers = new Map<StageName, AbortController>();
  private readonly disposed = new AbortController();

  constructor(
    readonly clock: Clock,
    /** When the request came in. */
    readonly startedAt: number,
    readonly settings: BudgetSettings
  ) {
    this.timer = new StageTimer(clock, startedAt);
  }

  /** When `stage` is cut off, on the clock. Never after the deadline. */
  cutoffAt(stage: StageName): number {
    return this.startedAt + this.cutoffMs(stage);
  }

  /** How long `stage` has left before its cut-off. */
  remaining(stage: StageName): number {
    return this.cutoffAt(stage) - this.clock.now();
  }

  /** Whether a call of `stage` may still start. */
  canStart(stage: StageName): boolean {
    return this.remaining(stage) >= this.settings.minStartMs;
  }

  /** Milliseconds since the request came in. */
  elapsed(): number {
    return this.clock.now() - this.startedAt;
  }

  /** Aborted at `stage`'s cut-off: every call of the stage carries it. */
  signal(stage: StageName): AbortSignal {
    const existing = this.controllers.get(stage);
    if (existing) return existing.signal;
    const controller = new AbortController();
    // Every call of the stage listens to this one signal (dozens of page
    // fetches at once): that is not a leak, so Node is not to warn of one.
    setMaxListeners(0, controller.signal);
    this.controllers.set(stage, controller);
    const stop = () => controller.abort(new TimeUpError(stage, this.cutoffMs(stage)));
    const left = this.remaining(stage);
    if (left <= 0) {
      stop();
    } else {
      void this.clock.sleep(left, this.disposed.signal).then(() => {
        if (!this.disposed.signal.aborted) stop();
      });
    }
    return controller.signal;
  }

  /**
   * Runs one call of `stage` within its cut-off: not started when the
   * cut-off has come, stopped when it comes while the call is running. A
   * failure that is not the clock's is thrown as it came.
   */
  async within<T>(
    stage: StageName,
    work: (signal: AbortSignal) => Promise<T>,
    options: { jev?: boolean } = {}
  ): Promise<Within<T>> {
    if (!this.canStart(stage)) {
      this.timer.notStarted(stage);
      return { status: "notStarted" };
    }
    const signal = this.signal(stage);
    const end = this.timer.begin(stage, options);
    try {
      return { status: "done", value: await work(signal) };
    } catch (err) {
      if (signal.aborted) {
        this.timer.stopped(stage);
        return { status: "stopped" };
      }
      throw err;
    } finally {
      end();
    }
  }

  /** Each stage's time and calls, for `result.timings`. Observability only. */
  timings(): StageTiming[] {
    const cutoffs = Object.fromEntries(STAGES.map((stage) => [stage, this.cutoffMs(stage)]));
    return this.timer.timings(cutoffs);
  }

  /** The stages whose cut-off left work undone, in run order. Empty when none did. */
  cutShort(): StageCut[] {
    return STAGES.flatMap((stage) => {
      const { notStarted, stopped } = this.timer.counts(stage);
      return notStarted + stopped > 0
        ? [{ stage, notStarted, stopped, cutoffMs: this.cutoffMs(stage) }]
        : [];
    });
  }

  /** Ends the waits for the cut-offs. The run is over. */
  dispose(): void {
    this.disposed.abort();
  }

  private cutoffMs(stage: StageName): number {
    return Math.min(this.settings.cutoffMs[stage], this.settings.deadlineMs);
  }
}

/**
 * A budget for one run. `startedAt` is when the request came in; without
 * it, now. `settings` narrows the numbers above, for a test.
 */
export function createTimeBudget(
  options: {
    clock?: Clock;
    startedAt?: number;
    settings?: Partial<Omit<BudgetSettings, "cutoffMs">> & {
      cutoffMs?: Partial<Record<StageName, number>>;
    };
  } = {}
): TimeBudget {
  const clock = options.clock ?? systemClock;
  const overrides = options.settings ?? {};
  const settings: BudgetSettings = {
    deadlineMs: overrides.deadlineMs ?? DEFAULT_BUDGET.deadlineMs,
    minStartMs: overrides.minStartMs ?? DEFAULT_BUDGET.minStartMs,
    cutoffMs: { ...DEFAULT_BUDGET.cutoffMs, ...overrides.cutoffMs },
  };
  return new TimeBudget(clock, options.startedAt ?? clock.now(), settings);
}
