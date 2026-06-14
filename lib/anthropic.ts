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
// ALL STAGES ON OPUS 4.8 per the 2026-06-14 directive ("every step should be
// done with opus 4.8"). Previously script-gen/tweak ran Sonnet and QA/logo/
// design-language ran Haiku for cost; the user opted to trade that spend for
// uniform top-tier quality across the whole pipeline. Opus 4.8 is vision-
// capable, so the screenshot-reading stages (qaAgent, logoAgent, designLanguage)
// work unchanged. Build was briefly Fable 5 (won the 2026-06-11 A/B on taste,
// .data/ab/negative-audit.json) but Fable access was revoked on our key
// (404, anthropic.com/news/fable-mythos-access) — revisit Fable if it returns.
export const MODELS = {
  // Stage 1 — Script Generator (the storyline agent). Taste-heavy.
  scriptGenerator: "claude-opus-4-8",

  // Stage 5 — Full-build Design + Choreography pass (taste-heavy
  // composition + animation choices, plus retries when quality gates
  // fail). The commit-to-MP4 path.
  codingAgentBuild: "claude-opus-4-8",

  // Per-scene regenerate Design + Choreography pass (regenerateScene in
  // pipeline.ts — a single scene, not the full composition). Matches the
  // build path so a regenerated scene fits the rest of the composition.
  codingAgent: "claude-opus-4-8",

  // Stage 7 — QA Agent. Vision-capable, structured comparison.
  qaAgent: "claude-opus-4-8",
  // Logo-discovery agent — vision evaluation of brand-logo candidates.
  logoAgent: "claude-opus-4-8",
  // Design-language analysis — reads the brand's compositional design language
  // off a homepage screenshot (crawl-time, advisory).
  designLanguage: "claude-opus-4-8",
  // Stage 8 — Tweak Agent. Small-edit iteration.
  tweakAgent: "claude-opus-4-8",
} as const;
