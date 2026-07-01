//
// Tests for M3 layout edits (reposition + delete) at the orchestration level —
// accumulation of drags, the finalize+compile+write commit path, and structural
// isolation. Uses a temp genDir decomposed from a small composition; no network.
//
import { decomposeGenDir, readManifest, writePieceBody } from "../agents/lego-store";
import { moveElement, deleteElement } from "./edit-layout";
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
      <Piece id="s0.atmos" kind="atmosphere"><div style={{ position: "absolute", inset: 0, background: PALETTE.accent }} /></Piece>
      <Piece id="s0.copy" kind="text"><h1 style={{ position: "absolute", left: "50%", top: 100, color: PALETTE.ink }}>{c.headline}</h1></Piece>
      <Piece id="s0.card" kind="diegetic"><div style={{ position: "absolute", left: 80, top: 400, width: 200, height: 120 }} /></Piece>
    </div>
  );
};

export const Generated: React.FC<{ script: any }> = ({ script }) => (<Section0 script={script} />);
`;

const dir = path.join(os.tmpdir(), "rb-edit-layout-test");
const compAfter = async () => fs.readFile(path.join(dir, "Composition.tsx"), "utf8");

console.log("\n▶ edit-layout (M3)");

await check("setup: decompose a temp genDir", async () => {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "Composition.tsx"), CODE, "utf8");
  const rep = await decomposeGenDir(dir);
  assert(rep.ok && rep.pieces === 3, `decompose: ${JSON.stringify(rep)}`);
});

await check("move accumulates deltas + wraps ONLY the moved piece; comp compiles", async () => {
  const a = await moveElement({ genDir: dir, sceneIndex: 0, pieceId: "s0.card", dx: 30, dy: 10 });
  assert(a.ok, `move 1: ${a.error}`);
  const b = await moveElement({ genDir: dir, sceneIndex: 0, pieceId: "s0.card", dx: 20, dy: -4 });
  assert(b.ok && b.offset!.dx === 50 && b.offset!.dy === 6, `accumulation wrong: ${JSON.stringify(b.offset)}`);
  const comp = await compAfter();
  assert(/left: 50, top: 6, right: -50, bottom: -6/.test(comp), "accumulated offset box not in Composition");
  assert(!/transform:/.test(comp), "offset must not use transform");
  // only s0.card wrapped
  const copyBlock = comp.split('id="s0.copy"')[1].split("</Piece>")[0];
  assert(!/left: 50/.test(copyBlock), "s0.copy wrongly offset by a move of s0.card");
  const man = await readManifest(dir);
  assert(man.scenes[0].pieces.find((p) => p.id === "s0.card")!.offset!.dx === 50, "offset not persisted");
});

await check("commit failure rolls the manifest back (no partial move persisted)", async () => {
  // Poison a DIFFERENT piece's body so any reassembly fails to compile.
  await writePieceBody(dir, "s0.copy", "<div><span>unclosed");
  const before = JSON.stringify(await readManifest(dir));
  const r = await moveElement({ genDir: dir, sceneIndex: 0, pieceId: "s0.card", dx: 999, dy: 999 });
  assert(!r.ok && /compile/.test(r.error ?? ""), `expected compile failure, got ${JSON.stringify(r)}`);
  const after = JSON.stringify(await readManifest(dir));
  assert(after === before, "manifest not rolled back after a failed commit (offset leaked)");
  // repair the poisoned body so later cases run clean
  await writePieceBody(dir, "s0.copy", '<h1 style={{ position: "absolute", left: "50%", top: 100 }}>ok</h1>');
});

await check("move rejects non-finite deltas", async () => {
  const r = await moveElement({ genDir: dir, sceneIndex: 0, pieceId: "s0.card", dx: NaN, dy: 0 });
  assert(!r.ok && /finite/.test(r.error ?? ""), `expected finite-number rejection, got ${JSON.stringify(r)}`);
});

await check("move on a missing piece → ok:false, not found", async () => {
  const r = await moveElement({ genDir: dir, sceneIndex: 0, pieceId: "nope", dx: 1, dy: 1 });
  assert(!r.ok && /not found/.test(r.error ?? ""), `expected not-found, got ${JSON.stringify(r)}`);
});

await check("delete removes the piece; siblings survive; comp compiles", async () => {
  const r = await deleteElement({ genDir: dir, sceneIndex: 0, pieceId: "s0.card" });
  assert(r.ok && r.remaining === 2, `delete: ${JSON.stringify(r)}`);
  const comp = await compAfter();
  assert(!comp.includes('id="s0.card"'), "deleted piece still in Composition");
  assert(comp.includes('id="s0.atmos"') && comp.includes('id="s0.copy"'), "siblings dropped by delete");
  assert(!comp.includes("RB:s0.card"), "dead slot left in Composition");
});

await check("delete on a missing piece → ok:false", async () => {
  const r = await deleteElement({ genDir: dir, sceneIndex: 0, pieceId: "s0.card" });
  assert(!r.ok, "second delete of same id should fail");
});

// ---- nesting / drill-in (delete a CHILD of a composite) --------------------
const ndir = path.join(os.tmpdir(), "rb-edit-layout-nested-test");
const NCODE = `import React from "react";
import { Piece } from "./Piece";

const Card: React.FC<{ n: number }> = ({ n }) => (
  <div style={{ position: "absolute", left: n * 100, top: 100, width: 80, height: 80 }} />
);

export const Section0: React.FC<{ script: any }> = ({ script }) => (
  <div style={{ position: "absolute", inset: 0 }}>
    <Piece id="s0.copy" kind="text"><h1 style={{ position: "absolute", left: 40, top: 40 }}>Hi</h1></Piece>
    <Piece id="s0.cards" kind="diegetic">
      <Piece id="s0.cards.0" kind="card"><Card n={0} /></Piece>
      <Piece id="s0.cards.1" kind="card"><Card n={1} /></Piece>
      <Piece id="s0.cards.2" kind="card"><Card n={2} /></Piece>
    </Piece>
  </div>
);

export const Generated: React.FC<{ script: any }> = ({ script }) => (<Section0 script={script} />);
`;

await check("nested setup: decompose keeps children inside the composite (2 top-level pieces)", async () => {
  await fs.rm(ndir, { recursive: true, force: true });
  await fs.mkdir(ndir, { recursive: true });
  await fs.writeFile(path.join(ndir, "Composition.tsx"), NCODE, "utf8");
  const rep = await decomposeGenDir(ndir);
  assert(rep.ok && rep.pieces === 2, `nested decompose: ${JSON.stringify(rep)}`);
});

await check("delete a CHILD: only that child leaves; siblings + parent + other pieces stay", async () => {
  const r = await deleteElement({ genDir: ndir, sceneIndex: 0, pieceId: "s0.cards.1" });
  assert(r.ok && r.remaining === 2, `child delete: ${JSON.stringify(r)}`);
  const comp = await fs.readFile(path.join(ndir, "Composition.tsx"), "utf8");
  assert(!comp.includes('id="s0.cards.1"') && !comp.includes("n={1}"), "deleted child still present");
  assert(comp.includes('id="s0.cards.0"') && comp.includes('id="s0.cards.2"'), "sibling children dropped");
  assert(comp.includes('id="s0.cards"') && comp.includes('id="s0.copy"'), "parent or other piece dropped");
});

await check("delete a missing child → ok:false", async () => {
  const r = await deleteElement({ genDir: ndir, sceneIndex: 0, pieceId: "s0.cards.9" });
  assert(!r.ok, "missing child delete should fail");
});

await check("move a child → rejected with a clear message (not supported yet)", async () => {
  const r = await moveElement({ genDir: ndir, sceneIndex: 0, pieceId: "s0.cards.0", dx: 10, dy: 10 });
  assert(!r.ok && /nested/.test(r.error ?? ""), `expected nested-move rejection, got ${JSON.stringify(r)}`);
});

await fs.rm(ndir, { recursive: true, force: true }).catch(() => {});
await fs.rm(dir, { recursive: true, force: true }).catch(() => {});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
