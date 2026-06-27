/**
 * Tests for the M1 scene-content edit model — the get/set/delete-by-path
 * primitives the click-to-edit editor builds on. Pure, no render needed.
 */
import {
  editableFields,
  getField,
  setField,
  deleteField,
  type SceneContent,
} from "./scene-content";

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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
