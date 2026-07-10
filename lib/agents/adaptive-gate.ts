/**
 * Adaptive concurrency gate for the parallel scene fills.
 *
 * The founder directive: "aim for the maximum amount of simultaneous scenes."
 * A hardcoded cap (3) was a defensive guess after one z.ai overloaded_error —
 * it costs a whole extra wave of fill latency on every 5-scene build if the
 * real ceiling is higher. This gate starts at the MAXIMUM and discovers the
 * ceiling empirically instead of fearing it:
 *
 *   - starts wide open (all scenes at once, or RB_SCENE_CONCURRENCY when set)
 *   - HALVES capacity the moment any in-flight call reports an overload signal
 *     (multiplicative decrease — the TCP congestion-control move)
 *   - recovers +1 capacity per completed call (additive increase), so a single
 *     early blip doesn't doom the rest of the build to serial
 *   - never drops below 1: the build always makes progress
 *
 * Balance errors ([1113]) deliberately do NOT shrink the window — that's an
 * account state, not load; shedding concurrency can't fix it.
 */
export class AdaptiveGate {
  private inFlight = 0;
  private capacity: number;
  private waiters: Array<() => void> = [];
  /** How many times the window shrank — surfaced for telemetry/logs. */
  overloads = 0;

  constructor(
    readonly max: number,
    readonly min = 1,
  ) {
    this.capacity = Math.max(min, max);
  }

  /** Current window size (for logs/telemetry). */
  get width(): number {
    return this.capacity;
  }

  async acquire(): Promise<void> {
    while (this.inFlight >= this.capacity) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.inFlight += 1;
  }

  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.wake();
  }

  /** Multiplicative decrease on an overload signal from any in-flight call. */
  overload(): void {
    const next = Math.max(this.min, Math.floor(this.capacity / 2));
    if (next < this.capacity) {
      this.overloads += 1;
      console.warn(`[adaptive-gate] overload signal — window ${this.capacity} → ${next}`);
      this.capacity = next;
    }
  }

  /** Additive increase after a successful completion (capped at max). */
  success(): void {
    if (this.capacity < this.max) {
      this.capacity += 1;
      this.wake();
    }
  }

  private wake(): void {
    // Wake one waiter per unit of headroom. Woken tasks re-check the predicate
    // in acquire() before proceeding, so over-waking is safe; under-waking
    // would stall — hence the loop runs while headroom remains.
    let headroom = this.capacity - this.inFlight;
    while (headroom > 0 && this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      w();
      headroom -= 1;
    }
  }
}

/** Error shapes that mean "you are sending too much at once" — the only
 *  signals that should shrink the window. Balance ([1113]) excluded. */
export const isOverloadSignal = (err: unknown): boolean => {
  const msg = err instanceof Error ? `${err.message} ${String((err as Error & { cause?: unknown }).cause ?? "")}` : String(err);
  return /overloaded_error|overloaded|\[1305\]|too many concurrent|concurrency limit/i.test(msg);
};

/**
 * Order-preserving map with adaptive concurrency: at most gate.width calls in
 * flight, window shrinking/growing as the gate learns. A throwing item settles
 * to rejected — never rejects the batch (same contract as mapWithConcurrency).
 */
export const mapWithGate = async <T, R>(
  items: readonly T[],
  gate: AdaptiveGate,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> => {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  await Promise.all(
    items.map(async (item, i) => {
      await gate.acquire();
      try {
        results[i] = { status: "fulfilled", value: await fn(item, i) };
        gate.success();
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      } finally {
        gate.release();
      }
    }),
  );
  return results;
};
