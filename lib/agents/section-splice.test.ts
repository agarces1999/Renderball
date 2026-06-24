/**
 * Tests for section-splice — the locate/replace primitive behind per-scene
 * scoped retries. Run: `npm test` (no API key, no credits).
 *
 * The invariant that matters: replaceSection swaps exactly one section and
 * leaves every other byte (imports, module consts, sibling sections) intact,
 * and the result still compiles. A bad splice must be detectable downstream,
 * but here we lock the happy paths + the boundary cases that would silently
 * corrupt the file (wrong section, dropped neighbour, prose in the model reply).
 */
import {
  sectionRanges,
  sectionRange,
  listSectionIndices,
  extractSection,
  replaceSection,
  sceneIndexAt,
} from "./section-splice";
import { verifyCompilable } from "./code-extraction";

const PREAMBLE = `import React from "react";
import { AbsoluteFill } from "remotion";

const PALETTE = { ink: "#111", bg: "#fff", accent: "#f50" };
const FONT_DISPLAY = "Cabinet Grotesk";
`;

const S0 = `export const Section0: React.FC = () => {
  const title = "First";
  return (
    <AbsoluteFill style={{ background: PALETTE.bg, color: PALETTE.ink }}>
      <h1 style={{ fontFamily: FONT_DISPLAY }}>{title}</h1>
    </AbsoluteFill>
  );
};`;

const S1 = `export const Section1: React.FC = () => (
  <AbsoluteFill style={{ background: PALETTE.accent }}>
    <h2>Second — mentions Section0 in a comment, not a decl</h2>
  </AbsoluteFill>
);`;

const S2 = `export const Section2: React.FC = () => {
  return <AbsoluteFill><p>Third</p></AbsoluteFill>;
};`;

const FILE = `${PREAMBLE}\n${S0}\n\n${S1}\n\n${S2}\n`;

let passed = 0;
let failed = 0;
const checks: Promise<void>[] = [];
const check = (name: string, fn: () => void | Promise<void>) => {
  checks.push(
    (async () => {
      try {
        await fn();
        passed++;
        console.log(`  ✓ ${name}`);
      } catch (err) {
        failed++;
        console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : err}`);
      }
    })(),
  );
};
const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg);
};

// ── enumeration ────────────────────────────────────────────────────────
check("lists every section index in source order", () => {
  assert(
    JSON.stringify(listSectionIndices(FILE)) === "[0,1,2]",
    `got ${JSON.stringify(listSectionIndices(FILE))}`,
  );
});

check("ranges are contiguous and cover each section start", () => {
  const ranges = sectionRanges(FILE);
  assert(ranges.length === 3, "expected 3 ranges");
  // Each range starts exactly at its own `export` keyword.
  for (const r of ranges) {
    assert(
      FILE.slice(r.start).startsWith(`export const Section${r.index}`),
      `range for ${r.index} must start at its declaration`,
    );
  }
  // Range 0 ends where range 1 begins, etc.
  assert(ranges[0].end === ranges[1].start, "0.end == 1.start");
  assert(ranges[1].end === ranges[2].start, "1.end == 2.start");
  assert(ranges[2].end === FILE.length, "last range runs to EOF");
});

check("a Section name inside JSX/comments is NOT a declaration", () => {
  // S1's body mentions "Section0" in text — must not create a phantom range.
  assert(listSectionIndices(FILE).length === 3, "only real decls count");
});

// ── extraction ─────────────────────────────────────────────────────────
check("extractSection returns just the requested block", () => {
  const b = extractSection(FILE, 1);
  assert(b !== null, "Section1 must be found");
  assert(b!.startsWith("export const Section1"), "starts at Section1");
  assert(b!.includes("Second"), "has Section1's content");
  assert(!b!.includes("First"), "no Section0 bleed");
  assert(!b!.includes("Third"), "no Section2 bleed");
});

check("extractSection pulls one section out of a full-file model reply", () => {
  // Model ignored 'emit only the section' and returned the whole file — we
  // still grab exactly the section we asked for.
  const b = extractSection(FILE, 2);
  assert(b !== null && b!.includes("Third") && !b!.includes("Second"), "isolates Section2");
});

check("extractSection of a missing section is null", () => {
  assert(extractSection(FILE, 9) === null, "absent → null");
});

// ── replacement ──────────────────────────────────────────────────────────
const NEW_S1 = `export const Section1: React.FC = () => (
  <AbsoluteFill style={{ background: PALETTE.accent }}>
    <h2 style={{ fontFamily: FONT_DISPLAY }}>Second, regenerated</h2>
    <p>Now with a lede.</p>
  </AbsoluteFill>
);`;

check("replaceSection swaps only the target, neighbours intact + compiles", async () => {
  const out = replaceSection(FILE, 1, NEW_S1);
  assert(out !== null, "splice must succeed");
  assert(out!.includes("Second, regenerated"), "new content present");
  assert(out!.includes("Now with a lede."), "new content present");
  assert(!out!.includes("Second — mentions"), "old Section1 gone");
  // Neighbours and preamble untouched.
  assert(out!.includes('const PALETTE'), "preamble intact");
  assert(out!.includes("First"), "Section0 intact");
  assert(out!.includes("Third"), "Section2 intact");
  assert(JSON.stringify(listSectionIndices(out!)) === "[0,1,2]", "still 3 sections in order");
  assert((await verifyCompilable(out!)) === null, "spliced file must compile");
});

check("replaceSection accepts a fenced/prose-wrapped block via extract first", async () => {
  // Caller normally extractSection()s the model reply first; replaceSection
  // trims, so a body with trailing whitespace still splices cleanly.
  const out = replaceSection(FILE, 0, `\n${S0}\n\n`);
  assert(out !== null && (await verifyCompilable(out!)) === null, "compiles");
  assert(listSectionIndices(out!).length === 3, "section count preserved");
});

check("replacing the LAST section keeps the preamble + earlier sections", async () => {
  const NEW_S2 = `export const Section2: React.FC = () => <AbsoluteFill><p>Third v2</p></AbsoluteFill>;`;
  const out = replaceSection(FILE, 2, NEW_S2);
  assert(out !== null, "splice ok");
  assert(out!.includes("Third v2") && !out!.includes(">Third<"), "swapped last");
  assert(out!.includes("First") && out!.includes("Second"), "earlier sections kept");
  assert((await verifyCompilable(out!)) === null, "compiles");
});

check("replaceSection of a missing section is null (caller falls back)", () => {
  assert(replaceSection(FILE, 9, NEW_S1) === null, "absent → null");
});

// ── trailing top-level export (the `export const Generated` alias) ─────────
// The agents end Composition.tsx with a preview-only `export const Generated`.
// A naive last-section-runs-to-EOF range would swallow it; replacing the last
// section would then silently delete it. Section ranges must stop at the next
// top-level export so it's always preserved.
const FILE_WITH_TRAILER = `${FILE}
export const Generated: React.FC = () => (
  <><Section0 /><Section1 /><Section2 /></>
);
`;

check("the LAST section's range stops before a trailing export const", () => {
  const block = extractSection(FILE_WITH_TRAILER, 2);
  assert(block !== null, "Section2 found");
  assert(block!.includes("Third"), "has Section2 body");
  assert(!block!.includes("export const Generated"), "does NOT bleed into the trailer");
});

check("replacing the LAST section preserves the trailing export", async () => {
  const NEW_S2 = `export const Section2: React.FC = () => <AbsoluteFill><p>Third v2</p></AbsoluteFill>;`;
  const out = replaceSection(FILE_WITH_TRAILER, 2, NEW_S2);
  assert(out !== null, "splice ok");
  assert(out!.includes("Third v2"), "section swapped");
  assert(out!.includes("export const Generated"), "trailing export preserved");
  assert((await verifyCompilable(out!)) === null, "compiles");
});

check("replacing a MIDDLE section still preserves the trailing export", async () => {
  const out = replaceSection(FILE_WITH_TRAILER, 1, NEW_S1);
  assert(out !== null && out!.includes("Second, regenerated"), "middle swapped");
  assert(out!.includes("export const Generated"), "trailer untouched");
  assert(out!.includes("Third"), "Section2 untouched");
  assert((await verifyCompilable(out!)) === null, "compiles");
});

// ── a column-0 `export` INSIDE a section body must NOT split the section ───
// A dev-tool brand may render a code sample (`export const config = …`) inside
// a <pre>/template literal. The block boundary is narrow (Section{N}/Generated
// only), so such a line never truncates the section — the documented "robust
// to arbitrary content inside a section" invariant.
check("a code-sample `export` in a section body does not truncate it", async () => {
  const codeSampleScene = `export const Section1: React.FC = () => (
  <AbsoluteFill>
    <pre>{\`
export const config = { mode: "fast" };
export default config;
\`}</pre>
    <h2>Body has a column-0 export, but it's a string</h2>
  </AbsoluteFill>
);`;
  const file = `${PREAMBLE}\n${S0}\n\n${codeSampleScene}\n\n${S2}\n`;
  // The whole code-sample body must stay inside Section1's block.
  const block = extractSection(file, 1);
  assert(block !== null, "Section1 found");
  assert(block!.includes("export const config"), "code sample stays in the block");
  assert(block!.includes("export default config"), "all of the sample stays");
  assert(block!.includes("but it's a string"), "trailing JSX stays — section not truncated");
  assert(!block!.includes("Third"), "but does NOT bleed into Section2");
  // Indices unaffected: still exactly [0,1,2], not phantom-split by the sample.
  assert(JSON.stringify(listSectionIndices(file)) === "[0,1,2]", "no phantom section");
  // And a splice round-trips cleanly.
  const out = replaceSection(file, 0, S0);
  assert(out !== null && (await verifyCompilable(out!)) === null, "splice compiles");
  assert(out!.includes("export const config"), "Section1's sample survives a Section0 splice");
});

// ── offset attribution ───────────────────────────────────────────────────
check("sceneIndexAt maps an in-section offset to its scene", () => {
  const off = FILE.indexOf("Third");
  assert(sceneIndexAt(FILE, off) === 2, "offset inside Section2 → 2");
  const off1 = FILE.indexOf("Second");
  assert(sceneIndexAt(FILE, off1) === 1, "offset inside Section1 → 1");
});

check("sceneIndexAt returns null in the preamble", () => {
  const off = FILE.indexOf("PALETTE");
  assert(sceneIndexAt(FILE, off) === null, "preamble offset → null");
});

await Promise.all(checks);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
