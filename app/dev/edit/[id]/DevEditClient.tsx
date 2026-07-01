"use client";

import { useRef, useState } from "react";
import { ElementEditor } from "../../../preview/[id]/ElementEditor";

/**
 * Minimal dev harness for the M4 element editor — no Clerk session. Mounts the scene
 * iframe (served by /api/dev/[id]/iframe) with the ElementEditor overlay pointed at
 * the /api/dev/* edit endpoints. Edit mode is always on here.
 */
export function DevEditClient({
  scriptId,
  sceneLabels,
  width,
  height,
}: {
  scriptId: string;
  sceneLabels: string[];
  width: number;
  height: number;
}) {
  const [sceneIndex, setSceneIndex] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const iframeSrc = `/api/dev/${scriptId}/iframe?scene=${sceneIndex}&v=${reloadKey}`;

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 15, color: "#333", marginBottom: 12 }}>
        Dev element editor · <span style={{ fontFamily: "monospace", color: "#888" }}>{scriptId}</span>
      </h1>
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
        <ElementEditor
          iframeRef={iframeRef}
          scriptId={scriptId}
          sceneIndex={sceneIndex}
          reloadKey={reloadKey}
          canvasWidth={width}
          onChanged={() => setReloadKey((k) => k + 1)}
          apiBase="/api/dev"
        />
      </div>
      <div style={{ display: "flex", gap: 6, marginTop: 12, flexWrap: "wrap" }}>
        {sceneLabels.map((label, i) => (
          <button
            key={i}
            type="button"
            onClick={() => {
              setSceneIndex(i);
              setReloadKey((k) => k + 1);
            }}
            style={{
              borderRadius: 999,
              border: "1px solid " + (i === sceneIndex ? "#6366f1" : "#ddd"),
              background: i === sceneIndex ? "#eef" : "#fff",
              color: "#333",
              padding: "5px 12px",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            <span style={{ fontFamily: "monospace", color: "#aaa" }}>{i + 1}</span> {label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          style={{ borderRadius: 999, border: "1px solid #ddd", background: "#fff", padding: "5px 12px", fontSize: 12, cursor: "pointer" }}
        >
          Reload
        </button>
      </div>
    </div>
  );
}
