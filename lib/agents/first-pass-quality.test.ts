/**
 * Tests for the first-pass quality contracts (QA 2026-07-06):
 * resolveCanvasPlan (canvas always derived), findPlaceholderData
 * (masked/unresolved values), and the rewritten assessDeadAir
 * (CSS-block animations + frozen-tail + ambient exemption).
 */
import { resolveCanvasPlan } from "../crawl/brand-identity";
import { findPlaceholderData } from "./quality-gates";
import { assessDeadAir } from "./pipeline";
import type { Script } from "../../src/schema";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("first-pass-quality");

// ── resolveCanvasPlan ────────────────────────────────────────────────────────

check("crawl background wins and sets mode", () => {
  const p = resolveCanvasPlan({ background_color: "#0a051c", palette: ["#ffffff"] });
  assert(p.background === "#0a051c" && p.source === "crawl" && p.mode === "dark", JSON.stringify(p));
});

check("missing background falls back to the most background-like palette entry (Duolingo → white)", () => {
  const p = resolveCanvasPlan({ palette: ["#ffffff", "#57cc02", "#8ae21a", "#76d3fd", "#fd9403"] });
  assert(p.background === "#ffffff" && p.source === "palette" && p.mode === "light", JSON.stringify(p));
});

check("dark-extreme palette entry wins for a dark brand", () => {
  const p = resolveCanvasPlan({ palette: ["#111111", "#ff4400"] });
  assert(p.background === "#111111" && p.mode === "dark", JSON.stringify(p));
});

check("no crawl bg + only mid-tone palette → default white (never undefined)", () => {
  const p = resolveCanvasPlan({ palette: ["#888888"] });
  assert(p.background === "#ffffff" && p.source === "default", JSON.stringify(p));
  const empty = resolveCanvasPlan(undefined);
  assert(empty.background === "#ffffff" && empty.source === "default", JSON.stringify(empty));
});

// ── findPlaceholderData ──────────────────────────────────────────────────────

check("flags masked prices, $-dashes, and standalone Loading labels with section attribution", () => {
  const code = [
    'export const Section0 = () => <div><span>$•••.00</span></div>;',
    'export const Section1 = () => <div><p>Real copy</p><em>Loading</em><b>$—</b></div>;',
  ].join("\n");
  const hits = findPlaceholderData(code);
  assert(hits.length >= 3, `want ≥3 hits, got ${hits.length}: ${JSON.stringify(hits.map(h => h.token))}`);
  assert(hits.some((h) => h.section === 0 && /bullet run/.test(h.token)), "masked price in Section0");
  assert(hits.some((h) => h.section === 1 && /unresolved label/.test(h.token)), "Loading in Section1");
});

check("does NOT flag legit separators, ellipses, or Loading-substrings", () => {
  const code = [
    'export const Section0 = () => <div>',
    '  <span>Pay in 4 · Interest-free · Buyer protection</span>',
    '  <span>Recording…</span>',
    '  <LoadingScreenMock />',
    '  <span>$128.00</span>',
    "</div>;",
  ].join("\n");
  assert(findPlaceholderData(code).length === 0, JSON.stringify(findPlaceholderData(code)));
});

// ── assessDeadAir (rewritten) ────────────────────────────────────────────────

const scriptWith = (durations: number[]): Script =>
  ({
    scenes: durations.map((d, i) => ({
      label: `S${i}`,
      start_seconds: durations.slice(0, i).reduce((a, b) => a + b, 0),
      end_seconds: durations.slice(0, i + 1).reduce((a, b) => a + b, 0),
    })),
  } as unknown as Script);

check("catches a frozen tail declared in a <style> CSS block (the QA hole)", () => {
  // Unquoted CSS-block animation ending at 1.3s of a 6s scene, no ambient.
  const code = [
    "export const Section0 = () => (<><style>{`",
    "  .hero { animation: fadeRise 0.8s ease 0.5s forwards; }",
    "`}</style><div className='hero'/></>);",
  ].join("\n");
  const r = assessDeadAir(code, scriptWith([6]));
  assert(!r.ok, "should fail — last beat ends at 1.3s of 6s, no ambient");
});

check("an infinite ambient animation exempts the section", () => {
  const code = [
    "export const Section0 = () => (<><style>{`",
    "  .hero { animation: fadeRise 0.8s ease 0.5s forwards; }",
    "  .glow { animation: breathe 4s ease-in-out 1s infinite; }",
    "`}</style><div className='hero'/><div className='glow'/></>);",
  ].join("\n");
  const r = assessDeadAir(code, scriptWith([6]));
  assert(r.ok, `ambient should exempt: ${!r.ok ? (r as { error: string }).error : ""}`);
});

check("quoted inline animations whose last beat covers ≥75% pass without ambient", () => {
  const code = [
    "export const Section0 = () => (",
    '  <div style={{ animation: "fadeRise 0.6s ease 0.2s forwards" }}>',
    '    <span style={{ animation: "barGrow 1.0s ease 4.0s forwards" }} />',
    "  </div>);",
  ].join("\n");
  // last beat ends 5.0s of 6s (83%) → ok
  const r = assessDeadAir(code, scriptWith([6]));
  assert(r.ok, `coverage to 5.0s/6s should pass: ${!r.ok ? (r as { error: string }).error : ""}`);
});

check("a section with NO parseable animations and no ambient fails (was silently skipped)", () => {
  const code = "export const Section0 = () => (<div><h1>Static</h1></div>);";
  const r = assessDeadAir(code, scriptWith([6]));
  assert(!r.ok, "static section must fail");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
