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
import { recordSpend } from "../spend/record";

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
  /**
   * Spend-ledger label ("outline" | "build.fill" | "gate.repair" | …).
   * Optional on purpose: the row is recorded either way, and an omitted label
   * falls back to the ambient withSpend() context and then to "unattributed".
   * A missing label must never be able to lose a row — that is how $31.17
   * went uncounted in August.
   */
  stage?: string;
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
 * nothing here.
 *
 * The 120s default was described as "generous headroom" for those numbers and
 * is nothing of the kind for every caller: on Fireworks GLM-5.2 a deck outline
 * runs 79s at the median and 185s at p95. Long callers pass timeoutMs
 * explicitly (build-client uses 600s, the script transport 300s); the default
 * only covers the short ones it was written for.
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
    // Per-ATTEMPT clock, separate from t0. A castCall can be up to 5 provider
    // requests and the ledger needs to know how long the one that died ran
    // for — an attempt that dies after 1,529s (measured, August) generated
    // something we were billed for; one that dies after 1s did not.
    const tAttempt = Date.now();
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
        // Retries stall-detect FASTER than the first attempt: a healthy call
        // answers in seconds, and the observed failure mode (Fireworks
        // accepting a request and never sending headers) is sticky across
        // identical immediate retries — journey A measured 5 × 120s = 10
        // minutes of "Starting…" for an outline whose successful attempt took
        // 3 seconds. First attempt keeps the generous window for genuinely
        // slow calls; a retry that is going to answer at all answers fast.
        // The retry gets the SAME budget as the first attempt, never less.
        // It used to halve to 60s, which is indefensible for a call whose
        // whole point on retry is to succeed: measured over 94 real outline
        // generations the median is 79s and p95 is 185s, so a 60s retry
        // window could not have completed most of them. An attempt that timed
        // out because the work is genuinely long was then given LESS time,
        // making each retry strictly less likely to land than the one before.
        signal: call.signal ?? AbortSignal.timeout(call.timeoutMs ?? 120_000),
      });
    } catch (err) {
      // Network-level failure (reset, DNS, timeout): retryable within budget.
      lastErr = new CastProviderError(
        `cast transport error: ${err instanceof Error ? err.message : String(err)}`,
        null,
        true,
      );
      // STRUCTURALLY UNOBSERVABLE SPEND. There is no Response, so there is no
      // usage object — the provider may have generated (and billed) a full
      // completion that we aborted before reading. This is not fixable by
      // better instrumentation; tokens consumed by a request whose response we
      // never read are unknowable from our side, forever. What IS fixable is
      // pretending it did not happen: record a ZERO-token marker so the count
      // and the elapsed seconds are visible, and never a fabricated estimate.
      // Same discipline as lib/agents/pipeline.ts:485, which learned it when a
      // billed stream died mid-generation. In August 29 of these fired against
      // 6 successful builds, 7 of them after >300s.
      void recordSpend({
        model,
        stage: call.stage,
        ok: false,
        tokensUnknown: true,
        latencyMs: Date.now() - tAttempt,
      });
      if (attempt < RETRIES) await sleep(retryDelayMs(attempt, null));
      continue;
    }

    // NO LEDGER ROW for 429 / 5xx / 4xx, deliberately. The provider REJECTED
    // the request rather than serving it, so nothing was generated and
    // nothing is billed; their bodies carry no usage object either way. A
    // marker row here would drown the "we paid and could not measure it"
    // count — which is the one signal on this table that has to stay
    // trustworthy — in ordinary rate limiting.
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
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        // OpenAI-wire cache reporting. Captured for the ledger (it is free
        // data and the only way to learn whether Fireworks caching is even
        // engaging on this account) but NOT discounted when pricing — see
        // lib/spend/record.ts makeSpendRow for why unverified semantics are
        // priced at the full rate.
        prompt_tokens_details?: { cached_tokens?: number };
      };
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

    // THE LEDGER WRITE. Here, not at the call site: castCall is reached from
    // ~15 modules (the Anthropic-shim, pipeline, quality-loop, cast-build,
    // script-generator, a dozen offline scripts) and every one of them would
    // otherwise have to remember. They did not — that is the measured cause of
    // August's $31.17 hole. Fire-and-forget: the user's call never waits on
    // the ledger, and recordSpend never rejects.
    void recordSpend({
      model,
      stage: call.stage,
      inputTokens: j.usage?.prompt_tokens ?? 0,
      outputTokens: j.usage?.completion_tokens ?? 0,
      cachedTokens: j.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      latencyMs: Date.now() - tAttempt,
      // A `finish_reason: "length"` completion is a real, fully billed call —
      // it is ok:true and counted, even when the caller goes on to discard it.
      ok: true,
    });

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
