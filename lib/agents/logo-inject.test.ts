/**
 * Regression tests for injectLogoSrc (QA: the multi-line-import build break).
 *
 * The choreography agent emits the brand logo reference as `LOGO_SRC`; the
 * pipeline injects the real const after the import block. The old anchor matched
 * only lines STARTING with `import`, so when the last import was MULTI-LINE the
 * const landed between `import {` and its members → "Expected 'as' but found
 * 'LOGO_SRC'", an intermittent 500 at the animation stage. These lock the fix by
 * compiling the injected output with esbuild (the same check the build gate uses).
 *
 * Run: `npm test`. No API key, no network.
 */
import { injectLogoSrc, LOGO_SENTINEL, resolveCornerBrandMark, brandWordmarkText } from "./logo-inject";
import * as esbuild from "esbuild";

const SRC = "https://corgi.insure/images/corgi%20logo%20vector.svg";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : err}`);
  }
};
const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg);
};
const compileErr = async (code: string): Promise<string | null> => {
  try {
    await esbuild.transform(code, { loader: "tsx" });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message.split("\n").slice(0, 2).join(" ") : String(e);
  }
};

// ── THE BUG: a multi-line import as the last import ───────────────────────────
await check("multi-line last import → injected const compiles, lands after close", async () => {
  const code = [
    'import React from "react";',
    "import {",
    "  AbsoluteFill,",
    "  useCurrentFrame,",
    '} from "remotion";',
    "",
    "export const Section0 = () => <AbsoluteFill><img src={LOGO_SRC} /></AbsoluteFill>;",
  ].join("\n");
  const out = injectLogoSrc(code, SRC);
  const err = await compileErr(out);
  assert(err === null, `expected compile, got: ${err}`);
  assert(
    out.indexOf("const LOGO_SRC =") > out.indexOf('} from "remotion"'),
    "const must land AFTER the multi-line import closes",
  );
});

// ── Single-line imports still work ────────────────────────────────────────────
await check("single-line imports → const after the last import, compiles", async () => {
  const code = [
    'import React from "react";',
    'import { AbsoluteFill } from "remotion";',
    "export const S = () => <AbsoluteFill src={LOGO_SRC} />;",
  ].join("\n");
  const out = injectLogoSrc(code, SRC);
  assert((await compileErr(out)) === null, "should compile");
  assert(
    out.indexOf("const LOGO_SRC =") > out.indexOf('from "remotion"'),
    "const after last import",
  );
});

// ── A side-effect import as the last import ────────────────────────────────────
await check("trailing side-effect import → const after it, compiles", async () => {
  const code = [
    'import { AbsoluteFill } from "remotion";',
    'import "./styles.css";',
    "export const S = () => <AbsoluteFill src={LOGO_SRC} />;",
  ].join("\n");
  const out = injectLogoSrc(code, SRC);
  assert((await compileErr(out)) === null, "should compile");
  assert(out.indexOf("const LOGO_SRC =") > out.indexOf('"./styles.css"'), "const after side-effect import");
});

// ── Strips the agent's own LOGO_SRC declarations; our value wins, exactly once ──
await check("strips agent-declared const + declare, injects ours once", async () => {
  const code = [
    'import { AbsoluteFill } from "remotion";',
    "declare const LOGO_SRC: string;",
    'const LOGO_SRC = "https://stale.example/old.png";',
    "export const S = () => <AbsoluteFill src={LOGO_SRC} />;",
  ].join("\n");
  const out = injectLogoSrc(code, SRC);
  const decls = out.match(/const LOGO_SRC\s*=/g) ?? [];
  assert(decls.length === 1, `expected exactly one const decl, got ${decls.length}`);
  assert(!out.includes("stale.example"), "stale agent value must be stripped");
  assert(out.includes(SRC), "our real URL must be injected");
  assert(!/declare\s+const\s+LOGO_SRC/.test(out), "declare stub must be stripped");
  assert((await compileErr(out)) === null, "should compile");
});

// ── Collapses the sentinel to the real URL ────────────────────────────────────
await check("LOGO_SENTINEL literal is replaced with the real URL", () => {
  const code = `import { Img } from "remotion";\nexport const S = () => <Img src={"${LOGO_SENTINEL}"} />;`;
  const out = injectLogoSrc(code, SRC);
  assert(!out.includes(LOGO_SENTINEL), "sentinel must be gone");
  assert(out.includes(SRC), "real URL present");
});

// ── No reference → untouched (no const added) ─────────────────────────────────
await check("code that never references LOGO_SRC is returned unchanged", () => {
  const code = 'import { AbsoluteFill } from "remotion";\nexport const S = () => <AbsoluteFill />;';
  const out = injectLogoSrc(code, SRC);
  assert(!out.includes("const LOGO_SRC"), "no const should be added");
});

// ── No imports at all → const goes to the top ─────────────────────────────────
await check("no imports + references LOGO_SRC → const at top, compiles", async () => {
  const code = "export const S = () => LOGO_SRC;";
  const out = injectLogoSrc(code, SRC);
  assert(out.startsWith("const LOGO_SRC ="), "const should be prepended");
  assert((await compileErr(out)) === null, "should compile");
});

// ── undefined logoSrc → const STILL defined (v13: the Patagonia no-logo class)
// The old no-op contract left `logoSrc={LOGO_SRC}` dangling on logo-less
// brands — a ReferenceError that killed every scene at render (the chrome
// mounts on all of them). Now: referenced → `const LOGO_SRC = undefined;`
// (BrandChrome's text-wordmark fallback engages); unreferenced → untouched.
await check("undefined logoSrc + referenced → const LOGO_SRC = undefined injected, compiles", async () => {
  const code = 'import { AbsoluteFill } from "remotion";\nexport const S = () => <AbsoluteFill>{LOGO_SRC}</AbsoluteFill>;';
  const out = injectLogoSrc(code, undefined);
  assert(out.includes("const LOGO_SRC = undefined;"), `const must be defined, got: ${out}`);
  assert((await compileErr(out)) === null, "should compile");
});

await check("undefined logoSrc + agent-authored stale const → stripped and re-defined as undefined", () => {
  const code = 'import { Img } from "./Img";\nconst LOGO_SRC = "https://stale.example/logo.png";\nexport const S = () => <Img src={LOGO_SRC} />;';
  const out = injectLogoSrc(code, undefined);
  assert(!out.includes("stale.example"), "hallucinated logo URL must be stripped on no-logo brands");
  assert(out.includes("const LOGO_SRC = undefined;"), "const re-defined as undefined");
});

await check("undefined logoSrc + sentinel → sentinel collapses to empty (falsy → wordmark fallback)", () => {
  const code = `import { Img } from "./Img";\nexport const S = () => <Img src={"${LOGO_SENTINEL}"} />;`;
  const out = injectLogoSrc(code, undefined);
  assert(!out.includes(LOGO_SENTINEL), "sentinel must be gone");
});

await check("undefined logoSrc + no reference → code returned unchanged", () => {
  const code = 'import { AbsoluteFill } from "remotion";\nexport const S = () => <AbsoluteFill />;';
  assert(injectLogoSrc(code, undefined) === code, "unreferenced no-logo code untouched");
});

// ── corner-mark resolution + wordmark fallback (the Klarna white-square fix) ──
await check("brandWordmarkText strips a crawl-title tagline", () => {
  assert(brandWordmarkText("Klarna US - A secure, flexible way to manage your money") === "Klarna US", "tagline stripped");
  assert(brandWordmarkText("Linear – Plan and build") === "Linear", "en-dash separator");
  assert(brandWordmarkText("Liquid Death") === "Liquid Death", "no separator → whole name");
  assert(brandWordmarkText("") === undefined, "empty → undefined");
});

await check("resolveCornerBrandMark: app-icon-only brand → wordmark, no image (Klarna appIcon)", () => {
  const r = resolveCornerBrandMark({ brandName: "Klarna US - manage your money" });
  assert(r.logoSrc === undefined && r.wordmark === "Klarna US", `app-icon brand → wordmark, got ${JSON.stringify(r)}`);
});

await check("resolveCornerBrandMark: a real logo_hd renders as the image, no wordmark", () => {
  const r = resolveCornerBrandMark({ logoHd: "https://x/logo.svg", brandName: "Acme" });
  assert(r.logoSrc === "https://x/logo.svg" && r.wordmark === undefined, `logo image, got ${JSON.stringify(r)}`);
});

await check("resolveCornerBrandMark: a user upload always wins", () => {
  const r = resolveCornerBrandMark({ userLogoUrl: "blob://up", logoHd: "https://x/logo.svg", brandName: "Acme" });
  assert(r.logoSrc === "blob://up" && r.wordmark === undefined, `user logo wins, got ${JSON.stringify(r)}`);
});

await check("injectLogoSrc injects BRAND_WORDMARK alongside LOGO_SRC (fallback const)", () => {
  const code = 'import { AbsoluteFill } from "remotion";\nexport const S = () => <AbsoluteFill logo={LOGO_SRC} name={BRAND_WORDMARK} />;';
  const out = injectLogoSrc(code, undefined, "Klarna");
  assert(/const LOGO_SRC = undefined;/.test(out), "LOGO_SRC undefined when no logo");
  assert(/const BRAND_WORDMARK = "Klarna";/.test(out), `BRAND_WORDMARK injected, got: ${out}`);
});

await check("injectLogoSrc: real logo → LOGO_SRC set, BRAND_WORDMARK undefined", async () => {
  const code = 'import { AbsoluteFill } from "remotion";\nexport const S = () => <AbsoluteFill logo={LOGO_SRC} name={BRAND_WORDMARK} />;';
  const out = injectLogoSrc(code, SRC, undefined);
  assert(out.includes(`const LOGO_SRC = ${JSON.stringify(SRC)};`), "LOGO_SRC set");
  assert(/const BRAND_WORDMARK = undefined;/.test(out), "BRAND_WORDMARK undefined for logo brands");
  assert((await compileErr(out)) === null, "injected output compiles");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
