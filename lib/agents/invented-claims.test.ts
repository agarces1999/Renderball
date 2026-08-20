/**
 * Invented-claims detector regression — the friend-deck incident
 * (2026-08-20): a fabricated cost table ($19,000/$24,500/$6,200 →
 * $49,700) was reported as "$49" because the digit run stopped at the
 * comma, and the table's row values lived in string literals the
 * visible-text walk never saw. The repair chased a phantom literal and
 * shipped the fabrication flagged.
 */
import { findInventedClaims } from "./pipeline";
import type { Script } from "../../src/schema";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("invented-claims detector");

const script = {
  scenes: [
    { content: { headline: "Up to $4M to multiply it.", lede: "If we land them, $500 a month.", meta: [{ label: "Next", value: "1,000" }] } },
  ],
} as unknown as Script;

check("comma-grouped currency is captured WHOLE, not split at the comma", () => {
  const code = `export const Section1 = () => (<div><span>TOTAL</span><span>$49,700</span></div>);`;
  const found = findInventedClaims(code, script, undefined, undefined, undefined);
  assert(found.includes("$49,700"), `got: ${found.join(" | ")}`);
  assert(!found.includes("$49"), "still splitting at the comma");
});

check("claim-shaped values inside STRING LITERALS are seen (mapped table rows)", () => {
  const code = `const rows = [
    { label: "Agency retainer", value: "$19,000" },
    { label: "Ad spend", value: "$24,500" },
    { label: "Creative fees", value: "$6,200" },
  ];
  export const Section1 = () => (<div>{rows.map((r) => (<div><span>{r.label}</span><b>{r.value}</b></div>))}</div>);`;
  const found = findInventedClaims(code, script, undefined, undefined, undefined);
  for (const v of ["$19,000", "$24,500", "$6,200"]) assert(found.includes(v), `missing ${v}: ${found.join(" | ")}`);
});

check("script-sourced numbers pass, comma-insensitively", () => {
  const code = `export const Section0 = () => (<div><b>$4M</b><span>$500</span><i>1,000</i></div>);`;
  const found = findInventedClaims(code, script, undefined, undefined, undefined);
  assert(found.length === 0, `false positives: ${found.join(" | ")}`);
});

check("rgba/hex color strings are never claims", () => {
  const code = `export const Section0 = () => (<div style={{ background: "rgba(79,70,229,0.9)", color: "#4f46e5" }}><span style={{ boxShadow: "0 0 0 rgba(254,243,198,1)" }}>ok</span></div>);`;
  const found = findInventedClaims(code, script, undefined, undefined, undefined);
  assert(found.length === 0, `color noise flagged: ${found.join(" | ")}`);
});

console.log(`invented-claims: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
