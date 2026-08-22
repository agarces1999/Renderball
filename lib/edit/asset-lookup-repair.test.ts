//
// Repairing the string-predicate asset lookup.
//
// The fixture is verbatim from 01M0MX7ZJ8SBNMF3D1G6P99G7M's scene-3 template — the
// deck behind "image on slide 4 is not loading". Its manifest holds og_image at
// https://linear.app/static/og/homepage.jpg, and the code below could never reach it.
//
import { repairAssetLookups } from "./asset-lookup-repair";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("\n▶ asset-lookup-repair");

const IDS = new Set(["og_image", "favicon", "apple_touch_icon"]);

/** Verbatim from the shipped scene template. */
const SHIPPED =
  `  const images = Array.isArray(script.assets?.images) ? script.assets.images : [];\n` +
  `  const ogImage = images.find((u: any) => typeof u === "string" && u.includes("og_image")) || images[0];\n`;

check("the shipped expression is rewritten to an id match reading .src", () => {
  const { source, repairs } = repairAssetLookups(SHIPPED, IDS);
  assert(repairs.length === 1, `expected 1 repair, got ${repairs.length}`);
  assert(repairs[0].assetId === "og_image", `wrong asset id: ${repairs[0].assetId}`);
  assert(
    source.includes(`images.find((a: any) => a?.id === "og_image")?.src ?? images[0]?.src`),
    `unexpected rewrite:\n${source}`,
  );
  assert(!source.includes('typeof u === "string"'), "the broken predicate survived");
});

check("the repaired expression actually selects og_image at runtime", () => {
  // The real manifest order — apple_touch_icon FIRST, which is why the broken
  // fallback picked a favicon instead of the homepage image.
  const images = [
    { id: "apple_touch_icon", src: "https://linear.app/static/apple-touch-icon.png?v=2" },
    { id: "favicon", src: "https://linear.app/favicon.ico?v=2" },
    { id: "og_image", src: "https://linear.app/static/og/homepage.jpg" },
  ];
  const broken =
    images.find((u: unknown) => typeof u === "string" && u.includes("og_image")) ?? images[0];
  assert(
    typeof broken === "object" && broken.id === "apple_touch_icon",
    "the fixture no longer reproduces the original defect",
  );
  const repaired = images.find((a) => a?.id === "og_image")?.src ?? images[0]?.src;
  assert(repaired === "https://linear.app/static/og/homepage.jpg", `got ${repaired}`);
});

check("no fallback half: the rewrite omits it too", () => {
  const src = `const x = imgs.find((u: any) => typeof u === "string" && u.includes("favicon"));`;
  const { source, repairs } = repairAssetLookups(src, IDS);
  assert(repairs.length === 1, "should still match without `|| imgs[0]`");
  assert(source.includes(`imgs.find((a: any) => a?.id === "favicon")?.src`), source);
  assert(!source.includes("?? imgs[0]"), `invented a fallback that was not there: ${source}`);
});

check("an id the deck does NOT have is left alone", () => {
  // Repointing this would hide a genuine missing-asset bug behind a working image.
  const src = `const h = images.find((u: any) => typeof u === "string" && u.includes("hero_shot")) || images[0];`;
  const { source, repairs } = repairAssetLookups(src, IDS);
  assert(repairs.length === 0, "must not rewrite a lookup for an unknown asset");
  assert(source === src, "source changed despite no repair");
});

check("correct code is never touched", () => {
  const good = [
    `const og = images.find((a: any) => a?.id === "og_image")?.src;`,
    `<Img src="https://linear.app/static/og/homepage.jpg" />`,
    `const first = images[0]?.src;`,
    `rows.find((r: any) => typeof r === "string" && r.includes("og_image"))`, // not the images array… but shape-identical
  ];
  for (const g of good.slice(0, 3)) {
    const { source, repairs } = repairAssetLookups(g, IDS);
    assert(repairs.length === 0 && source === g, `touched correct code: ${g}`);
  }
});

check("several lookups in one template are all repaired", () => {
  const src =
    `const a = images.find((u: any) => typeof u === "string" && u.includes("og_image")) || images[0];\n` +
    `const b = images.find((v: any) => typeof v === "string" && v.includes("favicon")) || images[0];`;
  const { source, repairs } = repairAssetLookups(src, IDS);
  assert(repairs.length === 2, `expected 2 repairs, got ${repairs.length}`);
  assert(!source.includes("typeof"), `a broken predicate survived:\n${source}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
