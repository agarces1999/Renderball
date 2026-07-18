/**
 * Render-truth gates — deterministic correctness checks on the MEASURED render.
 *
 * These consume measure-scene.ts output (real element rects + computed colors +
 * a screenshot) and replace the static approximations that kept missing real
 * defects:
 *   • overflow  — an element with content crosses the canvas edge → clipped.
 *                 Pure geometry on measured rects; zero false positives (a
 *                 measured x+w>1920 is a fact, not a guess). This is what the
 *                 static findOverflowingElements only approximated from declared
 *                 inline width/left.
 *   • contrast  — text or a logo image rendered with too little luminance
 *                 contrast against the pixels actually behind it (the
 *                 light-on-light logo case). Sampled from the screenshot.
 *   • dead-region — measured empty quadrants (reuses painted-content.ts).
 *
 * Findings are returned, not thrown; the pipeline decides blocking vs advisory.
 */
import path from "path";
import { assessEmptyBand } from "./painted-content";
import type { SceneMeasurement, MeasuredElement } from "./measure-scene";

export type RenderTruthKind =
  | "overflow"
  | "cross-piece-overlap"
  | "barbell"
  | "canvas-brightness"
  | "canvas-coherence"
  | "corner-mark-collision"
  | "hollow-cta"
  | "intra-piece-overlap"
  | "ghost-fragment"
  | "stray-card"
  | "mock-occlusion"
  | "stranded-hero"
  | "measure-error";

export interface RenderTruthFinding {
  scene: number;
  kind: RenderTruthKind;
  detail: string;
}

// px tolerance so sub-pixel rounding / intentional full-bleed don't false-fire.
const EDGE_TOL = 3;
// Only content elements can be "clipped"; a full-bleed background/atmosphere
// legitimately fills or exceeds the canvas. Content = has own text or is an <img>.
const isContentEl = (e: MeasuredElement): boolean =>
  (e.text.length >= 2 || e.isImg) && e.opacity > 0.05;

/** Elements with content whose measured box crosses the canvas edge. */
export const findOverflow = (m: SceneMeasurement): RenderTruthFinding[] => {
  if (m.error) return [{ scene: m.scene, kind: "measure-error", detail: m.error }];
  const out: RenderTruthFinding[] = [];
  for (const e of m.elements) {
    if (!isContentEl(e)) continue;
    const overR = e.x + e.w > m.width + EDGE_TOL;
    const overL = e.x < -EDGE_TOL;
    const overB = e.y + e.h > m.height + EDGE_TOL;
    const overT = e.y < -EDGE_TOL;
    if (!(overR || overL || overB || overT)) continue;
    const where = [overL && "left", overR && "right", overT && "top", overB && "bottom"]
      .filter(Boolean)
      .join("+");
    const label = e.text ? `"${e.text.slice(0, 40)}"` : `<img ${(e.src || "").slice(-28)}>`;
    out.push({
      scene: m.scene,
      kind: "overflow",
      detail: `${e.tag} ${label} clipped at ${where} (box ${e.x},${e.y} ${e.w}×${e.h} on ${m.width}×${m.height})`,
    });
  }
  return out;
};

// ── cross-piece overlap (a title colliding with a diegetic mock) ─────────────
// The overlap class the text-vs-text gate can't see: a free-standing TEXT block
// from one LEGO piece intersecting an OPAQUE PANEL from a DIFFERENT piece — a
// headline clipped by (or unreadably printed over) a UI mock. Shipped in 2 of 3
// brands in one batch (Framer s1+s2: headlines cut mid-glyph by the editor
// mocks), so this is a high-frequency, ship-blocking class. Precision guards:
//   - the text must be on the CANVAS (own bg transparent AND not sitting on an
//     opaque/gradient ancestor surface within its own piece — an overlay card
//     like Arc s0's headline-on-browser is intentional and excluded),
//   - the text must be COVERED at its center (elementFromPoint stacking truth:
//     something else painted on top — text that is visibly on top never flags;
//     validated against 4 real builds where geometric overlap alone false-fired),
//   - the other element must be a substantive opaque panel (real surface, not
//     atmosphere glow — gradients report transparent backgroundColor),
//   - same-piece overlap is by-design (labels inside their own mock).
const XP_MIN_TEXT_PX = 24; // headline/lede class, not micro-labels (covered case)
const XP_MIN_TEXT_LEN = 8;
const XP_MIN_PANEL_AREA = 40_000; // ≥ ~200×200 — a real panel
const XP_MIN_PANEL_ALPHA = 0.5;
const XP_MIN_FRAC = 0.2; // ≥20% of the text box intersected ⇒ a collision
// Straddle case (QA: Fuse s3 annotation bullets crossing the panel grid): text
// PARTIALLY intersecting a panel reads as a collision regardless of z-order —
// half the line sits on the canvas, half on the panel, breaking contrast and
// crossing the panel's edge/labels. FULL containment stays the sanctioned
// overlay pattern (Loom s0: headline entirely over the dimmed mock).
const XP_STRADDLE_MIN_PX = 14; // catches 18px annotation bullets
const XP_STRADDLE_MIN_FRAC = 0.12; // below: grazing contact (descenders touching an edge)
const XP_STRADDLE_MAX_FRAC = 0.9; // above: effectively contained = overlay
// Cross-piece TEXT-ON-TEXT (Cases C+D). Case C (v11, Fuse s3): ANNOTATION-band
// canvas text (11-20px) printed across ONE foreign label = a collision —
// replayed on 4 live builds, fires on Fuse and nothing else. Case D (v12 —
// dogfood cycle 3, Linear s1): COPY-band canvas text (21-32px) WOVEN through a
// foreign piece's rows — the copy column interleaved through a full-canvas
// app-shell's activity feed. The discriminator vs the sanctioned Loom overlay
// (a 24px lede composed over ONE dimmed calendar label — a replayed
// false-positive class that must stay exempt): a weave hits ≥2 DISTINCT text
// nodes of the SAME foreign piece; a deliberate overlay grazes at most one.
// Display-size copy (≥33px) stays governed by Cases A/B entirely.
const XP_TT_MAX_PX = 20; // annotation band: single overlapped label fires
const XP_ANY_TT_MIN_FRAC = 0.25; // of the smaller text box
const XP_ANY_TT_MIN_OTHER_LEN = 3; // the run-over text must be real copy, not a glyph
const XP_ANY_TT_MAX_CANVAS_PX = 32; // copy band ceiling; ≥33px = display (A/B territory)
const XP_ANY_TT_MIN_OTHER_PX = 8; // run-over text can be mock micro-labels
const XP_ANY_TT_MIN_WEAVE_HITS = 2; // 21-32px copy must hit ≥2 nodes of one piece

/** Free-standing text from piece A colliding with piece B: covered-under-panel,
 *  straddling a panel edge, or printed across another piece's text. */
export const findCrossPieceOverlap = (m: SceneMeasurement): RenderTruthFinding[] => {
  if (m.error) return [];
  const canvasTexts = m.elements.filter(
    (e) =>
      !e.isImg &&
      e.piece &&
      !e.onOpaqueSurface &&
      e.text.trim().length >= XP_MIN_TEXT_LEN &&
      e.opacity > 0.1 &&
      cssAlpha(e.bg) < 0.15,
  );
  const panels = m.elements.filter(
    (e) =>
      e.piece &&
      e.opacity > 0.1 &&
      cssAlpha(e.bg) >= XP_MIN_PANEL_ALPHA &&
      e.w * e.h >= XP_MIN_PANEL_AREA &&
      // full-bleed backgrounds are the canvas, not a panel
      !(e.w >= m.width * 0.97 && e.h >= m.height * 0.97),
  );
  const otherTexts = m.elements.filter(
    (e) =>
      !e.isImg &&
      e.piece &&
      e.text.trim().length >= XP_ANY_TT_MIN_OTHER_LEN &&
      e.fontSize >= XP_ANY_TT_MIN_OTHER_PX &&
      e.opacity > 0.3,
  );
  const out: RenderTruthFinding[] = [];
  const seen = new Set<string>();
  const push = (key: string, finding: RenderTruthFinding) => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push(finding);
  };
  for (const t of canvasTexts) {
    for (const p of panels) {
      if (t.piece === p.piece) continue; // same piece = by design
      const ix = Math.min(t.x + t.w, p.x + p.w) - Math.max(t.x, p.x);
      const iy = Math.min(t.y + t.h, p.y + p.h) - Math.max(t.y, p.y);
      if (ix <= 0 || iy <= 0) continue;
      const frac = (ix * iy) / Math.max(1, t.w * t.h);
      // Case A — text CLIPPED UNDER the panel (Framer class): stacking truth.
      if (t.coveredAtCenter && t.fontSize >= XP_MIN_TEXT_PX && frac >= XP_MIN_FRAC) {
        push(`${t.piece}|${p.piece}|${t.text.slice(0, 20)}`, {
          scene: m.scene,
          kind: "cross-piece-overlap",
          detail:
            `text "${t.text.slice(0, 36)}" (piece ${t.piece}) collides with the opaque panel of piece ` +
            `${p.piece} — ${Math.round(frac * 100)}% of the text box is covered ` +
            `(text @${t.x},${t.y} ${t.w}×${t.h} ∩ panel @${p.x},${p.y} ${p.w}×${p.h}). ` +
            `Move or shrink one so the copy clears the mock, or give the text its own opaque surface/scrim.`,
        });
        continue;
      }
      // Case B — text STRADDLING the panel edge (Fuse s3 class): partial
      // intersection is a collision at any stacking order; full containment
      // is the sanctioned overlay and stays allowed.
      if (
        t.fontSize >= XP_STRADDLE_MIN_PX &&
        frac >= XP_STRADDLE_MIN_FRAC &&
        frac <= XP_STRADDLE_MAX_FRAC
      ) {
        push(`straddle|${t.piece}|${p.piece}|${t.text.slice(0, 20)}`, {
          scene: m.scene,
          kind: "cross-piece-overlap",
          detail:
            `text "${t.text.slice(0, 36)}" (piece ${t.piece}) STRADDLES the edge of piece ${p.piece}'s ` +
            `panel — ${Math.round(frac * 100)}% inside, the rest on the canvas (text @${t.x},${t.y} ` +
            `${t.w}×${t.h} ∩ panel @${p.x},${p.y} ${p.w}×${p.h}). Text must sit fully clear of the ` +
            `panel or fully inside it on a readable surface — never across its boundary.`,
        });
      }
    }
    // Cases C/D — copy-class text printed across ANOTHER piece's text nodes.
    // C: annotation band (≤20px) fires on a single overlapped label (Fuse).
    // D (v12): copy band (21-32px) fires when it WEAVES through ≥2 distinct
    // text nodes of the same foreign piece (the Linear s1 interleave); a
    // single grazed label stays the sanctioned Loom overlay. Display ≥33px
    // is Cases A/B territory.
    if (t.fontSize > XP_ANY_TT_MAX_CANVAS_PX) continue;
    const hitsByPiece = new Map<string, { o: MeasuredElement; frac: number }[]>();
    for (const o of otherTexts) {
      if (o.piece === t.piece) continue;
      const ix = Math.min(t.x + t.w, o.x + o.w) - Math.max(t.x, o.x);
      const iy = Math.min(t.y + t.h, o.y + o.h) - Math.max(t.y, o.y);
      if (ix <= 0 || iy <= 0) continue;
      const minArea = Math.max(1, Math.min(t.w * t.h, o.w * o.h));
      const frac = (ix * iy) / minArea;
      if (frac < XP_ANY_TT_MIN_FRAC) continue;
      hitsByPiece.set(o.piece, [...(hitsByPiece.get(o.piece) ?? []), { o, frac }]);
    }
    for (const [oPiece, hits] of hitsByPiece) {
      const distinctNodes = new Set(hits.map((h) => `${h.o.text}|${h.o.x},${h.o.y}`)).size;
      const fires = t.fontSize <= XP_TT_MAX_PX ? true : distinctNodes >= XP_ANY_TT_MIN_WEAVE_HITS;
      if (!fires) continue;
      const worst = hits.slice().sort((a, b) => b.frac - a.frac)[0];
      push(`tt|${t.piece}|${oPiece}|${t.text.slice(0, 14)}`, {
        scene: m.scene,
        kind: "cross-piece-overlap",
        detail:
          `text "${t.text.slice(0, 32)}" (piece ${t.piece}, ${t.fontSize}px) is printed across ` +
          `${distinctNodes} text node(s) of piece ${oPiece} (worst: "${worst.o.text.slice(0, 32)}", ` +
          `${Math.round(worst.frac * 100)}% of the smaller box). Fix BOTH sides: ${oPiece} must keep ` +
          `every row/label strictly inside its own slot (never extend under the copy column), and ` +
          `${t.piece} must set its text on an opaque panel that owns its column (or move fully clear).`,
      });
    }
  }
  return out;
};

// ── barbell / empty-band (a tall empty horizontal strip inside the safe area) ─
// The overflow gate catches content pushed OFF the canvas; this catches content
// that VACATES a large horizontal band OF the canvas — the "barbell" (a cluster
// up top, a cluster at the bottom, a void between) and the "empty lower half".
// The design-agent prose rules ("space-between is NOT a hollow barbell", "no
// internal empty band >~120px") target exactly this, but the agent obeys them
// inconsistently, and every prior anti-barbell fix pulled only the SPAN lever
// (content reaches top+bottom) — which a tiny eyebrow-at-top + dots-at-bottom
// satisfies while the middle stays empty. This measures the actual empty band.
//
// PIXEL-truth (not element rects): it scans painted ink per row of the settled
// screenshot, so a thin-bar visualization (waveform, sparkline, bar chart) reads
// as filled — its bars ARE ink — while a soft gradient backdrop is discarded by
// the same dominant-background subtraction the dead-region gate uses. A rect/
// element filter can't tell a 4px waveform bar from decoration; ink can.
const BAND_FAIL_FRAC = 0.3; // an empty interior band over this frac of H ⇒ barbell

/** Tallest empty horizontal band on the settled frame; barbell over BAND_FAIL_FRAC. */
export const findEmptyBand = async (m: SceneMeasurement): Promise<RenderTruthFinding[]> => {
  if (m.error || !m.screenshotPath) return []; // measure-error already surfaced by findOverflow
  try {
    const { bandFracH, startFracH } = await assessEmptyBand(m.screenshotPath);
    if (bandFracH < BAND_FAIL_FRAC) return [];
    const bandPx = Math.round(bandFracH * m.height);
    const startPx = Math.round(startFracH * m.height);
    return [
      {
        scene: m.scene,
        kind: "barbell",
        detail:
          `empty horizontal band ~${bandPx}px tall (from y≈${startPx} of ${m.height}, ` +
          `~${Math.round(bandFracH * 100)}% of the frame) carries no painted content — a barbell / ` +
          `empty-band. Fill it: scale the hero or diegetic element up so it occupies the middle, or add ` +
          `a real supporting row (a chart, KPI tiles, a caption/meta cluster) inside that band. Do NOT ` +
          `stretch a top cluster and a bottom cluster apart with empty space between (the barbell failure).`,
      },
    ];
  } catch (err) {
    // Fail OPEN deliberately (a measurement-infra error must not block a build) —
    // but never silently: barbell is a BLOCKING gate, so a broken screenshot/sharp
    // path would otherwise disable it without a trace.
    console.warn(
      `[render-truth] findEmptyBand skipped for scene ${m.scene}: ${err instanceof Error ? err.message : err}`,
    );
    return [];
  }
};

// OVERLAP_MIN_TEXT_PX — shared by findIntraPieceOverlap below (a text node must
// be a real block, not a hairline caption, to count in an overlap).
const OVERLAP_MIN_TEXT_PX = 12;

// Alpha of a CSS rgb/rgba color. rgb(...) (no alpha) ⇒ opaque (1). Used to keep
// the check to text sitting on the CANVAS — text on an opaque chip/card/badge
// overlaps that surface by design and must not be flagged.
const cssAlpha = (color: string): number => {
  const m = /rgba?\(([^)]+)\)/.exec(color || "");
  if (!m) return 0; // no parseable bg ⇒ treat as transparent
  const p = m[1].split(",").map((v) => parseFloat(v.trim()));
  return p.length >= 4 ? (Number.isNaN(p[3]) ? 1 : p[3]) : 1;
};

/** [r,g,b] of a CSS rgb()/rgba() string (0-255), or null when unparseable. */
const rgbTriplet = (color: string): [number, number, number] | null => {
  const m = /rgba?\(([^)]+)\)/.exec(color || "");
  if (!m) return null;
  const p = m[1].split(",").map((v) => parseFloat(v.trim()));
  if (p.length < 3 || p.slice(0, 3).some((v) => Number.isNaN(v))) return null;
  return [p[0], p[1], p[2]];
};

// Inline text containers — emphasis tags AND span/a/label — sit INSIDE a parent
// text block (a colored accent word via lastWordAccent, a styled <span>), so they
// must never count as a separate colliding block (they'd false-fire against their
// own parent). A real headline-buries-lede collision is always between BLOCK-level
// text (h1/h2/p/div/li). Tag-based exclusion is REQUIRED because measure-scene
// reports a parent's OWN text node (excluding inline-child text), so the
// substring-containment skip below can't catch an accent child geometrically.
const INLINE_TEXT_TAGS = new Set([
  "span", "a", "label", "time", "cite",
  "em", "i", "b", "strong", "mark", "sub", "sup", "small", "u", "s", "code", "kbd", "abbr",
]);

// Audit-1 Medium #5: findTextOverlap (the whole-box text-on-text advisory) was
// DELETED — it never reached blockingKinds and is superseded by the per-node
// findIntraPieceOverlap (same-piece control-over-text) + findCrossPieceOverlap
// (cross-piece) below. isOverlapText / OVERLAP_MIN_FRAC went with it.

// ── color/luminance helpers (WCAG relative luminance) ────────────────────────
const relLum = (r: number, g: number, b: number): number => {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};

// Audit-1 Medium #5: findContrast (logo-luminance-range advisory — a dup of the
// image-integrity gate; its text arm was already retired in v15) and
// findDeadRegion (quadrant-ink advisory — superseded by the occupancy gate +
// deterministic void furnish) were both DELETED. Neither reached blockingKinds;
// LOGO_RANGE_FLOOR / MIN_LOGO / INK_FLOOR / QUADRANT_FLOOR / assessFrameInk went
// with them. Logo readability is the vision/image-integrity gate's job.

// ── canvas-brightness (light brand shipped on a dark canvas) ─────────────────
// The #1 brand-fidelity miss: a fundamentally LIGHT brand (Glossier, Canva,
// Notion, Shopify, Airtable, Ramp) rendered with a near-black default canvas.
// The design-agent prompt rule (Layer 1) is the primary defense; this is the
// deterministic Layer-2 backstop the prompt rule lacked. Advisory by default.
const LIGHT_BRAND_LUM = 0.6; // brand background this bright ⇒ a "light brand"
const DARK_CANVAS_LUM = 0.3; // a rendered scene canvas this dark ⇒ "dark canvas"
const MAX_DARK_SCENES = 1; // one deliberate dark/contrast scene is allowed

/** WCAG relative luminance of a #rrggbb hex (null if unparseable). */
export const hexLuminance = (hex: string): number | null => {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return relLum((n >> 16) & 255, (n >> 8) & 255, n & 255);
};

/**
 * PURE: given the brand background + each scene's measured canvas luminance,
 * flag the light-brand-shipped-dark case. Only fires for a LIGHT brand (bg lum
 * > 0.6) with MORE THAN ONE dark-canvas scene (one dark contrast scene is fine).
 * Dark/mid brands return nothing. Separated from the pixel measurement so the
 * rule is unit-tested without an image.
 */
export const assessCanvasBrightness = (
  brandBackground: string | undefined,
  sceneLumas: { scene: number; lum: number | null }[],
): RenderTruthFinding[] => {
  if (!brandBackground) return [];
  const brandLum = hexLuminance(brandBackground);
  if (brandLum == null || brandLum <= LIGHT_BRAND_LUM) return []; // light brands only
  const dark = sceneLumas.filter(
    (s): s is { scene: number; lum: number } =>
      s.lum != null && s.lum < DARK_CANVAS_LUM,
  );
  if (dark.length <= MAX_DARK_SCENES) return [];
  return dark.map((s) => ({
    scene: s.scene,
    kind: "canvas-brightness" as const,
    detail:
      `light brand (background ${brandBackground}, lum ${brandLum.toFixed(2)}) but this scene's ` +
      `canvas is dark (lum ${s.lum.toFixed(2)}); ${dark.length}/${sceneLumas.length} scenes are dark — ` +
      `keep the default canvas light, at most one dark contrast scene`,
  }));
};

/** Median luminance of the downsampled frame — the canvas (background) dominates
 *  the frame area, so the median ≈ the canvas brightness, robust to foreground
 *  content. null if sharp is unavailable or the read fails (best-effort). */
const frameCanvasLuminance = async (
  screenshotPath: string,
): Promise<number | null> => {
  const sharpMod = await import("sharp").catch(() => null);
  if (!sharpMod) return null;
  try {
    const { data, info } = await sharpMod
      .default(screenshotPath)
      .resize({ width: 64, withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const ch = info.channels;
    const lums: number[] = [];
    for (let i = 0; i + 2 < data.length; i += ch) {
      lums.push(relLum(data[i], data[i + 1], data[i + 2]));
    }
    if (lums.length === 0) return null;
    lums.sort((a, b) => a - b);
    return lums[Math.floor(lums.length / 2)];
  } catch {
    return null;
  }
};

/** Measure each scene's canvas luminance + apply the light-brand rule. */
export const findCanvasBrightness = async (
  measurements: SceneMeasurement[],
  brandBackground: string | undefined,
): Promise<RenderTruthFinding[]> => {
  const brandLum = brandBackground ? hexLuminance(brandBackground) : null;
  if (brandLum == null || brandLum <= LIGHT_BRAND_LUM) return []; // skip non-light brands (no pixel work)
  const sceneLumas = await Promise.all(
    measurements.map(async (m) => ({
      scene: m.scene,
      lum:
        m.error || !m.screenshotPath
          ? null
          : await frameCanvasLuminance(m.screenshotPath),
    })),
  );
  return assessCanvasBrightness(brandBackground, sceneLumas);
};

// ── canvas COHERENCE (a scene shipped on an off-brand canvas) ────────────────
// The P3-C1 Fuse defect the light-brand canvas-brightness gate could not see:
// Fuse is a DARK burgundy brand (#440b12), and 4 of 5 scenes shipped that warm
// canvas — but scene 3 shipped a NEUTRAL near-black (#1a1a1a-class) canvas that
// broke the video's canvas coherence. canvas-brightness only fires for LIGHT
// brands (lum > 0.6), so a dark brand shipping one off-color scene is invisible
// to it. This gate is brand-agnostic: it compares each scene's median frame
// color to the BRAND canvas color and flags a scene whose canvas has drifted
// off-brand (a large RGB distance OR a collapse of the brand's chroma). Pure
// color math on the downsampled frame; advisory-vs-blocking is the caller's.
//
// CALIBRATION (agent-measured median RGB of the real Fuse frames vs brand
// #440b12 = (68,11,18), chroma 57):
//   MUST FIRE  — s3 (26,26,30): RGB dist 46, chroma 4 (neutral — lost the warm)
//   MUST PASS  — s0 (60,10,16) dist 9 · s1 (76,24,30) dist 19 · s2 (79,17,24)
//                dist 14 · s4 (68,12,18) dist 1 — all chroma 50–62, on-brand.
// dist floor 30 keeps ≥11pt margin on both sides; the chroma-collapse arm is a
// second, independent confirmation for a chromatic brand. Skipped entirely when
// the brand canvas is unparseable (no reference to compare against).
export const CANVAS_COHERENCE_RGB_DELTA = 30;
/** A brand canvas with at least this chroma is "chromatic" — a scene that
 *  collapses to near-neutral (below CANVAS_NEUTRAL_CHROMA) has lost the brand
 *  canvas color, an independent incoherence signal. */
const CANVAS_BRAND_CHROMATIC_MIN = 30;
const CANVAS_NEUTRAL_CHROMA = 14;
/** Two chromatic canvases whose hues differ by more than this (degrees) read as
 *  DIFFERENT brand colors — an off-brand hue drift, not a lightness inversion. */
const CANVAS_HUE_DRIFT_TOL = 40;

const hexRgb = (hex: string): [number, number, number] | null => {
  const m = /^#?([0-9a-fA-F]{6})$/.exec((hex ?? "").trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const chromaOf = (r: number, g: number, b: number): number =>
  Math.max(r, g, b) - Math.min(r, g, b);
const canvasRgbDist = (a: [number, number, number], b: [number, number, number]): number =>
  Math.round(Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2));

/** HSV hue in degrees (0-360), or null for a near-neutral color (no meaningful
 *  hue). Audit-1 High #4: lets coherence tell a HUE drift (off-brand) from a
 *  pure LIGHTNESS swing (a deliberate contrast scene keeping the brand hue). */
const HUE_MIN_CHROMA = 20; // below this a color has no reliable hue
export const hueOf = (r: number, g: number, b: number): number | null => {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d < HUE_MIN_CHROMA) return null;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
};
const hueDelta = (a: number, b: number): number => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

/** Median RGB of the frame's BORDER/GUTTER ring, NOT the whole frame. Audit-1
 *  High #4: the canvas is what shows at the edges behind every element; sampling
 *  the whole-frame median let a large centered furnish panel (the deterministic
 *  void fill) BE the median and read as an off-brand canvas — a fill↔coherence
 *  oscillation. The outer ring is the real canvas even when the center is full.
 *  null on failure. */
const BORDER_RING_FRAC = 0.1;
const frameCanvasColor = async (
  screenshotPath: string,
): Promise<[number, number, number] | null> => {
  const sharpMod = await import("sharp").catch(() => null);
  if (!sharpMod) return null;
  try {
    const { data, info } = await sharpMod
      .default(screenshotPath)
      .resize({ width: 64, withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const ch = info.channels;
    const W = info.width, H = info.height;
    const mx = Math.max(1, Math.round(W * BORDER_RING_FRAC));
    const my = Math.max(1, Math.round(H * BORDER_RING_FRAC));
    const rs: number[] = [], gs: number[] = [], bs: number[] = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        // Border ring only: the outer margin on any side.
        if (x >= mx && x < W - mx && y >= my && y < H - my) continue;
        const i = (y * W + x) * ch;
        rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]);
      }
    }
    if (rs.length === 0) return null;
    const med = (a: number[]): number => {
      const s = [...a].sort((x, y) => x - y);
      return s[Math.floor(s.length / 2)];
    };
    return [med(rs), med(gs), med(bs)];
  } catch {
    return null;
  }
};

/**
 * PURE: given the brand canvas color + each scene's measured canvas color, flag
 * scenes whose canvas has drifted OFF-BRAND. Audit-1 High #4 reconciles this with
 * the canvas-BRIGHTNESS gate, which allows MAX_DARK_SCENES deliberate contrast
 * scenes: coherence now grants the SAME budget. A scene that trips the RGB delta
 * is classified —
 *   • chroma-collapse (brand is chromatic, scene went neutral)  → ALWAYS off-brand
 *   • invented hue (scene is chromatic, brand is neutral)        → ALWAYS off-brand
 *   • hue drift (both chromatic, hues far apart)                 → ALWAYS off-brand
 *   • pure LUMINANCE inversion (same hue family / neutral swing) → BUDGETED: the
 *     first MAX_DARK_SCENES are allowed (a deliberate contrast scene keeps the
 *     brand hue, only its lightness inverts); the EXCESS is flagged.
 * This kills the old contradiction where brightness permitted one dark contrast
 * scene but coherence blocked it for being far from a light brand's canvas.
 * Separated from the pixel read so the rule is unit-tested without an image.
 */
export const assessCanvasCoherence = (
  brandBackground: string | undefined,
  sceneColors: { scene: number; rgb: [number, number, number] | null }[],
): RenderTruthFinding[] => {
  const brand = brandBackground ? hexRgb(brandBackground) : null;
  if (!brand) return []; // no reference → skip (never fabricate a canvas truth)
  const brandChroma = chromaOf(brand[0], brand[1], brand[2]);
  const brandChromatic = brandChroma >= CANVAS_BRAND_CHROMATIC_MIN;
  const brandHue = hueOf(brand[0], brand[1], brand[2]);
  const off: RenderTruthFinding[] = [];
  const inversions: { scene: number; rgb: [number, number, number]; dist: number }[] = [];
  for (const s of sceneColors) {
    if (!s.rgb) continue;
    const [r, g, b] = s.rgb;
    const dist = canvasRgbDist(s.rgb, brand);
    const sceneChroma = chromaOf(r, g, b);
    const chromaCollapse = brandChromatic && sceneChroma < CANVAS_NEUTRAL_CHROMA;
    if (dist < CANVAS_COHERENCE_RGB_DELTA && !chromaCollapse) continue; // coherent

    const sceneHue = hueOf(r, g, b);
    const inventedHue = !brandChromatic && sceneChroma >= CANVAS_BRAND_CHROMATIC_MIN;
    const hueDrift =
      brandHue !== null && sceneHue !== null && hueDelta(brandHue, sceneHue) > CANVAS_HUE_DRIFT_TOL;

    if (chromaCollapse || inventedHue || hueDrift) {
      const why = chromaCollapse
        ? `its chroma collapsed to ${sceneChroma} (brand chroma ${brandChroma}) — a neutral where the brand is colored`
        : inventedHue
          ? `it invented a saturated hue (chroma ${sceneChroma}) the neutral brand canvas does not have`
          : `its hue drifted off-brand (${Math.round(sceneHue ?? 0)}° vs brand ${Math.round(brandHue ?? 0)}°)`;
      off.push({
        scene: s.scene,
        kind: "canvas-coherence",
        detail:
          `scene ${s.scene} ships an OFF-BRAND canvas: measured border color rgb(${r},${g},${b}) is ${dist} away ` +
          `from the brand canvas ${brandBackground} (floor ${CANVAS_COHERENCE_RGB_DELTA}), and ${why}. ` +
          `Every scene must share ONE coherent brand canvas; this reads as a different video. Repaint the ` +
          `full-bleed canvas/atmosphere to the brand background ${brandBackground} (or a deliberate brand-palette ` +
          `tint of it), never a neutral or an unrelated tone.`,
      });
    } else {
      // A pure lightness swing that keeps the brand hue family — a deliberate
      // contrast scene. Budgeted below (same as canvas-brightness).
      inversions.push({ scene: s.scene, rgb: s.rgb, dist });
    }
  }
  // Grant MAX_DARK_SCENES luminance inversions; flag the excess (too many
  // inverted canvases break coherence just as too many dark scenes do).
  const excess = inversions.slice(MAX_DARK_SCENES);
  for (const s of excess) {
    off.push({
      scene: s.scene,
      kind: "canvas-coherence",
      detail:
        `scene ${s.scene} ships one contrast canvas too many: measured border color rgb(${s.rgb.join(",")}) is ` +
        `${s.dist} away from the brand canvas ${brandBackground}. At most ${MAX_DARK_SCENES} deliberate ` +
        `luminance-inversion scene is allowed; this one exceeds the budget. Repaint it to the brand canvas ` +
        `${brandBackground} so the video reads as ONE coherent canvas.`,
    });
  }
  return off.sort((a, b) => a.scene - b.scene);
};

/** Measure each scene's canvas color + apply the coherence rule. */
export const findCanvasCoherence = async (
  measurements: SceneMeasurement[],
  brandBackground: string | undefined,
): Promise<RenderTruthFinding[]> => {
  if (!brandBackground || !hexRgb(brandBackground)) return []; // no reference → skip (no pixel work)
  const sceneColors = await Promise.all(
    measurements.map(async (m) => ({
      scene: m.scene,
      rgb:
        m.error || !m.screenshotPath
          ? null
          : await frameCanvasColor(m.screenshotPath),
    })),
  );
  return assessCanvasCoherence(brandBackground, sceneColors);
};

// ── stranded hero (the layout composer contract) ─────────────────────────────
// The founder-doctrine defect (Fuse scene 1): a SMALL diegetic UI piece sitting
// alone in a CORNER of the frame — "we should never build a scene with a small
// UI element cornered on an edge". Plus the numeric split-register contract:
// on a `split` scene the hero visual must be a real column (≥30% of canvas
// width, vertically centered, opposite the text column). Both are pure
// geometry on the measured LEGO pieces (data-piece + data-kind), so they hold
// for every fill with zero taste-judgement — prevention by construction.
const HERO_KINDS = new Set(["diegetic", "image"]);
const SH_MIN_W_FRAC = 0.3; // a hero narrower than this fraction of W is "small"
const SH_MIN_H_FRAC = 0.4; // …and shorter than this fraction of H
const SH_CORNER_FRAC = 0.25; // centroid this far off BOTH center axes ⇒ a corner
const SH_MIN_AREA = 40_000; // ≥ ~200×200 — a content object, not a badge/accent
const SH_VCENTER_FRAC = 0.25; // split: hero centroid within this frac of H/2
const SH_SAME_SIDE_FRAC = 0.1; // split: both centroids this far onto ONE half ⇒ same-side

interface PieceBox {
  id: string;
  kind: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Bounding box per LEGO piece, from the measured element rects. */
const pieceBoxes = (m: SceneMeasurement): PieceBox[] => {
  const byId = new Map<string, { kind: string; x1: number; y1: number; x2: number; y2: number }>();
  for (const e of m.elements) {
    if (!e.piece || e.opacity <= 0.05) continue;
    const b = byId.get(e.piece);
    if (!b) {
      byId.set(e.piece, { kind: e.pieceKind ?? "", x1: e.x, y1: e.y, x2: e.x + e.w, y2: e.y + e.h });
    } else {
      b.x1 = Math.min(b.x1, e.x);
      b.y1 = Math.min(b.y1, e.y);
      b.x2 = Math.max(b.x2, e.x + e.w);
      b.y2 = Math.max(b.y2, e.y + e.h);
      if (!b.kind && e.pieceKind) b.kind = e.pieceKind;
    }
  }
  return [...byId.entries()].map(([id, b]) => ({
    id,
    kind: b.kind,
    x: b.x1,
    y: b.y1,
    w: b.x2 - b.x1,
    h: b.y2 - b.y1,
  }));
};

/** Area-weighted centroid-x of the scene's text pieces (undefined if none). */
const textCentroidX = (boxes: PieceBox[]): number | undefined => {
  const texts = boxes.filter((b) => b.kind === "text" && b.w > 0 && b.h > 0);
  if (texts.length === 0) return undefined;
  let area = 0;
  let acc = 0;
  for (const t of texts) {
    const a = t.w * t.h;
    area += a;
    acc += (t.x + t.w / 2) * a;
  }
  return area > 0 ? acc / area : undefined;
};

/**
 * The stranded-hero + split-contract gate. Register-aware: pass the scene's
 * script register (undefined ⇒ corner rule only). Skips scenes without LEGO
 * piece tagging (nothing to measure against — older builds fail open here and
 * are covered by dead-region/vision instead).
 */
/** Union bounding box of a set of piece boxes (the hero cluster's footprint). */
const unionBox = (bs: PieceBox[]): { x: number; y: number; w: number; h: number } => {
  const x1 = Math.min(...bs.map((b) => b.x));
  const y1 = Math.min(...bs.map((b) => b.y));
  const x2 = Math.max(...bs.map((b) => b.x + b.w));
  const y2 = Math.max(...bs.map((b) => b.y + b.h));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
};

export const findStrandedHero = (
  m: SceneMeasurement,
  register?: string,
): RenderTruthFinding[] => {
  if (m.error) return [];
  const boxes = pieceBoxes(m);
  const heroPieces = boxes.filter((b) => HERO_KINDS.has(b.kind) && b.w * b.h >= SH_MIN_AREA);
  // A full-bleed hero-kind piece (≥85% of canvas) is a CANVAS TREATMENT, not a
  // placeable hero. Its presence also means the scene is a full-bleed
  // composition — so a smaller secondary piece (often the throughline motif)
  // is NOT "stranded alone" and must not be judged as the hero (audit #22).
  const canvasArea = m.width * m.height;
  const fullBleedExists = heroPieces.some((b) => b.w * b.h >= 0.85 * canvasArea);
  const placeable = heroPieces.filter((b) => b.w * b.h < 0.85 * canvasArea);
  if (placeable.length === 0) return [];

  // Evaluate the hero ENVELOPE (union of all placeable hero pieces), not just
  // the single largest — the design prompt explicitly sanctions multi-piece
  // hero CLUSTERS (a row of cards / KPI tiles), which the largest-piece view
  // false-flagged as "too small" (audit #9).
  const env = unionBox(placeable);
  const cx = env.x + env.w / 2;
  const cy = env.y + env.h / 2;
  const out: RenderTruthFinding[] = [];

  // Universal corner rule — the founder doctrine defect: a SINGLE small UI
  // element ALONE in a corner. Only fires when there is exactly one placeable
  // hero (truly alone) and no full-bleed treatment; a cluster (>1) or a
  // full-bleed scene is a deliberate composition, never "stranded alone".
  if (placeable.length === 1 && !fullBleedExists) {
    const hero = placeable[0];
    const small = hero.w < SH_MIN_W_FRAC * m.width && hero.h < SH_MIN_H_FRAC * m.height;
    const cornered =
      Math.abs(cx - m.width / 2) > SH_CORNER_FRAC * m.width &&
      Math.abs(cy - m.height / 2) > SH_CORNER_FRAC * m.height;
    if (small && cornered) {
      out.push({
        scene: m.scene,
        kind: "stranded-hero",
        detail:
          `main visual piece "${hero.id}" (${hero.w}×${hero.h} at ${hero.x},${hero.y}) is SMALL and stranded in a corner of the ${m.width}×${m.height} frame. ` +
          `Make it a real hero: span at least ${Math.round(SH_MIN_W_FRAC * 100)}% of the canvas width, center it vertically in its column — never leave a small UI element alone at a frame edge.`,
      });
      return out; // the corner fix subsumes the split contract — one instruction at a time
    }
  }

  // Numeric split contract: the hero ENVELOPE ≥30% W, vertically centered,
  // opposite the text column. A full-bleed scene has no separable hero column.
  if (register === "split" && !fullBleedExists) {
    const label = placeable.length > 1 ? `hero cluster (${placeable.length} pieces)` : `hero visual "${placeable[0].id}"`;
    if (env.w < SH_MIN_W_FRAC * m.width) {
      out.push({
        scene: m.scene,
        kind: "stranded-hero",
        detail:
          `split scene: ${label} spans ${env.w}px — below the ${Math.round(SH_MIN_W_FRAC * 100)}% column contract (${Math.round(SH_MIN_W_FRAC * m.width)}px of ${m.width}). ` +
          `Scale the visual up to fill its column.`,
      });
    }
    if (Math.abs(cy - m.height / 2) > SH_VCENTER_FRAC * m.height) {
      out.push({
        scene: m.scene,
        kind: "stranded-hero",
        detail:
          `split scene: ${label} centers at y=${Math.round(cy)} — outside the vertically-centered band (${Math.round(m.height / 2 - SH_VCENTER_FRAC * m.height)}–${Math.round(m.height / 2 + SH_VCENTER_FRAC * m.height)}px). ` +
          `Center the visual vertically in its column.`,
      });
    }
    const tx = textCentroidX(boxes);
    if (tx !== undefined) {
      const heroOff = cx - m.width / 2;
      const textOff = tx - m.width / 2;
      const sameSide =
        heroOff * textOff > 0 &&
        Math.abs(heroOff) > SH_SAME_SIDE_FRAC * m.width &&
        Math.abs(textOff) > SH_SAME_SIDE_FRAC * m.width;
      if (sameSide) {
        out.push({
          scene: m.scene,
          kind: "stranded-hero",
          detail:
            `split scene: ${label} (center x=${Math.round(cx)}) and the text column (center x=${Math.round(tx)}) sit on the SAME half of the frame. ` +
            `Put the text column and the hero visual in OPPOSITE columns.`,
        });
      }
    }
  }
  return out;
};

// ── piece-edge crop (v10 — dogfood cycle 1: bottom mocks cropped at frame) ──
// Cycle 1 shipped s0/s4 bottom hero bands whose RENDERED content ran past the
// canvas bottom edge and read as cropped. The overflow gate is blind to it:
// the clipped elements are panels/divs with no direct text, so isContentEl
// excludes them. This check works at PIECE granularity — the union of a
// piece's measured rects vs the canvas bottom/right edge — because the layout
// composer promised each piece a slot that ends above the bottom reserve, so
// a piece union crossing the frame edge is always a defect of the piece's own
// content sizing, never a composition choice (full-canvas treatments exempt).
//
// Repair posture: DETERMINISTIC first. The finding carries the exact overflow;
// the runner clamps the piece's wrapper offset in the assembled code
// (assemble.ts clampPieceOffsets) and re-measures — regen is only for
// residuals the clamp cannot fix (piece taller than the canvas).

/** A piece's union may clip the canvas bottom/right by at most this fraction
 *  of its OWN height/width before the finding blocks. */
export const EDGE_CROP_FRAC = 0.02;
/** Union area ≥ this fraction of the canvas = a full-canvas treatment (same
 *  threshold findStrandedHero uses) — exempt from the edge-crop rule. */
const EDGE_CROP_FULL_BLEED_FRAC = 0.85;
/** Piece kinds that own the frame edge by design. */
const EDGE_CROP_EXEMPT_KINDS = new Set(["atmosphere", "chrome"]);

export interface EdgeCropFinding {
  kind: "piece-edge-crop";
  scene: number;
  /** The piece whose rendered union clips the frame — routing + clamp target. */
  pieceId: string;
  blocking: true;
  edge: "bottom" | "right";
  /** How far past the canvas edge the piece's union extends, px. */
  overflowPx: number;
  union: { x: number; y: number; w: number; h: number };
  detail: string;
  repairInstruction: string;
}

/** Pieces whose rendered union clips the canvas bottom/right edge by more
 *  than EDGE_CROP_FRAC of their own height/width. Pure geometry on measured
 *  rects — zero screenshots, zero LLM. */
export const findEdgeCroppedPieces = (m: SceneMeasurement): EdgeCropFinding[] => {
  if (m.error) return [];
  const out: EdgeCropFinding[] = [];
  const canvasArea = m.width * m.height;
  for (const box of pieceBoxes(m)) {
    if (!box.id || EDGE_CROP_EXEMPT_KINDS.has(box.kind)) continue;
    if (box.w <= 0 || box.h <= 0) continue;
    if (box.w * box.h >= EDGE_CROP_FULL_BLEED_FRAC * canvasArea) continue; // canvas treatment
    const checks: { edge: "bottom" | "right"; overflowPx: number; own: number }[] = [
      { edge: "bottom", overflowPx: box.y + box.h - m.height, own: box.h },
      { edge: "right", overflowPx: box.x + box.w - m.width, own: box.w },
    ];
    for (const c of checks) {
      if (c.overflowPx <= Math.max(EDGE_TOL, EDGE_CROP_FRAC * c.own)) continue;
      out.push({
        kind: "piece-edge-crop",
        scene: m.scene,
        pieceId: box.id,
        blocking: true,
        edge: c.edge,
        overflowPx: Math.round(c.overflowPx),
        union: { x: box.x, y: box.y, w: box.w, h: box.h },
        detail:
          `scene ${m.scene}: piece "${box.id}" (rendered union ${box.w}×${box.h} at ${box.x},${box.y}) ` +
          `runs ${Math.round(c.overflowPx)}px past the canvas ${c.edge} edge (${m.width}×${m.height}) — ` +
          `${Math.round((c.overflowPx / c.own) * 100)}% of its own ${c.edge === "bottom" ? "height" : "width"} is cropped by the frame.`,
        repairInstruction:
          `Fit "${box.id}" fully inside the frame: the deterministic clamp repositions the piece first; ` +
          `if it still clips, shrink the piece's own content to its declared slot (its wrapper owns ` +
          `placement — never grow past the wrapper's bounds, and keep a visible margin above the frame edge).`,
      });
    }
  }
  return out;
};

// Audit-1 Medium #5: findInteriorClip (a text node protruding past its OWN
// piece's sibling union — advisory only) was DELETED; it never reached
// blockingKinds and is covered by findIntraPieceOverlap + the piece-edge-crop
// clamp below. INTERIOR_CLIP_FRAC / IC_* went with it.

// ── clamp-vs-slot planner (v11 — dogfood cycle 2: the s2.hero clamp ricochet) ─
// Cycle 2's deterministic edge-crop clamp moved an OVERSIZED piece (content
// ~1266px in a 768px slot) leftward into the copy column — trading an edge
// crop for a cross-piece straddle and costing a full extra gate round. The
// clamp is only the cheapest true fix when the piece actually FITS its slot
// and the move lands on free canvas. This planner decides, per finding:
//   - content exceeds the slot by > EDGE_CLAMP_OVERSIZE_FRAC on the overflow
//     axis → the piece is mis-sized, not mis-placed: route DIRECT REGEN
//     ("fill the wrapper, never exceed it") and never clamp;
//   - the clamped position would NEWLY intersect another piece's declared
//     slot territory → route DIRECT REGEN (a clamp that invades a neighbor
//     converts one defect into a worse one);
//   - otherwise → the deterministic move (assemble.ts clampPieceOffsets).

/** A piece's measured union may exceed its declared slot on the overflow axis
 *  by at most this factor before clamping is refused (regen instead). */
export const EDGE_CLAMP_OVERSIZE_FRAC = 1.25;
/** New neighbor-slot intersection must exceed this many px on BOTH axes to
 *  count as an invasion (grazing contact is not a collision). */
const CLAMP_INVASION_TOL_PX = 8;

export interface SlotTerritory {
  pieceId: string;
  scene: number;
  kind: string;
  bounds: { x: number; y: number; w: number; h: number };
}

export interface EdgeCropRegenRoute {
  pieceId: string;
  scene: number;
  reason: "oversized-for-slot" | "clamp-would-invade-neighbor";
  detail: string;
  repairInstruction: string;
}

export interface EdgeCropMovePlan {
  moves: { pieceId: string; dx: number; dy: number }[];
  regens: EdgeCropRegenRoute[];
}

const intersect1D = (a1: number, a2: number, b1: number, b2: number): number =>
  Math.min(a2, b2) - Math.max(a1, b1);

const invades = (
  u: { x: number; y: number; w: number; h: number },
  s: { x: number; y: number; w: number; h: number },
): boolean =>
  intersect1D(u.x, u.x + u.w, s.x, s.x + s.w) > CLAMP_INVASION_TOL_PX &&
  intersect1D(u.y, u.y + u.h, s.y, s.y + s.h) > CLAMP_INVASION_TOL_PX;

/**
 * Plan deterministic clamp moves vs direct-regen routes for a round's
 * edge-crop findings. `slots` are the layout composer's declared territories
 * (SceneManifest piece bounds); `canvas` sizes the full-bleed exemption.
 */
export const planEdgeCropMoves = (
  findings: EdgeCropFinding[],
  slots: SlotTerritory[],
  canvas: { w: number; h: number },
  marginPx: number,
): EdgeCropMovePlan => {
  const plan: EdgeCropMovePlan = { moves: [], regens: [] };
  const byPiece = new Map<string, EdgeCropFinding[]>();
  for (const f of findings) byPiece.set(f.pieceId, [...(byPiece.get(f.pieceId) ?? []), f]);

  for (const [pieceId, fs] of byPiece) {
    const scene = fs[0].scene;
    const union = fs[0].union;
    const slot = slots.find((s) => s.pieceId === pieceId && s.scene === scene);

    // (a) Oversized for its slot on the overflow axis → regen, never clamp.
    if (slot) {
      const oversized = fs.find(
        (f) =>
          (f.edge === "right" && union.w > slot.bounds.w * EDGE_CLAMP_OVERSIZE_FRAC) ||
          (f.edge === "bottom" && union.h > slot.bounds.h * EDGE_CLAMP_OVERSIZE_FRAC),
      );
      if (oversized) {
        const axis = oversized.edge === "right" ? "wide" : "tall";
        const own = oversized.edge === "right" ? union.w : union.h;
        const slotDim = oversized.edge === "right" ? slot.bounds.w : slot.bounds.h;
        plan.regens.push({
          pieceId,
          scene,
          reason: "oversized-for-slot",
          detail: `content ~${Math.round(own)}px ${axis} in a ${Math.round(slotDim)}px slot (>${Math.round((EDGE_CLAMP_OVERSIZE_FRAC - 1) * 100)}% over) — repositioning cannot fix a mis-sized piece`,
          repairInstruction:
            `Your content is ~${Math.round(own)}px ${axis} but the slot is ${Math.round(slotDim)}px — content is WIDER than its slot. ` +
            `Rebuild the element to FILL the wrapper and never exceed it: width/height 100%, interior laid out within the wrapper's own bounds, no fixed px sizes larger than the slot.`,
        });
        continue;
      }
    }

    // Compose the move exactly as the clamp loop would.
    let dx = 0;
    let dy = 0;
    for (const f of fs) {
      if (f.edge === "bottom") dy = -(f.overflowPx + marginPx);
      else dx = -(f.overflowPx + marginPx);
    }

    // (b) The moved union must not NEWLY land on a neighbor's territory.
    const moved = { x: union.x + dx, y: union.y + dy, w: union.w, h: union.h };
    const neighbors = slots.filter(
      (s) =>
        s.scene === scene &&
        s.pieceId !== pieceId &&
        !EDGE_CROP_EXEMPT_KINDS.has(s.kind) &&
        s.bounds.w * s.bounds.h < EDGE_CROP_FULL_BLEED_FRAC * canvas.w * canvas.h,
    );
    const invaded = neighbors.find((s) => invades(moved, s.bounds) && !invades(union, s.bounds));
    if (invaded) {
      plan.regens.push({
        pieceId,
        scene,
        reason: "clamp-would-invade-neighbor",
        detail: `the ${dx || dy}px clamp would move this piece onto "${invaded.pieceId}"'s territory (slot ${invaded.bounds.x},${invaded.bounds.y} ${invaded.bounds.w}×${invaded.bounds.h})`,
        repairInstruction:
          `Repositioning this piece would collide with "${invaded.pieceId}" — rebuild the element's content to fit INSIDE its own wrapper instead: ` +
          `fill the wrapper (width/height 100%), keep every interior item within the wrapper's bounds, and keep a visible margin above the frame edge.`,
      });
      continue;
    }
    plan.moves.push({ pieceId, dx, dy });
  }
  return plan;
};

// ── stray motif fragments (v15 — dogfood cycle 6: the crossing lime rule) ────
// Cycle-6 evidence (Robinhood): s2 shipped a thin lime rule CROSSING OUT of
// the phone mock's edge onto the canvas, and s4 shipped an orphaned "100%"
// progress bar floating mid-void, >100px from any other content of its piece.
// Both are accent FRAGMENTS — thin painted bars that lost their anchor. Every
// prior gate is blind: they're inside the frame (no overflow), tiny (no
// density change), the right hue (no accent-fill), and textless (no
// interior-clip). Measured truth:
//   crossing — a thin painted bar intersecting one of its OWN piece's opaque
//     panels while extending past that panel's edge by >30% of its own length
//     (a rule that escapes its mock);
//   isolated — a thin painted bar ≥80px (rect gap) from every other visible
//     element of its piece (a fragment floating in the void).
// Precision guards: connector/throughline pieces ARE thin rules by design —
// exempt. When accent hexes are supplied, only accent-toned bars qualify
// (neutral hairlines/dividers are grammar, not fragments). STRUCTURAL
// (advisory) finding + a deterministic repair where safe: crossing bars CLIP
// to the panel edge (a numeral rewrite), isolated childless bars REMOVE.

/** Thin-bar geometry: the short axis at most / the long axis at least. */
const STRAY_MAX_THIN_PX = 16;
const STRAY_MIN_LONG_PX = 48;
/** Crossing: overhang past the panel edge must exceed this frac of own length. */
export const STRAY_CROSSING_FRAC = 0.3;
/** …and this many absolute px (grazing contact never fires). */
export const STRAY_CROSSING_MIN_PX = 24;
/** Isolated: minimum rect-to-rect gap from ALL other piece content. */
export const STRAY_ISOLATION_MIN_PX = 80;
/** RGB distance for "accent-toned" when accent hexes are supplied. */
const STRAY_ACCENT_RGB_DIST = 70;
const STRAY_EXEMPT_PIECE_RX = /\.(connector|throughline)$/;

export interface StrayFragmentFinding {
  kind: "stray-fragment";
  scene: number;
  pieceId: string;
  form: "crossing" | "isolated";
  rect: { x: number; y: number; w: number; h: number };
  bg: string;
  /** crossing only: which panel edge is crossed + by how much. */
  edge?: "left" | "right" | "top" | "bottom";
  overhangPx?: number;
  detail: string;
}

const rgbOf = (c: string): [number, number, number] | null => {
  const hex = /^#([0-9a-fA-F]{6})$/.exec((c || "").trim());
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = /rgba?\(([^)]+)\)/.exec(c || "");
  if (!m) return null;
  const p = m[1].split(",").map((v) => parseFloat(v.trim()));
  if (p.length < 3 || p.slice(0, 3).some((n) => Number.isNaN(n))) return null;
  return [p[0], p[1], p[2]];
};

const rgbDist = (a: [number, number, number], b: [number, number, number]): number =>
  Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);

const rectGap = (
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): number => {
  const dx = Math.max(0, Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w)));
  const dy = Math.max(0, Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)));
  return Math.sqrt(dx * dx + dy * dy);
};

const isThinPaintedBar = (e: MeasuredElement): boolean =>
  !e.isImg &&
  e.text.trim() === "" &&
  e.hasTextDesc !== true &&
  e.opacity > 0.1 &&
  cssAlpha(e.bg) >= 0.5 &&
  ((e.h <= STRAY_MAX_THIN_PX && e.w >= STRAY_MIN_LONG_PX) ||
    (e.w <= STRAY_MAX_THIN_PX && e.h >= STRAY_MIN_LONG_PX));

/** The visible (clip-aware) rect when the walk provides it. */
const strayRect = (e: MeasuredElement): { x: number; y: number; w: number; h: number } =>
  typeof e.vw === "number" && typeof e.vh === "number"
    ? { x: e.vx ?? e.x, y: e.vy ?? e.y, w: e.vw, h: e.vh }
    : { x: e.x, y: e.y, w: e.w, h: e.h };

/** Thin accent bars that cross a panel's edge (their own piece's or a foreign
 *  mock's — the cycle-6 rule was a THROUGHLINE bar escaping the hero's phone
 *  panel) or float isolated from all their piece's content. Pure geometry on
 *  measured rects. */
export const findStrayFragments = (
  m: SceneMeasurement,
  accentHexes?: string[],
): StrayFragmentFinding[] => {
  if (m.error) return [];
  const accents = (accentHexes ?? [])
    .map(rgbOf)
    .filter((c): c is [number, number, number] => c !== null);
  const visible = m.elements.filter((e) => e.opacity > 0.05 && e.w > 0 && e.h > 0);
  // Panels from ANY content piece — the crossing form is cross-piece-aware.
  const panels = visible
    .filter(
      (p) =>
        !!p.piece &&
        p.pieceKind !== "atmosphere" &&
        p.pieceKind !== "chrome" &&
        p.opacity > 0.1 &&
        (cssAlpha(p.bg) >= XP_MIN_PANEL_ALPHA || !!p.hasBgImage) &&
        p.w * p.h >= XP_MIN_PANEL_AREA &&
        p.w * p.h < EDGE_CROP_FULL_BLEED_FRAC * m.width * m.height,
    )
    .map((p) => ({ el: p, rect: strayRect(p) }));
  const out: StrayFragmentFinding[] = [];
  for (const e of visible) {
    // Atmosphere bars are staging (dividers, frame lines) — never fragments.
    if (!e.piece || e.pieceKind === "atmosphere" || e.pieceKind === "chrome") continue;
    if (!isThinPaintedBar(e)) continue;
    if (accents.length > 0) {
      const bar = rgbOf(e.bg);
      if (!bar || !accents.some((a) => rgbDist(bar, a) <= STRAY_ACCENT_RGB_DIST)) continue;
    }
    const r = strayRect(e);
    if (r.w <= 0 || r.h <= 0) continue;
    const horizontal = r.w >= r.h;
    const ownLen = horizontal ? r.w : r.h;
    if (ownLen < STRAY_MIN_LONG_PX) continue;
    // (a) CROSSING: the bar SUBSTANTIVELY lives in a panel (long-axis
    // intersection ≥25% of its length) yet overhangs that panel's edge by
    // >30% of its length and ≥24px (grazing contact never fires).
    let crossed: StrayFragmentFinding | null = null;
    for (const { el: pEl, rect: p } of panels) {
      if (pEl === e) continue;
      const ix = Math.min(r.x + r.w, p.x + p.w) - Math.max(r.x, p.x);
      const iy = Math.min(r.y + r.h, p.y + p.h) - Math.max(r.y, p.y);
      if (ix <= 0 || iy <= 0) continue;
      const alongAxis = horizontal ? ix : iy;
      if (alongAxis < 0.25 * ownLen) continue; // touches, doesn't live there
      const overs: { edge: "left" | "right" | "top" | "bottom"; px: number }[] = horizontal
        ? [
            { edge: "right", px: r.x + r.w - (p.x + p.w) },
            { edge: "left", px: p.x - r.x },
          ]
        : [
            { edge: "bottom", px: r.y + r.h - (p.y + p.h) },
            { edge: "top", px: p.y - r.y },
          ];
      const worst = overs
        .filter((o) => o.px > STRAY_CROSSING_FRAC * ownLen && o.px >= STRAY_CROSSING_MIN_PX)
        .sort((a, b) => b.px - a.px)[0];
      if (!worst) continue;
      crossed = {
        kind: "stray-fragment",
        scene: m.scene,
        pieceId: e.piece,
        form: "crossing",
        rect: r,
        bg: e.bg,
        edge: worst.edge,
        overhangPx: Math.round(worst.px),
        detail:
          `scene ${m.scene}: a ${r.w}×${r.h} accent bar (piece ${e.piece}, bg ${e.bg}) CROSSES the ${worst.edge} ` +
          `edge of ${pEl.piece === e.piece ? "its own" : `piece ${pEl.piece}'s`} panel by ${Math.round(worst.px)}px ` +
          `(${Math.round((worst.px / ownLen) * 100)}% of its own length) — a rule escaping its mock onto the ` +
          `canvas. Keep accent rules fully inside the surface they annotate.`,
      };
      break;
    }
    if (crossed) {
      out.push(crossed);
      continue;
    }
    // (b) ISOLATED: ≥80px from every other visible element of its piece.
    // Connector/throughline pieces ARE thin rules by design — exempt here.
    if (STRAY_EXEMPT_PIECE_RX.test(e.piece)) continue;
    const others = visible.filter(
      (o) => o !== e && o.piece === e.piece && (isPaintedForStray(o) || o.text.trim() !== ""),
    );
    if (others.length === 0) continue; // the bar IS the piece — a motif, not a fragment
    const minGap = Math.min(...others.map((o) => rectGap(r, strayRect(o))));
    if (minGap < STRAY_ISOLATION_MIN_PX) continue;
    out.push({
      kind: "stray-fragment",
      scene: m.scene,
      pieceId: e.piece,
      form: "isolated",
      rect: r,
      bg: e.bg,
      detail:
        `scene ${m.scene}: a ${r.w}×${r.h} accent bar (piece ${e.piece}, bg ${e.bg}) floats ISOLATED — ` +
        `${Math.round(minGap)}px from the nearest other content of its piece (floor ${STRAY_ISOLATION_MIN_PX}px). ` +
        `An orphaned fragment mid-void: anchor it to real content or remove it.`,
    });
  }
  return out;
};

const isPaintedForStray = (e: MeasuredElement): boolean =>
  e.opacity > 0.05 && (e.isImg || cssAlpha(e.bg) >= 0.5 || !!e.hasBgImage);

// ── deterministic stray-fragment repair (clip / remove where safe) ───────────
// Best-effort, zero tokens, mirroring the edge-crop clamp posture: the repair
// only applies when the fragment's authored style is UNAMBIGUOUSLY identifiable
// in the piece's code (exactly one style span whose width/height literals match
// the measured rect ±3px and whose background resolves to the measured color).
// crossing → the long-axis dimension literal rewrites so the bar ends at the
// panel edge (a numeral edit — safe with children). isolated → the element is
// removed, but ONLY when it is self-closing or immediately-closed (childless);
// anything ambiguous no-ops and the structural finding ships instead.

export interface StrayRepairResult {
  code: string;
  action: "clipped" | "removed" | "none";
  detail: string;
}

/** First balanced `{{ … }}` span starting at `from` (string-aware). */
const balancedDoubleBrace = (s: string, from: number): { start: number; end: number } | null => {
  if (s.slice(from, from + 2) !== "{{") return null;
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return { start: from, end: i + 1 };
    }
  }
  return null;
};

export const exciseStrayFragment = (
  pieceCode: string,
  finding: StrayFragmentFinding,
  palette?: Record<string, string>,
): StrayRepairResult => {
  const none = (why: string): StrayRepairResult => ({ code: pieceCode, action: "none", detail: why });
  const wantBg = rgbOf(finding.bg);
  if (!wantBg) return none("measured bg unparseable");
  // Every style span whose width/height/background all match the measured rect.
  const matches: { styleStart: number; styleEnd: number; span: string }[] = [];
  const rx = /style\s*=\s*\{\{/g;
  for (let m = rx.exec(pieceCode); m; m = rx.exec(pieceCode)) {
    const open = pieceCode.indexOf("{{", m.index);
    const bal = balancedDoubleBrace(pieceCode, open);
    if (!bal) continue;
    const span = pieceCode.slice(bal.start, bal.end);
    const w = /\bwidth\s*:\s*(\d+(?:\.\d+)?)(?![\d.%\w])/.exec(span);
    const h = /\bheight\s*:\s*(\d+(?:\.\d+)?)(?![\d.%\w])/.exec(span);
    if (!w || !h) continue;
    if (Math.abs(Number(w[1]) - finding.rect.w) > 3 || Math.abs(Number(h[1]) - finding.rect.h) > 3) continue;
    const bgM = /\b(?:background|backgroundColor)\s*:\s*(?:(["'`])(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\))\1|([A-Z][A-Z0-9_]{2,}))/.exec(span);
    if (!bgM) continue;
    const raw = bgM[2] ?? (bgM[3] && palette ? palette[bgM[3]] : undefined);
    const got = raw ? rgbOf(raw) : null;
    if (!got || rgbDist(got, wantBg) > 40) continue;
    matches.push({ styleStart: bal.start, styleEnd: bal.end, span });
  }
  if (matches.length !== 1) return none(`${matches.length} matching style span(s) — ambiguous, no repair`);
  const hit = matches[0];

  if (finding.form === "crossing" && finding.overhangPx) {
    const horizontal = finding.rect.w >= finding.rect.h;
    const dim = horizontal ? "width" : "height";
    const own = horizontal ? finding.rect.w : finding.rect.h;
    const clipped = Math.max(8, Math.round(own - finding.overhangPx - 2));
    const dimRx = new RegExp(`(\\b${dim}\\s*:\\s*)(\\d+(?:\\.\\d+)?)(?![\\d.%\\w])`);
    const newSpan = hit.span.replace(dimRx, (_f, pre: string) => `${pre}${clipped}`);
    if (newSpan === hit.span) return none("dimension literal not rewritable");
    return {
      code: pieceCode.slice(0, hit.styleStart) + newSpan + pieceCode.slice(hit.styleEnd),
      action: "clipped",
      detail: `${dim} ${own} → ${clipped}px (ends at the panel edge)`,
    };
  }

  // isolated → remove, only when unambiguous and childless.
  const tagStart = pieceCode.lastIndexOf("<", hit.styleStart);
  if (tagStart === -1) return none("no enclosing tag found");
  const tagName = /^<([A-Za-z][A-Za-z0-9]*)/.exec(pieceCode.slice(tagStart, tagStart + 40))?.[1];
  if (!tagName) return none("enclosing tag unparseable");
  // Scan for the tag's closing '>' (string/brace-aware past the style span).
  let i = hit.styleEnd;
  let quote: string | null = null;
  let depth = 0;
  for (; i < pieceCode.length; i++) {
    const c = pieceCode[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) break;
  }
  if (i >= pieceCode.length) return none("tag never closes");
  const selfClosing = pieceCode[i - 1] === "/";
  let end = i + 1;
  if (!selfClosing) {
    const closer = `</${tagName}>`;
    const rest = pieceCode.slice(i + 1);
    if (!rest.startsWith(closer) && !/^\s*<\//.test(rest.slice(0, closer.length + 8))) {
      return none("element has children — not removable");
    }
    const closeAt = pieceCode.indexOf(closer, i + 1);
    if (closeAt === -1 || pieceCode.slice(i + 1, closeAt).trim() !== "") {
      return none("element has children — not removable");
    }
    end = closeAt + closer.length;
  }
  return {
    code: pieceCode.slice(0, tagStart) + pieceCode.slice(end),
    action: "removed",
    detail: `removed the orphaned ${finding.rect.w}×${finding.rect.h} <${tagName}> fragment`,
  };
};

// ── motif clutter: singularity budget vs the throughline/atmosphere layers ───
// Frame-authoring PR follow-up (Klarna eyeball): the recurring-motif and
// atmosphere layers scatter DECORATION disconnected from any content — s4
// shipped four ghost ✓ glyphs drifting in the atmosphere, and the throughline
// (pinned to a fixed cross-scene anchor, right of frame) shipped a floating
// "Klarna" pill on top of the CHROME wordmark. Both defeat the composition
// head's budget{brandMark:1} intent. Every prior gate is blind: the glyphs are
// tiny textless-looking atmosphere, the pill is a legal in-frame element.
//
// Two arms (measured truth on the DECORATION layers only — atmosphere +
// *.throughline/*.connector; hero/copy content is never touched so a legit
// checkout ✓ or the hero's own brand mark stays):
//   decorative-glyph — an element whose text is a pure motif GLYPH (✓ ★ ❤ …,
//     no letters/digits) in a decoration layer. Always clutter (real content
//     glyphs live in hero/copy pieces) → remove.
//   floating-brand-mark — a decoration-layer element that renders the BRAND
//     NAME as a pill/badge, UNLESS the head's budget assigns the brand mark to
//     THIS layer AND the mark sits ON content (not isolated). So the scene-3
//     grid legend (budget=throughline, over the hero) stays; the scenes-0/1/2
//     unbudgeted pills and the scene-4 pill floating right of the phone go.
const MOTIF_DECO_PIECE_RX = /\.(throughline|connector)$/;
// Motif glyphs: checkmarks, stars, sparkles, hearts, suit pips — symbols that
// read as "AI-slop motif echo". Deliberately EXCLUDES arrows (→ ➜: legit
// "next"/flow indicators) and dots/bullets (neutral texture).
const MOTIF_GLYPH_RX =
  /[✓✔✅☑✅✔✕✖✗✘★☆✦✧⭐✨❤♥♡♠♦♣♦️]/u;
/** True when trimmed text is PURELY motif glyph(s) — a checkmark/star/heart run
 *  with no letters or digits (so "Klarna", "$248", "→ Buy" never qualify). */
export const isMotifGlyphText = (t: string): boolean => {
  const s = (t ?? "").trim();
  if (!s) return false;
  if (/[A-Za-z0-9]/.test(s)) return false;
  return MOTIF_GLYPH_RX.test(s);
};

export interface MotifClutterFinding {
  kind: "motif-clutter";
  scene: number;
  pieceId: string;
  form: "decorative-glyph" | "floating-brand-mark" | "floating-motif" | "protruding-motif";
  text: string;
  rect: { x: number; y: number; w: number; h: number };
  detail: string;
}

// ── protruding-motif calibration (P3-C2 #1) ──────────────────────────────────
// The recurring residual (Fuse, Klarna, Brex): the head authors the throughline
// INSIDE the hero (Brex s2 bounds 340,420,210,32; s3 760,430,400,36; s4
// 820,480,280,28), but the CAST re-emits it as an absolutely-positioned chip
// pinned near the hero's right edge — protruding past the hero's painted
// envelope into empty canvas (Brex s2 "RECEIPT AUTO-MATCHED" sits fully right of
// the 300..1360 dashboard; s3 "9.8M RECEIPTS…" pokes ~45px past the 320..1565
// card, over the 30x tile; s4 "RECEIPTS AUTOMATED…" juts ~140px past the
// 460..1460 onboarding mock). The gap arm keeps them (they're <80px off the hero
// edge — "on content" by its measure), so they slip. This arm CLAMPS the defect:
// a throughline/connector chip whose box sticks out past the hero's envelope by
// ≥ PROTRUSION_MIN_PX into canvas that no other content covers is removed. A
// throughline fully contained in the hero (the reference's in-mock slot) stays.
/** Min single-edge overhang (px) past the hero envelope, in EMPTY canvas, for a
 *  throughline chip to count as protruding. Brex s3 pokes ~45px (nearest fire);
 *  a rounded-corner sliver (~10px) or a fully-contained motif (0) stays. */
export const PROTRUSION_MIN_PX = 36;
/** A protruding strip this-or-more covered by OTHER content (copy panel, an
 *  adjacent card) is a chip legitimately bridging two panels → kept, not clamped. */
const PROTRUSION_COVER_FRAC = 0.5;

export interface MotifClutterOptions {
  /** Brand name — enables the floating-brand-mark arm (omit ⇒ glyph arm only). */
  brandName?: string;
  /** budget.brandMark for THIS scene (the role the head assigned the single
   *  brand mark: "throughline" | "hero" | "chrome" | "none" | …). A decoration
   *  layer that owns the budgeted mark AND sits on content is kept. */
  brandMarkOwner?: string;
  /** Isolation floor for a budgeted mark to still count as floating (default 80). */
  isolationPx?: number;
}

/** The brand's first significant word, normalized (mirrors findBrandMarkDefects:
 *  the leading alphabetic run so a domain suffix / tagline never pollutes it). */
const brandFirstWord = (brandName: string | undefined): string => {
  const rawFirst = (brandName ?? "").trim().split(/\s+/)[0] ?? "";
  const cleanFirst = rawFirst.match(/[A-Za-z][A-Za-z'&-]*/)?.[0] ?? rawFirst;
  return cleanFirst.toLowerCase().replace(/[^a-z0-9]/g, "");
};

/** Motif clutter on the decoration layers — pure geometry on measured rects. */
export const findMotifClutter = (
  m: SceneMeasurement,
  opts: MotifClutterOptions = {},
): MotifClutterFinding[] => {
  if (m.error) return [];
  const isolationPx = opts.isolationPx ?? STRAY_ISOLATION_MIN_PX;
  const brandWord = brandFirstWord(opts.brandName);
  const visible = m.elements.filter((e) => e.opacity > 0.02 && e.w > 0 && e.h > 0);
  const isDecoLayer = (e: MeasuredElement): boolean =>
    e.pieceKind === "atmosphere" || (!!e.piece && MOTIF_DECO_PIECE_RX.test(e.piece));
  // Anchor content for the isolation test: painted, non-decoration, non-chrome,
  // NON-full-bleed elements (excluding a full-bleed hero wrapper, whose box
  // would falsely make every mark "on content").
  const canvasArea = m.width * m.height;
  const anchors = visible.filter(
    (e) =>
      !!e.piece &&
      e.pieceKind !== "atmosphere" &&
      e.pieceKind !== "chrome" &&
      !MOTIF_DECO_PIECE_RX.test(e.piece) &&
      (e.isImg || cssAlpha(e.bg) >= 0.5 || e.text.trim() !== "" || !!e.hasBgImage) &&
      e.w * e.h < EDGE_CROP_FULL_BLEED_FRAC * canvasArea,
  );
  const out: MotifClutterFinding[] = [];
  const seenGlyphPiece = new Set<string>();
  const seenMarkPiece = new Set<string>();
  for (const e of visible) {
    if (!isDecoLayer(e)) continue;
    const t = e.text.trim();
    const rect = { x: e.x, y: e.y, w: e.w, h: e.h };
    // Motif glyph — a text glyph (✓ ★ …) OR a small drawn <svg>/<path> icon
    // (the ghost-checkmark echo painted as SVG) in the ATMOSPHERE layer.
    const isSvgIcon =
      e.pieceKind === "atmosphere" &&
      (e.tag === "svg" || e.tag === "path") &&
      e.text.trim() === "" &&
      e.w > 0 && e.w <= 96 && e.h > 0 && e.h <= 96;
    if (isMotifGlyphText(t) || isSvgIcon) {
      if (seenGlyphPiece.has(e.piece)) continue;
      seenGlyphPiece.add(e.piece);
      out.push({
        kind: "motif-clutter",
        scene: m.scene,
        pieceId: e.piece,
        form: "decorative-glyph",
        text: t || `<${e.tag} icon>`,
        rect,
        detail: `scene ${m.scene}: decoration layer ${e.piece} paints a free-floating motif ${isSvgIcon ? "icon" : `glyph "${t}"`}, not anchored to any content. Remove the decorative ${isSvgIcon ? "icon" : "glyph"}.`,
      });
      continue;
    }
    if (brandWord && brandWord.length >= 3) {
      const norm = t.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (norm !== brandWord) continue;
      if (seenMarkPiece.has(e.piece)) continue;
      const role = e.pieceKind === "atmosphere" ? "atmosphere" : (MOTIF_DECO_PIECE_RX.exec(e.piece)?.[1] ?? "");
      const budgeted = !!opts.brandMarkOwner && opts.brandMarkOwner === role;
      const gap = anchors.length
        ? Math.min(...anchors.map((a) => rectGap(rect, { x: a.x, y: a.y, w: a.w, h: a.h })))
        : Infinity;
      const isolated = gap >= isolationPx;
      if (budgeted && !isolated) continue; // the sanctioned, on-content motif mark — keep
      seenMarkPiece.add(e.piece);
      out.push({
        kind: "motif-clutter",
        scene: m.scene,
        pieceId: e.piece,
        form: "floating-brand-mark",
        text: t,
        rect,
        detail:
          `scene ${m.scene}: decoration layer ${e.piece} renders a "${opts.brandName}" brand pill (${budgeted ? `budgeted here but ${Math.round(gap)}px off content — floating` : "not the budgeted brand-mark owner"}). ` +
          `The chrome already carries the single corner mark; remove the duplicate/floating motif pill.`,
      });
    }
  }
  // Piece-level arm: an isolated throughline/connector PIECE whose whole painted
  // extent sits ≥ isolationPx from all content is floating motif clutter even
  // when it renders no brand name or glyph — the scene-0 "empty badge slot"
  // (a dashed pill pinned right of the checkout, disconnected from it). A
  // throughline that sits ON content (scene-3 grid legend) is not isolated → kept.
  const decoPieceRects = new Map<string, { x: number; y: number; w: number; h: number }[]>();
  for (const e of visible) {
    if (e.piece && MOTIF_DECO_PIECE_RX.test(e.piece)) {
      decoPieceRects.set(e.piece, [...(decoPieceRects.get(e.piece) ?? []), { x: e.x, y: e.y, w: e.w, h: e.h }]);
    }
  }
  // The hero's painted envelope (union of its non-full-bleed elements) — the box
  // a throughline chip must stay inside. A full-bleed hero (its members ARE the
  // canvas) yields no bounded envelope, so nothing can "protrude" past it.
  const heroEls = visible.filter(
    (e) => !!e.piece && e.piece.endsWith(".hero") && e.w * e.h < EDGE_CROP_FULL_BLEED_FRAC * canvasArea,
  );
  const heroBox =
    heroEls.length > 0
      ? (() => {
          const x0 = Math.min(...heroEls.map((e) => e.x));
          const y0 = Math.min(...heroEls.map((e) => e.y));
          return { x: x0, y: y0, w: Math.max(...heroEls.map((e) => e.x + e.w)) - x0, h: Math.max(...heroEls.map((e) => e.y + e.h)) - y0 };
        })()
      : null;
  // Content that is NOT the hero (a copy column, an adjacent card) — a chip whose
  // overhang lands ON one of these bridges two panels legitimately → not clamped.
  const otherContent = anchors.filter((a) => !(a.piece && a.piece.endsWith(".hero")));
  for (const [pieceId, rects] of decoPieceRects) {
    if (seenMarkPiece.has(pieceId) || seenGlyphPiece.has(pieceId)) continue; // already flagged
    const x0 = Math.min(...rects.map((r) => r.x));
    const y0 = Math.min(...rects.map((r) => r.y));
    const box = { x: x0, y: y0, w: Math.max(...rects.map((r) => r.x + r.w)) - x0, h: Math.max(...rects.map((r) => r.y + r.h)) - y0 };
    if (box.w <= 0 || box.h <= 0) continue;
    const gap = anchors.length ? Math.min(...anchors.map((a) => rectGap(box, { x: a.x, y: a.y, w: a.w, h: a.h }))) : Infinity;
    if (gap >= isolationPx) {
      seenMarkPiece.add(pieceId);
      out.push({
        kind: "motif-clutter",
        scene: m.scene,
        pieceId,
        form: "floating-motif",
        text: "",
        rect: box,
        detail: `scene ${m.scene}: throughline/connector piece ${pieceId} floats ${Math.round(gap)}px off all content (floor ${isolationPx}px) — a motif pinned in the void, disconnected from the frame. Remove it.`,
      });
      continue;
    }
    // Attached to content (gap < floor) but possibly PROTRUDING past the hero's
    // envelope into empty canvas — the Brex s2/s3/s4 pinned-right proof chips.
    const overPx = heroBox ? motifProtrusionPx(box, heroBox, otherContent) : 0;
    if (overPx >= PROTRUSION_MIN_PX) {
      seenMarkPiece.add(pieceId);
      out.push({
        kind: "motif-clutter",
        scene: m.scene,
        pieceId,
        form: "protruding-motif",
        text: "",
        rect: box,
        detail: `scene ${m.scene}: throughline/connector piece ${pieceId} protrudes ~${Math.round(overPx)}px past the hero's envelope (${Math.round(heroBox!.x)},${Math.round(heroBox!.y)} ${Math.round(heroBox!.w)}×${Math.round(heroBox!.h)}) into empty canvas — a motif chip pinned outside the frame's content, not the in-hero slot the head authored. Remove it (or nest it fully inside the hero).`,
      });
    }
  }
  return out;
};

/** Rect-intersection area. */
const rectIntersectArea = (
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): number => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
};

/**
 * How far a throughline chip's box sticks out past the hero's envelope, measured
 * as the widest single-edge overhang whose strip lands in EMPTY canvas (covered
 * < PROTRUSION_COVER_FRAC by any non-hero content). 0 when the chip is fully
 * contained, or when every overhang lands on an adjacent content panel.
 */
export const motifProtrusionPx = (
  box: { x: number; y: number; w: number; h: number },
  hero: { x: number; y: number; w: number; h: number },
  otherContent: { x: number; y: number; w: number; h: number }[],
): number => {
  const heroR = hero.x + hero.w;
  const heroB = hero.y + hero.h;
  const boxR = box.x + box.w;
  const boxB = box.y + box.h;
  // The protruding strip on each side (the part of `box` beyond that hero edge).
  const strips: { px: number; strip: { x: number; y: number; w: number; h: number } }[] = [];
  if (boxR > heroR) {
    const sx = Math.max(heroR, box.x);
    strips.push({ px: boxR - sx, strip: { x: sx, y: box.y, w: boxR - sx, h: box.h } });
  }
  if (box.x < hero.x) {
    const sw = Math.min(hero.x, boxR) - box.x;
    strips.push({ px: sw, strip: { x: box.x, y: box.y, w: sw, h: box.h } });
  }
  if (boxB > heroB) {
    const sy = Math.max(heroB, box.y);
    strips.push({ px: boxB - sy, strip: { x: box.x, y: sy, w: box.w, h: boxB - sy } });
  }
  if (box.y < hero.y) {
    const sh = Math.min(hero.y, boxB) - box.y;
    strips.push({ px: sh, strip: { x: box.x, y: box.y, w: box.w, h: sh } });
  }
  let maxEmpty = 0;
  for (const { px, strip } of strips) {
    if (px <= 0 || strip.w <= 0 || strip.h <= 0) continue;
    const stripArea = strip.w * strip.h;
    const covered = otherContent.reduce((acc, o) => acc + rectIntersectArea(strip, o), 0);
    if (covered / stripArea < PROTRUSION_COVER_FRAC) maxEmpty = Math.max(maxEmpty, px);
  }
  return maxEmpty;
};

// ── corner-mark collision (a duplicate brand lockup in the corner chrome) ────
// The P3-C1 Fuse defect the source-based dup-mark gate (findBrandMarkDefects)
// and the deco-layer motif gate both missed: the composition head authored
// "the Fuse logo upper-left" INSIDE the hero while the app's BrandChrome ALWAYS
// paints its own corner lockup top-left — so scenes 0 and 4 shipped "Fuse Fuse"
// overlapping in the corner. findBrandMarkDefects excludes kind="chrome" and
// needs ≥2 NON-chrome marks, so a chrome-mark + one hero-mark collision scores 1
// and never fires. This gate is POSITION-AWARE on measured boxes: it finds the
// corner chrome mark, then any NON-chrome element that repaints the brand name
// (or a logo image) overlapping / nearly touching it. A diegetic brand mention
// INSIDE a mock, far from the corner (Fuse s2's sidebar "Fuse", ~330px off the
// chrome), is not a collision — the small proximity gate is what separates a
// duplicate corner lockup from a legitimate in-mock brand mark.
const CORNER_MARK_REGION_X_FRAC = 0.32; // the top-left chrome corner: x < 32% W
const CORNER_MARK_REGION_Y_FRAC = 0.22; // …and y < 22% H
const CORNER_MARK_COLLISION_GAP = 44;   // overlapping / nearly touching the chrome mark

/** A duplicate brand lockup colliding with the corner chrome mark. Measured. */
export const findCornerMarkCollision = (
  m: SceneMeasurement,
  opts: { brandName?: string } = {},
): RenderTruthFinding[] => {
  if (m.error) return [];
  const brandWord = brandFirstWord(opts.brandName);
  if (brandWord.length < 2) return [];
  const cornerX = CORNER_MARK_REGION_X_FRAC * m.width;
  const cornerY = CORNER_MARK_REGION_Y_FRAC * m.height;
  const visible = m.elements.filter((e) => e.opacity > 0.05 && e.w > 0 && e.h > 0);
  const normText = (t: string): string => (t ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const isBrandText = (e: MeasuredElement): boolean => normText(e.text) === brandWord;
  const isLogoImg = (e: MeasuredElement): boolean =>
    e.isImg && /\blogo\b|lockup|wordmark|brand/i.test(e.src ?? "");
  // C8 #4: a corner-mark GHOST — a distinct element whose text is a ≥4-char PREFIX
  // of the brand word ("Flex" ⊂ "Flexport") but NOT the whole word. This is the
  // corner-mark render DOUBLING (a truncated second wordmark ghosting under the
  // corner chrome — Flexport s2/s4). Exact-word doubles are isBrandText; this
  // catches the partial-word ghost the exact match misses. Scoped by the same
  // corner-region + overlap-the-chrome gate below, so it can't fire on prose.
  const BRAND_GHOST_MIN_LEN = 4;
  const isBrandGhost = (e: MeasuredElement): boolean => {
    if (e.isImg) return false;
    const t = normText(e.text);
    return (
      t.length >= BRAND_GHOST_MIN_LEN &&
      t.length < brandWord.length &&
      brandWord.startsWith(t)
    );
  };
  // The corner chrome mark: chrome-piece elements in the top-left corner that
  // paint the brand name or a logo image. Take their union box.
  const chromeMarks = visible.filter(
    (e) =>
      e.pieceKind === "chrome" &&
      e.x < cornerX && e.y < cornerY &&
      (isBrandText(e) || isLogoImg(e) || (e.isImg && e.x < cornerX * 0.5)),
  );
  if (chromeMarks.length === 0) return []; // no corner lockup measured → nothing to collide with
  const cx0 = Math.min(...chromeMarks.map((e) => e.x));
  const cy0 = Math.min(...chromeMarks.map((e) => e.y));
  const chromeBox = {
    x: cx0,
    y: cy0,
    w: Math.max(...chromeMarks.map((e) => e.x + e.w)) - cx0,
    h: Math.max(...chromeMarks.map((e) => e.y + e.h)) - cy0,
  };
  const out: RenderTruthFinding[] = [];
  const seenPieces = new Set<string>();
  for (const e of visible) {
    if (e.pieceKind === "chrome") continue; // the sanctioned corner mark itself
    const ghost = isBrandGhost(e);
    if (!(isBrandText(e) || isLogoImg(e) || ghost)) continue;
    // must be in the top-left corner region AND nearly touching the chrome mark
    const centerX = e.x + e.w / 2;
    const centerY = e.y + e.h / 2;
    if (centerX > cornerX || centerY > cornerY) continue;
    const gap = rectGap({ x: e.x, y: e.y, w: e.w, h: e.h }, chromeBox);
    if (gap > CORNER_MARK_COLLISION_GAP) continue; // a distant in-mock brand mark → not a collision
    const owner = e.piece || `s${m.scene}.hero`;
    if (seenPieces.has(owner)) continue;
    seenPieces.add(owner);
    out.push({
      scene: m.scene,
      kind: "corner-mark-collision",
      detail:
        `scene ${m.scene}: piece ${owner} paints a ${ghost ? `partial brand-mark GHOST ("${e.text.trim()}" — a truncated double of the corner wordmark)` : `SECOND brand lockup (${e.isImg ? "logo image" : `"${e.text.trim()}"`})`} ` +
        `in the top-left corner, ${Math.round(gap)}px from the app's corner chrome mark (they overlap as a garbled ` +
        `double wordmark). The corner brand lockup is ALWAYS provided by the chrome — ${owner} must NOT render the ` +
        `brand logo/wordmark in the frame's upper-left. Remove the brand mark from ${owner} (a stat, headline, or ` +
        `product detail belongs there instead); a brand mark may appear only as diegetic chrome INSIDE a device/app ` +
        `mock, well clear of the frame corner.`,
    });
  }
  return out;
};

// ── hollow CTA (P3-C2 #2: a label-less accent button) ────────────────────────
// Brex s4 shipped a SECOND CTA below the tagline as a solid orange pill with NO
// text inside — a button-shaped accent slab that reads as a broken/unfinished
// control. This is the button-scale sibling of the hollow-hero floor: a saturated
// accent fill, button-sized and pill-shaped, carrying no own text and no text
// descendant. A real CTA ("Start now") carries its label and is exempt; an accent
// PANEL (large) is accent-as-fill's job; a thin accent RULE is a stray fragment's.
const CTA_MIN_W = 56;
const CTA_MAX_W = 460;
const CTA_MIN_H = 26;
const CTA_MAX_H = 96;
const CTA_MIN_ASPECT = 1.6;   // wider than tall — a label-bearing button, not a square icon chip
const CTA_MAX_ASPECT = 9;
/** Min chroma (max−min channel) for a fill to read as a saturated ACCENT (not a
 *  neutral card). Brex orange #ff5900 → 255; a neutral panel → <20. */
const CTA_ACCENT_CHROMA_MIN = 45;
/** The accent fill must sit this far (RGB dist) off the brand canvas so a
 *  saturated-canvas brand doesn't flag its own background. */
const CTA_CANVAS_DIST_MIN = 60;
/** C8 #3: an arrow/chevron/icon-triangle glyph (the "→" / "↗" / "›" family). A
 *  button-sized PILL whose only text is one of these — no word — is a hollow
 *  directional control (Flexport s4 shipped a light "→" pill beside the stats). */
const ARROW_GLYPH_RX =
  /[→←↑↓↗↘↖↙⟶⟵⭢⭠⇒⇐⇨⇦↦➔➙➜➝➞➟➠➤➢▶◀▸◂◄►▷◁›‹»«]/u;
/** Arrow-only text: at least one arrow glyph AND no letter or digit (a lone glyph,
 *  never a real label like "Get started with Flexport →"). */
const isArrowOnly = (text: string): boolean => {
  const t = text.trim();
  return t.length > 0 && ARROW_GLYPH_RX.test(t) && !/[\p{L}\p{N}]/u.test(t);
};
/** Square-ish is allowed for the ARROW arm — an icon button is often ~1:1 — but a
 *  bare arrowhead/connector (no pill surface) is excluded by the surface gate. */
const CTA_ARROW_MIN_ASPECT = 0.7;

/** A label-less button-shape on a content piece. Two arms: (1) an empty SOLID
 *  ACCENT pill (Brex s4 — no text at all); (2) C8 #3: a button-sized PILL whose
 *  only text is a lone arrow/icon glyph (Flexport s4 — a neutral "→" pill with no
 *  word). Both read as a broken/unfinished control. Pure geometry + color. */
export const findHollowCta = (
  m: SceneMeasurement,
  opts: { brandBackground?: string } = {},
): RenderTruthFinding[] => {
  if (m.error) return [];
  const canvasRgb = opts.brandBackground ? hexRgb(opts.brandBackground) : null;
  const out: RenderTruthFinding[] = [];
  const seen = new Set<string>();
  // A candidate arrow pill's own text is arrow-only; guard against a labelled
  // button whose worded label lives in a CHILD element (arrow as the wrapper's
  // direct text) — a descendant carrying a word means it is a real CTA.
  const hasWord = (t: string): boolean => /[\p{L}\p{N}]/u.test(t);
  const descendantHasWord = (rootIx: number): boolean => {
    const stack = m.elements.map((_, k) => k).filter((k) => m.elements[k].parentIx === rootIx);
    const guard = new Set<number>();
    while (stack.length) {
      const ix = stack.pop()!;
      if (guard.has(ix)) continue;
      guard.add(ix);
      if (hasWord(m.elements[ix].text)) return true;
      for (let k = 0; k < m.elements.length; k++) if (m.elements[k].parentIx === ix) stack.push(k);
    }
    return false;
  };
  m.elements.forEach((e, ix) => {
    if (e.opacity <= 0.5 || e.isImg) return;
    if (e.pieceKind === "atmosphere" || e.pieceKind === "chrome") return;
    if (!e.piece || MOTIF_DECO_PIECE_RX.test(e.piece)) return;
    if (e.w < CTA_MIN_W || e.w > CTA_MAX_W || e.h < CTA_MIN_H || e.h > CTA_MAX_H) return;
    const aspect = e.w / e.h;

    // Arm 2 (C8 #3) — arrow-only PILL. The wrapper's direct text is a lone arrow
    // glyph (a real "Label →" CTA carries a word in its text or a worded child).
    // Neutral OR accent fill — the defect isn't the color, it's the missing label.
    if (
      isArrowOnly(e.text) &&
      !descendantHasWord(ix) &&
      aspect >= CTA_ARROW_MIN_ASPECT &&
      aspect <= CTA_MAX_ASPECT &&
      (cssAlpha(e.bg) >= 0.5 || (e.radius ?? 0) > 0) && // a real pill surface, not a bare arrowhead
      !seen.has(e.piece)
    ) {
      seen.add(e.piece);
      out.push({
        scene: m.scene,
        kind: "hollow-cta",
        detail:
          `scene ${m.scene}: piece ${e.piece} paints a button-sized pill (${Math.round(e.w)}×${Math.round(e.h)} at ` +
          `${Math.round(e.x)},${Math.round(e.y)}) whose ONLY text is a lone "${e.text.trim()}" arrow glyph — a ` +
          `label-less directional control reads as broken/unfinished. Re-emit it WITH its action label (the CTA verb, ` +
          `e.g. "Get started →"), or REMOVE it if it duplicates the scene's real, labeled CTA. A CTA pill must carry a word.`,
      });
      return;
    }

    // Arm 1 (Brex s4) — empty SOLID ACCENT pill: no own text AND no text anywhere
    // in the subtree → truly label-less.
    if (e.text.trim() !== "" || e.hasTextDesc === true) return;
    if (aspect < CTA_MIN_ASPECT || aspect > CTA_MAX_ASPECT) return;
    if (cssAlpha(e.bg) < 0.9) return; // must be a SOLID fill (a real button surface)
    const rgb = rgbTriplet(e.bg);
    if (!rgb) return;
    if (chromaOf(rgb[0], rgb[1], rgb[2]) < CTA_ACCENT_CHROMA_MIN) return; // neutral card → not a CTA
    if (canvasRgb && canvasRgbDist(rgb, canvasRgb) < CTA_CANVAS_DIST_MIN) return; // ≈ the brand canvas → skip
    if (seen.has(e.piece)) return;
    seen.add(e.piece);
    out.push({
      scene: m.scene,
      kind: "hollow-cta",
      detail:
        `scene ${m.scene}: piece ${e.piece} paints a solid accent button (${Math.round(e.w)}×${Math.round(e.h)} at ` +
        `${Math.round(e.x)},${Math.round(e.y)}, fill ${e.bg}) with NO label — a CTA-shaped pill carrying no own text and ` +
        `no text descendant reads as a broken/unfinished control. Re-emit this button WITH its action label inside it ` +
        `(the CTA verb, e.g. "Start now"/"Get started"), or REMOVE it if it duplicates the scene's real, labeled CTA. ` +
        `A solid accent pill must never ship empty.`,
    });
  });
  return out;
};

// ── stray empty card on a full-bleed layer (P3-C5 #2a) ───────────────────────
// Vanta s2 (full-bleed) shipped a stray EMPTY dark rounded card floating over
// the bar chart — a solid panel carrying no text, no image, no motif, stacked on
// top of the primary mock. It reads as a rendering artifact (a leftover
// container). This is the card-scale sibling of the hollow-CTA gate: a solid,
// text-less, card-sized panel that OVERLAPS other content on a FULL-BLEED scene,
// where a floating empty card is unambiguously a defect (the reference full-bleed
// mocks never float an empty container over their surface). Scoped to full-bleed
// to avoid touching legit empty accent blocks on other registers.
const STRAY_CARD_MIN_AREA = 14_000; // a real card (≈120×120+), not a chip/rule
const STRAY_CARD_MAX_CANVAS_FRAC = 0.3; // bigger = the mock surface itself, not a stray card
const STRAY_CARD_MIN_DIM = 60; // both dims — a panel, not a thin bar
const STRAY_CARD_MIN_OVERLAP = 0.5; // this share of the CARD must sit over other content

/** A solid, empty, card-sized panel floating OVER content on a full-bleed scene. */
export const findStrayFullBleedCard = (
  m: SceneMeasurement,
  register?: string,
): RenderTruthFinding[] => {
  if (m.error || register !== "full-bleed") return [];
  const canvasArea = m.width * m.height;
  if (canvasArea <= 0) return [];
  const out: RenderTruthFinding[] = [];
  const seen = new Set<string>();
  // Other content elements a stray card could be occluding (painted, text-bearing
  // or image, from a DIFFERENT piece).
  const contentEls = m.elements.filter(
    (o) =>
      !!o.piece &&
      o.pieceKind !== "atmosphere" &&
      o.pieceKind !== "chrome" &&
      o.opacity > 0.3 &&
      o.w > 0 &&
      o.h > 0 &&
      (o.isImg || o.text.trim() !== "" || o.hasTextDesc === true || o.hasBgImage === true),
  );
  for (const e of m.elements) {
    if (e.opacity <= 0.5 || e.isImg) continue;
    if (e.pieceKind === "atmosphere" || e.pieceKind === "chrome") continue;
    if (!e.piece || MOTIF_DECO_PIECE_RX.test(e.piece)) continue;
    // EMPTY: no own text, no text descendant, no background image/gradient/motif.
    if (e.text.trim() !== "" || e.hasTextDesc === true || e.hasBgImage === true) continue;
    if (cssAlpha(e.bg) < 0.9) continue; // must be a SOLID container surface
    if (e.w < STRAY_CARD_MIN_DIM || e.h < STRAY_CARD_MIN_DIM) continue;
    const area = e.w * e.h;
    if (area < STRAY_CARD_MIN_AREA || area > STRAY_CARD_MAX_CANVAS_FRAC * canvasArea) continue;
    // Must OVERLAP another piece's content (it floats OVER the mock, occluding it)
    // — a standalone empty block that touches nothing is the orphaned-card
    // advisory's job, not a blocking occlusion.
    const cardArea = e.w * e.h;
    const occludes = contentEls.some((o) => {
      if (o.piece === e.piece) return false;
      const ix = Math.min(e.x + e.w, o.x + o.w) - Math.max(e.x, o.x);
      const iy = Math.min(e.y + e.h, o.y + o.h) - Math.max(e.y, o.y);
      if (ix <= 0 || iy <= 0) return false;
      return cardArea > 0 && (ix * iy) / cardArea >= STRAY_CARD_MIN_OVERLAP;
    });
    if (!occludes || seen.has(e.piece)) continue;
    seen.add(e.piece);
    out.push({
      scene: m.scene,
      kind: "stray-card",
      detail:
        `scene ${m.scene}: piece ${e.piece} paints a solid EMPTY card (${Math.round(e.w)}×${Math.round(e.h)} at ` +
        `${Math.round(e.x)},${Math.round(e.y)}, fill ${e.bg}) — no text, no image, no motif — floating OVER the ` +
        `primary surface on this full-bleed scene. A solid container carrying nothing, stacked on the mock, reads as ` +
        `a rendering artifact. REMOVE this empty card (or, if it was meant to hold content, FILL it with the real ` +
        `rows/values it should carry). A full-bleed scene shows ONE primary surface — never a hollow card floating over it.`,
    });
  }
  return out;
};

// ── centered-mock occlusion + right-edge clip (P3-C9 #3) ─────────────────────
// Razorpay s4 (CENTERED): a "NEXT STEPS" / "Ready to activate" card STACKED over
// the onboarding mock's action buttons occluded "Get started"/"Go live" (cut to
// "Get…"/"Go"), AND the mock CLIPPED past the right frame edge. The C5 stray-card
// guard (findStrayFullBleedCard) is FULL-BLEED-only, and the piece-edge-crop clamp
// missed a mock whose buttons are covered. This gate extends both to a CENTERED /
// stat mock:
//   (a) a solid content card of piece B covering ≥ MOCK_OCCL_MIN_FRAC of a mock
//       BUTTON of piece A, with the button measured coveredAtCenter (stacking
//       truth: something is genuinely painted on top) → occlusion;
//   (b) a mock PANEL/image element clipped by the RIGHT frame edge (its layout
//       crosses the edge, or its visible rect is cut short at the edge) → clip.
// Scoped to centered/stat (full-bleed → findStrayFullBleedCard; split/list carry
// their own contracts) and kept tight — coveredAtCenter for (a), a real clip on a
// mock surface for (b) — to spare legitimately layered mocks.
const MOCK_OCCL_REGISTERS: ReadonlySet<string> = new Set(["centered", "stat"]);
const MOCK_BUTTON_MIN_W = 56;
const MOCK_BUTTON_MIN_H = 20;
const MOCK_BUTTON_MAX_H = 96;
const MOCK_BUTTON_MIN_ASPECT = 1.6; // wider than tall — a label-bearing control
const MOCK_BUTTON_MAX_LABEL = 28; // a short action label, not a paragraph
const MOCK_OCCL_MIN_FRAC = 0.35; // this share of the button covered by the card
const MOCK_CLIP_TOL = 6; // px slack at the right edge

/** A button-shaped, short-label, solid-surface control (a mock CTA / action). */
const isMockButton = (e: MeasuredElement): boolean => {
  if (e.isImg || e.opacity <= 0.4) return false;
  if (e.pieceKind === "atmosphere" || e.pieceKind === "chrome") return false;
  const label = e.text.trim();
  if (label.length < 2 || label.length > MOCK_BUTTON_MAX_LABEL) return false;
  if (e.w < MOCK_BUTTON_MIN_W || e.h < MOCK_BUTTON_MIN_H || e.h > MOCK_BUTTON_MAX_H) return false;
  const aspect = e.h > 0 ? e.w / e.h : 0;
  if (aspect < MOCK_BUTTON_MIN_ASPECT) return false;
  return cssAlpha(e.bg) >= 0.5; // a solid pill/button, not a bare inline link
};

/** Occlusion of a centered/stat mock's button row + a mock clipped by the right
 *  frame edge. Blocking; names the mock piece so the regen route can act. */
export const findCenteredMockOcclusion = (
  m: SceneMeasurement,
  register?: string,
): RenderTruthFinding[] => {
  if (m.error || !register || !MOCK_OCCL_REGISTERS.has(register)) return [];
  if (m.width <= 0 || m.height <= 0) return [];
  const out: RenderTruthFinding[] = [];
  const seen = new Set<string>();
  // (a) OCCLUSION — a mock button covered by a solid content card of another piece.
  const cards = m.elements.filter(
    (e) =>
      !!e.piece &&
      e.pieceKind !== "atmosphere" &&
      e.pieceKind !== "chrome" &&
      e.opacity > 0.4 &&
      cssAlpha(e.bg) >= 0.6 &&
      e.w >= 80 &&
      e.h >= 60,
  );
  for (const b of m.elements) {
    if (!b.piece || !isMockButton(b) || b.coveredAtCenter !== true) continue;
    const bArea = b.w * b.h;
    if (bArea <= 0) continue;
    const occ = cards.find((c) => {
      if (c.piece === b.piece) return false; // same-piece layering is by design
      const ix = Math.min(b.x + b.w, c.x + c.w) - Math.max(b.x, c.x);
      const iy = Math.min(b.y + b.h, c.y + c.h) - Math.max(b.y, c.y);
      if (ix <= 0 || iy <= 0) return false;
      return (ix * iy) / bArea >= MOCK_OCCL_MIN_FRAC;
    });
    if (!occ) continue;
    const key = `occ|${b.piece}|${b.text.slice(0, 16)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      scene: m.scene,
      kind: "mock-occlusion",
      detail:
        `scene ${m.scene}: the ${register} mock's action button "${b.text.slice(0, 24)}" (piece ${b.piece} ` +
        `@${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.w)}×${Math.round(b.h)}) is COVERED by the card of ` +
        `piece ${occ.piece} stacked on top — the CTA label is occluded/cut. Keep the mock's interactive/button row ` +
        `CLEAR: move the overlaying card off the buttons (or into the mock's own empty region), or restack so the ` +
        `buttons sit on top. A centered mock must never bury its own CTA under another card.`,
    });
  }
  // (b) RIGHT-EDGE CLIP — a mock SURFACE (panel/image) cut by the right frame edge.
  for (const e of m.elements) {
    if (!e.piece || e.pieceKind === "atmosphere" || e.pieceKind === "chrome") continue;
    if (e.opacity <= 0.3) continue;
    const isSurface = e.isImg || e.hasBgImage === true || cssAlpha(e.bg) >= 0.6;
    if (!isSurface) continue; // bare text overflow is findOverflow's job
    if (e.w >= m.width * 0.92) continue; // a full-bleed treatment, not a clipped mock
    const layoutRight = e.x + e.w;
    const crossesEdge = layoutRight > m.width + MOCK_CLIP_TOL;
    const visClipped =
      e.vx !== undefined &&
      e.vw !== undefined &&
      layoutRight >= m.width - MOCK_CLIP_TOL &&
      e.vx + e.vw < layoutRight - MOCK_CLIP_TOL;
    if (!crossesEdge && !visClipped) continue;
    const key = `clip|${e.piece}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const overflowPx = Math.round(crossesEdge ? layoutRight - m.width : layoutRight - (e.vx! + e.vw!));
    out.push({
      scene: m.scene,
      kind: "mock-occlusion",
      detail:
        `scene ${m.scene}: the ${register} mock surface of piece ${e.piece} (@${Math.round(e.x)},${Math.round(e.y)} ` +
        `${Math.round(e.w)}×${Math.round(e.h)}) is CLIPPED by the right frame edge (~${overflowPx}px past ${m.width}). ` +
        `Pull the centered mock fully inside the frame with a visible right margin — never let it run off the right ` +
        `edge; shrink or shift the mock so every panel and label is on-canvas.`,
    });
  }
  return out;
};

// ── intra-piece overlap (P3-C2 #4b: a control colliding with copy) ───────────
// Brex s0 shipped, inside ONE hero, a "Submit for Approval" pill overlapping the
// "1 required field missing…" helper line AND the receipt footer. findTextOverlap
// misses it: (1) it's ADVISORY, not blocking, and (2) isOverlapText excludes any
// element with a solid bg, so the BUTTON pill is never one of the pair. This gate
// is the blocking, SAME-piece, SEVERE subset — a control OR readable text block
// overlapping DIFFERENT text of its own piece by ≥ half the smaller box (a real
// collision, not an adjacent chip). Cross-piece collisions are cross-piece-overlap's.
const INTRA_OVERLAP_FRAC = 0.5;
const isIntraControl = (e: MeasuredElement): boolean =>
  !e.isImg &&
  !INLINE_TEXT_TAGS.has(e.tag.toLowerCase()) &&
  e.text.trim().length >= 2 &&
  e.opacity > 0.5 &&
  cssAlpha(e.bg) >= 0.5 &&
  e.pieceKind !== "chrome" &&
  e.pieceKind !== "atmosphere";
const isIntraText = (e: MeasuredElement): boolean =>
  !e.isImg &&
  !INLINE_TEXT_TAGS.has(e.tag.toLowerCase()) &&
  e.text.trim().length >= 3 &&
  e.fontSize >= OVERLAP_MIN_TEXT_PX &&
  e.opacity > 0.3 &&
  e.pieceKind !== "chrome" &&
  e.pieceKind !== "atmosphere";

/** SAME-piece severe collisions where at least one side is a solid control. */
export const findIntraPieceOverlap = (m: SceneMeasurement): RenderTruthFinding[] => {
  if (m.error) return [];
  const cands = m.elements.filter((e) => e.w > 0 && e.h > 0 && !!e.piece && (isIntraControl(e) || isIntraText(e)));
  const out: RenderTruthFinding[] = [];
  const seenPiece = new Set<string>();
  for (let i = 0; i < cands.length; i++) {
    for (let j = i + 1; j < cands.length; j++) {
      const a = cands[i];
      const b = cands[j];
      if (a.piece !== b.piece) continue; // SAME piece only (cross-piece is another gate)
      if (seenPiece.has(a.piece)) continue;
      // At least one side must be a solid control — the defect shape isOverlapText misses.
      if (!(isIntraControl(a) || isIntraControl(b))) continue;
      const at = a.text.trim();
      const bt = b.text.trim();
      if (at === bt || at.includes(bt) || bt.includes(at)) continue; // label/child/repeat
      const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ix <= 0 || iy <= 0) continue;
      const areaA = a.w * a.h;
      const areaB = b.w * b.h;
      const inter = ix * iy;
      const minArea = Math.min(areaA, areaB);
      if (minArea <= 0) continue;
      // Full containment = a parent/child by design (a label on its own surface).
      if (inter >= 0.92 * minArea) continue;
      const frac = inter / minArea;
      if (frac < INTRA_OVERLAP_FRAC) continue;
      seenPiece.add(a.piece);
      out.push({
        scene: m.scene,
        kind: "intra-piece-overlap",
        detail:
          `scene ${m.scene}: inside piece ${a.piece}, "${at.slice(0, 28)}" (${a.tag}@${Math.round(a.x)},${Math.round(a.y)} ` +
          `${Math.round(a.w)}×${Math.round(a.h)}${cssAlpha(a.bg) >= 0.5 ? " button" : ""}) collides with "${bt.slice(0, 28)}" ` +
          `(${b.tag}@${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.w)}×${Math.round(b.h)}) — ${Math.round(frac * 100)}% of ` +
          `the smaller box. Two controls/labels stacked on the same spot read as broken. Reflow ${a.piece} so every button, ` +
          `helper line, and label owns its own row with real spacing — nothing overlapping.`,
      });
    }
  }
  return out;
};

// ── oversized ghost text fragment (P3-C2 #4a: the "DRAFT" watermark) ──────────
// Brex s0's head authored a "'DRAFT' watermark in #42578a in the upper third" —
// it rendered as a giant faint word-fragment drifting behind the headline, pure
// clutter. A real display headline is full-opacity and multi-word; a giant stat
// counter is a full-opacity number. This flags the specific ghost shape: an
// OVERSIZED (font ≥ 130px), LOW-OPACITY (≤ 0.4), single-token decorative word on
// a hero/atmosphere layer — never a readable copy line or a legible counter.
const GHOST_FRAGMENT_MIN_FONT_PX = 130;
const GHOST_FRAGMENT_MAX_OPACITY = 0.4;

/** Oversized low-opacity single-word text fragments (decorative watermarks). */
export const findGhostFragment = (m: SceneMeasurement): RenderTruthFinding[] => {
  if (m.error) return [];
  const out: RenderTruthFinding[] = [];
  const seen = new Set<string>();
  for (const e of m.elements) {
    if (e.isImg) continue;
    if (INLINE_TEXT_TAGS.has(e.tag.toLowerCase())) continue;
    const t = e.text.trim();
    if (t.length < 2) continue;
    if (e.pieceKind === "chrome") continue;
    if (e.fontSize < GHOST_FRAGMENT_MIN_FONT_PX) continue; // must be OVERSIZED
    if (e.opacity > GHOST_FRAGMENT_MAX_OPACITY) continue;   // must be a GHOST (faint)
    // single decorative token — a watermark, not a copy line or a comma-grouped stat
    if (/\s/.test(t) || t.length > 16) continue;
    const key = `${e.piece}|${t}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      scene: m.scene,
      kind: "ghost-fragment",
      detail:
        `scene ${m.scene}: ${e.piece || "(no piece)"} paints an OVERSIZED low-opacity word "${t}" ` +
        `(font ${Math.round(e.fontSize)}px, opacity ${e.opacity.toFixed(2)}, box ${Math.round(e.w)}×${Math.round(e.h)} at ` +
        `${Math.round(e.x)},${Math.round(e.y)}) — a giant ghost watermark drifting behind the content, pure clutter. ` +
        `Remove the oversized decorative word entirely; convey the state with a small, legible label instead of a huge faint fragment.`,
    });
  }
  return out;
};

// ── motif-clutter repair (deterministic, zero tokens) ────────────────────────
// decorative-glyph → strip the glyph element(s) from the piece body.
// floating-brand-mark on a throughline/connector piece (the pill IS the piece)
//   → blank the piece wrapper's inner. On atmosphere → strip the pill element.

/** Index just after the '>' that closes the JSX start-tag beginning at
 *  `tagStart` ('<'); string/brace aware. -1 if unterminated. */
const jsxStartTagEnd = (s: string, tagStart: number): number => {
  let quote: string | null = null;
  let depth = 0;
  for (let i = tagStart; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return i + 1;
  }
  return -1;
};

/** Match the element `<tag` at `tagStart` to its balanced `</tag>` (nested same
 *  tags, self-closing `<tag/>`, strings, `{expr}` braces aware). Returns the
 *  inner-content start (after the start tag's '>') and the closing tag's start
 *  ('<' of `</tag>`), plus the index just past `</tag>`. */
const matchElement = (
  s: string,
  tagStart: number,
  tag: string,
): { innerStart: number; closeStart: number; afterEnd: number } | null => {
  const openEnd = jsxStartTagEnd(s, tagStart);
  if (openEnd < 0) return null;
  if (s[openEnd - 2] === "/") return { innerStart: openEnd, closeStart: openEnd, afterEnd: openEnd }; // self-closed
  const open = `<${tag}`;
  const close = `</${tag}`;
  let depth = 1;
  let quote: string | null = null;
  for (let i = openEnd; i < s.length; ) {
    const c = s[i];
    if (quote) {
      if (c === "\\") { i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; i++; continue; }
    if (c === "<") {
      if (s.startsWith(close, i)) {
        depth--;
        if (depth === 0) {
          const gt = s.indexOf(">", i);
          return { innerStart: openEnd, closeStart: i, afterEnd: gt < 0 ? s.length : gt + 1 };
        }
        i += close.length;
        continue;
      }
      if (s.startsWith(open, i)) {
        const e = jsxStartTagEnd(s, i);
        if (e < 0) return null;
        if (s[e - 2] !== "/") depth++;
        i = e;
        continue;
      }
    }
    i++;
  }
  return null;
};

/** Empty a throughline/connector piece wrapper's inner content (keeps the
 *  `<div data-piece …>` so measurement still sees the piece, painted blank). */
export const blankPieceInner = (spanSlice: string): { code: string; blanked: boolean } => {
  const at = spanSlice.indexOf("<div");
  if (at < 0) return { code: spanSlice, blanked: false };
  const m = matchElement(spanSlice, at, "div");
  if (!m || m.closeStart <= m.innerStart) return { code: spanSlice, blanked: false };
  if (!spanSlice.slice(m.innerStart, m.closeStart).trim()) return { code: spanSlice, blanked: false };
  return { code: spanSlice.slice(0, m.innerStart) + spanSlice.slice(m.closeStart), blanked: true };
};

// ── motif ICON svgs (the ghost-checkmark defect drawn as <svg><path/></svg>) ──
// The atmosphere emitter also paints motif echoes as SVG icons ("four ghosted
// green checkmarks", drawn <path d="M5 12.5 L10 17.5 L19 7"/>), often inside a
// {[…].map(…)} group — no text node, so the glyph arm is blind. Atmosphere's
// legit content is washes/grain/dots (divs + CSS bg); a small standalone <svg>
// ICON there is motif clutter. Strip small-viewBox <svg> icons (and the whole
// {…map…} group when the svg is its body). Full-bleed background svgs are kept.

/** Max viewBox / width|height dimension for an <svg> to count as an ICON. */
const SVG_ICON_MAX_DIM = 96;
const svgOpenTagIsIcon = (openTag: string): boolean => {
  const vb = /viewBox\s*=\s*["']\s*[\d.]+\s+[\d.]+\s+([\d.]+)\s+([\d.]+)/.exec(openTag);
  if (vb) return Math.max(Number(vb[1]), Number(vb[2])) <= SVG_ICON_MAX_DIM;
  const wl = /\bwidth\s*=\s*["']?(\d+)/.exec(openTag);
  const hl = /\bheight\s*=\s*["']?(\d+)/.exec(openTag);
  if (wl || hl) return Math.max(Number(wl?.[1] ?? 0), Number(hl?.[1] ?? 0)) <= SVG_ICON_MAX_DIM;
  return false; // size unknowable (e.g. width={expr}, no viewBox) → keep (avoid FP)
};

/** The `{ … }` JSX expression enclosing `pos` (nearest balanced brace pair). */
const enclosingBraceExpr = (s: string, pos: number): { start: number; end: number } | null => {
  let depth = 0;
  let start = -1;
  for (let i = pos - 1; i >= 0; i--) {
    const c = s[i];
    if (c === "}") depth++;
    else if (c === "{") { if (depth === 0) { start = i; break; } depth--; }
  }
  if (start < 0) return null;
  let d = 0;
  let quote: string | null = null;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "{") d++;
    else if (c === "}") { d--; if (d === 0) return { start, end: i + 1 }; }
  }
  return null;
};

/** Strip decorative motif-icon `<svg>`s from a decoration-layer body. Removes
 *  the enclosing `{…map…}` group when the svg is a mapped decoration. */
export const stripDecorationSvgIcons = (body: string): { code: string; removed: number } => {
  let out = body;
  let removed = 0;
  for (let guard = 0; guard < 32; guard++) {
    let hit = false;
    for (let at = out.indexOf("<svg"); at !== -1; at = out.indexOf("<svg", at + 4)) {
      const openGt = out.indexOf(">", at);
      if (openGt < 0) break;
      const m = matchElement(out, at, "svg");
      if (!m) continue;
      if (!svgOpenTagIsIcon(out.slice(at, openGt + 1))) continue; // full-bleed/unknown → keep
      // Remove the enclosing {…map…} group if this svg is a mapped decoration.
      const brace = enclosingBraceExpr(out, at);
      const span =
        brace && brace.end >= m.afterEnd && out.slice(brace.start, at).includes(".map(")
          ? brace
          : { start: at, end: m.afterEnd };
      out = out.slice(0, span.start) + out.slice(span.end);
      removed++;
      hit = true;
      break;
    }
    if (!hit) break;
  }
  return { code: out, removed };
};

/** Remove leaf elements whose direct text matches `isClutter` (a motif glyph or
 *  the brand pill) from a piece body. Leaf-only (no same-tag nesting inside),
 *  bounded, string/brace safe enough for the decoration layers it runs on. */
export const stripClutterElements = (
  spanSlice: string,
  isClutter: (text: string) => boolean,
): { code: string; removed: number } => {
  let out = spanSlice;
  let removed = 0;
  for (let guard = 0; guard < 64; guard++) {
    let hit = false;
    const rx = />([^<>{}]*)</g;
    for (let m = rx.exec(out); m; m = rx.exec(out)) {
      const text = m[1].trim();
      if (!text || !isClutter(text)) continue;
      const gt = m.index; // the '>' closing this element's start tag
      const tagStart = out.lastIndexOf("<", gt);
      if (tagStart < 0 || out[tagStart + 1] === "/") continue;
      const nameM = /^<([A-Za-z][A-Za-z0-9]*)/.exec(out.slice(tagStart, tagStart + 30));
      if (!nameM) continue;
      const tag = nameM[1];
      const closer = `</${tag}>`;
      const closeAt = out.indexOf(closer, gt);
      if (closeAt < 0) continue;
      if (out.slice(gt + 1, closeAt).includes(`<${tag}`)) continue; // not a leaf — skip
      out = out.slice(0, tagStart) + out.slice(closeAt + closer.length);
      removed++;
      hit = true;
      break;
    }
    if (!hit) break;
  }
  return { code: out, removed };
};

export interface MotifRepairResult {
  code: string;
  action: "blanked" | "stripped" | "none";
  detail: string;
}

/** Repair every motif-clutter finding for ONE piece's span slice. */
export const exciseMotifClutter = (
  spanSlice: string,
  findings: MotifClutterFinding[],
  opts: { brandName?: string } = {},
): MotifRepairResult => {
  if (findings.length === 0) return { code: spanSlice, action: "none", detail: "no findings" };
  const pieceId = findings[0].pieceId;
  const hasFloatingPiece = findings.some(
    (f) => f.form === "floating-brand-mark" || f.form === "floating-motif" || f.form === "protruding-motif",
  );
  // A floating / protruding brand pill or motif IS a throughline/connector piece → blank it.
  if (hasFloatingPiece && MOTIF_DECO_PIECE_RX.test(pieceId)) {
    const r = blankPieceInner(spanSlice);
    if (r.blanked) return { code: r.code, action: "blanked", detail: `blanked floating motif piece ${pieceId}` };
  }
  // Otherwise strip the specific clutter elements: text glyphs + any atmosphere
  // pill, plus small drawn <svg> motif icons (ghost checkmarks drawn as paths).
  const brandWord = brandFirstWord(opts.brandName);
  const isClutter = (t: string): boolean =>
    isMotifGlyphText(t) ||
    (brandWord.length >= 3 && t.toLowerCase().replace(/[^a-z0-9]/g, "") === brandWord);
  const glyphs = stripClutterElements(spanSlice, isClutter);
  const svgs = stripDecorationSvgIcons(glyphs.code);
  const total = glyphs.removed + svgs.removed;
  if (total > 0) return { code: svgs.code, action: "stripped", detail: `stripped ${total} motif element(s) from ${pieceId} (${glyphs.removed} glyph, ${svgs.removed} svg)` };
  return { code: spanSlice, action: "none", detail: `no removable motif element in ${pieceId}` };
};

export interface RenderTruthOptions {
  /** Which checks block. dead-region defaults to advisory (composition taste). */
  blockingKinds?: RenderTruthKind[];
  /** Brand's real background color (#rrggbb) — enables the canvas-brightness
   *  check (light brand shipped dark). Omitted ⇒ check skipped. */
  brandBackground?: string;
  /** Per-scene script registers (script.scenes[i].register) — enables the
   *  register-aware layout contracts (split hero placement). Omitted ⇒ only
   *  the universal stranded-corner rule runs. */
  registers?: (string | undefined)[];
  /** Brand name — enables the corner-mark-collision gate (a duplicate brand
   *  lockup colliding with the app's corner chrome). Omitted ⇒ gate skipped. */
  brandName?: string;
}

/**
 * Run all render-truth checks across measured scenes. Returns every finding;
 * `blocking` is the subset whose kind is in blockingKinds (default:
 * overflow + measure-error — the unambiguous correctness failures).
 */
export const findRenderTruthFailures = async (
  measurements: SceneMeasurement[],
  opts: RenderTruthOptions = {},
): Promise<{ findings: RenderTruthFinding[]; blocking: RenderTruthFinding[] }> => {
  // Default blockers: overflow (proven, zero-FP) + measure-error (fail-closed).
  const blockingKinds = new Set<RenderTruthKind>(
    opts.blockingKinds ?? ["overflow", "measure-error"],
  );
  const findings: RenderTruthFinding[] = [];
  for (const m of measurements) {
    findings.push(...findOverflow(m));
    findings.push(...findCrossPieceOverlap(m));
    findings.push(...findStrandedHero(m, opts.registers?.[m.scene]));
    findings.push(...findCornerMarkCollision(m, { brandName: opts.brandName }));
    findings.push(...findHollowCta(m, { brandBackground: opts.brandBackground }));
    findings.push(...findStrayFullBleedCard(m, opts.registers?.[m.scene]));
    findings.push(...findCenteredMockOcclusion(m, opts.registers?.[m.scene]));
    findings.push(...findIntraPieceOverlap(m));
    findings.push(...findGhostFragment(m));
    findings.push(...(await findEmptyBand(m)));
  }
  // Cross-scene: light brand shipped on a dark canvas (advisory by default).
  findings.push(...(await findCanvasBrightness(measurements, opts.brandBackground)));
  // Cross-scene: a scene shipped on an off-brand canvas (breaks video coherence).
  findings.push(...(await findCanvasCoherence(measurements, opts.brandBackground)));
  const blocking = findings.filter((f) => blockingKinds.has(f.kind));
  return { findings, blocking };
};

// Re-exported for callers that only need the outDir convention.
export const measureOutDir = (genDir: string): string =>
  path.join(genDir, ".render-truth");
