/**
 * THE invariant: the store and the render must never disagree.
 *
 * A document is two artefacts that have to say the same thing — lego/manifest.json
 * (what pieces exist) and Composition.tsx (what actually renders). Every editor
 * operation rewrites both. If one changes and the other does not, the document is
 * corrupt in a way no error reports: the next commit re-derives from whichever is
 * authoritative and the difference is destroyed. That is exactly how a cosmetic
 * z-order click permanently deleted an element, and why the feature is still
 * unshipped.
 *
 * So rather than test each operation's happy path and hope, this asserts ONE
 * property after every operation, including the ones that are expected to fail:
 *
 *     the ids in the manifest == the ids rendered in Composition.tsx
 *
 * A failure here is always a real defect. There is no fixture, timing or harness
 * explanation available — both artefacts are read straight off disk.
 */
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { decomposeGenDir, readManifest } from "../agents/lego-store";
// undoEdit, not lego-store's undoLast: undoLast restores the STORE only, and the
// route pairs it with a commit. Calling the lower layer in a test asserts an
// inconsistency the product never actually exposes — worth knowing as a footgun,
// but not a defect.
import { undoEdit } from "./undo-edit";
import {
  deleteElement,
  moveElement,
  reorderElement,
  resizeElement,
} from "./edit-layout";
import { insertElement } from "./insert-element";
import { applyPageOp } from "./page-ops";
import { blankScript } from "../documents/blank-document";
import type { Script } from "../../src/schema";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => Promise<void>) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

const CODE = `import React from "react";
import { Piece } from "./Piece";

const PALETTE = { ink: "#10141c", accent: "#00c28a" };

export const Section0: React.FC<{ script: any }> = () => (
  <div style={{ position: "absolute", inset: 0 }}>
    <Piece id="s0.back" kind="atmosphere"><div style={{ position: "absolute", left: 0, top: 0, width: 400, height: 300 }} /></Piece>
    <Piece id="s0.copy" kind="text"><div style={{ position: "absolute", left: 100, top: 120, width: 600, height: 200 }}><h1 style={{ color: PALETTE.ink }}>Headline</h1></div></Piece>
    <Piece id="s0.card" kind="diegetic"><div style={{ position: "absolute", left: 200, top: 400, width: 300, height: 180 }} /></Piece>
    <Piece id="s0.chrome" kind="chrome"><div style={{ position: "absolute", left: 40, top: 30, width: 800, height: 20 }} /></Piece>
  </div>
);

export const Section1: React.FC<{ script: any }> = () => (
  <div style={{ position: "absolute", inset: 0 }}>
    <Piece id="s1.copy" kind="text"><div style={{ position: "absolute", left: 80, top: 90, width: 500, height: 150 }}><h2 style={{ color: PALETTE.ink }}>Second</h2></div></Piece>
  </div>
);

export const Generated: React.FC<{ script: any }> = ({ script }) => (<><Section0 script={script} /><Section1 script={script} /></>);
`;

const dir = path.join(os.tmpdir(), "rb-consistency-test");

/**
 * A script matching the fixture's two sections.
 *
 * Page operations rewrite BOTH the sources and the script, and refuse outright
 * when the two disagree about how many pages exist — so the fixture has to carry
 * a script with the same shape as its composition.
 */
const script = (): Script => blankScript("CONSISTENCY", 2);

/** Ids the manifest claims exist, across every scene. */
const manifestIds = async (): Promise<string[]> => {
  const m = await readManifest(dir);
  return m.scenes.flatMap((s) => s.pieces.map((p) => p.id)).sort();
};

/** Ids that actually render. */
const renderedIds = async (): Promise<string[]> => {
  const code = await fs.readFile(path.join(dir, "Composition.tsx"), "utf8");
  return [...code.matchAll(/id="([^"]+)"/g)].map((m) => m[1]).sort();
};

/**
 * The invariant. Called after EVERY operation, successful or not.
 *
 * Also checks nothing rendered twice: a duplicated slot renders a piece in two
 * places and is just as corrupt as a missing one.
 */
const assertConsistent = async (after: string): Promise<void> => {
  const store = await manifestIds();
  const render = await renderedIds();

  const missing = store.filter((id) => !render.includes(id));
  const extra = render.filter((id) => !store.includes(id));
  assert(
    missing.length === 0,
    `after ${after}: manifest claims ${missing.join(", ")} but the render does not contain them`,
  );
  assert(
    extra.length === 0,
    `after ${after}: the render contains ${extra.join(", ")} which the manifest does not know about`,
  );

  const dupes = render.filter((id, i) => render.indexOf(id) !== i);
  assert(dupes.length === 0, `after ${after}: rendered more than once: ${dupes.join(", ")}`);

  const code = await fs.readFile(path.join(dir, "Composition.tsx"), "utf8");
  assert(code.includes("export const Generated"), `after ${after}: the composition lost its entry point`);
  assert(
    !/\{\/\*RB:[^*]*\{\/\*RB:/.test(code),
    `after ${after}: a slot marker ended up nested inside another`,
  );
};

const reset = async (): Promise<void> => {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "Composition.tsx"), CODE, "utf8");
  const rep = await decomposeGenDir(dir);
  if (!rep.ok) throw new Error(`fixture failed to decompose: ${JSON.stringify(rep)}`);
};

const run = async () => {
  console.log("store/render consistency");

  await check("the fixture starts consistent", async () => {
    await reset();
    await assertConsistent("setup");
    assert((await manifestIds()).length === 5, `expected 5 pieces, got ${(await manifestIds()).length}`);
  });

  await check("consistent after MOVE", async () => {
    await reset();
    const r = await moveElement({ genDir: dir, sceneIndex: 0, pieceId: "s0.card", dx: 40, dy: 25 });
    assert(r.ok, `move failed: ${r.error}`);
    await assertConsistent("move");
  });

  await check("consistent after repeated MOVE (offsets accumulate)", async () => {
    await reset();
    for (const d of [10, -20, 35]) {
      await moveElement({ genDir: dir, sceneIndex: 0, pieceId: "s0.card", dx: d, dy: d });
      await assertConsistent(`move ${d}`);
    }
  });

  await check("consistent after RESIZE", async () => {
    await reset();
    const r = await resizeElement({ genDir: dir, sceneIndex: 0, pieceId: "s0.card", x: 50, y: 60, w: 400, h: 220 });
    assert(r.ok, `resize failed: ${r.error}`);
    await assertConsistent("resize");
  });

  await check("consistent after a REFUSED resize", async () => {
    await reset();
    // Zero width is rejected; a refusal must leave the document untouched.
    const r = await resizeElement({ genDir: dir, sceneIndex: 0, pieceId: "s0.card", x: 0, y: 0, w: 0, h: 10 });
    assert(!r.ok, "a zero-width resize should be refused");
    await assertConsistent("refused resize");
  });

  await check("consistent after DELETE", async () => {
    await reset();
    const r = await deleteElement({ genDir: dir, sceneIndex: 0, pieceId: "s0.card" });
    assert(r.ok, `delete failed: ${r.error}`);
    await assertConsistent("delete");
    assert(!(await manifestIds()).includes("s0.card"), "the deleted piece should be gone from the manifest");
    assert(!(await renderedIds()).includes("s0.card"), "the deleted piece should be gone from the render");
  });

  await check("consistent after INSERT", async () => {
    await reset();
    const r = await insertElement({
      genDir: dir, scriptId: "t", sceneIndex: 0,
      bounds: { x: 120, y: 500, w: 300, h: 120 },
      spec: { mode: "primitive", primitive: "text", text: "Added" },
    });
    assert(r.ok, `insert failed: ${JSON.stringify(r).slice(0, 160)}`);
    await assertConsistent("insert");
  });

  await check("consistent after BRING TO FRONT / SEND TO BACK", async () => {
    await reset();
    for (const to of ["front", "back", "front"] as const) {
      const r = await reorderElement({ genDir: dir, sceneIndex: 0, pieceId: "s0.copy", to });
      // Either outcome is legal — but the document must stay coherent.
      await assertConsistent(`${to} (ok=${r.ok})`);
    }
  });

  await check("consistent after reordering EVERY piece both ways", async () => {
    await reset();
    for (const id of ["s0.back", "s0.copy", "s0.card", "s0.chrome"]) {
      for (const to of ["front", "back"] as const) {
        const r = await reorderElement({ genDir: dir, sceneIndex: 0, pieceId: id, to });
        await assertConsistent(`${to}(${id}) ok=${r.ok}`);
      }
    }
  });

  await check("consistent after ADD PAGE", async () => {
    await reset();
    const r = await applyPageOp(dir, script(), { op: "add", after: 0 });
    assert(r.ok, `add page failed: ${r.error}`);
    await assertConsistent("add page");
  });

  await check("consistent after DUPLICATE PAGE", async () => {
    await reset();
    const r = await applyPageOp(dir, script(), { op: "duplicate", page: 0 });
    assert(r.ok, `duplicate page failed: ${r.error}`);
    await assertConsistent("duplicate page");
  });

  await check("consistent after REMOVE PAGE", async () => {
    await reset();
    const r = await applyPageOp(dir, script(), { op: "remove", page: 1 });
    assert(r.ok, `remove page failed: ${r.error}`);
    await assertConsistent("remove page");
  });

  await check("consistent after MOVE PAGE", async () => {
    await reset();
    const r = await applyPageOp(dir, script(), { op: "move", page: 0, to: 1 });
    assert(r.ok, `move page failed: ${r.error}`);
    await assertConsistent("move page");
  });

  await check("consistent after UNDO of a delete", async () => {
    await reset();
    const before = await manifestIds();
    await deleteElement({ genDir: dir, sceneIndex: 0, pieceId: "s0.card" });
    await assertConsistent("delete before undo");
    const u = await undoEdit(dir);
    assert(u.ok, `undo failed: ${JSON.stringify(u)}`);
    await assertConsistent("undo");
    assert(
      (await manifestIds()).join(",") === before.join(","),
      "undo should restore exactly the pieces that were there",
    );
  });

  await check("consistent after a LONG mixed sequence", async () => {
    await reset();
    await moveElement({ genDir: dir, sceneIndex: 0, pieceId: "s0.card", dx: 20, dy: 10 });
    await assertConsistent("seq/move");
    await resizeElement({ genDir: dir, sceneIndex: 0, pieceId: "s0.card", x: 10, y: 20, w: 320, h: 200 });
    await assertConsistent("seq/resize");
    await insertElement({
      genDir: dir, scriptId: "t", sceneIndex: 0,
      bounds: { x: 400, y: 400, w: 200, h: 100 },
      spec: { mode: "primitive", primitive: "text", text: "Mixed" },
    });
    await assertConsistent("seq/insert");
    await applyPageOp(dir, script(), { op: "duplicate", page: 0 });
    await assertConsistent("seq/duplicate page");
    await deleteElement({ genDir: dir, sceneIndex: 0, pieceId: "s0.back" });
    await assertConsistent("seq/delete");
    await reorderElement({ genDir: dir, sceneIndex: 0, pieceId: "s0.copy", to: "front" });
    await assertConsistent("seq/front");
    await undoEdit(dir);
    await assertConsistent("seq/undo");
  });

  await check("an operation on a MISSING piece changes nothing", async () => {
    await reset();
    const before = await renderedIds();
    for (const op of [
      () => moveElement({ genDir: dir, sceneIndex: 0, pieceId: "s0.nope", dx: 5, dy: 5 }),
      () => resizeElement({ genDir: dir, sceneIndex: 0, pieceId: "s0.nope", x: 0, y: 0, w: 100, h: 100 }),
      () => deleteElement({ genDir: dir, sceneIndex: 0, pieceId: "s0.nope" }),
      () => reorderElement({ genDir: dir, sceneIndex: 0, pieceId: "s0.nope", to: "front" }),
    ]) {
      const r = await op();
      assert(!r.ok, "an operation on a nonexistent piece should be refused");
      await assertConsistent("refused op on a missing piece");
    }
    assert((await renderedIds()).join(",") === before.join(","), "refusals must not change the render");
  });

  await check("an operation on a MISSING scene changes nothing", async () => {
    await reset();
    const before = await renderedIds();
    const r = await moveElement({ genDir: dir, sceneIndex: 99, pieceId: "s0.card", dx: 5, dy: 5 });
    assert(!r.ok, "an operation on a nonexistent scene should be refused");
    await assertConsistent("refused op on a missing scene");
    assert((await renderedIds()).join(",") === before.join(","), "refusals must not change the render");
  });

  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
};

await run();
