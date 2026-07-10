/**
 * Process-wide z.ai ACCOUNT concurrency limiter.
 *
 * The AdaptiveGate caps fill width within ONE build; with
 * RB_MAX_CONCURRENT_BUILDS builds running, each starting at scene-count
 * width, the ACCOUNT's concurrency ceiling (z.ai's [1302] throttle) can be
 * exceeded even though every individual build behaves. This semaphore is the
 * hard ceiling across all builds in the process.
 *
 * Only per-scene FILLS are wrapped — the wide, bursty class. Their cap is
 * RB_ACCOUNT_CONCURRENCY − RESERVE, so QA gates / vision / script generation
 * / regens (all sequential per build, naturally narrow, deliberately
 * unwrapped) always have headroom and can never be starved by a fill burst.
 *
 * RB_ACCOUNT_CONCURRENCY defaults to 10 — the figure z.ai documents for
 * standard accounts (unverified for ours). Set it to the number shown in the
 * z.ai console → manage-apikey → rate-limits once read; the adaptive gate
 * still handles anything the static cap gets wrong.
 */

export class AccountLimiter {
  private inFlight = 0;
  private queue: Array<() => void> = [];

  constructor(readonly size: number) {
    if (!Number.isFinite(size) || size < 1) throw new Error(`AccountLimiter size must be ≥ 1, got ${size}`);
  }

  /** Slots currently held. */
  get held(): number {
    return this.inFlight;
  }

  /** Acquirers waiting in line. */
  get waiting(): number {
    return this.queue.length;
  }

  /** Acquire a slot (FIFO). Resolves to an idempotent release function. */
  async acquire(): Promise<() => void> {
    if (this.inFlight < this.size) {
      this.inFlight++;
    } else {
      // The releaser hands its slot DIRECTLY to the head of the queue —
      // inFlight never dips, so a latecomer can't jump the line between a
      // release and this waiter waking up.
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next();
      else this.inFlight--;
    };
  }

  /** Run fn while holding a slot; always releases, even on throw. */
  async with<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/** Slots kept free for QA/vision/script/regen traffic (never used by fills). */
const RESERVE = 2;

const accountCap = (): number => {
  const raw = Number(process.env.RB_ACCOUNT_CONCURRENCY);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 10;
};

/** The process-wide limiter every per-scene fill must hold a slot from. */
export const fillLimiter = new AccountLimiter(Math.max(1, accountCap() - RESERVE));
