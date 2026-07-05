"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ElementEditor } from "../../../preview/[id]/ElementEditor";
import { cn } from "../../../../lib/cn";

/**
 * Dev editing dashboard (no Clerk session; NODE_ENV-gated route), on the
 * DESIGN.md system: quiet cool-greyscale chrome (canvas/surface/hairline/ink
 * tokens), Geist UI + Geist Mono meta + Cabinet Grotesk for the story surfaces
 * (logline, scene title), emerald only on active states. The dark canvas frame
 * recedes so the brand-color scene is the loudest thing — same rules as
 * /preview, mirrored here without the Clerk-bound AppShell.
 *
 * Layout: canvas (settled edit surface + ElementEditor overlay) with the SCRIPT
 * panel beside it — logline, the scene's story role, and its copy fields.
 * Navigation: prev/next + ←/→ keys, durations on the rail, Esc deselects,
 * Play motion replays choreography.
 */

interface SceneSummary {
  label: string;
  description: string | null;
  seconds: number;
}
interface Field {
  path: string;
  label: string;
  value: string;
}

export function DevEditClient({
  scriptId,
  scenes,
  logline,
  width,
  height,
}: {
  scriptId: string;
  scenes: SceneSummary[];
  logline: string | null;
  width: number;
  height: number;
}) {
  const [sceneIndex, setSceneIndex] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  // Editing happens on a SETTLED scene (instant clicks, stable outlines);
  // "Play motion" replays the choreography from t=0.
  const [playMotion, setPlayMotion] = useState(false);
  const [fields, setFields] = useState<Field[]>([]);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const iframeSrc = `/api/dev/${scriptId}/iframe?scene=${sceneIndex}&v=${reloadKey}${playMotion ? "" : "&settle=1"}`;

  const scene = scenes[sceneIndex];
  const totalSeconds = scenes.reduce((a, s) => a + s.seconds, 0);

  const goTo = useCallback(
    (i: number) => {
      if (i < 0 || i >= scenes.length) return;
      setSceneIndex(i);
      setReloadKey((k) => k + 1);
    },
    [scenes.length],
  );

  // ←/→ switch scenes. Text editing happens INSIDE the iframe document, so
  // parent-level arrows never collide with typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") goTo(sceneIndex - 1);
      else if (e.key === "ArrowRight") goTo(sceneIndex + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sceneIndex, goTo]);

  // The SCRIPT panel's copy fields — same endpoint the editor resolves against,
  // refreshed after every edit (reloadKey) so the panel tracks saved changes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/dev/edit-element?scriptId=${encodeURIComponent(scriptId)}&sceneIndex=${sceneIndex}`);
        const json = (await res.json().catch(() => ({}))) as { fields?: Field[] };
        if (!cancelled) setFields(Array.isArray(json.fields) ? json.fields : []);
      } catch {
        if (!cancelled) setFields([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scriptId, sceneIndex, reloadKey]);

  return (
    <div className="min-h-screen bg-canvas">
      <div className="mx-auto max-w-[1180px] px-6 py-5">
        {/* quiet header — orb mark + wordmark, mono metadata */}
        <div className="mb-1 flex items-baseline gap-3">
          <span className="orb h-5 w-5 shrink-0 translate-y-[3px]" aria-hidden />
          <h1 className="text-[15px] font-semibold text-ink">
            Renderball <span className="font-normal text-muted">editor</span>
          </h1>
          <span className="font-mono text-[11px] text-faint">
            {scriptId} · {scenes.length} scenes · {Math.round(totalSeconds)}s
          </span>
        </div>
        {logline && (
          <p className="mb-5 ml-8 max-w-[760px] font-display text-[17px] font-medium leading-snug tracking-[-0.015em] text-ink-soft">
            {logline}
          </p>
        )}

        {/* canvas + script panel */}
        <div className="flex items-start gap-5">
          <div className="min-w-0 flex-1">
            <div
              className="relative overflow-hidden rounded-[18px] border border-hairline bg-[#0b0d12]"
              style={{ aspectRatio: `${width}/${height}` }}
            >
              <iframe
                ref={iframeRef}
                src={iframeSrc}
                title={`Scene ${sceneIndex + 1}`}
                style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: 0 }}
              />
              {/* While motion plays, the editor overlay unmounts — rects measured
                  mid-animation are wrong, and the surface is for watching. */}
              {!playMotion && (
                <ElementEditor
                  iframeRef={iframeRef}
                  scriptId={scriptId}
                  sceneIndex={sceneIndex}
                  reloadKey={reloadKey}
                  canvasWidth={width}
                  onChanged={() => setReloadKey((k) => k + 1)}
                  apiBase="/api/dev"
                  defaultShowAll
                />
              )}
            </div>

            {/* navigation rail */}
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => goTo(sceneIndex - 1)}
                disabled={sceneIndex === 0}
                title="Previous scene (←)"
                className="rounded-full border border-hairline-strong px-2.5 py-1.5 text-[12px] text-muted transition-colors hover:text-ink disabled:opacity-35"
              >
                ‹
              </button>
              {scenes.map((s, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => goTo(i)}
                  className={cn(
                    "rounded-full border px-3 py-1.5 text-[12px] transition-colors",
                    i === sceneIndex
                      ? "border-accent-line bg-accent-soft text-ink"
                      : "border-hairline-strong text-muted hover:text-ink",
                  )}
                >
                  <span className="font-mono text-faint">{i + 1}</span> {s.label}{" "}
                  <span className="font-mono text-[10px] text-faint">{Math.round(s.seconds)}s</span>
                </button>
              ))}
              <button
                type="button"
                onClick={() => goTo(sceneIndex + 1)}
                disabled={sceneIndex === scenes.length - 1}
                title="Next scene (→)"
                className="rounded-full border border-hairline-strong px-2.5 py-1.5 text-[12px] text-muted transition-colors hover:text-ink disabled:opacity-35"
              >
                ›
              </button>
              <span className="flex-1" />
              <button
                type="button"
                onClick={() => setReloadKey((k) => k + 1)}
                className="rounded-md border border-hairline-strong bg-surface px-3.5 py-1.5 text-[12.5px] text-ink transition-colors hover:bg-surface-2"
              >
                {playMotion ? "Replay" : "Reload"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setPlayMotion((p) => !p);
                  setReloadKey((k) => k + 1); // reload swaps settle mode + restarts choreography
                }}
                className={cn(
                  "rounded-md border px-3.5 py-1.5 text-[12.5px] transition-colors",
                  playMotion
                    ? "border-accent-line bg-accent-soft text-ink"
                    : "border-hairline-strong bg-surface text-ink hover:bg-surface-2",
                )}
              >
                {playMotion ? "✎ Back to editing" : "▶ Play motion"}
              </button>
            </div>
          </div>

          {/* SCRIPT panel — the story + this scene's copy, beside where you edit it */}
          <aside className="max-h-[78vh] w-[300px] shrink-0 overflow-y-auto rounded-[12px] border border-hairline bg-surface px-4 py-3.5">
            <div className="mb-1.5 font-mono text-[10.5px] uppercase tracking-[0.14em] text-faint">
              Script · Scene {sceneIndex + 1} of {scenes.length}
            </div>
            <div className="font-display text-[19px] font-bold leading-tight tracking-[-0.015em] text-ink">
              {scene?.label}
            </div>
            <div className="mb-2 font-mono text-[11px] text-faint">{Math.round(scene?.seconds ?? 0)}s on screen</div>
            {scene?.description && (
              <p className="mb-3 text-[13px] leading-relaxed text-ink-soft">{scene.description}</p>
            )}
            <div className="border-t border-hairline pt-2.5">
              <div className="mb-2 font-mono text-[10.5px] uppercase tracking-[0.14em] text-faint">
                Copy in this scene
              </div>
              {fields.length === 0 && <div className="text-[12.5px] text-faint">No editable copy fields.</div>}
              {fields.map((f) => (
                <div key={f.path} className="mb-2.5">
                  <div className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-faint">{f.label}</div>
                  <div className="text-[13px] leading-normal text-ink-soft">{f.value}</div>
                </div>
              ))}
              <div className="mt-3 text-[11px] leading-relaxed text-faint">
                Double-click any text in the canvas to edit it — changes save to the script and render in the MP4.
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
