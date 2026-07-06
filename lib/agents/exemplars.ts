/**
 * Golden-scene exemplars — QUALITY-ARCHITECTURE.md #1 (first-pass yield).
 *
 * Curated, gate-clean scenes extracted from approved builds and SANITIZED
 * (base64 data-URIs elided, source brand names swapped to Acme variants), keyed
 * by scene register. 1-2 are injected into the design prompt as worked examples:
 * models imitate structure from examples far better than they follow the same
 * rules as prose (the "600 lines of HARD RULES" problem the red-team confirmed).
 *
 * Guardrails from the red-team:
 * - sanitized so they teach STRUCTURE, never content (the prompt block repeats
 *   the injunction — copy/colors/motifs must come from THIS brand, not the example);
 * - capped at MAX_EXEMPLARS per build (prompt size: each is ~5-7KB);
 * - RB_EXEMPLARS=off is the kill switch (rollback = config revert).
 */
import { readFileSync } from "fs";
import path from "path";

export interface Exemplar {
  id: string;
  register: string;
  notes: string;
  code: string;
}

const MAX_EXEMPLARS = 2;

let cache: Exemplar[] | null = null;
export const loadExemplars = (): Exemplar[] => {
  if (cache) return cache;
  try {
    cache = JSON.parse(
      readFileSync(path.join(process.cwd(), "lib", "agents", "exemplars", "exemplars.json"), "utf8"),
    ) as Exemplar[];
  } catch (err) {
    console.warn("[exemplars] library unavailable:", err instanceof Error ? err.message : err);
    cache = [];
  }
  return cache;
};

/**
 * Pick up to MAX_EXEMPLARS for a script: most-frequent registers first (that's
 * where imitation pays most), deduped by register, deterministic order.
 */
export const selectExemplars = (
  registers: (string | undefined)[],
  pool: Exemplar[] = loadExemplars(),
): Exemplar[] => {
  const counts = new Map<string, number>();
  for (const r of registers) if (r) counts.set(r, (counts.get(r) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([r]) => r);
  const out: Exemplar[] = [];
  for (const r of ranked) {
    const ex = pool.find((e) => e.register === r);
    if (ex) out.push(ex);
    if (out.length >= MAX_EXEMPLARS) break;
  }
  return out;
};

/** The prompt block. Empty string when disabled or nothing matched. */
export const exemplarPromptBlock = (registers: (string | undefined)[]): string => {
  if (process.env.RB_EXEMPLARS === "off") return "";
  const picked = selectExemplars(registers);
  if (picked.length === 0) return "";
  const parts: string[] = [
    "## Worked exemplars (structure reference ONLY)",
    "The sections below are real, gate-clean scenes from prior builds — study their COMPOSITION: how they fill the frame top-to-bottom, keep copy clear of mocks, give every element an anchor, and pair text with substantive structure. They are sanitized (brand → \"Acme\").",
    "**NEVER copy their text, colors, brand names, or motifs — every visible choice must come from THIS brand's palette, fonts, and content.** Imitate the structural quality, not the surface.",
  ];
  for (const ex of picked) {
    parts.push("", `### Exemplar — register "${ex.register}" (${ex.notes})`, "```tsx", ex.code.trim(), "```");
  }
  return parts.join("\n");
};
