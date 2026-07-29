"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ElementEditor,
  type ElementEditorHandle,
  type EditorState,
} from "../../../preview/[id]/ElementEditor";
import {
  EditorShell,
  type EditorToolController,
} from "../../../../components/EditorShell";
import { cn } from "../../../../lib/cn";
import { BrandPanel } from "../../../../components/BrandPanel";
import { DeckPagePanel } from "../../../preview/[id]/PreviewClient";

/**
 * Dev editing harness (no Clerk session; NODE_ENV-gated route). Renders the
 * REAL editor on the shared EditorShell — the same app-shell chrome the
 * landing performs and the product wears — so the shell + ElementEditor loop
 * can be exercised and visually verified without auth.
 *
 * GET /dev/edit/<scriptId>
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
  const [playMotion, setPlayMotion] = useState(false);
  const router = useRouter();
  const [panelTab, setPanelTab] = useState<"copy" | "page" | "brand">("copy");
  const [pageBusy, setPageBusy] = useState(false);

  /**
   * Page operations against the dev twin — add, duplicate, remove, reorder.
   *
   * Mirrors PreviewClient's handler but on /api/dev, so the QA suite can drive
   * page management without a session. The scene index is clamped afterwards
   * because removing the last page would otherwise leave the editor pointed at
   * a page that no longer exists.
   */
  const pageOp = async (
    op:
      | { op: "duplicate"; page: number }
      | { op: "remove"; page: number }
      | { op: "move"; page: number; to: number }
      | { op: "add"; after: number },
  ) => {
    setPageBusy(true);
    try {
      const res = await fetch("/api/dev/page-op", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scriptId, ...op }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; total?: number };
      if (res.ok && json.ok) {
        if (typeof json.total === "number" && json.total > 0) {
          setSceneIndex((i) => Math.min(i, json.total! - 1));
        }
        // The scene list is server-rendered, so the page count only
        // updates on a refresh; the reload key repaints the canvas.
        router.refresh();
        setReloadKey((k) => k + 1);
      }
    } finally {
      setPageBusy(false);
    }
  };
  const [fields, setFields] = useState<Field[]>([]);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // The editor's live tool state, mirrored up so the shell toolbar reflects it.
  const editorRef = useRef<ElementEditorHandle>(null);
  const [ed, setEd] = useState<EditorState>({
    tool: "select",
    showAll: false,
    canUndo: false,
    busy: null,
  });

  const iframeSrc = `/api/dev/${scriptId}/iframe?scene=${sceneIndex}&v=${reloadKey}${playMotion ? "" : "&settle=1"}`;
  const scene = scenes[sceneIndex];

  const goTo = useCallback(
    (i: number) => {
      if (i < 0 || i >= scenes.length) return;
      setSceneIndex(i);
      setReloadKey((k) => k + 1);
    },
    [scenes.length],
  );

  // ←/→ switch scenes (text editing happens inside the iframe, so parent-level
  // arrows never collide with typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") goTo(sceneIndex - 1);
      else if (e.key === "ArrowRight") goTo(sceneIndex + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sceneIndex, goTo]);

  // The inspector's copy fields — refreshed after every edit so it tracks saves.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/dev/edit-element?scriptId=${encodeURIComponent(scriptId)}&sceneIndex=${sceneIndex}`,
        );
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

  const controls: EditorToolController = useMemo(
    () => ({
      tool: ed.tool,
      canUndo: ed.canUndo,
      busy: !!ed.busy || playMotion,
      select: () => {
        if (ed.tool === "generate") editorRef.current?.toggleGenerate();
      },
      generate: () => editorRef.current?.toggleGenerate(),
      addText: () => editorRef.current?.addText(),
      addImage: () => editorRef.current?.addImage(),
      undo: () => editorRef.current?.undo(),
    }),
    [ed, playMotion],
  );

  return (
    <div className="min-h-screen bg-canvas">
      <EditorShell
        slides={scenes.map((s) => ({ label: s.label }))}
        active={sceneIndex}
        onSelect={goTo}
        width={width}
        height={height}
        status={ed.busy ? "saving" : "saved"}
        controls={controls}
        actions={
          <>
            <button
              type="button"
              onClick={() => setReloadKey((k) => k + 1)}
              className="rounded-md border border-hairline-strong bg-surface px-3 py-1.5 text-[12px] text-ink transition-colors hover:bg-surface-2"
            >
              {playMotion ? "Replay" : "Reload"}
            </button>
            <button
              type="button"
              onClick={() => {
                setPlayMotion((p) => !p);
                setReloadKey((k) => k + 1);
              }}
              className={cn(
                "rounded-md border px-3 py-1.5 text-[12px] transition-colors",
                playMotion
                  ? "border-accent-line bg-accent-soft text-ink"
                  : "border-hairline-strong bg-surface text-ink hover:bg-surface-2",
              )}
            >
              {playMotion ? "✎ Edit" : "▶ Play"}
            </button>
          </>
        }
        sidePanel={
          // Copy / Page / Brand, mirroring the real editor. Page ops and brand
          // had NO automated coverage at all — not because they were hard to
          // drive, but because nothing unauthenticated ever rendered their
          // panels, so the QA suite could not reach two of the product's
          // largest surfaces.
          <div className="flex h-full flex-col">
            <div className="flex shrink-0 gap-1 border-b border-hairline px-3 pt-2.5">
              {(["copy", "page", "brand"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  data-rb-devtab={t}
                  onClick={() => setPanelTab(t)}
                  className={
                    "rounded-t-md px-2.5 py-1.5 text-[12px] capitalize transition-colors " +
                    (panelTab === t
                      ? "bg-surface font-semibold text-ink"
                      : "text-muted hover:text-ink")
                  }
                >
                  {t}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {panelTab === "brand" ? (
                <BrandPanel scriptId={scriptId} apiBase="/api/dev" />
              ) : panelTab === "page" ? (
                <DeckPagePanel
                  index={sceneIndex}
                  total={scenes.length}
                  description={scene?.description ?? null}
                  busy={pageBusy}
                  onOp={(op) => void pageOp(op)}
                />
              ) : (
                <ScriptPanel
                  logline={logline}
                  sceneIndex={sceneIndex}
                  total={scenes.length}
                  scene={scene}
                  fields={fields}
                />
              )}
            </div>
          </div>
        }
        footer={<span className="block truncate">{scriptId}</span>}
      >
        <iframe
          ref={iframeRef}
          src={iframeSrc}
          title={`Scene ${sceneIndex + 1}`}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: 0 }}
        />
        {/* While motion plays the overlay unmounts — rects measured mid-animation
            are wrong, and the surface is for watching. */}
        {!playMotion && (
          <ElementEditor
            ref={editorRef}
            iframeRef={iframeRef}
            scriptId={scriptId}
            sceneIndex={sceneIndex}
            reloadKey={reloadKey}
            canvasWidth={width}
            onChanged={() => setReloadKey((k) => k + 1)}
            apiBase="/api/dev"
            hideToolbar
            onState={setEd}
          />
        )}
      </EditorShell>
    </div>
  );
}

/* ─── the script / copy inspector (rehomed into the shell's side panel) ── */

function ScriptPanel({
  logline,
  sceneIndex,
  total,
  scene,
  fields,
}: {
  logline: string | null;
  sceneIndex: number;
  total: number;
  scene: SceneSummary | undefined;
  fields: Field[];
}) {
  return (
    <div className="max-h-full overflow-y-auto rounded-xl border border-hairline bg-surface px-4 py-3.5">
      {logline && (
        <p className="mb-3 font-display text-[14px] font-medium leading-snug tracking-[-0.01em] text-ink-soft">
          {logline}
        </p>
      )}
      <div className="mb-1.5 font-mono text-[10.5px] uppercase tracking-[0.14em] text-faint">
        Slide {sceneIndex + 1} of {total}
      </div>
      <div className="font-display text-[19px] font-bold leading-tight tracking-[-0.015em] text-ink">
        {scene?.label}
      </div>
      <div className="mb-2 font-mono text-[11px] text-faint">
        {Math.round(scene?.seconds ?? 0)}s on screen
      </div>
      {scene?.description && (
        <p className="mb-3 text-[13px] leading-relaxed text-ink-soft">{scene.description}</p>
      )}
      <div className="border-t border-hairline pt-2.5">
        <div className="mb-2 font-mono text-[10.5px] uppercase tracking-[0.14em] text-faint">
          Copy in this slide
        </div>
        {fields.length === 0 && (
          <div className="text-[12.5px] text-faint">No editable copy fields.</div>
        )}
        {fields.map((f) => (
          <div key={f.path} className="mb-2.5">
            <div className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-faint">
              {f.label}
            </div>
            <div className="text-[13px] leading-normal text-ink-soft">{f.value}</div>
          </div>
        ))}
        <div className="mt-3 text-[11px] leading-relaxed text-faint">
          Double-click any text in the canvas to edit it · drag an empty area to generate.
        </div>
      </div>
    </div>
  );
}
