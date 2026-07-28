/**
 * A blank document must be EDITABLE from the first second.
 *
 * The production failure this pins down: `writeBlankDocument` wrote a valid
 * Composition.tsx but no lego/ directory, because decomposition only ever ran
 * at the end of a real build. Every editor mutation reads the piece manifest,
 * so the first action on a brand-new document — draw a box and generate, add
 * text, add an image — threw
 *
 *     ENOENT: no such file or directory, open '.../lego/manifest.json'
 *
 * out of an API route with no try/catch. The user saw "request failed (500)"
 * while doing the one thing the whole product is sold on.
 *
 * Two properties are asserted, because there are two fixes and either alone
 * would leave a hole: new documents are decomposed at creation, AND a document
 * that somehow has no manifest heals itself on read (documents created before
 * the fix are already on disk and must not need recreating).
 */
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { blankCompositionSource } from "./blank-document";
import { writeGeneratedFiles } from "../render/build-wrapper";
import { blankScript } from "./blank-document";
import { insertElement } from "../edit/insert-element";
import { readManifest } from "../agents/lego-store";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => Promise<void>) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

const dir = path.join(os.tmpdir(), "rb-blank-doc-edit-test");
const legoDir = path.join(dir, "lego");

/** Materialise a blank document at `dir` WITHOUT the decompose step, i.e. what
 *  writeBlankDocument produced before the fix and what is already on disk for
 *  documents created then. (writeBlankDocument itself targets src/generated.) */
const writeUndecomposedBlank = async () => {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  const code = blankCompositionSource(1);
  await writeGeneratedFiles(dir, { designCode: code, code, script: blankScript("T", 1), warnings: {} });
  await fs.rm(legoDir, { recursive: true, force: true }); // ensure no manifest
};

const run = async () => {
  console.log("blank-document-edit");

  await check("a blank composition decomposes — it really does carry a <Piece>", async () => {
    await writeUndecomposedBlank();
    const m = await readManifest(dir); // heals
    assert(m.scenes.length === 1, `expected 1 scene, got ${m.scenes.length}`);
    assert(m.scenes[0].pieces.length >= 1, "a blank page must expose at least one editable piece");
  });

  await check("readManifest HEALS a document with no lego/ (repairs docs made before the fix)", async () => {
    await writeUndecomposedBlank();
    const exists = await fs.stat(path.join(legoDir, "manifest.json")).then(() => true).catch(() => false);
    assert(!exists, "precondition: the manifest must be absent");
    await readManifest(dir);
    const healed = await fs.stat(path.join(legoDir, "manifest.json")).then(() => true).catch(() => false);
    assert(healed, "readManifest must derive the manifest instead of throwing ENOENT");
  });

  await check("insertElement works on an undecomposed blank doc — THE 500", async () => {
    await writeUndecomposedBlank();
    const r = await insertElement({
      genDir: dir,
      scriptId: "T",
      sceneIndex: 0,
      bounds: { x: 100, y: 200, w: 400, h: 120 },
      spec: { mode: "primitive", primitive: "text", text: "Your text" },
    });
    assert(r.ok, `insert must succeed, got: ${JSON.stringify(r).slice(0, 200)}`);
  });

  await check("the inserted element lands at the drawn bounds", async () => {
    const code = await fs.readFile(path.join(dir, "Composition.tsx"), "utf8");
    assert(/left: 100, top: 200/.test(code), "inserted wrapper is not at the marquee bounds");
    assert(code.includes("Your text"), "inserted text literal missing");
  });

  await check("a directory with no composition fails in WORDS, not an fs errno", async () => {
    const empty = path.join(os.tmpdir(), "rb-blank-doc-edit-empty");
    await fs.rm(empty, { recursive: true, force: true });
    await fs.mkdir(empty, { recursive: true });
    let msg = "";
    try { await readManifest(empty); } catch (e) { msg = e instanceof Error ? e.message : String(e); }
    assert(msg !== "", "must throw for a directory with nothing to decompose");
    assert(!/ENOENT/.test(msg), `must not leak an fs errno to the caller: ${msg}`);
    await fs.rm(empty, { recursive: true, force: true });
  });

  await fs.rm(dir, { recursive: true, force: true });
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
};

await run();
