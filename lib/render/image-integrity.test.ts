/**
 * Tests for the image-integrity pass — the "no broken image ever ships"
 * guarantee. Pure: the reachability probe is injected, so no network.
 * Locks the ElevenLabs regression: brand-CDN SVGs (flag icons, partner logos)
 * and extension-less src URLs were invisible to the raster-extension regex and
 * shipped as 404s in both the preview and the MP4.
 */
import {
  repairBrokenImages,
  findBrokenRenderedImages,
  swapBrokenImagesForWordmark,
} from "./image-integrity";
import type { SceneMeasurement, MeasuredElement } from "./measure-scene";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

const TRANSPARENT = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
/** Probe stub: URLs containing "dead" are unreachable, everything else is live. */
const probe = (u: string) => Promise.resolve(!u.includes("dead"));

console.log("image-integrity");

await check("live raster + live svg → untouched", async () => {
  const code = `<Img src="https://cdn.x.com/photo.jpg" /><Img src="https://cdn.x.com/logo.svg" />`;
  const r = await repairBrokenImages(code, [], probe);
  assert(r.code === code && r.replaced.length === 0 && r.neutralized.length === 0, JSON.stringify(r));
});

await check("dead raster is pool-replaced with a validated photo", async () => {
  const code = `<Img src="https://cdn.x.com/dead-photo.jpg" />`;
  const r = await repairBrokenImages(code, ["https://pool.com/alt.jpg"], probe);
  assert(r.code.includes("https://pool.com/alt.jpg"), "should swap in the pool photo");
  assert(r.replaced.length === 1 && r.neutralized.length === 0, JSON.stringify(r));
});

await check("dead SVG in src position is caught + NEUTRALIZED (never pool-replaced)", async () => {
  // the ElevenLabs flags case: circle-flags/*.svg 404ing
  const code = `<Img src="https://eleven-cdn.io/flags/dead-fr.svg" alt="fr" />`;
  const r = await repairBrokenImages(code, ["https://pool.com/alt.jpg"], probe);
  assert(r.code.includes(TRANSPARENT), "dead svg → transparent pixel");
  assert(!r.code.includes("alt.jpg"), "an icon slot must NOT get a random photo");
  assert(r.neutralized.length === 1, JSON.stringify(r.neutralized));
});

await check("dead extension-less src URL is caught + neutralized", async () => {
  // the ElevenLabs _next/static chunk path case
  const code = `<Img src={"https://cdn.x.com/dead/_next/static/chunks/app/_ui/"} />`;
  const r = await repairBrokenImages(code, [], probe);
  assert(r.code.includes(TRANSPARENT), "dead extension-less src → transparent pixel");
});

await check("xmlns / font URLs (not in src=, no raster ext) are never touched", async () => {
  const code = `<svg xmlns="http://www.w3.org/2000/svg"/> @font-face { src: url("https://fonts.gstatic.com/dead-font.woff2"); }`;
  const r = await repairBrokenImages(code, [], probe);
  // font url is inside CSS src: url(...) — not the JSX src="..." attribute form with quotes right after src=
  assert(r.code === code, `must not touch non-image URLs: ${JSON.stringify(r)}`);
});

await check("pool exhaustion on a dead raster falls back to transparent pixel", async () => {
  const code = `<Img src="https://cdn.x.com/dead1.png" /><Img src="https://cdn.x.com/dead2.png" />`;
  const r = await repairBrokenImages(code, ["https://pool.com/dead-pool.jpg", "https://pool.com/ok.jpg"], probe);
  assert(r.replaced.length === 1 && r.replaced[0].to === "https://pool.com/ok.jpg", "one valid pool url used");
  assert(r.neutralized.length === 1 && r.code.includes(TRANSPARENT), "second dead raster neutralized");
});

// ── v12: measured broken-image detection (mocked page walk) + wordmark swap ──

const mel = (p: Partial<MeasuredElement>): MeasuredElement => ({
  tag: "img", x: 10, y: 10, w: 120, h: 40, color: "rgb(0,0,0)", bg: "rgba(0,0,0,0)",
  text: "", isImg: true, src: "https://cdn.x.com/logo.svg", imgNaturalWidth: 0,
  fontSize: 0, opacity: 1, piece: "s1.hero", onOpaqueSurface: false, coveredAtCenter: false, ...p,
});
const mscene = (i: number, els: MeasuredElement[]): SceneMeasurement => ({
  scene: i, width: 1920, height: 1080, elements: els,
});

await check("findBrokenRenderedImages: naturalWidth===0 flags; decoded/unmeasured/invisible do not", () => {
  const ms = [
    mscene(1, [
      mel({ src: "data:image/svg+xml;base64,CORRUPT", imgNaturalWidth: 0 }), // broken → flags
      mel({ src: "https://cdn.x.com/fine.png", imgNaturalWidth: 400 }), // decoded → no
      mel({ src: "https://cdn.x.com/old-fixture.png", imgNaturalWidth: undefined }), // unmeasured → no
      mel({ src: "https://cdn.x.com/hidden.png", imgNaturalWidth: 0, opacity: 0 }), // invisible → no
      mel({ tag: "div", isImg: false, src: undefined, imgNaturalWidth: undefined }), // not an img
    ]),
  ];
  const r = findBrokenRenderedImages(ms);
  assert(r.length === 1, `expected exactly the corrupt data URI, got ${JSON.stringify(r)}`);
  assert(r[0].src === "data:image/svg+xml;base64,CORRUPT" && r[0].pieceId === "s1.hero" && r[0].scene === 1, JSON.stringify(r[0]));
});

await check("findBrokenRenderedImages: dedupes repeated mounts of the same src per scene", () => {
  const ms = [mscene(2, [mel({ imgNaturalWidth: 0 }), mel({ imgNaturalWidth: 0, x: 500 })])];
  assert(findBrokenRenderedImages(ms).length === 1, "same src twice in one scene = one entry");
});

await check("swap: literal-src tag becomes the brand wordmark, keeping its style + size", () => {
  const code = `<div><Img src="https://cdn.x.com/broken.svg" style={{ width: 140, height: 36, opacity: 0.9 }} /></div>`;
  const r = swapBrokenImagesForWordmark(code, ["https://cdn.x.com/broken.svg"], "Oatly");
  assert(r.swapped.length === 1 && r.swapped[0].via === "tag-swap", JSON.stringify(r.swapped));
  assert(!r.code.includes("<Img"), "the broken mount is gone");
  assert(r.code.includes(`{"Oatly"}`), "brand name renders as the wordmark");
  assert(r.code.includes("FONT_DISPLAY"), "wordmark uses the display face");
  assert(r.code.includes("width: 140, height: 36, opacity: 0.9"), `original style carried: ${r.code}`);
});

await check("swap: width/height ATTRS carry into the wordmark style + scale its font", () => {
  const code = `<img src="https://cdn.x.com/broken.svg" width={200} height={48} />`;
  const r = swapBrokenImagesForWordmark(code, ["https://cdn.x.com/broken.svg"], "Oatly");
  assert(r.swapped.length === 1, "swapped");
  assert(r.code.includes("width: 200") && r.code.includes("height: 48"), `sizing carried: ${r.code}`);
  assert(r.code.includes("fontSize: 26"), `font scales to ~0.55×height: ${r.code}`);
});

await check("swap: ident-bound src resolves through the injected const (the cycle-3 logo class)", () => {
  const code = [
    `const LOGO_SRC = "data:image/svg+xml;base64,CORRUPT";`,
    `<Img src={LOGO_SRC} style={{ height: 22 }} />`,
  ].join("\n");
  const r = swapBrokenImagesForWordmark(code, ["data:image/svg+xml;base64,CORRUPT"], "Linear");
  assert(r.swapped.some((s) => s.via === "tag-swap"), `ident src resolved + swapped: ${JSON.stringify(r.swapped)}`);
  assert(r.code.includes(`{"Linear"}`), "wordmark carries the brand name");
});

await check("swap: chrome logoSrc BINDING rewrites to the wordmark fallback", () => {
  const code = [
    `const LOGO_SRC = "data:image/svg+xml;base64,CORRUPT";`,
    `<BrandChrome variant="corner" logoSrc={LOGO_SRC} ink={INK} />`,
  ].join("\n");
  const r = swapBrokenImagesForWordmark(code, ["data:image/svg+xml;base64,CORRUPT"], "Linear");
  assert(r.swapped.some((s) => s.via === "chrome-wordmark"), JSON.stringify(r.swapped));
  assert(r.code.includes(`logoSrc={undefined} wordmark={"Linear"}`), `chrome binding rewritten: ${r.code}`);
});

await check("swap: a piece-body fragment resolves idents via constSource", () => {
  const body = `<div><Img src={LOGO_SRC} /></div>`;
  const constSource = `const LOGO_SRC = "data:image/svg+xml;base64,CORRUPT";`;
  const r = swapBrokenImagesForWordmark(body, ["data:image/svg+xml;base64,CORRUPT"], "Oatly", { constSource });
  assert(r.swapped.length === 1 && r.code.includes(`{"Oatly"}`), `fragment swap via constSource: ${r.code}`);
});

await check("swap: healthy srcs and unrelated tags are untouched", () => {
  const code = `<Img src="https://cdn.x.com/fine.png" /><img src="https://cdn.x.com/also-fine.jpg" style={{ width: 40 }} />`;
  const r = swapBrokenImagesForWordmark(code, ["https://cdn.x.com/broken.svg"], "Oatly");
  assert(r.code === code && r.swapped.length === 0, "nothing to swap");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
