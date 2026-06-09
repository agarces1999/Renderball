import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "fs";
import path from "path";

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

  _client = new Anthropic({ apiKey });
  return _client;
};

/**
 * Model registry per stage, per PRODUCT.md §1038.
 * Swap-friendly: model choice is one constant per role.
 */
export const MODELS = {
  // Stage 1 — Script Generator. Taste-heavy, worth premium.
  // PRODUCT.md calls for Opus 4.7; default to Sonnet 4.5 until the
  // Week-1 bake-off picks a winner empirically.
  scriptGenerator: "claude-sonnet-4-5",

  // Stage 5 — Full-build Design + Choreography pass (taste-heavy
  // composition + animation choices, plus retries when quality gates
  // fail). The commit-to-MP4 path.
  codingAgentBuild: "claude-opus-4-8",

  // Per-scene regenerate Design + Choreography pass (regenerateScene in
  // pipeline.ts — a single scene, not the full composition). Same Opus
  // weight as the build path so a regenerated scene matches the rest of
  // the composition; it writes back into src/generated/<id>/, which the
  // MP4 render path then reuses.
  codingAgent: "claude-opus-4-8",

  // Stage 7 — QA Agent. Cheap, vision-capable, structured comparison.
  qaAgent: "claude-haiku-4-5",
  // Logo-discovery agent — vision evaluation of brand-logo candidates.
  // Uses Sonnet for taste/judgment; falls back to Haiku if cost matters.
  logoAgent: "claude-sonnet-4-5",
  // Design-language analysis — reads the brand's compositional design language
  // off a homepage screenshot (crawl-time, advisory). Haiku is vision-capable +
  // cheap and runs every crawl; bump to Sonnet if the brief reads too generic.
  designLanguage: "claude-haiku-4-5",
  // Stage 8 — Tweak Agent. Fast iteration on small edits.
  tweakAgent: "claude-sonnet-4-5",
} as const;
