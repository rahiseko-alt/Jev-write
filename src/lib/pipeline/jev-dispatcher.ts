import type { StageName } from "./stage-timings";
import type { TimeBudget, Within } from "./time-budget";

/**
 * How the run sends its JEV requests (ADR-0022): in the order they are
 * handed in, as fast as JEV's published limits allow, and never after their
 * stage's cut-off.
 *
 * JEV's limits for jev-1.13 (docs.typesafe.ai/models, read 2026-09-24):
 * 250,000 tokens per second and 1,200 requests per minute; a request over
 * either is refused with 429. The page warns that the limits "can change
 * without notice", so the run keeps to them as written rather than to what
 * JEV happened to let through once (145 relevance requests of about 24,000
 * estimated tokens each, answered within 3 s: well over 250,000 a second).
 */
export const JEV_TOKENS_PER_SECOND = 250_000;
export const JEV_REQUESTS_PER_MINUTE = 1_200;

/**
 * How many requests may be in flight at once: the published request rate
 * (1,200 a minute, 20 a second) times the longest reply measured in
 * production (article-05: 145 relevance requests sent together, all
 * answered within 3 s): 20 × 3 = 60. So the cap does not set the pace; the
 * limits do. #84 kept 8 in flight, which at about a second a reply let
 * through 8 requests a second whatever the limits allowed.
 */
export const JEV_MAX_IN_FLIGHT = 60;

export interface JevLimits {
  tokensPerSecond: number;
  requestsPerMinute: number;
  maxInFlight: number;
}

export const JEV_LIMITS: JevLimits = {
  tokensPerSecond: JEV_TOKENS_PER_SECOND,
  requestsPerMinute: JEV_REQUESTS_PER_MINUTE,
  maxInFlight: JEV_MAX_IN_FLIGHT,
};

const MINUTE_MS = 60_000;
const SECOND_MS = 1_000;

interface Job {
  stage: StageName;
  tokens: number;
  work: (signal: AbortSignal) => Promise<unknown>;
  resolve: (outcome: Within<unknown>) => void;
  reject: (error: unknown) => void;
}

/**
 * One run's JEV requests, sent through #89's time budget (ADR-0021) as it
 * is: each request is one `budget.within` of its stage, so the stage's
 * cut-off stops it, counts it and records it as 時間切れ, and its time is in
 * `result.timings`. What this adds is only when each request starts:
 *
 *  - in the order handed in (the caller's fixed order);
 *  - no more than `tokensPerSecond` estimated tokens started in any second,
 *    and no more than `requestsPerMinute` started in any minute. The
 *    estimate counts high (support-question.ts, estimateTokens), so the
 *    tokens really sent stay under the limit;
 *  - no more than `maxInFlight` at once;
 *  - a request whose stage can no longer start one (its cut-off has come,
 *    or less than the least time to start one is left) is not sent: it
 *    comes back "notStarted" at once, counted as 時間切れ by the budget, and
 *    takes no place in the limits.
 */
export class JevDispatcher {
  private readonly queue: Job[] = [];
  private inFlight = 0;
  private pumping = false;
  /** When requests started, oldest first, within the last minute. */
  private readonly starts: number[] = [];
  /** The estimated tokens of requests started within the last second, oldest first. */
  private readonly spent: { at: number; tokens: number }[] = [];

  constructor(
    private readonly budget: TimeBudget,
    private readonly limits: JevLimits = JEV_LIMITS
  ) {}

  /**
   * Hands in one request of `stage`, of about `tokens` estimated tokens.
   * `work` sends it once, stopping when the signal is aborted. Resolves with
   * what the budget made of it; rejects with JEV's own failure.
   */
  send<T>(stage: StageName, tokens: number, work: (signal: AbortSignal) => Promise<T>): Promise<Within<T>> {
    return new Promise<Within<T>>((resolve, reject) => {
      this.queue.push({
        stage,
        tokens,
        work,
        resolve: resolve as (outcome: Within<unknown>) => void,
        reject,
      });
      void this.pump();
    });
  }

  /** Starts what may start now, in the order handed in; waits for the limits when it must. */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0 && this.inFlight < this.limits.maxInFlight) {
        const job = this.queue[0];
        if (!this.budget.canStart(job.stage)) {
          // Too late to start: the budget says so and counts it.
          this.queue.shift();
          this.start(job, false);
          continue;
        }
        const now = this.budget.clock.now();
        const at = this.earliestStart(now, job.tokens);
        if (at > now) {
          // The wait ends early at the stage's cut-off, so what is left of
          // the queue is let go as not started, not held past it.
          await this.budget.clock.sleep(at - now, this.budget.signal(job.stage));
          continue;
        }
        this.queue.shift();
        this.starts.push(now);
        this.spent.push({ at: now, tokens: job.tokens });
        this.start(job, true);
      }
    } finally {
      this.pumping = false;
    }
  }

  private start(job: Job, sent: boolean): void {
    if (sent) this.inFlight++;
    this.budget
      .within(job.stage, job.work, { jev: true })
      .then(job.resolve, job.reject)
      .finally(() => {
        if (!sent) return;
        this.inFlight--;
        void this.pump();
      });
  }

  /**
   * The earliest time from `now` at which a request of `tokens` keeps within
   * both limits: fewer than `requestsPerMinute` starts in the minute before
   * it, and at most `tokensPerSecond` tokens in the second before it, its
   * own included (a request larger than that alone starts when the second
   * before it is empty).
   */
  private earliestStart(now: number, tokens: number): number {
    while (this.starts.length > 0 && this.starts[0] <= now - MINUTE_MS) this.starts.shift();
    while (this.spent.length > 0 && this.spent[0].at <= now - SECOND_MS) this.spent.shift();

    let at = now;
    const { requestsPerMinute, tokensPerSecond } = this.limits;
    if (this.starts.length >= requestsPerMinute) {
      at = Math.max(at, this.starts[this.starts.length - requestsPerMinute] + MINUTE_MS);
    }
    const window = this.spent.filter((entry) => entry.at > at - SECOND_MS);
    let used = window.reduce((sum, entry) => sum + entry.tokens, 0);
    for (const entry of window) {
      if (used === 0 || used + tokens <= tokensPerSecond) break;
      // Once this entry leaves the second, its tokens are free again.
      at = Math.max(at, entry.at + SECOND_MS);
      used -= entry.tokens;
    }
    return at;
  }
}
