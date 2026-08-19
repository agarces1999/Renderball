/**
 * SEARCH/REPLACE repairs for one section (speed playbook 2026-08-19; the
 * aider/v0-quick-edit class). A scoped gate fix rarely needs a new section —
 * it needs six lines changed in one. Re-emitting ~300 lines of TSX per fix
 * paid the full emission price and, on GLM, the full thinking tax on every
 * retry. The diff rung asks for exact SEARCH/REPLACE blocks and applies
 * them deterministically; the whole-section re-emit remains as the
 * escalation rung, and the pipeline's strict-improvement adoption gate
 * (compile + re-gate + not-worse) judges the result either way — a bad
 * diff cannot ship any more than a bad re-emit could.
 *
 * Application is ALL-OR-NOTHING per attempt, and every SEARCH must match
 * EXACTLY ONCE: an ambiguous or missing match aborts the whole attempt
 * rather than half-applying (aider's own hard-learned rule).
 */

export interface SearchReplaceBlock {
  search: string;
  replace: string;
}

const BLOCK_RE = /<{7} SEARCH\n([\s\S]*?)\n={7}\n([\s\S]*?)\n>{7} REPLACE/g;

/** Parse every well-formed block; returns [] when the output carries none. */
export const parseSearchReplaceBlocks = (text: string): SearchReplaceBlock[] => {
  const out: SearchReplaceBlock[] = [];
  let m: RegExpExecArray | null;
  BLOCK_RE.lastIndex = 0;
  while ((m = BLOCK_RE.exec(text)) !== null) {
    out.push({ search: m[1], replace: m[2] });
  }
  return out;
};

export type DiffApplyResult =
  | { ok: true; section: string; applied: number }
  | { ok: false; reason: string };

export const applySearchReplace = (
  section: string,
  blocks: SearchReplaceBlock[],
): DiffApplyResult => {
  if (blocks.length === 0) return { ok: false, reason: "no blocks" };
  let next = section;
  for (const [i, b] of blocks.entries()) {
    if (b.search.trim().length === 0) return { ok: false, reason: `block ${i}: empty search` };
    const first = next.indexOf(b.search);
    if (first < 0) return { ok: false, reason: `block ${i}: search not found` };
    if (next.indexOf(b.search, first + 1) >= 0) {
      return { ok: false, reason: `block ${i}: search is ambiguous (matches twice)` };
    }
    next = next.slice(0, first) + b.replace + next.slice(first + b.search.length);
  }
  return { ok: true, section: next, applied: blocks.length };
};

/** The prompt for a diff-rung repair attempt over one section's source. */
export const diffRepairPrompt = (
  sectionName: string,
  sectionSource: string,
  fixMessages: string[],
): string =>
  [
    `Fix the issues below in ${sectionName} by emitting SEARCH/REPLACE blocks ONLY — the smallest exact edits that fix them. Do not re-emit the section.`,
    ``,
    `## Issues`,
    ...fixMessages.map((m) => `- ${m}`),
    ``,
    `## ${sectionName} source (edit target)`,
    "```tsx",
    sectionSource,
    "```",
    ``,
    `## Output format (repeat per edit; SEARCH must copy the source EXACTLY and match exactly once)`,
    `<<<<<<< SEARCH`,
    `(exact lines from the source)`,
    `=======`,
    `(replacement lines)`,
    `>>>>>>> REPLACE`,
    ``,
    `No prose, no code fences around the blocks, nothing else.`,
  ].join("\n");
