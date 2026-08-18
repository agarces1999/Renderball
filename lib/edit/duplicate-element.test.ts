//
// Tests for ⌘D duplicate. The properties that matter: the clone is a real,
// independently addressable piece (fresh id everywhere, no duplicate data-piece),
// it lands offset from where the source RENDERS, the source is untouched, and a
// failed commit leaves no orphan behind.
//
import { decomposeGenDir, readManifest, writePieceBody } from "../agents/lego-store";
import { duplicateElement, cloneBody, cloneOpenTag } from "./duplicate-element";
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
      <Piece id="s0.atmos" kind="atmosphere"><div style={{ position: "absolute", inset: 0, zIndex: 0, background: PALETTE.accent }} /></Piece>
      <Piece id="s0.copy" kind="text"><h1 data-piece="s0.copy" style={{ position: "absolute", left: 50, top: 100, zIndex: 2, color: PALETTE.ink }}>{c.headline}</h1></Piece>
      <Piece id="s0.card" kind="diegetic"><div data-piece="s0.card" style={{ position: "absolute", left: 80, top: 400, width: 200, height: 120, zIndex: 1 }} /></Piece>
    </div>
  );
};

export const Generated: React.FC<{ script: any }> = ({ script }) => (<Section0 script={script} />);
`;

const dir = path.join(os.tmpdir(), "rb-duplicate-test");
const compAfter = async () => fs.readFile(path.join(dir, "Composition.tsx"), "utf8");
const setup = async () => {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "Composition.tsx"), CODE, "utf8");
  return decomposeGenDir(dir);
};

console.log("\n▶ duplicate-element (⌘D)");

// ---- the pure id-rewriter -------------------------------------------------

await check("cloneBody rewrites data-piece and the piece's own id", () => {
  const out = cloneBody('<div data-piece="s0.card" id="s0.card" />', "s0.card", "s0.add1");
  assert(out.includes('data-piece="s0.add1"'), `data-piece not rewritten: ${out}`);
  assert(out.includes('id="s0.add1"'), `id not rewritten: ${out}`);
  assert(!out.includes("s0.card"), `old id survived: ${out}`);
});

await check("cloneBody re-prefixes nested CHILD ids (composite subtree stays consistent)", () => {
  const out = cloneBody(
    '<Piece id="s0.grid.a" kind="card"/><Piece id="s0.grid.b" kind="card"/>',
    "s0.grid",
    "s0.add1",
  );
  assert(out.includes('id="s0.add1.a"') && out.includes('id="s0.add1.b"'), `children not re-prefixed: ${out}`);
});

await check("cloneBody makes off-convention ids unique too (never leaves a collision)", () => {
  const out = cloneBody('<div id="hero"/><div id="hero2"/>', "s0.card", "s0.add1");
  assert(!/id="hero"/.test(out) && !/id="hero2"/.test(out), `unrelated ids left to collide: ${out}`);
  const ids = [...out.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  assert(new Set(ids).size === ids.length, `rewritten ids are not unique: ${ids.join()}`);
});

await check("cloneBody + cloneOpenTag DROP the throughline marker", () => {
  const body = cloneBody('<div data-throughline="motif-x" id="s0.t"/>', "s0.t", "s0.add1");
  assert(!body.includes("data-throughline"), `body kept the throughline marker: ${body}`);
  const tag = cloneOpenTag('<Piece id="s0.t" kind="diegetic" throughline="motif-x">', "s0.t", "s0.add1");
  assert(tag === '<Piece id="s0.add1" kind="diegetic">', `openTag wrong: ${tag}`);
});

// ---- the orchestrated op --------------------------------------------------

await check("setup: decompose a temp genDir", async () => {
  const rep = await setup();
  assert(rep.ok && rep.pieces === 3, `decompose: ${JSON.stringify(rep)}`);
});

await check("duplicate adds ONE piece with a fresh id; the source is untouched", async () => {
  const r = await duplicateElement({ genDir: dir, sceneIndex: 0, pieceId: "s0.card" });
  assert(r.ok && !!r.pieceId, `duplicate: ${JSON.stringify(r)}`);
  assert(r.pieceId !== "s0.card", "clone reused the source id");
  const man = await readManifest(dir);
  assert(man.scenes[0].pieces.length === 4, `expected 4 pieces, got ${man.scenes[0].pieces.length}`);
  const comp = await compAfter();
  assert(comp.includes('id="s0.card"'), "the SOURCE piece vanished");
  assert(comp.includes(`id="${r.pieceId}"`), "the clone is not in the composition");
  // The clone is a copy of the card, so the card's markup appears twice.
  assert(comp.split("width: 200, height: 120").length === 3, "clone did not copy the source body");
});

await check("exactly ONE node answers to each data-piece id (no ambiguous hit-test)", async () => {
  const comp = await compAfter();
  const ids = [...comp.matchAll(/data-piece="([^"]+)"/g)].map((m) => m[1]);
  assert(new Set(ids).size === ids.length, `duplicate data-piece ids: ${ids.join()}`);
});

await check("the clone carries the source's kind and its own offset", async () => {
  const man = await readManifest(dir);
  const clone = man.scenes[0].pieces.find((p) => p.id !== "s0.card" && p.kind === "diegetic")!;
  assert(!!clone, "no diegetic clone in the manifest");
  assert(clone.offset?.dx === 24 && clone.offset?.dy === 24, `offset wrong: ${JSON.stringify(clone.offset)}`);
});

await check("the clone is independent: deleting it leaves the source intact", async () => {
  const man = await readManifest(dir);
  const clone = man.scenes[0].pieces.find((p) => p.id !== "s0.card" && p.kind === "diegetic")!;
  const r = await deleteElement({ genDir: dir, sceneIndex: 0, pieceId: clone.id });
  assert(r.ok, `delete clone: ${r.error}`);
  const comp = await compAfter();
  assert(comp.includes('id="s0.card"'), "deleting the clone removed the source");
  assert(!comp.includes(`id="${clone.id}"`), "clone still present after delete");
});

await check("duplicating a MOVED piece lands beside where it renders, not its origin", async () => {
  await setup();
  const mv = await moveElement({ genDir: dir, sceneIndex: 0, pieceId: "s0.card", dx: 300, dy: 120 });
  assert(mv.ok, `move: ${mv.error}`);
  const r = await duplicateElement({ genDir: dir, sceneIndex: 0, pieceId: "s0.card" });
  assert(r.ok, `duplicate: ${r.error}`);
  const man = await readManifest(dir);
  const clone = man.scenes[0].pieces.find((p) => p.id === r.pieceId)!;
  assert(
    clone.offset?.dx === 324 && clone.offset?.dy === 144,
    `clone should inherit the move (324,144), got ${JSON.stringify(clone.offset)}`,
  );
});

await check("duplicate of a missing piece → ok:false with a usable message", async () => {
  const r = await duplicateElement({ genDir: dir, sceneIndex: 0, pieceId: "nope" });
  assert(!r.ok && /not found/.test(r.error ?? ""), `expected not-found, got ${JSON.stringify(r)}`);
});

await check("a commit failure rolls back — no orphan piece file, no manifest entry", async () => {
  await setup();
  await writePieceBody(dir, "s0.copy", "<div><span>unclosed"); // poison a SIBLING
  const before = JSON.stringify(await readManifest(dir));
  const r = await duplicateElement({ genDir: dir, sceneIndex: 0, pieceId: "s0.card" });
  assert(!r.ok && /compile/.test(r.error ?? ""), `expected compile failure, got ${JSON.stringify(r)}`);
  const after = JSON.stringify(await readManifest(dir));
  assert(after === before, "manifest not rolled back after a failed duplicate");
  const files = await fs.readdir(path.join(dir, "lego", "pieces"));
  assert(files.length === 3, `orphan body file left behind: ${files.join()}`);
});

await fs.rm(dir, { recursive: true, force: true }).catch(() => {});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
