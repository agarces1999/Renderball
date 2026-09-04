/** The persistent per-brand deck system: keyed by host, fingerprinted on the
 *  brand facts, a miss is a miss. Zero model spend. */
import { promises as fsp } from "fs";
import path from "path";
import { brandSystemKey, brandFingerprint, loadBrandSystem, saveBrandSystem } from "./brand-system";
import { assemblePack, type PackInput } from "./pack";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("brand-system");

const brand: PackInput["brand"] = { brandName: "Stripe", palette: ["#635BFF"], logoSrc: null, mode: "light", background: "#fff", fonts: { display: { stack: "Inter, sans-serif" } } };

await check("key is the site host, case- and www-insensitive; name is the fallback", () => {
  assert(brandSystemKey("https://www.Stripe.com/", "Stripe") === brandSystemKey("https://stripe.com/pricing", "x"), "host-keyed");
  assert(brandSystemKey(undefined, "Stripe") === brandSystemKey(null, "stripe "), "name fallback normalized");
  assert(brandSystemKey("https://stripe.com", "Stripe") !== brandSystemKey("https://deel.com", "Deel"), "different brands differ");
});

await check("fingerprint tracks the brand facts the author saw", () => {
  const a = brandFingerprint(brand);
  assert(a === brandFingerprint({ ...brand }), "stable");
  assert(a !== brandFingerprint({ ...brand, palette: ["#000000"] }), "palette change → new fingerprint");
  assert(a !== brandFingerprint({ ...brand, designCard: "Mood: x" }), "design card change → new fingerprint");
});

await check("save → load roundtrip; a changed fingerprint is a miss", async () => {
  const key = `test-${Date.now()}`;
  const preamble = 'import React from "react";\n' + "const X = 1;\n".repeat(40);
  await saveBrandSystem({ key, fingerprint: "fp1", preamble, scriptId: "s1" });
  const hit = await loadBrandSystem(key, "fp1");
  assert(!!hit && hit.preamble === preamble && hit.uses === 0, "hit with the same fingerprint");
  assert((await loadBrandSystem(key, "fp2")) === null, "miss on a different fingerprint");
  await fsp.rm(path.join(process.cwd(), ".data", "brand-systems", `${key}.json`), { force: true });
});

await check("the plan pass asks for plans only, against the stored system", () => {
  const pack = assemblePack({ briefPrompt: "b", tone: undefined, aspect: "16:9", scenes: [{ label: "Open", description: "d", content: "{}" }], brand, assetUrls: [], parallel: { pass: "plan", preamble: 'import React from "react";\nconst Chrome = 1;' } });
  assert(/DECK SYSTEM/.test(pack) && /PLAN PASS OUTPUT/.test(pack) && /Emit NO code/.test(pack), "plan contract");
  assert(pack.includes("const Chrome = 1;"), "stored preamble in view");
  assert(/ONLY the page plans in one ```text block/.test(pack), "output shape");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
