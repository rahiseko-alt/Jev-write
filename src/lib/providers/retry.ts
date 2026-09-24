import { pause, stoppedError } from "./call-limit";

/**
 * Asking the same service the same thing again, after it said "not now".
 *
 * This is not a stand-in: nothing here answers in the service's place. A
 * rate limit (429) or an overload (529) says the service is busy, not that
 * the request is wrong, so the same request goes to the same service again
 * after the wait it asked for. If it is still busy after the last try, the
 * final response is handed back untouched and the caller reports it as the
 * failure it is.
 *
 * The retries stay within the call's time (ADR-0021): a wait the time runs
 * out in ends there, and nothing is sent after it.
 */

/** Waits before each retry when the service names none: 2s, 4s, 8s. */
export const RETRY_BACKOFF_MS = [2000, 4000, 8000];
/** How many times the same request may be sent again. */
export const MAX_RETRIES = RETRY_BACKOFF_MS.length;
/** A retry-after longer than this is not waited out whole. */
export const MAX_RETRY_WAIT_MS = 60000;

/** The wait a retry-after header asks for, in ms, or undefined if it asks for none. */
export function parseRetryAfter(header?: string | null, now = Date.now()): number | undefined {
  if (header == null || header.trim() === "") return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return seconds < 0 ? undefined : Math.min(seconds * 1000, MAX_RETRY_WAIT_MS);
  }
  const date = Date.parse(header);
  if (Number.isNaN(date)) return undefined;
  return Math.min(Math.max(date - now, 0), MAX_RETRY_WAIT_MS);
}

type RetryableResponse = {
  ok: boolean;
  status: number;
  headers?: { get?: (name: string) => string | null } | null;
};

export interface RetryOptions {
  /** Statuses that mean "busy, ask again". */
  retryStatuses: number[];
  /**
   * The waits before each retry when the service names none; as many
   * retries as there are waits. Without it, RETRY_BACKOFF_MS.
   */
  backoffMs?: number[];
  /** Called as the same request is sent again, so the run can say it retried. */
  onRetry?: (status: number, waitMs: number, attempt: number) => void;
  /**
   * Aborted when the call's time has run out (ADR-0021). A wait ends there
   * and nothing more is sent: the call throws what the signal was aborted with.
   */
  signal?: AbortSignal;
}

/**
 * Sends the request, and sends it again (up to MAX_RETRIES times, or once
 * per wait in `backoffMs`) while the service answers with one of the retry
 * statuses. Returns the last response, successful or not.
 */
export async function sendWithRetry<R extends RetryableResponse>(
  send: () => Promise<R>,
  options: RetryOptions
): Promise<R> {
  const backoff = options.backoffMs ?? RETRY_BACKOFF_MS;
  let response = await send();
  for (let attempt = 1; attempt <= backoff.length; attempt++) {
    if (response.ok || !options.retryStatuses.includes(response.status)) {
      return response;
    }
    const wait =
      parseRetryAfter(response.headers?.get?.("retry-after")) ??
      backoff[attempt - 1];
    await pause(wait, options.signal);
    if (options.signal?.aborted) throw stoppedError(options.signal);
    options.onRetry?.(response.status, wait, attempt);
    response = await send();
  }
  return response;
}
