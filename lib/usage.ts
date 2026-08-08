/**
 * Token-usage accounting + persistence.
 *
 * Every Anthropic response already carries a `usage` object; we capture all
 * FOUR token counts (not just input/output), price them, and append one record
 * per costing operation to `.data/usage.jsonl`. That makes per-build cost
 * measurable going forward instead of estimated.
 *
 * Prompt caching matters a lot here: the design/script system prompts are large
 * and cached (`cache_control: ephemeral`), so cache READS bill at 10% of the
 * input rate and cache WRITES at 125%. Ignoring those fields overstates cost
 * several-fold — which is exactly why a measured number beats the estimate.
 */
import { promises as fs } from "fs";
import path from "path";

export type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
};

export const EMPTY_USAGE: Usage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

/** Coerce an Anthropic SDK usage object (cache fields may be null) into Usage. */
export const usageOf = (
  u:
    | {
        input_tokens?: number | null;
        output_tokens?: number | null;
        cache_creation_input_tokens?: number | null;
        cache_read_input_tokens?: number | null;
      }
    | null
    | undefined,
): Usage => ({
  input_tokens: u?.input_tokens ?? 0,
  output_tokens: u?.output_tokens ?? 0,
  cache_creation_input_tokens: u?.cache_creation_input_tokens ?? 0,
  cache_read_input_tokens: u?.cache_read_input_tokens ?? 0,
});

export const addUsage = (a: Usage, b: Usage): Usage => ({
  input_tokens: a.input_tokens + b.input_tokens,
  output_tokens: a.output_tokens + b.output_tokens,
  cache_creation_input_tokens:
    a.cache_creation_input_tokens + b.cache_creation_input_tokens,
  cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
});

/**
 * USD per 1M tokens — base input/output rate per model.
 *
 * GLM/Kimi rows are Fireworks serverless list price (docs.fireworks.ai,
 * checked 2026-07-23 — the day z.ai left the stack); Claude rows are Anthropic
 * list price. The live pipeline runs entirely on Fireworks — `glm-5.2` for
 * every text/build/QA stage (MODELS.* in lib/anthropic.ts) and kimi-k2p6 for
 * the vision gate (VISION_MODEL) — so those rows price all real spend;
 * `glm-5v-turbo` remains only to price legacy pre-pivot z.ai ledger rows.
 * A model absent here falls back to the Sonnet rate ($3/$15), which OVERSTATED
 * GLM cost ~2-3x in .data/usage.jsonl and the build report when the GLM rows
 * were missing. Claude rows are kept for reference / any future re-route.
 */
// Optional per-model cache multipliers (× the base input rate). Defaults are
// Anthropic-calibrated (write 1.25x, read 0.10x). GLM rows carry the
// provider's REAL cached-input price — Fireworks bills $0.21/M on the fast
// router; the legacy z.ai row keeps $0.26/M against $1.40 base (kept exact
// after a 2026-07-05 billing reconciliation showed the 0.10x approximation
// under-recording) — and neither provider documents a cache-WRITE premium,
// so GLM write bills at the plain input rate.
const RATES: Record<
  string,
  { input: number; output: number; cacheRead?: number; cacheWrite?: number }
> = {
  // GLM 5.2 — the live build substrate, served by FIREWORKS since 2026-07-23
  // (z.ai removed). The production default deployment is the FAST router,
  // which bills $2.10/$6.60 per M with $0.21 cached input
  // (docs.fireworks.ai/serverless/pricing, checked 2026-07-23) — 1.5× the
  // standard glm-5p2 tier ($1.40/$4.40); we pay for the serving speed. The
  // abstract "glm-5.2" row carries the FAST rate because that's what every
  // recorded stage actually runs on; castCall doesn't surface cached tokens
  // yet, so cache rows stay zero (ledger errs on overstating, never under).
  "glm-5.2": { input: 2.1, output: 6.6, cacheRead: 0.21 / 2.1, cacheWrite: 1 }, // all text/build/QA stages (fast router)
  "accounts/fireworks/routers/glm-5p2-fast": { input: 2.1, output: 6.6, cacheRead: 0.21 / 2.1, cacheWrite: 1 }, // same, wire id
  "glm-5v-turbo": { input: 1.2, output: 4.0, cacheRead: 0.26 / 1.4, cacheWrite: 1 }, // legacy z.ai vision rows
  // Fireworks vision — Kimi K2.6 (the account's one live serverless VLM,
  // probe-verified 2026-07-23). Rate is the K2-lineage estimate — TODO
  // verify against the first Fireworks invoice.
  "accounts/fireworks/models/kimi-k2p6": { input: 0.6, output: 3.0 },
  // Anthropic — reference / fallback
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};
const CACHE_WRITE_MULT = 1.25;
const CACHE_READ_MULT = 0.1;

/**
 * USD per IMAGE — the editor's image generation (lib/llm/image-provider.ts)
 * bills per image, not per token. TODO verify both rates against the first
 * Fireworks invoice: the serverless pricing page dropped its image rows when
 * image generation was deprecated (2026-06-10), so these are the last
 * published step rates, rounded UP (ledger errs on overstating, never under).
 * SDXL ≈ $0.00013/step × 30 steps; flux schnell fp8 ≈ $0.00035/step × 4.
 */
const IMAGE_RATES: Record<string, number> = {
  "accounts/fireworks/models/stable-diffusion-xl-1024-v1-0": 0.005,
  "accounts/fireworks/models/flux-1-schnell-fp8": 0.0015,
};
/** Unknown image model → the highest known rate (overstate, never under). */
const IMAGE_RATE_FALLBACK = 0.005;

/** Cost in USD for `n` generated images on a given model. */
export const imageCostUsd = (model: string, n: number): number =>
  n * (IMAGE_RATES[model] ?? IMAGE_RATE_FALLBACK);

/**
 * Was this model priced by a REAL rate row, or by a fallback?
 *
 * Both fallbacks above are silent: an unknown text model bills at the Sonnet
 * rate ($3/$15) and an unknown image model at $0.005. That is deliberate —
 * overstate, never understate — but it means a routing change to a model
 * nobody added here produces a number that LOOKS exact and is not. The spend
 * report calls this to say so out loud (lib/spend/ledger.ts integrity check)
 * instead of quietly reporting a guess as the answer.
 *
 * Exported rather than re-listing the model ids in the reporting layer: two
 * copies of the rate table is how they drift.
 */
export const isPricedModel = (model: string): boolean =>
  Object.prototype.hasOwnProperty.call(RATES, model) ||
  Object.prototype.hasOwnProperty.call(IMAGE_RATES, model);

/** Cost in USD for a usage bundle on a given model. Unknown model → Sonnet rate. */
export const costUsd = (model: string, u: Usage): number => {
  const r = RATES[model] ?? RATES["claude-sonnet-4-5"];
  const readMult = r.cacheRead ?? CACHE_READ_MULT;
  const writeMult = r.cacheWrite ?? CACHE_WRITE_MULT;
  return (
    (u.input_tokens * r.input +
      u.output_tokens * r.output +
      u.cache_creation_input_tokens * r.input * writeMult +
      u.cache_read_input_tokens * r.input * readMult) /
    1_000_000
  );
};

export type UsageRecord = {
  ts: string;
  op: string; // "generate" | "build" | "crawl" | ...
  model: string;
  scriptId?: string;
  url?: string;
  usage: Usage;
  /** Generated-image count for per-image-billed ops (all token fields 0). */
  images?: number;
  cost_usd: number;
  /** True when the operation FAILED after spending these tokens (e.g. a build
   *  whose composition didn't compile). Real billed cost — counted in totals,
   *  excluded from per-successful-build averages by the report. */
  failed?: boolean;
};

const USAGE_LOG = path.join(process.cwd(), ".data", "usage.jsonl");

/**
 * Build the record that recordUsage persists — pure, so the shape (cost math,
 * field passthrough, ts default) is unit-testable without touching disk.
 */
export const makeUsageRecord = (
  entry: Omit<UsageRecord, "ts" | "cost_usd"> & { ts?: string },
): UsageRecord => ({
  ts: entry.ts ?? new Date().toISOString(),
  op: entry.op,
  model: entry.model,
  ...(entry.scriptId ? { scriptId: entry.scriptId } : {}),
  ...(entry.url ? { url: entry.url } : {}),
  usage: entry.usage,
  ...(entry.images ? { images: entry.images } : {}),
  cost_usd: Number(
    (costUsd(entry.model, entry.usage) + imageCostUsd(entry.model, entry.images ?? 0)).toFixed(6),
  ),
  ...(entry.failed ? { failed: true } : {}),
});

/**
 * Append one usage record to `.data/usage.jsonl`. Best-effort: usage logging
 * must NEVER break a build, so every error is swallowed (warned, not thrown).
 * `cost_usd` is computed + stored at write time so report tooling needs no
 * pricing logic of its own.
 */
export const recordUsage = async (
  entry: Omit<UsageRecord, "ts" | "cost_usd"> & { ts?: string },
): Promise<void> => {
  // Unit tests drive real orchestrators (insert-element) whose spend paths call
  // this — let them opt out so test runs never write phantom rows to the ledger.
  if (process.env.RB_USAGE_DISABLE === "1") return;
  try {
    const rec = makeUsageRecord(entry);
    await fs.mkdir(path.dirname(USAGE_LOG), { recursive: true });
    await fs.appendFile(USAGE_LOG, JSON.stringify(rec) + "\n", "utf8");
  } catch (err) {
    console.warn("[usage] failed to record usage:", err);
  }
};
