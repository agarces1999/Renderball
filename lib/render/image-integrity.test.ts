/**
 * Tests for the image-integrity pass — the "no broken image ever ships"
 * guarantee. Pure: the reachability probe is injected, so no network.
 * Locks the ElevenLabs regression: brand-CDN SVGs (flag icons, partner logos)
 * and extension-less src URLs were invisible to the raster-extension regex and
 * shipped as 404s in both the preview and the MP4.
 */
import { repairBrokenImages } from "./image-integrity";

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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
