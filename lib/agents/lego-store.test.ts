//
// Tests for the LEGO on-disk store (M1 wire-in): decompose a Composition.tsx to
// genDir/lego/, read it back, and reassemble byte-identically — plus a single-piece
// edit from disk that changes only that piece.
//
import { decomposeGenDir, readDecomposed, reassembleFromDisk } from "./lego-store";
import { promises as fs } from "fs";
import path from "path";
import os from "os";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

const CODE = `import React from "react";
import { Piece } from "./Piece";

const PALETTE = { accent: "#ccff00", ink: "#f4f1ea" };

export const Section0: React.FC<{ script: any }> = ({ script }) => {
  const c = script.scenes[0].content;
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <Piece id="s0.atmos" kind="atmosphere"><div style={{ background: PALETTE.accent }} /></Piece>
      <Piece id="s0.copy" kind="text"><h1 style={{ color: PALETTE.ink }}>{c.headline}</h1></Piece>
      <Piece id="s0.bar" kind="diegetic" throughline="pb"><div data-throughline="pb" style={{ left: 80, top: 930 }} /></Piece>
    </div>
  );
};

export const Section1: React.FC<{ script: any }> = ({ script }) => (
  <div><Piece id="s1.copy" kind="text"><h1>Two</h1></Piece></div>
);

export const Generated: React.FC<{ script: any }> = ({ script }) => (<><Section0 script={script} /><Section1 script={script} /></>);
`;

const dir = path.join(os.tmpdir(), "rb-lego-store-test");

console.log("lego-store (M1 wire-in)");

await check("decomposeGenDir writes artifacts + reports piece count", async () => {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "Composition.tsx"), CODE, "utf8");
  const rep = await decomposeGenDir(dir);
  assert(rep.ok === true && rep.pieces === 4, `report: ${JSON.stringify(rep)}`);
});

await check("manifest + per-piece body files are written", async () => {
  const m = JSON.parse(await fs.readFile(path.join(dir, "lego", "manifest.json"), "utf8"));
  assert(m.scenes.length === 2, "2 scenes in manifest");
  assert(m.scenes[0].pieces[2].throughline === "pb", "throughline persisted");
  const body = await fs.readFile(path.join(dir, "lego", "pieces", "s0.copy.tsx"), "utf8");
  assert(body.includes("{c.headline}") && !body.includes("<Piece"), "piece file holds the bare body");
});

await check("readDecomposed → reassembleFromDisk is BYTE-IDENTICAL", async () => {
  const out = await reassembleFromDisk(dir);
  assert(out === CODE, "reassembled-from-disk must equal the original byte-for-byte");
});

await check("editing one piece from disk changes only that piece", async () => {
  const out = await reassembleFromDisk(dir, (_si, p) => (p.id === "s0.copy" ? "<h1>REGENERATED</h1>" : p.body));
  assert(out.includes("REGENERATED") && out !== CODE, "edited body present");
  // sibling pieces untouched: s1.copy still renders {c.headline}? no — s1 uses <h1>Two</h1>; assert it survives
  assert(out.includes("<h1>Two</h1>"), "sibling scene untouched");
  assert(out.includes('<Piece id="s0.atmos"'), "sibling piece markers preserved");
});

await fs.rm(dir, { recursive: true, force: true }).catch(() => {});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
