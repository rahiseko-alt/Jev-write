/**
 * The one place that holds the run's time budget and JEV's limits (ADR-0021).
 *
 * The budget is enforced by the clock, never by an estimate of how long the
 * work will take: an estimate said the JEV part of #84 would take 22–35 s,
 * and three claims took 92 s. Here nothing is predicted. Each piece of work
 * is given a time by which it must start and a time by which it must end,
 * read off the clock, and what the clock rules out is recorded as 時間切れ.
 *
 * All times below are measured from the start of the run.
 */

// ---------------------------------------------------------------------------
// The budget
// ---------------------------------------------------------------------------

/**
 * How long Vercel lets one run take before cutting it off with nothing
 * returned (`maxDuration` in vercel.json and in the analyze route).
 */
export const PLATFORM_LIMIT_MS = 300_000;

/**
 * Every JEV request of the run has ended by now, answered or not, and the
 * result is assembled. The 30 s left before the platform limit are the
 * margin: the time before this clock starts (the function starting up, the
 * request being read), assembling and sending the response, and a busy event
 * loop. A run the platform cuts off returns nothing at all, so the margin
 * errs on the side of returning early.
 */
export const RUN_DEADLINE_MS = 270_000;

/**
 * Kept at the end for the 信頼度 questions (ADR-0011), one to four per claim
 * (SUPPORT_REQUESTS_PER_CLAIM). 30 s holds about 200 of them at JEV's limits
 * (20 requests/s; at the 30,000-token state budget, about 8 requests/s by
 * tokens): about twice the 116 that 29 claims can need at most, with room
 * for a retry.
 */
export const SUPPORT_RESERVE_MS = 30_000;

/**
 * How long one attempt at JEV may take, reply included: the client's limit
 * before this change. An attempt is never given longer than is left before
 * the end of its stage.
 */
export const JEV_ATTEMPT_TIMEOUT_MS = 15_000;

/**
 * No attempt is started, or retried, with less than this left before the end
 * of its stage: an answer needs the time to arrive.
 */
export const MIN_ATTEMPT_MS = 5_000;

/**
 * No new relevance judgment starts after this: 225 s. What is in flight then
 * may take one whole attempt to end, and the 信頼度 questions keep their
 * reserve after that.
 */
export const RELEVANCE_STOP_MS = RUN_DEADLINE_MS - SUPPORT_RESERVE_MS - JEV_ATTEMPT_TIMEOUT_MS;

/**
 * Relevance judgments still in flight end by this, answered or timed out:
 * 240 s. The 信頼度 questions start as soon as the relevance judgments have
 * all ended, and by this at the latest.
 */
export const RELEVANCE_END_MS = RUN_DEADLINE_MS - SUPPORT_RESERVE_MS;

/**
 * At most this many requests carry one claim's 信頼度 question. The related
 * sections go in the order the claim's candidates were judged in (primary
 * sources first) until they fill 4 requests' state (about 120,000 estimated
 * tokens, the same amount a claim was given before, ADR-0016); the rest are
 * listed as held back, never dropped without a word.
 *
 * Without it the reserve above cannot be kept: judged over the whole pool, a
 * claim can have dozens of requests' worth of related sections, and 29
 * claims' worth does not fit in 30 s (simulated at article-05 size, with one
 * section in seven related to every claim, some 950 were needed and every
 * claim came back without a number). With it, 29 claims need at most 116
 * requests, about 3.5 million estimated tokens: 14 s at JEV's 250,000 tokens
 * a second. It also keeps the highest of the answers (ADR-0014) from being
 * taken over ever more requests.
 */
export const SUPPORT_REQUESTS_PER_CLAIM = 4;

// ---------------------------------------------------------------------------
// JEV's limits (docs.typesafe.ai/models, jev-1.13; checked 2026-09-23)
// ---------------------------------------------------------------------------

/**
 * 1,200 requests per minute. A request over it is refused with 429. The run
 * spreads them evenly, 20 in any second, rather than spending the minute's
 * worth in a burst: how JEV counts the minute is not documented.
 */
export const JEV_REQUESTS_PER_MINUTE = 1_200;

/**
 * 250,000 tokens per second. A request over it is refused with 429. Counted
 * with this side's estimate, which over-counts Japanese (support-question.ts
 * estimateTokens), so the run stays under the real figure.
 */
export const JEV_TOKENS_PER_SECOND = 250_000;

/**
 * How many requests are in flight at once: 20, the requests JEV takes per
 * second (1,200 / 60). At about a second a request, 20 in flight keep the run
 * at the request limit; if JEV answers faster, the limits above hold the run
 * back, and if it answers slower, this does, rather than piling requests onto
 * a busy service.
 */
export const JEV_MAX_IN_FLIGHT = JEV_REQUESTS_PER_MINUTE / 60;

/**
 * How a refused request (429 over the limit, 529 overloaded, other 5xx) is
 * sent again: JEV's own SDK defaults (docs.typesafe.ai/sdk/javascript/api/
 * interfaces/RetryPolicy): at most 2 retries, 0.5 s doubled up to 5 s, and
 * the wait the reply asks for (retry-after) honored up to 60 s — always only
 * when there is still time before the end of the stage.
 */
export const JEV_MAX_RETRIES = 2;
export const JEV_BACKOFF_INITIAL_MS = 500;
export const JEV_BACKOFF_MAX_MS = 5_000;
export const JEV_MAX_RETRY_AFTER_MS = 60_000;

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

/** Where the time comes from. A test hands in a clock it moves by hand. */
export interface Clock {
  now(): number;
  /** Waits `ms`; an abort ends the wait early. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const timer = setTimeout(done, Math.max(0, ms));
      function done() {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      }
      signal?.addEventListener("abort", done, { once: true });
    }),
};

/** The budget's numbers: times in ms from the start of the run. */
export interface BudgetSettings {
  deadlineMs: number;
  supportReserveMs: number;
  attemptTimeoutMs: number;
  minAttemptMs: number;
  /** The most requests one claim's 信頼度 question is spread over. */
  supportRequestsPerClaim: number;
}

export const DEFAULT_BUDGET: BudgetSettings = {
  deadlineMs: RUN_DEADLINE_MS,
  supportReserveMs: SUPPORT_RESERVE_MS,
  attemptTimeoutMs: JEV_ATTEMPT_TIMEOUT_MS,
  minAttemptMs: MIN_ATTEMPT_MS,
  supportRequestsPerClaim: SUPPORT_REQUESTS_PER_CLAIM,
};

/** One run's budget, as points in time on its clock. */
export interface TimeBudget {
  clock: Clock;
  settings: BudgetSettings;
  /** When the run started. */
  startedAt: number;
  /** No new relevance judgment starts after this. */
  relevanceStopAt: number;
  /** Relevance judgments in flight end by this. */
  relevanceEndAt: number;
  /** Every JEV request has ended by this. */
  deadlineAt: number;
  /** The last moment a 信頼度 question may start. */
  supportStopAt: number;
  /** Milliseconds since the run started. */
  elapsed(at?: number): number;
}

export function createTimeBudget(
  clock: Clock = systemClock,
  overrides: Partial<BudgetSettings> = {},
  startedAt: number = clock.now()
): TimeBudget {
  const settings: BudgetSettings = { ...DEFAULT_BUDGET, ...overrides };
  const deadlineAt = startedAt + settings.deadlineMs;
  const relevanceEndAt = deadlineAt - settings.supportReserveMs;
  return {
    clock,
    settings,
    startedAt,
    relevanceStopAt: relevanceEndAt - settings.attemptTimeoutMs,
    relevanceEndAt,
    deadlineAt,
    supportStopAt: deadlineAt - settings.minAttemptMs,
    elapsed: (at = clock.now()) => at - startedAt,
  };
}

/**
 * JEV's limits and how this run keeps to them. How long an attempt may take
 * is the budget's to say (BudgetSettings), not repeated here.
 */
export interface JevLimits {
  requestsPerMinute: number;
  tokensPerSecond: number;
  maxInFlight: number;
  maxRetries: number;
  backoffInitialMs: number;
  backoffMaxMs: number;
  maxRetryAfterMs: number;
}

export const DEFAULT_JEV_LIMITS: JevLimits = {
  requestsPerMinute: JEV_REQUESTS_PER_MINUTE,
  tokensPerSecond: JEV_TOKENS_PER_SECOND,
  maxInFlight: JEV_MAX_IN_FLIGHT,
  maxRetries: JEV_MAX_RETRIES,
  backoffInitialMs: JEV_BACKOFF_INITIAL_MS,
  backoffMaxMs: JEV_BACKOFF_MAX_MS,
  maxRetryAfterMs: JEV_MAX_RETRY_AFTER_MS,
};
