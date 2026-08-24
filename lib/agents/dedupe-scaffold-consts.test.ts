//
// Scaffold-const dedupe — the #112 witnessed failure, pinned.
//
import { dedupeTopLevelConsts } from "./dedupe-scaffold-consts";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("\n▶ dedupe-scaffold-consts");

check("THE WITNESSED FAILURE: a regen re-emitting BRAND_WORDMARK compiles again", () => {
  const code = [
    `import React from "react";`,
    `const LOGO_SRC = "https://x/logo.png";`,
    `const BRAND_WORDMARK = undefined;`,
    `function Section0() { return null; }`,
    `const BRAND_WORDMARK = undefined;`, // the regen's duplicate, top level
    `function Section3() { return null; }`,
  ].join("\n");
  const r = dedupeTopLevelConsts(code);
  assert(r.removed.length === 1 && r.removed[0] === "BRAND_WORDMARK", JSON.stringify(r.removed));
  const decls = r.code.split("\n").filter((l) => l.startsWith("const BRAND_WORDMARK"));
  assert(decls.length === 1, `expected one declaration left, got ${decls.length}`);
  assert(r.code.includes("Section3"), "must not eat surrounding code");
});

check("the FIRST declaration wins — the scaffold is the system of record", () => {
  const r = dedupeTopLevelConsts(`const A = "scaffold";\nconst A = "regen";\n`);
  assert(r.code.includes(`const A = "scaffold";`) && !r.code.includes(`const A = "regen";`), r.code);
});

check("an INDENTED duplicate is legal shadowing and untouched", () => {
  const code = `const X = 1;\nfunction f() {\n  const X = 2;\n  return X;\n}\n`;
  const r = dedupeTopLevelConsts(code);
  assert(r.removed.length === 0 && r.code === code, "shadowing must survive");
});

check("a duplicate of a MULTI-LINE declaration is dropped (single-line later copy)", () => {
  const code = `const PALETTE = {\n  ink: "#111",\n} as const;\nconst PALETTE = {};\n`;
  const r = dedupeTopLevelConsts(code);
  assert(r.removed.includes("PALETTE"), JSON.stringify(r.removed));
  assert(r.code.includes(`ink: "#111"`), "the multi-line original must survive");
});

check("a later MULTI-LINE duplicate is left alone — compile fails as today, nothing mangled", () => {
  const code = `const P = { a: 1 };\nconst P = {\n  a: 2,\n};\n`;
  const r = dedupeTopLevelConsts(code);
  assert(r.removed.length === 0, "multi-line duplicates are out of scope by design");
  assert(r.code === code, "must not touch what it cannot fully parse");
});

check("text inside a TEMPLATE LITERAL is never eaten", () => {
  // A CSS string whose content happens to contain a const-looking line at column 0.
  const code = "const CSS = `\nconst FAKE = 1;\nconst FAKE = 1;\n`;\nconst REAL = 2;\n";
  const r = dedupeTopLevelConsts(code);
  assert(r.removed.length === 0, `ate template content: ${JSON.stringify(r.removed)}`);
  assert(r.code === code, "template body must be byte-identical");
});

check("no duplicates → byte-identical output", () => {
  const code = `const A = 1;\nconst B = 2;\nexport default A;\n`;
  const r = dedupeTopLevelConsts(code);
  assert(r.code === code && r.removed.length === 0, "identity when clean");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
