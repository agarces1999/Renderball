//
// Literal text editing, tested against the pieces that actually shipped.
//
// The bug: clicking the footer of scene 1 in deck 01M0MX7ZJ8SBNMF3D1G6P99G7M returned
// "No editable text found in this piece". The piece is full of visible text — "The
// method", "Stay in the tool", "Opinionated by default" — every word of it a hardcoded
// JSX literal bound to nothing, so the content model could not see it and the message
// was accurate. 240 of 1,405 stored pieces (17%) are in that state.
//
// Fixtures below are verbatim from src/generated. The ambiguity case is the one that
// matters most: a literal rendered N times through `.map()` must be REFUSED, because
// patching it would rewrite every copy from one edit.
//
import { patchLiteral, countLiteral, literalSpans } from "./piece-literal";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("\n▶ piece-literal");

/** Verbatim from 01M0MX7ZJ8SBNMF3D1G6P99G7M/lego/pieces/s1.meta.tsx — the reported bug. */
const META = `
        <div style={{ position: "absolute", left: 80, bottom: 64, width: 1760, display: "flex" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: PALETTE.accent }} />
            <span style={{ fontFamily: FONT_MONO, fontSize: 13, color: PALETTE.ink, opacity: 0.6 }}>The method</span>
          </div>
          <div style={{ display: "flex", gap: 56, alignItems: "center" }}>
            <div>
              <div style={{ fontFamily: FONT_MONO, fontSize: 11, opacity: 0.45, marginBottom: 4 }}>Principle</div>
              <div style={{ fontFamily: FONT_DISPLAY, fontSize: 16, fontWeight: 600, opacity: 0.82 }}>Stay in the tool</div>
            </div>
            <div>
              <div style={{ fontFamily: FONT_MONO, fontSize: 11, opacity: 0.45, marginBottom: 4 }}>Posture</div>
              <div style={{ fontFamily: FONT_DISPLAY, fontSize: 16, fontWeight: 600, opacity: 0.82 }}>Opinionated by default</div>
            </div>
          </div>
        </div>`;

/** Verbatim shape from 01KW006K8D5HYJ8CQB3XT4QMKW/lego/pieces/s0.meta.tsx — loop-rendered. */
const MAPPED = `
        <div style={{ display: "flex", gap: 80 }}>
          {c.meta?.map((m, i) => (
            <div key={i} style={{ display: "flex", flexDirection: "column" }}>
              <div style={{ fontSize: 11, color: PALETTE.grayMid }}>{m.label}</div>
              <div style={{ fontSize: 18, fontWeight: 600 }}>{m.value}</div>
            </div>
          ))}
        </div>`;

check("the reported bug: 'Stay in the tool' is found and replaced", () => {
  const r = patchLiteral(META, { oldText: "Stay in the tool", newText: "Ship it daily", occurrence: 0, total: 1 });
  assert(r.ok, `expected a patch, got ${JSON.stringify(r)}`);
  if (!r.ok) return;
  assert(r.body.includes("Ship it daily"), "new text missing");
  assert(!r.body.includes("Stay in the tool"), "old text still present");
  // Every sibling literal untouched.
  for (const other of ["The method", "Principle", "Posture", "Opinionated by default"]) {
    assert(r.body.includes(other), `clobbered a sibling literal: ${other}`);
  }
});

check("surrounding markup and indentation survive byte-for-byte", () => {
  const r = patchLiteral(META, { oldText: "Principle", newText: "Rule", occurrence: 0, total: 1 });
  assert(r.ok, "expected a patch");
  if (!r.ok) return;
  assert(r.body === META.replace(">Principle<", ">Rule<"), "patch changed more than the text run");
});

check("LOOP-RENDERED text is refused, never guessed", () => {
  // The DOM shows three "Overview" labels; the source has one literal driving all of
  // them. Patching index 1 would rewrite all three. Refusal is the only safe answer.
  const body = MAPPED.replace("{m.label}", "Overview");
  const r = patchLiteral(body, { oldText: "Overview", newText: "Summary", occurrence: 1, total: 3 });
  assert(!r.ok && r.reason === "ambiguous", `expected ambiguous, got ${JSON.stringify(r)}`);
});

check("repeated literals ARE editable when source and DOM agree", () => {
  const body = `<div><span>Buy</span><span>Buy</span></div>`;
  const r = patchLiteral(body, { oldText: "Buy", newText: "Sell", occurrence: 1, total: 2 });
  assert(r.ok, `expected a patch, got ${JSON.stringify(r)}`);
  if (!r.ok) return;
  assert(r.body === `<div><span>Buy</span><span>Sell</span></div>`, `patched the wrong one: ${r.body}`);
});

check("entities: the DOM's '&' matches the source's '&amp;'", () => {
  // Verbatim shape from a shipped s3.cards.tsx.
  const body = `<div><h4>Stocks &amp; Funds</h4></div>`;
  assert(countLiteral(body, "Stocks & Funds") === 1, "entity-decoded match failed");
  const r = patchLiteral(body, { oldText: "Stocks & Funds", newText: "Stocks & ETFs", occurrence: 0, total: 1 });
  assert(r.ok, "expected a patch");
  if (!r.ok) return;
  assert(r.body.includes("Stocks &amp; ETFs"), `must re-encode on write: ${r.body}`);
});

check("user text containing JSX-hostile characters is escaped", () => {
  const r = patchLiteral(`<div><p>hello</p></div>`, {
    oldText: "hello", newText: "a < b {x}", occurrence: 0, total: 1,
  });
  assert(r.ok, "expected a patch");
  if (!r.ok) return;
  assert(!/<p>[^<]*<(?!\/p>)/.test(r.body), `raw '<' would break the parse: ${r.body}`);
  assert(!r.body.includes("{x}"), `raw braces would become an expression: ${r.body}`);
  assert(r.body.includes("&lt;") && r.body.includes("&#123;"), `expected escapes: ${r.body}`);
});

check("a mocked code pane keeps its &nbsp; indentation through an edit", () => {
  // Verbatim from a shipped s2.sharecard.tsx — a fake editor rendering a code sample.
  // Plain .trim() ate the indentation and the edit silently unindented the line.
  const body = `<div>&nbsp;&nbsp;screen: true,</div>`;
  const clicked = "  screen: true,"; // what the DOM reports
  const r = patchLiteral(body, { oldText: clicked, newText: "  screen: false,", occurrence: 0, total: 1 });
  assert(r.ok, `expected a patch, got ${JSON.stringify(r)}`);
  if (!r.ok) return;
  assert(r.body === `<div>&nbsp;&nbsp;screen: false,</div>`, `indentation lost: ${r.body}`);
});

check("bound expressions are never treated as literals", () => {
  const spans = literalSpans(`<h1>{c.headline}</h1><span>{m.label}</span>`);
  assert(spans.length === 0, `expressions must not be editable: ${JSON.stringify(spans)}`);
});

check("arrow functions and punctuation runs are never selectable", () => {
  // `=>` opens a junk run that ends at the next tag. It must never match real text.
  const spans = literalSpans(MAPPED).map((s) => s.text);
  assert(!spans.some((t) => /=>|^\(+$|^\)+$/.test(t)), `junk run collected as text: ${JSON.stringify(spans)}`);
});

check("unknown text is not-found, and empty input is rejected", () => {
  const a = patchLiteral(META, { oldText: "nowhere in this piece", newText: "x", occurrence: 0, total: 1 });
  assert(!a.ok && a.reason === "not-found", `expected not-found, got ${JSON.stringify(a)}`);
  const b = patchLiteral(META, { oldText: "The method", newText: "   ", occurrence: 0, total: 1 });
  assert(!b.ok && b.reason === "empty", `blank replacement must be refused, got ${JSON.stringify(b)}`);
});

check("an edit round-trips: patch, then find the new text and patch it back", () => {
  const one = patchLiteral(META, { oldText: "The method", newText: "The approach", occurrence: 0, total: 1 });
  assert(one.ok, "first patch failed");
  if (!one.ok) return;
  const two = patchLiteral(one.body, { oldText: "The approach", newText: "The method", occurrence: 0, total: 1 });
  assert(two.ok, "second patch failed");
  if (!two.ok) return;
  assert(two.body === META, "round-trip did not restore the original body");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
