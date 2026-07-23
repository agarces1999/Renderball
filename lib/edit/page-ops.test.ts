//
// Tests for deck page operations (duplicate / remove / move / add-blank) at the
// orchestration level: temp genDir decomposed from a small 3-scene composition,
// real writeDecomposed/commit path, no network. Verifies renumbering of Section
// exports, scenes[K] refs, piece ids/slots/files, deck timing retile, offset
// carriage, and rollback-safety guards.
//
import { decomposeGenDir, readManifest, setPieceOffset, undoDepth } from "../agents/lego-store";
import { undoEdit } from "./undo-edit";
import { applyPageOp, normalizePageOp } from "./page-ops";
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

const section = (k: number, label: string) => `
export const Section${k}: React.FC<{ script: any }> = ({ script }) => {
  const c = script.scenes[${k}].content;
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <Piece id="s${k}.atmos" kind="atmosphere"><div style={{ position: "absolute", inset: 0, background: PALETTE.bg }} /></Piece>
      <Piece id="s${k}.copy" kind="text"><h1 style={{ position: "absolute", left: 96, top: 100 }}>{c.headline} ${label}</h1></Piece>
      <Piece id="s${k}.chrome" kind="chrome"><div style={{ position: "absolute", left: 40, top: 40 }}>logo</div></Piece>
    </div>
  );
};
`;

const CODE = `import React from "react";
import { Piece } from "./Piece";

const PALETTE = { bg: "#f4f1ea" };
${section(0, "A")}${section(1, "B")}${section(2, "C")}
export const Generated: React.FC<{ script: any }> = ({ script }) => (<Section0 script={script} />);
`;

const scene = (i: number, label: string) => ({
  id: `01TESTSCENE${String(i).padStart(15, "0")}`,
  index: i,
  label,
  visual_concept: "test",
  content: { headline: `Head ${label}`, asset_ids: [] },
  start_seconds: i * 5,
  end_seconds: (i + 1) * 5,
});

const makeScript = (): Script =>
  ({
    id: "01TESTSCRIPT00000000000000",
    config: { duration_seconds: 15, aspect_ratio: "16:9", resolution: "1080p", tone: "t", pacing: "medium", kind: "deck" },
    scenes: [scene(0, "A"), scene(1, "B"), scene(2, "C")],
  }) as unknown as Script;

const dir = path.join(os.tmpdir(), "rb-page-ops-test");
const comp = async () => fs.readFile(path.join(dir, "Composition.tsx"), "utf8");
const reset = async () => {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "Composition.tsx"), CODE, "utf8");
  const rep = await decomposeGenDir(dir);
  assert(rep.ok && rep.pieces === 9, `decompose: ${JSON.stringify(rep)}`);
};

console.log("\n▶ page-ops");

await check("normalizePageOp accepts valid shapes, rejects junk", () => {
  assert(normalizePageOp({ op: "duplicate", page: 1 })?.op === "duplicate", "duplicate");
  assert(normalizePageOp({ op: "move", page: 0, to: 2 })?.op === "move", "move");
  assert(normalizePageOp({ op: "move", page: 0 }) === null, "move without to");
  assert(normalizePageOp({ op: "add", after: 0.5 }) === null, "non-integer");
  assert(normalizePageOp({ op: "explode" }) === null, "unknown op");
});

await check("duplicate: page count, renumbering, copy label, retile, focus", async () => {
  await reset();
  const r = await applyPageOp(dir, makeScript(), { op: "duplicate", page: 1 });
  assert(r.ok && r.pages === 4 && r.focus === 2, `result: ${JSON.stringify({ ok: r.ok, pages: r.pages, focus: r.focus, error: r.error })}`);
  const s = r.script!;
  assert(s.scenes.map((x) => x.label).join("|") === "A|B|B copy|C", `labels: ${s.scenes.map((x) => x.label)}`);
  assert(s.scenes[2].id !== s.scenes[1].id, "clone must get a fresh scene id");
  assert(s.scenes.every((x, i) => x.index === i), "scene.index not sequential");
  assert(s.scenes[3].start_seconds === 15 && s.scenes[3].end_seconds === 20, "deck retile wrong");
  assert(s.config.duration_seconds === 20, "duration not retiled");
  const code = await comp();
  for (let k = 0; k < 4; k++) assert(code.includes(`export const Section${k}`), `Section${k} missing`);
  assert(!code.includes("Section4"), "stray Section4");
  assert(code.includes("scenes[3]") && !code.includes("scenes[4]"), "scenes[] refs wrong");
  const m = await readManifest(dir);
  assert(m.scenes.map((x) => x.sceneIndex).join(",") === "0,1,2,3", "manifest indexes");
  assert(m.scenes[2].pieces.every((p) => p.id.startsWith("s2.")), `clone piece ids: ${m.scenes[2].pieces.map((p) => p.id)}`);
  assert(m.scenes[3].pieces.every((p) => p.id.startsWith("s3.")), "shifted piece ids");
  const files = await fs.readdir(path.join(dir, "lego", "pieces"));
  assert(files.includes("s3.copy.tsx") && files.includes("s2.copy.tsx"), `files: ${files.join(",")}`);
});

await check("remove middle page: renumbers down, guards last page", async () => {
  await reset();
  const r = await applyPageOp(dir, makeScript(), { op: "remove", page: 1 });
  assert(r.ok && r.pages === 2 && r.focus === 1, `remove: ${JSON.stringify({ pages: r.pages, focus: r.focus, error: r.error })}`);
  assert(r.script!.scenes.map((x) => x.label).join("|") === "A|C", "labels after remove");
  const code = await comp();
  assert(code.includes("export const Section1") && !code.includes("export const Section2"), "sections not renumbered");
  assert(code.includes(" A</h1>") && code.includes(" C</h1>") && !code.includes(" B</h1>"), "removed page's section still present (or survivors lost)");
  assert(r.script!.config.duration_seconds === 10, "duration after remove");
  // guard: removing down to zero is refused
  const one = { ...makeScript(), scenes: [scene(0, "solo")] } as unknown as Script;
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "Composition.tsx"), `import React from "react";\nimport { Piece } from "./Piece";\n\nconst PALETTE = { bg: "#fff" };\n${section(0, "solo")}\nexport const Generated: React.FC<{ script: any }> = ({ script }) => (<Section0 script={script} />);\n`, "utf8");
  await decomposeGenDir(dir);
  const guard = await applyPageOp(dir, one, { op: "remove", page: 0 });
  assert(!guard.ok && /at least one page/.test(guard.error ?? ""), `guard: ${guard.error}`);
});

await check("move 0 → 2: order, own-index refs follow", async () => {
  await reset();
  const r = await applyPageOp(dir, makeScript(), { op: "move", page: 0, to: 2 });
  assert(r.ok && r.focus === 2, `move: ${r.error}`);
  assert(r.script!.scenes.map((x) => x.label).join("|") === "B|C|A", `labels: ${r.script!.scenes.map((x) => x.label)}`);
  const code = await comp();
  // The old scene 0 ("A") now renders as Section2 reading scenes[2]
  const sec2 = code.slice(code.indexOf("export const Section2"));
  assert(sec2.includes("scenes[2]") && sec2.includes(" A</h1>"), "moved section refs/content wrong");
  const m = await readManifest(dir);
  assert(m.scenes[2].pieces.some((p) => p.id === "s2.copy"), "moved piece ids not retagged");
});

await check("add blank page: keeps background/chrome only, blank content", async () => {
  await reset();
  const r = await applyPageOp(dir, makeScript(), { op: "add", after: 0 });
  assert(r.ok && r.pages === 4 && r.focus === 1, `add: ${r.error}`);
  assert(r.script!.scenes[1].label === "New page", "blank label");
  assert(r.script!.scenes[1].content.headline === "New page", "blank headline");
  const m = await readManifest(dir);
  const kinds = m.scenes[1].pieces.map((p) => p.kind).sort().join(",");
  assert(kinds === "atmosphere,chrome", `blank kinds: ${kinds}`);
  const code = await comp();
  assert(!/Section1[\s\S]{0,600}Head/.test(code.slice(code.indexOf("export const Section1"), code.indexOf("export const Section2"))), "blank page still renders copy piece");
});

await check("move offsets survive the rewrite and follow their piece", async () => {
  await reset();
  const set = await setPieceOffset(dir, 1, "s1.copy", { dx: 12, dy: -8 });
  assert(set, "setPieceOffset failed");
  const r = await applyPageOp(dir, makeScript(), { op: "move", page: 1, to: 0 });
  assert(r.ok, `move: ${r.error}`);
  const m = await readManifest(dir);
  const pm = m.scenes[0].pieces.find((p) => p.id === "s0.copy");
  assert(!!pm?.offset && pm.offset.dx === 12 && pm.offset.dy === -8, `offset lost: ${JSON.stringify(pm?.offset)}`);
});

await check("page ops are undoable: snapshot carries the script, ring survives ops", async () => {
  await reset();
  const dup = await applyPageOp(dir, makeScript(), { op: "duplicate", page: 0 });
  assert(dup.ok && dup.pages === 4, `dup: ${dup.error}`);
  assert((await undoDepth(dir)) === 1, "ring should hold the duplicate snapshot");
  const rem = await applyPageOp(dir, dup.script!, { op: "remove", page: 3 });
  assert(rem.ok && rem.pages === 3, `remove: ${rem.error}`);
  assert((await undoDepth(dir)) === 2, "ring must SURVIVE the second op (was cleared before)");
  // Undo the remove → back to 4 pages, script restored and returned
  const u1 = await undoEdit(dir);
  assert(u1.ok && !!u1.script, `undo1: ${u1.error}`);
  const s1 = u1.script as Script;
  assert(s1.scenes.length === 4 && s1.scenes[1].label === "A copy", `undo1 script: ${s1.scenes.map((x) => x.label)}`);
  const m1 = await readManifest(dir);
  assert(m1.scenes.length === 4, "undo1 store scene count");
  // Undo the duplicate → original 3 pages
  const u2 = await undoEdit(dir);
  assert(u2.ok && !!u2.script, `undo2: ${u2.error}`);
  const s2 = u2.script as Script;
  assert(s2.scenes.length === 3 && s2.scenes.map((x) => x.label).join("|") === "A|B|C", "undo2 script");
  const code = await comp();
  assert(!code.includes("export const Section3"), "undo2 left a stray Section3");
});

await check("store/script mismatch is refused", async () => {
  await reset();
  const short = { ...makeScript(), scenes: [scene(0, "A")] } as unknown as Script;
  const r = await applyPageOp(dir, short, { op: "duplicate", page: 0 });
  assert(!r.ok && /mismatch/.test(r.error ?? ""), `mismatch guard: ${r.error}`);
});

await fs.rm(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
