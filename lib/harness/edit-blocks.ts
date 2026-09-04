/**
 * Conflict-marker edit blocks (RB_EDIT_BLOCKS, 2026-09-02).
 *
 * The probe that earned this: a two-line fix on a real 31KB deck cost 13,813
 * tokens and 62s because surgicalPatch re-emits the WHOLE file — and revision
 * pays the same tax (12.6k tokens for ≤15% changes). Worse, re-emission
 * silently drifts untouched pages (measured: the round-2 sig mismatches).
 * Anchored edits cannot touch what they do not name.
 *
 * Format: the git-conflict SEARCH/REPLACE convention (Aider's edit format —
 * the most cross-model-evidenced edit representation there is; independent
 * replication in the Diff-XYZ benchmark). We adopt the FORMAT, not any code.
 *
 * Apply contract (the whole safety story):
 *   - Each SEARCH must match the current file EXACTLY and EXACTLY ONCE.
 *   - Blocks apply sequentially (later blocks see earlier edits).
 *   - ANY failure discards the ENTIRE patch (all-or-nothing) — the caller
 *     falls back to today's full-file path, so the worst case is the status
 *     quo. Existing truth validators + render checks run after either path.
 */

export interface EditBlock {
  search: string;
  replace: string;
}

const OPEN = /^<{5,9} SEARCH\s*$/;
const MID = /^={5,9}\s*$/;
const CLOSE = /^>{5,9} REPLACE\s*$/;
const MAX_BLOCKS = 40;

/** Parse SEARCH/REPLACE blocks out of a model reply (prose/fences tolerated
 *  around blocks). Returns null when nothing parses or structure is broken —
 *  null means "fall back", never "apply something partial". */
export const parseEditBlocks = (text: string): EditBlock[] | null => {
  const lines = text.split("\n");
  const blocks: EditBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!OPEN.test(lines[i])) {
      i++;
      continue;
    }
    i++;
    const search: string[] = [];
    while (i < lines.length && !MID.test(lines[i])) {
      if (OPEN.test(lines[i]) || CLOSE.test(lines[i])) return null; // malformed nesting
      search.push(lines[i]);
      i++;
    }
    if (i >= lines.length) return null; // SEARCH never closed
    i++; // past =======
    const replace: string[] = [];
    while (i < lines.length && !CLOSE.test(lines[i])) {
      if (OPEN.test(lines[i]) || MID.test(lines[i])) return null;
      replace.push(lines[i]);
      i++;
    }
    if (i >= lines.length) return null; // block never closed
    i++; // past >>>>>>> REPLACE
    if (search.join("\n").trim().length === 0) return null; // empty anchor
    blocks.push({ search: search.join("\n"), replace: replace.join("\n") });
    if (blocks.length > MAX_BLOCKS) return null;
  }
  return blocks.length ? blocks : null;
};

export type ApplyResult = { ok: true; code: string; applied: number } | { ok: false; reason: string };

const countOccurrences = (haystack: string, needle: string): number => {
  let n = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    n++;
    at = haystack.indexOf(needle, at + 1);
  }
  return n;
};

/** All-or-nothing exact-unique application. */
export const applyEditBlocks = (code: string, blocks: EditBlock[]): ApplyResult => {
  let out = code;
  for (let i = 0; i < blocks.length; i++) {
    const { search, replace } = blocks[i];
    const hits = countOccurrences(out, search);
    if (hits === 0) return { ok: false, reason: `block ${i + 1}: SEARCH text not found` };
    if (hits > 1) return { ok: false, reason: `block ${i + 1}: SEARCH text matches ${hits} places (not unique)` };
    out = out.replace(search, () => replace);
  }
  // Byte sanity, same doctrine as the full-file path: an edit set that
  // guts the file is not a patch.
  if (out.length < code.length * 0.6) return { ok: false, reason: "edits removed >40% of the file" };
  return { ok: true, code: out, applied: blocks.length };
};

/** The output-format contract appended to patch/revise prompts — ONE
 *  definition so the two call sites can never drift (unbound-copy lesson). */
export const EDIT_BLOCKS_INSTRUCTION = `Reply with the EDITS ONLY, as one or more search/replace blocks in exactly this format:
<<<<<<< SEARCH
(exact lines copied VERBATIM from the file — whitespace included — enough lines to be unique)
=======
(the replacement lines)
>>>>>>> REPLACE
Rules: each SEARCH must be an exact, unique match in the file; make the smallest blocks that fix the problem; multiple blocks are fine; do NOT re-emit the whole file; no commentary.`;

// DEFAULT ON since 2026-09-04 (founder: "agree to build and push" on the
// page-scale fixes, after blind pairs graded the fast lane a "minimal" quality
// tax for ~120s/deck): the PATCH site only; unparseable blocks fall through to
// the full-file patch. RB_EDIT_BLOCKS=off restores the old path.
export const editBlocksEnabled = (): boolean => (process.env.RB_EDIT_BLOCKS ?? "on") === "on";
