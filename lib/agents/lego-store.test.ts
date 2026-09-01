//
// Tests for the LEGO on-disk store (M1 wire-in): decompose a Composition.tsx to
// genDir/lego/, read it back, and reassemble byte-identically — plus a single-piece
// edit from disk that changes only that piece.
//
import { decomposeGenDir, readDecomposed, reassembleFromDisk, setPieceOffset, removePieceFromDisk, readManifest } from "./lego-store";
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

await check("setPieceOffset wraps ONLY that piece in a shifted offset box, NO transform (M3 move)", async () => {
  const ok = await setPieceOffset(dir, 0, "s0.copy", { dx: 40, dy: -20 });
  assert(ok === true, "setPieceOffset returned false");
  const out = await reassembleFromDisk(dir);
  // s0.copy body wrapped in a Section-sized box shifted by (40,-20): left/top/right/bottom
  const wrap = out.match(/<Piece id="s0.copy"[^>]*>(<div style=\{\{ position: "absolute", left: 40, top: -20, right: -40, bottom: 20 \}\}>)/);
  assert(!!wrap, "s0.copy body not wrapped by the offset box");
  // MUST NOT use transform — that would create a stacking context + break cross-piece z-index
  assert(!/transform:/.test(out), "offset must not use transform (breaks z-index isolation)");
  // siblings NOT wrapped
  assert(!/left: 40/.test(out.split('id="s0.atmos"')[1].split("</Piece>")[0]), "s0.atmos wrongly wrapped");
  assert(out.includes("<h1>Two</h1>"), "sibling scene untouched by a move");
});

await check("offset persists across a regenerate-style body override", async () => {
  const out = await reassembleFromDisk(dir, (_si, p) => (p.id === "s0.copy" ? "<h1>NEWBODY</h1>" : p.body));
  assert(/left: 40, top: -20, right: -40, bottom: 20/.test(out), "offset lost after body override");
  assert(/bottom: 20 \}\}><h1>NEWBODY<\/h1><\/div>/.test(out.replace(/\s+/g, " ")), "new body not present under the offset box");
});

await check("removePieceFromDisk deletes the piece, strips its slot + file (M3 delete)", async () => {
  await setPieceOffset(dir, 0, "s0.copy", { dx: 0, dy: 0 }); // reset so the assertion below is clean
  const ok = await removePieceFromDisk(dir, 0, "s0.bar");
  assert(ok === true, "removePieceFromDisk returned false");
  const m = await readManifest(dir);
  assert(!m.scenes[0].pieces.some((p) => p.id === "s0.bar"), "s0.bar still in manifest");
  assert(!m.scenes[0].template.includes("RB:s0.bar"), "s0.bar slot not stripped from template");
  let fileGone = false;
  try { await fs.access(path.join(dir, "lego", "pieces", "s0.bar.tsx")); } catch { fileGone = true; }
  assert(fileGone, "s0.bar body file not removed");
  const out = await reassembleFromDisk(dir);
  assert(!out.includes('id="s0.bar"') && !out.includes("data-throughline=\"pb\""), "deleted piece still rendered");
  assert(out.includes('id="s0.atmos"') && out.includes("<h1>Two</h1>"), "siblings dropped by a delete");
});

await check("removePieceFromDisk on a missing id → false, no mutation", async () => {
  const before = JSON.stringify(await readManifest(dir));
  const ok = await removePieceFromDisk(dir, 0, "nope");
  assert(ok === false, "should return false for a missing id");
  assert(JSON.stringify(await readManifest(dir)) === before, "manifest mutated on a no-op delete");
});

await check("computed Piece ids REFUSE decomposition (Deel corruption class, 2026-08-31)", async () => {
  // A <Piece> rendered inside a .map with a computed id decomposes under a
  // counter name that can collide with a real piece — two pieces, one file,
  // and every from-disk reassembly stitches the wrong body. The guard must
  // refuse BEFORE anything touches disk; the deck stays whole and editable
  // at page granularity instead of silently corruptible.
  const computed = `import React from "react";
import { Piece } from "./Piece";
export const Section0: React.FC<{ script: any }> = () => (
  <div>
    {["a", "b"].map((b, i) => (
      <Piece key={b} id={\`s0.p\${1 + i}\`} kind="diegetic"><p>{b}</p></Piece>
    ))}
    <Piece id="s0.p1" kind="text"><h1>collides</h1></Piece>
  </div>
);
export const Generated: React.FC<{ script: any }> = () => <Section0 script={null} />;
`;
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "Composition.tsx"), computed, "utf8");
  const rep = await decomposeGenDir(dir);
  assert(rep.ok === false, `must refuse, got ${JSON.stringify(rep)}`);
  assert(/computed piece id|duplicate piece id/.test(rep.reason ?? ""), `reason names the id problem: ${rep.reason}`);
  const legoWritten = await fs.stat(path.join(dir, "lego", "manifest.json")).then(() => true).catch(() => false);
  assert(legoWritten === false, "nothing may touch disk on refusal");
});

await fs.rm(dir, { recursive: true, force: true }).catch(() => {});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
