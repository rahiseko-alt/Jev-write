/**
 * What bounds one call to an outside service (ADR-0021).
 *
 * The run's time budget hands every call the signal of its stage, aborted
 * at the stage's cut-off. The call then stops at once, its retries and the
 * waits between them included, and throws. That is not the service failing:
 * the service may have been about to answer. So it is not counted as the
 * service's failure in 各サービスの状態; the run records it as 時間切れ.
 */
export interface CallLimit {
  /** Aborted when the time for the call's stage has run out. */
  signal?: AbortSignal;
}

/** Whether the caller stopped the call (時間切れ), as opposed to the service failing. */
export function stoppedByCaller(limit?: CallLimit): boolean {
  return limit?.signal?.aborted === true;
}

/**
 * A signal for one attempt at a call: aborted by the caller's signal, or
 * when the service's own time limit for one attempt passes, whichever comes
 * first. Release it when the attempt is over.
 */
export function attemptSignal(
  timeoutMs: number,
  outer?: AbortSignal
): { signal: AbortSignal; release(): void } {
  const controller = new AbortController();
  const follow = () => controller.abort(outer?.reason);
  if (outer?.aborted) follow();
  else outer?.addEventListener("abort", follow, { once: true });
  const timer = setTimeout(() => controller.abort(), Math.max(0, timeoutMs));
  return {
    signal: controller.signal,
    release() {
      clearTimeout(timer);
      outer?.removeEventListener("abort", follow);
    },
  };
}

/** Waits `ms`, or less when the signal aborts first. */
export function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, Math.max(0, ms));
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** What a call its caller stopped throws: the reason the caller gave, or a plain abort. */
export function stoppedError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  return error;
}
