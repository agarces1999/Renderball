//
// Tests for element INSERT (add primitives + the generate-path store mechanics) and
// free-text editing, at the orchestration level. Uses a temp genDir decomposed from a
// small composition WITH a chrome piece (so slot-before-chrome is exercised). No
// network — the LLM generate call itself is covered by E2E; here we drive the same
// insertPiece → reassemble → finalize → compile path with a synthetic generated body.
//
import { decomposeGenDir, readManifest, reassembleFromDisk, insertPiece, nextPieceId } from "../agents/lego-store";
import { insertElement, parseInsertBody } from "./insert-element";
import { inlineAssetSrcs } from "./image-assets";
import { editPieceText } from "./edit-piece-text";
import { readFreetext, themeSwatches } from "./freetext";
import { deleteElement, resizeElement } from "./edit-layout";
import { undoEdit, undoAvailable } from "./undo-edit";
import { finalizeUndefinedRefs } from "../agents/finalize-refs";
import { verifyCompilable } from "../agents/code-extraction";
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
import { Img } from "remotion";
import { Piece } from "./Piece";

const PALETTE = { accent: "#ccff00", ink: "#f4f1ea" };

export const Section0: React.FC<{ script: any }> = ({ script }) => {
  const c = script.scenes[0].content;
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <Piece id="s0.atmos" kind="atmosphere"><div style={{ position: "absolute", inset: 0, background: PALETTE.accent }} /></Piece>
      <Piece id="s0.copy" kind="text"><h1 style={{ position: "absolute", left: 96, top: 100, color: PALETTE.ink }}>{c.headline}</h1></Piece>
      <Piece id="s0.chrome" kind="chrome"><div style={{ position: "absolute", left: 40, top: 40 }}>logo</div></Piece>
    </div>
  );
};

export const Generated: React.FC<{ script: any }> = ({ script }) => (<Section0 script={script} />);
`;

const dir = path.join(os.tmpdir(), "rb-insert-element-test");
const comp = async () => fs.readFile(path.join(dir, "Composition.tsx"), "utf8");

console.log("\n▶ insert-element");

await check("setup: decompose a temp genDir (3 pieces incl. chrome)", async () => {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "Composition.tsx"), CODE, "utf8");
  const rep = await decomposeGenDir(dir);
  assert(rep.ok && rep.pieces === 3, `decompose: ${JSON.stringify(rep)}`);
});

await check("insert text primitive: compiles, freetext literal present, slot BEFORE chrome", async () => {
  const r = await insertElement({ genDir: dir, scriptId: "t", sceneIndex: 0, bounds: { x: 100, y: 200, w: 400, h: 120 }, spec: { mode: "primitive", primitive: "text", text: "Your text" } });
  assert(r.ok && r.pieceId === "s0.add1", `insert text: ${JSON.stringify(r)}`);
  const code = await comp();
  assert(code.includes('id="s0.add1"'), "inserted piece openTag missing");
  assert(code.includes('data-rb-freetext="1"'), "freetext marker missing");
  assert(code.includes("Your text"), "freetext literal missing");
  // painted before chrome (chrome stays on top)
  assert(code.indexOf('id="s0.add1"') < code.indexOf('id="s0.chrome"'), "inserted piece not before chrome");
  // positioned at the marquee box
  assert(/left: 100, top: 200/.test(code), "inserted wrapper not at bounds");
});

await check("nextPieceId allocates a fresh id (no collision with add1)", async () => {
  const id = await nextPieceId(dir, 0);
  assert(id === "s0.add2", `expected s0.add2, got ${id}`);
});

await check("edit free-text replaces the literal in place; compiles", async () => {
  const r = await editPieceText({ genDir: dir, sceneIndex: 0, pieceId: "s0.add1", value: "Hello World" });
  assert(r.ok, `edit-piece-text: ${r.error}`);
  const code = await comp();
  assert(code.includes("Hello World") && !code.includes("Your text"), "free-text not replaced");
});

await check("edit free-text on a non-freetext piece → ok:false", async () => {
  const r = await editPieceText({ genDir: dir, sceneIndex: 0, pieceId: "s0.copy", value: "nope" });
  assert(!r.ok && /free-text/.test(r.error ?? ""), `expected no-freetext rejection, got ${JSON.stringify(r)}`);
});

await check("format edit applies size/bold/italic/underline/colour/align; text preserved", async () => {
  const r = await editPieceText({
    genDir: dir,
    sceneIndex: 0,
    pieceId: "s0.add1",
    format: { size: 48, weight: 700, italic: true, underline: true, color: "#ccff00", align: "center" },
  });
  assert(r.ok, `format edit: ${r.error}`);
  assert(r.format?.size === 48 && r.format?.weight === 700 && r.format?.align === "center", `format echo wrong: ${JSON.stringify(r.format)}`);
  const code = await comp();
  assert(/fontSize: 48/.test(code), "size not applied");
  assert(/fontWeight: 700/.test(code), "weight not applied");
  assert(/fontStyle: "italic"/.test(code), "italic not applied");
  assert(/textDecoration: "underline"/.test(code), "underline not applied");
  assert(/color: "#ccff00"/.test(code), "colour not applied");
  assert(/textAlign: "center"/.test(code), "align not applied");
  assert(code.includes("Hello World"), "copy lost by a format-only edit");
});

await check("format patch MERGES onto the stored format (partial patch keeps the rest)", async () => {
  const r = await editPieceText({ genDir: dir, sceneIndex: 0, pieceId: "s0.add1", format: { align: "right" } });
  assert(r.ok && r.format?.align === "right", `partial patch: ${JSON.stringify(r)}`);
  assert(r.format?.size === 48 && r.format?.weight === 700, `merge lost prior fields: ${JSON.stringify(r.format)}`);
});

await check("text edit preserves formatting (span re-emitted from the stored spec)", async () => {
  const r = await editPieceText({ genDir: dir, sceneIndex: 0, pieceId: "s0.add1", value: "Restyled copy" });
  assert(r.ok, `text edit: ${r.error}`);
  const code = await comp();
  assert(code.includes("Restyled copy"), "copy not updated");
  assert(/fontSize: 48/.test(code) && /textAlign: "right"/.test(code), "formatting lost by a text edit");
});

await check("an unsafe colour is rejected/sanitized (never reaches the source)", async () => {
  const r = await editPieceText({
    genDir: dir,
    sceneIndex: 0,
    pieceId: "s0.add1",
    format: { color: '"; alert(1); //' },
  });
  assert(r.ok, `sanitize edit: ${r.error}`);
  assert(r.format?.color === "inherit", `unsafe colour not sanitized: ${JSON.stringify(r.format)}`);
  const code = await comp();
  assert(!code.includes("alert(1)"), "unsafe colour leaked into the composition");
});

await check("format spec round-trips through the emitted span", async () => {
  const body = await fs.readFile(path.join(dir, "lego", "pieces", "s0.add1.tsx"), "utf8");
  const read = readFreetext(body);
  assert(!!read, "readFreetext failed on an emitted span");
  assert(read!.text === "Restyled copy", `text round-trip: ${read!.text}`);
  assert(read!.format.size === 48 && read!.format.align === "right" && read!.format.color === "inherit",
    `format round-trip: ${JSON.stringify(read!.format)}`);
});

await check("themeSwatches pulls the video's own palette colours", async () => {
  const swatches = themeSwatches('const PALETTE = { accent: "#ccff00", ink: "#f4f1ea" }; const faint = "rgba(0,0,0,0.05)";');
  assert(swatches.includes("#ccff00") && swatches.includes("#f4f1ea"), `missing palette hexes: ${JSON.stringify(swatches)}`);
  assert(!swatches.some((s) => s.startsWith("rgba")), `near-transparent tint should be skipped: ${JSON.stringify(swatches)}`);
});

await check("insert image primitive: emits <Img>, compiles", async () => {
  const r = await insertElement({ genDir: dir, scriptId: "t", sceneIndex: 0, bounds: { x: 50, y: 50, w: 300, h: 200 }, spec: { mode: "primitive", primitive: "image" } });
  assert(r.ok && r.pieceId === "s0.add2", `insert image: ${JSON.stringify(r)}`);
  const code = await comp();
  assert(/id="s0.add2"[\s\S]*<Img /.test(code), "inserted image <Img> missing");
});

await check("insert icon primitive: default Sparkles auto-imported from lucide", async () => {
  const r = await insertElement({ genDir: dir, scriptId: "t", sceneIndex: 0, bounds: { x: 10, y: 10, w: 80, h: 80 }, spec: { mode: "primitive", primitive: "icon" } });
  assert(r.ok && r.pieceId === "s0.add3", `insert icon: ${JSON.stringify(r)}`);
  const code = await comp();
  assert(code.includes("<Sparkles"), "icon not emitted");
  assert(/from ["']lucide-react["']/.test(code) && /\bSparkles\b/.test(code.match(/import[^;]*lucide-react[^;]*/)?.[0] ?? ""), "Sparkles not auto-imported");
});

await check("insert rejects non-positive bounds", async () => {
  const r = await insertElement({ genDir: dir, scriptId: "t", sceneIndex: 0, bounds: { x: 0, y: 0, w: 0, h: 100 }, spec: { mode: "primitive", primitive: "text" } });
  assert(!r.ok && /positive|finite/.test(r.error ?? ""), `expected bounds rejection, got ${JSON.stringify(r)}`);
});

await check("insert on a missing scene → ok:false, not found", async () => {
  const r = await insertElement({ genDir: dir, scriptId: "t", sceneIndex: 9, bounds: { x: 1, y: 1, w: 10, h: 10 }, spec: { mode: "primitive", primitive: "text" } });
  assert(!r.ok && /not found/.test(r.error ?? ""), `expected not-found, got ${JSON.stringify(r)}`);
});

await check("generate store path: a synthetic generated body inserts + reassembles + compiles", async () => {
  // Simulate what the LLM returns (inner JSX only); the orchestrator wraps it — here
  // we drive the store path insertElement's generate branch uses after generatePiece.
  const id = await nextPieceId(dir, 0);
  const openTag = `<Piece id=${JSON.stringify(id)} kind="diegetic">`;
  const inner = `<div style={{ display: "flex", width: "100%", height: "100%" }}><span>3.2x</span></div>`;
  const body = `<div data-piece=${JSON.stringify(id)} data-kind="diegetic" style={{ position: "absolute", left: 120, top: 300, width: 500, height: 260, zIndex: 9, overflow: "hidden" }}>${inner}</div>`;
  const ok = await insertPiece(dir, { sceneIndex: 0, id, kind: "diegetic", openTag, body });
  assert(ok, "insertPiece returned false");
  const reassembled = await reassembleFromDisk(dir);
  assert(reassembled.includes(openTag) && reassembled.includes("3.2x"), "generated piece not reassembled");
  const { code } = await finalizeUndefinedRefs(reassembled);
  assert(!(await verifyCompilable(code)), "generated composition does not compile");
  await fs.writeFile(path.join(dir, "Composition.tsx"), code, "utf8"); // persist, like commit()
});

// ---- generate-image (diffusion → asset → <Img>) ----------------------------

// A real (1×1 transparent) PNG so the transport's signature check passes and a
// genuine file lands under assets/.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

await check("generate-image: mocked provider → asset on disk + <Img> at the box, compiles", async () => {
  const realFetch = globalThis.fetch;
  process.env.RB_FIREWORKS_KEY = process.env.RB_FIREWORKS_KEY || "test-key";
  globalThis.fetch = (() =>
    Promise.resolve(new Response(TINY_PNG, { status: 200, headers: { "content-type": "image/png" } }))) as typeof fetch;
  try {
    const r = await insertElement({
      genDir: dir,
      scriptId: "t",
      sceneIndex: 0,
      bounds: { x: 40, y: 40, w: 640, h: 360 },
      spec: { mode: "generate-image", prompt: "a calm teal gradient" },
    });
    assert(r.ok && !!r.pieceId, `generate-image insert: ${JSON.stringify(r)}`);
    const code = await comp();
    // finalize normalizes src={"…"} to the plain attribute form.
    const ref = code.match(/src="(assets\/img-[0-9a-f]{12}\.png)"/)?.[1];
    assert(!!ref, `composition must reference the stored asset, got: ${code.match(/src=[^ ]*/)?.[0]}`);
    const bytes = await fs.readFile(path.join(dir, ref!));
    assert(bytes.equals(TINY_PNG), "stored asset bytes must be the provider's PNG");
    assert(new RegExp(`id="${r.pieceId}"[\\s\\S]*left: 40, top: 40, width: 640, height: 360`).test(code), "deterministic wrapper must carry the drawn bounds");
    // The SSR inline pass swaps the token for a data URI (what export renders).
    const inlined = await inlineAssetSrcs(`<img src="${ref}"/>`, dir);
    assert(inlined.startsWith('<img src="data:image/png;base64,'), "inlineAssetSrcs must produce a data URI");
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check("generate-image: provider failure → ok:false, no piece added", async () => {
  const realFetch = globalThis.fetch;
  const before = (await readManifest(dir)).scenes[0].pieces.length;
  globalThis.fetch = (() =>
    Promise.resolve(new Response(JSON.stringify({ error: { message: "Unauthorized" } }), { status: 401 }))) as typeof fetch;
  try {
    const r = await insertElement({
      genDir: dir,
      scriptId: "t",
      sceneIndex: 0,
      bounds: { x: 0, y: 0, w: 100, h: 100 },
      spec: { mode: "generate-image", prompt: "x" },
    });
    assert(!r.ok && /isn't enabled|image generation failed/.test(r.error ?? ""), `expected friendly failure, got ${JSON.stringify(r)}`);
    assert((await readManifest(dir)).scenes[0].pieces.length === before, "no piece may be added on failure");
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check("parseInsertBody accepts generate-image and demands a prompt", () => {
  const okBody = parseInsertBody({ scriptId: "s", sceneIndex: 0, bounds: { x: 1, y: 1, w: 10, h: 10 }, mode: "generate-image", prompt: "a dog" });
  assert(okBody.ok && okBody.spec.mode === "generate-image", `parse ok: ${JSON.stringify(okBody)}`);
  const noPrompt = parseInsertBody({ scriptId: "s", sceneIndex: 0, bounds: { x: 1, y: 1, w: 10, h: 10 }, mode: "generate-image", prompt: "  " });
  assert(!noPrompt.ok && /Describe the image/.test(noPrompt.ok ? "" : noPrompt.error), "blank prompt must be rejected");
});

await check("inserted pieces re-decompose cleanly (byte-identical round-trip)", async () => {
  const rep = await decomposeGenDir(dir);
  // atmos, copy, chrome + add1(text) + add2(image) + add3(icon) + the synthetic
  // generated one + the generate-image piece = 8
  assert(rep.ok && rep.pieces === 8, `re-decompose: ${JSON.stringify(rep)}`);
});

await check("delete an inserted piece: clean removal, siblings survive", async () => {
  const r = await deleteElement({ genDir: dir, sceneIndex: 0, pieceId: "s0.add2" });
  assert(r.ok, `delete: ${JSON.stringify(r)}`);
  const code = await comp();
  assert(!code.includes('id="s0.add2"') && !code.includes("RB:s0.add2"), "inserted piece not fully removed");
  assert(code.includes('id="s0.add1"') && code.includes('id="s0.chrome"'), "siblings dropped by delete");
});

// ---- resize -----------------------------------------------------------------

await check("resize rewrites the wrapper's box (left/top/width) and compiles", async () => {
  const r = await resizeElement({ genDir: dir, sceneIndex: 0, pieceId: "s0.add1", x: 50, y: 60, w: 300, h: 120 });
  assert(r.ok, `resize: ${r.error}`);
  const body = await fs.readFile(path.join(dir, "lego", "pieces", "s0.add1.tsx"), "utf8");
  assert(/left: 50/.test(body) && /top: 60/.test(body), `origin not rewritten: ${body.slice(0, 160)}`);
  assert(/width: 300/.test(body) && /maxWidth: 300/.test(body), "width/maxWidth not rewritten");
  const code = await comp();
  assert(/left: 50, top: 60/.test(code), "resized box not in the composition");
});

await check("resize rejects a body that isn't a positioned box (clear reason)", async () => {
  const r = await resizeElement({ genDir: dir, sceneIndex: 0, pieceId: "s0.copy", x: 0, y: 0, w: 100, h: 100 });
  assert(!r.ok && /positioned box|can't be resized/.test(r.error ?? ""), `expected resize rejection, got ${JSON.stringify(r)}`);
});

await check("resize rejects non-positive bounds", async () => {
  const r = await resizeElement({ genDir: dir, sceneIndex: 0, pieceId: "s0.add1", x: 0, y: 0, w: 0, h: 10 });
  assert(!r.ok && /positive/.test(r.error ?? ""), `expected bounds rejection, got ${JSON.stringify(r)}`);
});

// ---- undo -------------------------------------------------------------------

await check("undo reverses the last edit (resize) and pops the stack", async () => {
  const before = await undoAvailable(dir);
  assert(before > 0, "expected undo history from the preceding edits");
  const r = await undoEdit(dir);
  assert(r.ok && r.label === "resize", `undo: ${JSON.stringify(r)}`);
  const body = await fs.readFile(path.join(dir, "lego", "pieces", "s0.add1.tsx"), "utf8");
  assert(/left: 100/.test(body) && /width: 400/.test(body), `resize not reverted: ${body.slice(0, 160)}`);
  assert((await undoAvailable(dir)) === before - 1, "undo did not pop the stack");
});

await check("undo restores a DELETED piece (snapshot covers adds and deletes)", async () => {
  const ins = await insertElement({ genDir: dir, scriptId: "t", sceneIndex: 0, bounds: { x: 10, y: 10, w: 200, h: 80 }, spec: { mode: "primitive", primitive: "text", text: "Doomed" } });
  assert(ins.ok, `setup insert: ${ins.error}`);
  const id = ins.pieceId!;
  const del = await deleteElement({ genDir: dir, sceneIndex: 0, pieceId: id });
  assert(del.ok, `setup delete: ${del.error}`);
  assert(!(await comp()).includes(`id="${id}"`), "piece should be gone before undo");

  const r = await undoEdit(dir);
  assert(r.ok && r.label === "delete", `undo delete: ${JSON.stringify(r)}`);
  const code = await comp();
  assert(code.includes(`id="${id}"`) && code.includes("Doomed"), "deleted piece not restored by undo");
});

await check("undo of an INSERT removes the piece again", async () => {
  const r = await undoEdit(dir); // the insert from the previous case
  assert(r.ok && r.label === "add", `undo insert: ${JSON.stringify(r)}`);
  assert(!(await comp()).includes("Doomed"), "inserted piece not removed by undo");
});

await check("undo with an empty stack → ok:false, nothing to undo", async () => {
  for (let i = 0; i < 40 && (await undoAvailable(dir)) > 0; i++) await undoEdit(dir);
  const r = await undoEdit(dir);
  assert(!r.ok && /nothing to undo/.test(r.error ?? ""), `expected empty-stack rejection, got ${JSON.stringify(r)}`);
});

await fs.rm(dir, { recursive: true, force: true }).catch(() => {});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
