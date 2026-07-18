/**
 * DETERMINISTIC VOID FURNISH (P3-C3 — void convergence).
 *
 * The systemic failure across four dogfood brands (Fuse, Brex, Deel×2) was VOID
 * NON-CONVERGENCE: the occupancy gate DETECTS a marooned-card-in-a-void or an
 * empty canvas half, routes a FURNISH regen to the hero, the model re-emits the
 * same under-filled frame, the retry budget exhausts, and the void ships flagged
 * (quality-loop.ts's own post-loop comment: "we cannot regen post-loop … ships
 * FLAGGED"). Detecting harder never made a void converge.
 *
 * This module is the CONVERGENCE GUARANTEE and the ONE terminal void arbiter
 * (occupancy detects, furnish converges). Audit-1 High #3: it fills EVERY flagged
 * void — blocking, severe, OR advisory, on ANY register (not only blocking ones)
 * — when the void survives the loop or a motif-blank empties a region. We
 * DETERMINISTICALLY fill the band with a brand-consistent panel — a real
 * secondary surface built from the scene's own blueprint values (padded with the
 * brand name if the scene is value-thin, so a void can't ship for want of
 * content) — injected straight into the assembled composition, at the Chrome
 * anchor or the section root. No model, no retry: a void can no longer ship.
 *
 * The panel is SELF-CONTAINED by construction — literal hex colors, literal font
 * families, inline styles, literal text — so it compiles wherever it is injected
 * (it depends on no emitted const). It carries `data-piece`/`data-kind` so
 * measure-scene resolves it exactly like a cast piece, and the re-measure after
 * injection confirms the void cleared.
 */

// ── color helpers ────────────────────────────────────────────────────────────

/** #rgb / #rrggbb → [r,g,b] (0..255), else null. */
export const parseHex = (hex: string): [number, number, number] | null => {
  const h = (hex ?? "").replace(/^#/, "").trim();
  const s = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
};

/** Relative luminance 0..1 (sRGB-weighted), 0.5 fallback when unparseable. */
export const relLuminance = (hex: string): number => {
  const rgb = parseHex(hex);
  if (!rgb) return 0.5;
  return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
};

/** A readable text color for the given panel surface (near-white on a dark
 *  surface, near-black on a light one) — derived, so the panel never depends on
 *  the theme's ink/canvas being a clean contrast pair. */
export const textOnSurface = (surfaceHex: string): string =>
  relLuminance(surfaceHex) < 0.5 ? "#f4f4f6" : "#16181d";

/** A hairline/separator visible on the surface (translucent light on a dark
 *  surface, translucent dark on a light one). */
export const hairlineOnSurface = (surfaceHex: string): string =>
  relLuminance(surfaceHex) < 0.5 ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.12)";

/** Chroma = max−min channel (0 = neutral gray, high = saturated). */
const chroma = (hex: string): number => {
  const rgb = parseHex(hex);
  if (!rgb) return 999;
  return Math.max(...rgb) - Math.min(...rgb);
};

export const SURFACE_MIN_LUM_CONTRAST = 0.35;
export const SURFACE_MAX_CHROMA = 60;
/** Minimum luminance distance (0..1) an elevated card must clear so it reads as
 *  a distinct surface, not the canvas — ~18/255, matching the placeholder floor. */
export const ELEVATED_SURFACE_MIN_DELTA_L = 0.07;

/**
 * R2 (audit-2) — the ONE elevated-surface picker. Every "an elevated card
 * surface on the brand canvas" decision (the void-furnish panel AND cast-build's
 * compile-break blueprint placeholder) routes through this single luminance
 * policy, so a dark brand can never get a stark-white slab from one picker while
 * the other paints a tasteful dark card.
 *
 * On a DARK canvas it returns a MID-elevated surface — the LEAST-distant palette
 * token that still clears the ΔL floor (the brand's own dark card, e.g. Scale's
 * #171717), NOT the most-distant stark-white extreme (the Mailchimp debug-box
 * defect). On a LIGHT canvas it returns a solid DARK card (the most-distant
 * darker token) so the panel reads clearly on the pale field. Low-chroma only —
 * never a saturated accent (that trips accent-as-fill). Returns the chosen
 * palette entry (name + hex) so a token-ref caller uses `.name` and a
 * literal-hex caller uses `.hex`; null when the palette carries no qualifying
 * token (the caller then applies its own literal/role fallback).
 */
export const pickElevatedSurface = (
  canvasHex: string,
  palette: Array<[string, string]>,
): { name: string; hex: string } | null => {
  const canvasLum = relLuminance(canvasHex);
  const canvasDark = canvasLum < 0.5;
  const cands = palette
    .filter(([, hex]) => parseHex(hex) && chroma(hex) <= SURFACE_MAX_CHROMA)
    .map(([name, hex]) => ({ name, hex, lum: relLuminance(hex), d: Math.abs(relLuminance(hex) - canvasLum) }))
    .filter((c) => c.d >= ELEVATED_SURFACE_MIN_DELTA_L && (canvasDark ? c.lum > canvasLum : c.lum < canvasLum));
  if (cands.length === 0) return null;
  const pick = canvasDark
    ? cands.reduce((a, b) => (b.d < a.d ? b : a)) // mid-elevated (nearest lighter card)
    : cands.reduce((a, b) => (b.d > a.d ? b : a)); // solid dark card on a pale field
  return { name: pick.name, hex: pick.hex };
};

/**
 * Pick the furnish panel surface (a literal hex): the shared elevated-surface
 * policy over the brand palette, with a computed neutral fallback so the panel
 * always contrasts regardless of palette. R2: the dark-canvas fallback is a
 * mid-elevated DARK card (#1c1e24), NEVER stark white — that was the Mailchimp
 * debug-box. The washout gate passes by construction.
 */
export const pickFurnishSurface = (paletteValues: string[], canvasBg: string): string => {
  const picked = pickElevatedSurface(canvasBg, paletteValues.map((h) => ["", h] as [string, string]));
  if (picked) return picked.hex;
  return relLuminance(canvasBg) > 0.5 ? "#181a1f" : "#1c1e24";
};

// ── register-aware furnish decision (P3-C8 #1) ───────────────────────────────

/**
 * A void this fraction of the frame (any axis) on a SPLIT/LIST register is an
 * ABANDONED HALF — an empty column/band the register PROMISED to fill (the
 * Flexport-s1 / Deel-s1 class) — and must furnish even beside an otherwise
 * healthy hero. Below it, a healthy hero's residual air is treated as intentional
 * breathing (a mild bottom/edge band), matching the audit-2 furnish rebalance:
 * furnish stays a rare terminal net, not "fill every empty region". Calibrated on
 * the real Flexport frames: s1 (52% right column, split) FURNISHES; s3 (28% bottom
 * row, list) + s4 (27% bottom row, split) are mild top-weighted breathing bands
 * and SKIP; s0 (centered) + s2 (full-bleed) skip by register. */
export const FURNISH_ABANDONMENT_FRAC = 0.4;

export type FurnishDecision = "furnish-hollow" | "furnish-abandoned" | "skip-healthy";

/**
 * R4 (audit-2) + C8 #1 — the register-aware furnish gate. A genuinely HOLLOW hero
 * (painted below the health floor — the caller passes the boolean) always
 * furnishes its OWN hole. A HEALTHY hero owns its frame — the surrounding air is
 * intentional negative space, furnish suppressed — EXCEPT on a split/list whose
 * void clears FURNISH_ABANDONMENT_FRAC: those registers promise a filled second
 * region, so an abandoned column/band there furnishes (the void band, not the
 * hero's bounds). Centered/quote/full-bleed keep the skip (a centered focal, a
 * quote, or a full-bleed mock legitimately breathes — the Mailchimp-s0 defect the
 * hero-health gate was built to stop).
 */
export const furnishDecision = (
  heroHollow: boolean,
  register: string | undefined,
  runFracW: number,
): FurnishDecision => {
  if (heroHollow) return "furnish-hollow";
  const promisesBothRegions = register === "split" || register === "list";
  if (promisesBothRegions && runFracW >= FURNISH_ABANDONMENT_FRAC) return "furnish-abandoned";
  return "skip-healthy";
};

// ── the furnish panel ────────────────────────────────────────────────────────

export interface FurnishRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FurnishPanelOpts {
  /** Piece id for the injected wrapper, e.g. "s1.furnish". */
  pieceId: string;
  /** Absolute canvas-px rect the panel occupies (already inset from the band). */
  rect: FurnishRect;
  /** Interior/detail values to render as rows (diegetic set dressing). */
  values: string[];
  /** Optional header lifted from the scene (a short clause). */
  title?: string;
  /** Panel surface — resolved by the caller to CONTRAST the scene canvas. */
  surfaceHex: string;
  /** Brand accent (punctuation only — dots/rules, never a fill). */
  accentHex: string;
  /** Literal font families (theme.fonts.*), so the panel is self-contained. */
  fontDisplay: string;
  fontBody: string;
  /** Stacking order (above content pieces, below chrome). Default 6. */
  zIndex?: number;
}

/** JSX-text safe: strip angle/brace and collapse whitespace, cap length. */
const safeText = (s: string, cap = 60): string => {
  const t = (s ?? "").replace(/[<>{}]/g, "").replace(/\s+/g, " ").trim();
  return t.length > cap ? t.slice(0, cap).trim() : t;
};

/** A short, digit-free clause reads as a metric LABEL. */
const isLabelLike = (s: string): boolean =>
  s.length <= 22 && !/\d/.test(s) && s.split(/\s+/).length <= 3 && !/[.!?]$/.test(s);

/**
 * R3 (audit-2): pair a flat token list into label:value ROWS so the furnish
 * panel reads as a real spec sheet, not a raw bullet dump of every extracted
 * token (the Mailchimp debug-box). A short, digit-free label immediately
 * followed by a token that carries a digit (a metric value) becomes ONE
 * {label,value} row; everything else stays a standalone value row.
 */
export const pairValueRows = (values: string[]): Array<{ label?: string; value: string }> => {
  const rows: Array<{ label?: string; value: string }> = [];
  for (let i = 0; i < values.length; i++) {
    const cur = values[i];
    const nxt = values[i + 1];
    if (nxt && isLabelLike(cur) && /\d/.test(nxt)) {
      rows.push({ label: cur, value: nxt });
      i++;
    } else {
      rows.push({ value: cur });
    }
  }
  return rows;
};

/**
 * Build the self-contained JSX for one furnish panel. Returns a positioned
 * `<div data-piece …>` string ready to inject as a Section child. The layout is
 * a header (optional) + a grid of value rows + a footer meta line, filling the
 * rect — a real secondary panel, not a floating chip. Returns "" when there is
 * nothing worth rendering (caller then leaves the residual flagged).
 */
export const buildFurnishPanelJsx = (o: FurnishPanelOpts): string => {
  const values = o.values.map((v) => safeText(v, 64)).filter((v) => v.length >= 2).slice(0, 8);
  if (values.length === 0) return "";
  const surface = o.surfaceHex;
  const ink = textOnSurface(surface);
  const hairline = hairlineOnSurface(surface);
  const accent = o.accentHex;
  const title = o.title ? safeText(o.title, 52) : "";
  const z = o.zIndex ?? 6;
  const { x, y, w, h } = o.rect;

  const inkMuted = relLuminance(surface) < 0.5 ? "rgba(244,244,246,0.62)" : "rgba(22,24,29,0.62)";
  const rows = pairValueRows(values)
    .map((row, i) => {
      const top = i > 0 ? `, borderTop: "1px solid ${hairline}"` : "";
      if (row.label) {
        // label:value spec row — label left (muted), value right (strong).
        return (
          `      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, padding: "13px 4px"${top} }}>` +
          `<span style={{ fontFamily: ${JSON.stringify(o.fontBody)}, fontSize: 15, color: "${inkMuted}", lineHeight: 1.3 }}>${row.label}</span>` +
          `<span style={{ fontFamily: ${JSON.stringify(o.fontBody)}, fontSize: 16, fontWeight: 600, color: "${ink}", lineHeight: 1.3, textAlign: "right" }}>${row.value}</span></div>`
        );
      }
      return (
        `      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 4px"${top} }}>` +
        `<span style={{ width: 7, height: 7, borderRadius: "50%", background: "${accent}", flexShrink: 0 }} />` +
        `<span style={{ fontFamily: ${JSON.stringify(o.fontBody)}, fontSize: 16, color: "${ink}", lineHeight: 1.3 }}>${row.value}</span></div>`
      );
    })
    .join("\n");

  const header = title
    ? `      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>` +
      `<span style={{ width: 5, height: 26, borderRadius: 3, background: "${accent}", flexShrink: 0 }} />` +
      `<span style={{ fontFamily: ${JSON.stringify(o.fontDisplay)}, fontSize: 26, fontWeight: 600, color: "${ink}", lineHeight: 1.05 }}>${title}</span></div>\n`
    : "";

  return (
    `<div data-piece="${o.pieceId}" data-kind="diegetic" style={{ position: "absolute", left: ${Math.round(
      x,
    )}, top: ${Math.round(y)}, width: ${Math.round(w)}, height: ${Math.round(h)}, zIndex: ${z}, boxSizing: "border-box", display: "flex" }}>\n` +
    `    <div style={{ flex: 1, borderRadius: 18, background: "${surface}", boxShadow: "0 20px 54px rgba(0,0,0,0.24)", padding: "26px 30px", boxSizing: "border-box", display: "flex", flexDirection: "column", gap: 14, overflow: "hidden" }}>\n` +
    header +
    `      <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-start" }}>\n` +
    `${rows}\n` +
    `      </div>\n` +
    `    </div>\n` +
    `  </div>`
  );
};

// ── injection into the assembled composition ─────────────────────────────────

/**
 * Insert a furnish panel as a child of Section{scene}, just before its
 * `<Chrome sceneIndex={scene}` mount (so it sits above content pieces and below
 * the chrome). Audit-1 High #3 edit (5): when the Chrome anchor is absent (a
 * malformed section), fall back to injecting right after Section{scene}'s
 * `<style …/>` line (its ROOT), so the panel still lands in the correct scene
 * and a void can't ship for want of an anchor. Only returns { injected:false }
 * when NEITHER anchor exists (a genuinely unrecognizable section) — the caller
 * then leaves the void flagged (never breaks the build).
 */
export const injectFurnishIntoSection = (
  code: string,
  scene: number,
  panelJsx: string,
): { code: string; injected: boolean } => {
  if (!panelJsx) return { code, injected: false };
  const injectAtLine = (at: number): { code: string; injected: boolean } => {
    const lineStart = code.lastIndexOf("\n", at) + 1;
    const indent = code.slice(lineStart, at); // leading whitespace of the anchor line
    return {
      code: code.slice(0, lineStart) + indent + panelJsx + "\n" + code.slice(lineStart),
      injected: true,
    };
  };
  const chrome = code.indexOf(`<Chrome sceneIndex={${scene}}`);
  if (chrome !== -1) return injectAtLine(chrome);
  // Fallback: land inside Section{scene}'s root, just after its <style …/> line.
  const decl = code.indexOf(`export const Section${scene}:`);
  if (decl !== -1) {
    const style = code.indexOf("<style dangerouslySetInnerHTML", decl);
    if (style !== -1) {
      const nl = code.indexOf("\n", style);
      const injectAt = nl >= 0 ? nl + 1 : style;
      // Anchor on the FIRST char of the following line so indent is captured.
      return injectAtLine(injectAt + (code.slice(injectAt).match(/^[ \t]*/)?.[0].length ?? 0));
    }
  }
  return { code, injected: false };
};

// ── the void → furnish rect mapping ──────────────────────────────────────────

/** Margin inset (canvas px) kept between the furnish panel and the band edges /
 *  frame edges, so the panel breathes rather than running edge-to-edge. */
export const FURNISH_INSET_PX = 28;
/** The furnish panel's vertical extent as a fraction of canvas height (a
 *  comfortable central band, leaving air top and bottom). */
export const FURNISH_V_FRAC = 0.72;

/**
 * Map a detected void band (fractional x-range) to the absolute-px rect the
 * furnish panel should occupy: the band inset by FURNISH_INSET_PX, centered
 * vertically over FURNISH_V_FRAC of the canvas height. Clamped to stay on
 * canvas. Returns null when the band is too thin to furnish meaningfully.
 */
export const furnishRectForBand = (
  band: { startFracW: number; endFracW: number },
  canvas: { w: number; h: number },
): FurnishRect | null => {
  const x0 = band.startFracW * canvas.w + FURNISH_INSET_PX;
  const x1 = band.endFracW * canvas.w - FURNISH_INSET_PX;
  const w = x1 - x0;
  if (w < 180) return null; // too thin for a legible panel
  const h = FURNISH_V_FRAC * canvas.h;
  const y = (canvas.h - h) / 2;
  return {
    x: Math.max(FURNISH_INSET_PX, x0),
    y: Math.max(FURNISH_INSET_PX, y),
    w: Math.min(w, canvas.w - 2 * FURNISH_INSET_PX),
    h: Math.min(h, canvas.h - 2 * FURNISH_INSET_PX),
  };
};

/** The horizontal fraction the furnish panel occupies within a ROW band (a wide
 *  central strip, leaving air left and right). */
export const FURNISH_H_FRAC = 0.86;

/**
 * P3-C5: map a detected HORIZONTAL void band (fractional y-range, full width) to
 * the absolute-px rect a furnish panel should occupy — the band inset by
 * FURNISH_INSET_PX, centered horizontally over FURNISH_H_FRAC of the canvas
 * width. Clamped to stay on canvas. Returns null when the band is too short to
 * furnish a legible panel.
 */
export const furnishRectForRowBand = (
  rowBand: { startFracH: number; endFracH: number },
  canvas: { w: number; h: number },
): FurnishRect | null => {
  const y0 = rowBand.startFracH * canvas.h + FURNISH_INSET_PX;
  const y1 = rowBand.endFracH * canvas.h - FURNISH_INSET_PX;
  const h = y1 - y0;
  if (h < 120) return null; // too short for a legible panel
  const w = FURNISH_H_FRAC * canvas.w;
  const x = (canvas.w - w) / 2;
  return {
    x: Math.max(FURNISH_INSET_PX, x),
    y: Math.max(FURNISH_INSET_PX, y0),
    w: Math.min(w, canvas.w - 2 * FURNISH_INSET_PX),
    h: Math.min(h, canvas.h - 2 * FURNISH_INSET_PX),
  };
};
