import { promises as fs } from "fs";
import path from "path";
import { createHash } from "crypto";
import React from "react";
import * as esbuild from "esbuild";
import { renderSceneSandboxed } from "./sandbox/pool";
import { hydrateGenDir } from "./gen-store";
import type { Script } from "../../src/schema";
import { dimensionsForScript, WIDE_LOCKUP_RATIO } from "./build-wrapper";
import { inlineAssetSrcs } from "../edit/image-assets";
import { FIT_TEXT_SCRIPT, textFitEnabled } from "./fit-text";

// react-dom/server via runtime require to bypass Next's app-router static check.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { renderToStaticMarkup } = eval("require")("react-dom/server") as {
  renderToStaticMarkup: (node: React.ReactNode) => string;
};

export type SceneDocResult =
  | { ok: true; html: string; cacheKey?: string; cacheHit?: boolean }
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
  /**
   * CLIENT PREVIEW Phase 1 (docs/CLIENT_PREVIEW_SPIKE.md): also load the deck's
   * browser bundle (same compile artifact the sandbox SSRs) and client-render
   * the Section into a DETACHED container — invisible to the lottie/fit scans —
   * then publish a canonical-DOM comparison on window.__rbParity. Read-only:
   * what the user sees stays the SSR markup. bundleUrl is lane-specific
   * (/api/dev/... vs /api/preview/...), provided by the route.
   */
  hydrate?: { bundleUrl: string };
}

const RENDER_CACHE_MAX = 64;
const globalForRenderCache = globalThis as unknown as { __rbRenderCache?: Map<string, string> };
const renderCache: Map<string, string> = (globalForRenderCache.__rbRenderCache ??= new Map());

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

  /**
   * CONTENT-HASH RENDER CACHE (speed playbook 2026-08-18). renderSceneDoc is
   * pure given (composition bytes, script, scene, settle) — the comment
   * below has said so for weeks; this makes it true operationally. Same
   * inputs → the exact HTML we already produced, no compile, no sandbox,
   * no SSR. Two callers profit immediately: repeated editor loads of an
   * unchanged scene, and every measure/gate pass that re-renders scenes a
   * repair round didn't touch. The key hashes the real bytes (never mtimes)
   * + scriptId (no cross-document sharing even on collision-shaped input).
   * LRU on globalThis (the Next dev multi-instance lesson), ~64 entries —
   * full decks, not fragments, so memory stays bounded.
   */
  let compBytes: Buffer;
  try {
    compBytes = await fs.readFile(compPath);
  } catch {
    return {
      ok: false,
      status: 404,
      message: `Composition.tsx not found for ${scriptId}. Run a build first.`,
    };
  }

  const cacheKey = createHash("sha1")
    .update(scriptId)
    .update("\u0000")
    .update(compBytes)
    .update("\u0000")
    .update(JSON.stringify(script))
    .update(`\u0000${sceneIndex}\u0000${opts.settle ? 1 : 0}\u0000${opts.hydrate ? `h:${opts.hydrate.bundleUrl}` : ""}\u0000v3`)
    .digest("hex");
  const cached = renderCache.get(cacheKey);
  if (cached) {
    // LRU touch: re-insert as newest.
    renderCache.delete(cacheKey);
    renderCache.set(cacheKey, cached);
    return { ok: true, html: cached, cacheKey, cacheHit: true };
  }

  // Compile + execute + render happen in a SEPARATE PROCESS with an empty
  // environment (lib/render/sandbox/pool.ts). Composition code is written by a
  // model whose prompt includes crawled third-party text, and it used to run
  // right here — next to DATABASE_URL, CLERK_SECRET_KEY, STRIPE_SECRET_KEY and
  // RB_FIREWORKS_KEY. It also ran synchronously and un-interruptibly, so one
  // composition with an infinite loop froze the server for everyone. Only the
  // finished HTML string crosses back, and the sandbox has a hard timeout.
  const rendered = await renderSceneSandboxed(compPath, sceneIndex, script);
  if (!rendered.ok) {
    return { ok: false, status: rendered.status, message: rendered.message };
  }

  let sectionHtml = rendered.html;

  // Document-asset refs (editor-inserted images, lib/edit/image-assets.ts) are
  // origin-free tokens — inline the bytes so this doc renders identically in
  // the preview iframe and in export's origin-less page.setContent.
  sectionHtml = await inlineAssetSrcs(sectionHtml, path.dirname(compPath));

  const dims = dimensionsForScript(script);

  const lottieMount = sectionHtml.includes("rb-lottie")
    ? // SELF-HOSTED (speed playbook 2026-08-18): this script sits inside EVERY
    // scene document — editor re-renders, measure passes, exports — and the
    // cdnjs fetch put a third-party round-trip (and a third-party outage
    // mode) on the hot path. Same pinned build, served from our own origin.
    `<script src="/vendor/lottie-5.12.2.min.js"></script>
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
    /* Morph hook: a piece-swap can add .rb-lottie nodes after load — the
       parent editor re-invokes the mount for exactly that. Idempotent via
       data-rb-init. */
    window.__rbLottieMount = play;
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

  /**
   * CLIENT PREVIEW Phase 1 parity block. Loads the deck's browser bundle
   * (same compile source the sandbox evaluates), client-renders the Section
   * into a DETACHED container, and publishes a canonical-DOM comparison on
   * window.__rbParity. Detached is load-bearing twice: the lottie/fit scans
   * (document.querySelectorAll) can never see the client tree, and the user
   * keeps seeing exactly the SSR markup — read-only proof, zero UX change.
   *
   * Canonicalization notes, each a real divergence class found in design:
   * - style attrs compare via el.style longhands (sorted), NEVER the raw
   *   attribute string — the SSR side carries React's serialization, the
   *   client side the browser's, and they differ in whitespace for
   *   identical styles. Routing both through the same CSSStyleDeclaration
   *   normalizes identically.
   * - src/href values in the binary classes (data:, blob:, assets/,
   *   /api/assets) normalize to "[bin]": inlineAssetSrcs rewrote the SSR
   *   side to data URIs while the client tree keeps the raw token. Bounded,
   *   documented divergence — everything else about the node still compares.
   * - adjacent text nodes merge per element (the HTML parser coalesces,
   *   React keeps them separate).
   * - raw-text elements (style/script) decode HTML entities before compare
   *   (corpus find, 2 of 5 mismatches): React SSR escapes quotes in <style>
   *   children to &quot;/&#x27;, and the browser NEVER decodes entities in
   *   raw-text — those CSS declarations were silently broken in SSR all
   *   along; the client render is the more correct one. Decode is
   *   idempotent, so applying to both sides only collapses the entity form.
   * - attribute values that are pure floats round to 3 decimals (corpus
   *   find: recharts branches on environment and emits 112.49999999999993
   *   vs 112.5 for the same line). Sub-0.001px is invisible; real layout
   *   differences still compare.
   * - the capture runs SYNCHRONOUSLY at parse time, before fonts.ready/
   *   DOMContentLoaded, so fit-text and lottie have not mutated the SSR DOM
   *   yet, and flushSync captures the client tree before async effects.
   */
  const hydrateBlock = opts.hydrate
    ? `<script src="${opts.hydrate.bundleUrl}"></script>
<script>
(function () {
  var out = { ok: false, phase: "init" };
  window.__rbParity = out;
  try {
    var SCRIPT = ${JSON.stringify(JSON.stringify(script)).replace(/</g, "\\u003c")};
    var SCENE = ${sceneIndex};
    var BIN = /^(data:|blob:|assets\\/|\\/api\\/assets)/;
    var FLOAT = /^-?\\d+\\.\\d+$/;
    function decodeEntities(t) {
      return t.replace(/&(quot|#x27|#39|amp|lt|gt);/g, function (_, e) {
        return e === "quot" ? '"' : e === "amp" ? "&" : e === "lt" ? "<" : e === "gt" ? ">" : "'";
      });
    }
    function canonEl(el, buf) {
      buf.push("<", el.nodeName);
      var names = el.getAttributeNames().filter(function (n) { return n.indexOf("data-react") !== 0 && n !== "style"; }).sort();
      for (var i = 0; i < names.length; i++) {
        var v = el.getAttribute(names[i]) || "";
        if ((names[i] === "src" || names[i] === "href" || names[i] === "xlink:href") && BIN.test(v)) v = "[bin]";
        if (FLOAT.test(v)) v = String(Math.round(parseFloat(v) * 1000) / 1000);
        buf.push(" ", names[i], "=", JSON.stringify(v));
      }
      if (el.style && el.style.length) {
        var props = [];
        for (var k = 0; k < el.style.length; k++) props.push(el.style[k] + ":" + el.style.getPropertyValue(el.style[k]));
        props.sort();
        buf.push(' style="', props.join(";"), '"');
      }
      buf.push(">");
      var nn = el.nodeName.toUpperCase();
      if (nn === "STYLE" || nn === "SCRIPT") buf.push(JSON.stringify(decodeEntities(el.textContent || "")));
      else canonChildren(el, buf);
      buf.push("</", el.nodeName, ">");
    }
    function canonChildren(root, buf) {
      var text = "";
      for (var c = root.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) { text += c.nodeValue; continue; }
        if (c.nodeType === 1) {
          if (text) { buf.push(JSON.stringify(text)); text = ""; }
          canonEl(c, buf);
        }
      }
      if (text) buf.push(JSON.stringify(text));
    }
    function canon(root) { var buf = []; canonChildren(root, buf); return buf.join(""); }

    out.phase = "ssr-capture";
    var ssr = canon(document.querySelector(".renderball-canvas"));

    out.phase = "client-render";
    var C = window.__rbComposition;
    if (!C) throw new Error("bundle did not attach __rbComposition");
    var Section = C.Comp["Section" + SCENE];
    if (!Section) throw new Error("Section" + SCENE + " not exported by bundle");
    var host = document.createElement("div");
    var root = C.createRoot(host);
    C.flushSync(function () { root.render(C.React.createElement(Section, { script: JSON.parse(SCRIPT) })); });

    out.phase = "client-capture";
    var client = canon(host);
    root.unmount();

    var match = ssr === client;
    var firstDiff = -1;
    if (!match) {
      var n = Math.min(ssr.length, client.length);
      for (var j = 0; j < n; j++) { if (ssr.charAt(j) !== client.charAt(j)) { firstDiff = j; break; } }
      if (firstDiff < 0) firstDiff = n;
    }
    window.__rbParity = {
      ok: true, match: match, ssrLen: ssr.length, clientLen: client.length, firstDiff: firstDiff,
      ssrCtx: match ? "" : ssr.slice(Math.max(0, firstDiff - 60), firstDiff + 140),
      clientCtx: match ? "" : client.slice(Math.max(0, firstDiff - 60), firstDiff + 140)
    };
  } catch (e) {
    window.__rbParity = { ok: false, phase: out.phase, error: String((e && e.message) || e) };
  }
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
  /* TRANSPARENT, never a colour. This document is always letterboxed inside
     somebody else's frame — fit() below scales the canvas into whatever box it
     lands in and centres it, so there is nearly always leftover space, even a
     rounding rim when the aspect is exact. A colour here paints that leftover
     ITSELF, on top of the host's frame. #000 did, and the black pillarbox
     showed up inside the editor's white canvas frame: measured 214px wide at a
     620px-tall viewport, 342px with a banner open, and still a 4px black rim at
     heights where the aspect came out exactly 16:9.
       Transparent hands the letterbox back to the host, the only party that
     knows what colour it should be: white in the editor, #0b0d12 on the video
     preview surface (PreviewClient sets that on the iframe element itself —
     measured rgb(11,13,18) in its bars after this change), bg-surface in the
     share viewer. No host can paint the wrong bars again.
       Exports are unaffected: they screenshot at exactly dims.width×dims.height,
     where fit() scales to 1 and the letterbox has zero area. Measured rather
     than assumed — every page of a 5-page deck, captured the way
     export-static.ts captures with omitBackground:true, came back with zero
     translucent pixels (canvas 1920x1080 at 0,0 in a 1920x1080 viewport). What
     is behind the canvas cannot reach a PNG or a PDF. */
  html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; height: 100%; }
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
  // Re-entry for the editor. fit() writes its scale as INLINE STYLE on
  // .renderball-canvas, and the morph path's ancestor sync copies style from a
  // freshly-rendered document — where fit() has never run, so the canvas there
  // carries no transform. Copying that absence onto the live canvas wipes the
  // scale and the page snaps to 1:1: a 1920px canvas in a ~1000px frame, which
  // reads as "everything expanded". Idempotent, so calling it after any DOM
  // surgery is always safe and always correct.
  window.__rbFit = fit;
</script>
</head>
<body>
<div class="renderball-canvas">${sectionHtml}</div>
${textFitEnabled() ? `<script>${FIT_TEXT_SCRIPT}</script>` : ""}
${lottieMount}
${lockupMount}
${hydrateBlock}
</body>
</html>`;

  renderCache.set(cacheKey, html);
  if (renderCache.size > RENDER_CACHE_MAX) {
    const oldest = renderCache.keys().next().value;
    if (oldest !== undefined) renderCache.delete(oldest);
  }
  return { ok: true, html, cacheKey, cacheHit: false };
}
