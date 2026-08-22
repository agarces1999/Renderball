"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { BrandPanel } from "../../../components/BrandPanel";
import { ElementPanel } from "../../../components/ElementPanel";
import { ShareButton } from "../../../components/ShareButton";
import { StructuralPanel } from "../../../components/StructuralPanel";
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
 * Reduce an error response body to a sentence a person can read. Routes answer
 * designed failures as JSON {error} with human-written copy — surface that
 * verbatim. Everything else is wire format: a Cloudflare error page mid-deploy,
 * the middleware's HTML rewrite of a dead session, some future bare-text body.
 * None of that may be printed into the editor, so non-JSON falls back to a
 * short status line — with the one hint we can infer (an auth-shaped status
 * means signing in again fixes it).
 */
const friendlyApiError = (txt: string, status: number, op: string): string => {
  try {
    const e = (JSON.parse(txt) as { error?: string }).error;
    if (e) return e;
  } catch {
    /* non-JSON body */
  }
  if (status === 401 || status === 404) {
    return `${op} didn't go through — your session may have expired. Refresh the page and sign in again.`;
  }
  const t = txt.trim();
  // Belt-and-braces: never render markup or a wall of wire text as the message.
  if (!t || t.startsWith("<") || t.length > 300) return `${op} failed (${status})`;
  return t;
};

/**
 * Soft quality warnings the pipeline can attach to a build result. Matches
 * BuildWarnings in pipeline.ts. All non-blocking — surfaced as quiet notes.
 */
interface PreviewWarnings {
  /** Built from a brief with almost nothing in it — the deck carries slots,
   *  not facts, and the user must be told plainly. */
  thin_brief?: { words: number };
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
  render_truth_unresolved?: string[];
  render_truth_advisory?: string[];
}

export function PreviewClient({ scriptId, script, initialWarnings, isBlank = false }: Props) {
  /**
   * THE RE-ENTRY LINE (perception research: peak-end — the finish is what a
   * 20-minute build is remembered by; interrupted users take 10-15 min to
   * re-orient). If the ceremony stashed build facts in this tab, the editor
   * opens with one quiet sentence of what happened while they were away,
   * then never mentions it again.
   */
  const [builtLine, setBuiltLine] = useState<string | null>(null);
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(`rb-build-facts:${scriptId}`);
      if (!raw) return;
      sessionStorage.removeItem(`rb-build-facts:${scriptId}`);
      const facts = JSON.parse(raw) as { startedAt?: number };
      const secs = facts.startedAt ? Math.round((Date.now() - facts.startedAt) / 1000) : null;
      const mins = secs ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}` : null;
      const flags = initialWarnings ? Object.keys(initialWarnings).length : 0;
      setBuiltLine(
        `Built ${script.scenes.length} page${script.scenes.length === 1 ? "" : "s"}${mins ? ` in ${mins}` : ""}${flags ? ` · ${flags} check${flags === 1 ? "" : "s"} flagged below` : " · every check clean"}`,
      );
      document.title = "✓ Ready — Renderball";
      const t = setTimeout(() => {
        if (document.title.startsWith("✓")) document.title = "Renderball";
      }, 4000);
      return () => clearTimeout(t);
    } catch {
      /* no facts — a normal open */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Canvas pivot (docs/PIVOT.md): decks are static page documents — no
  // autoplay, pages render settled, and export is PDF/PNG instead of MP4.
  const isDeck = script.config.kind === "deck";
  // Page ops (add/remove/reorder/duplicate) restructure the scene list —
  // `doc` is the live document; the server-loaded `script` prop is its seed.
  const [doc, setDoc] = useState(script);
  const [sceneIndex, setSceneIndex] = useState(0);
  const [panelTab, setPanelTab] = useState<"page" | "brand" | "element">("page");
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
  // Preview = the deck as the audience meets it: editor chrome gone, one page
  // filling the screen. Held separately from sceneIndex so closing preview
  // returns the user to the page they were editing, not the one they read to.
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const dims = useMemo(() => getDimensions(doc), [doc]);

  // Preview keyboard nav. Bound only while preview is open so the editor keeps
  // its own shortcuts the rest of the time.
  useEffect(() => {
    if (previewIndex === null) return;
    const last = doc.scenes.length - 1;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPreviewIndex(null);
        return;
      }
      if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") {
        e.preventDefault();
        setPreviewIndex((i) => (i === null ? i : Math.min(i + 1, last)));
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        setPreviewIndex((i) => (i === null ? i : Math.max(i - 1, 0)));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [previewIndex, doc.scenes.length]);

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
        if (res.status === 402) {
          let friendly: string | null = null;
          try {
            friendly = (JSON.parse(txt) as { error?: string }).error ?? null;
          } catch {
            /* non-JSON body */
          }
          setRegenLimit(
            friendly ?? "This document has used its included tokens.",
          );
          return;
        }
        throw new Error(friendlyApiError(txt, res.status, "regeneration"));
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
        setMp4State({
          kind: "error",
          message: friendlyApiError(await res.text(), res.status, "render"),
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
  // (multi-second) and, on failure, answers JSON with no attachment header —
  // a bare <a> would navigate the editor away to that body. Fetching keeps
  // the user in place: a busy label while it renders, a dismissible message
  // if it fails, a normal download if it succeeds.
  const handleExport = async (format: "pdf" | "png") => {
    if (exporting) return;
    setExportError(null);
    setExporting(format);
    try {
      const qs =
        format === "png" ? `format=png&scene=${sceneIndex}` : "format=pdf";
      const res = await fetch(`/api/preview/${scriptId}/export?${qs}`);
      if (!res.ok) {
        setExportError(friendlyApiError(await res.text(), res.status, "export"));
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
      // The wire can answer non-JSON (a Cloudflare error page mid-deploy, the
      // middleware's HTML rewrite of a dead session) — parse defensively like
      // every neighboring handler, never surface a parser's complaint.
      const json = (await res.json().catch(() => null)) as {
        ok?: true;
        focus?: number;
        script?: typeof script;
        error?: string;
      } | null;
      if (!res.ok || !json?.script) {
        throw new Error(
          json?.error ?? friendlyApiError("", res.status, "page operation"),
        );
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

  // Quality NOTES (the collapsible panel's content) vs anything the banner
  // must surface. thin_brief is not a quality note — it is a statement about
  // the input — so it gets the banner without forcing the notes panel open.
  const hasWarnings =
    warnings &&
    (warnings.invented_claims?.length ||
      warnings.low_contrast?.length ||
      warnings.missing_charts?.length ||
      warnings.throughline_drift?.length ||
      (warnings.duplicate_logo ?? 0) > 1 ||
      warnings.overflow_crop?.length);
  const bannerWarnings = hasWarnings || warnings?.thin_brief ? warnings : null;

  // Tool state for the shell toolbar (deck path). ElementEditor reports its
  // state up through onState; the toolbar buttons drive it back through the ref.
  const editorRef = useRef<ElementEditorHandle>(null);
  const [ed, setEd] = useState<EditorState>({
    tool: "select",
    showAll: false,
    canUndo: false,
    busy: null,
    selected: null,
  });
  // The piece the Element panel is ABOUT. Not simply ed.selected: the editor
  // clears the selection for the length of a regen reload (setSelected(null)
  // → iframe reload → reselect), and a panel keyed on the raw selection
  // vanished mid-success. Held through busy; released on a real deselect.
  const [panelPiece, setPanelPiece] = useState<{ pieceId: string; kind: string } | null>(null);
  useEffect(() => {
    if (ed.selected) {
      setPanelPiece(ed.selected);
      return;
    }
    if (ed.busy) return;
    // A GRACE WINDOW, not an immediate clear. The editor restores the
    // selection only once the NEW iframe document is actually up (~1.5s: the
    // reselect used to fire against the stale document and land on the old
    // rect). That correctness fix opened a gap where busy has cleared but the
    // document has not arrived — and the Element tab blinked out of existence
    // mid-regen, which reads as the panel losing your work. Hold the piece
    // across the gap; a real deselect still lands, just a beat later.
    const t = setTimeout(() => setPanelPiece(null), 2500);
    return () => clearTimeout(t);
  }, [ed.selected, ed.busy]);
  // The Element tab exists only while something is selected — it appears on
  // select, and a deselect returns to the page tab rather than stranding an
  // empty panel.
  useEffect(() => {
    if (panelPiece) setPanelTab("element");
    else setPanelTab((t) => (t === "element" ? "page" : t));
  }, [panelPiece]);
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
              {/* Reading the deck is a different act from editing it: preview
                  drops the chrome so the page can be judged the way it will be
                  met. Sits before Share because you look before you send. */}
              <button
                type="button"
                onClick={() => setPreviewIndex(sceneIndex)}
                title="See the deck the way your audience will"
                className="rounded-md border border-hairline-strong px-3 py-1.5 text-[12px] text-muted transition-colors hover:text-ink"
              >
                Preview
              </button>
              <ShareButton scriptId={scriptId} />
              {/* Scoped to ONE page while its neighbor exports the whole deck —
                  the label carries the page number so a bare "PNG" can't read
                  as the PDF button's whole-deck sibling. */}
              <button
                type="button"
                onClick={() => void handleExport("png")}
                disabled={exporting !== null}
                title={`Download page ${sceneIndex + 1} as a PNG image`}
                className="rounded-md border border-hairline-strong bg-surface px-3 py-1.5 text-[12px] text-ink transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {exporting === "png" ? "Exporting…" : `Page ${sceneIndex + 1} PNG`}
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
            <>
            {builtLine && (
              <div className="mx-auto mb-2 flex max-w-[860px] items-center justify-between gap-3 rounded-md border border-accent-line bg-accent-soft px-3 py-1.5">
                <span className="text-[12px] text-accent-text">{builtLine}</span>
                <button
                  type="button"
                  onClick={() => setBuiltLine(null)}
                  className="font-mono text-[10px] uppercase tracking-[0.12em] text-accent-text/70 transition-colors hover:text-accent-text"
                >
                  Dismiss
                </button>
              </div>
            )}
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
              structural={
                warnings?.structural_unresolved?.length ||
                warnings?.render_truth_unresolved?.length ||
                warnings?.render_truth_advisory?.length
                  ? [
                      ...(warnings?.structural_unresolved ?? []),
                      ...(warnings?.render_truth_unresolved ?? []),
                      ...(warnings?.render_truth_advisory ?? []),
                    ]
                  : null
              }
              warnings={bannerWarnings}
            />
            </>
          }
          sidePanel={
            // Page inspector and brand live in the same column: brand is a
            // document-level concern, so it belongs beside the canvas rather
            // than buried in a per-element menu.
            <div className="flex h-full flex-col">
              <div className="flex shrink-0 gap-1 border-b border-hairline px-3 pt-2.5">
                {([...(panelPiece ? (["element"] as const) : []), "page", "brand"] as const).map((t) => (
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
                {panelTab === "element" && panelPiece ? (
                  <ElementPanel
                    scriptId={scriptId}
                    pieceId={panelPiece.pieceId}
                    kind={panelPiece.kind}
                    pageBrief={currentScene?.visual_concept ?? null}
                    busy={ed.busy}
                    onRegenerate={(instruction) => editorRef.current?.regenerateSelected(instruction)}
                  />
                ) : panelTab === "brand" ? (
                  <BrandPanel
                    scriptId={scriptId}
                    onApplied={() => {
                      // Re-skin is a same-scene repaint: morph the changed
                      // pieces + section chrome in place; reload only if the
                      // morph declines.
                      void editorRef.current?.morphReload().then((ok) => {
                        if (!ok) setReloadKey((k) => k + 1);
                      });
                    }}
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
              onBrandApplied={() => setReloadKey((k) => k + 1)}
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
        {previewIndex !== null && (
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Deck preview"
            className="fixed inset-0 z-50 flex flex-col bg-black/95"
          >
            <div className="flex shrink-0 items-center justify-between px-4 py-2.5">
              <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-white/50">
                Preview · page {previewIndex + 1} of {doc.scenes.length}
              </span>
              <div className="flex items-center gap-3">
                <span className="hidden font-mono text-[10.5px] uppercase tracking-[0.14em] text-white/35 sm:inline">
                  ← → to move · Esc to close
                </span>
                <button
                  type="button"
                  onClick={() => setPreviewIndex(null)}
                  className="rounded-md border border-white/20 px-3 py-1.5 text-[12px] text-white/80 transition-colors hover:bg-white/10 hover:text-white"
                >
                  Close
                </button>
              </div>
            </div>
            <div className="relative flex min-h-0 flex-1 items-center justify-center px-4 pb-4">
              {/* Width is derived from the viewport height so the page keeps
                  its exact aspect ratio at any window size. */}
              <div
                className="overflow-hidden rounded-lg bg-[#0b0d12] shadow-2xl"
                style={{
                  aspectRatio: `${dims.width}/${dims.height}`,
                  width: `min(100%, calc((100vh - 7rem) * ${dims.width / dims.height}))`,
                }}
              >
                <iframe
                  key={previewIndex}
                  src={`/api/preview/${scriptId}/iframe?scene=${previewIndex}&v=${reloadKey}&settle=1`}
                  title={`Preview page ${previewIndex + 1}`}
                  style={{ width: "100%", height: "100%", border: 0 }}
                />
              </div>
              {previewIndex > 0 && (
                <button
                  type="button"
                  aria-label="Previous page"
                  onClick={() =>
                    setPreviewIndex((i) => (i === null ? i : Math.max(i - 1, 0)))
                  }
                  className="absolute left-4 top-1/2 -translate-y-1/2 rounded-full border border-white/15 bg-black/40 px-3.5 py-2 text-[14px] text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                >
                  ←
                </button>
              )}
              {previewIndex < doc.scenes.length - 1 && (
                <button
                  type="button"
                  aria-label="Next page"
                  onClick={() =>
                    setPreviewIndex((i) =>
                      i === null ? i : Math.min(i + 1, doc.scenes.length - 1),
                    )
                  }
                  className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full border border-white/15 bg-black/40 px-3.5 py-2 text-[14px] text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                >
                  →
                </button>
              )}
            </div>
          </div>
        )}
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

      {(warnings?.structural_unresolved?.length ||
        warnings?.render_truth_unresolved?.length ||
        warnings?.render_truth_advisory?.length) ? (
        <StructuralPanel
          issues={[
            ...(warnings?.structural_unresolved ?? []),
            // Layout findings the bounded repair ladder could not clear — the
            // deck shipped anyway (founder policy 2026-08-13) and these name
            // the pages to touch up by hand.
            ...(warnings?.render_truth_unresolved ?? []),
            // Findings the gate SAW but was not allowed to act on, because the
            // page could not vouch for its own text metrics. These used to
            // reach nobody, and a real collision shipped as "checks passed".
            ...(warnings?.render_truth_advisory ?? []),
          ]}
        />
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
/** Does this payload carry real quality NOTES (vs only an input statement)? */
const hasQualityNotes = (w: PreviewWarnings): boolean =>
  !!(w.invented_claims?.length ||
    w.low_contrast?.length ||
    w.missing_charts?.length ||
    w.throughline_drift?.length ||
    (w.duplicate_logo ?? 0) > 1 ||
    w.overflow_crop?.length);

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
  // Check panels are collapsed until asked for — see the strip below.
  const [checksOpen, setChecksOpen] = useState(false);
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
      {/* The honest line (same incident): a one-sentence brief cannot produce
          a deck full of real facts, so say so ONCE, plainly, where the user
          will read it — before they send it to an investor. */}
      {warnings?.thin_brief && (
        <div className="flex items-start gap-3 rounded-md border border-hairline bg-surface px-3 py-2">
          <span className="mt-[3px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
          <p className="text-[12.5px] leading-relaxed text-muted">
            <span className="text-ink">Your brief was one line, so this deck is a frame, not a finished story.</span>{" "}
            Anywhere you see an em dash or a prompt in place of a number, that is a slot waiting for your real figure —
            nothing here was invented on your behalf. Click any text to fill it in.
          </p>
        </div>
      )}
      {/* COLLAPSED BY DEFAULT (first-outside-tester incident, 2026-08-20):
          the full check panels rendered between toolbar and canvas, and on a
          fresh build with findings they consumed the stage — the user's new
          deck shrank to a stamp under a wall of QA chrome, with the suggest
          bar floating over it. The work stays loudest (DESIGN.md): one quiet
          summary line; the panels expand only when asked. */}
      {(structural?.length || (warnings && hasQualityNotes(warnings))) && !checksOpen ? (
        <button
          type="button"
          onClick={() => setChecksOpen(true)}
          className="flex w-full items-center justify-between gap-3 rounded-md border border-hairline bg-surface px-3 py-1.5 text-left transition-colors hover:border-hairline-strong"
        >
          <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">
            {structural?.length
              ? `${structural.length} unresolved check${structural.length === 1 ? "" : "s"}`
              : "Quality notes"}
            {warnings && hasQualityNotes(warnings) && structural?.length ? " · quality notes" : ""}
          </span>
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-faint">
            Review →
          </span>
        </button>
      ) : null}
      {checksOpen && (
        <div className="space-y-2">
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => setChecksOpen(false)}
              className="font-mono text-[10px] uppercase tracking-[0.12em] text-faint transition-colors hover:text-ink"
            >
              Collapse checks ×
            </button>
          </div>
          {structural && structural.length > 0 && <StructuralPanel issues={structural} />}
          {warnings && hasQualityNotes(warnings) && <WarningsPanel warnings={warnings} />}
        </div>
      )}
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
