/**
 * BrandChrome wide-lockup suppression — the "tailscale tailscale" bug.
 *
 * Run: `npm test` or `node scripts/run-tests.mjs lib/render/brand-chrome.test.ts`
 * (from the repo root). No API key, no network.
 *
 * Tailscale's logo.svg is a full LOCKUP (viewBox 0 0 121 22: dot-grid mark +
 * "tailscale" as vector paths), and the design agent passes BOTH logoSrc and
 * wordmark — BrandChrome rendered them side by side, doubling the brand name
 * in every frame. The fix measures the loaded image's natural aspect ratio
 * and suppresses the wordmark span when the asset already contains the name.
 *
 * The test runner has no DOM, so an actual image-load → suppression pass is
 * impractical here. Instead this compiles the SHIPPED template string from a
 * genDir the way the preview/render paths do (esbuild → eval → SSR, the
 * render-gate.test.ts pattern) and checks: (1) the ratio decision itself,
 * (2) the compiled template exports the SAME decision (string/helper sync),
 * (3) the pre-load SSR default still renders the wordmark — measurement can
 * only suppress — with the data hooks both suppression paths (React onLoad,
 * static-preview injected script) target.
 */
import { existsSync } from "fs";
import { promises as fs } from "fs";
import { createRequire } from "module";
import os from "os";
import path from "path";
import React from "react";
import * as esbuild from "esbuild";
import {
  BRAND_CHROME_SOURCE,
  IMG_SHIM_SOURCE,
  WIDE_LOCKUP_RATIO,
  isWideLockup,
} from "./build-wrapper";

const nodeRequire = createRequire(path.join(process.cwd(), "package.json"));
const { renderToStaticMarkup } = nodeRequire("react-dom/server") as {
  renderToStaticMarkup: (node: React.ReactNode) => string;
};

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
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

// Tailscale-shaped wide lockup as a data URI — never fetched in SSR, but the
// realistic shape documents what the suppression is for.
const LOCKUP_SRC =
  'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 121 22"><rect width="121" height="22"/></svg>';

// (naturalWidth, naturalHeight, lockup?) — the boundary cases the ratio must
// hold: real lockups suppress, square favicons and 2:1 marks keep the span,
// an unmeasurable image (height 0) keeps today's behavior.
const RATIO_CASES: [number, number, boolean][] = [
  [121, 22, true], // Tailscale's logo.svg
  [22, 22, false], // square mark
  [48, 24, false], // 2:1 mark + breathing room
  [26, 10, true], // just past the threshold
  [25, 10, false], // exactly the threshold — not proven wider
  [100, 0, false], // unmeasurable
];

check("isWideLockup: lockups suppress, marks and squares don't", () => {
  for (const [w, h, expected] of RATIO_CASES) {
    assert(
      isWideLockup(w, h) === expected,
      `isWideLockup(${w}, ${h}) should be ${expected}`,
    );
  }
});

// ── Compile the SHIPPED string the way the preview/render paths do ──────────
const genDir = await fs.mkdtemp(path.join(os.tmpdir(), "rb-brand-chrome-"));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let BrandChrome: React.ComponentType<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let compiled: Record<string, any>;
try {
  await fs.writeFile(path.join(genDir, "BrandChrome.tsx"), BRAND_CHROME_SOURCE, "utf-8");
  await fs.writeFile(path.join(genDir, "Img.tsx"), IMG_SHIM_SOURCE, "utf-8");
  assert(existsSync(path.join(genDir, "BrandChrome.tsx")), "genDir write failed");

  const result = await esbuild.build({
    entryPoints: [path.join(genDir, "BrandChrome.tsx")],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node18",
    jsx: "automatic",
    write: false,
    external: ["react"],
    logLevel: "silent",
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const moduleObj: { exports: Record<string, any> } = { exports: {} };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function("module", "exports", "require", result.outputFiles[0].text);
  fn(moduleObj, moduleObj.exports, nodeRequire);
  compiled = moduleObj.exports;
  BrandChrome = compiled.BrandChrome;

  check("the shipped template exports the same lockup decision", () => {
    assert(
      BRAND_CHROME_SOURCE.includes(`> ${WIDE_LOCKUP_RATIO}`),
      "WIDE_LOCKUP_RATIO not interpolated into the template",
    );
    assert(typeof compiled.isWideLockup === "function", "isWideLockup not exported");
    for (const [w, h] of RATIO_CASES) {
      assert(
        compiled.isWideLockup(w, h) === isWideLockup(w, h),
        `template disagrees with build-wrapper at (${w}, ${h})`,
      );
    }
  });

  const baseProps = {
    sceneIndex: 0,
    totalScenes: 3,
    logoSrc: LOCKUP_SRC,
    wordmark: "tailscale",
    ink: "#F8FAFC",
    accent: "#4458EE",
    fontDisplay: "Inter",
    fontBody: "Inter",
  };

  check("pre-load SSR default: wordmark still renders (suppress-only)", () => {
    const html = renderToStaticMarkup(React.createElement(BrandChrome, baseProps));
    assert(html.includes(">tailscale<"), "wordmark span missing before measurement");
    assert(html.includes("data-rb-brand-logo"), "logo measurement hook missing");
    assert(html.includes("data-rb-brand-wordmark"), "wordmark suppression hook missing");
  });

  check("all three variants carry the suppression hooks", () => {
    for (const variant of ["corner", "footer", "strip"] as const) {
      const html = renderToStaticMarkup(
        React.createElement(BrandChrome, { ...baseProps, variant }),
      );
      assert(
        html.includes("data-rb-brand-logo") && html.includes("data-rb-brand-wordmark"),
        `${variant} variant lost a suppression hook`,
      );
    }
  });

  check("no-logo brands keep the wordmark as the mark", () => {
    const html = renderToStaticMarkup(
      React.createElement(BrandChrome, { ...baseProps, logoSrc: undefined }),
    );
    assert(html.includes(">tailscale<"), "wordmark-as-mark missing");
    assert(!html.includes("data-rb-brand-logo"), "logo hook rendered with no logo");
  });

  check("the template wires load-time measurement to the suppression state", () => {
    // No DOM under this runner — assert the wiring the render path executes:
    // onLoad measures naturalWidth/naturalHeight and flips logoIsLockup.
    for (const needle of ["onLoad", "naturalWidth", "naturalHeight", "logoIsLockup"]) {
      assert(BRAND_CHROME_SOURCE.includes(needle), `template missing ${needle}`);
    }
    assert(
      BRAND_CHROME_SOURCE.includes("wordmark && !logoIsLockup"),
      "wordmark render not gated on the lockup state",
    );
  });
} finally {
  await fs.rm(genDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
