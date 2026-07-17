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
import { injectLogoSrc, LOGO_SENTINEL } from "./logo-inject";
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
