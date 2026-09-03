/**
 * Section-scoped revision splice: only flagged pages change; anything
 * unusable refuses so the caller falls back to the full-file path.
 */
import { sectionSpans, spliceSections } from "./splice-sections";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("splice-sections");

const page = (i: number, tag: string) =>
  `export const Section${i}: React.FC<{ script?: Script }> = () => (\n  <div style={{ position: "absolute", inset: 0 }}>\n    ${"<p>".padEnd(60, tag[0] || "x")}${tag}</p>\n    ${"<div />".repeat(40)}\n  </div>\n);\n\n`;
const deck = `import React from "react";\nimport { Piece } from "./Piece";\ntype Script = any;\nconst PALETTE = { accent: "#000" };\n\n${page(0, "zero")}${page(1, "one")}${page(2, "two")}`;

await check("spans cover the file in order", () => {
  const s = sectionSpans(deck);
  assert(s.map((x) => x.index).join(",") === "0,1,2", `got ${s.map((x) => x.index)}`);
  assert(s[2].end === deck.length, "last span runs to EOF");
});

await check("only the flagged page changes; the reply's other pages are ignored", () => {
  const reply = "Here you go:\n```tsx\n" + page(0, "ZERO-DRIFTED") + page(1, "ONE-REVISED") + "```";
  const r = spliceSections(deck, reply, [1]);
  assert(r.ok, `expected ok, got ${JSON.stringify(r)}`);
  if (!r.ok) return;
  assert(r.code.includes("ONE-REVISED"), "flagged page replaced");
  assert(!r.code.includes("ZERO-DRIFTED") && r.code.includes("zero</p>"), "unflagged page untouched even though the reply re-emitted it");
  assert(r.code.includes("two</p>"), "trailing page intact");
  assert(r.code.startsWith('import React from "react";'), "preamble intact");
  assert(sectionSpans(r.code).length === 3, "still three exports");
});

await check("a flagged page missing from the reply refuses (caller falls back)", () => {
  const r = spliceSections(deck, "```tsx\n" + page(0, "zero-again") + "```", [1]);
  assert(!r.ok && /Section1 missing/.test((r as { reason: string }).reason), `got ${JSON.stringify(r)}`);
});

await check("an implausibly small re-emission refuses", () => {
  const r = spliceSections(deck, "```tsx\nexport const Section1 = () => null;\n```", [1]);
  assert(!r.ok && /implausibly small/.test((r as { reason: string }).reason), `got ${JSON.stringify(r)}`);
});

await check("two flagged pages both replaced, in file order", () => {
  const reply = "```tsx\n" + page(2, "TWO-REVISED") + page(0, "ZERO-REVISED") + "```";
  const r = spliceSections(deck, reply, [2, 0]);
  assert(r.ok, `expected ok, got ${JSON.stringify(r)}`);
  if (!r.ok) return;
  const i0 = r.code.indexOf("ZERO-REVISED");
  const i1 = r.code.indexOf("one</p>");
  const i2 = r.code.indexOf("TWO-REVISED");
  assert(i0 > 0 && i1 > i0 && i2 > i1, "order preserved");
  assert(r.replaced.join(",") === "0,2", "replaced list sorted");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
