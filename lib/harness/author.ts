/**
 * The author socket — one strong call, whole deck, one mind (docs/HARNESS.md §1).
 *
 * The model is a config choice, not a foundation: swap order via
 * RB_HARNESS_MODEL. Budgets are PER-MODEL, set by trace review (2026-08-27):
 * Qwen finishes with 4x headroom at 8k; GLM was truncated mid-plan at 8k and
 * needs 16k; DeepSeek completes on provider defaults with no thinking param.
 * Kimi K3 is excluded with mechanism: it plans in the content channel without
 * bound and never emits (qa/harness-lab/m2-diag-kimi-k3-fast.raw.json).
 *
 * Failure handling mirrors the measured protocol: one mechanical retry per
 * model, then fall through the socket — failure modes are model-specific, so
 * diversity beats persistence.
 */
import { castCall } from "../llm/cast-provider";

export interface HarnessAuthor {
  model: string;
  /** Fireworks thinking budget; undefined = provider default (no thinking param). */
  thinkingBudget?: number;
}

export const HARNESS_AUTHORS: HarnessAuthor[] = [
  { model: "accounts/fireworks/models/qwen3p8-max", thinkingBudget: 8000 },
  { model: "accounts/fireworks/routers/glm-5p2-fast", thinkingBudget: 16000 },
  { model: "accounts/fireworks/models/deepseek-v4-pro-0813" },
];

const AUTHOR_MAX_TOKENS = 30_000;
const AUTHOR_TIMEOUT_MS = 360_000;

/** Largest fenced code block, thinking stripped. Null when no fence closed. */
export const extractDeckFile = (raw: string): string | null => {
  const noThink = raw.replace(/<think>[\s\S]*?<\/think>/g, "");
  const blocks = [...noThink.matchAll(/```(?:tsx|typescript|jsx|ts)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  if (!blocks.length) return null;
  return blocks.reduce((a, b) => (b.length > a.length ? b : a));
};

export const missingSections = (code: string, sceneCount: number): string[] =>
  Array.from({ length: sceneCount }, (_, i) => `Section${i}`).filter(
    (name) => !new RegExp(`export const ${name}\\b`).test(code),
  );

export interface AuthorAttempt {
  model: string;
  seconds: number;
  outputTokens: number;
  ok: boolean;
  failure?: string;
}

export interface AuthorResult {
  code: string;
  model: string;
  attempts: AuthorAttempt[];
}

/** Socket order, honoring RB_HARNESS_MODEL as a pin (exact id or substring). */
export const socketOrder = (): HarnessAuthor[] => {
  const pin = process.env.RB_HARNESS_MODEL?.trim();
  if (!pin) return HARNESS_AUTHORS;
  const hit = HARNESS_AUTHORS.find((a) => a.model === pin || a.model.includes(pin));
  if (hit) return [hit, ...HARNESS_AUTHORS.filter((a) => a !== hit)];
  // An unknown pin is an explicit operator override: run it with the safe
  // default dial and keep the known socket behind it.
  return [{ model: pin, thinkingBudget: 8000 }, ...HARNESS_AUTHORS];
};

export const authorDeck = async (
  pack: string,
  sceneCount: number,
  opts?: { onAttempt?: (a: AuthorAttempt) => void },
): Promise<AuthorResult> => {
  const attempts: AuthorAttempt[] = [];
  for (const author of socketOrder()) {
    for (let tryN = 0; tryN < 2; tryN++) {
      const t0 = Date.now();
      try {
        const r = await castCall({
          system: "",
          user: pack,
          maxTokens: AUTHOR_MAX_TOKENS,
          model: author.model,
          timeoutMs: AUTHOR_TIMEOUT_MS,
          ...(author.thinkingBudget ? { effort: "high" as const, thinkingBudget: author.thinkingBudget } : {}),
        });
        const code = extractDeckFile(r.text ?? "");
        const missing = code ? missingSections(code, sceneCount) : null;
        const failure = !code
          ? "no closed code fence"
          : missing && missing.length
            ? `missing exports: ${missing.join(", ")}`
            : undefined;
        const attempt: AuthorAttempt = {
          model: author.model,
          seconds: Math.round((Date.now() - t0) / 100) / 10,
          outputTokens: r.outputTokens,
          ok: !failure,
          failure,
        };
        attempts.push(attempt);
        opts?.onAttempt?.(attempt);
        if (!failure && code) return { code, model: author.model, attempts };
      } catch (err) {
        const attempt: AuthorAttempt = {
          model: author.model,
          seconds: Math.round((Date.now() - t0) / 100) / 10,
          outputTokens: 0,
          ok: false,
          failure: String(err).slice(0, 200),
        };
        attempts.push(attempt);
        opts?.onAttempt?.(attempt);
      }
    }
  }
  throw new Error(
    `harness author: every socket model failed — ${attempts.map((a) => `${a.model.split("/").pop()}: ${a.failure}`).join(" · ")}`,
  );
};
