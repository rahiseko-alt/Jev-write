import type { StageTiming } from "@/types";
import type { Clock } from "./time-budget";

/**
 * The stages of one run, in the order they begin (ADR-0021). The names are
 * what `result.timings` carries and what the time settings are keyed by.
 */
export const STAGES = [
  "extraction",
  "queryGeneration",
  "search",
  "pageFetch",
  "factCheck",
  "relevanceJudging",
  "supportJudging",
] as const;

export type StageName = (typeof STAGES)[number];

/** What one stage did, counted as it went. */
export interface StageCounts {
  /** Calls to outside services it started. */
  calls: number;
  /** Of those, the requests sent to JEV. */
  jevCalls: number;
  /** Calls not started because the stage's cut-off had come (時間切れ). */
  notStarted: number;
  /** Calls still running at the stage's cut-off, and stopped there (時間切れ). */
  stopped: number;
}

type Span = StageCounts & {
  /** Pieces of work running right now. */
  active: number;
  /** Since when at least one has been running. */
  since: number;
  /** Time with at least one running, up to `since`. */
  busy: number;
  first?: number;
  last?: number;
};

/**
 * How long each stage had work in flight, and what it sent. Observability
 * only: nothing here decides anything.
 *
 * Stages overlap (the article's queries are written while the claims are
 * extracted, and many searches run at once), so a stage's duration is the
 * time during which at least one piece of it was running, not the sum of
 * its pieces.
 */
export class StageTimer {
  private spans = new Map<StageName, Span>();

  constructor(
    private readonly clock: Clock,
    /** When the request came in: every time is reported from here. */
    private readonly origin: number
  ) {}

  /** Marks one call of `stage` as started; call what it returns when it ends. */
  begin(stage: StageName, options: { jev?: boolean } = {}): () => void {
    const span = this.span(stage);
    const now = this.clock.now();
    if (span.active === 0) span.since = now;
    span.active++;
    span.calls++;
    if (options.jev) span.jevCalls++;
    span.first = span.first === undefined ? now : Math.min(span.first, now);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const at = this.clock.now();
      span.active--;
      if (span.active === 0) span.busy += at - span.since;
      span.last = span.last === undefined ? at : Math.max(span.last, at);
    };
  }

  /** Counts a call of `stage` that was not started: its cut-off had come. */
  notStarted(stage: StageName): void {
    this.span(stage).notStarted++;
  }

  /** Counts a call of `stage` that was stopped at its cut-off. */
  stopped(stage: StageName): void {
    this.span(stage).stopped++;
  }

  /** What `stage` has done so far. */
  counts(stage: StageName): StageCounts {
    const { calls, jevCalls, notStarted, stopped } = this.span(stage);
    return { calls, jevCalls, notStarted, stopped };
  }

  /**
   * Every stage, in the fixed order, whether it ran or not: one that never
   * ran shows 0 ms and no start or end. With each, its cut-off (ms from the
   * request's start) when one is given.
   */
  timings(cutoffs: Partial<Record<StageName, number>> = {}): StageTiming[] {
    const now = this.clock.now();
    return STAGES.map((stage) => {
      const span = this.span(stage);
      const running = span.active > 0;
      const timing: StageTiming = {
        stage,
        durationMs: span.busy + (running ? now - span.since : 0),
      };
      if (span.first !== undefined) {
        timing.startMs = span.first - this.origin;
        timing.endMs = (running ? now : span.last ?? now) - this.origin;
      }
      if (cutoffs[stage] !== undefined) timing.cutoffMs = cutoffs[stage];
      timing.calls = span.calls;
      timing.jevCalls = span.jevCalls;
      timing.notStarted = span.notStarted;
      timing.stopped = span.stopped;
      return timing;
    });
  }

  private span(stage: StageName): Span {
    let span = this.spans.get(stage);
    if (!span) {
      span = { active: 0, since: 0, busy: 0, calls: 0, jevCalls: 0, notStarted: 0, stopped: 0 };
      this.spans.set(stage, span);
    }
    return span;
  }
}
