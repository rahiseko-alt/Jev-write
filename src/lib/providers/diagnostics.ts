/**
 * What each outside service actually did during one run.
 *
 * When a run comes back with nothing found, the reader deserves to know
 * whether every check ran and found nothing, or whether a service never
 * answered at all. Without this the two look identical on screen.
 */

export type ProviderDiagnostics = {
  /** How many calls to the real service failed during this run. */
  failureCount?: number;
  /** The first failure's message, with anything credential-shaped removed. */
  lastError?: string;
  /** How many times a busy service (429/529) was asked the same thing again. */
  retryCount?: number;
};

const MAX_ERROR_LENGTH = 200;

/** A message safe to put on screen: no key, no query string, not a wall of text. */
export function describeFailure(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/([?&](?:key|api[_-]?key|token)=)[^&\s]+/gi, "$1***")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "***")
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, "Bearer ***")
    .slice(0, MAX_ERROR_LENGTH);
}

/** Record a failure on a provider that keeps diagnostics. */
export function recordFailure(target: ProviderDiagnostics, err: unknown): void {
  target.failureCount = (target.failureCount ?? 0) + 1;
  if (!target.lastError) {
    target.lastError = describeFailure(err);
  }
}

/** Record that the same request was sent again to a busy service. */
export function recordRetry(target: ProviderDiagnostics): void {
  target.retryCount = (target.retryCount ?? 0) + 1;
}
