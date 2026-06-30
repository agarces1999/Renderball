/**
 * Tests for the LEGO decomposer/reassembler (M1b). The core guarantee: with no
 * edits, reassemble(decompose(code)) is BYTE-IDENTICAL — and editing one piece's
 * body changes ONLY that piece's region (the structural zero-neighbor property).
 */
import { decompose, reassemble, pieceCount } from "./lego-decompose";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

// A realistic <Piece>-marked composition: variable preamble (PALETTE object),
// self-positioned bodies, a throughline piece, two scenes, a Generated alias.
const CODE = `import React from "react";
import { Piece } from "./Piece";

const PALETTE = { accent: "#ccff00", ink: "#f4f1ea" };
const FONT = '"Inter", sans-serif';

export const Section0: React.FC<{ script: any }> = ({ script }) => {
  const c = script.scenes[0].content;
  return (
    <div style={{ position: "absolute", inset: 0, background: "#0E1413" }}>
      <Piece id="s0.atmos" kind="atmosphere">
        <div style={{ position: "absolute", inset: 0, background: PALETTE.accent }} />
      </Piece>
      <Piece id="s0.copy" kind="text">
        <div style={{ position: "absolute", left: 80, top: 120 }}><h1 style={{ color: PALETTE.ink, fontFamily: FONT }}>{c.headline}</h1></div>
      </Piece>
      <Piece id="s0.bar" kind="diegetic" throughline="progress-bar">
        <div data-throughline="progress-bar" style={{ position: "absolute", left: 80, top: 930, width: 1760, height: 6, background: PALETTE.accent }} />
      </Piece>
    </div>
  );
};

export const Section1: React.FC<{ script: any }> = ({ script }) => {
  const c = script.scenes[1].content;
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <Piece id="s1.copy" kind="text"><h1>{c.headline}</h1></Piece>
    </div>
  );
};

export const Generated: React.FC<{ script: any }> = ({ script }) => (
  <>
    <Section0 script={script} />
    <Section1 script={script} />
  </>
);
`;

console.log("lego-decompose (M1b)");

const d = decompose(CODE);

check("splits into preamble + scenes + tail; extracts every piece", () => {
  assert(d.preamble.startsWith('import React'), "preamble starts at imports");
  assert(d.preamble.includes("const PALETTE = {") && !d.preamble.includes("export const Section0"), "preamble holds the variable consts, stops before Section0");
  assert(d.scenes.length === 2, `2 scenes, got ${d.scenes.length}`);
  assert(pieceCount(d) === 4, `4 pieces, got ${pieceCount(d)}`);
  assert(d.tail.includes("export const Generated"), "tail holds the Generated alias");
});

check("captures piece id / kind / throughline", () => {
  const p = d.scenes[0].pieces;
  assert(p.map((x) => x.id).join(",") === "s0.atmos,s0.copy,s0.bar", `ids: ${p.map((x) => x.id)}`);
  assert(p[0].kind === "atmosphere" && p[1].kind === "text" && p[2].kind === "diegetic", "kinds");
  assert(p[2].throughline === "progress-bar" && p[0].throughline === undefined, "throughline only on the bar");
  assert(p[1].body.includes("{c.headline}"), "piece body captured verbatim");
});

check("template holds a slot per piece, no <Piece> left inline", () => {
  assert(d.scenes[0].template.includes("{/*RB:s0.copy*/}"), "slot present");
  assert(!d.scenes[0].template.includes("<Piece"), "no <Piece> opening left in the template");
});

check("BYTE-IDENTICAL round trip with no edits", () => {
  const out = reassemble(d);
  assert(out === CODE, "reassemble(decompose(code)) must equal the original byte-for-byte");
});

check("editing ONE piece changes only that piece's region (zero neighbor effect)", () => {
  const NEW = `<div style={{ position: "absolute", left: 80, top: 120 }}><h1>REGENERATED</h1></div>`;
  const out = reassemble(d, (_si, p) => (p.id === "s0.copy" ? NEW : p.body));
  assert(out.includes("REGENERATED"), "the edited body is present");
  assert(!out.includes("{c.headline}\\n") || out.split("{c.headline}").length === 2,
    "only the edited piece's binding changed — s1.copy's {c.headline} is untouched");
  // Everything OUTSIDE the s0.copy piece must be byte-identical to the original:
  const orig = CODE.split('<Piece id="s0.copy" kind="text">')[0] + CODE.split('</Piece>').slice(2).join("</Piece>");
  const got = out.split('<Piece id="s0.copy" kind="text">')[0] + out.split('</Piece>').slice(2).join("</Piece>");
  assert(orig === got, "the template, preamble, tail, and sibling pieces are byte-identical after a single-piece edit");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
