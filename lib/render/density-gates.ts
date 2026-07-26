/**
 * Density gates — deterministic sensors that make "thin" a measurable,
 * BLOCKING defect of the assembled scene code.
 *
 * Evidence base (forensic audit, 2026-07): the reference GLM build
 * (01KXEAF0SNT0RR079Z1SJZ1KWZ) and the thin gpt-oss spike build
 * (CAST_SPIKE_FULL_HUBSPOT) were both SSR-rendered and measured. Naive
 * whole-scene element counts do NOT separate them (reference s4 = 46 elements
 * < spike s1 = 51) — what separates 5/5 vs 0/5 with double margins is the
 * INTERIOR of the diegetic mock, the DEPTH of the DOM, and the VARIETY of the
 * atmosphere layers. These gates measure exactly that:
 *
 *   a. DIEGETIC-INTERIOR FLOOR — per scene, at least one data-kind="diegetic"
 *      piece whose wrapper contains ≥15 element descendants AND ≥4 non-empty
 *      interior text nodes. (Reference per-scene best: 87/30, 36/7, 45/7,
 *      36/7, 15/5. Spike best: 13/3.)
 *   a2. PER-HERO FLOOR (acceptance v6, 2026-07-16) — any piece whose
 *      data-piece id ends in ".hero" must ITSELF meet a hero floor
 *      (≥15 element descendants AND ≥1 non-empty text node). Clause (a) alone
 *      leaked: acceptance v5's scene 2 shipped its hero as a LONE element in a
 *      void (s2.hero = 1el/0tx) while a sibling piece (s2.throughline,
 *      16el/4tx) carried the any-diegetic floor. The hero is the scene's main
 *      visual — a sibling cannot carry it. Scenes without a ".hero" piece are
 *      governed by clause (a) exactly as before.
 *   b. DOM DEPTH — per scene, max element nesting depth ≥7. (Reference 7–11;
 *      spike flat 5.)
 *   c. ATMOSPHERE VARIETY — video-level: ≥4 distinct gradient signatures
 *      across absolutely-positioned decorative layers, AND no single signature
 *      verbatim in >2 scenes. (Spike: one radial-gradient string in 4/5
 *      scenes; reference: 8 distinct.)
 *   d. IMG-SRC WHITELIST — every rendered <img>/<Img> src must match
 *      ^(https?:|data:|/). (The spike shipped raw asset ids like "site_img_0"
 *      that render as blank rectangles.)
 *
 * How: the assembled Composition source (the Section{N} exports) is bundled
 * with esbuild + evaluated + renderToStaticMarkup'd per Section — the same
 * compile+eval+SSR steps ssr-render.ts / measure-scene.ts run, so "measured
 * here" == "what the preview/MP4 paints" — then the HTML is walked with a
 * small dependency-free tag-stack parser (no jsdom/cheerio). The Piece shim
 * emits `data-piece` / `data-kind` on a display:contents wrapper
 * (build-wrapper.ts PIECE_SHIM_SOURCE, assemble.ts pieceAttrs), which is what
 * clause (a) keys on.
 *
 * Findings are returned, never thrown; every clause is BLOCKING (that is the
 * point — thin output must stop the line, not advise). A scene that cannot be
 * SSR'd at all fails closed with a measure-error finding, mirroring
 * measure-scene.ts.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import React from "react";
import * as esbuild from "esbuild";
import { sandboxedRequire } from "./code-guard";
import {
  IMG_SHIM_SOURCE,
  PIECE_SHIM_SOURCE,
  VIDEO_SHIM_SOURCE,
  LOTTIE_SHIM_SOURCE,
  BRAND_CHROME_SOURCE,
} from "./build-wrapper";

// ─────────────────────────────────────────────────────────────────────────────
// Gate constants — chosen from the audit's measured separation, each with a
// documented margin between the passing reference and the failing spike.
// ─────────────────────────────────────────────────────────────────────────────

/** (a) A real diegetic mock has an INTERIOR — rows, cells, chips, labels.
 *  Floor 15 element descendants: reference per-scene best pieces measured
 *  87/36/45/36/15; the spike's best measured 13. 15 admits the reference's
 *  leanest scene exactly while the spike's richest piece (13) still fails. */
export const DIEGETIC_MIN_ELEMENTS = 15;
/** (a) …and it says things: ≥4 non-empty interior text nodes. Reference best
 *  pieces: 30/7/7/7/5 text nodes; spike best: 3. */
export const DIEGETIC_MIN_TEXT_NODES = 4;
/** (a2) A HERO must itself have an interior. Calibration (measured via the
 *  same SSR path, 2026-07-16): passing heroes — Duolingo GLM reference
 *  (01KWTMK9WXRZNF7X553R9AN63M) s3.hero = 34el/2tx; acceptance v5
 *  (CAST_SPIKE_A5_GLM52) s0/s1/s3/s4 heroes = 83/5, 57/9, 122/16, 93/18.
 *  Failing hero — v5 s2.hero = 1el/0tx (the lone-element-in-a-void leak).
 *  Element floor 15 (same bar as clause a): weakest passing hero measures 34
 *  (2.3x margin); the failing hero measures 1 (15x under). */
export const HERO_MIN_ELEMENTS = 15;
/** (a2) …and says at least ONE thing. The reference hero is an illustrative
 *  tableau with only 2 interior text nodes, so the hero text floor is 1, not
 *  clause (a)'s 4 — heroes may be image-like, but a 0-text hero paired with a
 *  hollow interior is the v5 failure shape (measured 0 on the failing hero,
 *  ≥2 on every passing one). */
export const HERO_MIN_TEXT_NODES = 1;
/** (b) Depth floor 7: reference scenes measure 7–11 deep; the spike is flat
 *  at 5 everywhere. Depth = element nesting on the SSR'd Section markup (a
 *  root element is depth 1), including display:contents piece wrappers —
 *  they are real DOM nodes and the same convention for both builds. */
export const DEPTH_FLOOR = 7;
/** (c) At least 4 distinct gradient signatures across the video's
 *  absolutely-positioned decorative layers. Reference: 8 distinct; spike: 1
 *  dominant signature. */
export const MIN_GRADIENT_SIGNATURES = 4;
/** (c) No single signature verbatim in more than 2 scenes (a shared motif
 *  glow may echo once; wallpapering 4/5 scenes with one radial-gradient — the
 *  spike — is monotony). */
export const MAX_SCENES_PER_SIGNATURE = 2;
/** (d) A rendered <img> src must be a real fetchable reference. */
export const IMG_SRC_WHITELIST = /^(https?:|data:|\/)/;

export type DensityKind =
  | "thin-diegetic"
  | "thin-hero"
  | "shallow-dom"
  | "atmosphere-monotony"
  | "img-src"
  | "density-measure-error";

export interface DensityFinding {
  kind: DensityKind;
  /** Scene index; -1 for video-level findings (atmosphere variety). */
  scene: number;
  /** All density clauses block — thin is a defect, not an advisory. */
  blocking: boolean;
  /** Humanized, with the measured numbers. */
  detail: string;
  /** Concrete instruction an LLM regen/repair pass can act on. */
  repairInstruction: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// SSR harness — self-contained mirror of the ssr-render/measure-scene bundle+
// eval path, but taking the composition SOURCE (a string) instead of a genDir:
// the gates run on the assembled code BEFORE it is committed to disk. Shims
// are written beside it in a temp dir so the generated `./Img` / `./Piece` /
// `./BrandChrome` / `./Video` / `./Lottie` imports resolve exactly as they do
// in a real genDir (build-wrapper.writeGeneratedFiles writes the same five).
// ─────────────────────────────────────────────────────────────────────────────

// Same externals ssr-render.ts / measure-scene.ts use — peer deps resolve at
// runtime via require; only the local TSX bundles.
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

// eval("require") is the real require inside the Next server bundle (the
// app-router static-analysis bypass); under the ESM test runner it throws, so
// fall back to createRequire anchored at the project root — same node_modules.
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

const SHIM_FILES: Record<string, string> = {
  "Img.tsx": IMG_SHIM_SOURCE,
  "Piece.tsx": PIECE_SHIM_SOURCE,
  "Video.tsx": VIDEO_SHIM_SOURCE,
  "Lottie.tsx": LOTTIE_SHIM_SOURCE,
  "BrandChrome.tsx": BRAND_CHROME_SOURCE,
};

export interface SectionRender {
  scene: number;
  /** Static markup of the Section, or null when it could not be rendered. */
  html: string | null;
  error?: string;
}

/**
 * Bundle + eval `code` (an assembled Composition.tsx source) and SSR every
 * `Section{N}` export to static markup. `script` is passed as the Section
 * prop — the real script.json for a real build; synthetic fixtures that don't
 * read the prop may omit it. Synchronous by design (esbuild.buildSync +
 * renderToStaticMarkup) so assessDensity stays a plain function.
 */
export const renderSectionsForAnalysis = (
  code: string,
  script?: unknown,
): SectionRender[] => {
  // Scene count from the source's Section exports — the gate must not trust
  // the script (a build that dropped a Section is exactly what fails closed).
  const sectionIdxs = new Set<number>();
  for (const m of code.matchAll(/export\s+const\s+Section(\d+)\b/g)) {
    sectionIdxs.add(Number(m[1]));
  }
  const fromScript = Array.isArray((script as { scenes?: unknown[] } | undefined)?.scenes)
    ? (script as { scenes: unknown[] }).scenes.length
    : 0;
  const sceneCount = Math.max(
    fromScript,
    sectionIdxs.size ? Math.max(...sectionIdxs) + 1 : 0,
  );
  if (sceneCount === 0) {
    return [{ scene: 0, html: null, error: "no Section{N} exports found in code" }];
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rb-density-"));
  let mod: Record<string, unknown>;
  try {
    fs.writeFileSync(path.join(tmp, "Composition.tsx"), code, "utf8");
    for (const [file, src] of Object.entries(SHIM_FILES)) {
      fs.writeFileSync(path.join(tmp, file), src, "utf8");
    }
    const result = esbuild.buildSync({
      entryPoints: [path.join(tmp, "Composition.tsx")],
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
      sandboxedRequire(nodeRequire),
    );
    mod = moduleObj.exports;
  } catch (err) {
    const error = `compile/eval: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
    return Array.from({ length: sceneCount }, (_, i) => ({ scene: i, html: null, error }));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const out: SectionRender[] = [];
  for (let i = 0; i < sceneCount; i++) {
    const Section = [`Section${i}`, `Scene${i}Slide`, `Scene${i}`, `Slide${i}`]
      .map((n) => mod[n])
      .find((f) => typeof f === "function") as
      | React.ComponentType<{ script: unknown }>
      | undefined;
    if (!Section) {
      out.push({ scene: i, html: null, error: `no Section${i} export` });
      continue;
    }
    try {
      out.push({ scene: i, html: renderToStaticMarkup(React.createElement(Section, { script })) });
    } catch (err) {
      out.push({
        scene: i,
        html: null,
        error: `render: ${err instanceof Error ? err.message.slice(0, 140) : String(err)}`,
      });
    }
  }
  return out;
};

// ─────────────────────────────────────────────────────────────────────────────
// HTML structure parser — a small tag-stack walk over renderToStaticMarkup
// output. No dependencies: static markup is machine-emitted (double-quoted
// attributes, self-closed voids), so a positional parser is exact here.
// ─────────────────────────────────────────────────────────────────────────────

export interface HtmlNode {
  tag: string;
  attrs: Record<string, string>;
  /** Element children + non-empty-or-not raw text children (strings). */
  children: (HtmlNode | string)[];
}

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);
const RAW_TEXT_TAGS = new Set(["script", "style"]);

const decodeEntities = (s: string): string =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** Parse static markup into a forest of HtmlNodes (text nodes as strings). */
export const parseHtmlStructure = (html: string): HtmlNode[] => {
  const roots: HtmlNode[] = [];
  const stack: HtmlNode[] = [];
  const append = (n: HtmlNode | string): void => {
    (stack.length ? stack[stack.length - 1].children : roots).push(n);
  };
  let i = 0;
  while (i < html.length) {
    if (html[i] === "<") {
      // comment
      if (html.startsWith("<!--", i)) {
        const end = html.indexOf("-->", i + 4);
        i = end === -1 ? html.length : end + 3;
        continue;
      }
      // closing tag
      if (html[i + 1] === "/") {
        const end = html.indexOf(">", i);
        if (end === -1) break;
        const name = html.slice(i + 2, end).trim().toLowerCase();
        for (let s = stack.length - 1; s >= 0; s--) {
          if (stack[s].tag === name) {
            stack.length = s;
            break;
          }
        }
        i = end + 1;
        continue;
      }
      // opening tag
      const nameMatch = /^<([a-zA-Z][a-zA-Z0-9:_-]*)/.exec(html.slice(i));
      if (!nameMatch) {
        // stray "<" in text — consume as text
        append("<");
        i++;
        continue;
      }
      const tag = nameMatch[1].toLowerCase();
      let j = i + nameMatch[0].length;
      const attrs: Record<string, string> = {};
      let selfClosed = false;
      while (j < html.length) {
        while (j < html.length && /\s/.test(html[j])) j++;
        if (html[j] === ">") {
          j++;
          break;
        }
        if (html[j] === "/" && html[j + 1] === ">") {
          selfClosed = true;
          j += 2;
          break;
        }
        const am = /^([^\s=/>]+)/.exec(html.slice(j));
        if (!am) {
          j++;
          continue;
        }
        const name = am[1];
        j += am[0].length;
        let value = "";
        if (html[j] === "=") {
          j++;
          const q = html[j];
          if (q === '"' || q === "'") {
            const end = html.indexOf(q, j + 1);
            value = html.slice(j + 1, end === -1 ? html.length : end);
            j = end === -1 ? html.length : end + 1;
          } else {
            const vm = /^[^\s>]*/.exec(html.slice(j));
            value = vm ? vm[0] : "";
            j += value.length;
          }
        }
        attrs[name.toLowerCase()] = decodeEntities(value);
      }
      const el: HtmlNode = { tag, attrs, children: [] };
      append(el);
      if (!selfClosed && !VOID_TAGS.has(tag)) {
        if (RAW_TEXT_TAGS.has(tag)) {
          // raw text content — capture verbatim to the closing tag
          const closeRx = new RegExp(`</${tag}\\s*>`, "i");
          const rest = html.slice(j);
          const m = closeRx.exec(rest);
          const end = m ? j + m.index : html.length;
          const text = html.slice(j, end);
          if (text) el.children.push(text);
          j = m ? end + m[0].length : html.length;
        } else {
          stack.push(el);
        }
      }
      i = j;
      continue;
    }
    const next = html.indexOf("<", i);
    const end = next === -1 ? html.length : next;
    const text = html.slice(i, end);
    if (text) append(decodeEntities(text));
    i = end;
  }
  return roots;
};

// ── tree measurements ────────────────────────────────────────────────────────

const isElement = (n: HtmlNode | string): n is HtmlNode => typeof n !== "string";

/** Number of ELEMENT descendants under `el` (excluding `el` itself). */
export const countElementDescendants = (el: HtmlNode): number => {
  let n = 0;
  for (const c of el.children) {
    if (isElement(c)) n += 1 + countElementDescendants(c);
  }
  return n;
};

/** Number of non-empty (after trim) TEXT nodes in `el`'s subtree. */
export const countTextNodes = (el: HtmlNode): number => {
  let n = 0;
  for (const c of el.children) {
    if (isElement(c)) n += countTextNodes(c);
    else if (c.trim().length > 0) n++;
  }
  return n;
};

/** Max element nesting depth of a forest (a root element = depth 1). */
export const maxDomDepth = (roots: (HtmlNode | string)[]): number => {
  let deepest = 0;
  for (const r of roots) {
    if (!isElement(r)) continue;
    const d = 1 + maxDomDepth(r.children);
    if (d > deepest) deepest = d;
  }
  return deepest;
};

/** Depth-first walk over every element in a forest. */
export const walkElements = (
  roots: (HtmlNode | string)[],
  visit: (el: HtmlNode) => void,
): void => {
  for (const r of roots) {
    if (!isElement(r)) continue;
    visit(r);
    walkElements(r.children, visit);
  }
};

// ── gradient signatures (clause c) ───────────────────────────────────────────

const GRADIENT_OPEN_RX = /(?:repeating-)?(?:linear|radial|conic)-gradient\(/gi;

/** Every balanced `…-gradient(…)` substring in a CSS value, whitespace- and
 *  case-normalized so "verbatim" comparison is byte-stable across scenes. */
export const extractGradients = (cssValue: string): string[] => {
  const out: string[] = [];
  GRADIENT_OPEN_RX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = GRADIENT_OPEN_RX.exec(cssValue))) {
    let depth = 1;
    let j = m.index + m[0].length;
    while (j < cssValue.length && depth > 0) {
      if (cssValue[j] === "(") depth++;
      else if (cssValue[j] === ")") depth--;
      j++;
    }
    if (depth === 0) {
      out.push(cssValue.slice(m.index, j).replace(/\s+/g, "").toLowerCase());
      GRADIENT_OPEN_RX.lastIndex = j;
    }
  }
  return out;
};

const isAbsolutelyPositioned = (el: HtmlNode): boolean =>
  /(?:^|;)\s*position\s*:\s*(?:absolute|fixed)\b/i.test(el.attrs.style || "");

/**
 * Gradient signatures of a scene's absolutely-positioned DECORATIVE layers —
 * atmosphere washes, glows, vignettes. Decorative = the element carries a
 * gradient and no text of its own (a gradient-filled CTA/label is content,
 * not atmosphere). Returns the DISTINCT signatures for the scene.
 */
export const gradientSignatures = (roots: (HtmlNode | string)[]): Set<string> => {
  const sigs = new Set<string>();
  walkElements(roots, (el) => {
    if (!isAbsolutelyPositioned(el)) return;
    const hasOwnText = el.children.some((c) => !isElement(c) && c.trim().length > 0);
    if (hasOwnText) return;
    for (const g of extractGradients(el.attrs.style || "")) sigs.add(g);
  });
  return sigs;
};

// ── piece stats (clause a) ───────────────────────────────────────────────────

export interface PieceStats {
  id: string;
  kind: string;
  elements: number;
  textNodes: number;
}

/** Per-piece interior stats — every [data-piece] wrapper in the forest. */
export const pieceStats = (roots: (HtmlNode | string)[]): PieceStats[] => {
  const out: PieceStats[] = [];
  walkElements(roots, (el) => {
    if (!("data-piece" in el.attrs)) return;
    out.push({
      id: el.attrs["data-piece"] || "",
      kind: el.attrs["data-kind"] || "",
      elements: countElementDescendants(el),
      textNodes: countTextNodes(el),
    });
  });
  return out;
};

// ── img srcs (clause d) ──────────────────────────────────────────────────────

/** All <img> srcs in the forest (missing src reported as ""). */
export const imgSrcs = (roots: (HtmlNode | string)[]): string[] => {
  const out: string[] = [];
  walkElements(roots, (el) => {
    if (el.tag === "img") out.push(el.attrs.src ?? "");
  });
  return out;
};

// ─────────────────────────────────────────────────────────────────────────────
// The gates. Pure per-scene / per-video assessments over the parsed forests —
// exported individually for tests; assessDensity composes them.
// ─────────────────────────────────────────────────────────────────────────────

/** (a) Diegetic-interior floor + (a2) per-hero floor for one scene. */
export const assessDiegeticInterior = (
  roots: (HtmlNode | string)[],
  scene: number,
): DensityFinding[] => {
  const findings: DensityFinding[] = [];
  const pieces = pieceStats(roots);
  const diegetics = pieces.filter((p) => p.kind === "diegetic");
  const passing = diegetics.find(
    (p) => p.elements >= DIEGETIC_MIN_ELEMENTS && p.textNodes >= DIEGETIC_MIN_TEXT_NODES,
  );
  if (!passing) {
    const best = diegetics
      .slice()
      .sort((a, b) => b.elements + b.textNodes * 2 - (a.elements + a.textNodes * 2))[0];
    const measured = best
      ? `richest diegetic piece "${best.id}" has ${best.elements} element descendants and ` +
        `${best.textNodes} non-empty text nodes`
      : `no data-kind="diegetic" piece at all`;
    findings.push({
      kind: "thin-diegetic",
      scene,
      blocking: true,
      detail:
        `scene ${scene}: ${measured} — floor is ≥${DIEGETIC_MIN_ELEMENTS} elements AND ` +
        `≥${DIEGETIC_MIN_TEXT_NODES} text nodes in at least one diegetic piece. ` +
        `A real product mock has an interior; this one is a hollow shell.`,
      repairInstruction:
        `Rebuild the scene's main diegetic mock with a real INTERIOR: give the product UI ` +
        `concrete rows, cells, chips, avatars, labels, values and micro-copy (at least ` +
        `${DIEGETIC_MIN_ELEMENTS} nested elements and ${DIEGETIC_MIN_TEXT_NODES} distinct visible ` +
        `text strings inside the mock — e.g. a toolbar with named buttons, 3–4 list rows each ` +
        `with a title, meta label and status chip, a sidebar with named items). Do not add ` +
        `empty decorative boxes; every added element should be plausible product content.`,
    });
  }
  // (a2) Per-HERO floor — the hero must ITSELF meet the floor; a rich sibling
  // piece satisfying clause (a) cannot carry it (the v5 scene-2 leak: s2.hero
  // shipped as one element in a void while s2.throughline carried the scene).
  for (const hero of pieces.filter((p) => p.id.endsWith(".hero"))) {
    if (hero.elements >= HERO_MIN_ELEMENTS && hero.textNodes >= HERO_MIN_TEXT_NODES) continue;
    findings.push({
      kind: "thin-hero",
      scene,
      blocking: true,
      detail:
        `scene ${scene}: hero piece "${hero.id}" has ${hero.elements} element descendants and ` +
        `${hero.textNodes} non-empty text nodes — the HERO floor is ≥${HERO_MIN_ELEMENTS} elements ` +
        `AND ≥${HERO_MIN_TEXT_NODES} text node(s) in the hero ITSELF. A sibling piece cannot ` +
        `carry the hero: the hero is the scene's main visual, and this one is a hollow prop.`,
      repairInstruction:
        `Rebuild "${hero.id}" as the scene's real main visual with its own INTERIOR: a concrete ` +
        `product artifact (screen, dashboard, device mock, chart, annotated tableau) containing ` +
        `at least ${HERO_MIN_ELEMENTS} nested elements and at least ${HERO_MIN_TEXT_NODES} visible ` +
        `text string(s) — rows, cells, chips, labels, values that belong to the product. Do not ` +
        `delegate the scene's substance to sibling pieces; the hero itself must hold it.`,
    });
  }
  return findings;
};

/** (b) DOM depth floor for one scene. */
export const assessDomDepth = (
  roots: (HtmlNode | string)[],
  scene: number,
): DensityFinding[] => {
  const depth = maxDomDepth(roots);
  if (depth >= DEPTH_FLOOR) return [];
  return [
    {
      kind: "shallow-dom",
      scene,
      blocking: true,
      detail:
        `scene ${scene}: max element nesting depth is ${depth} — floor is ≥${DEPTH_FLOOR}. ` +
        `Rich scenes nest structure (frame → panel → row → cell → label); a flat scene ` +
        `reads as a thin poster.`,
      repairInstruction:
        `Add real hierarchical structure to the scene's main visual: wrap content in a framed ` +
        `container (window/browser/card chrome), give it internal panels, and give panels rows ` +
        `with labeled cells so the deepest content sits at least ${DEPTH_FLOOR} elements deep. ` +
        `Nest by meaning (chrome → surface → section → row → cell → text), never empty ` +
        `wrapper-divs for their own sake.`,
    },
  ];
};

/** (c) Atmosphere variety across the whole video (scene -1 = video-level). */
export const assessAtmosphereVariety = (
  scenes: { scene: number; roots: (HtmlNode | string)[] }[],
): DensityFinding[] => {
  const bySig = new Map<string, number[]>();
  for (const { scene, roots } of scenes) {
    for (const sig of gradientSignatures(roots)) {
      const arr = bySig.get(sig) ?? [];
      arr.push(scene);
      bySig.set(sig, arr);
    }
  }
  const findings: DensityFinding[] = [];
  const distinct = bySig.size;
  if (distinct < MIN_GRADIENT_SIGNATURES) {
    findings.push({
      kind: "atmosphere-monotony",
      scene: -1,
      blocking: true,
      detail:
        `video has only ${distinct} distinct atmosphere gradient signature(s) across ` +
        `${scenes.length} scenes — floor is ≥${MIN_GRADIENT_SIGNATURES}. Every scene is ` +
        `wearing the same (or no) atmosphere.`,
      repairInstruction:
        `Give each scene its own atmospheric treatment: vary the decorative background layers ` +
        `per scene (different gradient geometry — a corner glow here, a horizon wash there, a ` +
        `vignette elsewhere — different stops, angles and radii), so the video carries at least ` +
        `${MIN_GRADIENT_SIGNATURES} distinct absolutely-positioned gradient layers overall. ` +
        `Keep them on-palette; change the SHAPE of the light, not the brand colors.`,
    });
  }
  const repeated = [...bySig.entries()].filter(
    ([, scenesOf]) => new Set(scenesOf).size > MAX_SCENES_PER_SIGNATURE,
  );
  for (const [sig, scenesOf] of repeated) {
    const uniq = [...new Set(scenesOf)].sort((a, b) => a - b);
    findings.push({
      kind: "atmosphere-monotony",
      scene: -1,
      blocking: true,
      detail:
        `one gradient signature repeats VERBATIM in ${uniq.length} scenes (${uniq.join(", ")}) — ` +
        `max is ${MAX_SCENES_PER_SIGNATURE}. Signature: ${sig.slice(0, 120)}${sig.length > 120 ? "…" : ""}`,
      repairInstruction:
        `The same decorative gradient is copy-pasted across scenes ${uniq.join(", ")}. Keep it in ` +
        `at most ${MAX_SCENES_PER_SIGNATURE}; in the others, replace it with a DIFFERENT atmosphere ` +
        `layer (change the gradient type, origin, angle, stop positions or extent — not just the ` +
        `alpha) so each scene has its own light.`,
    });
  }
  return findings;
};

/** (d) img-src whitelist for one scene. */
export const assessImgSrcs = (
  roots: (HtmlNode | string)[],
  scene: number,
): DensityFinding[] => {
  const bad = imgSrcs(roots).filter((src) => !IMG_SRC_WHITELIST.test(src));
  if (bad.length === 0) return [];
  const shown = [...new Set(bad)].map((s) => (s === "" ? "(empty)" : `"${s.slice(0, 60)}"`));
  return [
    {
      kind: "img-src",
      scene,
      blocking: true,
      detail:
        `scene ${scene}: ${bad.length} <img> src(s) are not fetchable URLs — ${shown.join(", ")}. ` +
        `Anything not matching ${IMG_SRC_WHITELIST} renders as a blank rectangle.`,
      repairInstruction:
        `Replace each invalid <Img> src with a real reference: use the crawled asset URLs from ` +
        `script.assets.images (https://…), an inline data: URI, or a root-relative /path. Raw ` +
        `asset ids like "site_img_0" are NOT resolvable at render time — if no real image URL ` +
        `exists for the slot, build the visual as styled DOM (a CSS mock) instead of an <Img>.`,
    },
  ];
};

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run all density gates against an assembled Composition source. SSRs every
 * Section, parses the markup, and returns every finding (all blocking). A
 * scene that fails to SSR fails closed with a density-measure-error finding.
 */
export const assessDensity = (code: string, script?: unknown): DensityFinding[] => {
  const renders = renderSectionsForAnalysis(code, script);
  const findings: DensityFinding[] = [];
  const parsed: { scene: number; roots: (HtmlNode | string)[] }[] = [];
  for (const r of renders) {
    if (r.html == null) {
      findings.push({
        kind: "density-measure-error",
        scene: r.scene,
        blocking: true,
        detail: `scene ${r.scene} could not be SSR'd for density analysis: ${r.error}`,
        repairInstruction:
          `Fix the scene so it server-renders: the Section${r.scene} component must compile and ` +
          `renderToStaticMarkup without throwing (${r.error}).`,
      });
      continue;
    }
    parsed.push({ scene: r.scene, roots: parseHtmlStructure(r.html) });
  }
  for (const { scene, roots } of parsed) {
    findings.push(...assessDiegeticInterior(roots, scene));
    findings.push(...assessDomDepth(roots, scene));
    findings.push(...assessImgSrcs(roots, scene));
  }
  findings.push(...assessAtmosphereVariety(parsed));
  return findings;
};
