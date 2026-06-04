"use client";

import { useState, useTransition } from "react";
import type { Scene, Script } from "../../../src/schema";
import { saveScriptEdits, renderScriptToMp4 } from "./actions";
import { cn } from "../../../lib/cn";

/**
 * The story screen (fluid v1) — see DESIGN.md.
 *
 * Story-first: the logline and the scene sequence are the hero. The
 * headlines, read top to bottom, are the story. The visual brief
 * (visual_concept + text strings + assets) lives in a per-scene
 * disclosure so the narrative stays clean but stays editable.
 *
 * One loud action: "Build the video" (→ the animated preview, where the
 * user iterates per scene). MP4 render stays reachable as a quiet
 * secondary control.
 */

type RenderState =
  | { kind: "idle" }
  | { kind: "rendering" }
  | { kind: "done"; url: string }
  | { kind: "error"; message: string };

export function EditableReview({
  initialScript,
  briefId,
  existingRenderUrl,
}: {
  initialScript: Script;
  briefId: string;
  existingRenderUrl: string | null;
}) {
  const [script, setScript] = useState<Script>(initialScript);
  const [pendingSave, startSave] = useTransition();
  const [saveError, setSaveError] = useState<string | null>(null);
  const [renderState, setRenderState] = useState<RenderState>(
    existingRenderUrl ? { kind: "done", url: existingRenderUrl } : { kind: "idle" },
  );

  const RENDER_FPS = 30;
  const lastScene = script.scenes[script.scenes.length - 1];
  const totalSeconds =
    lastScene?.end_seconds ??
    (typeof lastScene?.end_frame === "number"
      ? lastScene.end_frame / RENDER_FPS
      : script.config.duration_seconds) ??
    0;

  const narrative = script.narrative;

  const persist = (next: Script) => {
    startSave(async () => {
      const result = await saveScriptEdits(next);
      setSaveError(result.ok ? null : result.error);
    });
  };

  const handleHeadlineBlur = (sceneIdx: number, next: string) => {
    const original = initialScript.scenes[sceneIdx]?.content?.headline ?? "";
    if (next === original) return;
    const nextScenes = script.scenes.map((sc, i) =>
      i === sceneIdx
        ? { ...sc, content: { ...sc.content, headline: next } }
        : sc,
    );
    const nextScript: Script = { ...script, scenes: nextScenes };
    setScript(nextScript);
    persist(nextScript);
  };

  const handleConceptBlur = (sceneIdx: number, next: string) => {
    const original = initialScript.scenes[sceneIdx]?.visual_concept ?? "";
    if (next === original) return;
    const nextScenes = script.scenes.map((sc, i) =>
      i === sceneIdx ? { ...sc, visual_concept: next } : sc,
    );
    const nextScript: Script = { ...script, scenes: nextScenes };
    setScript(nextScript);
    persist(nextScript);
  };

  const handleRender = () => {
    setRenderState({ kind: "rendering" });
    startSave(async () => {
      const saveRes = await saveScriptEdits(script);
      if (!saveRes.ok) {
        setRenderState({ kind: "error", message: saveRes.error });
        return;
      }
      const renderRes = await renderScriptToMp4(briefId);
      if (!renderRes.ok) {
        setRenderState({ kind: "error", message: renderRes.error });
        return;
      }
      setRenderState({ kind: "done", url: renderRes.url });
    });
  };

  return (
    <div>
      {/* Action bar */}
      <div className="sticky top-0 z-10 -mx-6 mb-10 flex flex-wrap items-center justify-between gap-4 border-b border-hairline bg-canvas px-6 py-4">
        <div className="font-mono text-[12px] text-muted">
          {totalSeconds.toFixed(0)}s · {script.config.aspect_ratio} ·{" "}
          {script.config.resolution} ·{" "}
          {pendingSave ? (
            <span className="text-accent-text">saving…</span>
          ) : saveError ? (
            <span className="text-red-400">save error</span>
          ) : (
            <span>edits auto-save</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <RenderControls
            state={renderState}
            onRender={handleRender}
            disabled={pendingSave && renderState.kind !== "rendering"}
          />
          <a
            href={`/preview/${script.id}`}
            className="rounded-md bg-accent px-5 py-2.5 text-[14px] font-semibold text-accent-ink transition-all hover:brightness-110"
          >
            Build the video →
          </a>
        </div>
      </div>

      {/* Story spine */}
      <header className="mb-10">
        <div className="mb-3 font-mono text-[11px] uppercase tracking-[0.18em] text-accent-text">
          Your story
        </div>
        <h1 className="max-w-[32ch] font-display text-[clamp(24px,3.4vw,34px)] font-medium leading-[1.18] tracking-tight text-ink">
          {narrative?.logline || script.brief.purpose || "Your story"}
        </h1>
        <div className="mt-4 font-mono text-[12px] leading-relaxed text-muted">
          {script.scenes.length} scenes · {totalSeconds.toFixed(0)}s
          {narrative?.arc ? <> · {narrative.arc}</> : null}
          {narrative?.throughline ? (
            <div className="mt-1 text-faint">
              throughline: {narrative.throughline}
            </div>
          ) : null}
        </div>
      </header>

      {/* Scene sequence */}
      <div className="space-y-3">
        {script.scenes.map((scene, i) => (
          <StoryScene
            key={scene.id || i}
            index={i}
            scene={scene}
            fps={RENDER_FPS}
            assetUrlForId={(id: string) =>
              script.assets.images.find((a) => a.id === id)?.src
            }
            onHeadlineBlur={(v) => handleHeadlineBlur(i, v)}
            onConceptBlur={(v) => handleConceptBlur(i, v)}
          />
        ))}
      </div>

      <p className="mt-8 text-center font-mono text-[12px] text-faint">
        Edit any headline or visual brief, then build. Nothing renders until
        you say so.
      </p>
    </div>
  );
}

const TURN_RX = /\b(turn|pivot|reveal|shift|but|what if|unlock)\b/i;

function StoryScene({
  index,
  scene,
  fps,
  assetUrlForId,
  onHeadlineBlur,
  onConceptBlur,
}: {
  index: number;
  scene: Scene;
  fps: number;
  assetUrlForId: (id: string) => string | undefined;
  onHeadlineBlur: (v: string) => void;
  onConceptBlur: (v: string) => void;
}) {
  const start =
    typeof scene.start_seconds === "number"
      ? scene.start_seconds
      : typeof scene.start_frame === "number"
        ? scene.start_frame / fps
        : 0;
  const end =
    typeof scene.end_seconds === "number"
      ? scene.end_seconds
      : typeof scene.end_frame === "number"
        ? scene.end_frame / fps
        : 0;
  const texts = scene.content?.texts ?? [];
  const assetIds = scene.content?.asset_ids ?? [];
  const role = scene.description?.trim();
  const isTurn = TURN_RX.test(role ?? "") || TURN_RX.test(scene.label ?? "");

  return (
    <div
      className={cn(
        "rounded-md border bg-surface-2 p-5 transition-colors",
        isTurn ? "border-accent-line bg-accent-soft" : "border-hairline",
      )}
    >
      <div className="flex items-start gap-5">
        <div className="w-[72px] shrink-0 pt-1 font-mono text-[12px] text-faint">
          {String(index + 1).padStart(2, "0")} · {start.toFixed(0)}–
          {end.toFixed(0)}s
        </div>
        <div className="min-w-0 flex-1">
          <EditableHeadline
            value={scene.content?.headline ?? ""}
            onBlur={onHeadlineBlur}
          />
          {role && (
            <div className="mt-1.5 text-[12.5px] font-medium text-accent-text">
              {role}
            </div>
          )}

          <details className="group mt-3">
            <summary className="flex cursor-pointer list-none items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-faint hover:text-muted">
              <span className="transition-transform group-open:rotate-90">›</span>
              Visual brief
            </summary>
            <div className="mt-3 space-y-4 border-l border-hairline pl-4">
              <div>
                <div className="mb-1.5 font-mono text-[10px] uppercase tracking-widest text-faint">
                  How it looks + moves (the brief the build reads)
                </div>
                <EditableTextarea
                  value={scene.visual_concept}
                  onBlur={onConceptBlur}
                  minRows={3}
                />
              </div>
              {texts.length > 0 && (
                <div>
                  <div className="mb-1.5 font-mono text-[10px] uppercase tracking-widest text-faint">
                    Text on screen
                  </div>
                  <ul className="space-y-1">
                    {texts.map((t, j) => (
                      <li
                        key={j}
                        className="text-[13px] leading-relaxed text-ink-soft before:mr-2 before:text-faint before:content-['•']"
                      >
                        {t}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {assetIds.length > 0 && (
                <div>
                  <div className="mb-1.5 font-mono text-[10px] uppercase tracking-widest text-faint">
                    Assets
                  </div>
                  <ul className="space-y-1">
                    {assetIds.map((id, j) => {
                      const url = assetUrlForId(id);
                      return (
                        <li
                          key={j}
                          className="flex items-center gap-2 font-mono text-[12px] text-muted"
                        >
                          {id}
                          {url && (
                            <a
                              href={url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-accent-text hover:underline"
                            >
                              view
                            </a>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}

function RenderControls({
  state,
  onRender,
  disabled,
}: {
  state: RenderState;
  onRender: () => void;
  disabled: boolean;
}) {
  switch (state.kind) {
    case "idle":
      return (
        <button
          type="button"
          onClick={onRender}
          disabled={disabled}
          className="rounded-md border border-hairline-strong px-4 py-2.5 text-[13px] text-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          Render MP4
        </button>
      );
    case "rendering":
      return (
        <div className="flex items-center gap-2 font-mono text-[13px] text-muted">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent" />
          rendering…
        </div>
      );
    case "done":
      return (
        <div className="flex items-center gap-3">
          <a
            href={state.url}
            target="_blank"
            rel="noreferrer"
            className="text-[13px] text-accent-text hover:underline"
          >
            ↓ MP4
          </a>
          <button
            type="button"
            onClick={onRender}
            disabled={disabled}
            className="text-[12px] text-faint transition-colors hover:text-ink"
          >
            re-render
          </button>
        </div>
      );
    case "error":
      return (
        <div className="flex max-w-[260px] flex-col items-end gap-0.5">
          <span className="font-mono text-[12px] text-red-400">render failed</span>
          <span className="break-words text-right text-[11px] text-red-400/80">
            {state.message}
          </span>
          <button
            type="button"
            onClick={onRender}
            className="text-[12px] text-muted transition-colors hover:text-ink"
          >
            retry
          </button>
        </div>
      );
  }
}

function EditableHeadline({
  value,
  onBlur,
}: {
  value: string;
  onBlur: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
        className="-mx-1 block rounded px-1 text-left font-display text-[22px] font-semibold leading-[1.15] tracking-tight text-ink transition-colors hover:bg-surface-3"
      >
        {value || "Untitled scene"}
      </button>
    );
  }
  return (
    <input
      type="text"
      value={draft}
      autoFocus
      maxLength={120}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setEditing(false);
        const next = draft.trim();
        if (next && next !== value) onBlur(next);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        }
        if (e.key === "Escape") {
          setDraft(value);
          setEditing(false);
        }
      }}
      className="w-full rounded border border-accent-line bg-surface px-2 py-1 font-display text-[22px] font-semibold leading-[1.15] tracking-tight text-ink focus:outline-none"
    />
  );
}

function EditableTextarea({
  value,
  onBlur,
  minRows = 3,
}: {
  value: string;
  onBlur: (v: string) => void;
  minRows?: number;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
        className="-mx-1 block w-full rounded px-1 text-left text-[13px] leading-relaxed text-ink-soft transition-colors hover:bg-surface-3"
      >
        {value}
      </button>
    );
  }
  return (
    <textarea
      value={draft}
      autoFocus
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setEditing(false);
        const next = draft.trim();
        if (next && next !== value) onBlur(next);
      }}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          (e.target as HTMLTextAreaElement).blur();
        }
        if (e.key === "Escape") {
          setDraft(value);
          setEditing(false);
        }
      }}
      rows={minRows}
      className="w-full resize-y rounded-md border border-accent-line bg-surface px-3 py-2 text-[13px] leading-relaxed text-ink focus:outline-none"
    />
  );
}
