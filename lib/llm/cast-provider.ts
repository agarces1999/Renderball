/**
 * Cast provider — the OpenAI-wire transport for the element-cast build path.
 *
 * FIREWORKS ONLY (2026-07-23): the default cast model is the same GLM-5.2
 * fast router the parallel build runs on; the model id selects the wire, and
 * RB_CAST_MODEL can still target a Cerebras-served model for bake-offs.
 * OPT-IN ADOPTION: nothing routes here unless the caller picks the cast path
 * (RB_BUILD_MODE=cast, or runPreviewBuild's per-call buildMode override) and
 * the default model's wire has its key — RB_FIREWORKS_KEY for the Fireworks
 * default, RB_CAST_KEY for a Cerebras override; castConfigured() encodes
 * this. The parallel path remains the default engine (7ba7397: parallel won
 * the head-to-head; cast stays in the lab).
 *
 * Cerebras specifics this transport encodes (verified against their docs
 * 2026-07-13, see project memory speed-quality-pivot):
 *   - `max_completion_tokens` (not `max_tokens`): Cerebras PRE-DEBITS this
 *     value against the tokens-per-minute bucket before generating, so caps
 *     must be tight and honest — a lazy 40k cap on a 3k element starves the
 *     rest of the burst.
 *   - `reasoning_effort`: gpt-oss has a real graded dial (low/medium/high) —
 *     the doctrine's "think at the head, emit at the leaves" as literal API
 *     params. zai-glm-4.7 accepts "none" (a true off switch).
 *   - 429s are EXPECTED under burst (RPM/TPM token buckets, whichever hits
 *     first): honor retry-after, jittered backoff, bounded retries.
 */

import { noteZaiError, noteZaiSuccess } from "../zai-breaker";

export type CastEffort = "none" | "low" | "medium" | "high";

export interface CastCall {
  system: string;
  /** Single-turn prompt. Ignored when `messages` is provided. */
  user?: string;
  /**
   * Multi-turn history (Fireworks-only migration, 2026-07-23): the build
   * pipeline's repair loops feed prior output + error back as turns. When
   * present, these are sent verbatim after the system message and `user`
   * is ignored.
   */
  messages?: { role: "user" | "assistant"; content: string }[];
  /** Honest output ceiling — pre-debited against TPM. Size per workload. */
  maxTokens: number;
  effort?: CastEffort;
  /** Per-call model override (mixed casting routes hero/connector and leaf
   *  workloads to different models). Precedence: call.model → RB_CAST_MODEL →
   *  the gpt-oss-120b default. */
  model?: string;
  /** Constrain the response to syntactically-valid JSON (OpenAI-wire
   *  response_format json_object — supported by both Fireworks and Cerebras).
   *  Use for JSON-emitting stages (script head): kills the fence/typo failure
   *  class at the decoder instead of burning a ~50s repair round on it. */
  json?: boolean;
  signal?: AbortSignal;
  /** Request timeout override (default 120s). The whole-composition build
   *  passes emit tens of k tokens and need more headroom. */
  timeoutMs?: number;
}

export interface CastResult {
  text: string;
  /** Reasoning content when the serving stack returns it separately. */
  thinking: string;
  inputTokens: number;
  outputTokens: number;
  seconds: number;
  stopReason: string | null;
}

export class CastProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "CastProviderError";
  }
}

const BASE_URL = () => process.env.RB_CAST_BASE_URL || "https://api.cerebras.ai/v1";
// FIREWORKS ONLY (2026-07-23): the cast default is the same GLM-5.2 fast
// router the rest of the build runs on. RB_CAST_MODEL can still point at a
// Cerebras-served model (the id selects the wire) for bake-off experiments.
const MODEL = () => process.env.RB_CAST_MODEL || "accounts/fireworks/routers/glm-5p2-fast";
const KEY = () => process.env.RB_CAST_KEY || "";

/** The cast path is available when the DEFAULT model's wire has a key. */
export const castConfigured = (): boolean =>
  isFireworksModel(MODEL()) ? (process.env.RB_FIREWORKS_KEY || "").length > 0 : KEY().length > 0;

// ── multi-provider resolution ────────────────────────────────────────────────
// Fireworks models are namespaced ("accounts/fireworks/models/…"), so the
// model id itself selects the provider — no separate routing config needed.
// Smoke-verified on glm-5p2 (2026-07-16): `thinking: {type:"disabled"}` is a
// TRUE off switch (2.5s, zero reasoning, clean output — undocumented but
// accepted); `thinking: {enabled, budget_tokens}` separates reasoning into
// reasoning_content. `reasoning_effort` WITHOUT the thinking param leaks CoT
// into visible content on this serving — never send it bare to Fireworks.
/** Exported: cast-build sizes provider-aware token caps off it (Cerebras
 *  pre-debits max_completion_tokens against TPM; Fireworks does not). */
export const isFireworksModel = (model: string): boolean => model.startsWith("accounts/fireworks/");

interface WireConfig {
  url: string;
  key: string;
  body: (call: CastCall, model: string) => Record<string, unknown>;
}

const FIREWORKS_THINKING_BUDGETS: Record<Exclude<CastEffort, "none">, number> = {
  low: 1024,
  medium: 2048,
  high: 8192,
};

const wireFor = (model: string): WireConfig =>
  isFireworksModel(model)
    ? {
        url: "https://api.fireworks.ai/inference/v1/chat/completions",
        key: process.env.RB_FIREWORKS_KEY || "",
        body: (call, m) => ({
          model: m,
          max_tokens: call.maxTokens,
          ...(call.effort === "none"
            ? { thinking: { type: "disabled" } }
            : call.effort
              ? { thinking: { type: "enabled", budget_tokens: FIREWORKS_THINKING_BUDGETS[call.effort] } }
              : {}),
          ...(call.json ? { response_format: { type: "json_object" } } : {}),
        }),
      }
    : {
        url: `${BASE_URL()}/chat/completions`,
        key: KEY(),
        body: (call, m) => ({
          model: m,
          max_completion_tokens: call.maxTokens,
          ...(call.effort ? { reasoning_effort: call.effort } : {}),
          ...(call.json ? { response_format: { type: "json_object" } } : {}),
        }),
      };

/** Bounded, retry-after-honoring backoff for the token-bucket 429s. */
const RETRIES = 4;
const BASE_DELAY_MS = 1500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const retryDelayMs = (attempt: number, retryAfterHeader: string | null): number => {
  const retryAfter = Number(retryAfterHeader);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  // Jittered exponential: bursts that 429 together must not retry together.
  return BASE_DELAY_MS * 2 ** attempt * (0.5 + Math.random());
};

/**
 * One cast call. Non-streaming on purpose: at Cerebras speeds an element is
 * ~2s and the head ~10s — the SSE plumbing (and its failure modes) buys
 * nothing here. The 120s timeout is generous headroom over both.
 */
export const castCall = async (call: CastCall): Promise<CastResult> => {
  const model = call.model ?? MODEL();
  const wire = wireFor(model);
  if (!wire.key) {
    throw new CastProviderError(
      isFireworksModel(model)
        ? "cast provider not configured (RB_FIREWORKS_KEY missing for a Fireworks model)"
        : "cast provider not configured (RB_CAST_KEY missing)",
      null,
      false,
    );
  }
  const t0 = Date.now();
  let lastErr: CastProviderError | null = null;

  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    let res: Response;
    try {
      res = await fetch(wire.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${wire.key}`,
        },
        body: JSON.stringify({
          ...wire.body(call, model),
          messages: [
            ...(call.system ? [{ role: "system", content: call.system }] : []),
            ...(call.messages ?? [{ role: "user", content: call.user ?? "" }]),
          ],
        }),
        signal: call.signal ?? AbortSignal.timeout(call.timeoutMs ?? 120_000),
      });
    } catch (err) {
      // Network-level failure (reset, DNS, timeout): retryable within budget.
      lastErr = new CastProviderError(
        `cast transport error: ${err instanceof Error ? err.message : String(err)}`,
        null,
        true,
      );
      if (attempt < RETRIES) await sleep(retryDelayMs(attempt, null));
      continue;
    }

    if (res.status === 429 || res.status >= 500) {
      lastErr = new CastProviderError(
        `cast HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`,
        res.status,
        true,
      );
      // Report to the spend breaker BEFORE retrying: if the provider account
      // is dry, every remaining retry is a guaranteed-failing paid call.
      // noteZaiError returns true only for a genuine balance/quota error — a
      // plain 429 overload is not one — so the ladder is unaffected by
      // ordinary rate limiting.
      if (noteZaiError(lastErr)) throw lastErr;
      if (attempt < RETRIES) await sleep(retryDelayMs(attempt, res.headers.get("retry-after")));
      continue;
    }

    const j = (await res.json().catch(() => null)) as {
      error?: { message?: string };
      choices?: { message?: { content?: string; reasoning?: string; reasoning_content?: string }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    } | null;

    if (!res.ok || !j || j.error) {
      // 4xx other than 429: our request is wrong — do not burn retries on it.
      // HTTP 402 lands here, which is exactly how Fireworks says "account dry".
      const fatal = new CastProviderError(
        `cast HTTP ${res.status}: ${j?.error?.message ?? "unparseable response"}`,
        res.status,
        false,
      );
      // Only 402 means the account is dry. Reporting every non-2xx here fed
      // 400/401/403/404 into the breaker.
      if (res.status === 402) noteZaiError(fatal);
      throw fatal;
    }

    // Closes a half-open breaker. Previously the ONLY caller of
    // noteZaiSuccess was pipeline.ts's streamBuildCall, which the edit
    // endpoints and the whole cast path never touch — so the first probe
    // after a cooldown could be consumed by a regen that succeeded without
    // ever closing the circuit, latching it open until a restart.
    noteZaiSuccess();

    const msg = j.choices?.[0]?.message ?? {};
    return {
      text: msg.content ?? "",
      thinking: msg.reasoning_content ?? msg.reasoning ?? "",
      inputTokens: j.usage?.prompt_tokens ?? 0,
      outputTokens: j.usage?.completion_tokens ?? 0,
      seconds: (Date.now() - t0) / 1000,
      stopReason: j.choices?.[0]?.finish_reason ?? null,
    };
  }

  throw lastErr ?? new CastProviderError("cast call failed after retries", null, true);
};
