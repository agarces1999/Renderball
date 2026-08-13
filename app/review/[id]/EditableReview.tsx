"use client";

import { useState, useTransition } from "react";
import type { Scene, Script, ScriptDecision } from "../../../src/schema";
import { saveScriptEdits } from "./actions";
import {
  deleteScene,
  insertBlankScene,
  moveScene,
} from "../../../lib/agents/outline-scene-ops";
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
  briefPrompt,
}: {
  initialScript: Script;
  /** The user's original brief, verbatim — editable here (founder ask
   *  2026-08-12: "i should be able to edit the brief after renderball
   *  generates it"). Absent on legacy briefs created before freeform mode. */
  briefPrompt?: string;
}) {
  const [script, setScript] = useState<Script>(initialScript);
  const [pendingSave, startSave] = useTransition();
  const [saveError, setSaveError] = useState<string | null>(null);

  // ── the brief, editable after the fact ────────────────────────────────────
  const [briefOpen, setBriefOpen] = useState(false);
  const [briefText, setBriefText] = useState(briefPrompt ?? "");
  const [rewriting, setRewriting] = useState(false);
  const [rewriteError, setRewriteError] = useState<string | null>(null);
  const rewriteOutline = async () => {
    if (rewriting || !briefText.trim()) return;
    setRewriting(true);
    setRewriteError(null);
    try {
      const res = await fetch("/api/documents/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scriptId: script.id,
          prompt: briefText.trim(),
          pages: script.scenes.length,
        }),
      });
      if (!res.ok && res.status !== 202) {
        const data = await res.json().catch(() => null);
        setRewriteError(
          typeof data?.error === "string" && /\s/.test(data.error)
            ? data.error
            : "Could not start the rewrite. Your outline is unchanged.",
        );
        setRewriting(false);
        return;
      }
      // Poll the outline job (the same machinery the first generation used);
      // the current outline stays on screen until the new one is really here.
      const until = Date.now() + 8 * 60_000;
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, 2_500));
        let poll: Response;
        try {
          poll = await fetch(
            `/api/documents/generate?scriptId=${encodeURIComponent(script.id)}`,
          );
        } catch {
          continue;
        }
        if (!poll.ok) continue;
        const data = (await poll.json().catch(() => null)) as
          | { status?: string; resultStatus?: number; result?: { error?: string } }
          | null;
        if (!data) continue;
        if (data.status === "done") {
          const status = data.resultStatus ?? 200;
          if (status >= 200 && status < 300) {
            window.location.reload();
            return;
          }
          setRewriteError(
            data.result?.error ?? "The rewrite didn't come together. Your outline is unchanged.",
          );
          setRewriting(false);
          return;
        }
        if (data.status === "error") {
          setRewriteError("The rewrite failed partway. Your outline is unchanged.");
          setRewriting(false);
          return;
        }
      }
      setRewriteError(
        "The rewrite is taking unusually long. Refresh in a minute — it may have landed.",
      );
      setRewriting(false);
    } catch {
      setRewriteError("Network error. Your outline is unchanged.");
      setRewriting(false);
    }
  };

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
    // No-op guard against CURRENT state, not the page-load snapshot —
    // comparing against initialScript made reverting a line to its original
    // wording silently snap back to the rejected edit.
    const original = script.scenes[sceneIdx]?.content?.headline ?? "";
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
    // Same current-state guard as handleHeadlineBlur — reverts must persist.
    const original = script.scenes[sceneIdx]?.visual_concept ?? "";
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

  // ── outline page ops (founder, 2026-08-13: "edit the outline itself") ────
  // Deterministic and free: build the next script, show it, persist it — the
  // same optimistic path every headline edit takes.
  const applyOp = (next: Script) => {
    if (next === script) return; // guarded no-ops (last page, out of range)
    setScript(next);
    persist(next);
  };
  const handleMove = (i: number, dir: -1 | 1) => applyOp(moveScene(script, i, i + dir));
  const handleDelete = (i: number) => applyOp(deleteScene(script, i));
  const handleAdd = (after: number) => applyOp(insertBlankScene(script, after));
  const handleLedeBlur = (sceneIdx: number, next: string) => {
    const original = script.scenes[sceneIdx]?.content?.lede ?? "";
    if (next === original) return;
    const nextScenes = script.scenes.map((sc, i) =>
      i === sceneIdx ? { ...sc, content: { ...sc.content, lede: next || undefined } } : sc,
    );
    applyOp({ ...script, scenes: nextScenes });
  };

  // ── per-page AI rewrite ───────────────────────────────────────────────────
  // POST → 202 → poll, the house pattern. The server splices + validates +
  // saves; the client only ever adopts the SAVED result.
  const [rewriteBusyIdx, setRewriteBusyIdx] = useState<number | null>(null);
  const [rewriteErrors, setRewriteErrors] = useState<Record<number, string>>({});
  const handleRewrite = async (sceneIdx: number, instruction: string) => {
    if (rewriteBusyIdx !== null) return;
    setRewriteBusyIdx(sceneIdx);
    setRewriteErrors((e) => ({ ...e, [sceneIdx]: "" }));
    const fail = (msg: string) => {
      setRewriteErrors((e) => ({ ...e, [sceneIdx]: msg }));
      setRewriteBusyIdx(null);
    };
    try {
      const res = await fetch("/api/documents/outline-page", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scriptId: script.id, scene: sceneIdx, instruction }),
      });
      let data = (await res.json().catch(() => null)) as
        | { ok?: boolean; scenes?: Script["scenes"]; error?: string; status?: string }
        | null;
      if (res.status !== 202 && !res.ok) {
        fail(
          typeof data?.error === "string" && /\s/.test(data.error)
            ? data.error
            : "Could not start the rewrite. The page is unchanged.",
        );
        return;
      }
      if (res.status === 202) {
        const until = Date.now() + 6 * 60_000;
        data = null;
        while (Date.now() < until) {
          await new Promise((r) => setTimeout(r, 2_000));
          let poll: Response;
          try {
            poll = await fetch(
              `/api/documents/outline-page?scriptId=${encodeURIComponent(script.id)}`,
            );
          } catch {
            continue;
          }
          if (!poll.ok) continue;
          const p = (await poll.json().catch(() => null)) as
            | { status?: string; result?: unknown; resultStatus?: number; error?: string }
            | null;
          if (!p) continue;
          if (p.status === "done") {
            const status = p.resultStatus ?? 200;
            const body = p.result as { scenes?: Script["scenes"]; error?: string } | null;
            if (status >= 200 && status < 300) data = { ok: true, scenes: body?.scenes };
            else data = { error: body?.error };
            break;
          }
          if (p.status === "error") {
            data = { error: p.error };
            break;
          }
        }
      }
      if (!data?.ok || !Array.isArray(data.scenes)) {
        fail(
          typeof data?.error === "string" && /\s/.test(data.error)
            ? data.error
            : "The rewrite didn't come together. The page is unchanged.",
        );
        return;
      }
      // Server-saved truth; adopt it wholesale (indexes/timing renumbered there).
      setScript((prev) => ({ ...prev, scenes: data!.scenes! }));
      setRewriteBusyIdx(null);
    } catch {
      fail("Network error. The page is unchanged.");
    }
  };

  const decisions = script.decisions ?? [];

  return (
    <div>
      {/* Action bar — sits just under the global header */}
      <div className="sticky top-[53px] z-10 -mx-6 mb-10 flex flex-wrap items-center justify-between gap-4 border-b border-hairline chrome-veil px-6 py-4 backdrop-blur-md">
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
          {/* brief is optional-chained: synthetic scripts (blank documents)
              carry none, and this header must never crash the page */}
          {narrative?.logline || script.brief?.purpose || (isDeck ? "Your outline" : "Your story")}
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

      {/* The brief, on the record and editable. It used to vanish the moment
          Generate was pressed — the one input the whole outline came from was
          the one thing this screen could not show or change (founder,
          2026-08-12). Editing rewrites the outline through the same generate
          job, with the same approval step after; the current outline stays
          until the new one actually lands. */}
      {briefPrompt !== undefined && (
        <section className="mb-10 rounded-md border border-hairline bg-surface p-5">
          <div className="mb-1 flex items-center justify-between">
            <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-accent-text">
              Your brief
            </span>
            {!briefOpen && (
              <button
                type="button"
                onClick={() => setBriefOpen(true)}
                className="rounded-md border border-hairline px-2.5 py-1 text-[11.5px] text-muted transition-colors hover:border-accent-line hover:text-ink"
              >
                Edit the brief
              </button>
            )}
          </div>
          {!briefOpen ? (
            <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink-soft">
              {briefText || "(no brief text was saved with this document)"}
            </p>
          ) : (
            <>
              <textarea
                value={briefText}
                onChange={(e) => setBriefText(e.target.value)}
                rows={5}
                autoFocus
                disabled={rewriting}
                className="w-full resize-y rounded-md border border-hairline bg-surface-2 px-3 py-2.5 text-[13px] leading-relaxed text-ink outline-none focus:border-accent-line disabled:opacity-60"
              />
              <div className="mt-2.5 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => void rewriteOutline()}
                  disabled={rewriting || !briefText.trim()}
                  className="rounded-md bg-accent px-4 py-2 text-[13px] font-semibold text-accent-ink transition-all hover:brightness-110 disabled:opacity-50"
                >
                  {rewriting ? "Rewriting your outline…" : "Rewrite the outline from this"}
                </button>
                {!rewriting && (
                  <button
                    type="button"
                    onClick={() => {
                      setBriefOpen(false);
                      setBriefText(briefPrompt ?? "");
                      setRewriteError(null);
                    }}
                    className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-faint transition-colors hover:text-ink"
                  >
                    cancel
                  </button>
                )}
                <span className="font-mono text-[10.5px] text-faint">
                  {rewriting
                    ? "your current outline stays until the new one lands"
                    : "uses tokens · you approve the new outline before anything is designed"}
                </span>
              </div>
              {rewriteError && (
                <p className="mt-2.5 text-[12.5px] leading-relaxed text-ink">{rewriteError}</p>
              )}
            </>
          )}
        </section>
      )}

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

      {/* Page/scene sequence — every page fully editable: its lines, its
          place in the order, its existence, and (paid, labelled) an AI
          rewrite of just that page. */}
      <div className="space-y-1.5">
        {script.scenes.map((scene, i) => (
          <div key={scene.id || i}>
            <StoryScene
              index={i}
              scene={scene}
              isDeck={isDeck}
              fps={RENDER_FPS}
              assetUrlForId={(id: string) =>
                script.assets.images.find((a) => a.id === id)?.src
              }
              onHeadlineBlur={(v) => handleHeadlineBlur(i, v)}
              onConceptBlur={(v) => handleConceptBlur(i, v)}
              onLedeBlur={(v) => handleLedeBlur(i, v)}
              onMoveUp={i > 0 ? () => handleMove(i, -1) : undefined}
              onMoveDown={i < script.scenes.length - 1 ? () => handleMove(i, 1) : undefined}
              onDelete={script.scenes.length > 1 ? () => handleDelete(i) : undefined}
              onRewrite={(instruction) => void handleRewrite(i, instruction)}
              rewriteBusy={rewriteBusyIdx === i}
              rewriteDisabled={rewriteBusyIdx !== null}
              rewriteError={rewriteErrors[i] || null}
            />
            <div className="flex justify-center py-0.5">
              <button
                type="button"
                onClick={() => handleAdd(i)}
                className="rounded-full border border-transparent px-3 py-0.5 font-mono text-[10.5px] uppercase tracking-[0.14em] text-transparent transition-colors hover:border-hairline hover:text-muted"
                aria-label={`Add a ${isDeck ? "page" : "scene"} after ${i + 1}`}
              >
                + add a {isDeck ? "page" : "scene"} here
              </button>
            </div>
          </div>
        ))}
      </div>

      <p className="mt-6 text-center font-mono text-[12px] text-faint">
        Every line is editable — click it. Reorder, remove or add pages;
        nothing builds until you say so.
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
  onLedeBlur,
  onMoveUp,
  onMoveDown,
  onDelete,
  onRewrite,
  rewriteBusy,
  rewriteDisabled,
  rewriteError,
}: {
  index: number;
  scene: Scene;
  isDeck: boolean;
  fps: number;
  assetUrlForId: (id: string) => string | undefined;
  onHeadlineBlur: (v: string) => void;
  onConceptBlur: (v: string) => void;
  onLedeBlur: (v: string) => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onDelete?: () => void;
  onRewrite: (instruction: string) => void;
  rewriteBusy: boolean;
  rewriteDisabled: boolean;
  rewriteError: string | null;
}) {
  const [rewriteOpen, setRewriteOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
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
      <div className="group flex items-start gap-5">
        <div className="w-[72px] shrink-0 pt-1 font-mono text-[12px] text-faint">
          {String(index + 1).padStart(2, "0")}
          {isDeck ? null : (
            <>
              {" "}· {start.toFixed(0)}–{end.toFixed(0)}s
            </>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <EditableHeadline
                value={primary}
                placeholder={`Untitled ${noun.toLowerCase()}`}
                onBlur={onHeadlineBlur}
              />
            </div>
            {/* The page's controls — visible on hover, always reachable.
                Order mirrors the editor's page rail: move, rewrite, remove. */}
            <div className="flex shrink-0 items-center gap-1 opacity-40 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
              {onMoveUp && (
                <button type="button" onClick={onMoveUp} title={`Move ${noun.toLowerCase()} up`} className="rounded border border-hairline px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:border-accent-line hover:text-ink">
                  ↑
                </button>
              )}
              {onMoveDown && (
                <button type="button" onClick={onMoveDown} title={`Move ${noun.toLowerCase()} down`} className="rounded border border-hairline px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:border-accent-line hover:text-ink">
                  ↓
                </button>
              )}
              <button
                type="button"
                onClick={() => setRewriteOpen((o) => !o)}
                disabled={rewriteDisabled && !rewriteBusy}
                title="Rewrite this page with AI"
                className="rounded border border-hairline px-2 py-0.5 text-[11px] text-muted transition-colors hover:border-accent-line hover:text-ink disabled:opacity-50"
              >
                Rewrite…
              </button>
              {onDelete && (
                <button
                  type="button"
                  onClick={onDelete}
                  title={`Remove this ${noun.toLowerCase()}`}
                  className="rounded border border-hairline px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:border-red-500/40 hover:text-ink"
                >
                  ✕
                </button>
              )}
            </div>
          </div>
          {showRole && (
            <div className="mt-1.5 text-[12.5px] font-medium text-accent-text">
              {desc}
            </div>
          )}
          {/* The supporting line, as editable as the headline. */}
          <div className="mt-1.5">
            <EditableSupport
              value={scene.content?.lede ?? ""}
              placeholder="Add a supporting line…"
              onBlur={onLedeBlur}
            />
          </div>

          {rewriteOpen && (
            <div className="mt-3 rounded-md border border-hairline bg-surface p-3">
              <textarea
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                rows={2}
                autoFocus
                disabled={rewriteBusy}
                placeholder={`What should change on this ${noun.toLowerCase()}? e.g. "make it about the retention numbers, drop the quote"`}
                className="w-full resize-y rounded-md border border-hairline bg-surface-2 px-2.5 py-2 text-[12.5px] leading-relaxed text-ink outline-none focus:border-accent-line disabled:opacity-60"
              />
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  disabled={rewriteBusy || !instruction.trim()}
                  onClick={() => onRewrite(instruction.trim())}
                  className="rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-accent-ink transition-all hover:brightness-110 disabled:opacity-50"
                >
                  {rewriteBusy ? "Rewriting this page…" : "Rewrite this page"}
                </button>
                {!rewriteBusy && (
                  <button
                    type="button"
                    onClick={() => setRewriteOpen(false)}
                    className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-faint transition-colors hover:text-ink"
                  >
                    cancel
                  </button>
                )}
                <span className="font-mono text-[10.5px] text-faint">
                  {rewriteBusy
                    ? "the rest of the outline is untouched"
                    : "uses tokens · only this page changes"}
                </span>
              </div>
              {rewriteError && (
                <p className="mt-2 text-[12px] leading-relaxed text-ink">{rewriteError}</p>
              )}
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

function EditableSupport({
  value,
  placeholder,
  onBlur,
}: {
  value: string;
  placeholder: string;
  onBlur: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  if (!editing) {
    return (
      <button
        type="button"
        data-rb-lede
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
        className={cn(
          "-mx-1 block w-full rounded px-1 text-left text-[13px] leading-relaxed transition-colors hover:bg-surface-3",
          value ? "text-ink-soft" : "text-faint",
        )}
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
      maxLength={240}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setEditing(false);
        if (draft.trim() !== value) onBlur(draft.trim());
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
      className="w-full rounded border border-accent-line bg-surface px-2 py-1 text-[13px] leading-relaxed text-ink focus:outline-none"
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
