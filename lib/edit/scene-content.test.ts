/**
 * Tests for the M1 scene-content edit model — the get/set/delete-by-path
 * primitives the click-to-edit editor builds on. Pure, no render needed.
 */
import {
  editableFields,
  getField,
  setField,
  deleteField,
  findPathByValue,
  type SceneContent,
} from "./scene-content";
import { applyTextEdit, applyTextEdits } from "./apply-text-edit";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

const full = (): SceneContent => ({
  eyebrow: "EVERY IDEA STARTS HERE",
  headline: "One design, every surface",
  lede: "Resize for any format in a tap.",
  bullets: ["Thousands of free elements", "Snap-to-grid precision", "Brand kit colors"],
  caption: "Magic Resize — one design to many formats",
  meta: [{ label: "FORMATS", value: "Many" }, { label: "RESIZE", value: "One tap" }],
  cta: { primary: "Start designing today", secondary: "See templates" },
});

console.log("scene-content (M1 edit model)");

check("editableFields: enumerates populated fields in reading order", () => {
  const f = editableFields(full());
  const paths = f.map((x) => x.path);
  assert(
    JSON.stringify(paths) ===
      JSON.stringify([
        "eyebrow", "headline", "lede",
        "bullets.0", "bullets.1", "bullets.2",
        "caption",
        "meta.0.label", "meta.0.value", "meta.1.label", "meta.1.value",
        "cta.primary", "cta.secondary",
      ]),
    `order wrong: ${JSON.stringify(paths)}`,
  );
  assert(f[1].label === "Headline" && f[1].value === "One design, every surface", "headline field shape");
});

check("editableFields: skips empty / whitespace / absent fields", () => {
  const f = editableFields({ headline: "Hi", lede: "   ", bullets: ["a", ""] });
  const paths = f.map((x) => x.path);
  assert(JSON.stringify(paths) === JSON.stringify(["headline", "bullets.0"]), `got ${JSON.stringify(paths)}`);
});

check("getField: resolves every path shape", () => {
  const c = full();
  assert(getField(c, "headline") === "One design, every surface", "headline");
  assert(getField(c, "bullets.1") === "Snap-to-grid precision", "bullet");
  assert(getField(c, "cta.primary") === "Start designing today", "cta");
  assert(getField(c, "meta.1.value") === "One tap", "meta value");
  assert(getField(c, "nope") === undefined, "unknown → undefined");
  assert(getField(c, "bullets.9") === undefined, "out-of-range → undefined");
});

check("setField: immutable, updates the targeted path only", () => {
  const c = full();
  const n = setField(c, "headline", "Design anything");
  assert(n.headline === "Design anything", "updated");
  assert(c.headline === "One design, every surface", "original untouched (immutable)");
  assert(n.lede === c.lede && n.bullets !== c.bullets, "other fields preserved, arrays cloned");
  assert(setField(c, "bullets.0", "X").bullets![0] === "X", "bullet set");
  assert(setField(c, "cta.primary", "Go").cta!.primary === "Go", "cta set");
  assert(setField(c, "meta.0.label", "F").meta![0].label === "F", "meta set");
});

check("setField: unknown path is a safe no-op clone", () => {
  const c = full();
  const n = setField(c, "bogus.path", "x");
  assert(JSON.stringify(n) === JSON.stringify(c) && n !== c, "no-op but new object");
});

check("deleteField: removes array items, clears singles, cleans empties", () => {
  const c = full();
  const noBullet = deleteField(c, "bullets.1");
  assert(JSON.stringify(noBullet.bullets) === JSON.stringify(["Thousands of free elements", "Brand kit colors"]), "bullet removed");
  assert(c.bullets!.length === 3, "original untouched");

  const noHead = deleteField(c, "headline");
  assert(noHead.headline === undefined, "single cleared");

  const noMeta = deleteField(c, "meta.0.value");
  assert(noMeta.meta!.length === 1 && noMeta.meta![0].label === "RESIZE", "whole meta pair removed");

  const oneBullet = deleteField({ bullets: ["only"] }, "bullets.0");
  assert(oneBullet.bullets === undefined, "emptied bullets array dropped");

  const ctaGone = deleteField({ cta: { primary: "Go" } }, "cta.primary");
  assert(ctaGone.cta === undefined, "emptied cta dropped");
});

// -- findPathByValue: the inline-edit resolver for videos with no data-content-path --

check("findPathByValue: exact match resolves the right path", () => {
  const c = full();
  assert(findPathByValue(c, "One design, every surface") === "headline", "headline");
  assert(findPathByValue(c, "Snap-to-grid precision") === "bullets.1", "bullet");
  assert(findPathByValue(c, "Start designing today") === "cta.primary", "cta");
  assert(findPathByValue(c, "One tap") === "meta.1.value", "meta value");
});

check("findPathByValue: trims and normalizes whitespace", () => {
  const c = full();
  assert(findPathByValue(c, "  One design, every surface  ") === "headline", "surrounding ws trimmed");
  // textContent of an accent-split headline collapses internal newlines/spaces
  assert(findPathByValue({ headline: "One design,\n  every surface" }, "One design, every surface") === "headline", "internal ws normalized");
});

check("findPathByValue: no match → null", () => {
  assert(findPathByValue(full(), "not in this scene") === null, "miss → null");
});

// -- applyTextEdit: resolve (path | matchText) then edit/delete --

check("applyTextEdit: explicit path wins", () => {
  const r = applyTextEdit(full(), { path: "headline", op: "edit", value: "New head" });
  assert(r.ok && r.path === "headline" && r.content!.headline === "New head", "edited by path");
});

check("applyTextEdit: falls back to matchText when path absent", () => {
  const r = applyTextEdit(full(), { matchText: "Start designing today", op: "edit", value: "Go now" });
  assert(r.ok && r.path === "cta.primary" && r.content!.cta!.primary === "Go now", "resolved via matchText");
});

check("applyTextEdit: falls back to matchText when path is stale/unknown", () => {
  const r = applyTextEdit(full(), { path: "bogus.path", matchText: "One design, every surface", op: "edit", value: "X" });
  assert(r.ok && r.path === "headline" && r.content!.headline === "X", "stale path → matchText");
});

check("applyTextEdit: delete op removes the resolved field", () => {
  const r = applyTextEdit(full(), { matchText: "Snap-to-grid precision", op: "delete" });
  assert(r.ok && r.path === "bullets.1", "resolved delete path");
  assert(JSON.stringify(r.content!.bullets) === JSON.stringify(["Thousands of free elements", "Brand kit colors"]), "bullet removed");
});

check("applyTextEdit: unresolvable → ok:false, no throw", () => {
  const r = applyTextEdit(full(), { matchText: "ghost text", op: "edit", value: "x" });
  assert(!r.ok && !!r.error, "miss returns error, not throw");
});

check("applyTextEdit: edit without a string value → ok:false", () => {
  const r = applyTextEdit(full(), { path: "headline", op: "edit" });
  assert(!r.ok && r.error === "value required for edit", "guards missing value");
});

// -- applyTextEdits: the batch shape (editor's multi-field save) --

check("applyTextEdits: applies multiple edits in one pass against evolving content", () => {
  const { content, results, okCount } = applyTextEdits(full(), [
    { path: "headline", op: "edit", value: "New head" },
    { matchText: "Start designing today", op: "edit", value: "Go now" },
    { matchText: "Snap-to-grid precision", op: "delete" },
  ]);
  assert(okCount === 3 && results.every((r) => r.ok), JSON.stringify(results));
  assert(content.headline === "New head", "headline updated");
  assert(content.cta!.primary === "Go now", "cta updated via matchText");
  assert(content.bullets!.length === 2, "bullet deleted");
});

check("applyTextEdits: partial failure reports per-edit results, applies the rest", () => {
  const { content, results, okCount } = applyTextEdits(full(), [
    { matchText: "ghost text that matches nothing", op: "edit", value: "x" },
    { path: "headline", op: "edit", value: "Kept" },
  ]);
  assert(okCount === 1, `okCount ${okCount}`);
  assert(!results[0].ok && !!results[0].error, "first edit failed with error");
  assert(results[1].ok && content.headline === "Kept", "second edit applied");
});

check("applyTextEdits: all-fail → okCount 0, content unchanged", () => {
  const before = full();
  const { content, okCount } = applyTextEdits(before, [{ matchText: "nope", op: "edit", value: "x" }]);
  assert(okCount === 0 && JSON.stringify(content) === JSON.stringify(before), "unchanged");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
