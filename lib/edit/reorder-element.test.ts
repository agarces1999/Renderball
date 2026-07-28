/**
 * Z-order: bring an element to the front / send it to the back.
 *
 * Paint order is SLOT order in the scene template ({/*RB:<id>*\/} markers), not
 * the order of the manifest's `pieces` array — pieces render as fragments in a
 * single stacking context, so the slot emitted last paints on top. These tests
 * assert against the reassembled Composition rather than the manifest, because
 * the Composition is what actually renders: a test that only checked the array
 * would pass while the slide looked identical.
 */
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { decomposeGenDir } from "../agents/lego-store";
import { reorderElement } from "./edit-layout";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => Promise<void>) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

const CODE = `import React from "react";
import { Piece } from "./Piece";

export const Section0: React.FC<{ script: any }> = () => (
  <div style={{ position: "absolute", inset: 0 }}>
    <Piece id="s0.back" kind="atmosphere"><div style={{ position: "absolute", left: 0, top: 0, width: 100, height: 100 }} /></Piece>
    <Piece id="s0.mid" kind="text"><div style={{ position: "absolute", left: 10, top: 10, width: 100, height: 100 }} /></Piece>
    <Piece id="s0.top" kind="chrome"><div style={{ position: "absolute", left: 20, top: 20, width: 100, height: 100 }} /></Piece>
  </div>
);

export const Generated: React.FC<{ script: any }> = ({ script }) => (<Section0 script={script} />);
`;

const dir = path.join(os.tmpdir(), "rb-reorder-element-test");
const comp = async (): Promise<string> => fs.readFile(path.join(dir, "Composition.tsx"), "utf8");

/** Paint order as it will actually render: the order the ids appear in the file. */
const order = async (): Promise<string[]> => {
  const c = await comp();
  return ["s0.back", "s0.mid", "s0.top"]
    .map((id) => ({ id, at: c.indexOf(`id="${id}"`) }))
    .filter((e) => e.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((e) => e.id);
};

const run = async () => {
  console.log("reorder-element");

  await check("setup: three stacked pieces decompose", async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "Composition.tsx"), CODE, "utf8");
    const rep = await decomposeGenDir(dir);
    assert(rep.ok && rep.pieces === 3, `decompose: ${JSON.stringify(rep)}`);
    const o = await order();
    assert(o.join(",") === "s0.back,s0.mid,s0.top", `initial order wrong: ${o.join(",")}`);
  });

  await check("bring to front puts the element LAST, so it paints on top", async () => {
    const r = await reorderElement({ genDir: dir, sceneIndex: 0, pieceId: "s0.back", to: "front" });
    assert(r.ok, `expected ok, got: ${r.error}`);
    const o = await order();
    assert(o[o.length - 1] === "s0.back", `expected s0.back last, got ${o.join(",")}`);
    assert(o.length === 3, `all three must survive, got ${o.join(",")}`);
  });

  await check("send to back puts the element FIRST, so it paints behind", async () => {
    const r = await reorderElement({ genDir: dir, sceneIndex: 0, pieceId: "s0.back", to: "back" });
    assert(r.ok, `expected ok, got: ${r.error}`);
    const o = await order();
    assert(o[0] === "s0.back", `expected s0.back first, got ${o.join(",")}`);
  });

  await check("the composition still compiles after reordering", async () => {
    const c = await comp();
    assert(c.includes("export const Section0"), "section export lost");
    assert(c.includes("export const Generated"), "generated export lost");
    // Each piece appears exactly once — a slot must MOVE, never duplicate.
    for (const id of ["s0.back", "s0.mid", "s0.top"]) {
      const n = c.split(`id="${id}"`).length - 1;
      assert(n === 1, `piece ${id} appears ${n}× (a slot was duplicated)`);
    }
  });

  await check("front is idempotent — repeating it does not corrupt the order", async () => {
    await reorderElement({ genDir: dir, sceneIndex: 0, pieceId: "s0.mid", to: "front" });
    const first = (await order()).join(",");
    await reorderElement({ genDir: dir, sceneIndex: 0, pieceId: "s0.mid", to: "front" });
    const second = (await order()).join(",");
    assert(first === second, `order changed on a repeat: ${first} → ${second}`);
    assert(second.endsWith("s0.mid"), `s0.mid should be on top, got ${second}`);
  });

  // The bug live testing caught and this fixture originally did not: the
  // insertion point was derived by indexing the piece list with a FILTERED
  // position list's index. With every piece slotted the two line up by luck;
  // remove one slot and the wrong marker's length is used, dropping the moved
  // marker inside another comment — and the element vanishes from the slide.
  await check("a scene with an unslotted piece still reorders WITHOUT losing anyone", async () => {
    const alt = path.join(os.tmpdir(), "rb-reorder-unslotted-test");
    await fs.rm(alt, { recursive: true, force: true });
    await fs.mkdir(alt, { recursive: true });
    await fs.writeFile(path.join(alt, "Composition.tsx"), CODE, "utf8");
    await decomposeGenDir(alt);

    // Strip ONE slot from the template, leaving its piece in the manifest —
    // exactly the mismatch a real deck can present.
    const mPath = path.join(alt, "lego", "manifest.json");
    const manifest = JSON.parse(await fs.readFile(mPath, "utf8"));
    manifest.scenes[0].template = manifest.scenes[0].template.replace("{/*RB:s0.mid*/}", "");
    await fs.writeFile(mPath, JSON.stringify(manifest, null, 2), "utf8");

    const r = await reorderElement({ genDir: alt, sceneIndex: 0, pieceId: "s0.back", to: "front" });

    // The contract is NOT "always succeeds" — it is "never loses anyone". A
    // reorder that cannot be done without dropping a piece must refuse and leave
    // the document exactly as it was. Either outcome is acceptable; a silent
    // deletion is not.
    const c = await fs.readFile(path.join(alt, "Composition.tsx"), "utf8");
    if (r.ok) {
      assert(c.includes('id="s0.back"'), "the MOVED piece disappeared from the composition");
      assert(c.includes('id="s0.top"'), "an untouched piece disappeared from the composition");
      assert(!/\{\/\*RB:[^*]*\{\/\*RB:/.test(c), "a slot marker was nested inside another");
    } else {
      assert(r.code === "would-drop", `refusal must say why, got ${JSON.stringify(r.code)}`);
      assert(c.includes('id="s0.top"'), "a refusal must leave the document intact");
      const m = JSON.parse(await fs.readFile(path.join(alt, "lego", "manifest.json"), "utf8"));
      assert(m.scenes[0].pieces.length === 3, "a refusal must not remove anything from the manifest");
    }

    await fs.rm(alt, { recursive: true, force: true }).catch(() => {});
  });

  /**
   * The invariant that matters more than order itself: reordering must never
   * LOSE anyone. When a marker went missing the reassembled Composition dropped
   * that element, and the next commit re-derived the manifest from that
   * Composition — so a cosmetic operation permanently deleted the piece. Every
   * piece is driven to front and to back in turn, and the full set is
   * re-asserted after each step.
   */
  await check("no sequence of front/back ever loses a piece (manifest AND render)", async () => {
    const ids = ["s0.back", "s0.mid", "s0.top"];
    for (const id of ids) {
      for (const to of ["front", "back"] as const) {
        const r = await reorderElement({ genDir: dir, sceneIndex: 0, pieceId: id, to });
        assert(r.ok, `${to}(${id}) failed: ${r.error}`);

        const c = await comp();
        for (const other of ids) {
          const n = c.split(`id="${other}"`).length - 1;
          assert(n === 1, `after ${to}(${id}), piece ${other} appears ${n}× in the render`);
        }
        const m = JSON.parse(await fs.readFile(path.join(dir, "lego", "manifest.json"), "utf8"));
        const kept: string[] = m.scenes[0].pieces.map((p: { id: string }) => p.id);
        assert(kept.length === 3, `after ${to}(${id}) the manifest holds ${kept.join(",")}`);
      }
    }
  });

  await check("an unknown piece is refused", async () => {
    const r = await reorderElement({ genDir: dir, sceneIndex: 0, pieceId: "s0.nope", to: "front" });
    assert(!r.ok && /not found/.test(r.error ?? ""), `expected not-found, got ${JSON.stringify(r)}`);
  });

  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
};

await run();
