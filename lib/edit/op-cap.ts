/**
 * Per-owner sliding-window cap for the editor's LLM operations (scene/element
 * regen). These routes check auth but not entitlement, so before this cap a
 * hostile (or runaway-scripted) account could loop regens for unbounded GLM
 * spend (launch audit P0). This is the launch-scale brake: generous enough
 * that no real editing session hits it, cheap enough to hold the line until
 * a real per-op metering policy is a product decision.
 *
 * In-process sliding window — correct for the single-container deploy of
 * record; move to Redis alongside the build lock if multi-instance.
 */

const WINDOW_MS = 60 * 60 * 1000;
const CAP = Math.max(1, Number(process.env.RB_REGEN_HOURLY_CAP) || 30);

const windows = new Map<string, number[]>();

export type OpCapResult = { allowed: true } | { allowed: false; retryAfterMin: number };

/** Record + check one regen op for `ownerId`. */
export const takeRegenSlot = (ownerId: string): OpCapResult => {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const stamps = (windows.get(ownerId) ?? []).filter((t) => t > cutoff);
  if (stamps.length >= CAP) {
    const oldest = stamps[0];
    return { allowed: false, retryAfterMin: Math.ceil((oldest + WINDOW_MS - now) / 60000) };
  }
  stamps.push(now);
  windows.set(ownerId, stamps);
  return { allowed: true };
};

/** Test-only reset. */
export const resetOpCapForTests = (): void => windows.clear();
