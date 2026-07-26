import { promises as fs } from "fs";
import path from "path";
import React from "react";
import * as esbuild from "esbuild";
import { sandboxedRequire, shadowedFunctionArgs, shadowedValues } from "./code-guard";
import { hydrateGenDir } from "./gen-store";
import type { Script } from "../../src/schema";
import { dimensionsForScript, WIDE_LOCKUP_RATIO } from "./build-wrapper";
import { inlineAssetSrcs } from "../edit/image-assets";

// react-dom/server via runtime require to bypass Next's app-router static check.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { renderToStaticMarkup } = eval("require")("react-dom/server") as {
  renderToStaticMarkup: (node: React.ReactNode) => string;
};

export type SceneDocResult =
  | { ok: true; html: string }
  | { ok: false; status: number; message: string };

/**
 * SSR one Section{N} of a generated Composition into a self-contained HTML doc —
 * the shared core of the preview iframe. esbuild compiles Composition.tsx on demand
 * (webpack can't dynamic-import dirs created mid-session), we eval it in a synthesized
 * CJS context reusing this process's require (so react/lucide/recharts are the same
 * instances), render the Section, and wrap it in an auto-scaling canvas doc.
 *
 * Auth + script loading are the caller's job; this is pure given a loaded script.
 */
export interface SceneDocOptions {
  /**
   * Render the scene SETTLED: jump every finite entry animation to its end state
   * (the same `animation-delay: -100000s` override measure-scene.ts uses, which the
   * MP4's late frames match). The editor passes this on post-edit reloads so an edit
   * shows its final result in ~300ms instead of replaying up to ~6s of entrance
   * choreography. First loads / scene switches keep animations (settle omitted).
   */
  settle?: boolean;
}

export async function renderSceneDoc(
  scriptId: string,
  sceneIndex: number,
  script: Script,
  opts: SceneDocOptions = {},
): Promise<SceneDocResult> {
  if (sceneIndex < 0 || sceneIndex >= script.scenes.length) {
    return { ok: false, status: 400, message: `scene ${sceneIndex} out of range (0..${script.scenes.length - 1})` };
  }

  // Restore from durable storage if this container has never seen the
  // document — i.e. any container after a deploy. Every render path (canvas,
  // export, thumbnail) funnels through here, so this one call is what keeps a
  // built deck alive across the ephemeral filesystem. No-op when it is
  // already local.
  await hydrateGenDir(scriptId);

  const compPath = path.join(process.cwd(), "src", "generated", scriptId, "Composition.tsx");
  try {
    await fs.access(compPath);
  } catch {
    return {
      ok: false,
      status: 404,
      message: `Composition.tsx not found for ${scriptId}. Run a build first.`,
    };
  }

  let bundleSource: string;
  try {
    const result = await esbuild.build({
      entryPoints: [compPath],
      bundle: true,
      format: "cjs",
      platform: "node",
      target: "node18",
      jsx: "automatic",
      write: false,
      external: [
        "react",
        "react-dom",
        "react-dom/server",
        "recharts",
        "lucide-react",
        "shiki",
        "simple-icons",
        "simple-icons/icons",
        "remotion",
        "@remotion/lottie",
      ],
      logLevel: "silent",
    });
    bundleSource = result.outputFiles[0].text;
  } catch (err) {
    return { ok: false, status: 500, message: `Compilation error: ${err instanceof Error ? err.message : String(err)}` };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const moduleObj: { exports: Record<string, any> } = { exports: {} };
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function(...shadowedFunctionArgs(), bundleSource);
    fn(moduleObj, moduleObj.exports, sandboxedRequire(eval("require")), ...shadowedValues());
  } catch (err) {
    return { ok: false, status: 500, message: `Module eval error: ${err instanceof Error ? err.message : String(err)}` };
  }

  const mod = moduleObj.exports;
  const candidates = [`Section${sceneIndex}`, `Scene${sceneIndex}Slide`, `Scene${sceneIndex}`, `Slide${sceneIndex}`];
  let Section: React.ComponentType<{ script: typeof script }> | undefined;
  for (const name of candidates) {
    if (typeof mod[name] === "function") {
      Section = mod[name];
      break;
    }
  }
  if (!Section) {
    return { ok: false, status: 500, message: `No Section${sceneIndex} exported. Exports: ${Object.keys(mod).join(", ")}` };
  }

  let sectionHtml: string;
  try {
    sectionHtml = renderToStaticMarkup(React.createElement(Section, { script }));
  } catch (err) {
    return { ok: false, status: 500, message: `Render error: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Document-asset refs (editor-inserted images, lib/edit/image-assets.ts) are
  // origin-free tokens — inline the bytes so this doc renders identically in
  // the preview iframe and in export's origin-less page.setContent.
  sectionHtml = await inlineAssetSrcs(sectionHtml, path.dirname(compPath));

  const dims = dimensionsForScript(script);

  const lottieMount = sectionHtml.includes("rb-lottie")
    ? `<script src="https://cdnjs.cloudflare.com/ajax/libs/lottie-web/5.12.2/lottie.min.js"></script>
<script>
  (function () {
    function play() {
      var els = document.querySelectorAll('.rb-lottie[data-lottie-src]');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (el.getAttribute('data-rb-init') || !window.lottie) continue;
        el.setAttribute('data-rb-init', '1');
        try {
          window.lottie.loadAnimation({
            container: el,
            path: el.getAttribute('data-lottie-src'),
            renderer: 'svg',
            loop: el.getAttribute('data-lottie-loop') !== '0',
            autoplay: true,
          });
        } catch (e) {}
      }
    }
    if (window.lottie) play();
    document.addEventListener('DOMContentLoaded', play);
    window.addEventListener('load', play);
  })();
</script>`
    : "";

  const lockupMount = sectionHtml.includes("data-rb-brand-logo")
    ? `<script>
  (function () {
    function apply(img) {
      if (!(img.naturalHeight > 0 && img.naturalWidth / img.naturalHeight > ${WIDE_LOCKUP_RATIO})) return;
      var mark = img.parentElement;
      var span = mark && mark.querySelector('[data-rb-brand-wordmark]');
      if (span) span.style.display = 'none';
    }
    function scan() {
      var imgs = document.querySelectorAll('img[data-rb-brand-logo]');
      for (var i = 0; i < imgs.length; i++) {
        if (imgs[i].complete) apply(imgs[i]);
        else imgs[i].addEventListener('load', function (e) { apply(e.target); });
      }
    }
    document.addEventListener('DOMContentLoaded', scan);
    window.addEventListener('load', scan);
  })();
</script>`
    : "";

  // Settled mode: the !important longhand beats inline shorthand delays, jumping
  // finite fill-forwards entry animations to their final frame (infinite ambient
  // loops just phase-shift — they keep looping). Matches measure-scene + MP4 truth.
  const settleCss = opts.settle
    ? `
  *, *::before, *::after { animation-delay: -100000s !important; }`
    : "";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Preview · Scene ${sceneIndex}</title>
<style>
  html, body { margin: 0; padding: 0; background: #000; overflow: hidden; height: 100%; }
  body { display: flex; align-items: center; justify-content: center; }${settleCss}
  .renderball-canvas {
    width: ${dims.width}px;
    height: ${dims.height}px;
    position: relative;
    transform-origin: top left;
  }
</style>
<script>
  function fit() {
    var c = document.querySelector('.renderball-canvas');
    if (!c) return;
    var sx = window.innerWidth / ${dims.width};
    var sy = window.innerHeight / ${dims.height};
    var s = Math.min(sx, sy);
    c.style.transform = 'scale(' + s + ')';
    var w = ${dims.width} * s;
    var h = ${dims.height} * s;
    c.style.position = 'absolute';
    c.style.left = ((window.innerWidth - w) / 2) + 'px';
    c.style.top = ((window.innerHeight - h) / 2) + 'px';
  }
  window.addEventListener('resize', fit);
  document.addEventListener('DOMContentLoaded', fit);
</script>
</head>
<body>
<div class="renderball-canvas">${sectionHtml}</div>
${lottieMount}
${lockupMount}
</body>
</html>`;

  return { ok: true, html };
}
