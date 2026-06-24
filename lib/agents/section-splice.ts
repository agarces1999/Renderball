/**
 * Section splice — locate and replace a single `Section{N}` component inside a
 * generated Composition.tsx.
 *
 * The agents emit one file that is, structurally, `[imports + module-scope
 * consts] + [export const Section0 …] [export const Section1 …] …` — one
 * top-level export per scene, in order (build-wrapper.ts resolves them by name).
 * This module lets the pipeline regenerate ONE scene's component and graft it
 * back into the rest of the file byte-for-byte, instead of paying a full
 * whole-composition regeneration when a single scene trips a quality gate.
 *
 * It is purely positional — it keys off the `export const|function Section{N}`
 * declaration line and treats everything up to the NEXT section declaration (or
 * EOF) as that section's block. No brace/JSX/string parsing, so it is robust to
 * arbitrary content inside a section. The one assumption — sections are the
 * trailing run of top-level exports — holds for every file the design agent
 * emits; when it doesn't, callers fall back to a whole-composition retry, and
 * every spliced result is re-compiled before it can ship, so a bad splice can
 * never reach the user.
 */

// `export const Section3 …`, `export const Section3: React.FC …`, and
// `export function Section3 …` all match. Anchored to line start (m flag) so a
// `Section3` mentioned inside JSX/strings never registers as a declaration.
const SECTION_DECL_RX = /^export\s+(?:const|function)\s+Section(\d+)\b/gm;

// A section's block ends at the next BLOCK BOUNDARY: the following Section
// declaration, OR the file's trailing `export const Generated` preview alias
// (the agents always end the file with it). Ending the LAST section at EOF
// instead would make replaceSection silently drop that trailing export; keying
// off the next boundary keeps every splice content-preserving.
//
// Deliberately NARROW — only `Section{N}` / `Generated`, never any `^export`.
// A blanket `^export` boundary would truncate a section whose BODY contains a
// column-0 `export` (e.g. a code sample inside a <pre>/template literal — real
// for a dev-tool brand), breaking the "robust to arbitrary content inside a
// section" invariant. This matches exactly the same token class the section
// enumerator trusts, so it adds no new in-body-collision risk beyond
// SECTION_DECL_RX's existing (vanishingly small) one.
const BLOCK_BOUNDARY_RX =
  /^export\s+(?:const|function)\s+(?:Section\d+|Generated)\b/gm;

export interface SectionRange {
  index: number;
  /** Char offset of the `export` keyword that begins the declaration. */
  start: number;
  /** Char offset one past the section (next section's start, or EOF). */
  end: number;
}

/**
 * All `Section{N}` declarations in `code`, in source order, each with the char
 * range [start, end) covering its block (up to the next section or EOF).
 */
export const sectionRanges = (code: string): SectionRange[] => {
  const starts: { index: number; start: number }[] = [];
  SECTION_DECL_RX.lastIndex = 0;
  for (let m = SECTION_DECL_RX.exec(code); m; m = SECTION_DECL_RX.exec(code)) {
    starts.push({ index: parseInt(m[1], 10), start: m.index });
  }
  // Boundary offsets (Section decls + the trailing `Generated` alias), in
  // order. A section ends at the first boundary AFTER its own start, or EOF
  // when none follows.
  const boundaries: number[] = [];
  BLOCK_BOUNDARY_RX.lastIndex = 0;
  for (let m = BLOCK_BOUNDARY_RX.exec(code); m; m = BLOCK_BOUNDARY_RX.exec(code)) {
    boundaries.push(m.index);
  }
  return starts.map((s) => ({
    index: s.index,
    start: s.start,
    end: boundaries.find((o) => o > s.start) ?? code.length,
  }));
};

/** The [start, end) range for a specific section index, or null if absent. */
export const sectionRange = (
  code: string,
  index: number,
): SectionRange | null => sectionRanges(code).find((r) => r.index === index) ?? null;

/** The section indices present in `code`, in source order. */
export const listSectionIndices = (code: string): number[] =>
  sectionRanges(code).map((r) => r.index);

/**
 * Extract the `Section{index}` block (trimmed). Useful for pulling JUST the
 * regenerated section out of a model response that may include surrounding
 * prose or even other sections. Returns null when the section isn't present.
 */
export const extractSection = (
  code: string,
  index: number,
): string | null => {
  const r = sectionRange(code, index);
  if (!r) return null;
  return code.slice(r.start, r.end).trim();
};

/**
 * Replace the `Section{index}` block with `block`, preserving everything before
 * (imports, module consts, earlier sections) and after (later sections). The
 * new block is normalized to a trimmed body separated from neighbours by a
 * blank line. Returns null when the section isn't present (caller falls back).
 */
export const replaceSection = (
  code: string,
  index: number,
  block: string,
): string | null => {
  const r = sectionRange(code, index);
  if (!r) return null;
  const before = code.slice(0, r.start); // ends at the prior newline
  const after = code.slice(r.end);
  const body = block.trim();
  if (!after) return `${before}${body}\n`;
  return `${before}${body}\n\n${after.replace(/^\n+/, "")}`;
};

/**
 * Which section contains the char `offset`, or null if it falls outside every
 * section (e.g. in the imports / module-const preamble). Lets offset-bearing
 * gate findings (an overflowing element, a slow text entrance) be attributed to
 * the scene whose component they live in.
 */
export const sceneIndexAt = (code: string, offset: number): number | null => {
  for (const r of sectionRanges(code)) {
    if (offset >= r.start && offset < r.end) return r.index;
  }
  return null;
};
