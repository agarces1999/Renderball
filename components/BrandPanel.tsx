"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The document's brand, editable in place.
 *
 * Brand used to be fixed at /new and frozen into the build, so a deck's
 * colours, fonts, logo and materials could never change afterwards. This is
 * the surface that unfreezes it, and it is deliberately shaped around the
 * pricing promise: everything here is DETERMINISTIC and therefore free —
 * swapping a colour rewrites literal values in the document's own sources, it
 * does not regenerate anything. Regeneration stays an explicit, separate,
 * metered action, and only then do the brand guidelines below steer the model.
 *
 * DESIGN.md: the chrome is quiet while the user's work is loud, so swatches
 * show the document's OWN colours rather than app chrome, and the panel never
 * competes with the canvas.
 */

type Role = "accent" | "canvas" | "ink" | "muted" | "surface" | "line";

interface BrandAsset {
  ref: string;
  name: string;
  mime: string;
  kind: string;
  note?: string;
}

interface DocumentBrand {
  v: 1;
  palette: Partial<Record<Role, string>>;
  fonts: { display?: string; body?: string; mono?: string };
  logo?: string;
  assets: BrandAsset[];
  guidelines?: string;
}

interface InUse {
  palette: Partial<Record<Role, string>>;
  fonts: { display?: string; body?: string; mono?: string };
  colors: { hex: string; count: number }[];
}

/**
 * Curated stacks for the type dropdowns, each rendered IN ITS OWN FACE so
 * choosing a font means seeing it (founder call 2026-08-03 — the raw
 * font-family strings meant nothing to anyone who is not a developer). Every
 * stack ends in a generic family, so a machine without the first choice still
 * renders something close. Geist and Cabinet Grotesk are loaded by the app
 * itself, so their previews are faithful; the rest are system faces.
 */
const FONT_OPTIONS: { label: string; stack: string; kind: "sans" | "serif" | "mono" }[] = [
  { label: "Geist", stack: '"Geist", system-ui, sans-serif', kind: "sans" },
  { label: "Cabinet Grotesk", stack: '"Cabinet Grotesk", "Geist", system-ui, sans-serif', kind: "sans" },
  { label: "Helvetica", stack: '"Helvetica Neue", Helvetica, Arial, sans-serif', kind: "sans" },
  { label: "Futura", stack: 'Futura, "Century Gothic", "Trebuchet MS", sans-serif', kind: "sans" },
  { label: "Gill Sans", stack: '"Gill Sans", "Gill Sans MT", Calibri, sans-serif', kind: "sans" },
  { label: "Verdana", stack: "Verdana, Geneva, sans-serif", kind: "sans" },
  { label: "Georgia", stack: 'Georgia, "Times New Roman", serif', kind: "serif" },
  { label: "Palatino", stack: 'Palatino, "Palatino Linotype", "Book Antiqua", serif', kind: "serif" },
  { label: "Garamond", stack: 'Garamond, "Apple Garamond", "Times New Roman", serif', kind: "serif" },
  { label: "Times", stack: '"Times New Roman", Times, serif', kind: "serif" },
  { label: "Geist Mono", stack: '"Geist Mono", ui-monospace, monospace', kind: "mono" },
  { label: "Menlo", stack: 'Menlo, Monaco, "Courier New", monospace', kind: "mono" },
  { label: "Courier", stack: '"Courier New", Courier, monospace', kind: "mono" },
];

const normStack = (s: string) => s.toLowerCase().replace(/["'\s]/g, "");
const firstFamily = (s: string) => s.split(",")[0]?.replace(/["']/g, "").trim() || "";

/**
 * One type slot as a dropdown that previews every option in its own face.
 * Expands INLINE (an accordion, not an overlay) — the panel is narrow and
 * scrollable, and an overlay popover would clip against it. "Custom stack"
 * keeps the old raw input reachable for anyone pasting a corporate webfont.
 */
function FontSelect({
  slot,
  value,
  onChange,
}: {
  slot: "display" | "body" | "mono";
  value: string;
  onChange: (stack: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  // Mono choices lead the mono slot; everything stays reachable everywhere.
  const options = [...FONT_OPTIONS].sort((a, b) => {
    const w = (o: { kind: string }) => (slot === "mono" ? (o.kind === "mono" ? 0 : 1) : o.kind === "mono" ? 1 : 0);
    return w(a) - w(b);
  });
  const match = options.find((o) => normStack(o.stack) === normStack(value));

  return (
    <div className="mt-0.5">
      <button
        type="button"
        data-rb-font-slot={slot}
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          setCustom(false);
        }}
        className="flex w-full items-center justify-between rounded-md border border-hairline bg-surface px-2 py-1.5 text-left text-[13px] text-ink outline-none transition-colors hover:border-hairline-strong focus:border-accent-line"
        style={{ fontFamily: value || undefined }}
      >
        <span className="truncate">{match?.label ?? (value ? firstFamily(value) : "Choose a font")}</span>
        <span className={`ml-2 shrink-0 text-[9px] text-faint transition-transform ${open ? "rotate-180" : ""}`}>▼</span>
      </button>

      {open && (
        <div className="mt-1 overflow-hidden rounded-md border border-hairline bg-surface">
          {options.map((o) => (
            <button
              key={o.label}
              type="button"
              data-rb-font-option={o.label}
              onClick={() => {
                onChange(o.stack);
                setOpen(false);
              }}
              className={`flex w-full items-baseline justify-between px-2 py-1.5 text-left transition-colors hover:bg-surface-2 ${
                match?.label === o.label ? "bg-surface-2" : ""
              }`}
            >
              <span className="text-[13.5px] text-ink" style={{ fontFamily: o.stack }}>
                {o.label}
              </span>
              <span className="ml-2 shrink-0 text-[11px] text-faint" style={{ fontFamily: o.stack }}>
                Aa Bb 123
              </span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => setCustom(!custom)}
            className="w-full border-t border-hairline px-2 py-1.5 text-left font-mono text-[10.5px] text-muted transition-colors hover:bg-surface-2"
          >
            Custom stack…
          </button>
          {custom && (
            <input
              type="text"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder='"Inter", sans-serif'
              autoFocus
              className="w-full border-t border-hairline bg-surface px-2 py-1.5 font-mono text-[11px] text-ink outline-none"
            />
          )}
        </div>
      )}
    </div>
  );
}

const ROLES: { key: Role; label: string }[] = [
  { key: "accent", label: "Accent" },
  { key: "canvas", label: "Background" },
  { key: "ink", label: "Text" },
  { key: "surface", label: "Surface" },
  { key: "line", label: "Lines" },
];

/** Where a piece of feedback belongs, so it renders next to the control that
 *  produced it — the panel is far taller than its viewport, so a single
 *  message at the bottom is invisible from wherever the user just clicked. */
type FeedbackScope = "apply" | "materials" | "guidelines";

export function BrandPanel({
  scriptId,
  // Which API to talk to. Defaults to the Clerk-protected production routes;
  // the dev harness passes "/api/dev" so the panel can be driven — and QA'd —
  // without a session.
  apiBase = "/api/preview",
  // Called after a successful apply so the host can refresh its canvas in
  // place; without it the panel falls back to a full reload.
  onApplied,
}: {
  scriptId: string;
  apiBase?: string;
  onApplied?: () => void;
}) {
  const [brand, setBrand] = useState<DocumentBrand | null>(null);
  const [inUse, setInUse] = useState<InUse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    scope: FeedbackScope;
    kind: "ok" | "error";
    text: string;
  } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // The server's last-saved brand, tracked apart from staged edits. Materials
  // actions (use/clear logo, remove a file) build on THIS, never on `brand`,
  // so clicking them can neither silently apply nor destroy colour, type or
  // guidelines picks the user hasn't saved yet.
  const savedRef = useRef<DocumentBrand | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const r = await fetch(`${apiBase}/brand?scriptId=${encodeURIComponent(scriptId)}`);
      if (!r.ok) {
        setLoadError("The brand couldn’t be loaded.");
        return;
      }
      const d = await r.json();
      savedRef.current = d.brand;
      setBrand(d.brand);
      setInUse(d.inUse);
    } catch {
      setLoadError("The brand couldn’t be loaded.");
    }
  }, [scriptId, apiBase]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Save + apply. `apply:false` stores guidance that only affects future
   *  generation, so it costs nothing and changes nothing on canvas. */
  const save = useCallback(
    async (next: DocumentBrand, apply: boolean, label: string, scope: FeedbackScope, savedText?: string) => {
      setBusy(label);
      setFeedback(null);
      // A cleared font field means "unset that slot", not an invalid value —
      // left in, it would reject the whole save, colour edits included.
      const fonts = { ...next.fonts };
      for (const slot of ["display", "body", "mono"] as const) {
        const v = fonts[slot];
        if (v !== undefined && v.trim() === "") delete fonts[slot];
      }
      // Keeps Apply disabled through the fallback reload, so a second click
      // can't race a new PUT against the pending navigation.
      let reloading = false;
      try {
        const r = await fetch(`${apiBase}/brand`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scriptId, brand: { ...next, fonts }, apply }),
        });
        const d = await r.json().catch(() => null);
        if (!r.ok) {
          setFeedback({ scope, kind: "error", text: d?.error ?? "could not save" });
          return;
        }
        savedRef.current = d.brand;
        // Take only the server-owned fields; wholesale replacement would
        // clobber staged edits (a logo save is built on the last-saved brand,
        // and the user may have kept typing while the request was in flight).
        setBrand((prev) =>
          prev ? { ...prev, assets: d.brand.assets, logo: d.brand.logo } : d.brand,
        );
        if (apply) {
          const n = (d.changes ?? []).length;
          if (n > 0) {
            if (onApplied) {
              setFeedback({
                scope,
                kind: "ok",
                text: `Applied — ${n} change${n === 1 ? "" : "s"}.`,
              });
              onApplied();
              // The document's sources just changed; refresh what "in use" shows.
              void load();
            } else {
              // The canvas is an iframe rendered server-side; without a host
              // to refresh it, a reload is the honest way to show new source.
              reloading = true;
              setFeedback({
                scope,
                kind: "ok",
                text: `Applied — ${n} change${n === 1 ? "" : "s"}. Reloading…`,
              });
              setTimeout(() => window.location.reload(), 700);
            }
          } else {
            setFeedback({
              scope,
              kind: "ok",
              text: "Saved — nothing on the pages needed to change.",
            });
          }
        } else {
          setFeedback({ scope, kind: "ok", text: savedText ?? "Saved." });
        }
      } catch {
        setFeedback({ scope, kind: "error", text: "network error" });
      } finally {
        if (!reloading) setBusy(null);
      }
    },
    [scriptId, apiBase, onApplied, load],
  );

  const upload = async (file: File) => {
    setBusy("upload");
    setFeedback(null);
    try {
      const fd = new FormData();
      fd.set("file", file);
      fd.set("scriptId", scriptId);
      const r = await fetch(`${apiBase}/brand/asset`, { method: "POST", body: fd });
      const d = await r.json().catch(() => null);
      if (!r.ok) {
        setFeedback({ scope: "materials", kind: "error", text: d?.error ?? "upload failed" });
        return;
      }
      savedRef.current = d.brand;
      setBrand((prev) =>
        prev ? { ...prev, assets: d.brand.assets, logo: d.brand.logo } : d.brand,
      );
      setFeedback({ scope: "materials", kind: "ok", text: `Added ${d.asset.name}.` });
    } catch {
      setFeedback({ scope: "materials", kind: "error", text: "upload failed" });
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const removeAsset = async (asset: BrandAsset) => {
    setBusy(`remove:${asset.ref}`);
    setFeedback(null);
    try {
      const r = await fetch(
        `${apiBase}/brand/asset?scriptId=${encodeURIComponent(scriptId)}&ref=${encodeURIComponent(asset.ref)}`,
        { method: "DELETE" },
      );
      const d = await r.json().catch(() => null);
      if (!r.ok) {
        setFeedback({ scope: "materials", kind: "error", text: d?.error ?? "could not remove" });
        return;
      }
      savedRef.current = d.brand;
      setBrand((prev) =>
        prev ? { ...prev, assets: d.brand.assets, logo: d.brand.logo } : d.brand,
      );
      setFeedback({ scope: "materials", kind: "ok", text: `Removed ${asset.name}.` });
    } catch {
      setFeedback({ scope: "materials", kind: "error", text: "could not remove" });
    } finally {
      setBusy(null);
    }
  };

  const feedbackAt = (scope: FeedbackScope) =>
    feedback?.scope === scope ? (
      <p
        role="status"
        className={`mt-1.5 font-mono text-[11px] ${feedback.kind === "error" ? "text-red-500" : "text-accent-text"}`}
      >
        {feedback.text}
      </p>
    ) : null;

  if (!brand) {
    return (
      <div className="flex flex-col items-start gap-2 p-4">
        {loadError ? (
          <>
            <p className="font-mono text-[11px] text-faint">{loadError}</p>
            <button
              type="button"
              onClick={() => void load()}
              className="rounded-md border border-hairline-strong bg-surface px-3 py-1.5 text-[12px] text-ink transition-colors hover:bg-surface-2"
            >
              Try again
            </button>
          </>
        ) : (
          <p className="font-mono text-[11px] text-faint">Loading brand…</p>
        )}
      </div>
    );
  }

  const setRole = (role: Role, hex: string) =>
    setBrand({ ...brand, palette: { ...brand.palette, [role]: hex } });

  // Setting the logo persists AND applies in one step — the swap is
  // deterministic and free, so the panel's "applies instantly" promise holds.
  // Built on the last-saved brand, not the staged one, so the click can't
  // silently commit colour or type picks the user hasn't applied.
  const setLogo = (ref: string) =>
    save({ ...(savedRef.current ?? brand), logo: ref }, true, "logo", "materials");

  // Clearing can't apply: the rewrite only swaps a logo it has a replacement
  // for — there is no removal path for slides already carrying the mark. So
  // this saves without applying and says exactly that.
  const clearLogo = () =>
    save(
      { ...(savedRef.current ?? brand), logo: undefined },
      false,
      "logo",
      "materials",
      "Cleared — existing slides keep the mark; it won’t be used from here on.",
    );

  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto p-4">
      <div>
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted">Brand</p>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">
          Colours, type and logo apply instantly and cost nothing. Guidelines and
          materials steer what gets generated next.
        </p>
      </div>

      {/* ── colours ─────────────────────────────────────────────────── */}
      <section>
        <h3 className="mb-2 text-[12.5px] font-semibold text-ink">Colours</h3>
        <div className="flex flex-col gap-2">
          {ROLES.map(({ key, label }) => {
            const current = brand.palette[key] ?? inUse?.palette?.[key] ?? "";
            const mappable = !!inUse?.palette?.[key];
            return (
              <label key={key} className="flex items-center gap-2.5">
                <input
                  type="color"
                  value={/^#[0-9a-f]{6}$/i.test(current) ? current : "#000000"}
                  onChange={(e) => setRole(key, e.target.value)}
                  disabled={!mappable}
                  className="h-7 w-9 shrink-0 cursor-pointer rounded border border-hairline bg-transparent disabled:cursor-not-allowed disabled:opacity-40"
                  aria-label={label}
                />
                <span className="flex-1 text-[12px] text-ink">{label}</span>
                <span className="font-mono text-[10.5px] text-faint">
                  {mappable ? current || "—" : "not in this deck"}
                </span>
              </label>
            );
          })}
        </div>
        {inUse && inUse.colors.length > 0 && (
          <div className="mt-2.5">
            <p className="mb-1 font-mono text-[9.5px] uppercase tracking-[0.14em] text-faint">
              In this document
            </p>
            <div className="flex flex-wrap gap-1">
              {inUse.colors.slice(0, 10).map((c) => (
                <span
                  key={c.hex}
                  title={`${c.hex} · ${c.count} uses`}
                  className="h-4 w-4 rounded-[3px] border border-hairline"
                  style={{ background: c.hex }}
                />
              ))}
            </div>
          </div>
        )}
      </section>

      {/* ── type ────────────────────────────────────────────────────── */}
      <section>
        <h3 className="mb-2 text-[12.5px] font-semibold text-ink">Type</h3>
        {(["display", "body", "mono"] as const).map((slot) => (
          <div key={slot} className="mb-1.5">
            <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-faint">
              {slot}
            </span>
            <FontSelect
              slot={slot}
              value={brand.fonts[slot] ?? inUse?.fonts?.[slot] ?? ""}
              onChange={(stack) =>
                setBrand({ ...brand, fonts: { ...brand.fonts, [slot]: stack } })
              }
            />
          </div>
        ))}
      </section>

      <div>
        <button
          type="button"
          onClick={() => save(brand, true, "apply", "apply")}
          disabled={!!busy}
          className="rounded-full bg-accent px-3 py-2 text-[12.5px] font-semibold text-accent-ink transition-all hover:brightness-110 disabled:opacity-50"
        >
          {busy === "apply" ? "Applying…" : "Apply to this deck · free"}
        </button>
        {feedbackAt("apply")}
      </div>

      {/* ── materials ───────────────────────────────────────────────── */}
      <section>
        <h3 className="mb-1 text-[12.5px] font-semibold text-ink">Brand materials</h3>
        <p className="mb-2 text-[11.5px] leading-relaxed text-muted">
          Logos, icons, illustrations, JSON, webfonts. Generated elements can use
          these by name.
        </p>
        <div className="flex flex-col gap-1.5">
          {brand.assets.map((a) => (
            <div
              key={a.ref}
              className="flex items-center gap-2 rounded-md border border-hairline bg-surface px-2 py-1.5"
            >
              {a.mime.startsWith("image/") ? (
                <img
                  src={`${apiBase}/asset?scriptId=${encodeURIComponent(scriptId)}&ref=${encodeURIComponent(a.ref)}`}
                  alt=""
                  className="h-6 w-6 shrink-0 rounded object-contain"
                />
              ) : (
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-surface-2 font-mono text-[9px] text-muted">
                  {a.kind.slice(0, 3)}
                </span>
              )}
              <span className="flex-1 truncate text-[11.5px] text-ink">{a.name}</span>
              {brand.logo === a.ref ? (
                <button
                  type="button"
                  onClick={() => clearLogo()}
                  disabled={!!busy}
                  title="Stop using as the logo from here on — existing slides keep it"
                  className="shrink-0 rounded-sm bg-accent-soft px-1.5 py-0.5 font-mono text-[9px] text-accent-text transition-opacity hover:opacity-70 disabled:opacity-50"
                >
                  logo ×
                </button>
              ) : (
                a.mime.startsWith("image/") && (
                  <button
                    type="button"
                    onClick={() => setLogo(a.ref)}
                    disabled={!!busy}
                    className="shrink-0 rounded-sm border border-hairline px-1.5 py-0.5 font-mono text-[9px] text-muted transition-colors hover:border-hairline-strong hover:text-ink disabled:opacity-50"
                  >
                    Use as logo
                  </button>
                )
              )}
              <button
                type="button"
                onClick={() => void removeAsset(a)}
                disabled={!!busy}
                aria-label={`Remove ${a.name}`}
                title="Remove from brand materials"
                className="shrink-0 rounded px-1 font-mono text-[12px] leading-none text-faint transition-colors hover:text-ink disabled:opacity-50"
              >
                ×
              </button>
            </div>
          ))}
          {brand.assets.length === 0 && (
            <p className="font-mono text-[10.5px] text-faint">Nothing uploaded yet.</p>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".png,.jpg,.jpeg,.svg,.webp,.gif,.json,.woff,.woff2,.ttf,.otf"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
          }}
          className="mt-2 w-full text-[11px] text-muted file:mr-2 file:rounded-md file:border file:border-hairline-strong file:bg-surface file:px-2.5 file:py-1 file:text-[11px] file:text-ink"
        />
        {feedbackAt("materials")}
      </section>

      {/* ── guidelines ──────────────────────────────────────────────── */}
      <section>
        <h3 className="mb-1 text-[12.5px] font-semibold text-ink">Brand guidelines</h3>
        <p className="mb-2 text-[11.5px] leading-relaxed text-muted">
          In your own words. Everything generated from here on follows these.
        </p>
        <textarea
          value={brand.guidelines ?? ""}
          onChange={(e) => setBrand({ ...brand, guidelines: e.target.value })}
          rows={6}
          placeholder={
            "Sentence case for headlines.\nNever put the logo on the accent colour.\nWe say “members”, not “users”."
          }
          className="w-full resize-y rounded-md border border-hairline bg-surface px-2 py-1.5 text-[11.5px] leading-relaxed text-ink outline-none focus:border-accent-line"
        />
        <button
          type="button"
          onClick={() => save(brand, false, "guidelines", "guidelines")}
          disabled={!!busy}
          className="mt-1.5 rounded-md border border-hairline-strong bg-surface px-3 py-1.5 text-[12px] text-ink transition-colors hover:bg-surface-2 disabled:opacity-50"
        >
          {busy === "guidelines" ? "Saving…" : "Save guidelines"}
        </button>
        {feedbackAt("guidelines")}
      </section>
    </div>
  );
}
