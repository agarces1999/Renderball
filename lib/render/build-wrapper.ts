/**
 * ============================================================================
 * WRAPPER MODULE — the ONLY video-aware code path in Renderball.
 * ============================================================================
 *
 * The Design Agent and Choreography Agent produce pure React + CSS — they
 * have no notion of video, frames, or Remotion. This module bridges that
 * output to the Remotion renderer by emitting an `index.tsx` that:
 *
 *   1. Imports each Section{N} component the agents emitted
 *   2. Wraps each in a Remotion <Sequence> with the right start/duration
 *   3. Registers a top-level <Composition> with the right canvas dimensions
 *
 * RULE: do NOT reference this module from prompts, agent inputs, or
 * agent-generated code. If you find yourself thinking "the agent could
 * just import Sequence directly," you're violating the axiom that
 * agents don't know about video.
 *
 * Schema → renderer mapping:
 *   start_seconds / end_seconds (Script) → from / durationInFrames (Sequence)
 *   config.duration_seconds              → composition.durationInFrames
 *   FPS is fixed at 30 here              → composition.fps
 */

import { promises as fs } from "fs";
import path from "path";
import type { Script } from "../../src/schema";
import { reportUnsafeComposition } from "./code-guard";
import { persistGenDir } from "./gen-store";
import { throughlineAnchorFor } from "../agents/choreograph";
import { selectThroughlineAnchor } from "../agents/throughline-anchor";
import type { Aspect } from "../agents/layout-composer";

/** Frames-per-second for capture. Fixed at the rendering boundary. */
export const RENDER_FPS = 30 as const;

/**
 * Render-quality options passed to @remotion/renderer.renderMedia.
 * Tuned for 1920×1080 H.264 visually-lossless output.
 *
 * - crf: 18 is the "visually lossless" sweet spot for x264 (lower = better,
 *   range 0-51, default 23). 18 looks essentially identical to source at
 *   ~5x larger file size than default. Worth it for brand-quality output.
 * - videoBitrate: explicit upper bound. CRF is variable-bitrate; this caps
 *   the ceiling so single-frame complexity doesn't blow up file size.
 * - jpegQuality: intermediate-frame quality when imageFormat is "jpeg".
 *   95 is barely-perceptible loss; 100 doubles disk I/O for no visible win.
 */
export const RENDER_QUALITY = {
  codec: "h264" as const,
  imageFormat: "jpeg" as const,
  jpegQuality: 95,
  // CRF 18 is "visually lossless" for x264; bitrate floats. Remotion
  // rejects both crf+videoBitrate, so we pick CRF — quality-locked, file
  // size varies with scene complexity.
  crf: 18,
} as const;

// Section start/end time + total length — file-private helpers used by
// totalFramesForScript and buildIndexTsx below. No external consumers,
// so they don't need to be exported (kept that way during the
// 2026-05-28 dead-code cleanup).
const sceneStartSeconds = (
  s: Script["scenes"][number] | undefined,
): number | undefined => {
  if (!s) return undefined;
  if (typeof s.start_seconds === "number") return s.start_seconds;
  if (typeof s.start_frame === "number") return s.start_frame / RENDER_FPS;
  return undefined;
};

const sceneEndSeconds = (
  s: Script["scenes"][number] | undefined,
): number | undefined => {
  if (!s) return undefined;
  if (typeof s.end_seconds === "number") return s.end_seconds;
  if (typeof s.end_frame === "number") return s.end_frame / RENDER_FPS;
  return undefined;
};

const totalSecondsForScript = (script: Script): number => {
  const last = script.scenes[script.scenes.length - 1];
  return (
    sceneEndSeconds(last) ?? script.config.duration_seconds ?? 0
  );
};

/** Total frames for the renderer (seconds × FPS, rounded). */
export const totalFramesForScript = (script: Script): number =>
  Math.round(totalSecondsForScript(script) * RENDER_FPS);

/** Composition canvas dimensions derived from script.config. */
export const dimensionsForScript = (
  script: Script,
): { width: number; height: number } => {
  const is4k = script.config.resolution === "4k";
  switch (script.config.aspect_ratio) {
    case "16:9":
      return is4k
        ? { width: 3840, height: 2160 }
        : { width: 1920, height: 1080 };
    case "9:16":
      return is4k
        ? { width: 2160, height: 3840 }
        : { width: 1080, height: 1920 };
    case "1:1":
      return is4k
        ? { width: 2160, height: 2160 }
        : { width: 1080, height: 1080 };
  }
};

/**
 * Generate the index.tsx that registers the Remotion composition.
 * The emitted file imports the agent-generated Composition.tsx and
 * wraps each Section{N} in a Sequence based on the script's timeline.
 *
 * Resilient to naming drift: tries Section{i} / Scene{i}Slide /
 * Scene{i} / Slide{i} in that order to find the per-section component.
 */
/** Scene-transition overlap: consecutive scenes crossfade over this many
 *  frames instead of hard-cutting. The OUTGOING scene's Sequence is extended
 *  by this much (its ambient keeps breathing, plus a subtle cinematic push);
 *  the INCOMING scene mounts on top and fades in. Deterministic — pure frame
 *  math in the wrapper, zero tokens, applies identically in the Player preview
 *  and the MP4 (same generated index.tsx). */
export const TRANSITION_FRAMES = Math.round(0.4 * RENDER_FPS);

export const buildIndexTsx = (script: Script): string => {
  const dims = dimensionsForScript(script);
  const totalFrames = totalFramesForScript(script);
  const lastScene = script.scenes.length - 1;
  // The match-cut camera push is centered ON THE MOTIF, so its origin must
  // follow the motif's actual anchor — which cast-build now chooses per VIDEO
  // (throughline-anchor.ts), not per aspect. Recomputed here from the same pure
  // function over the same scenes rather than threaded through every caller;
  // a script with no throughline keeps the historical per-aspect constant.
  const aspect = (script.config?.aspect_ratio ?? "16:9") as Aspect;
  const anchor = (script.narrative?.throughline?.trim() ?? "").length > 0
    ? selectThroughlineAnchor(
        script.scenes.map((s) => ({
          register: (s as { register?: string }).register,
          content: s.content as Record<string, unknown> | undefined,
          composition: (s as { composition?: never }).composition,
        })),
        aspect,
      ).anchor
    : throughlineAnchorFor(aspect);
  const pushOrigin = `${anchor.left}px ${anchor.top}px`;

  const sceneSequences = script.scenes
    .map((scene, i) => {
      const startFrame = Math.round(
        (sceneStartSeconds(scene) ?? 0) * RENDER_FPS,
      );
      const endFrame = Math.round(
        (sceneEndSeconds(scene) ?? 0) * RENDER_FPS,
      );
      const duration = endFrame - startFrame;
      // Every scene except the last plays TRANSITION_FRAMES into its successor
      // (the crossfade window). JSX order stacks the incoming scene on top.
      const mounted = i < lastScene ? duration + TRANSITION_FRAMES : duration;
      return `        {(() => {
          const C = pickSection(Sections, ${i});
          return C ? (
            <Sequence from={${startFrame}} durationInFrames={${mounted}} layout="none">
              <SceneTransition scripted={${duration}} isFirst={${i === 0}} isLast={${i === lastScene}}>
                <SectionClock>
                  <C script={script} />
                </SectionClock>
              </SceneTransition>
            </Sequence>
          ) : null;
        })()}`;
    })
    .join("\n");

  return `// Auto-generated wrapper. Do not edit.
// The agents' Composition.tsx is pure React + CSS. This file wraps each
// per-section component in a Remotion <Sequence> for the capture layer.
import React from "react";
import {
  Composition,
  registerRoot,
  Sequence,
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  getRemotionEnvironment,
} from "remotion";
import * as Sections from "./Composition";
import script from "./script.json";

// Resolve the section component by index, tolerating naming-style drift.
function pickSection(mod: any, i: number): React.FC<any> | undefined {
  const candidates = [
    \`Section\${i}\`,
    \`Scene\${i}Slide\`,
    \`Scene\${i}\`,
    \`Slide\${i}\`,
  ];
  for (const name of candidates) {
    if (typeof mod[name] === "function") return mod[name];
  }
  return undefined;
}

// ── Deterministic CSS-animation clock (render path only) ────────────────────
// The agents' sections animate with plain CSS (@keyframes + animation), which
// runs on the WALL clock. The renderer captures frames on the FRAME clock —
// Chromium's animation timeline does not advance in lockstep with captured
// frames, so animations with longer delays (empirically >= ~2.3s) never
// reached their active phase in the MP4 while the live preview played them:
// approved content silently vanished from the export.
//
// Fix: when (and ONLY when) Remotion is rendering, pin every Web Animations
// API animation in the section's subtree to the scene-relative Remotion time.
// WAAPI currentTime includes the delay phase, so setting it reproduces
// wall-clock playback exactly: delays elapse, fill-forwards holds, infinite
// loops cycle. getAnimations() re-runs every frame, so animations created
// after first paint (elements mounting mid-scene) are captured too; pause()
// also keeps finished non-fill animations alive in getAnimations(). In the
// preview / Studio (isRendering false) the effect is inert and native
// wall-clock playback is untouched.
const SectionClock: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // useCurrentFrame inside a <Sequence> is scene-relative — frame 0 is the
  // scene's first frame, matching when the section mounts and its CSS
  // animations start in wall-clock playback.
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { isRendering } = getRemotionEnvironment();
  const ref = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    if (!isRendering) return;
    const container = ref.current;
    if (!container || typeof container.getAnimations !== "function") return;
    const timeMs = (frame / fps) * 1000;
    for (const anim of container.getAnimations({ subtree: true })) {
      try {
        anim.pause();
        anim.currentTime = timeMs;
      } catch {
        // A detached or canceled animation can throw on seek — skip it.
      }
    }
  }, [frame, fps, isRendering]);
  // display:contents keeps the wrapper out of layout — absolutely-positioned
  // sections still resolve against the composition's AbsoluteFill.
  return (
    <div ref={ref} style={{ display: "contents" }}>
      {children}
    </div>
  );
};

// ── Deterministic scene transitions ──────────────────────────────────────────
// Scenes used to hard-cut. Each non-last scene's Sequence is extended by
// TRANSITION_FRAMES so it keeps playing (ambient loops breathing, plus a subtle
// cinematic push) while the NEXT scene — mounted on top by JSX order — fades in
// over the same window. The first scene fades up from the black composition
// base for a filmic open. Pure frame math; works identically in the Player
// preview and the frame-clocked render.
const TRANSITION_FRAMES = ${TRANSITION_FRAMES};
// The outgoing push scales toward the throughline motif's pinned anchor — the
// one object that survives every cut (its entrance only plays in scene 0) —
// so each cut reads as the camera pushing toward the surviving object while
// everything else exits and the next scene assembles around it.
const PUSH_ORIGIN = "${pushOrigin}";
const SceneTransition: React.FC<{
  scripted: number;
  isFirst: boolean;
  isLast: boolean;
  children: React.ReactNode;
}> = ({ scripted, isFirst, isLast, children }) => {
  const frame = useCurrentFrame(); // scene-relative inside the Sequence
  // data-rb-film gates the FILM-ONLY choreography (element exits): the
  // measurement harness and the per-scene editor iframe never mount this
  // wrapper, so they see the settled mid-scene frame; the composed Player
  // preview and the MP4 do, so elements leave the frame before each cut.
  const style: React.CSSProperties = { position: "absolute", inset: 0, transformOrigin: PUSH_ORIGIN };
  // Fade IN over the first window: crossfade over the extended predecessor
  // (or from black for the opening scene).
  const fadeIn = isFirst ? Math.round(TRANSITION_FRAMES * 1.5) : TRANSITION_FRAMES;
  if (frame < fadeIn) style.opacity = Math.max(0, Math.min(1, frame / fadeIn));
  // Outgoing push: past the scripted end (the overlap window), scale up gently
  // beneath the incoming scene for cut momentum, centered on the motif anchor.
  if (!isLast && frame > scripted) {
    const p = Math.min(1, (frame - scripted) / TRANSITION_FRAMES);
    style.transform = \`scale(\${1 + 0.02 * p})\`;
  }
  return <div data-rb-film="" style={style}>{children}</div>;
};

const Composed: React.FC<{ script: typeof script }> = ({ script }) => (
  <AbsoluteFill style={{ backgroundColor: "#000" }}>
${sceneSequences}
  </AbsoluteFill>
);

const Root = () => (
  <Composition
    id="Generated"
    component={Composed as React.FC<{ script: typeof script }>}
    durationInFrames={${totalFrames}}
    fps={${RENDER_FPS}}
    width={${dims.width}}
    height={${dims.height}}
    defaultProps={{ script }}
  />
);

registerRoot(Root);
`;
};

/**
 * The sibling Img.tsx file. Dropped next to Composition.tsx so the
 * agent's \`import { Img } from "./Img"\` resolves locally — keeps the
 * "remotion" string out of the agent-emitted code.
 *
 * Why a plain <img> (not Remotion's <Img>):
 * - Remotion's <Img> internally calls useVideoConfig(), which throws
 *   when rendered outside a <Composition> context. The preview page
 *   mounts Sections directly into a normal Next.js page — no
 *   Composition wrapper. Using Remotion's <Img> breaks preview.
 * - Renderball never animates image src per-frame; images mount at
 *   scene start and stay. There's no benefit to Remotion's frame-
 *   accurate loading behavior here.
 * - The Remotion renderer uses Puppeteer with \`waitUntil: "networkidle0"\`
 *   by default, which already waits for images to finish loading before
 *   capturing. Plain <img> is safe in the MP4 path too.
 *
 * Single shim, works in both preview (Next.js) and render (Remotion).
 */
export const IMG_SHIM_SOURCE = `import React from "react";

export type ImgProps = Omit<React.ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  /** A URL, or an entry from script.assets.images ({ id, src, ... }). */
  src?: unknown;
};

/**
 * Resolve whatever the composition handed us into a URL string.
 *
 * script.assets.images is an array of OBJECTS — { id, src, width, height, ... } —
 * and generated code reaches into it in several ways, not all of them right. One
 * shipped deck wrote:
 *
 *   images.find((u) => typeof u === "string" && u.includes("og_image")) || images[0]
 *
 * The string test can never match an object array, so it fell through to images[0]
 * and passed the whole object as src. React stringifies that to "[object Object]",
 * the browser requests a URL that cannot exist, and the slide shows an empty framed
 * box where a picture belongs — reported as "image on slide 4 is not loading", with
 * the real og_image URL sitting unused in the manifest the whole time.
 *
 * Coercing here means no shape mistake upstream can ever reach the DOM as a broken
 * image. An unusable value renders no <img> at all rather than a broken one.
 */
const resolveSrc = (src: unknown): string | undefined => {
  if (typeof src === "string") return src || undefined;
  if (src && typeof src === "object") {
    const inner = (src as { src?: unknown }).src;
    if (typeof inner === "string") return inner || undefined;
  }
  return undefined;
};

export const Img: React.FC<ImgProps> = ({ src, ...rest }) => {
  const resolved = resolveSrc(src);
  if (!resolved) return null;
  return React.createElement("img", { ...rest, src: resolved });
};
`;

/**
 * Transparent edit-marker shim (the LEGO engine). `<Piece id kind throughline?>`
 * renders its children UNCHANGED — zero visual effect, exactly like a fragment —
 * so a Composition with Piece wrappers renders byte-identically to one without.
 * Its id/kind/throughline props exist only in the source string, where the
 * deterministic decomposer reads them to slice each top-level role into its own
 * editable piece file. Works in preview (Next.js) and render (Remotion) alike.
 */
// Piece renders a display:contents wrapper carrying data-piece/data-kind. display:
// contents generates NO layout box — the children lay out exactly as if the wrapper
// weren't there (proven pixel-identical to a Fragment in the Remotion render) — so it
// costs the MP4 nothing, but gives the visual editor a real DOM node to resolve a
// click to its piece (event.target.closest('[data-piece]')) and to bound a highlight.
export const PIECE_SHIM_SOURCE = `import React from "react";

export const Piece: React.FC<{
  id?: string;
  kind?: string;
  throughline?: string;
  children?: React.ReactNode;
}> = ({ id, kind, throughline, children }) =>
  React.createElement(
    "div",
    { "data-piece": id, "data-kind": kind, "data-throughline": throughline, style: { display: "contents" } },
    children,
  );
`;

/**
 * Dual-context Video shim. Dropped next to Composition.tsx so the agent's
 * `import { Video } from "./Video"` resolves locally.
 * - In a Remotion RENDER → <OffthreadVideo> (deterministic, frame-accurate,
 *   muted, looped) so the MP4 captures motion correctly.
 * - In the static-HTML PREVIEW (no Remotion context — getRemotionEnvironment
 *   reports isRendering:false, or throws) → a plain autoplay/loop/muted
 *   <video> the browser plays natively. Same baked src in both → preview
 *   shows the same clip the MP4 renders.
 * NOTE: requires "remotion" to be an esbuild external in the preview iframe
 * route (so the import stays a runtime require, not a server-bundled module).
 */
export const VIDEO_SHIM_SOURCE = `import React from "react";
import { OffthreadVideo, getRemotionEnvironment } from "remotion";

export type VideoProps = React.VideoHTMLAttributes<HTMLVideoElement> & { src: string };

export const Video: React.FC<VideoProps> = (props) => {
  let isRendering = false;
  try { isRendering = getRemotionEnvironment().isRendering; } catch (e) { isRendering = false; }
  if (isRendering) {
    return React.createElement(OffthreadVideo, Object.assign({ muted: true, loop: true }, props));
  }
  return React.createElement(
    "video",
    Object.assign({ autoPlay: true, loop: true, muted: true, playsInline: true }, props),
  );
};
`;

/**
 * Dual-context Lottie shim. Lottie needs a JS runtime to animate, which the
 * static-HTML preview does NOT have — so the two contexts diverge more than
 * photo/video:
 * - RENDER → @remotion/lottie's <Lottie> (frame-accurate). We fetch the JSON
 *   ourselves and hold the frame via delayRender until it's loaded.
 * - PREVIEW → an empty container tagged data-lottie-src; the iframe route
 *   injects a vanilla lottie-web player that finds these containers and plays
 *   them client-side (since the static HTML can't run React/@remotion/lottie).
 * Requires "@remotion/lottie" + "remotion" as esbuild externals in the iframe.
 */
export const LOTTIE_SHIM_SOURCE = `import React from "react";
import { getRemotionEnvironment, delayRender, continueRender } from "remotion";
import { Lottie as RemotionLottie } from "@remotion/lottie";

export type LottieProps = { src: string; loop?: boolean; style?: React.CSSProperties; className?: string };

const RenderLottie: React.FC<LottieProps> = ({ src, loop, style, className }) => {
  const [data, setData] = React.useState(null);
  const [handle] = React.useState(() => delayRender("lottie"));
  React.useEffect(() => {
    let active = true;
    fetch(src)
      .then(function (r) { return r.json(); })
      .then(function (j) { if (active) { setData(j); continueRender(handle); } })
      .catch(function () { continueRender(handle); });
    return function () { active = false; };
  }, [src, handle]);
  if (!data) return null;
  return React.createElement(RemotionLottie, { animationData: data, loop: loop !== false, style: style, className: className });
};

export const Lottie: React.FC<LottieProps> = (props) => {
  let isRendering = false;
  try { isRendering = getRemotionEnvironment().isRendering; } catch (e) { isRendering = false; }
  if (isRendering) return React.createElement(RenderLottie, props);
  return React.createElement("div", {
    className: "rb-lottie " + (props.className || ""),
    "data-lottie-src": props.src,
    "data-lottie-loop": props.loop === false ? "0" : "1",
    style: props.style,
  });
};
`;

/**
 * naturalWidth/naturalHeight above this ratio means a logo asset is a
 * horizontal LOCKUP — the brand name is already drawn inside the image
 * (tailscale.com/static/logo.svg: dot-grid mark + "tailscale" wordmark in one
 * file, viewBox 0 0 121 22 ≈ 5.5:1). Rendering BrandChrome's wordmark span
 * next to such an asset prints the name twice ("tailscale tailscale").
 * 2.5 clears square favicons and modestly-wide marks (≤2:1) while catching
 * real lockups (≥3:1 in practice).
 */
export const WIDE_LOCKUP_RATIO = 2.5;

/**
 * The lockup decision. BRAND_CHROME_SOURCE interpolates WIDE_LOCKUP_RATIO into
 * an identical helper, and the static-preview suppression script in
 * app/api/preview/[id]/iframe/route.ts applies the same comparison — neither
 * can drift from this constant. brand-chrome.test.ts checks the compiled
 * template's export agrees with this one.
 */
export const isWideLockup = (
  naturalWidth: number,
  naturalHeight: number,
): boolean => naturalHeight > 0 && naturalWidth / naturalHeight > WIDE_LOCKUP_RATIO;

/**
 * The PROVIDED BrandChrome — dropped next to Composition.tsx so the agent's
 * \`import { BrandChrome } from "./BrandChrome"\` resolves locally.
 *
 * Why provided instead of agent-authored: the brand-mark choreography (one
 * logo per frame, hero-CTA suppression, contrast inversion, stable positions)
 * was the #1 retry driver and the #1 shipped-defect class — 28% of historical
 * comps shipped duplicate logo sites and 10% drew the mark by hand. A fixed
 * component makes that whole class impossible to author: the agent configures
 * it (variant, colors, fonts, wordmark, logoSrc) but cannot misplace the mark.
 * Brand variety is preserved through the three archetypes + full color/type
 * config; consistency-within-a-video is structural.
 *
 * Pure inline styles, no deps beyond the local Img shim — works in preview
 * (Next.js) and render (Remotion) identically, like the other shims.
 */
export const BRAND_CHROME_SOURCE = `import React from "react";
import { Img } from "./Img";

/** naturalWidth/naturalHeight above this ratio means the logo asset is a
 *  horizontal LOCKUP — the brand name is already drawn inside the image, so
 *  rendering the wordmark span next to it would print the name twice.
 *  Mirrors isWideLockup in lib/render/build-wrapper.ts (the template
 *  interpolates the same WIDE_LOCKUP_RATIO constant). */
export const isWideLockup = (naturalWidth: number, naturalHeight: number): boolean =>
  naturalHeight > 0 && naturalWidth / naturalHeight > ${WIDE_LOCKUP_RATIO};

/** True when a CSS color reads as LIGHT (luminance > 0.5). Parses #hex and
 *  rgb()/rgba(); anything unparseable counts as light, preserving the legacy
 *  white-silhouette behavior. Drives the logo filter below: light ink means a
 *  dark canvas (silhouette the mark white); dark ink means a light canvas
 *  (render the mark's NATURAL colors — a white silhouette on a light canvas
 *  is invisible, the FP-rebuild top-left logo bug). */
export const isLightColor = (c: string): boolean => {
  let r: number, g: number, b: number;
  const hex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(c.trim());
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split("").map((x) => x + x).join("");
    const n = parseInt(h, 16);
    r = (n >> 16) & 255; g = (n >> 8) & 255; b = n & 255;
  } else {
    const m = /rgba?\\(\\s*(\\d+)[\\s,]+(\\d+)[\\s,]+(\\d+)/.exec(c);
    if (!m) return true;
    r = +m[1]; g = +m[2]; b = +m[3];
  }
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 127;
};

export interface BrandChromeProps {
  sceneIndex: number;
  totalScenes: number;
  /** ONE archetype per video: corner (default, tech/minimal), footer
   *  (editorial band), strip (top app-bar). Never varies between scenes. */
  variant?: "corner" | "footer" | "strip";
  /** Pass LOGO_SRC. Omit when the brand has no real logo — the wordmark
   *  text then serves as the mark. */
  logoSrc?: string;
  /** Brand name text rendered next to the mark (or as the mark itself).
   *  Auto-suppressed once logoSrc loads and measures as a wide lockup
   *  (see isWideLockup) — the asset already contains the name. */
  wordmark?: string;
  /** STABLE context pill (tagline / event / category) — never the scene's
   *  editorial eyebrow. */
  category?: string;
  /** Set false on the ONE scene that renders its own hero logo (logo-led
   *  opening / CTA) so the frame keeps exactly one logo. */
  showCornerLogo?: boolean;
  /** Set true on a full-bleed brand-color scene: chrome flips to white ink
   *  so it clears contrast against the saturated field. */
  onBrandColorBg?: boolean;
  /** Chrome ink on normal (dark) scenes — e.g. BRAND_LIGHT. */
  ink: string;
  /** Active pagination dot / accents — e.g. BRAND_ACCENT. */
  accent: string;
  fontDisplay: string;
  fontBody: string;
  /** Optional footer-band background (footer variant only). */
  tint?: string;
}

export const BrandChrome: React.FC<BrandChromeProps> = ({
  sceneIndex,
  totalScenes,
  variant = "corner",
  logoSrc,
  wordmark,
  category,
  showCornerLogo,
  onBrandColorBg,
  ink,
  accent,
  fontDisplay,
  fontBody,
  tint,
}) => {
  const fg = onBrandColorBg ? "#ffffff" : ink;
  const dot = onBrandColorBg ? "#ffffff" : accent;
  const idle = onBrandColorBg ? "rgba(255,255,255,0.45)" : "rgba(255,255,255,0.25)";
  // Logo treatment follows the canvas: on a dark canvas (light ink) the mark
  // is silhouetted white; on a light canvas (dark ink) it keeps its natural
  // brand colors — forcing white there rendered it invisible.
  const logoFilter =
    onBrandColorBg || isLightColor(ink) ? "brightness(0) invert(1)" : "none";

  // Until the logo loads — and in SSR, where it never does — the wordmark
  // renders as always; measurement can only SUPPRESS it. The MP4 renderer
  // waits for images before capturing frames, so onLoad lands ahead of
  // frame 0. The data-rb-brand-* attributes are load-bearing: the static-HTML
  // preview strips React handlers, so the iframe route re-applies this same
  // rule via an injected vanilla script that finds them.
  const [logoIsLockup, setLogoIsLockup] = React.useState(false);

  const mark =
    showCornerLogo !== false ? (
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {logoSrc ? (
          <Img
            src={logoSrc}
            data-rb-brand-logo=""
            style={{ height: 24, width: "auto", filter: logoFilter }}
            onLoad={(e: React.SyntheticEvent<HTMLImageElement>) => {
              const el = e.currentTarget;
              if (isWideLockup(el.naturalWidth, el.naturalHeight)) setLogoIsLockup(true);
            }}
          />
        ) : null}
        {wordmark && !logoIsLockup ? (
          <span
            data-rb-brand-wordmark=""
            style={{
              fontFamily: fontDisplay,
              fontWeight: 600,
              fontSize: 18,
              color: fg,
              letterSpacing: "-0.01em",
              whiteSpace: "nowrap",
            }}
          >
            {wordmark}
          </span>
        ) : null}
      </div>
    ) : (
      <div />
    );

  const pill = category ? (
    <div style={{ display: "flex", alignItems: "center", gap: 8, maxWidth: 460 }}>
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: dot,
          opacity: 0.85,
          flexShrink: 0,
        }}
      />
      <span
        style={{
          fontFamily: fontBody,
          fontSize: 11,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: fg,
          opacity: onBrandColorBg ? 0.95 : 0.75,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {category}
      </span>
    </div>
  ) : null;

  // Pagination dots REMOVED (QA 2026-07-06): scene-progress dots at the bottom
  // of every frame read as website carousel chrome and made rendered scenes
  // look like landing-page screenshots. A brand film shows no progress UI.
  // sceneIndex/totalScenes stay in the props contract (compat + future use).
  void sceneIndex;
  void totalScenes;
  void idle;

  if (variant === "footer") {
    return (
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: 64,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 40px",
          background: tint ?? "rgba(255,255,255,0.04)",
          zIndex: 20,
        }}
      >
        {mark}
        {pill ?? <div />}
      </div>
    );
  }

  if (variant === "strip") {
    return (
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 0,
          height: 56,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 40px",
          zIndex: 20,
        }}
      >
        {mark}
        {pill ?? <div />}
      </div>
    );
  }

  // corner (default)
  return (
    <>
      {showCornerLogo !== false && (
        <div style={{ position: "absolute", top: 32, left: 40, zIndex: 20 }}>{mark}</div>
      )}
      {pill && (
        <div style={{ position: "absolute", top: 36, right: 40, zIndex: 20 }}>{pill}</div>
      )}
    </>
  );
};
`;

/** The files that make up one generated composition under src/generated/<id>/. */
export interface GeneratedFiles {
  designCode: string;
  code: string;
  script: Script;
  /** BuildWarnings, serialized as-is. Typed `unknown` here to keep this
   *  module free of a runtime dep on pipeline.ts (it only stringifies it). */
  warnings?: unknown;
  /** Asset search log (license-auditable record of search_assets calls). */
  assetManifest?: unknown;
}

/**
 * Write the generated composition + Remotion wrapper + provenance to
 * genDir. Shared by the preview endpoint and the MP4 render path so the
 * on-disk layout (and the script.json / warnings.json the "preview is the
 * MP4" reuse check relies on) is identical regardless of which path built
 * it. Lives here (not render-brief) so the preview route can import it
 * without pulling in @remotion/bundler + renderer.
 */
export const writeGeneratedFiles = async (
  genDir: string,
  files: GeneratedFiles,
  opts: {
    /** false = write the dir but do NOT publish it to durable storage.
     *  For scratch render dirs (stream critics' early renders, 2026-09-01)
     *  that must never reach the store customers hydrate from. Default true —
     *  every existing caller keeps its durability. */
    persist?: boolean;
  } = {},
): Promise<void> => {
  // The two LLM-authored files are checked BEFORE anything touches disk: this
  // process later executes them with a real `new Function(...)`, so unsafe
  // output must fail the build rather than wait for a renderer to run it.
  // The shims below are ours and are not scanned. See code-guard.ts.
  reportUnsafeComposition(files.code, "Composition.tsx");
  reportUnsafeComposition(files.designCode, "Composition.design.tsx");

  await fs.mkdir(genDir, { recursive: true });
  await fs.writeFile(path.join(genDir, "Img.tsx"), IMG_SHIM_SOURCE, "utf-8");
  await fs.writeFile(path.join(genDir, "Piece.tsx"), PIECE_SHIM_SOURCE, "utf-8");
  await fs.writeFile(path.join(genDir, "Video.tsx"), VIDEO_SHIM_SOURCE, "utf-8");
  await fs.writeFile(path.join(genDir, "Lottie.tsx"), LOTTIE_SHIM_SOURCE, "utf-8");
  await fs.writeFile(path.join(genDir, "BrandChrome.tsx"), BRAND_CHROME_SOURCE, "utf-8");
  await fs.writeFile(
    path.join(genDir, "Composition.design.tsx"),
    files.designCode,
    "utf-8",
  );
  await fs.writeFile(path.join(genDir, "Composition.tsx"), files.code, "utf-8");
  await fs.writeFile(
    path.join(genDir, "script.json"),
    JSON.stringify(files.script, null, 2),
    "utf-8",
  );
  await fs.writeFile(
    path.join(genDir, "index.tsx"),
    buildIndexTsx(files.script),
    "utf-8",
  );
  await fs.writeFile(
    path.join(genDir, "warnings.json"),
    JSON.stringify(files.warnings ?? {}, null, 2),
    "utf-8",
  );
  if (files.assetManifest) {
    await fs.writeFile(
      path.join(genDir, "assets-manifest.json"),
      JSON.stringify(files.assetManifest, null, 2),
      "utf-8",
    );
  }

  // Publish to durable storage. The container filesystem is wiped on every
  // deploy, so without this the document the user just paid for exists only
  // until the next push. Best-effort: a storage outage must not fail a
  // finished build (see gen-store.ts).
  if (opts.persist !== false) await persistGenDir(path.basename(genDir));
};
