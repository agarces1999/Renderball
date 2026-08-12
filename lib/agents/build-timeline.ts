/**
 * Build phase timeline — durable timing attribution for every build.
 *
 * Born from the 2026-07-10 HubSpot timing run: the build took 57 minutes and
 * we could NOT say where they went, because the only phase boundaries lived in
 * console logs a detached dev server had discarded. The timeline records each
 * phase boundary in memory as the pipeline crosses it; run-preview-build
 * persists it as `<genDir>/build-timeline.json`, so wall-clock attribution
 * (scaffold vs fills vs gates vs vision) survives any client/log loss.
 */

export interface TimelineEvent {
  phase: string;
  at: string; // ISO timestamp
  /** Seconds since the timeline was created (= build start). */
  elapsed_s: number;
  /** Seconds since the PREVIOUS mark — the phase's own duration. */
  step_s: number;
}

export class BuildTimeline {
  private readonly t0 = Date.now();
  private last = this.t0;
  readonly events: TimelineEvent[] = [];
  private readonly onMark?: (e: TimelineEvent) => void;

  /**
   * `onMark` fires on every phase boundary — the ONE wiring point that turns
   * this from a post-mortem artifact into a live signal. run-preview-build
   * uses it to (a) surface real progress to the polling client and (b) check
   * the cooperative cancel flag, so a stop lands at the next boundary instead
   * of needing threading through every pipeline stage. It MAY THROW (that is
   * how cancellation propagates); mark() deliberately does not catch.
   */
  constructor(opts?: { onMark?: (e: TimelineEvent) => void }) {
    this.onMark = opts?.onMark;
  }

  /** Record a phase boundary. Also logs, so live consoles see it too. */
  mark(phase: string): TimelineEvent {
    const now = Date.now();
    const e: TimelineEvent = {
      phase,
      at: new Date(now).toISOString(),
      elapsed_s: +((now - this.t0) / 1000).toFixed(1),
      step_s: +((now - this.last) / 1000).toFixed(1),
    };
    this.last = now;
    this.events.push(e);
    console.warn(`[timeline] ${phase} +${e.elapsed_s}s (step ${e.step_s}s)`);
    this.onMark?.(e);
    return e;
  }

  toJSON(): { total_s: number; events: TimelineEvent[] } {
    return {
      total_s: +((Date.now() - this.t0) / 1000).toFixed(1),
      events: this.events,
    };
  }
}
