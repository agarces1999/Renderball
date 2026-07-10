import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "fs";
import path from "path";
import { Agent } from "undici";

/**
 * Singleton Anthropic client. Reads ANTHROPIC_API_KEY from env at first call.
 *
 * Lazy-init: don't construct at module load. Next.js may import this
 * file during build, when env vars aren't always populated.
 *
 * Why the fallback to .env.local: Claude Desktop sets
 * ANTHROPIC_API_KEY="" (empty string) in child-process env. Next.js
 * prefers process.env over .env.local, so the empty string wins and
 * the file value is ignored. This fallback re-reads .env.local
 * directly when process.env is missing or blank.
 */
let _client: Anthropic | null = null;

const readEnvLocalKey = (): string | undefined => {
  try {
    const content = readFileSync(
      path.join(process.cwd(), ".env.local"),
      "utf-8",
    );
    const match = content.match(/^ANTHROPIC_API_KEY=(.+)$/m);
    const value = match?.[1].trim();
    // Strip optional surrounding quotes — dotenv-compatible parsing.
    if (value && /^["'].*["']$/.test(value)) {
      return value.slice(1, -1);
    }
    return value || undefined;
  } catch {
    return undefined;
  }
};

export const getAnthropic = (): Anthropic => {
  if (_client) return _client;

  // Trim because empty strings and whitespace-only values count as unset.
  let apiKey = process.env.ANTHROPIC_API_KEY?.trim();

  if (!apiKey) {
    apiKey = readEnvLocalKey();
  }

  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it to .env.local or export it in your shell.",
    );
  }

  // ANTHROPIC_BASE_URL points the SDK at z.ai's Anthropic-compatible endpoint
  // (GLM 5.2 — the build model). Read from .env.local too: Claude Desktop blanks
  // process.env so the key is read from the file (above), and the base URL must
  // use the same fallback or the SDK silently hits api.anthropic.com.
  // Read .env.local FIRST: the host env (Claude Desktop) bakes
  // ANTHROPIC_BASE_URL=https://api.anthropic.com into process.env, and Next
  // gives process.env precedence over .env.local — so a process.env-first read
  // would always pick Anthropic and ignore the z.ai override. .env.local is the
  // experiment's source of truth here.
  let baseURL: string | undefined;
  try {
    const content = readFileSync(path.join(process.cwd(), ".env.local"), "utf-8");
    const m = content.match(/^ANTHROPIC_BASE_URL=(.+)$/m);
    let v = m?.[1]?.trim();
    if (v && /^["'].*["']$/.test(v)) v = v.slice(1, -1);
    baseURL = v || undefined;
  } catch { /* no .env.local */ }
  if (!baseURL) baseURL = process.env.ANTHROPIC_BASE_URL?.trim() || undefined;
  // Production boot assertion (launch audit): the stack is GLM-only — a
  // missing ANTHROPIC_BASE_URL makes the SDK silently target api.anthropic.com
  // with a z.ai key, and every build fails with a confusing upstream auth
  // error. Fail loudly and instantly instead.
  if (!baseURL && process.env.NODE_ENV === "production") {
    throw new Error(
      "ANTHROPIC_BASE_URL is not set — production requires the z.ai endpoint (the stack is GLM-only). Set it in the deploy environment.",
    );
  }
  // Partial key material does not belong in production stdout/log aggregation.
  if (process.env.NODE_ENV !== "production") {
    console.warn(`[anthropic] client baseURL=${baseURL ?? "(default anthropic)"} keyTail=${apiKey.slice(-4)}`);
  }
  // GLM/z.ai reliability (LOCAL): long client timeout (z.ai recommends ~50min)
  // so a slow max-effort generation isn't aborted by the SDK, and maxRetries so
  // a transient connection abort (undici idle ETIMEDOUT mid-stream) is retried
  // rather than failing the whole build. Harmless on Anthropic too.
  //
  // Transport hardening for the ~38-min mid-stream `read ETIMEDOUT` on long GLM
  // streams. That error is a KERNEL TCP read-timeout on a dead ESTABLISHED
  // socket (NOT z.ai timing us out, NOT undici's app-timer — those throw named
  // UND_ERR_* errors; verified via the transport investigation). Node's global
  // fetch (undici) defaults to a lax 60s TCP keepalive + a 300s inter-chunk
  // body timeout, so a long quiet stretch lets an egress NAT/middlebox drop the
  // idle flow and the kernel later reaps the socket. This dispatcher — scoped to
  // THIS client only (NOT setGlobalDispatcher, so unrelated R2/Stripe/Next
  // fetches keep stock behavior) — sends keepalive probes every ~10s to hold the
  // flow-table entry warm and detect a dead path fast, and disables the 300s
  // body timer so a genuinely long silent thinking stretch can't trip it.
  // streamBuildCall (pipeline.ts) stays as the backstop: the SDK cannot retry a
  // post-headers mid-stream drop, so retry is the only thing that recovers one.
  // NOTE: keepalive is a (well-reasoned but unproven) bet on idle-NAT eviction;
  // streamBuildCall logs the err.cause chain so we can confirm whether this
  // actually reduces drop frequency over the coming builds.
  const zaiDispatcher = new Agent({
    connect: { keepAlive: true, keepAliveInitialDelay: 10_000 },
    bodyTimeout: 0,
    headersTimeout: 10 * 60_000,
    keepAliveTimeout: 60 * 60_000,
    keepAliveMaxTimeout: 60 * 60_000,
  });
  _client = new Anthropic({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    timeout: 3_000_000,
    maxRetries: 2,
    fetchOptions: { dispatcher: zaiDispatcher },
  });
  return _client;
};

/**
 * Model registry per stage, per PRODUCT.md §1038.
 * Swap-friendly: model choice is one constant per role.
 */
// EVERY STAGE ON GLM 5.2 via z.ai's Anthropic-compatible endpoint
// (ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic, key in .env.local). This
// is the production build model: Fable 5 won the 2026-06-11 taste A/B but its
// access was revoked (404), and Opus is no longer used for builds — GLM 5.2 is
// the model, full stop (revisit only if Fable access returns). GLM is reached
// through the same SDK client; the call contract differs from Anthropic's and
// is captured in BUILD_REASONING / BUILD_MAX_TOKENS below.
export const MODELS = {
  scriptGenerator: "glm-5.2",
  codingAgentBuild: "glm-5.2",
  codingAgent: "glm-5.2",
  qaAgent: "glm-5.2",
  logoAgent: "glm-5.2",
  designLanguage: "glm-5.2",
  tweakAgent: "glm-5.2",
} as const;

/**
 * Vision model for the QA gate (and, as a follow-up, the crawl's logo/palette
 * vision). GLM-5V-Turbo is z.ai's multimodal model built to "examine rendered
 * output and identify discrepancies" — validated 2026-06-21 to read our scene
 * screenshots accurately (0 false positives on 5 good builds, and it correctly
 * caught a deliberate color mismatch). The text GLM models (glm-5.2 etc.) are
 * NOT vision-capable.
 *
 * CRITICAL: vision calls MUST go through z.ai's NATIVE endpoint via
 * lib/render/zai-vision.ts — the Anthropic-compatible endpoint that
 * getAnthropic() targets silently DROPS image blocks, so images sent through the
 * SDK client are invisible to the model.
 */
export const VISION_MODEL = "glm-5v-turbo";

/**
 * Reasoning + output config for the build/composition calls on GLM 5.2 (z.ai).
 *
 * GLM controls reasoning with `thinking.type` (`enabled`|`disabled`) plus a
 * separate `reasoning_effort` — NOT Anthropic's `thinking:{type:"adaptive"}`,
 * which z.ai silently IGNORES. Sending `adaptive` left reasoning off and GLM
 * returned an empty/truncated composition (the ~984-token / 95-token-preamble
 * failures); switching to the GLM-native pair fixed it. `"max"` effort is
 * z.ai's recommendation for coding and matches the "don't cap the thinking"
 * directive. `max_tokens` is GLM 5.2's 131072 output ceiling.
 *
 * Spread into every messages.stream() on the build path so there's ONE source
 * of truth. Typed `any` because `reasoning_effort` isn't in the Anthropic SDK's
 * param surface — z.ai accepts it as an extra field on the wire, and spreading
 * an `any` keeps the call-site object literals type-clean.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const BUILD_REASONING: any = {
  thinking: { type: "enabled" },
  // OVERNIGHT BATCH (local): "high", not "max". At "max" a single build does not
  // converge inside 2h on GLM (design + scoped/whole-comp retries + render-truth,
  // each call ~18min) — zero builds completed. "high" keeps strong reasoning but
  // lets builds finish so the multi-brand loop can actually run. Production
  // default is "max"; revisit per the wall-time finding.
  reasoning_effort: "high",
};
/** GLM 5.2 max output tokens (z.ai ceiling). */
export const BUILD_MAX_TOKENS = 131072;
