/**
 * The <Img> shim resolves an asset OBJECT to its URL.
 *
 * Run: `npm test` or `node scripts/run-tests.mjs lib/render/img-shim.test.ts`.
 * No API key, no network.
 *
 * THE BUG (founder report, 2026-08-22: "image on slide 4 is not loading").
 * `script.assets.images` is an array of objects — `{ id, src, width, height }`. A
 * shipped Linear deck reached into it with
 *
 *   images.find((u) => typeof u === "string" && u.includes("og_image")) || images[0]
 *
 * The string predicate cannot match an object array, so it fell through to
 * `images[0]` and passed the entire object to `<Img src>`. React stringifies that to
 * "[object Object]", the browser requests a URL that cannot exist, and slide 4 showed
 * an 800x130 framed box — border, drop shadow, "Linear · in sync" badge — with
 * nothing in it. The correct URL (https://linear.app/static/og/homepage.jpg) sat in
 * the manifest the whole time.
 *
 * Two fixes: the prompt now states the element shape (lib/agents/pipeline.ts), and
 * the shim coerces, so no upstream shape mistake can reach the DOM as a broken image.
 * This tests the second — the one that also repairs the 184 decks already on disk.
 *
 * Compiles the SHIPPED template string exactly as the preview/render paths do
 * (esbuild → eval → SSR), following the brand-chrome.test.ts pattern, so the thing
 * under test is the string we actually write into every deck.
 */
import { promises as fs } from "fs";
import { createRequire } from "module";
import os from "os";
import path from "path";
import React from "react";
import * as esbuild from "esbuild";
import { IMG_SHIM_SOURCE } from "./build-wrapper";

const nodeRequire = createRequire(path.join(process.cwd(), "package.json"));
const { renderToStaticMarkup } = nodeRequire("react-dom/server") as {
  renderToStaticMarkup: (node: React.ReactNode) => string;
};

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : err}`); }
};
const assert = (cond: boolean, msg: string) => { if (!cond) throw new Error(msg); };

console.log("\n▶ img-shim");

/** Verbatim from 01M0MX7ZJ8SBNMF3D1G6P99G7M/script.json. */
const OG_URL = "https://linear.app/static/og/homepage.jpg";
const ASSET_OBJECT = {
  id: "og_image",
  src: OG_URL,
  width: 1200,
  height: 630,
  format: "jpg",
  alt_text: "Linear",
  license_id: "linear_kit",
};

const genDir = await fs.mkdtemp(path.join(os.tmpdir(), "rb-img-shim-"));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let Img: React.ComponentType<any>;
try {
  await fs.writeFile(path.join(genDir, "Img.tsx"), IMG_SHIM_SOURCE, "utf-8");
  const result = await esbuild.build({
    entryPoints: [path.join(genDir, "Img.tsx")],
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
  Img = moduleObj.exports.Img;

  check("the shipped template compiles and exports Img", () => {
    assert(typeof Img === "function", "Img not exported from the compiled shim");
  });

  check("THE BUG: an asset object resolves to its URL, not [object Object]", () => {
    const html = renderToStaticMarkup(React.createElement(Img, { src: ASSET_OBJECT }));
    assert(!html.includes("[object Object]"), `object leaked into src: ${html}`);
    assert(html.includes(OG_URL), `expected the og_image URL, got: ${html}`);
  });

  check("the exact expression the Linear deck used now renders correctly", () => {
    // images.find(string predicate) || images[0] — the predicate never matches, so
    // this is images[0], an object. Before the fix that was a broken image.
    const images = [ASSET_OBJECT, { id: "favicon", src: "https://linear.app/favicon.ico" }];
    const ogImage =
      images.find((u: unknown) => typeof u === "string" && u.includes("og_image")) ?? images[0];
    const html = renderToStaticMarkup(React.createElement(Img, { src: ogImage }));
    assert(html.includes(OG_URL), `expected a real URL, got: ${html}`);
  });

  check("a plain URL string still works exactly as before", () => {
    const html = renderToStaticMarkup(React.createElement(Img, { src: OG_URL }));
    assert(html.includes(OG_URL), `plain string regressed: ${html}`);
  });

  check("style and other img attributes pass through untouched", () => {
    const html = renderToStaticMarkup(
      React.createElement(Img, { src: OG_URL, alt: "Linear", style: { width: 72, height: 72 } }),
    );
    assert(html.includes('alt="Linear"'), `alt dropped: ${html}`);
    assert(/width:\s*72px/.test(html), `style dropped: ${html}`);
  });

  check("an unusable src renders NOTHING rather than a broken image", () => {
    for (const bad of [undefined, null, "", {}, { src: 42 }, 7]) {
      const html = renderToStaticMarkup(React.createElement(Img, { src: bad }));
      assert(html === "", `expected no element for ${JSON.stringify(bad)}, got: ${html}`);
    }
  });
} finally {
  await fs.rm(genDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
