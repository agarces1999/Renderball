"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { BrandPanel } from "../../../components/BrandPanel";
import { ShareButton } from "../../../components/ShareButton";
import { BlankDocumentPanel } from "../../../components/BlankDocumentPanel";
import Link from "next/link";
import type { Script } from "../../../src/schema";
import { cn } from "../../../lib/cn";
import {
  ElementEditor,
  type ElementEditorHandle,
  type EditorState,
} from "./ElementEditor";
import {
  EditorShell,
  type EditorToolController,
} from "../../../components/EditorShell";

interface Props {
  scriptId: string;
  script: Script;
  /** Persisted warnings.json contents, loaded server-side on first view. */
  initialWarnings?: Record<string, unknown> | null;
  /** True when this document has never been generated into — drives the
   *  empty state that offers "generate every page" vs "build it yourself". */
  isBlank?: boolean;
}

/**
 * Client-side preview of the agent-emitted Composition.tsx.
 *
 * Each scene is rendered server-side via /api/preview/[id]/iframe?scene=N and
 * mounted in an <iframe> (esbuild compiles Composition.tsx on demand, so every
 * request reads fresh source — per-scene "Regenerate" writes new source and
 * the next iframe load picks it up). Scene change = iframe.src change = the
 * browser reloads the iframe so CSS animations restart.
 *
 * Chrome stays quiet (DESIGN.md): a dark canvas frames the brand-colored
 * work, controls use the greyscale + emerald tokens, and the one loud action
 * is the export (PDF/PNG for decks, MP4 for videos).
 */
type Mp4State =
  | { kind: "idle" }
  | { kind: "rendering" }
  | { kind: "done"; url: string }
  | { kind: "error"; message: string };

/**
 * Soft quality warnings the pipeline can attach to a build result. Matches
 * BuildWarnings in pipeline.ts. All non-blocking — surfaced as quiet notes.
 */
interface PreviewWarnings {
  invented_claims?: string[];
  low_contrast?: { fg: string; bg: string; ratio: number }[];
  missing_charts?: string[];
  throughline_drift?: {
    slug: string;
    axis: "x" | "y" | "both";
    driftX: number;
    driftY: number;
    occurrences: number;
  }[];
  duplicate_logo?: number;
  overflow_crop?: number[];
  /**
   * Structural gate failures that survived every retry ("gate_key: detail").
   * The LOUD tier — shipped-broken class (render crashes, drawn logo replicas,
   * severe contrast), rendered as its own alarm panel, not a quiet note.
   */
  structural_unresolved?: string[];
}

export function PreviewClient({ scriptId, script, initialWarnings, isBlank = false }: Props) {
  // Canvas pivot (docs/PIVOT.md): decks are static page documents — no
  // autoplay, pages render settled, and export is PDF/PNG instead of MP4.
  const isDeck = script.config.kind === "deck";
  // Page ops (add/remove/reorder/duplicate) restructure the scene list —
  // `doc` is the live document; the server-loaded `script` prop is its seed.
  const [doc, setDoc] = useState(script);
  const [sceneIndex, setSceneIndex] = useState(0);
  const [panelTab, setPanelTab] = useState<"page" | "brand">("page");
  // Only while the document is untouched — an empty state, not a mode.
  const [showBlankPanel, setShowBlankPanel] = useState(isBlank);
  const [playing, setPlaying] = useState(!isDeck);
  const [pageBusy, setPageBusy] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [regenerating, setRegenerating] = useState(false);
  const [regenError, setRegenError] = useState<string | null>(null);
  // Instructed regen (DESIGN.md flow step 6: "say what to change, it regenerates").
  // The button opens this ask; the API rejects blind rerolls.
  const [regenAsk, setRegenAsk] = useState(false);
  const [regenInstruction, setRegenInstruction] = useState("");
  const [mp4State, setMp4State] = useState<Mp4State>({ kind: "idle" });
  // PDF/PNG export is a multi-second server-side render. The buttons carry
  // their own busy state, and a failure lands here — never as a navigation
  // away from the editor to the raw response body.
  const [exporting, setExporting] = useState<"pdf" | "png" | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  // 402 from the metering gate — a plan limit, not a failure. The way forward
  // is /billing, so it gets its own quiet surface instead of the red strip.
  const [regenLimit, setRegenLimit] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<PreviewWarnings | null>(
    (initialWarnings as PreviewWarnings | null) ?? null,
  );
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const dims = useMemo(() => getDimensions(doc), [doc]);

  // Auto-advance scenes when playing (never while editing elements, never on decks).
  useEffect(() => {
    if (isDeck || !playing || editing) return;
    const scene = doc.scenes[sceneIndex];
    if (!scene) return;
    const startSec = scene.start_seconds ?? 0;
    const endSec = scene.end_seconds ?? 0;
    const durMs = Math.max(0, (endSec - startSec) * 1000);
    if (durMs <= 0) return;
    const t = setTimeout(() => {
      setSceneIndex((i) => (i + 1) % doc.scenes.length);
      setReloadKey((k) => k + 1);
    }, durMs);
    return () => clearTimeout(t);
  }, [sceneIndex, playing, editing, isDeck, doc.scenes, reloadKey]);

  const replayScene = () => setReloadKey((k) => k + 1);
  const selectScene = (i: number) => {
    setSceneIndex(i);
    setReloadKey((k) => k + 1);
    // The typed instruction is about ONE scene — a new scene gets a fresh ask.
    setRegenAsk(false);
    setRegenInstruction("");
    // Errors describe an op on the page just left — they must not follow the
    // user onto a page they say nothing about.
    setRegenError(null);
    setPageError(null);
  };

  const handleRegenerate = async () => {
    const instruction = regenInstruction.trim();
    if (!instruction) return;
    setRegenerating(true);
    setRegenError(null);
    setRegenLimit(null);
    try {
      const res = await fetch("/api/preview/regenerate-scene", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scriptId, sceneIndex, instruction }),
      });
      if (!res.ok) {
        // The route answers JSON ({"error": "..."}) with a human-written
        // message for the designed outcomes (hourly cap, breaker, tokens) —
        // surface that sentence, never the wire format.
        const txt = await res.text();
        let friendly: string | null = null;
        try {
          friendly = (JSON.parse(txt) as { error?: string }).error ?? null;
        } catch {
          /* non-JSON body — fall through to the raw text */
        }
        if (res.status === 402) {
          setRegenLimit(
            friendly ?? "This document has used its included tokens.",
          );
          return;
        }
        throw new Error(friendly ?? (txt || `regeneration failed (${res.status})`));
      }
      const json = (await res.json()) as {
        ok: true;
        warnings?: PreviewWarnings;
      };
      if (json.warnings) setWarnings(json.warnings);
      setRegenAsk(false);
      setRegenInstruction("");
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
        let friendly: string | null = null;
        try {
          friendly = (JSON.parse(txt) as { error?: string }).error ?? null;
        } catch {
          /* non-JSON body — fall through to the raw text */
        }
        setMp4State({
          kind: "error",
          message: friendly ?? (txt || `render failed (${res.status})`),
        });
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

  // Fetch-driven export. The route SSRs every page through a headless browser
  // (multi-second) and, on failure, answers plain text with no attachment
  // header — a bare <a> would navigate the editor away to that text. Fetching
  // keeps the user in place: a busy label while it renders, a dismissible
  // message if it fails, a normal download if it succeeds.
  const handleExport = async (format: "pdf" | "png") => {
    if (exporting) return;
    setExportError(null);
    setExporting(format);
    try {
      const qs =
        format === "png" ? `format=png&scene=${sceneIndex}` : "format=pdf";
      const res = await fetch(`/api/preview/${scriptId}/export?${qs}`);
      if (!res.ok) {
        const txt = (await res.text()).trim();
        let friendly: string | null = null;
        try {
          friendly = (JSON.parse(txt) as { error?: string }).error ?? null;
        } catch {
          /* non-JSON body — fall through to the raw text */
        }
        setExportError(friendly ?? (txt || `export failed (${res.status})`));
        return;
      }
      const blob = await res.blob();
      const name =
        res.headers
          .get("content-disposition")
          ?.match(/filename="([^"]+)"/)?.[1] ?? `${scriptId}.${format}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(null);
    }
  };

  const currentScene = doc.scenes[sceneIndex];

  // Structural page edit → POST, adopt the returned script, focus the page the
  // op points at. Deterministic + fast; the iframe reload shows the result.
  const pageOp = async (
    op:
      | { op: "duplicate"; page: number }
      | { op: "remove"; page: number }
      | { op: "move"; page: number; to: number }
      | { op: "add"; after: number },
  ) => {
    setPageBusy(true);
    setPageError(null);
    try {
      const res = await fetch("/api/preview/page-op", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scriptId, ...op }),
      });
      const json = (await res.json()) as {
        ok?: true;
        focus?: number;
        script?: typeof script;
        error?: string;
      };
      if (!res.ok || !json.script) {
        throw new Error(json.error ?? `page operation failed (${res.status})`);
      }
      setDoc(json.script);
      setSceneIndex(Math.min(json.focus ?? 0, json.script.scenes.length - 1));
      setReloadKey((k) => k + 1);
    } catch (e) {
      setPageError(e instanceof Error ? e.message : String(e));
    } finally {
      setPageBusy(false);
    }
  };
  // Edit mode renders SETTLED (entry animations at their end state): interactions are
  // instant and rects are stable — you edit a static scene, you WATCH motion in play
  // mode. Toggling edit changes the src, so the browser swaps modes naturally.
  const iframeSrc = `/api/preview/${scriptId}/iframe?scene=${sceneIndex}&v=${reloadKey}${editing || isDeck ? "&settle=1" : ""}`;

  const hasWarnings =
    warnings &&
    (warnings.invented_claims?.length ||
      warnings.low_contrast?.length ||
      warnings.missing_charts?.length ||
      warnings.throughline_drift?.length ||
      (warnings.duplicate_logo ?? 0) > 1 ||
      warnings.overflow_crop?.length);

  // Tool state for the shell toolbar (deck path). ElementEditor reports its
  // state up through onState; the toolbar buttons drive it back through the ref.
  const editorRef = useRef<ElementEditorHandle>(null);
  const [ed, setEd] = useState<EditorState>({
    tool: "select",
    showAll: false,
    canUndo: false,
    busy: null,
  });
  // One busy flag for the whole shell: element edits, regen, and page ops all
  // rewrite state under the canvas, so every structural control gates on it —
  // a page op mid-regen would land the regen on whatever page took its index.
  const shellBusy = !!ed.busy || regenerating || pageBusy;
  const controls: EditorToolController = {
    tool: ed.tool,
    canUndo: ed.canUndo,
    busy: shellBusy,
    select: () => {
      if (ed.tool === "generate") editorRef.current?.toggleGenerate();
    },
    generate: () => editorRef.current?.toggleGenerate(),
    addText: () => editorRef.current?.addText(),
    addImage: () => editorRef.current?.addImage(),
    undo: () => editorRef.current?.undo(),
  };

  // ── Decks: the app-shell editor (matches the landing) ───────────────────
  // Videos keep the classic playback surface below; decks are static design
  // documents, so the editor is always live (no "edit mode" toggle) and the
  // loud action is PDF/PNG export, not MP4.
  if (isDeck) {
    return (
      <div className="min-h-screen bg-canvas">
        <EditorShell
          slides={doc.scenes.map((s) => ({ label: s.label ?? "Slide" }))}
          active={sceneIndex}
          onSelect={selectScene}
          onAddSlide={() => {
            if (!shellBusy) void pageOp({ op: "add", after: sceneIndex });
          }}
          width={dims.width}
          height={dims.height}
          status={shellBusy ? "saving" : "saved"}
          controls={controls}
          actions={
            <>
              {/* While the document is still blank, the full-deck path stays
                  one click away even after the start panel was dismissed —
                  dismissing an empty state must not bury the product's
                  expensive-but-headline capability. */}
              {isBlank && !showBlankPanel && (
                <button
                  type="button"
                  onClick={() => setShowBlankPanel(true)}
                  className="rounded-md border border-accent-line bg-accent-soft px-3 py-1.5 text-[12px] font-medium text-ink transition-all hover:brightness-105"
                >
                  Generate every page
                </button>
              )}
              <button
                type="button"
                onClick={() => setRegenAsk((a) => !a)}
                disabled={shellBusy}
                className={cn(
                  "rounded-md border px-3 py-1.5 text-[12px] transition-colors disabled:opacity-50",
                  regenAsk
                    ? "border-accent-line bg-accent-soft text-ink"
                    : "border-hairline-strong text-muted hover:text-ink",
                )}
              >
                {regenerating ? "Regenerating…" : "Regenerate"}
              </button>
              <ShareButton scriptId={scriptId} />
              <button
                type="button"
                onClick={() => void handleExport("png")}
                disabled={exporting !== null}
                className="rounded-md border border-hairline-strong bg-surface px-3 py-1.5 text-[12px] text-ink transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {exporting === "png" ? "Exporting…" : "PNG"}
              </button>
              <button
                type="button"
                onClick={() => void handleExport("pdf")}
                disabled={exporting !== null}
                className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-1.5 text-[12px] font-semibold text-accent-ink transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {exporting === "pdf" ? (
                  <>
                    <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent-ink" />
                    Exporting PDF…
                  </>
                ) : (
                  "Export PDF →"
                )}
              </button>
            </>
          }
          banner={
            <DeckBanner
              regenAsk={regenAsk && !regenerating}
              regenInstruction={regenInstruction}
              onRegenInstruction={setRegenInstruction}
              onRegenSubmit={() => void handleRegenerate()}
              onRegenCancel={() => setRegenAsk(false)}
              regenError={regenError}
              pageError={pageError}
              onErrorDismiss={() => {
                setRegenError(null);
                setPageError(null);
              }}
              regenLimit={regenLimit}
              onLimitDismiss={() => setRegenLimit(null)}
              exportError={exportError}
              onExportDismiss={() => setExportError(null)}
              structural={warnings?.structural_unresolved ?? null}
              warnings={hasWarnings ? warnings : null}
            />
          }
          sidePanel={
            // Page inspector and brand live in the same column: brand is a
            // document-level concern, so it belongs beside the canvas rather
            // than buried in a per-element menu.
            <div className="flex h-full flex-col">
              <div className="flex shrink-0 gap-1 border-b border-hairline px-3 pt-2.5">
                {(["page", "brand"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
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
                  <BrandPanel
                    scriptId={scriptId}
                    onApplied={() => setReloadKey((k) => k + 1)}
                  />
                ) : (
                  <DeckPagePanel
                    index={sceneIndex}
                    total={doc.scenes.length}
                    description={currentScene?.description ?? null}
                    busy={shellBusy}
                    onOp={(op) => void pageOp(op)}
                  />
                )}
              </div>
            </div>
          }
          footer={
            <Link href="/documents" className="transition-colors hover:text-ink">
              ← Documents
            </Link>
          }
        >
          {showBlankPanel && (
            <BlankDocumentPanel
              scriptId={scriptId}
              onDismiss={() => setShowBlankPanel(false)}
            />
          )}
          <iframe
            ref={iframeRef}
            src={iframeSrc}
            title={`Page ${sceneIndex + 1}`}
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: 0 }}
          />
          <ElementEditor
            ref={editorRef}
            iframeRef={iframeRef}
            scriptId={scriptId}
            sceneIndex={sceneIndex}
            reloadKey={reloadKey}
            canvasWidth={dims.width}
            onChanged={() => setReloadKey((k) => k + 1)}
            hideToolbar
            onState={setEd}
          />
        </EditorShell>
      </div>
    );
  }

  return (
    <div>
      {/* Canvas — the user's brand-colored work; dark frame so it's the loudest thing */}
      <div
        className="relative mb-5 overflow-hidden rounded-lg border border-hairline bg-[#0b0d12]"
        style={{ aspectRatio: `${dims.width}/${dims.height}` }}
      >
        <iframe
          ref={iframeRef}
          src={iframeSrc}
          title={`${isDeck ? "Page" : "Scene"} ${sceneIndex + 1}`}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            border: 0,
            background: "#0b0d12",
          }}
        />
        {editing && (
          <ElementEditor
            iframeRef={iframeRef}
            scriptId={scriptId}
            sceneIndex={sceneIndex}
            reloadKey={reloadKey}
            canvasWidth={dims.width}
            onChanged={() => setReloadKey((k) => k + 1)}
          />
        )}
      </div>

      {/* Scene rail */}
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        {doc.scenes.map((s, i) => (
          <button
            key={i}
            type="button"
            onClick={() => selectScene(i)}
            className={cn(
              "rounded-full border px-3 py-1.5 text-[12px] transition-colors",
              i === sceneIndex
                ? "border-accent-line bg-accent-soft text-ink"
                : "border-hairline-strong text-muted hover:text-ink",
            )}
          >
            <span className="font-mono text-faint">{i + 1}</span>{" "}
            {s.label}
          </button>
        ))}
      </div>

      {/* Page operations — deck-only structural edits (deterministic, free) */}
      {isDeck && (
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 font-mono text-[11px] uppercase tracking-[0.14em] text-faint">
            Page {sceneIndex + 1}
          </span>
          <button
            type="button"
            onClick={() => void pageOp({ op: "move", page: sceneIndex, to: sceneIndex - 1 })}
            disabled={pageBusy || sceneIndex === 0}
            title="Move page left"
            className="rounded-md border border-hairline-strong bg-surface px-2.5 py-1.5 text-[12px] text-muted transition-colors hover:text-ink disabled:opacity-40"
          >
            ←
          </button>
          <button
            type="button"
            onClick={() => void pageOp({ op: "move", page: sceneIndex, to: sceneIndex + 1 })}
            disabled={pageBusy || sceneIndex >= doc.scenes.length - 1}
            title="Move page right"
            className="rounded-md border border-hairline-strong bg-surface px-2.5 py-1.5 text-[12px] text-muted transition-colors hover:text-ink disabled:opacity-40"
          >
            →
          </button>
          <button
            type="button"
            onClick={() => void pageOp({ op: "duplicate", page: sceneIndex })}
            disabled={pageBusy}
            className="rounded-md border border-hairline-strong bg-surface px-3 py-1.5 text-[12px] text-muted transition-colors hover:text-ink disabled:opacity-40"
          >
            Duplicate
          </button>
          <button
            type="button"
            onClick={() => void pageOp({ op: "add", after: sceneIndex })}
            disabled={pageBusy}
            className="rounded-md border border-hairline-strong bg-surface px-3 py-1.5 text-[12px] text-muted transition-colors hover:text-ink disabled:opacity-40"
          >
            + Blank page
          </button>
          <button
            type="button"
            onClick={() => void pageOp({ op: "remove", page: sceneIndex })}
            disabled={pageBusy || doc.scenes.length <= 1}
            className="rounded-md border border-hairline-strong bg-surface px-3 py-1.5 text-[12px] text-muted transition-colors hover:text-red-500 disabled:opacity-40"
          >
            Delete page
          </button>
          {pageBusy && <span className="text-[12px] text-faint">Applying…</span>}
          {pageError && <span className="text-[12px] text-red-500">{pageError}</span>}
        </div>
      )}

      {/* Playback + actions */}
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => {
            setEditing((e) => {
              const next = !e;
              if (next) setPlaying(false);
              return next;
            });
            setReloadKey((k) => k + 1);
          }}
          className={cn(
            "rounded-md border px-4 py-2 text-[13px] transition-colors",
            editing
              ? "border-accent-line bg-accent-soft text-ink"
              : "border-hairline-strong bg-surface text-ink hover:bg-surface-2",
          )}
        >
          {editing ? "Done editing" : "Edit elements"}
        </button>
        {!isDeck && (
          <>
            <button
              type="button"
              onClick={() => setPlaying((p) => !p)}
              disabled={editing}
              className="rounded-md border border-hairline-strong bg-surface px-4 py-2 text-[13px] text-ink transition-colors hover:bg-surface-2 disabled:opacity-40"
            >
              {playing ? "Pause" : "Play"}
            </button>
            <button
              type="button"
              onClick={replayScene}
              className="rounded-md border border-hairline-strong bg-surface px-4 py-2 text-[13px] text-ink transition-colors hover:bg-surface-2"
            >
              Replay scene
            </button>
          </>
        )}
        <button
          type="button"
          onClick={() => setRegenAsk((a) => !a)}
          disabled={regenerating}
          className={cn(
            "rounded-md border px-4 py-2 text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-50",
            regenAsk
              ? "border-accent-line bg-accent-soft text-ink"
              : "border-hairline-strong text-muted hover:text-ink",
          )}
        >
          {regenerating
            ? "Regenerating…"
            : `Regenerate ${isDeck ? "page" : "scene"} ${sceneIndex + 1}`}
        </button>
        {regenAsk && !regenerating && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleRegenerate();
            }}
            className="flex items-center gap-2"
          >
            <input
              autoFocus
              value={regenInstruction}
              onChange={(e) => setRegenInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setRegenAsk(false);
              }}
              placeholder={`What should change on this ${isDeck ? "page" : "scene"}?`}
              className="w-72 rounded-md border border-hairline-strong bg-surface-2 px-3 py-2 text-[13px] text-ink placeholder:text-faint outline-none focus:border-accent-line"
            />
            <button
              type="submit"
              disabled={!regenInstruction.trim()}
              className="rounded-md bg-accent px-4 py-2 text-[13px] font-medium text-accent-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Go
            </button>
          </form>
        )}

        <div className="ml-auto flex items-center gap-2">
          {isDeck ? (
            <>
              <button
                type="button"
                onClick={() => void handleExport("png")}
                disabled={exporting !== null}
                className="rounded-md border border-hairline-strong bg-surface px-4 py-2 text-[13px] text-ink transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {exporting === "png"
                  ? "Exporting…"
                  : `Page ${sceneIndex + 1} PNG`}
              </button>
              <button
                type="button"
                onClick={() => void handleExport("pdf")}
                disabled={exporting !== null}
                className="inline-flex items-center gap-2 rounded-md bg-accent px-5 py-2 text-[13px] font-semibold text-accent-ink transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {exporting === "pdf" ? (
                  <>
                    <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent-ink" />
                    Exporting PDF…
                  </>
                ) : (
                  "Export PDF →"
                )}
              </button>
            </>
          ) : mp4State.kind === "done" ? (
            <a
              href={mp4State.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-md bg-accent px-5 py-2 text-[13px] font-semibold text-accent-ink transition-all hover:brightness-110"
            >
              View MP4 ↗
            </a>
          ) : (
            <button
              type="button"
              onClick={handleRenderMp4}
              disabled={mp4State.kind === "rendering"}
              className="inline-flex items-center gap-2 rounded-md bg-accent px-5 py-2 text-[13px] font-semibold text-accent-ink transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {mp4State.kind === "rendering" ? (
                <>
                  <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent-ink" />
                  Rendering MP4… (~2-4 min)
                </>
              ) : (
                "Export MP4 →"
              )}
            </button>
          )}
        </div>
      </div>

      {mp4State.kind === "error" && (
        <div className="mb-4 whitespace-pre-wrap rounded-md border border-red-500/30 bg-red-500/5 p-4 font-mono text-[12px] text-red-500">
          MP4 render failed: {mp4State.message}
        </div>
      )}

      {exportError && (
        <ErrorStrip
          message={exportError}
          onDismiss={() => setExportError(null)}
          className="mb-4"
        />
      )}

      {regenLimit && (
        <LimitStrip
          message={regenLimit}
          onDismiss={() => setRegenLimit(null)}
          className="mb-4"
        />
      )}

      {warnings?.structural_unresolved &&
      warnings.structural_unresolved.length > 0 ? (
        <StructuralPanel issues={warnings.structural_unresolved} />
      ) : null}

      {hasWarnings ? <WarningsPanel warnings={warnings!} /> : null}

      {regenError && (
        <ErrorStrip
          message={regenError}
          onDismiss={() => setRegenError(null)}
          className="mb-4"
        />
      )}

      {/* Current page/scene meta — deck pages have no meaningful duration */}
      {currentScene && (
        <div className="font-mono text-[12px] text-muted">
          <div>
            {isDeck
              ? `page ${sceneIndex + 1}/${doc.scenes.length}`
              : `scene ${sceneIndex + 1}/${script.scenes.length} · ${(
                  (currentScene.end_seconds ?? 0) -
                  (currentScene.start_seconds ?? 0)
                ).toFixed(1)}s`}
          </div>
          {currentScene.description && (
            <div className="mt-1 italic text-faint">
              {currentScene.description}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type PageOp =
  | { op: "duplicate"; page: number }
  | { op: "remove"; page: number }
  | { op: "move"; page: number; to: number }
  | { op: "add"; after: number };

/**
 * The strip between the deck toolbar and canvas: an open regen form, then any
 * quality warnings and errors. Empty (renders nothing) in the common case.
 */
function DeckBanner({
  regenAsk,
  regenInstruction,
  onRegenInstruction,
  onRegenSubmit,
  onRegenCancel,
  regenError,
  pageError,
  onErrorDismiss,
  regenLimit,
  onLimitDismiss,
  exportError,
  onExportDismiss,
  structural,
  warnings,
}: {
  regenAsk: boolean;
  regenInstruction: string;
  onRegenInstruction: (v: string) => void;
  onRegenSubmit: () => void;
  onRegenCancel: () => void;
  regenError: string | null;
  pageError: string | null;
  onErrorDismiss: () => void;
  regenLimit: string | null;
  onLimitDismiss: () => void;
  exportError: string | null;
  onExportDismiss: () => void;
  structural: string[] | null;
  warnings: PreviewWarnings | null;
}) {
  const anything =
    regenAsk ||
    regenError ||
    pageError ||
    regenLimit ||
    exportError ||
    (structural && structural.length > 0) ||
    warnings;
  if (!anything) return null;
  return (
    <div className="space-y-2">
      {regenAsk && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onRegenSubmit();
          }}
          className="flex items-center gap-2 rounded-lg border border-hairline bg-surface px-2.5 py-2"
        >
          <span className="shrink-0 font-mono text-[10.5px] uppercase tracking-[0.14em] text-faint">
            Regenerate this page
          </span>
          <input
            autoFocus
            value={regenInstruction}
            onChange={(e) => onRegenInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onRegenCancel();
            }}
            placeholder="What should change on this page?"
            className="min-w-0 flex-1 rounded-md border border-hairline-strong bg-surface-2 px-3 py-1.5 text-[13px] text-ink placeholder:text-faint outline-none focus:border-accent-line"
          />
          <button
            type="submit"
            disabled={!regenInstruction.trim()}
            className="shrink-0 rounded-md bg-accent px-4 py-1.5 text-[13px] font-medium text-accent-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Go
          </button>
        </form>
      )}
      {regenLimit && (
        <LimitStrip message={regenLimit} onDismiss={onLimitDismiss} />
      )}
      {structural && structural.length > 0 && <StructuralPanel issues={structural} />}
      {warnings && <WarningsPanel warnings={warnings} />}
      {(pageError || regenError) && (
        <ErrorStrip
          message={(pageError ?? regenError)!}
          onDismiss={onErrorDismiss}
        />
      )}
      {exportError && (
        <ErrorStrip message={exportError} onDismiss={onExportDismiss} />
      )}
    </div>
  );
}

/**
 * Red error surface with a dismiss control — an error must never park itself
 * over the work with no way to close it.
 */
function ErrorStrip({
  message,
  onDismiss,
  className,
}: {
  message: string;
  onDismiss: () => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-3 rounded-md border border-red-500/30 bg-red-500/5 p-3",
        className,
      )}
    >
      <div className="whitespace-pre-wrap font-mono text-[12px] text-red-500">
        {message}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="shrink-0 rounded px-1 text-[14px] leading-none text-red-500/70 transition-colors hover:text-red-500"
      >
        ×
      </button>
    </div>
  );
}

/**
 * Out of tokens is a plan limit, not a failure — quiet accent surface with
 * the way forward (/billing), mirroring BuildPreviewClient's limit screen.
 */
function LimitStrip({
  message,
  onDismiss,
  className,
}: {
  message: string;
  onDismiss: () => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 rounded-md border border-accent-line bg-accent-soft p-3",
        className,
      )}
    >
      <span className="text-[13px] text-ink">{message}</span>
      <span className="flex shrink-0 items-center gap-3">
        <Link
          href="/billing"
          className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-semibold text-accent-ink transition-all hover:brightness-110"
        >
          See plans →
        </Link>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="rounded px-1 text-[14px] leading-none text-muted transition-colors hover:text-ink"
        >
          ×
        </button>
      </span>
    </div>
  );
}

/** The deck's per-page inspector — structural ops on the active page. */
export function DeckPagePanel({
  index,
  total,
  description,
  busy,
  onOp,
}: {
  index: number;
  total: number;
  description: string | null;
  busy: boolean;
  onOp: (op: PageOp) => void;
}) {
  return (
    <div className="rounded-xl border border-hairline bg-surface px-4 py-3.5">
      <div className="mb-1.5 font-mono text-[10.5px] uppercase tracking-[0.14em] text-faint">
        Page {index + 1} of {total}
      </div>
      {description && (
        <p className="mb-3 text-[13px] leading-relaxed text-ink-soft">{description}</p>
      )}
      <div className="border-t border-hairline pt-3">
        <div className="mb-2 font-mono text-[10.5px] uppercase tracking-[0.14em] text-faint">
          Page actions
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <PageOpBtn onClick={() => onOp({ op: "move", page: index, to: index - 1 })} disabled={busy || index === 0}>
            ← Move left
          </PageOpBtn>
          <PageOpBtn onClick={() => onOp({ op: "move", page: index, to: index + 1 })} disabled={busy || index >= total - 1}>
            Move right →
          </PageOpBtn>
          <PageOpBtn onClick={() => onOp({ op: "duplicate", page: index })} disabled={busy}>
            Duplicate
          </PageOpBtn>
          <PageOpBtn onClick={() => onOp({ op: "add", after: index })} disabled={busy}>
            + Blank page
          </PageOpBtn>
          <PageOpBtn onClick={() => onOp({ op: "remove", page: index })} disabled={busy || total <= 1} danger>
            Delete page
          </PageOpBtn>
        </div>
        {busy && <div className="mt-2 text-[12px] text-faint">Applying…</div>}
      </div>
    </div>
  );
}

function PageOpBtn({
  onClick,
  disabled,
  danger,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "rounded-md border border-hairline-strong bg-surface px-2.5 py-1.5 text-[12px] text-muted transition-colors disabled:opacity-40",
        danger ? "hover:text-red-500" : "hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

/**
 * The LOUD tier — structural gate failures that survived every retry. Unlike
 * the quiet notes below, these are shipped-broken-class defects (a scene that
 * crashes at render, a hand-drawn logo replica, severe contrast), so the panel
 * uses the error-red convention (red-500 alpha, same as the MP4-failure and
 * regen-error surfaces) and sits above the notes. It still must not fight the
 * brand-color preview: a thin alarm strip, not a wall of red.
 */
function StructuralPanel({ issues }: { issues: string[] }) {
  return (
    <div className="mb-4 rounded-md border border-red-500/30 bg-red-500/5 p-4">
      <div className="mb-1.5 font-mono text-[11px] uppercase tracking-[0.16em] text-red-500">
        Unresolved structural issues ({issues.length})
      </div>
      <div className="mb-2.5 text-[12px] text-ink-soft">
        These failed the build&apos;s structural quality gates and survived
        every automatic retry — the design shipped with them. Regenerate the
        affected page or scene, or rebuild, to clear them.
      </div>
      <ul className="space-y-1">
        {issues.slice(0, 10).map((issue, i) => {
          const sep = issue.indexOf(":");
          const gate = sep > 0 ? issue.slice(0, sep) : null;
          const detail = sep > 0 ? issue.slice(sep + 1).trim() : issue;
          return (
            <li key={i} className="flex items-baseline gap-2 text-[12px]">
              <span className="mt-1 inline-block h-1.5 w-1.5 shrink-0 self-center rounded-full bg-red-500" />
              {gate && (
                <span className="shrink-0 font-mono text-[11px] text-red-500">
                  {gate}
                </span>
              )}
              <span className="text-ink-soft">{detail}</span>
            </li>
          );
        })}
        {issues.length > 10 && (
          <li className="font-mono text-[11px] text-muted">
            +{issues.length - 10} more in warnings.json
          </li>
        )}
      </ul>
    </div>
  );
}

/**
 * Soft quality notes — the BuildWarnings the validators produced (invented
 * numeric claims, low-contrast pairs, scenes missing charts, drifting motifs,
 * duplicate logos, cropped elements). All non-blocking: the design ships
 * either way; this panel just makes the issues visible so the user can decide
 * whether to regenerate the affected scene. Quiet on purpose (surface-2 +
 * muted), not an alarm.
 */
function WarningsPanel({ warnings }: { warnings: PreviewWarnings }) {
  return (
    <div className="mb-6 rounded-md border border-hairline bg-surface-2 p-4">
      <div className="mb-3 font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
        Quality notes
      </div>
      <div className="space-y-3">
        {warnings.invented_claims && warnings.invented_claims.length > 0 && (
          <div>
            <div className="mb-1.5 text-[11px] text-muted">
              Invented numeric claims ({warnings.invented_claims.length}) — not
              supported by your brief, body excerpts, or verified claims
            </div>
            <div className="flex flex-wrap gap-1.5">
              {warnings.invented_claims.slice(0, 8).map((c, i) => (
                <span
                  key={i}
                  className="rounded border border-hairline-strong bg-surface px-2 py-0.5 font-mono text-[11px] text-ink-soft"
                >
                  {c}
                </span>
              ))}
            </div>
          </div>
        )}

        {warnings.low_contrast && warnings.low_contrast.length > 0 && (
          <div>
            <div className="mb-1.5 text-[11px] text-muted">
              Low-contrast text pairings ({warnings.low_contrast.length}) — below
              WCAG 4.5:1
            </div>
            <div className="flex flex-wrap gap-2">
              {warnings.low_contrast.slice(0, 8).map((c, i) => (
                <span
                  key={i}
                  className="flex items-center gap-1.5 rounded border border-hairline-strong bg-surface px-2 py-0.5 font-mono text-[11px] text-ink-soft"
                  title={`fg ${c.fg} on bg ${c.bg} — ${c.ratio}:1`}
                >
                  <span style={{ color: c.fg, background: c.bg, padding: "0 4px", borderRadius: 2 }}>
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
            <div className="mb-1.5 text-[11px] text-muted">
              Scenes with numeric data but no chart — consider regenerating with
              a real visualization
            </div>
            <div className="flex flex-wrap gap-1.5">
              {warnings.missing_charts.slice(0, 8).map((s, i) => (
                <span
                  key={i}
                  className="rounded border border-hairline-strong bg-surface px-2 py-0.5 text-[11px] text-ink-soft"
                >
                  {s}
                </span>
              ))}
            </div>
          </div>
        )}

        {warnings.throughline_drift && warnings.throughline_drift.length > 0 && (
          <div>
            <div className="mb-1.5 text-[11px] text-muted">
              Recurring elements that jump position (
              {warnings.throughline_drift.length}) — a motif moves &gt;10% of the
              canvas between scenes
            </div>
            <div className="flex flex-wrap gap-1.5">
              {warnings.throughline_drift.slice(0, 6).map((d, i) => (
                <span
                  key={i}
                  className="rounded border border-hairline-strong bg-surface px-2 py-0.5 font-mono text-[11px] text-ink-soft"
                  title={`"${d.slug}" appears in ${d.occurrences} scenes; drifts ${d.driftX}px x / ${d.driftY}px y`}
                >
                  {d.slug} ·{" "}
                  {d.axis === "both"
                    ? `${d.driftX}×${d.driftY}px`
                    : d.axis === "x"
                      ? `${d.driftX}px →`
                      : `${d.driftY}px ↓`}
                </span>
              ))}
            </div>
          </div>
        )}

        {warnings.duplicate_logo && warnings.duplicate_logo > 1 && (
          <div className="text-[11px] text-muted">
            Brand logo appears {warnings.duplicate_logo}× — a scene is drawing
            its own logo on top of the persistent brand mark. Regenerate that
            scene to drop the extra.
          </div>
        )}

        {warnings.overflow_crop && warnings.overflow_crop.length > 0 && (
          <div>
            <div className="mb-1.5 text-[11px] text-muted">
              Element(s) cropped at the canvas edge:
            </div>
            <div className="flex flex-wrap gap-1.5">
              {warnings.overflow_crop.slice(0, 8).map((w, i) => (
                <span
                  key={i}
                  className="rounded border border-hairline-strong bg-surface px-2 py-0.5 font-mono text-[11px] text-ink-soft"
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
