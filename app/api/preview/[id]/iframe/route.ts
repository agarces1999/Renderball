import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import React from "react";
import * as esbuild from "esbuild";
import { loadScript } from "../../../../../lib/store";
import { dimensionsForScript } from "../../../../../lib/render/build-wrapper";

// react-dom/server pulled in via runtime require to bypass Next.js's
// app-router static-analysis check ("don't import react-dom/server in
// components"). For API routes this is legitimate — we're SSRing the
// agent-emitted Composition into a self-contained HTML doc.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { renderToStaticMarkup } = eval('require')("react-dom/server") as {
  renderToStaticMarkup: (node: React.ReactNode) => string;
};

/**
 * Self-contained iframe-served preview of one Section{N}.
 *
 * Why iframe + on-demand compile (not dynamic import on the client):
 * Webpack's `import(\`...${var}...\`)` builds a context-module at compile
 * time and bakes in chunk references for every directory matching the
 * pattern THEN. New directories created mid-session (the typical
 * Renderball flow: user creates a new brief → agents write to
 * src/generated/<newId>/) aren't in the chunk map and the dynamic
 * import 404s. Iframe + server-side esbuild bypasses webpack entirely.
 *
 * Flow per request:
 *   1. Load script.json from disk
 *   2. Read Composition.tsx
 *   3. esbuild → CJS, externalize peer deps (react / lucide / recharts)
 *   4. Function-eval the bundle in a synthesized CJS context
 *   5. ReactDOMServer.renderToStaticMarkup(<Section{N} script={script}/>)
 *   6. Wrap in an HTML doc that auto-scales the natural-size content
 *      to the viewport and includes inline <style> for the @keyframes
 *      already baked into the section's own JSX
 *
 * GET /api/preview/<scriptId>/iframe?scene=<index>
 */
export async function GET(
  request: Request,
  { params }: { params: { id: string } },
) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "dev-only" }, { status: 404 });
  }

  const scriptId = params.id;
  const url = new URL(request.url);
  const sceneIndex = parseInt(url.searchParams.get("scene") ?? "0", 10);

  const script = await loadScript(scriptId);
  if (!script) {
    return new NextResponse(`script not found: ${scriptId}`, { status: 404 });
  }
  if (sceneIndex < 0 || sceneIndex >= script.scenes.length) {
    return new NextResponse(
      `scene ${sceneIndex} out of range (0..${script.scenes.length - 1})`,
      { status: 400 },
    );
  }

  const compPath = path.join(
    process.cwd(),
    "src",
    "generated",
    scriptId,
    "Composition.tsx",
  );
  try {
    await fs.access(compPath);
  } catch {
    return new NextResponse(
      `Composition.tsx not found at ${compPath}. Run /api/preview/build first.`,
      { status: 404 },
    );
  }

  // Compile the Composition.tsx (+ its sibling Img.tsx + script.json
  // imports) into a single CJS bundle. Externals stay as require() calls
  // resolved at eval time against the project's node_modules.
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
        // The Video shim imports from remotion; keep it a runtime require so
        // it's not server-bundled. getRemotionEnvironment() reports
        // isRendering:false here → the shim renders a plain <video>.
        "remotion",
        // The Lottie shim imports @remotion/lottie at module scope, but in
        // the static-preview branch it renders a plain container (the iframe's
        // injected lottie-web plays it). Externalize so it's not bundled here.
        "@remotion/lottie",
      ],
      logLevel: "silent",
    });
    bundleSource = result.outputFiles[0].text;
  } catch (err) {
    return new NextResponse(
      `Compilation error: ${err instanceof Error ? err.message : String(err)}`,
      { status: 500 },
    );
  }

  // Synthesize a CJS environment. We reuse this process's `require` so
  // externals resolve to the same React / lucide / recharts instances.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const moduleObj: { exports: Record<string, any> } = { exports: {} };
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function("module", "exports", "require", bundleSource);
    fn(moduleObj, moduleObj.exports, eval("require"));
  } catch (err) {
    return new NextResponse(
      `Module eval error: ${err instanceof Error ? err.message : String(err)}\n\n${bundleSource.slice(0, 500)}`,
      { status: 500 },
    );
  }

  const mod = moduleObj.exports;
  const candidates = [
    `Section${sceneIndex}`,
    `Scene${sceneIndex}Slide`,
    `Scene${sceneIndex}`,
    `Slide${sceneIndex}`,
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Section: React.ComponentType<{ script: typeof script }> | undefined;
  for (const name of candidates) {
    if (typeof mod[name] === "function") {
      Section = mod[name];
      break;
    }
  }
  if (!Section) {
    return new NextResponse(
      `No Section${sceneIndex} exported from Composition.tsx. Exports: ${Object.keys(mod).join(", ")}`,
      { status: 500 },
    );
  }

  let sectionHtml: string;
  try {
    sectionHtml = renderToStaticMarkup(
      React.createElement(Section, { script }),
    );
  } catch (err) {
    return new NextResponse(
      `Render error: ${err instanceof Error ? err.message : String(err)}`,
      { status: 500 },
    );
  }

  const dims = dimensionsForScript(script);

  // If the comp uses Lottie, the static HTML can't animate it (no JS runtime),
  // so inject lottie-web + a mount script that brings every .rb-lottie
  // container to life client-side. Only injected when actually needed.
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

  const doc = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Preview · Scene ${sceneIndex}</title>
<style>
  html, body { margin: 0; padding: 0; background: #000; overflow: hidden; height: 100%; }
  body { display: flex; align-items: center; justify-content: center; }
  /* Natural-size canvas, scaled to fit viewport via CSS variable. */
  .renderball-canvas {
    width: ${dims.width}px;
    height: ${dims.height}px;
    position: relative;
    transform-origin: top left;
  }
</style>
<script>
  // Compute scale = min(viewportW/canvasW, viewportH/canvasH) and
  // center the canvas. Re-runs on resize.
  function fit() {
    var c = document.querySelector('.renderball-canvas');
    if (!c) return;
    var sx = window.innerWidth / ${dims.width};
    var sy = window.innerHeight / ${dims.height};
    var s = Math.min(sx, sy);
    c.style.transform = 'scale(' + s + ')';
    // Position via offset so it stays centered after scaling
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
</body>
</html>`;

  return new NextResponse(doc, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      // The preview page mounts this in an iframe — allow that.
      "X-Frame-Options": "SAMEORIGIN",
    },
  });
}
