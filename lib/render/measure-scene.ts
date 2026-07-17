/**
 * Render-truth measurement primitive.
 *
 * The whole quality system pivots on this: instead of static-analyzing the
 * generated CODE (which can't see flex/content overflow, computed contrast, or
 * transforms), we render each scene in a REAL browser and measure what actually
 * paints. Every defect that ships (clipped text, light-on-light logos, dead
 * regions) is a property of the rendered output, not the source — so we measure
 * the output.
 *
 * How:
 *   1. Bundle + eval the genDir's Composition.tsx and grab Section{N} — the
 *      EXACT path ssr-render.ts's gate uses, so "renders here" == "renders in
 *      the preview/MP4".
 *   2. renderToStaticMarkup(Section, { script }) → the scene's real DOM.
 *   3. Load it in headless Chromium (Playwright) at 1920×1080, with every CSS
 *      animation jumped to its settled END state via a `animation-delay:
 *      -100000s !important` override (fill-mode forwards/both → final frame).
 *      This matches what the SectionClock pins for the MP4's late frames,
 *      without needing the Remotion clock.
 *   4. page.evaluate → every element's getBoundingClientRect + computed colors.
 *   5. screenshot the frame (for the deterministic contrast/dead-region checks
 *      and the vision gate).
 *
 * Deliberately uses Playwright (stable, documented page API) over Remotion's
 * internal puppeteer fork (newPage needs internal types; screenshot lives behind
 * a deep dist import the package `exports` map can block). Boring-by-default for
 * a load-bearing primitive.
 *
 * Best-effort + fail-closed: a browser/load error returns { error } for that
 * scene (the gate treats a measurement error as a gate failure, never silent).
 */
import { promises as fs } from "fs";
import path from "path";
import { createRequire } from "module";
import React from "react";
import * as esbuild from "esbuild";

// Same externals the SSR gate uses — peer deps resolve at runtime; only the
// local TS (Composition + ./Img/./BrandChrome shims) bundles.
const EXTERNALS = [
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
];

const nodeRequire: NodeRequire = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return eval("require") as NodeRequire;
  } catch {
    return createRequire(path.join(process.cwd(), "package.json"));
  }
})();

const { renderToStaticMarkup } = nodeRequire("react-dom/server") as {
  renderToStaticMarkup: (node: React.ReactNode) => string;
};

export interface MeasuredElement {
  tag: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Computed text color, rgb() string. */
  color: string;
  /** Computed own background-color, rgb()/rgba() string. */
  bg: string;
  /** Trimmed direct text (first ~60 chars), empty if the element has no own text. */
  text: string;
  isImg: boolean;
  src?: string;
  /** <img> only: the DECODED intrinsic width. 0 = the image failed to load/
   *  decode (renders as the broken-image glyph) — the v12 broken-image swap
   *  keys off this. Undefined for non-imgs and for older fixtures. */
  imgNaturalWidth?: number;
  fontSize: number;
  opacity: number;
  /** Enclosing LEGO piece id (closest [data-piece]), "" when outside any piece. */
  piece: string;
  /** The enclosing piece's kind (data-kind: text/diegetic/image/atmosphere/chrome),
   *  "" when outside any piece. Optional so hand-built test fixtures stay small. */
  pieceKind?: string;
  /** True when an ancestor WITHIN the same piece paints an opaque background or
   *  gradient under this element (text on its own card/scrim — intentional). */
  onOpaqueSurface: boolean;
  /** True when elementFromPoint at this element's center hits a NON-related
   *  element — i.e. something else is stacked ON TOP of it (the clipped-by-mock
   *  signal; text that is visibly on top reports false). */
  coveredAtCenter: boolean;
  /** Computed border-top-left-radius in px (0 = square). Optional: older
   *  fixtures predate it. v13 — the skeleton-bar detector keys on rounding. */
  radius?: number;
  /** Index (into this scene's elements array) of the nearest RECORDED ancestor,
   *  -1 at the top. Optional: older fixtures predate it. v13 — sibling
   *  grouping for the skeleton-bar detector. */
  parentIx?: number;
  /** True when the subtree carries ANY text (own or descendants'). Optional:
   *  older fixtures predate it. */
  hasTextDesc?: boolean;
  /** True when the element paints a background-image/gradient (computed
   *  backgroundColor alone is transparent for gradients). Optional. */
  hasBgImage?: boolean;
}

export interface SceneMeasurement {
  scene: number;
  width: number;
  height: number;
  elements: MeasuredElement[];
  /** Absolute path to the rendered PNG, or undefined if screenshot failed. */
  screenshotPath?: string;
  /** Set when the scene could not be measured at all (treat as a gate failure). */
  error?: string;
}

export const CANVAS_DIMS: Record<string, { w: number; h: number }> = {
  "16:9": { w: 1920, h: 1080 },
  "9:16": { w: 1080, h: 1920 },
  "1:1": { w: 1080, h: 1080 },
};

// The DOM-walk runs INSIDE the browser page (serialized by Playwright). Keep it
// dependency-free and self-contained.
const PAGE_WALK = `(() => {
  const out = [];
  const recordedIx = new Map();
  const alphaOf = (c) => {
    const m = /rgba?\\(([^)]+)\\)/.exec(c || "");
    if (!m) return 0;
    const p = m[1].split(",").map((v) => parseFloat(v.trim()));
    return p.length >= 4 ? (isNaN(p[3]) ? 1 : p[3]) : 1;
  };
  const els = document.querySelectorAll("*");
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    // direct text only (not descendants') so a wrapper isn't credited with child copy
    let text = "";
    for (const n of el.childNodes) if (n.nodeType === 3) text += n.textContent;
    text = text.replace(/\\s+/g, " ").trim().slice(0, 60);
    // LEGO piece ancestry + whether an ancestor INSIDE the same piece paints an
    // opaque surface under this element (text on its own card = intentional).
    // Gradients count: computed backgroundColor is transparent for them, but a
    // gradient-backed card is every bit a surface (Arc's overlay card).
    const pieceEl = el.closest ? el.closest("[data-piece]") : null;
    const piece = pieceEl ? pieceEl.getAttribute("data-piece") || "" : "";
    const pieceKind = pieceEl ? pieceEl.getAttribute("data-kind") || "" : "";
    let onOpaqueSurface = false;
    for (let a = el.parentElement; a && pieceEl && pieceEl.contains(a); a = a.parentElement) {
      const acs = getComputedStyle(a);
      if (alphaOf(acs.backgroundColor) >= 0.5 || (acs.backgroundImage && acs.backgroundImage !== "none")) {
        onOpaqueSurface = true;
        break;
      }
      if (a === pieceEl) break;
    }
    // Stacking truth: is something unrelated painted ON TOP of this element's
    // center? (elementFromPoint sees the topmost hit-testable element — the
    // clipped-by-a-mock case; an element visibly on top reports false.)
    let coveredAtCenter = false;
    try {
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      if (cx >= 0 && cy >= 0 && cx < window.innerWidth && cy < window.innerHeight) {
        const hit = document.elementFromPoint(cx, cy);
        coveredAtCenter = !!hit && hit !== el && !el.contains(hit) && !hit.contains(el);
      }
    } catch (e) {}
    // Nearest RECORDED ancestor (skipped ancestors — 0x0, display:none — are
    // walked through so sibling grouping survives them).
    let parentIx = -1;
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (recordedIx.has(p)) { parentIx = recordedIx.get(p); break; }
    }
    recordedIx.set(el, out.length);
    out.push({
      tag: el.tagName.toLowerCase(),
      x: Math.round(r.x), y: Math.round(r.y),
      w: Math.round(r.width), h: Math.round(r.height),
      color: cs.color,
      bg: cs.backgroundColor,
      text,
      isImg: el.tagName === "IMG",
      src: el.tagName === "IMG" ? el.getAttribute("src") || undefined : undefined,
      imgNaturalWidth: el.tagName === "IMG" ? (typeof el.naturalWidth === "number" ? el.naturalWidth : 0) : undefined,
      fontSize: parseFloat(cs.fontSize) || 0,
      opacity: parseFloat(cs.opacity),
      piece,
      pieceKind,
      onOpaqueSurface,
      coveredAtCenter,
      radius: parseFloat(cs.borderTopLeftRadius) || 0,
      parentIx,
      hasTextDesc: ((el.textContent || "").trim().length > 0),
      hasBgImage: !!(cs.backgroundImage && cs.backgroundImage !== "none"),
    });
  }
  return out;
})()`;

const buildSceneHtml = (
  bodyHtml: string,
  fonts: { family?: string; src?: string }[],
  dims: { w: number; h: number },
): string => {
  // @font-face for any captured brand font so text measures at real metrics.
  const faces = fonts
    .filter((f) => f.family && f.src)
    .map(
      (f) =>
        `@font-face{font-family:"${f.family}";src:url("${f.src}");font-display:block;}`,
    )
    .join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;}
    ${faces}
    /* Jump every animation to its settled END state (fill-mode forwards/both
       → final frame). !important longhand beats the inline shorthand's delay. */
    *,*::before,*::after{animation-delay:-100000s !important;}
    #rb-stage{position:relative;width:${dims.w}px;height:${dims.h}px;overflow:hidden;}
  </style></head><body>
    <div id="rb-stage">${bodyHtml}</div>
  </body></html>`;
};

/**
 * Measure every scene of a written genDir in a real browser. Returns one entry
 * per scene with measured element rects/colors + a screenshot path. Screenshots
 * are written to `${outDir}/measure-scene-${i}.png`.
 */
export const measureScenes = async (
  genDir: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  script: any,
  outDir: string,
): Promise<SceneMeasurement[]> => {
  const sceneCount: number = Array.isArray(script?.scenes) ? script.scenes.length : 0;
  const aspect: string = script?.config?.aspect_ratio || "16:9";
  const dims = CANVAS_DIMS[aspect] || CANVAS_DIMS["16:9"];
  const fonts: { family?: string; src?: string }[] = Array.isArray(script?.assets?.fonts)
    ? script.assets.fonts
    : [];

  // ── bundle + eval the composition (same pattern as ssr-render.ts) ──────────
  const compPath = path.join(genDir, "Composition.tsx");
  let mod: Record<string, unknown>;
  try {
    const result = await esbuild.build({
      entryPoints: [compPath],
      bundle: true,
      format: "cjs",
      platform: "node",
      target: "node18",
      jsx: "automatic",
      write: false,
      external: EXTERNALS,
      logLevel: "silent",
    });
    const bundle = result.outputFiles[0].text;
    const moduleObj: { exports: Record<string, unknown> } = { exports: {} };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function("module", "exports", "require", bundle)(
      moduleObj,
      moduleObj.exports,
      nodeRequire,
    );
    mod = moduleObj.exports;
  } catch (err) {
    const error = `compile/eval: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
    return Array.from({ length: sceneCount }, (_, i) => ({
      scene: i,
      width: dims.w,
      height: dims.h,
      elements: [],
      error,
    }));
  }

  // ── render each Section to HTML up front (Node side) ───────────────────────
  const htmls: (string | null)[] = [];
  for (let i = 0; i < sceneCount; i++) {
    const Section = [`Section${i}`, `Scene${i}Slide`, `Scene${i}`, `Slide${i}`]
      .map((n) => mod[n])
      .find((f) => typeof f === "function") as
      | React.ComponentType<{ script: unknown }>
      | undefined;
    if (!Section) {
      htmls.push(null);
      continue;
    }
    try {
      htmls.push(renderToStaticMarkup(React.createElement(Section, { script })));
    } catch {
      htmls.push(null);
    }
  }

  await fs.mkdir(outDir, { recursive: true });

  // ── load each in a real browser, measure + screenshot ─────────────────────
  // Playwright is a dev/runtime dep; dynamic-import so a missing browser fails
  // closed per-scene rather than crashing module load.
  let chromium: typeof import("playwright").chromium;
  try {
    // CJS/ESM interop: `chromium` is normally on the namespace, but under Next
    // dev a hot-recompile (e.g. a commit landing mid-build, which is what broke
    // loop iteration 2) can re-wrap the CJS module so the export lands under
    // `.default` instead — the bare `({ chromium } = ...)` destructure then
    // yielded `undefined` and `chromium.launch` crashed with "Cannot read
    // properties of undefined (reading 'launch')". Resolve BOTH shapes, and fail
    // loudly (→ "playwright unavailable" measure-error) if truly absent.
    const pw = (await import("playwright")) as unknown as {
      chromium?: typeof import("playwright").chromium;
      default?: { chromium?: typeof import("playwright").chromium };
    };
    const resolved = pw.chromium ?? pw.default?.chromium;
    if (!resolved) {
      throw new Error("playwright loaded but its `chromium` export is undefined (module interop)");
    }
    chromium = resolved;
  } catch (err) {
    const error = `playwright unavailable: ${err instanceof Error ? err.message : String(err)}`;
    return Array.from({ length: sceneCount }, (_, i) => ({
      scene: i, width: dims.w, height: dims.h, elements: [], error,
    }));
  }

  // The PACKAGE import above succeeds whenever node_modules is present; what is
  // typically missing is the chromium BINARY (no `playwright install`). That
  // surfaces HERE, at launch — so it must be inside its own try, or it throws
  // uncaught out of measureScenes and the build route 500s instead of returning
  // the documented per-scene measure-error that fail-closes to a 422.
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  try {
    browser = await chromium.launch({ args: ["--no-sandbox"] });
  } catch (err) {
    const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
    const error = /executable doesn'?t exist|please run|install/i.test(msg)
      ? `playwright chromium not installed — run: npx playwright install chromium (${msg})`
      : `browser launch failed: ${msg}`;
    return Array.from({ length: sceneCount }, (_, i) => ({
      scene: i, width: dims.w, height: dims.h, elements: [], error,
    }));
  }
  const results: SceneMeasurement[] = [];
  try {
    const page = await browser.newPage({
      viewport: { width: dims.w, height: dims.h },
      deviceScaleFactor: 1,
    });
    for (let i = 0; i < sceneCount; i++) {
      const bodyHtml = htmls[i];
      if (bodyHtml == null) {
        results.push({ scene: i, width: dims.w, height: dims.h, elements: [], error: `no Section${i} / render failed` });
        continue;
      }
      try {
        const html = buildSceneHtml(bodyHtml, fonts, dims);
        // `networkidle` waits on the brand's REMOTE fonts/images, an unbounded
        // flakiness source for what is now a BLOCKING gate. Retry once on the
        // more lenient `load` so a transient remote stall doesn't hard-fail a
        // build; a genuinely-broken scene still errors on both attempts.
        try {
          await page.setContent(html, { waitUntil: "networkidle", timeout: 30000 });
        } catch {
          await page.setContent(html, { waitUntil: "load", timeout: 30000 });
        }
        // fonts loaded + a beat for layout to settle
        await page.evaluate("document.fonts && document.fonts.ready").catch(() => {});
        // SETTLE entry animations to their FINAL state before measuring AND
        // screenshotting. setContent renders at t=0, so without this we captured
        // an EARLY frame — diegetic elements (cards, terminals, mock UIs, charts)
        // were still animating in (opacity 0 / off-screen). That caused (a) the
        // render-truth gate to see false OFF-CANVAS (elements mid slide-in),
        // triggering the expensive repair ladder, and (b) the advisory vision
        // gate to judge scenes as "wall-of-type, no diegetic element" (the
        // over-flagging seen on Linear/Duolingo/Vercel). finish() jumps finite
        // entry animations to their end; infinite ambient ones throw → skipped.
        await page
          .evaluate(
            "try{(document.getAnimations?document.getAnimations():[]).forEach(function(a){try{a.finish()}catch(e){}})}catch(e){}",
          )
          .catch(() => {});
        await page.waitForTimeout(250).catch(() => {});
        const elements = (await page.evaluate(PAGE_WALK)) as MeasuredElement[];
        const screenshotPath = path.join(outDir, `measure-scene-${i}.png`);
        await page.screenshot({ path: screenshotPath, clip: { x: 0, y: 0, width: dims.w, height: dims.h } });
        results.push({ scene: i, width: dims.w, height: dims.h, elements, screenshotPath });
      } catch (err) {
        results.push({
          scene: i, width: dims.w, height: dims.h, elements: [],
          error: `measure: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
        });
      }
    }
  } finally {
    await browser.close();
  }
  return results;
};
