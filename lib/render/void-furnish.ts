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

/**
 * Pick the furnish panel surface: a color that CONTRASTS the scene canvas
 * (opposite luminance side) and reads as a neutral surface (low chroma — never a
 * saturated accent, which would trip the accent-as-fill gate). Prefers an
 * on-brand palette token that qualifies; falls back to a computed neutral
 * (dark surface on a light canvas, light surface on a dark canvas) so the panel
 * always contrasts regardless of palette. The washout gate passes by
 * construction — the surface is on the far luminance side of the canvas.
 */
export const SURFACE_MIN_LUM_CONTRAST = 0.35;
export const SURFACE_MAX_CHROMA = 60;
export const pickFurnishSurface = (paletteValues: string[], canvasBg: string): string => {
  const canvasLum = relLuminance(canvasBg);
  let best: { hex: string; d: number } | null = null;
  for (const hex of paletteValues) {
    if (!parseHex(hex)) continue;
    const d = Math.abs(relLuminance(hex) - canvasLum);
    if (d < SURFACE_MIN_LUM_CONTRAST || chroma(hex) > SURFACE_MAX_CHROMA) continue;
    if (!best || d > best.d) best = { hex, d };
  }
  if (best) return best.hex;
  return canvasLum > 0.5 ? "#181a1f" : "#f4f4f6";
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

  const rows = values
    .map(
      (v, i) =>
        `      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 4px"${
          i > 0 ? `, borderTop: "1px solid ${hairline}"` : ""
        } }}>` +
        `<span style={{ width: 7, height: 7, borderRadius: "50%", background: "${accent}", flexShrink: 0 }} />` +
        `<span style={{ fontFamily: ${JSON.stringify(o.fontBody)}, fontSize: 16, color: "${ink}", lineHeight: 1.3 }}>${v}</span></div>`,
    )
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
