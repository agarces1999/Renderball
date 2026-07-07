/**
 * Tests for the brand-kit gate predicate (approved DESIGN.md deviation,
 * 2026-07-07): logo required (upload or confirmed crawl), scanned colors
 * must be confirmed, uploaded fonts need a license attestation.
 */
import { brandKitStatus } from "./brand-kit";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("brand-kit");

const crawl = { ok: true, logo_hd: "https://x/logo.svg", palette: ["#fff", "#57cc02"] };

check("uploaded logo + confirmed colors → ready", () => {
  const s = brandKitStatus({
    brand_files: [{ is_logo: true }],
    colors_confirmed: true,
    brand_extract: crawl,
  });
  assert(s.ready && s.missing.length === 0, JSON.stringify(s));
});

check("confirmed crawled logo counts as locked", () => {
  const s = brandKitStatus({
    logo_source: "crawl_confirmed",
    colors_confirmed: true,
    brand_extract: crawl,
  });
  assert(s.ready, JSON.stringify(s));
});

check("no logo at all → blocked with a logo reason", () => {
  const s = brandKitStatus({ colors_confirmed: true, brand_extract: crawl });
  assert(!s.ready && s.missing.some((m) => /logo/.test(m)), JSON.stringify(s));
});

check("crawl_confirmed without an actual crawled logo does NOT satisfy", () => {
  const s = brandKitStatus({
    logo_source: "crawl_confirmed",
    colors_confirmed: true,
    brand_extract: { ok: true, palette: ["#fff"] }, // no logo_hd
  });
  assert(!s.ready && s.missing.some((m) => /logo/.test(m)), JSON.stringify(s));
});

check("scanned palette without confirmation → blocked with a colors reason", () => {
  const s = brandKitStatus({ brand_files: [{ is_logo: true }], brand_extract: crawl });
  assert(!s.ready && s.missing.some((m) => /colors/.test(m)), JSON.stringify(s));
});

check("no crawl → colors have nothing to confirm; uploaded logo alone is ready", () => {
  const s = brandKitStatus({ brand_files: [{ is_logo: true }] });
  assert(s.ready, JSON.stringify(s));
});

check("uploaded font without license attestation → blocked", () => {
  const s = brandKitStatus({
    brand_files: [{ is_logo: true }, { is_font: true }],
    colors_confirmed: true,
    brand_extract: crawl,
  });
  assert(!s.ready && s.missing.some((m) => /license/.test(m)), JSON.stringify(s));
});

check("licensed font passes", () => {
  const s = brandKitStatus({
    brand_files: [{ is_logo: true }, { is_font: true, font_licensed: true }],
    colors_confirmed: true,
    brand_extract: crawl,
  });
  assert(s.ready, JSON.stringify(s));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
