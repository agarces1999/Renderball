/**
 * Tests for golden-scene exemplar selection + prompt block
 * (docs/QUALITY-ARCHITECTURE.md #1).
 */
import { loadExemplars, selectExemplars, exemplarPromptBlock, type Exemplar } from "./exemplars";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("exemplars");

const ex = (register: string, id = register): Exemplar => ({ id, register, notes: "n", code: `const X_${id} = 1;` });
const POOL = [ex("stat"), ex("quote"), ex("split"), ex("centered")];

check("selects by most-frequent register first, deduped, capped at 2", () => {
  const picked = selectExemplars(["quote", "stat", "stat", "split", "stat", "quote"], POOL);
  assert(picked.length === 2, `len ${picked.length}`);
  assert(picked[0].register === "stat", `first ${picked[0].register}`);
  assert(picked[1].register === "quote", `second ${picked[1].register}`);
});

check("skips undefined registers and registers with no exemplar", () => {
  const picked = selectExemplars([undefined, "full-bleed", "centered", undefined], POOL);
  assert(picked.length === 1 && picked[0].register === "centered", JSON.stringify(picked.map((p) => p.register)));
});

check("empty registers → empty selection", () => {
  assert(selectExemplars([], POOL).length === 0, "should be empty");
});

check("library on disk loads, is sanitized, and covers the register vocabulary", () => {
  const lib = loadExemplars();
  assert(lib.length >= 5, `only ${lib.length} exemplars`);
  const registers = new Set(lib.map((e) => e.register));
  for (const r of ["stat", "quote", "split", "list", "centered", "full-bleed"]) {
    assert(registers.has(r), `missing register ${r}`);
  }
  for (const e of lib) {
    assert(!/perplexity|elevenlabs|liquid ?death/i.test(e.code), `${e.id}: source brand leaked`);
    assert(!/base64,[A-Za-z0-9+/]{200}/.test(e.code), `${e.id}: un-elided data URI`);
    assert(e.code.includes("export const Section"), `${e.id}: not a Section component`);
  }
});

check("prompt block contains code fences + the never-copy injunction", () => {
  const block = exemplarPromptBlock(["stat", "stat", "quote"]);
  assert(block.includes("```tsx"), "missing code fence");
  assert(/NEVER copy/i.test(block), "missing injunction");
  assert(block.includes('register "stat"'), "missing stat exemplar");
});

check("RB_EXEMPLARS=off disables the block", () => {
  const prev = process.env.RB_EXEMPLARS;
  process.env.RB_EXEMPLARS = "off";
  try {
    assert(exemplarPromptBlock(["stat"]) === "", "should be empty when off");
  } finally {
    if (prev === undefined) delete process.env.RB_EXEMPLARS;
    else process.env.RB_EXEMPLARS = prev;
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
