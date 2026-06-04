"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Script } from "../../../src/schema";

interface Props {
  scriptId: string;
  script: Script;
}

/**
 * Client-side preview of the agent-emitted Composition.tsx.
 *
 * Architecture (rewritten 2026-05-28 — iframe + on-demand SSR):
 * - Webpack's `import(\`...${var}...\`)` builds a context-module at
 *   compile time and bakes in chunk references for the directories
 *   present then. New `src/generated/<newId>/` dirs created after the
 *   dev server started AREN'T in the chunk map and the dynamic import
 *   throws "Cannot find module".
 * - Instead: each scene is rendered server-side via
 *   /api/preview/[id]/iframe?scene=N and mounted in an <iframe>. The
 *   server compiles the Composition.tsx on demand via esbuild, so
 *   every request reads fresh source from disk — no webpack involved.
 * - Scene change = iframe.src change = browser reloads iframe = CSS
 *   animations naturally restart. No more `key={}` remount juggling.
 *
 * Per-scene "Regenerate" still works: the regen endpoint writes new
 * Composition.tsx to disk, the next iframe load reads the new file.
 */
type Mp4State =
  | { kind: "idle" }
  | { kind: "rendering" }
  | { kind: "done"; url: string }
  | { kind: "error"; message: string };

/**
 * Soft quality warnings the pipeline can attach to a build result:
 * invented numeric claims, low-contrast color pairings, scenes that
 * should have charts but don't. Matches BuildWarnings in pipeline.ts.
 */
interface PreviewWarnings {
  invented_claims?: string[];
  low_contrast?: { fg: string; bg: string; ratio: number }[];
  missing_charts?: string[];
  throughline_drift?: { slug: string; axis: "x" | "y" | "both"; driftX: number; driftY: number; occurrences: number }[];
  duplicate_logo?: number;
  overflow_crop?: number[];
}

export function PreviewClient({ scriptId, script }: Props) {
  const [sceneIndex, setSceneIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [regenerating, setRegenerating] = useState(false);
  const [regenError, setRegenError] = useState<string | null>(null);
  const [mp4State, setMp4State] = useState<Mp4State>({ kind: "idle" });
  const [warnings, setWarnings] = useState<PreviewWarnings | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const dims = useMemo(() => getDimensions(script), [script]);

  // Auto-advance scenes when playing.
  useEffect(() => {
    if (!playing) return;
    const scene = script.scenes[sceneIndex];
    if (!scene) return;
    const startSec = scene.start_seconds ?? 0;
    const endSec = scene.end_seconds ?? 0;
    const durMs = Math.max(0, (endSec - startSec) * 1000);
    if (durMs <= 0) return;
    const t = setTimeout(() => {
      setSceneIndex((i) => (i + 1) % script.scenes.length);
      // Bump reload key so even loop-back (N → 0) re-fetches & restarts anims.
      setReloadKey((k) => k + 1);
    }, durMs);
    return () => clearTimeout(t);
  }, [sceneIndex, playing, script.scenes, reloadKey]);

  const replayScene = () => setReloadKey((k) => k + 1);
  const selectScene = (i: number) => {
    setSceneIndex(i);
    setReloadKey((k) => k + 1);
  };

  const handleRegenerate = async () => {
    setRegenerating(true);
    setRegenError(null);
    try {
      const res = await fetch("/api/preview/regenerate-scene", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scriptId, sceneIndex }),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`regen failed (${res.status}): ${txt}`);
      }
      const json = (await res.json()) as {
        ok: true;
        warnings?: PreviewWarnings;
      };
      if (json.warnings) setWarnings(json.warnings);
      // Bump reload key — the iframe re-fetches and the server reads
      // the freshly-written Composition.tsx.
      setReloadKey((k) => k + 1);
    } catch (e) {
      setRegenError(e instanceof Error ? e.message : String(e));
    } finally {
      setRegenerating(false);
    }
  };

  const handleRenderMp4 = async () => {
    setMp4State({ kind: "rendering" });
    try {
      const res = await fetch(`/api/preview/${scriptId}/render-mp4`, {
        method: "POST",
      });
      if (!res.ok) {
        const txt = await res.text();
        setMp4State({ kind: "error", message: `${res.status}: ${txt}` });
        return;
      }
      const json = (await res.json()) as {
        ok: true;
        url: string;
        warnings?: PreviewWarnings;
      };
      if (json.warnings) setWarnings(json.warnings);
      setMp4State({ kind: "done", url: json.url });
    } catch (e) {
      setMp4State({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const currentScene = script.scenes[sceneIndex];
  const iframeSrc = `/api/preview/${scriptId}/iframe?scene=${sceneIndex}&v=${reloadKey}`;

  return (
    <div>
      {/* Canvas — iframe-rendered Section at natural resolution, scaled to fit */}
      <div
        className="rounded-xl overflow-hidden bg-black ring-1 ring-gray-200 mb-6 relative"
        style={{ aspectRatio: `${dims.width}/${dims.height}` }}
      >
        <iframe
          ref={iframeRef}
          src={iframeSrc}
          title={`Scene ${sceneIndex + 1}`}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            border: 0,
            background: "#000",
          }}
        />
      </div>

      {/* Scene navigation */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {script.scenes.map((s, i) => (
          <button
            key={i}
            onClick={() => selectScene(i)}
            className={`text-xs px-3 py-1.5 rounded-md ring-1 transition-colors ${
              i === sceneIndex
                ? "bg-gray-900 text-white ring-gray-900"
                : "bg-white text-gray-700 ring-gray-300 hover:ring-gray-500"
            }`}
          >
            {i + 1}. {s.label}
          </button>
        ))}
      </div>

      {/* Playback controls */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <button
          onClick={() => setPlaying((p) => !p)}
          className="px-4 py-2 rounded-md bg-gray-900 text-white text-sm hover:bg-gray-700"
        >
          {playing ? "Pause" : "Play"}
        </button>
        <button
          onClick={replayScene}
          className="px-4 py-2 rounded-md bg-white text-gray-900 text-sm ring-1 ring-gray-300 hover:ring-gray-500"
        >
          Replay scene
        </button>
        <button
          onClick={handleRegenerate}
          disabled={regenerating}
          className="px-4 py-2 rounded-md bg-amber-100 text-amber-900 text-sm ring-1 ring-amber-300 hover:ring-amber-500 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {regenerating
            ? "Regenerating…"
            : `Regenerate scene ${sceneIndex + 1}`}
        </button>
        {mp4State.kind === "done" ? (
          <a
            href={mp4State.url}
            target="_blank"
            rel="noopener noreferrer"
            className="px-4 py-2 rounded-md bg-emerald-600 text-white text-sm hover:bg-emerald-700"
          >
            View MP4 ↗
          </a>
        ) : (
          <button
            type="button"
            onClick={handleRenderMp4}
            disabled={mp4State.kind === "rendering"}
            className="px-4 py-2 rounded-md bg-emerald-600 text-white text-sm hover:bg-emerald-700 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {mp4State.kind === "rendering"
              ? "Rendering MP4… (~2-4 min)"
              : "Render to MP4 →"}
          </button>
        )}
      </div>

      {mp4State.kind === "error" && (
        <div className="p-4 rounded-md bg-red-50 ring-1 ring-red-200 text-xs font-mono text-red-900 mb-4 whitespace-pre-wrap">
          MP4 render failed: {mp4State.message}
        </div>
      )}

      {warnings && (warnings.invented_claims?.length ||
        warnings.low_contrast?.length ||
        warnings.missing_charts?.length ||
        warnings.throughline_drift?.length ||
        (warnings.duplicate_logo ?? 0) > 1 ||
        warnings.overflow_crop?.length) ? (
        <WarningsPanel warnings={warnings} />
      ) : null}

      {regenError && (
        <div className="p-4 rounded-md bg-red-50 ring-1 ring-red-200 text-xs font-mono text-red-900 mb-4 whitespace-pre-wrap">
          {regenError}
        </div>
      )}

      {/* Current scene meta */}
      {currentScene && (
        <div className="text-xs text-gray-600 font-mono">
          <div>
            scene {sceneIndex + 1}/{script.scenes.length} ·{" "}
            {((currentScene.end_seconds ?? 0) -
              (currentScene.start_seconds ?? 0)).toFixed(1)}
            s
          </div>
          {currentScene.description && (
            <div className="mt-1 text-gray-500 italic">
              {currentScene.description}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Soft quality-warning chips. Surfaces the BuildWarnings the agents'
 * validators produced (invented numeric claims, low-contrast color
 * pairs, scenes missing charts). All warnings are non-blocking — the
 * design ships either way; this panel just makes the issues visible
 * so the user can decide whether to regenerate the affected scene.
 */
function WarningsPanel({ warnings }: { warnings: PreviewWarnings }) {
  return (
    <div className="mb-6 p-4 rounded-lg bg-amber-50 ring-1 ring-amber-200">
      <div className="flex items-center gap-2 text-xs uppercase tracking-widest text-amber-900 font-semibold mb-3">
        Quality warnings
      </div>
      <div className="space-y-3">
        {warnings.invented_claims && warnings.invented_claims.length > 0 && (
          <div>
            <div className="text-[11px] uppercase tracking-wide text-amber-800 mb-1.5">
              Invented numeric claims ({warnings.invented_claims.length}) —
              not supported by your brief, body excerpts, or verified
              claims
            </div>
            <div className="flex flex-wrap gap-1.5">
              {warnings.invented_claims.slice(0, 8).map((c, i) => (
                <span
                  key={i}
                  className="px-2 py-0.5 rounded bg-amber-100 text-amber-900 text-xs font-mono ring-1 ring-amber-200"
                >
                  {c}
                </span>
              ))}
            </div>
          </div>
        )}

        {warnings.low_contrast && warnings.low_contrast.length > 0 && (
          <div>
            <div className="text-[11px] uppercase tracking-wide text-amber-800 mb-1.5">
              Low-contrast text pairings ({warnings.low_contrast.length}) —
              below WCAG 4.5:1 threshold
            </div>
            <div className="flex flex-wrap gap-2">
              {warnings.low_contrast.slice(0, 8).map((c, i) => (
                <span
                  key={i}
                  className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-amber-100 text-amber-900 text-xs font-mono ring-1 ring-amber-200"
                  title={`fg ${c.fg} on bg ${c.bg} — ${c.ratio}:1`}
                >
                  <span
                    className="inline-block w-3 h-3 rounded-sm ring-1 ring-amber-300"
                    style={{ background: c.bg }}
                  />
                  <span style={{ color: c.fg, background: c.bg, padding: "0 4px" }}>
                    Aa
                  </span>
                  <span>{c.ratio}:1</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {warnings.missing_charts && warnings.missing_charts.length > 0 && (
          <div>
            <div className="text-[11px] uppercase tracking-wide text-amber-800 mb-1.5">
              Scenes with numeric data but no chart —
              consider regenerating with a real Recharts visualization
            </div>
            <div className="flex flex-wrap gap-1.5">
              {warnings.missing_charts.slice(0, 8).map((s, i) => (
                <span
                  key={i}
                  className="px-2 py-0.5 rounded bg-amber-100 text-amber-900 text-xs ring-1 ring-amber-200"
                >
                  {s}
                </span>
              ))}
            </div>
          </div>
        )}

        {warnings.throughline_drift && warnings.throughline_drift.length > 0 && (
          <div>
            <div className="text-[11px] uppercase tracking-wide text-amber-800 mb-1.5">
              Recurring elements that jump position ({warnings.throughline_drift.length}) —
              a motif moves &gt;10% of the canvas between scenes (reads as a teleport on the cut)
            </div>
            <div className="flex flex-wrap gap-1.5">
              {warnings.throughline_drift.slice(0, 6).map((d, i) => (
                <span
                  key={i}
                  className="px-2 py-0.5 rounded bg-amber-100 text-amber-900 text-xs font-mono ring-1 ring-amber-200"
                  title={`"${d.slug}" appears in ${d.occurrences} scenes; drifts ${d.driftX}px x / ${d.driftY}px y`}
                >
                  {d.slug} · {d.axis === "both" ? `${d.driftX}×${d.driftY}px` : d.axis === "x" ? `${d.driftX}px →` : `${d.driftY}px ↓`}
                </span>
              ))}
            </div>
          </div>
        )}

        {warnings.duplicate_logo && warnings.duplicate_logo > 1 && (
          <div>
            <div className="text-[11px] uppercase tracking-wide text-amber-800 mb-1.5">
              Brand logo appears {warnings.duplicate_logo}× — BrandChrome already
              shows it on every scene; a scene is rendering its own logo too
              (two marks on one frame). Per-scene-regenerate to drop the extra.
            </div>
          </div>
        )}

        {warnings.overflow_crop && warnings.overflow_crop.length > 0 && (
          <div>
            <div className="text-[11px] uppercase tracking-wide text-amber-800 mb-1.5">
              Element(s) cropped at the canvas edge — width(s) crossing the frame:
            </div>
            <div className="flex flex-wrap gap-1.5">
              {warnings.overflow_crop.slice(0, 8).map((w, i) => (
                <span
                  key={i}
                  className="px-2 py-0.5 rounded bg-amber-100 text-amber-900 text-xs font-mono ring-1 ring-amber-200"
                >
                  {w}px
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const getDimensions = (
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
