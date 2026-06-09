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

/** USD per 1M tokens — base input/output rate per model (Anthropic list price). */
const RATES: Record<string, { input: number; output: number }> = {
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};
// Prompt-cache pricing, as multiples of the base input rate.
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
  op: string; // "generate" | "build" | ...
  model: string;
  scriptId?: string;
  url?: string;
  usage: Usage;
  cost_usd: number;
};

const USAGE_LOG = path.join(process.cwd(), ".data", "usage.jsonl");

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
    const rec: UsageRecord = {
      ts: entry.ts ?? new Date().toISOString(),
      op: entry.op,
      model: entry.model,
      ...(entry.scriptId ? { scriptId: entry.scriptId } : {}),
      ...(entry.url ? { url: entry.url } : {}),
      usage: entry.usage,
      cost_usd: Number(costUsd(entry.model, entry.usage).toFixed(6)),
    };
    await fs.mkdir(path.dirname(USAGE_LOG), { recursive: true });
    await fs.appendFile(USAGE_LOG, JSON.stringify(rec) + "\n", "utf8");
  } catch (err) {
    console.warn("[usage] failed to record usage:", err);
  }
};
