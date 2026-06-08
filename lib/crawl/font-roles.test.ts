/**
 * Regression tests for classifyFontRoles (QA G2).
 *
 * Run: `npm test`. Locks the fix where a self-hosted face whose NAME collides
 * with a web-safe system font ("georgia") was crowned the display font over the
 * brand's distinctive custom face (corgi.insure → f37Bolton), forcing every
 * headline into a generic serif. No API key, no network.
 */
import { classifyFontRoles, type CrawledFont } from "./extract-brand";

const f = (family: string): CrawledFont => ({ family, src: `${family}.woff2` });

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : err}`);
  }
};
const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg);
};

// ── The bug: a system-named self-hosted serif beat the real display face ──────
check("corgi: distinctive f37Bolton wins display over self-hosted georgia", () => {
  const roles = classifyFontRoles([f("Geist"), f("georgia"), f("f37Bolton")]);
  assert(roles.display === "f37Bolton", `display: expected f37Bolton, got ${roles.display}`);
  assert(roles.body === "Geist", `body: expected Geist, got ${roles.body}`);
});

check("a self-hosted 'times new roman' loses to a distinctive custom face too", () => {
  const roles = classifyFontRoles([f("Inter"), f("Times New Roman"), f("Druk Wide")]);
  // Druk is a known display family AND distinctive → it should win.
  assert(roles.display === "Druk Wide", `expected Druk Wide, got ${roles.display}`);
});

// ── Unchanged behavior: a genuine licensed display serif still wins ───────────
check("genuine display serif (Playfair) still becomes display", () => {
  const roles = classifyFontRoles([f("Inter"), f("Playfair Display")]);
  assert(roles.display === "Playfair Display", `expected Playfair Display, got ${roles.display}`);
  assert(roles.body === "Inter", `expected Inter body, got ${roles.body}`);
});

check("licensed serifs we DON'T treat as system (Garamond) still win display", () => {
  const roles = classifyFontRoles([f("Helvetica Neue"), f("Garamond")]);
  assert(roles.display === "Garamond", `expected Garamond, got ${roles.display}`);
});

check("distinctive slab/display name (SuperClarendon) wins over the body sans", () => {
  const roles = classifyFontRoles([f("Acumin Pro"), f("SuperClarendon")]);
  assert(roles.display === "SuperClarendon", `expected SuperClarendon, got ${roles.display}`);
  assert(roles.body === "Acumin Pro", `expected Acumin Pro body, got ${roles.body}`);
});

// ── System serif with NO distinctive alternative → keep it (it's all we have) ──
check("georgia stays display when it's the only non-body face", () => {
  const roles = classifyFontRoles([f("Geist"), f("georgia")]);
  assert(roles.display === "georgia", `expected georgia (only option), got ${roles.display}`);
  assert(roles.body === "Geist", `expected Geist body, got ${roles.body}`);
});

// ── Mono + icon-font routing still hold alongside the new display logic ────────
check("mono is pulled out; display still resolves to the custom face", () => {
  const roles = classifyFontRoles([f("Geist"), f("JetBrains Mono"), f("georgia"), f("f37Bolton")]);
  assert(roles.mono === "JetBrains Mono", `expected mono JetBrains Mono, got ${roles.mono}`);
  assert(roles.display === "f37Bolton", `expected f37Bolton display, got ${roles.display}`);
  assert(roles.body === "Geist", `expected Geist body, got ${roles.body}`);
});

check("icon fonts are skipped, not routed to display", () => {
  const roles = classifyFontRoles([f("webflow-icons"), f("Geist"), f("f37Bolton")]);
  assert(roles.display === "f37Bolton", `expected f37Bolton, got ${roles.display}`);
  assert(roles.body === "Geist", `expected Geist, got ${roles.body}`);
});

// ── Degenerate input ──────────────────────────────────────────────────────────
check("single face → it's the body, display falls back to the same", () => {
  const roles = classifyFontRoles([f("Geist")]);
  assert(roles.body === "Geist", `expected Geist body, got ${roles.body}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
