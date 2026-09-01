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
import { castCall, castStream, type CastResult } from "../llm/cast-provider";

/** Live hooks for the streamed author (RB_STREAM_CRITICS, 2026-09-01).
 *  onText receives the FULL accumulated content after each delta — the
 *  stream-critics watcher wants cumulative text, and re-slicing here keeps
 *  the consumer trivially stateless about transport chunking. onAttemptStart
 *  fires before every attempt so a failed try's partial text can never leak
 *  into the next attempt's view. */
export interface AuthorStreamHooks {
  onAttemptStart: () => void;
  onText: (accumulated: string) => void;
  /** Accumulated reasoning after each thinking delta — the ceremony's live
   *  voice-over drinks from this. Optional; keep the sink FEATHER-LIGHT
   *  (probe 2026-09-01: heavy per-delta work correlates with longer
   *  completions). */
  onThinking?: (accumulated: string) => void;
}

/** True when authors go over SSE in this process (either flag or hooks). */
export const authorStreamEnabled = (): boolean => streamAlways();

/** RB_AUTHOR_STREAM=on: author over SSE even with no consumer (no-op hooks).
 *  Exists because the 2026-09-01 probe measured Fireworks serving qwen
 *  stream:true with 25-35% MORE content than the same non-streamed request —
 *  so transport choice is a MODEL-BEHAVIOR variable, and experiments that
 *  toggle stream critics must hold it constant across arms. Default off:
 *  prod behavior unchanged. */
const streamAlways = () => (process.env.RB_AUTHOR_STREAM ?? "off") === "on";

/** One author attempt over the wire: streamed when hooks are given (thinking
 *  accumulated back into the result so harness-trace parity survives — trace
 *  review is protocol), plain castCall otherwise. */
const authorWire = async (
  call: Parameters<typeof castCall>[0],
  stream?: AuthorStreamHooks,
): Promise<CastResult> => {
  if (!stream && streamAlways()) stream = { onAttemptStart: () => {}, onText: () => {} };
  if (!stream) return castCall(call);
  stream.onAttemptStart();
  let acc = "";
  let thinking = "";
  const r = await castStream(
    call,
    (delta) => {
      acc += delta;
      stream.onText(acc);
    },
    (t) => {
      thinking += t;
      try {
        stream.onThinking?.(thinking);
      } catch {
        /* the voice-over must never kill the paid stream */
      }
    },
  );
  return { ...r, thinking };
};

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

export const missingSections = (code: string, sceneCount: number, start = 0): string[] =>
  Array.from({ length: sceneCount - start }, (_, i) => `Section${start + i}`).filter(
    (name) => !new RegExp(`export const ${name}\\b`).test(code),
  );

/** Append continuation chapters to the base file. The base carries the module
 *  preamble (imports, palette, helpers) and the first sections; additions are
 *  section-only blocks. Throws on duplicate Section exports — a continuation
 *  that re-declared an earlier page would shadow it silently at runtime. */
export const mergeChapters = (base: string, additions: string[]): string => {
  const merged = [base, ...additions].join("\n\n");
  const seen = new Set<string>();
  for (const m of merged.matchAll(/export const (Section\d+)\b/g)) {
    if (seen.has(m[1])) throw new Error(`chapter merge: duplicate export ${m[1]}`);
    seen.add(m[1]);
  }
  return merged;
};

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
  /** The winning call's reasoning stream — persisted for trace review
   *  (docs/HARNESS.md: outcome data alone missed GLM being squeezed). */
  thinking: string;
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
  opts?: { onAttempt?: (a: AuthorAttempt) => void; signal?: AbortSignal; stream?: AuthorStreamHooks },
): Promise<AuthorResult> => {
  const attempts: AuthorAttempt[] = [];
  for (const author of socketOrder()) {
    for (let tryN = 0; tryN < 2; tryN++) {
      const t0 = Date.now();
      try {
        const r = await authorWire({
          system: "",
          user: pack,
          maxTokens: AUTHOR_MAX_TOKENS,
          signal: opts?.signal,
          model: author.model,
          timeoutMs: AUTHOR_TIMEOUT_MS,
          ...(author.thinkingBudget ? { effort: "high" as const, thinkingBudget: author.thinkingBudget } : {}),
        }, opts?.stream);
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
        if (!failure && code) return { code, model: author.model, attempts, thinking: r.thinking ?? "" };
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

/** Author pages [start, end) as a CONTINUATION of an existing file. The model
 *  sees the full pack (whole-outline context) plus the complete prior code, and
 *  emits ONLY its sections — no imports, no re-declared helpers. The chapter
 *  author is pinned to the model that wrote the base so the identity stays one
 *  mind's; on repeated failure the socket falls through (any model can continue
 *  given the code). */
export const authorContinuation = async (
  basePack: string,
  priorCode: string,
  start: number,
  end: number,
  pinnedModel: string,
  opts?: { onAttempt?: (a: AuthorAttempt) => void; signal?: AbortSignal },
): Promise<{ code: string; model: string; attempts: AuthorAttempt[]; thinking: string }> => {
  const prompt = `${basePack}

You have ALREADY authored the beginning of this deck — the complete file so far is below. Continue THE SAME file for pages ${start + 1} through ${end}:
- Emit ONLY \`export const Section${start}\` through \`export const Section${end - 1}\` (React.FC<{ script?: Script }>), in order.
- NO import lines, NO re-declared constants, helpers, or components — reuse everything the existing file already defines, verbatim by name.
- Same identity, same chrome, same Piece grammar (ids continue as "s${start}.p0" onward).
- Do not repeat or modify any earlier section.

\`\`\`tsx
${priorCode}
\`\`\`

Reply with ONLY the new sections in a single \`\`\`tsx block.`;
  const chain = [
    ...socketOrder().filter((a) => a.model === pinnedModel),
    ...socketOrder().filter((a) => a.model !== pinnedModel),
  ];
  const attempts: AuthorAttempt[] = [];
  for (const author of chain) {
    for (let tryN = 0; tryN < 2; tryN++) {
      const t0 = Date.now();
      try {
        const r = await castCall({
          system: "",
          user: prompt,
          maxTokens: AUTHOR_MAX_TOKENS,
          signal: opts?.signal,
          model: author.model,
          timeoutMs: AUTHOR_TIMEOUT_MS,
          ...(author.thinkingBudget ? { effort: "high" as const, thinkingBudget: author.thinkingBudget } : {}),
        });
        const code = extractDeckFile(r.text ?? "");
        const missing = code ? missingSections(code, end, start) : null;
        const redeclares = code ? /(^|\n)\s*import\s/.test(code) || missingSections(code, start).length < start : false;
        const failure = !code
          ? "no closed code fence"
          : missing && missing.length
            ? `missing exports: ${missing.join(", ")}`
            : redeclares
              ? "continuation re-declared imports or earlier sections"
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
        if (!failure && code) return { code, model: author.model, attempts, thinking: r.thinking ?? "" };
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
    `harness continuation (pages ${start + 1}-${end}): every socket model failed — ${attempts.map((a) => `${a.model.split("/").pop()}: ${a.failure}`).join(" · ")}`,
  );
};
