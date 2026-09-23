import type { JEVClient } from "@/lib/providers";
import { JEVRequestError } from "@/lib/providers/jev/types";
import { recordFailure, recordRetry } from "@/lib/providers/diagnostics";
import type { Clock, JevLimits } from "./time-budget";

/**
 * Every JEV request of a run goes through here (ADR-0021). This is where the
 * run keeps to JEV's official limits, and where the clock, not an estimate,
 * decides what is still sent.
 *
 *  - Requests start in the order they were handed in, never more than
 *    `maxInFlight` at once, `requestsPerMinute` spread evenly over the
 *    minute, and never more than `tokensPerSecond` in any second
 *    (docs.typesafe.ai/models).
 *  - Each has a time to start by and a time to end by. One whose turn has
 *    not come by its start-by time is not sent: it comes back "not-started",
 *    for the caller to record as 時間切れ. One in flight is given no longer
 *    than is left before its end-by time.
 *  - A request JEV refuses as busy (429, 5xx) is sent again with backoff, as
 *    JEV's API reference asks (docs.typesafe.ai/api, "Handling rate limits"),
 *    only while the retry can still end in time. While JEV is busy, nothing
 *    else is started either.
 *  - It never answers in JEV's place: a request that got no answer comes
 *    back as the failure it is.
 */

/** When one request may run. */
export interface DispatchWindow {
  /** Which stage it belongs to, for the counts in the run's timings. */
  stage: string;
  /** It is not started after this. */
  startBy: number;
  /** Every attempt at it has ended by this. */
  finishBy: number;
}

export type Dispatched<T> =
  | { status: "answered"; value: T }
  /** Its turn did not come before its start-by time: 時間切れ. */
  | { status: "not-started" }
  /**
   * No answer. `cutOff` when the attempt was stopped by the end of its window
   * (時間切れ) rather than by JEV (a refusal, an error, or a whole attempt's
   * time without a reply).
   */
  | { status: "failed"; error: unknown; cutOff: boolean };

/** What one stage sent, for the timings (observability only). */
export interface StageCounts {
  /** Requests sent (a retry is not counted again here). */
  calls: number;
  /** Times a request was sent again after JEV said it was busy. */
  retries: number;
  /** Requests JEV did not answer. */
  failures: number;
  /** Requests stopped by the end of their window while in flight. */
  cutOff: number;
  /** Requests never sent, because their start-by time had passed. */
  notStarted: number;
}

interface Job {
  tokens: number;
  window: DispatchWindow;
  attempt: (timeoutMs: number) => Promise<unknown>;
  resolve: (outcome: Dispatched<unknown>) => void;
}

type Attempted = { ok: true; value: unknown } | { ok: false; error: unknown; timedOut: boolean };

const MINUTE_MS = 60_000;
const SECOND_MS = 1_000;

/** Whether JEV refused the request as busy: over the rate limit (429) or overloaded (5xx, 529 among them). */
export function isBusy(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && (status === 429 || (status >= 500 && status <= 599));
}

export class JevDispatcher {
  private queue: Job[] = [];
  private inFlight = 0;
  private pumping = false;
  /** When requests started, oldest first, within the last minute. */
  private starts: number[] = [];
  /** Tokens sent, oldest first, within the last second. */
  private spent: { at: number; tokens: number }[] = [];
  /** Nothing starts before this: JEV said it was busy. */
  private pausedUntil = Number.NEGATIVE_INFINITY;
  private counts = new Map<string, StageCounts>();

  constructor(
    /** Where failures and retries are recorded, for 各サービスの状態. */
    private readonly jev: JEVClient,
    private readonly clock: Clock,
    private readonly limits: JevLimits,
    /** How long one attempt may take, and the least time worth starting one with. */
    private readonly attemptTimeoutMs: number,
    private readonly minAttemptMs: number
  ) {}

  /**
   * Hands in one request. `tokens` is its estimated size; `attempt` sends it
   * once, within the time it is given.
   */
  send<T>(
    tokens: number,
    window: DispatchWindow,
    attempt: (timeoutMs: number) => Promise<T>
  ): Promise<Dispatched<T>> {
    return new Promise((resolve) => {
      this.queue.push({
        tokens,
        window,
        attempt,
        resolve: resolve as (outcome: Dispatched<unknown>) => void,
      });
      void this.pump();
    });
  }

  /** What one stage sent so far. */
  countsFor(stage: string): StageCounts {
    return { ...this.count(stage) };
  }

  private count(stage: string): StageCounts {
    let counts = this.counts.get(stage);
    if (!counts) {
      counts = { calls: 0, retries: 0, failures: 0, cutOff: 0, notStarted: 0 };
      this.counts.set(stage, counts);
    }
    return counts;
  }

  /** Starts what may start now, in the order handed in; waits for the limits when it must. */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0 && this.inFlight < this.limits.maxInFlight) {
        const job = this.queue[0];
        const now = this.clock.now();
        const at = this.earliestStart(now, job.tokens);
        if (at > job.window.startBy || job.window.finishBy - at < this.minAttemptMs) {
          // Its turn would come too late: it is not sent, and it is said so.
          this.queue.shift();
          this.count(job.window.stage).notStarted++;
          job.resolve({ status: "not-started" });
          continue;
        }
        if (at > now) {
          await this.clock.sleep(at - now);
          continue;
        }
        this.queue.shift();
        this.inFlight++;
        this.take(now, job.tokens);
        this.count(job.window.stage).calls++;
        void this.run(job, now).finally(() => {
          this.inFlight--;
          void this.pump();
        });
      }
    } finally {
      this.pumping = false;
    }
  }

  /** One request, from its first attempt to its answer or its failure. */
  private async run(job: Job, startedAt: number): Promise<void> {
    const counts = this.count(job.window.stage);
    let now = startedAt;
    for (let retries = 0; ; retries++) {
      const timeoutMs = Math.min(this.attemptTimeoutMs, job.window.finishBy - now);
      const outcome = await this.attemptOnce(job, timeoutMs);
      if (outcome.ok) {
        job.resolve({ status: "answered", value: outcome.value });
        return;
      }

      now = this.clock.now();
      if (!outcome.timedOut && isBusy(outcome.error) && retries < this.limits.maxRetries) {
        const wait = this.waitAfter(outcome.error, retries);
        const at = this.earliestStart(now + wait, job.tokens);
        if (job.window.finishBy - at >= this.minAttemptMs) {
          // JEV is busy: nothing else starts before this one may be sent again.
          this.pausedUntil = Math.max(this.pausedUntil, now + wait);
          counts.retries++;
          recordRetry(this.jev);
          await this.clock.sleep(at - now);
          now = await this.waitForTurn(job.tokens, job.window.finishBy - this.minAttemptMs);
          if (now >= 0) {
            this.take(now, job.tokens);
            continue;
          }
          now = this.clock.now();
        }
      }

      // The attempt that ran out of its window's time was stopped by the
      // budget, not by JEV: it is 時間切れ, and not counted against JEV.
      const cutOff = outcome.timedOut && timeoutMs < this.attemptTimeoutMs;
      if (cutOff) {
        counts.cutOff++;
      } else {
        counts.failures++;
        recordFailure(this.jev, outcome.error);
      }
      job.resolve({ status: "failed", error: outcome.error, cutOff });
      return;
    }
  }

  /**
   * Waits until the limits let one more request start, and returns when that
   * was, or -1 if that would be after `latest`.
   */
  private async waitForTurn(tokens: number, latest: number): Promise<number> {
    for (;;) {
      const now = this.clock.now();
      const at = this.earliestStart(now, tokens);
      if (at > latest) return -1;
      if (at <= now) return now;
      await this.clock.sleep(at - now);
    }
  }

  /** One attempt, given `timeoutMs`; the clock ends it if the attempt itself does not. */
  private async attemptOnce(job: Job, timeoutMs: number): Promise<Attempted> {
    const stop = new AbortController();
    const call: Promise<Attempted> = Promise.resolve()
      .then(() => job.attempt(timeoutMs))
      .then(
        (value): Attempted => ({ ok: true, value }),
        (error): Attempted => ({
          ok: false,
          error,
          timedOut: error instanceof JEVRequestError && error.timedOut,
        })
      );
    const expired: Promise<Attempted> = this.clock.sleep(timeoutMs, stop.signal).then(() => ({
      ok: false,
      error: new JEVRequestError(`JEV did not answer within ${timeoutMs}ms`, { timedOut: true }),
      timedOut: true,
    }));
    try {
      return await Promise.race([call, expired]);
    } finally {
      stop.abort();
    }
  }

  /** The wait before sending again: what the reply asked for, or JEV's SDK backoff. */
  private waitAfter(error: unknown, retries: number): number {
    const asked = (error as { retryAfterMs?: unknown } | null)?.retryAfterMs;
    if (typeof asked === "number" && asked >= 0 && asked <= this.limits.maxRetryAfterMs) return asked;
    return Math.min(this.limits.backoffInitialMs * 2 ** retries, this.limits.backoffMaxMs);
  }

  /** Counts one request as sent at `at`, against both limits. */
  private take(at: number, tokens: number): void {
    this.starts.push(at);
    this.spent.push({ at, tokens });
  }

  /**
   * The earliest time from `from` at which a request of `tokens` keeps within
   * the limits: `requestsPerMinute` spread evenly (at 1,200 a minute, fewer
   * than 20 starts in the second before it), and at most `tokensPerSecond`
   * tokens in the second before it, its own included. Also not before a
   * pause for a busy JEV has passed.
   */
  private earliestStart(from: number, tokens: number): number {
    this.forget(this.clock.now());
    const burst = Math.max(1, Math.ceil(this.limits.requestsPerMinute / 60));
    const span = (burst * MINUTE_MS) / this.limits.requestsPerMinute;
    let at = Math.max(from, this.pausedUntil);
    for (;;) {
      const recent = this.starts.filter((start) => start > at - span);
      if (recent.length >= burst) {
        at = recent[recent.length - burst] + span;
        continue;
      }
      const window = this.spent.filter((entry) => entry.at > at - SECOND_MS);
      const used = window.reduce((sum, entry) => sum + entry.tokens, 0);
      if (window.length > 0 && used + tokens > this.limits.tokensPerSecond) {
        at = window[0].at + SECOND_MS;
        continue;
      }
      return at;
    }
  }

  /** Drops what has left both windows. */
  private forget(now: number): void {
    while (this.starts.length > 0 && this.starts[0] <= now - MINUTE_MS) this.starts.shift();
    while (this.spent.length > 0 && this.spent[0].at <= now - SECOND_MS) this.spent.shift();
  }
}
