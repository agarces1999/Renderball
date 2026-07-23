"use client";

import { useState, useTransition } from "react";
import type { Scene, Script, ScriptDecision } from "../../../src/schema";
import { saveScriptEdits } from "./actions";
import { cn } from "../../../lib/cn";

/**
 * The story/outline screen (fluid v1) — see DESIGN.md; per docs/PIVOT.md
 * "story before render" becomes "outline before build" for decks.
 *
 * Narrative-first: the logline and the page/scene sequence are the hero. The
 * lines, read top to bottom, are the story. The visual brief (visual_concept
 * + text strings + assets) lives in a per-page disclosure so the narrative
 * stays clean but editable.
 *
 * One loud action: Build (→ the editor/preview, where the user iterates per
 * page and exports). Export lives on the preview screen, not here — this
 * screen is about approving the narrative before any expensive compute.
 */
export function EditableReview({
  initialScript,
}: {
  initialScript: Script;
}) {
  const [script, setScript] = useState<Script>(initialScript);
  const [pendingSave, startSave] = useTransition();
  const [saveError, setSaveError] = useState<string | null>(null);

  const isDeck = script.config.kind === "deck";
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

  const handleDecision = (decisionId: string, answer: string) => {
    const nextDecisions = (script.decisions ?? []).map((d) =>
      d.id === decisionId ? { ...d, resolved: answer } : d,
    );
    const nextScript: Script = { ...script, decisions: nextDecisions };
    setScript(nextScript);
    persist(nextScript);
  };

  const decisions = script.decisions ?? [];

  return (
    <div>
      {/* Action bar — sits just under the global header */}
      <div className="sticky top-[53px] z-10 -mx-6 mb-10 flex flex-wrap items-center justify-between gap-4 border-b border-hairline bg-canvas/90 px-6 py-4 backdrop-blur-md">
        <div className="font-mono text-[12px] text-muted">
          {isDeck
            ? `${script.scenes.length} ${script.scenes.length === 1 ? "page" : "pages"}`
            : `${totalSeconds.toFixed(0)}s`}{" "}
          · {script.config.aspect_ratio} · {script.config.resolution} ·{" "}
          {pendingSave ? (
            <span className="text-accent-text">saving…</span>
          ) : saveError ? (
            <span className="text-red-500">save error</span>
          ) : (
            <span>edits auto-save</span>
          )}
        </div>
        <a
          href={`/preview/${script.id}`}
          className="rounded-md bg-accent px-5 py-2.5 text-[14px] font-semibold text-accent-ink transition-all hover:brightness-110"
        >
          Build the {script.config.kind === "deck" ? "deck" : "video"} →
        </a>
      </div>

      {/* Story/outline spine */}
      <header className="mb-10">
        <div className="mb-3 font-mono text-[11px] uppercase tracking-[0.18em] text-accent-text">
          {isDeck ? "Your outline" : "Your story"}
        </div>
        <h1 className="max-w-[32ch] font-display text-[clamp(24px,3.4vw,34px)] font-medium leading-[1.18] tracking-tight text-ink">
          {narrative?.logline || script.brief.purpose || (isDeck ? "Your outline" : "Your story")}
        </h1>
        <div className="mt-4 font-mono text-[12px] leading-relaxed text-muted">
          {isDeck
            ? `${script.scenes.length} ${script.scenes.length === 1 ? "page" : "pages"}`
            : `${script.scenes.length} scenes · ${totalSeconds.toFixed(0)}s`}
          {narrative?.arc ? <> · {narrative.arc}</> : null}
          {narrative?.throughline ? (
            <div className="mt-1 text-faint">
              throughline: {narrative.throughline}
            </div>
          ) : null}
        </div>
      </header>

      {/* Uncertainty checkpoint — batched calls the agent couldn't make from
          the brief alone. The story already follows each first option, so
          building without answering is fine; answers steer the build. */}
      {decisions.length > 0 && (
        <section className="mb-10 rounded-md border border-hairline bg-surface p-5">
          <div className="mb-1 font-mono text-[11px] uppercase tracking-[0.18em] text-accent-text">
            Before you build — {decisions.length === 1 ? "one quick call" : `${decisions.length} quick calls`}
          </div>
          <p className="mb-4 text-[13px] text-muted">
            The {isDeck ? "outline" : "story"} already follows the first option
            in each. Confirm or change it — your answer steers the build.
          </p>
          <div className="space-y-5">
            {decisions.map((d) => (
              <DecisionRow
                key={d.id}
                decision={d}
                onResolve={(v) => handleDecision(d.id, v)}
              />
            ))}
          </div>
        </section>
      )}

      {/* Page/scene sequence */}
      <div className="space-y-3">
        {script.scenes.map((scene, i) => (
          <StoryScene
            key={scene.id || i}
            index={i}
            scene={scene}
            isDeck={isDeck}
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
        Edit any line or visual brief, then build. Nothing builds until you
        say so.
      </p>
    </div>
  );
}

function DecisionRow({
  decision,
  onResolve,
}: {
  decision: ScriptDecision;
  onResolve: (v: string) => void;
}) {
  const [otherOpen, setOtherOpen] = useState(false);
  const [otherText, setOtherText] = useState("");
  const resolved = decision.resolved?.trim() || null;
  const isCustom = !!resolved && !decision.options.includes(resolved);

  return (
    <div>
      <div className="text-[14px] font-medium text-ink">{decision.question}</div>
      {decision.context && (
        <div className="mt-0.5 text-[12.5px] text-muted">{decision.context}</div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {decision.options.map((opt, i) => {
          const active = resolved === opt;
          const assumed = !resolved && i === 0;
          return (
            <button
              key={opt}
              type="button"
              onClick={() => {
                setOtherOpen(false);
                onResolve(opt);
              }}
              className={cn(
                "rounded-full border px-3 py-1.5 text-[12.5px] transition-colors",
                active
                  ? "border-accent-line bg-accent-soft text-ink"
                  : assumed
                    ? "border-hairline-strong bg-surface-2 text-ink"
                    : "border-hairline-strong text-muted hover:text-ink",
              )}
            >
              {opt}
              {assumed && (
                <span className="ml-1.5 font-mono text-[10px] uppercase tracking-wider text-faint">
                  assumed
                </span>
              )}
            </button>
          );
        })}
        {isCustom && !otherOpen && (
          <span className="rounded-full border border-accent-line bg-accent-soft px-3 py-1.5 text-[12.5px] text-ink">
            {resolved}
          </span>
        )}
        <button
          type="button"
          onClick={() => {
            setOtherText(isCustom ? resolved! : "");
            setOtherOpen(true);
          }}
          className="px-1.5 py-1.5 text-[12.5px] text-faint transition-colors hover:text-muted"
        >
          Other…
        </button>
      </div>
      {otherOpen && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const v = otherText.trim();
            if (!v) return;
            onResolve(v);
            setOtherOpen(false);
          }}
          className="mt-2 flex items-center gap-2"
        >
          <input
            autoFocus
            value={otherText}
            onChange={(e) => setOtherText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOtherOpen(false);
            }}
            placeholder="Your call, in a few words"
            className="w-72 rounded-md border border-hairline-strong bg-surface-2 px-3 py-1.5 text-[13px] text-ink placeholder:text-faint outline-none focus:border-accent-line"
          />
          <button
            type="submit"
            disabled={!otherText.trim()}
            className="rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-medium text-accent-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Set
          </button>
        </form>
      )}
    </div>
  );
}

const TURN_RX = /\b(turn|pivot|reveal|shift|but|what if|unlock)\b/i;

function StoryScene({
  index,
  scene,
  isDeck,
  fps,
  assetUrlForId,
  onHeadlineBlur,
  onConceptBlur,
}: {
  index: number;
  scene: Scene;
  isDeck: boolean;
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

  // The page's primary line is the headline if the agent wrote one; otherwise
  // fall back to the role/description, then the label, so the spine never
  // reads untitled. The green role line only shows when it adds something
  // beyond the headline (no duplicate text).
  const headline = scene.content?.headline?.trim() ?? "";
  const desc = scene.description?.trim() ?? "";
  const label = scene.label?.trim() ?? "";
  const noun = isDeck ? "Page" : "Scene";
  const primary = headline || desc || label || `${noun} ${index + 1}`;
  const showRole = Boolean(headline && desc && desc !== headline);
  const isTurn = TURN_RX.test(desc) || TURN_RX.test(label);

  return (
    <div
      className={cn(
        "rounded-md border bg-surface-2 p-5 transition-colors",
        isTurn ? "border-accent-line bg-accent-soft" : "border-hairline",
      )}
    >
      <div className="flex items-start gap-5">
        <div className="w-[72px] shrink-0 pt-1 font-mono text-[12px] text-faint">
          {String(index + 1).padStart(2, "0")}
          {isDeck ? null : (
            <>
              {" "}· {start.toFixed(0)}–{end.toFixed(0)}s
            </>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <EditableHeadline
            value={primary}
            placeholder={`Untitled ${noun.toLowerCase()}`}
            onBlur={onHeadlineBlur}
          />
          {showRole && (
            <div className="mt-1.5 text-[12.5px] font-medium text-accent-text">
              {desc}
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
                  {isDeck
                    ? "How it looks (the brief the build reads)"
                    : "How it looks + moves (the brief the build reads)"}
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

function EditableHeadline({
  value,
  placeholder = "Untitled",
  onBlur,
}: {
  value: string;
  placeholder?: string;
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
        {value || placeholder}
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
