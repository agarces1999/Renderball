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
 * GLM rows are z.ai list price (docs.z.ai/guides/overview/pricing, fetched
 * 2026-06-24); Claude rows are Anthropic list price. The live pipeline runs
 * entirely on z.ai GLM — `glm-5.2` for every text/build/QA stage (MODELS.* in
 * lib/anthropic.ts) and `glm-5v-turbo` for the vision gate (VISION_MODEL) — so
 * those two rows price all real spend. Before this they were absent and fell
 * back to the Sonnet rate ($3/$15), which OVERSTATED GLM cost ~2-3x in
 * .data/usage.jsonl and the build report. Claude rows are kept for reference /
 * any future re-route.
 */
const RATES: Record<string, { input: number; output: number }> = {
  // z.ai GLM — the live build substrate
  "glm-5.2": { input: 1.4, output: 4.4 }, // all text/build/QA stages (MODELS.*)
  "glm-5v-turbo": { input: 1.2, output: 4.0 }, // vision gate (VISION_MODEL)
  // Anthropic — reference / fallback
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};
// Prompt-cache pricing, as multiples of the base input rate. These are
// Anthropic-calibrated (write 1.25x, read 0.10x). They are an APPROXIMATION for
// GLM — z.ai's cache-read discount is ~0.20x and its write premium differs —
// but the imprecision is small: the vision path reports zero cache tokens, and
// cache is a minor fraction of build spend. Revisit if GLM cache cost matters.
const CACHE_WRITE_MULT = 1.25;
const CACHE_READ_MULT = 0.1;

/** Cost in USD for a usage bundle on a given model. Unknown model → Sonnet rate. */
export const costUsd = (model: string, u: Usage): number => {
  const r = RATES[model] ?? RATES["claude-sonnet-4-5"];
  return (
    (u.input_tokens * r.input +
      u.output_tokens * r.output +
      u.cache_creation_input_tokens * r.input * CACHE_WRITE_MULT +
      u.cache_read_input_tokens * r.input * CACHE_READ_MULT) /
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
  cost_usd: Number(costUsd(entry.model, entry.usage).toFixed(6)),
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
  try {
    const rec = makeUsageRecord(entry);
    await fs.mkdir(path.dirname(USAGE_LOG), { recursive: true });
    await fs.appendFile(USAGE_LOG, JSON.stringify(rec) + "\n", "utf8");
  } catch (err) {
    console.warn("[usage] failed to record usage:", err);
  }
};
