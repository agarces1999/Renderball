import { castCall } from "./cast-provider";
import type { CastEffort } from "./cast-provider";

/**
 * Fireworks build client (2026-07-23: z.ai is OUT, Fireworks only).
 *
 * A drop-in stand-in for the Anthropic SDK's `client.messages` surface as the
 * build pipeline uses it — `.stream(params, opts).finalMessage()` — backed by
 * the OpenAI-wire castCall transport pointed at Fireworks. The pipeline's call
 * sites (design/animation passes, scene regen, compile fixes, piece
 * generate/regen) keep their exact shape; only the client construction line
 * changes from getAnthropic() to getBuildClient().
 *
 * Model mapping: the abstract MODELS.* names ("glm-5.2") stay in the call
 * sites and the usage ledger (pricing continuity); this shim resolves them to
 * the Fireworks deployment — same model family, faster serving, same list
 * price ($1.40/$4.40 per M).
 *
 * Reasoning mapping (Fireworks GLM smoke findings, cast-provider.ts):
 *   - params.thinking {type:"disabled"}      → effort "none" (true off switch)
 *   - params.thinking {type:"enabled"} + reasoning_effort high|max → "high"
 *     (medium → "medium", low → "low")
 *   - NO thinking param at all → "none". On z.ai, omission meant
 *     provider-default thinking; the sites that omit it (surgical compile fix,
 *     piece generate/regen) all WANT transcribe-and-patch speed — "think at
 *     the head, emit at the leaves" — so omission maps to the explicit off
 *     switch here. Never send bare reasoning_effort to Fireworks (leaks CoT
 *     into content).
 */

/** The Fireworks deployment every abstract build-model name resolves to. */
export const FIREWORKS_BUILD_MODEL = (): string =>
  process.env.RB_BUILD_MODEL || "accounts/fireworks/models/qwen3p8-max";

type ContentBlock = { type: string; text?: string; [key: string]: unknown };
type MessageContent = string | ContentBlock[];

interface StreamParams {
  model: string;
  max_tokens: number;
  system?: string | ContentBlock[];
  messages: { role: "user" | "assistant"; content: MessageContent }[];
  thinking?: { type?: string };
  reasoning_effort?: string;
  // cache_control etc. arrive inside system blocks — flattened away (no
  // Anthropic-style prompt caching on the OpenAI wire).
  [key: string]: unknown;
}

/** The subset of Anthropic's Message shape the pipeline reads. */
export interface BuildMessage {
  content: { type: "text"; text: string }[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
  stop_reason: string | null;
}

const flatten = (content: MessageContent | undefined): string => {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n\n");
};

const resolveEffort = (params: StreamParams): CastEffort => {
  if (params.thinking?.type === "disabled") return "none";
  if (params.thinking?.type === "enabled") {
    const e = params.reasoning_effort;
    if (e === "low") return "low";
    if (e === "medium") return "medium";
    return "high"; // "high", "max", or unspecified depth on an enabled dial
  }
  return "none"; // omission = the transcribe-and-patch sites — explicit off
};

const resolveModel = (model: string): string =>
  model.startsWith("accounts/fireworks/") ? model : FIREWORKS_BUILD_MODEL();

export const getBuildClient = () => ({
  messages: {
    stream(params: StreamParams, opts?: { timeout?: number }) {
      const finalMessage = async (): Promise<BuildMessage> => {
        const r = await castCall({
          system: flatten(params.system),
          messages: params.messages.map((m) => ({
            role: m.role,
            content: flatten(m.content),
          })),
          maxTokens: params.max_tokens,
          effort: resolveEffort(params),
          model: resolveModel(params.model),
          // Build passes emit whole compositions — default to generous
          // headroom; honor an explicit per-call timeout when given.
          timeoutMs: opts?.timeout ?? 600_000,
        });
        return {
          content: [{ type: "text", text: r.text }],
          usage: {
            input_tokens: r.inputTokens,
            output_tokens: r.outputTokens,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          stop_reason: r.stopReason,
        };
      };
      return { finalMessage };
    },
  },
});

export type BuildClient = ReturnType<typeof getBuildClient>;
