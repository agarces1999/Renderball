/**
 * Resizing a piece.
 *
 * WHY THIS EXISTS. Resize was reported as "not working", and on a real deck it
 * was: only 1 of 4 pieces could be resized. Three separate causes, each of which
 * gets a test here because each failed SILENTLY or with a misleading message.
 *
 *  1. The wrapper was located with a regex bounded by `[^{}]*`, so any style
 *     containing a template literal — `background: \`…${PALETTE.x}\`` , which
 *     generated pieces use constantly — was reported as "not a positioned box"
 *     despite being exactly that.
 *  2. Values were only rewritten when they were bare numbers, so a box
 *     positioned in percentages (`left: "62%"`) was left untouched: the API
 *     answered "resized" and the element did not move.
 *  3. Centring offsets (negative margins, translate(-50%,-50%)) survived the
 *     rewrite, so an element dropped at an explicit box landed somewhere else.
 *
 * Pieces that genuinely are not a single positioned box — a bare component, or a
 * fragment of siblings positioned in the section's coordinate space — must still
 * be refused, but with a machine-readable `code` so the editor can rebuild them
 * at the new size instead.
 */
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { decomposeGenDir, readDecomposed } from "../agents/lego-store";
import { resizeElement } from "./edit-layout";

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
    <Piece id="s0.plain" kind="text"><div style={{ position: "absolute", left: 80, top: 400, width: 200, height: 120 }} /></Piece>
    <Piece id="s0.tmpl" kind="atmosphere"><div style={{ position: "absolute", left: "62%", top: "28%", width: 720, height: 720, marginLeft: -360, marginTop: -360, background: \`radial-gradient(circle at 50% 50%, \${PALETTE.accent}, transparent)\` }} /></Piece>
    <Piece id="s0.centred" kind="text"><div style={{ position: "absolute", left: 500, top: 300, width: 400, height: 100, transform: "translate(-50%, -50%)" }} /></Piece>
    <Piece id="s0.bare" kind="chrome"><Chrome sceneIndex={0} /></Piece>
  </div>
);

export const Generated: React.FC<{ script: any }> = ({ script }) => (<Section0 script={script} />);
`;

const dir = path.join(os.tmpdir(), "rb-resize-element-test");
const bodyOf = async (id: string): Promise<string> => {
  const d = await readDecomposed(dir);
  const p = d.scenes[0].pieces.find((x) => x.id === id);
  if (!p) throw new Error(`piece ${id} missing`);
  return p.body;
};

const run = async () => {
  console.log("resize-element");

  await check("setup: decompose a fixture with four wrapper shapes", async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "Composition.tsx"), CODE, "utf8");
    const rep = await decomposeGenDir(dir);
    assert(rep.ok && rep.pieces === 4, `decompose: ${JSON.stringify(rep)}`);
  });

  await check("a plain numeric box resizes", async () => {
    const r = await resizeElement({ genDir: dir, sceneIndex: 0, pieceId: "s0.plain", x: 100, y: 150, w: 640, h: 320 });
    assert(r.ok, `expected ok, got: ${r.error}`);
    const b = await bodyOf("s0.plain");
    assert(/left:\s*100\b/.test(b) && /top:\s*150\b/.test(b), `origin not written: ${b.slice(0, 160)}`);
    assert(/width:\s*640\b/.test(b) && /height:\s*320\b/.test(b), `size not written: ${b.slice(0, 160)}`);
  });

  // Cause 1 + 2 together: the shape that broke it on the real deck.
  await check("a TEMPLATE-LITERAL style with PERCENTAGE origin resizes", async () => {
    const r = await resizeElement({ genDir: dir, sceneIndex: 0, pieceId: "s0.tmpl", x: 300, y: 260, w: 700, h: 340 });
    assert(r.ok, `expected ok, got: ${r.error}`);
    const b = await bodyOf("s0.tmpl");
    assert(/left:\s*300\b/.test(b), `percentage left was not replaced: ${b.slice(0, 200)}`);
    assert(/top:\s*260\b/.test(b), `percentage top was not replaced: ${b.slice(0, 200)}`);
    assert(/width:\s*700\b/.test(b) && /height:\s*340\b/.test(b), "size not written");
    assert(b.includes("radial-gradient"), "the template literal must survive the rewrite");
  });

  // Cause 3: offsets that would move the box off the dropped position.
  await check("negative centring margins are cleared", async () => {
    const b = await bodyOf("s0.tmpl");
    assert(!/marginLeft:/.test(b), `marginLeft survived and would shift the box: ${b.slice(0, 200)}`);
    assert(!/marginTop:/.test(b), "marginTop survived and would shift the box");
  });

  await check("a centring translate(-50%,-50%) is cleared", async () => {
    const r = await resizeElement({ genDir: dir, sceneIndex: 0, pieceId: "s0.centred", x: 40, y: 60, w: 300, h: 200 });
    assert(r.ok, `expected ok, got: ${r.error}`);
    const b = await bodyOf("s0.centred");
    assert(!/translate\(-50%/.test(b), `centring transform survived: ${b.slice(0, 200)}`);
    assert(/left:\s*40\b/.test(b) && /top:\s*60\b/.test(b), "origin not written");
  });

  await check("a bare component is refused with code 'no-wrapper', not a silent success", async () => {
    const r = await resizeElement({ genDir: dir, sceneIndex: 0, pieceId: "s0.bare", x: 10, y: 10, w: 200, h: 100 });
    assert(!r.ok, "a component with no box must not report success");
    assert(r.code === "no-wrapper", `expected code 'no-wrapper', got ${JSON.stringify(r.code)}`);
  });

  await check("bad bounds are rejected", async () => {
    const r = await resizeElement({ genDir: dir, sceneIndex: 0, pieceId: "s0.plain", x: 0, y: 0, w: 0, h: 100 });
    assert(!r.ok, "zero width must be rejected");
  });

  await check("an unknown piece is reported, not crashed", async () => {
    const r = await resizeElement({ genDir: dir, sceneIndex: 0, pieceId: "s0.nope", x: 0, y: 0, w: 10, h: 10 });
    assert(!r.ok && /not found/.test(r.error ?? ""), `expected not-found, got ${JSON.stringify(r)}`);
  });

  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
};

await run();
