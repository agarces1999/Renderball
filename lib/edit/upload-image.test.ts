/**
 * Tests for the canvas image-upload core: multipart validation + the
 * magic-byte gate. The insert mechanics themselves are covered by
 * insert-element.test.ts; here the focus is what may reach them.
 */
import { parseUploadForm, uploadImageElement } from "./upload-image";
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

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const form = (over: Partial<Record<"file" | "scriptId" | "sceneIndex" | "bounds", string | File>> = {}) => {
  const f = new FormData();
  f.append("file", (over.file as File) ?? new File([new Uint8Array(PNG)], "pic.png", { type: "image/png" }));
  f.append("scriptId", (over.scriptId as string) ?? "t");
  f.append("sceneIndex", (over.sceneIndex as string) ?? "0");
  f.append("bounds", (over.bounds as string) ?? JSON.stringify({ x: 10, y: 10, w: 200, h: 100 }));
  return f;
};

console.log("upload-image (canvas image upload core)");

await check("a well-formed multipart parses", () => {
  const p = parseUploadForm(form());
  assert(p.ok && p.scriptId === "t" && p.bounds.w === 200, `parse: ${JSON.stringify(p)}`);
});

await check("missing file / bad bounds / bad sceneIndex are each rejected", () => {
  const noFile = new FormData();
  noFile.append("scriptId", "t");
  assert(!parseUploadForm(noFile).ok, "no file must fail");
  const badBounds = parseUploadForm(form({ bounds: '{"x":1,"y":1,"w":-5,"h":5}' }));
  assert(!badBounds.ok, "negative bounds must fail");
  const badScene = parseUploadForm(form({ sceneIndex: "nope" }));
  assert(!badScene.ok, "non-numeric sceneIndex must fail");
});

await check("magic bytes gate the content: a script mislabeled image/png is rejected", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rb-upload-"));
  try {
    const evil = new File([`<script>alert(1)</script>`], "x.png", { type: "image/png" });
    const p = parseUploadForm(form({ file: evil }));
    assert(p.ok, "parse passes (type is client-supplied)");
    const r = await uploadImageElement(dir, p as Extract<typeof p, { ok: true }>);
    assert(!r.ok && /isn't an image/.test(r.error ?? ""), `sniff must reject, got ${JSON.stringify(r)}`);
    const assets = await fs.readdir(path.join(dir, "assets")).catch(() => []);
    assert(assets.length === 0, "nothing may land on disk");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

await check("a PDF (valid brand asset, not a canvas image) is rejected", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rb-upload-"));
  try {
    const pdf = new File([`%PDF-1.4 fake`], "doc.pdf", { type: "application/pdf" });
    const p = parseUploadForm(form({ file: pdf }));
    const r = await uploadImageElement(dir, p as Extract<typeof p, { ok: true }>);
    assert(!r.ok && /isn't an image/.test(r.error ?? ""), `pdf must reject, got ${JSON.stringify(r)}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

console.log(`\nupload-image: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
