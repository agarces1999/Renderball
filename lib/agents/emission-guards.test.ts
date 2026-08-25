import { collectLiteralImageSrcs, findForeignImageSrcs, sceneImageAllowlist, bodyPaintsInk } from "./emission-guards";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("emission guards (founder lever #2)");

check("collects literal http srcs; ignores expressions and data URIs", () => {
  const body = `<Img src="https://a.com/x.png" /><Img src={"https://b.com/y.jpg"} /><Img src={img.src} /><img src="data:image/png;base64,AA" />`;
  const got = collectLiteralImageSrcs(body);
  assert(got.length === 2 && got.includes("https://a.com/x.png") && got.includes("https://b.com/y.jpg"), JSON.stringify(got));
});

check("THE INCIDENT: an off-brief favicon is foreign; brief-provided srcs are not", () => {
  const scene = { content: { hero_image: { src: "https://cdn.renderball.com/img/hero.webp" } } };
  const allowed = sceneImageAllowlist(scene);
  const bad = `<Img src="https://northwind.coffee/favicon.ico" /><Img src="https://cdn.renderball.com/img/hero.webp" />`;
  const foreign = findForeignImageSrcs(bad, allowed);
  assert(foreign.length === 1 && foreign[0].includes("favicon"), JSON.stringify(foreign));
});

check("hollow decoration detected; painted ones pass", () => {
  assert(!bodyPaintsInk(`<div style={{ position: "relative", width: "100%", height: "100%" }}><div /></div>`), "hollow must be false");
  assert(bodyPaintsInk(`<svg><rect width="10" height="4" fill="#fff" /></svg>`), "svg shape paints");
  assert(bodyPaintsInk(`<div style={{ background: "linear-gradient(90deg, #000, #111)" }} />`), "gradient paints");
  assert(bodyPaintsInk(`<div style={{ borderTop: "1px solid #fff" }} />`), "border paints");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
