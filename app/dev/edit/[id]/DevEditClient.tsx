"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ElementEditor } from "../../../preview/[id]/ElementEditor";

/**
 * Dev editing dashboard (no Clerk session; NODE_ENV-gated route).
 *
 * Layout: canvas (settled edit surface + ElementEditor overlay) with the SCRIPT
 * panel beside it — the story logline, the current scene's role, and its copy
 * fields, so what you're editing is always visible next to where you edit it.
 * Navigation: prev/next + ←/→ keys, a scene rail with durations, Esc deselects
 * (in the editor), and the Play motion toggle to preview choreography.
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
  // Editing happens on a SETTLED scene (entry animations at their end state —
  // instant clicks, stable outlines, ~300ms post-edit reloads). "Play motion"
  // replays the scene's choreography from t=0 to preview the animation.
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

  const pill = (active: boolean): React.CSSProperties => ({
    borderRadius: 999,
    border: "1px solid " + (active ? "#6366f1" : "#ddd"),
    background: active ? "#6366f1" : "#fff",
    color: active ? "#fff" : "#333",
    padding: "5px 12px",
    fontSize: 12,
    cursor: "pointer",
    fontWeight: active ? 600 : 400,
  });

  return (
    <div style={{ maxWidth: 1400, margin: "0 auto", padding: "20px 24px", fontFamily: "system-ui, sans-serif", color: "#1a1d24" }}>
      {/* header: what you're editing */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4 }}>
        <h1 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Renderball editor</h1>
        <span style={{ fontSize: 11, color: "#9aa0ab", fontFamily: "monospace" }}>
          {scriptId} · {scenes.length} scenes · {Math.round(totalSeconds)}s
        </span>
      </div>
      {logline && (
        <p style={{ fontSize: 12.5, color: "#6b7280", margin: "0 0 14px", maxWidth: 860, lineHeight: 1.45 }}>{logline}</p>
      )}

      {/* canvas + script panel */}
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              position: "relative",
              aspectRatio: `${width}/${height}`,
              background: "#0b0d12",
              borderRadius: 8,
              overflow: "hidden",
              border: "1px solid #e5e5e5",
            }}
          >
            <iframe
              ref={iframeRef}
              src={iframeSrc}
              title={`Scene ${sceneIndex + 1}`}
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: 0 }}
            />
            {/* While motion plays, the editor overlay unmounts — rects measured
                mid-animation are wrong, and the surface is for watching, not editing. */}
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
          <div style={{ display: "flex", gap: 6, marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
            <button type="button" onClick={() => goTo(sceneIndex - 1)} disabled={sceneIndex === 0} style={{ ...pill(false), opacity: sceneIndex === 0 ? 0.4 : 1 }} title="Previous scene (←)">
              ‹
            </button>
            {scenes.map((s, i) => (
              <button key={i} type="button" onClick={() => goTo(i)} style={pill(i === sceneIndex)}>
                <span style={{ fontFamily: "monospace", opacity: 0.6, marginRight: 4 }}>{i + 1}</span>
                {s.label}
                <span style={{ fontFamily: "monospace", fontSize: 10, opacity: 0.55, marginLeft: 5 }}>{Math.round(s.seconds)}s</span>
              </button>
            ))}
            <button type="button" onClick={() => goTo(sceneIndex + 1)} disabled={sceneIndex === scenes.length - 1} style={{ ...pill(false), opacity: sceneIndex === scenes.length - 1 ? 0.4 : 1 }} title="Next scene (→)">
              ›
            </button>
            <span style={{ flex: 1 }} />
            <button type="button" onClick={() => setReloadKey((k) => k + 1)} style={pill(false)}>
              {playMotion ? "Replay" : "Reload"}
            </button>
            <button
              type="button"
              onClick={() => {
                setPlayMotion((p) => !p);
                setReloadKey((k) => k + 1); // reload swaps settle mode + restarts choreography
              }}
              style={pill(playMotion)}
            >
              {playMotion ? "✎ Back to editing" : "▶ Play motion"}
            </button>
          </div>
        </div>

        {/* SCRIPT panel — the story + this scene's copy, beside where you edit it */}
        <aside style={{ width: 300, flexShrink: 0, border: "1px solid #e5e5e5", borderRadius: 8, background: "#fafafa", padding: "14px 16px", maxHeight: "78vh", overflowY: "auto" }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.08em", color: "#9aa0ab", marginBottom: 6 }}>
            SCRIPT · SCENE {sceneIndex + 1} OF {scenes.length}
          </div>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 2 }}>{scene?.label}</div>
          <div style={{ fontSize: 11, fontFamily: "monospace", color: "#9aa0ab", marginBottom: 8 }}>{Math.round(scene?.seconds ?? 0)}s on screen</div>
          {scene?.description && (
            <p style={{ fontSize: 12, color: "#6b7280", lineHeight: 1.5, margin: "0 0 12px" }}>{scene.description}</p>
          )}
          <div style={{ borderTop: "1px solid #e8e8e8", paddingTop: 10 }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.08em", color: "#9aa0ab", marginBottom: 8 }}>
              COPY IN THIS SCENE
            </div>
            {fields.length === 0 && <div style={{ fontSize: 12, color: "#9aa0ab" }}>No editable copy fields.</div>}
            {fields.map((f) => (
              <div key={f.path} style={{ marginBottom: 9 }}>
                <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: "0.06em", color: "#a5aab5", textTransform: "uppercase" }}>{f.label}</div>
                <div style={{ fontSize: 12.5, color: "#374151", lineHeight: 1.4 }}>{f.value}</div>
              </div>
            ))}
            <div style={{ fontSize: 10.5, color: "#b0b5bf", marginTop: 10, lineHeight: 1.5 }}>
              Double-click any text in the canvas to edit it — changes save to the script and render in the MP4.
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
