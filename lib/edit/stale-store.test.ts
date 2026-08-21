//
// THE DEPLOY→REHYDRATE→EDIT LIFECYCLE. Every other store test decomposes its
// fixture in-process, so the store always matches the composition and this whole
// failure class is invisible to them — 1904 green tests, and a founder found it
// by hand in fifteen minutes (2026-08-21).
//
// What production actually does: writeGeneratedFiles snapshots the genDir to R2,
// and every call site runs BEFORE the build writes the lego store. The store
// therefore lives only on the container's disk. A deploy wipes that disk; the
// document rehydrates from the R2 snapshot and comes back carrying whatever
// store predated the build — for a deck generated from a blank document, the
// one-scene `s0.hint` scaffold.
//
// These tests reproduce exactly that state (new Composition.tsx, old store) and
// assert the heal. Measured on 3 of 94 stored decks before the fix.
//
import { decomposeGenDir, readManifest, healStaleStore, reassembleFromDisk } from "../agents/lego-store";
import { applyPageOp } from "./page-ops";
import { withGenDirLock } from "./gendir-lock";
import type { Script } from "../../src/schema";
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

const section = (k: number) => `
export const Section${k}: React.FC<{ script: any }> = ({ script }) => {
  const c = script.scenes[${k}].content;
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <Piece id="s${k}.atmos" kind="atmosphere"><div style={{ position: "absolute", inset: 0, background: PALETTE.bg }} /></Piece>
      <Piece id="s${k}.copy" kind="text"><h1 style={{ position: "absolute", left: 96, top: 100 }}>{c.headline}</h1></Piece>
    </div>
  );
};
`;

const composition = (n: number) => `import React from "react";
import { Piece } from "./Piece";

const PALETTE = { bg: "#f4f1ea" };
${Array.from({ length: n }, (_, i) => section(i)).join("")}
export const Generated: React.FC<{ script: any }> = ({ script }) => (<Section0 script={script} />);
`;

/** What creating a blank document leaves on disk: one scene, one hint piece. */
const BLANK = `import React from "react";
import { Piece } from "./Piece";

const PALETTE = { bg: "#f4f1ea" };

export const Section0: React.FC<{ script: any }> = () => (
  <div style={{ position: "absolute", inset: 0, background: PALETTE.bg }}>
    <Piece id="s0.hint" kind="text"><p style={{ position: "absolute", left: 96, top: 100 }}>Describe this page</p></Piece>
  </div>
);
export const Generated: React.FC<{ script: any }> = ({ script }) => (<Section0 script={script} />);
`;

const scene = (i: number) => ({
  id: `01STALESCENE${String(i).padStart(14, "0")}`,
  index: i,
  label: `Page ${i + 1}`,
  visual_concept: "test",
  content: { headline: `Head ${i}`, asset_ids: [] },
  start_seconds: i * 5,
  end_seconds: (i + 1) * 5,
});

const makeScript = (n: number): Script =>
  ({
    id: "01STALESCRIPT0000000000000",
    config: { duration_seconds: n * 5, aspect_ratio: "16:9", resolution: "1080p", tone: "t", pacing: "medium", kind: "deck" },
    scenes: Array.from({ length: n }, (_, i) => scene(i)),
  }) as unknown as Script;

const dir = path.join(os.tmpdir(), "rb-stale-store-test");

/**
 * Reproduce the rehydrated state: a store decomposed from the BLANK document,
 * then Composition.tsx replaced by the built n-page deck with no re-decompose.
 * This is byte-for-byte the shape the R2 snapshot restores.
 */
const rehydratedStale = async (pages: number) => {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "Composition.tsx"), BLANK, "utf8");
  const rep = await decomposeGenDir(dir);
  assert(rep.ok, `blank decompose failed: ${JSON.stringify(rep)}`);
  assert((await readManifest(dir)).scenes.length === 1, "precondition: blank store has 1 scene");
  // The build ships the real deck — but the snapshot already went out.
  await fs.writeFile(path.join(dir, "Composition.tsx"), composition(pages), "utf8");
};

console.log("\n▶ stale-store (deploy→rehydrate→edit)");

await check("REPRODUCES the founder's state: 6-page deck carrying a 1-scene store", async () => {
  await rehydratedStale(6);
  assert((await readManifest(dir)).scenes.length === 1, "store should still describe 1 scene");
});

await check("heal re-decomposes the store from the shipped composition", async () => {
  await rehydratedStale(6);
  const r = await healStaleStore(dir);
  assert(r.healed && r.scenes === 6, `heal: ${JSON.stringify(r)}`);
  const m = await readManifest(dir);
  assert(m.scenes.length === 6, `store scenes after heal: ${m.scenes.length}`);
  const ids = m.scenes.flatMap((s) => s.pieces.map((p) => p.id));
  assert(ids.includes("s5.copy"), `page 6's pieces must exist: ${ids.join(",")}`);
  assert(!ids.includes("s0.hint"), "the blank scaffold's piece must be gone");
});

await check("add-a-page no longer fails with store/script scene mismatch", async () => {
  await rehydratedStale(6);
  const r = await applyPageOp(dir, makeScript(6), { op: "add", after: 5 });
  assert(r.ok, `applyPageOp refused: ${r.error}`);
  assert(r.pages === 7, `pages after add: ${r.pages}`);
});

await check("every locked edit op heals before it reads the store", async () => {
  await rehydratedStale(4);
  const seen = await withGenDirLock(dir, async () => (await readManifest(dir)).scenes.length);
  assert(seen === 4, `op inside the lock saw ${seen} scene(s), expected 4`);
});

await check("heal is a no-op when the store already matches (offsets survive)", async () => {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "Composition.tsx"), composition(3), "utf8");
  assert((await decomposeGenDir(dir)).ok, "decompose");
  const before = JSON.stringify(await readManifest(dir));
  const r = await healStaleStore(dir);
  assert(!r.healed, `must not heal a matching store: ${JSON.stringify(r)}`);
  assert(JSON.stringify(await readManifest(dir)) === before, "a no-op heal must not rewrite the manifest");
});

await check("a healed store reassembles back to the shipped composition byte-for-byte", async () => {
  await rehydratedStale(5);
  const shipped = await fs.readFile(path.join(dir, "Composition.tsx"), "utf8");
  assert((await healStaleStore(dir)).healed, "should heal");
  // The whole point of the store: it is a lossless decomposition of what renders.
  // If a heal ever left it otherwise, every later edit would write back a
  // composition that differs from the one the user approved.
  assert((await reassembleFromDisk(dir)) === shipped, "healed store must round-trip to the shipped composition");
});

await check("a MISSING store is readManifest's lazy decompose; heal then agrees it is fresh", async () => {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "Composition.tsx"), composition(2), "utf8");
  // readManifest already repairs an ABSENT store on read. The gap this heal
  // closes is the STALE one — present, readable, and describing another document.
  assert((await readManifest(dir)).scenes.length === 2, "lazy decompose should build a 2-scene store");
  const r = await healStaleStore(dir);
  assert(!r.healed, `nothing left to heal: ${JSON.stringify(r)}`);
});

await fs.rm(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
