/** The diff repair rung's parser + all-or-nothing applier. */
import { parseSearchReplaceBlocks, applySearchReplace, diffRepairPrompt } from "./section-diff";

let passed = 0; let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("section-diff (SEARCH/REPLACE rung)");

const SRC = `export const Section2 = () => (
  <div style={{ fontSize: 84, color: "red" }}>
    <h1>{c.headline}</h1>
    <p>{c.lede}</p>
  </div>
);`;

check("parses multiple well-formed blocks", () => {
  const out = parseSearchReplaceBlocks(
    `<<<<<<< SEARCH\nfontSize: 84\n=======\nfontSize: 68\n>>>>>>> REPLACE\nnoise\n<<<<<<< SEARCH\ncolor: "red"\n=======\ncolor: "blue"\n>>>>>>> REPLACE`,
  );
  assert(out.length === 2, `2 blocks, got ${out.length}`);
  assert(out[0].search === "fontSize: 84" && out[1].replace === 'color: "blue"', "contents parsed");
});

check("applies all blocks; result carries every edit", () => {
  const blocks = parseSearchReplaceBlocks(
    `<<<<<<< SEARCH\nfontSize: 84\n=======\nfontSize: 68\n>>>>>>> REPLACE\n<<<<<<< SEARCH\n<p>{c.lede}</p>\n=======\n<p className="lede">{c.lede}</p>\n>>>>>>> REPLACE`,
  );
  const r = applySearchReplace(SRC, blocks);
  assert(r.ok, "applies");
  if (r.ok) {
    assert(r.section.includes("fontSize: 68") && r.section.includes('className="lede"'), "both edits in");
    assert(!r.section.includes("fontSize: 84"), "old text gone");
  }
});

check("missing search aborts the WHOLE attempt (no half-application)", () => {
  const blocks = parseSearchReplaceBlocks(
    `<<<<<<< SEARCH\nfontSize: 84\n=======\nfontSize: 68\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nNOT PRESENT\n=======\nx\n>>>>>>> REPLACE`,
  );
  const r = applySearchReplace(SRC, blocks);
  assert(!r.ok && /not found/.test(r.ok ? "" : r.reason), `aborts: ${JSON.stringify(r)}`);
});

check("ambiguous search aborts (matches twice)", () => {
  const twice = SRC + "\n// fontSize: 84 in a comment";
  const blocks = parseSearchReplaceBlocks(`<<<<<<< SEARCH\nfontSize: 84\n=======\nfontSize: 68\n>>>>>>> REPLACE`);
  const r = applySearchReplace(twice, blocks);
  assert(!r.ok && /ambiguous/.test(r.ok ? "" : r.reason), `aborts on ambiguity: ${JSON.stringify(r)}`);
});

check("no blocks / empty search are refusals, not crashes", () => {
  assert(!applySearchReplace(SRC, []).ok, "no blocks");
  assert(!applySearchReplace(SRC, [{ search: "  ", replace: "x" }]).ok, "empty search");
});

check("prompt carries issues, source, and the exact block grammar", () => {
  const p = diffRepairPrompt("Section2", SRC, ["headline overflows"]);
  assert(p.includes("Section2") && p.includes("headline overflows") && p.includes("<<<<<<< SEARCH"), "prompt shape");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
