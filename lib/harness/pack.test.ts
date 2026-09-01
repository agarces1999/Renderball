/**
 * The context pack renders user-locked color roles with authority.
 *
 * Why this exists: the founder's Fuse deck (2026-08-29). The user locked
 * Accent #440c12 in the ceremony; the pack handed the author eight anonymous
 * hexes and the author cast the locked maroon as the villain color. Roles are
 * decisions — the pack must say so, and the canonical PALETTE const is what
 * lets the Brand panel re-color a harness deck afterwards.
 */
import { assemblePack, type PackInput } from "./pack";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`);
  }
};
const assert = (c: boolean, m: string) => {
  if (!c) throw new Error(m);
};

console.log("harness pack");

const baseInput = (roles?: PackInput["brand"]["roles"]): PackInput => ({
  briefPrompt: "A deck about Fuse",
  tone: undefined,
  aspect: "16:9",
  scenes: [{ label: "Open", description: "The gap", content: '{"headline":"x"}' }],
  brand: {
    brandName: "Fuse",
    palette: ["#214eda", "#440c12"],
    logoSrc: null,
    mode: "light",
    background: "#ffffff",
    ...(roles ? { roles } : {}),
  },
  assetUrls: [],
});

check("no locked roles → no USER-LOCKED section", () => {
  const pack = assemblePack(baseInput());
  assert(!pack.includes("USER-LOCKED"), "section must not render for crawl-only brands");
});

check("locked accent + background render as decisions with their hexes", () => {
  const pack = assemblePack(baseInput({ accent: "#440c12", background: "#10141c" }));
  assert(pack.includes("USER-LOCKED COLOR ROLES"), "section header present");
  assert(pack.includes("Accent: #440c12 — THE brand accent"), "accent line carries the hex with authority");
  assert(pack.includes("Page background: #10141c"), "background line carries the hex");
});

check("confirmed monochrome renders the black & white directive", () => {
  const pack = assemblePack(baseInput({ monochrome: true }));
  assert(pack.includes("BLACK & WHITE"), "monochrome directive present");
});

check("file contract demands the canonical PALETTE const", () => {
  const pack = assemblePack(baseInput());
  assert(pack.includes("const PALETTE = { accent, canvas, ink, muted, surface, line }"), "canonical const named");
  assert(pack.includes("never rename these six"), "role keys are non-negotiable");
});

check("file contract demands the canonical font consts (founder's Zoom deck: fonts had no slot to swap)", () => {
  const pack = assemblePack(baseInput());
  for (const name of ["FONT_DISPLAY", "FONT_BODY", "FONT_MONO"]) {
    assert(pack.includes(`\`const ${name}\``), `${name} named in the contract`);
  }
  assert(pack.includes("never inline a stack"), "inlining is banned — inlined stacks are what made fonts unswappable");
});

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
