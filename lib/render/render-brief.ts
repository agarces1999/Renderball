/**
 * Single render path. Both the Stage 2 "Render to MP4" server action
 * (app/review/[id]/actions.ts) and the dev endpoint
 * (app/api/dev/render/route.ts) called the same ~200-line sequence:
 *
 *   1. Agent 2 (Design + Choreography) → generated React/CSS
 *   2. Write generated files to src/generated/<scriptId>/
 *   3. Remotion bundle()
 *   4. Remotion renderMedia() → public/renders/<scriptId>.mp4
 *
 * This module collapses them into one async function. Both callsites
 * now do `const result = await renderBriefToMp4(brief, script)` and
 * return the result directly. ~250 LOC of duplication removed.
 *
 * The function ONLY runs the build + render. Loading the brief +
 * script, plumbing UI state, and handling the render-button kind of
 * stays in the callsite.
 */

import { promises as fs } from "fs";
import path from "path";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import type { StoredBrief } from "../store";
import type { Script } from "../../src/schema";
import { isStorageConfigured, putObject, renderKey } from "../storage/r2";
import {
  buildAnimatedSections,
  buildAgentInputFromBrief,
  type BuildWarnings,
} from "../agents/pipeline";
import {
  writeGeneratedFiles,
  dimensionsForScript,
  totalFramesForScript,
  buildIndexTsx,
  RENDER_FPS,
  RENDER_QUALITY,
} from "./build-wrapper";

/**
 * Stage labels for failure reporting — lets the caller surface a
 * specific error UI per stage (Agent 2 failed vs bundle failed vs
 * renderMedia failed).
 */
export type RenderStage = "agent2" | "bundle" | "render";

export type RenderBriefResult =
  | { ok: true; url: string; warnings?: BuildWarnings }
  | { ok: false; error: string; stage?: RenderStage };

/**
 * If genDir already holds a composition built from an IDENTICAL script,
 * return its persisted warnings — reuse it, so the MP4 renders exactly what
 * the user previewed. Return null to signal "rebuild": missing files, a
 * parse error, or a script that changed since the build (config / scene
 * edits on the review screen).
 *
 * Equality is a full-content JSON compare. A false negative merely costs a
 * rebuild (the prior behavior); a false positive would require two genuinely
 * different scripts to serialize identically, which a full-content compare
 * rules out — so the unsafe direction (rendering a stale composition) can't
 * happen.
 */
const tryReuseGenerated = async (
  genDir: string,
  script: Script,
): Promise<{ warnings?: BuildWarnings } | null> => {
  try {
    const [storedScriptRaw] = await Promise.all([
      fs.readFile(path.join(genDir, "script.json"), "utf-8"),
      fs.access(path.join(genDir, "Composition.tsx")),
      fs.access(path.join(genDir, "index.tsx")),
      fs.access(path.join(genDir, "Img.tsx")),
    ]);
    if (
      JSON.stringify(JSON.parse(storedScriptRaw)) !== JSON.stringify(script)
    ) {
      return null; // script / config changed since the preview → rebuild
    }
    let warnings: BuildWarnings | undefined;
    try {
      const w = JSON.parse(
        await fs.readFile(path.join(genDir, "warnings.json"), "utf-8"),
      );
      warnings =
        w && Object.keys(w).length > 0 ? (w as BuildWarnings) : undefined;
    } catch {
      // no warnings.json (older build) — reuse without warnings
    }
    return { warnings };
  } catch {
    return null; // missing or corrupt artifacts → rebuild
  }
};

/**
 * Run the full Agent 2 → bundle → renderMedia pipeline against a
 * stored brief + its script. Returns the public render URL on
 * success.
 *
 * The brief is needed (not just the script) so we can pass brand
 * context — palette, fonts, og_image, verified claims — to the
 * agents. Without brand context the design pass falls back to
 * Renderball defaults.
 */
export const renderBriefToMp4 = async (
  brief: StoredBrief,
  script: Script,
): Promise<RenderBriefResult> => {
  if (!brief.script_id) {
    return { ok: false, error: "brief.script_id is required" };
  }

  const genDir = path.join(
    process.cwd(),
    "src",
    "generated",
    brief.script_id,
  );

  // ─── 1. Get the composition — reuse the preview's, or build it ────
  //
  // The preview IS the MP4. The preview build already ran the EXACT same
  // gated pipeline and saved a composition for this script. If the script
  // hasn't changed since, render THAT composition — the one the user
  // approved — rather than rebuilding a different (nondeterministic) one.
  // Rebuild only when the script/config changed or no preview exists.
  let warnings: BuildWarnings | undefined;
  const reusedWarnings = await tryReuseGenerated(genDir, script);
  if (reusedWarnings !== null) {
    warnings = reusedWarnings.warnings;
    // The wrapper (index.tsx) is OURS, derived deterministically from the
    // script — regenerate it even on the reuse path so older genDirs pick up
    // wrapper fixes (e.g. the render-time animation clock) without an
    // expensive agent rebuild. The agent-emitted Composition files are
    // untouched; only the harness around them refreshes.
    await fs.writeFile(
      path.join(genDir, "index.tsx"),
      buildIndexTsx(script),
      "utf-8",
    );
  } else {
    const agentResult = await buildAnimatedSections(
      buildAgentInputFromBrief(brief, script),
    );
    if (!agentResult.ok) {
      return {
        ok: false,
        error: `Agent 2 failed: ${agentResult.error}`,
        stage: "agent2",
      };
    }
    // ─── 2. Write generated files to src/generated/<scriptId>/ ──────
    await writeGeneratedFiles(genDir, {
      designCode: agentResult.designCode,
      code: agentResult.code,
      script,
      warnings: agentResult.warnings,
      assetManifest: agentResult.asset_manifest,
    });
    warnings = agentResult.warnings;
  }

  // ─── 3. Remotion bundle ───────────────────────────────────────────
  let bundleLocation: string;
  try {
    bundleLocation = await bundle({
      entryPoint: path.join(genDir, "index.tsx"),
      outDir: path.join(
        process.cwd(),
        ".data",
        "render-bundle",
        brief.script_id,
      ),
    });
  } catch (err) {
    return {
      ok: false,
      error: `Bundle failed: ${err instanceof Error ? err.message : String(err)}`,
      stage: "bundle",
    };
  }

  // ─── 4. Render to MP4 ─────────────────────────────────────────────
  try {
    const composition = await selectComposition({
      serveUrl: bundleLocation,
      id: "Generated",
      inputProps: { script },
    });

    const dims = dimensionsForScript(script);
    const totalFrames = totalFramesForScript(script);

    // PRIVATE dir (not public/) so renders are reachable only through the
    // owner-gated /api/renders/<scriptId> route, never the static handler.
    const outDir = path.join(process.cwd(), ".data", "renders");
    await fs.mkdir(outDir, { recursive: true });
    const outPath = path.join(outDir, `${brief.script_id}.mp4`);

    await renderMedia({
      composition: {
        ...composition,
        width: dims.width,
        height: dims.height,
        durationInFrames: totalFrames,
        fps: RENDER_FPS,
      },
      serveUrl: bundleLocation,
      outputLocation: outPath,
      inputProps: { script },
      ...RENDER_QUALITY,
    });

    // Push the durable copy to R2. Best-effort: a configured-but-failing upload
    // must not lose a render the user just spent compute on — it stays on local
    // disk and /api/renders falls back to it. On a stateless container the local
    // copy is ephemeral, so R2 is the real source of truth.
    if (isStorageConfigured() && brief.script_id) {
      try {
        await putObject(
          renderKey(brief.script_id),
          await fs.readFile(outPath),
          "video/mp4",
        );
      } catch (err) {
        console.error("[render] R2 upload failed, keeping local copy:", err);
      }
    }

    return {
      ok: true,
      url: `/api/renders/${brief.script_id}`,
      warnings,
    };
  } catch (err) {
    return {
      ok: false,
      error: `Render failed: ${err instanceof Error ? err.message : String(err)}`,
      stage: "render",
    };
  }
};
