import type { StageTiming } from "@/types";
import type { Clock } from "./time-budget";

/**
 * The stages of one run, in the order they begin (ADR-0021). The names are
 * what `result.timings` carries.
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

type Span = { active: number; since: number; busy: number; first?: number; last?: number };

/**
 * How long each stage had work in flight. Observability only: nothing here
 * decides anything. Stages overlap (the article's searches run while the
 * claims' queries are written, and several searches run at once), so a
 * stage's duration is the time during which at least one piece of it was
 * running, not the sum of its pieces.
 */
export class StageTimer {
  private spans = new Map<string, Span>();

  constructor(
    private readonly clock: Clock,
    /** When the run started: every time is reported from here. */
    private readonly origin: number
  ) {}

  /** Marks one piece of work in `stage` as started; call what it returns when it ends. */
  begin(stage: StageName): () => void {
    const span = this.span(stage);
    const now = this.clock.now();
    if (span.active === 0) span.since = now;
    span.active++;
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

  /** Times one piece of work in `stage`. */
  async time<T>(stage: StageName, work: () => Promise<T>): Promise<T> {
    const end = this.begin(stage);
    try {
      return await work();
    } finally {
      end();
    }
  }

  /**
   * Every stage that ran, in the fixed order, with the JEV counts given for
   * it. A stage that never ran is left out rather than shown as 0 ms.
   */
  timings(jev: Partial<Record<StageName, JevCounts>> = {}): StageTiming[] {
    const timings: StageTiming[] = [];
    for (const stage of STAGES) {
      const span = this.spans.get(stage);
      if (!span || span.first === undefined) continue;
      const now = this.clock.now();
      const open = span.active > 0 ? now - span.since : 0;
      const timing: StageTiming = {
        stage,
        durationMs: span.busy + open,
        startMs: span.first - this.origin,
        endMs: (span.active > 0 ? now : span.last ?? now) - this.origin,
      };
      const counts = jev[stage];
      if (counts) {
        timing.jevCalls = counts.calls;
        timing.jevRetries = counts.retries;
        timing.jevFailures = counts.failures;
        timing.jevCutOff = counts.cutOff;
        timing.jevNotStarted = counts.notStarted;
      }
      timings.push(timing);
    }
    return timings;
  }

  private span(stage: string): Span {
    let span = this.spans.get(stage);
    if (!span) {
      span = { active: 0, since: 0, busy: 0 };
      this.spans.set(stage, span);
    }
    return span;
  }
}

/** The JEV counts shown with a stage (the dispatcher's StageCounts). */
export interface JevCounts {
  calls: number;
  retries: number;
  failures: number;
  cutOff: number;
  notStarted: number;
}
