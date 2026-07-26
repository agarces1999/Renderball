import { strict as assert } from "assert";
import {
  assertSafeComposition,
  checkComposition,
  sandboxedRequire,
  UnsafeCompositionError,
} from "./code-guard";

/**
 * The composition guard is the only thing standing between LLM-authored code
 * and a real `require` in the app process. Two properties matter equally:
 * it must block host access, and it must NOT reject legitimate compositions —
 * a false positive fails a paid build. The false-negative direction is tested
 * with the payloads an injected prompt would plausibly produce; the
 * false-positive direction with the shapes real builds actually contain.
 */

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void) => tests.push([name, fn]);

/* ── blocks host access ─────────────────────────────────────────────── */

const PAYLOADS: Array<[string, string]> = [
  ["require()", 'export const S = () => {require("child_process"); return null;};'],
  ["dynamic import", 'export const S = () => {import("fs"); return null;};'],
  ["eval", 'export const S = () => {eval("x"); return null;};'],
  ["Function ctor", 'export const S = () => {new Function("return 1")(); return null;};'],
  ["process.env", "export const S = () => <p>{process.env.DATABASE_URL}</p>;"],
  ["process[]", 'export const S = () => <p>{process["env"]}</p>;'],
  ["globalThis", "export const S = () => {globalThis.x = 1; return null;};"],
  ["__proto__", "export const S = () => {({}).__proto__.x = 1; return null;};"],
  ["constructor[]", 'export const S = () => {({}).constructor["constructor"]; return null;};'],
  ["node: specifier", 'import cp from "node:child_process";\nexport const S = () => null;'],
  ["child_process word", 'const m = "child_process";\nexport const S = () => null;'],
  ["bare node builtin", 'import fs from "fs";\nexport const S = () => null;'],
  ["unknown package", 'import x from "left-pad";\nexport const S = () => null;'],
];

for (const [label, src] of PAYLOADS) {
  test(`blocks ${label}`, () => {
    assert.throws(() => assertSafeComposition(src), UnsafeCompositionError, label);
  });
}

/* ── allows what real builds contain ────────────────────────────────── */

test("allows the allowlisted render surface", () => {
  const src = [
    'import React from "react";',
    'import { BarChart, Bar } from "recharts";',
    'import { ArrowRight } from "lucide-react";',
    'import { siGithub } from "simple-icons/icons";',
    'import { AbsoluteFill } from "remotion";',
    'import { Lottie } from "@remotion/lottie";',
    'import { Piece } from "./Piece";',
    'import { BrandChrome } from "./BrandChrome";',
    "export const S = () => <AbsoluteFill><BarChart><Bar /></BarChart></AbsoluteFill>;",
  ].join("\n");
  assert.equal(checkComposition(src).safe, true);
});

test("allows a rendered code block whose DATA contains import/from tokens", () => {
  // Real builds render fake source listings; the highlighter data carries the
  // literal tokens "import" and "from". This shape produced a false positive
  // in the first cut of the extractor.
  const src = [
    'import React from "react";',
    "const CODE_LINES: { tokens: { t: string; c: string }[] }[] = [",
    '  { tokens: [{ t: "import", c: "#c678dd" }, { t: " x ", c: "#abb" }] },',
    '  { tokens: [{ t: "from", c: "#c678dd" }, { t: \' "./auth"\', c: "#98c" }] },',
    "];",
    "export const S = () => <pre>{JSON.stringify(CODE_LINES)}</pre>;",
  ].join("\n");
  assert.equal(checkComposition(src).safe, true);
});

test("allows prose containing the word process", () => {
  const src =
    'import React from "react";\nexport const S = () => <p>Our process is fast — processing in minutes.</p>;';
  assert.equal(checkComposition(src).safe, true);
});

test("allows subpaths of allowlisted packages", () => {
  const src = 'import { x } from "simple-icons/icons";\nexport const S = () => null;';
  assert.equal(checkComposition(src).safe, true);
});

/* ── the runtime jail ───────────────────────────────────────────────── */

test("sandboxedRequire resolves only the allowlist", () => {
  const real = ((m: string) => ({ mod: m })) as unknown as NodeRequire;
  const jailed = sandboxedRequire(real);
  assert.deepEqual(jailed("react"), { mod: "react" });
  assert.deepEqual(jailed("recharts"), { mod: "recharts" });
  assert.deepEqual(jailed("simple-icons/icons"), { mod: "simple-icons/icons" });
  for (const bad of ["child_process", "fs", "node:fs", "http", "net", "../../secrets"]) {
    assert.throws(() => jailed(bad), UnsafeCompositionError, bad);
  }
});

test("checkComposition reports instead of throwing", () => {
  const r = checkComposition('import fs from "fs";', "x");
  assert.equal(r.safe, false);
  if (!r.safe) assert.equal(r.reason, "disallowed-import");
});

let pass = 0;
let fail = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    pass++;
  } catch (err) {
    console.error(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`);
    fail++;
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
