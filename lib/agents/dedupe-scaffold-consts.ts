//
// Drop duplicate TOP-LEVEL `const` declarations from an assembled composition.
//
// Task #112, witnessed live 2026-08-24 (deck 01M0T30VKCVP2TYASFSFAPVZ9N, parallel
// path): the L1 repair regenerated scene 3 and the regenerated file declared
// BRAND_WORDMARK twice at top level — the regen re-emitted a scaffold-owned const.
// A duplicate top-level const is a GUARANTEED esbuild failure, so the ladder
// recorded "did not improve", stopped honestly, and the deck shipped flagged. The
// repair mechanism was sabotaged by its own emission.
//
// Dropping the LATER duplicate is always compile-safe (the program either becomes
// valid or was invalid for other reasons too) and always semantics-preserving in
// the direction we want: the SCAFFOLD declared it first, and the scaffold is the
// design system of record.
//
// Deliberately narrow:
//   * top-level only (column 0). An indented duplicate inside a Section is legal
//     shadowing and none of our business;
//   * single-line declarations only (`const X = ...;`). A multi-line duplicate is
//     left alone — the compile still fails, exactly as today, rather than risk
//     mangling a template literal;
//   * lines inside template literals are ignored via a backtick-depth guard, so a
//     CSS string containing the text "const foo = 1;" at column 0 cannot be eaten.
//
export interface DedupeConstsResult {
  code: string;
  /** Names whose later duplicate declaration was dropped, in order encountered. */
  removed: string[];
}

const countUnescapedBackticks = (line: string): number => {
  let n = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "`" && line[i - 1] !== "\\") n++;
  }
  return n;
};

export const dedupeTopLevelConsts = (code: string): DedupeConstsResult => {
  const lines = code.split("\n");
  const seen = new Set<string>();
  const removed: string[] = [];
  const out: string[] = [];
  let inTemplate = false;
  for (const line of lines) {
    const toggles = countUnescapedBackticks(line) % 2 === 1;
    if (inTemplate) {
      out.push(line);
      if (toggles) inTemplate = false;
      continue;
    }
    const single = /^const ([A-Za-z_$][A-Za-z0-9_$]*)\s*=.*;\s*$/.exec(line);
    if (single && !toggles) {
      if (seen.has(single[1])) {
        removed.push(single[1]);
        continue; // drop the duplicate line entirely
      }
      seen.add(single[1]);
    } else {
      // A multi-line declaration OPENS here — record the name so a later
      // single-line duplicate of it is still recognised, but never drop this.
      const multi = /^const ([A-Za-z_$][A-Za-z0-9_$]*)\s*[=:]/.exec(line);
      if (multi) seen.add(multi[1]);
    }
    out.push(line);
    if (toggles) inTemplate = true;
  }
  return { code: out.join("\n"), removed };
};
