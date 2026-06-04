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
export const buildIndexTsx = (script: Script): string => {
  const dims = dimensionsForScript(script);
  const totalFrames = totalFramesForScript(script);

  const sceneSequences = script.scenes
    .map((scene, i) => {
      const startFrame = Math.round(
        (sceneStartSeconds(scene) ?? 0) * RENDER_FPS,
      );
      const endFrame = Math.round(
        (sceneEndSeconds(scene) ?? 0) * RENDER_FPS,
      );
      const duration = endFrame - startFrame;
      return `        {(() => {
          const C = pickSection(Sections, ${i});
          return C ? (
            <Sequence from={${startFrame}} durationInFrames={${duration}} layout="none">
              <C script={script} />
            </Sequence>
          ) : null;
        })()}`;
    })
    .join("\n");

  return `// Auto-generated wrapper. Do not edit.
// The agents' Composition.tsx is pure React + CSS. This file wraps each
// per-section component in a Remotion <Sequence> for the capture layer.
import React from "react";
import { Composition, registerRoot, Sequence, AbsoluteFill } from "remotion";
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

export type ImgProps = React.ImgHTMLAttributes<HTMLImageElement>;

export const Img: React.FC<ImgProps> = (props) =>
  React.createElement("img", props);
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
): Promise<void> => {
  await fs.mkdir(genDir, { recursive: true });
  await fs.writeFile(path.join(genDir, "Img.tsx"), IMG_SHIM_SOURCE, "utf-8");
  await fs.writeFile(path.join(genDir, "Video.tsx"), VIDEO_SHIM_SOURCE, "utf-8");
  await fs.writeFile(path.join(genDir, "Lottie.tsx"), LOTTIE_SHIM_SOURCE, "utf-8");
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
};
