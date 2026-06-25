/**
 * Bounded retry for TRANSIENT network drops on a streaming LLM call.
 *
 * The SDK cannot resume a dropped stream, so we re-run the WHOLE call. This
 * mirrors the build pipeline's `streamBuildCall` contract: retry ONLY a
 * transient transport error (a connection blip — `terminated`, ECONNRESET, a
 * socket hang up, a momentary z.ai overload), NEVER a real API error (400 /
 * auth / truncation), which would just repeat. The script-generation call
 * (Agent 1) had NO such retry — a single `terminated` blip killed the whole
 * step, which cascaded into the worker re-attempting the brand for hours (the
 * 2026-06-25 generate-retry storm: ~50 calls/brand, $0 of value). z.ai drops
 * are intermittent, so the cheapest first step must survive them.
 */
const TRANSIENT_RX =
  /ETIMEDOUT|ECONNRESET|terminated|socket hang up|EPIPE|ECONNREFUSED|fetch failed|network|overloaded_error|\[operation failed\]|internal network failure/i;

export const isTransientNetErr = (err: unknown): boolean => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = err as any;
  const parts = [e?.message, e?.code, e?.cause?.message, e?.cause?.code, e?.cause?.cause?.code]
    .filter(Boolean)
    .join(" ");
  return TRANSIENT_RX.test(parts) || TRANSIENT_RX.test(String(err));
};

/**
 * Run `fn`, retrying the WHOLE call (a fresh stream) on a transient network
 * drop, up to `attempts` times with a small linear backoff. Fails FAST (rethrows
 * immediately) on a non-transient error, and rethrows the last error once
 * attempts are exhausted. `sleep` is injected so tests run without real delay.
 */
export const withTransientRetry = async <T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 3,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> => {
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      const transient = isTransientNetErr(err);
      console.warn(
        `[transient-retry] ${label}: attempt ${i}/${attempts} failed — ${
          transient ? "TRANSIENT → retrying" : "non-transient → aborting"
        }: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (i === attempts || !transient) throw err;
      await sleep(1500 * i);
    }
  }
  throw last;
};
