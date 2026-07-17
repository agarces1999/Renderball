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
import { assessFrameInk, assessEmptyBand, QUADRANT_FLOOR, INK_FLOOR } from "./painted-content";
import type { SceneMeasurement, MeasuredElement } from "./measure-scene";

export type RenderTruthKind =
  | "overflow"
  | "text-overlap"
  | "cross-piece-overlap"
  | "barbell"
  | "contrast"
  | "dead-region"
  | "canvas-brightness"
  | "stranded-hero"
  | "interior-clip"
  | "measure-error";

export interface RenderTruthFinding {
  scene: number;
  kind: RenderTruthKind;
  detail: string;
}

// px tolerance so sub-pixel rounding / intentional full-bleed don't false-fire.
const EDGE_TOL = 3;
// Only content elements can be "clipped"; a full-bleed background/atmosphere
// legitimately fills or exceeds the canvas. Content = has own text, or is an
// <img>, or is a small-ish decorated box (handled by contrast/dead-region).
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

// ── text-on-text overlap (the wrapping-headline-buries-the-lede defect) ──────
// Two DISTINCT text blocks printed on top of each other — both unreadable. The
// canonical cause: a scene stacks eyebrow/headline/lede/bullets with per-block
// `position:absolute; top:…`, then a headline wraps to more lines than the
// hardcoded gap reserved, overrunning the block below. The overflow gate misses
// it (nothing crosses the canvas edge — the collision is INSIDE the frame). The
// design-agent prompt rule ("stacked text MUST flow") is the primary fix; this is
// the deterministic detector. ADVISORY by default (not in blockingKinds) so it
// surfaces the defect without risking a wrongful regen of a good scene.
const OVERLAP_MIN_TEXT_PX = 12;
const OVERLAP_MIN_FRAC = 0.3; // intersection ≥30% of the SMALLER box ⇒ a collision

// Alpha of a CSS rgb/rgba color. rgb(...) (no alpha) ⇒ opaque (1). Used to keep
// the check to text sitting on the CANVAS — text on an opaque chip/card/badge
// overlaps that surface by design and must not be flagged.
const cssAlpha = (color: string): number => {
  const m = /rgba?\(([^)]+)\)/.exec(color || "");
  if (!m) return 0; // no parseable bg ⇒ treat as transparent
  const p = m[1].split(",").map((v) => parseFloat(v.trim()));
  return p.length >= 4 ? (Number.isNaN(p[3]) ? 1 : p[3]) : 1;
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

// A free-standing text BLOCK on the canvas (not a chip/badge label, not an icon,
// not an inline accent inside another block).
const isOverlapText = (e: MeasuredElement): boolean =>
  !e.isImg &&
  !INLINE_TEXT_TAGS.has(e.tag.toLowerCase()) &&
  e.text.trim().length >= 2 &&
  e.fontSize >= OVERLAP_MIN_TEXT_PX &&
  e.opacity > 0.1 &&
  cssAlpha(e.bg) < 0.15;

/**
 * Distinct text blocks whose measured boxes significantly overlap. Pairs are
 * skipped when one element's text CONTAINS the other's — that's a container/child
 * (e.g. a <ul> box around its <li>s, or a wrapper around its text node), not a
 * collision. What remains — two blocks with different copy overlapping ≥30% of
 * the smaller box — is the headline-buries-lede defect.
 */
export const findTextOverlap = (m: SceneMeasurement): RenderTruthFinding[] => {
  if (m.error) return []; // measure-error already surfaced by findOverflow
  const texts = m.elements.filter(isOverlapText);
  const out: RenderTruthFinding[] = [];
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i];
      const b = texts[j];
      // Container/child or a repeated string — not a collision.
      if (a.text.includes(b.text) || b.text.includes(a.text)) continue;
      const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ix <= 0 || iy <= 0) continue; // no intersection
      const minArea = Math.min(a.w * a.h, b.w * b.h);
      if (minArea <= 0) continue;
      const frac = (ix * iy) / minArea;
      if (frac < OVERLAP_MIN_FRAC) continue;
      out.push({
        scene: m.scene,
        kind: "text-overlap",
        detail:
          `text "${a.text.slice(0, 24)}" overlaps text "${b.text.slice(0, 24)}" — ` +
          `${Math.round(frac * 100)}% of the smaller box ` +
          `(${a.tag}@${a.x},${a.y} ${a.w}×${a.h} ∩ ${b.tag}@${b.x},${b.y} ${b.w}×${b.h})`,
      });
    }
  }
  return out;
};

// ── color/luminance helpers (WCAG relative luminance) ────────────────────────
const relLum = (r: number, g: number, b: number): number => {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};

// Floors are deliberately lenient — these flag genuinely-broken (near-invisible)
// content, not aesthetic borderline cases (false-negative direction).
const LOGO_RANGE_FLOOR = 0.1; // logo whose luminance barely varies vs its card
const MIN_LOGO = { w: 36, h: 18 };

/**
 * Sampled-from-pixels contrast — LOGO ARM ONLY as of v15. Logo image: internal
 * luminance range (a washed-out logo on a same-tone card barely varies).
 *
 * v15 RETIREMENT: the TEXT arm (computed color vs the mean luminance of the
 * text's own box) is retired — the box mean averages the glyphs themselves in,
 * so it false-fired on legible text (cycle-4 s4: "1.15:1" on a readable
 * navy-on-cream headline) and under-fired on real ghosts. Per-text-node
 * contrast against the sampled LOCAL backdrop (lib/render/text-contrast.ts,
 * dominant-cluster sampling that excludes the glyphs) replaces it with a
 * blocking arm + advisory band.
 *
 * Needs the screenshot; sharp is dynamic-imported so its absence degrades to
 * no contrast findings (not a crash).
 */
export const findContrast = async (
  m: SceneMeasurement,
): Promise<RenderTruthFinding[]> => {
  if (m.error || !m.screenshotPath) return [];
  const sharpMod = await import("sharp").catch(() => null);
  if (!sharpMod) return [];
  const sharp = sharpMod.default;
  const out: RenderTruthFinding[] = [];

  const sampleBox = async (
    x: number,
    y: number,
    w: number,
    h: number,
  ): Promise<{ mean: number; range: number } | null> => {
    const left = Math.max(0, Math.round(x));
    const top = Math.max(0, Math.round(y));
    const width = Math.min(m.width - left, Math.round(w));
    const height = Math.min(m.height - top, Math.round(h));
    if (width < 2 || height < 2) return null;
    try {
      const { data } = await sharp(m.screenshotPath)
        .extract({ left, top, width, height })
        .raw()
        .toBuffer({ resolveWithObject: true });
      let lo = 1,
        hi = 0,
        sum = 0,
        n = 0;
      for (let i = 0; i + 2 < data.length; i += 3) {
        const L = relLum(data[i], data[i + 1], data[i + 2]);
        if (L < lo) lo = L;
        if (L > hi) hi = L;
        sum += L;
        n++;
      }
      return n ? { mean: sum / n, range: hi - lo } : null;
    } catch {
      return null;
    }
  };

  for (const e of m.elements) {
    if (e.opacity <= 0.05) continue;
    if (e.isImg) {
      if (e.w < MIN_LOGO.w || e.h < MIN_LOGO.h) continue;
      // Skip corner brand-chrome marks (small, top band): a monochrome SVG
      // wordmark legitimately has near-zero internal luminance range yet reads
      // fine against the canvas. The internal-range proxy only makes sense for
      // larger logo cards (partner/customer logos on a surface). Logo-vs-surface
      // readability is owned by the vision gate, not this proxy — so contrast is
      // ADVISORY, never blocking, until that proxy is replaced with ink-vs-surface.
      if (e.y < 130 || (e.w < 120 && e.h < 60)) continue;
      const s = await sampleBox(e.x, e.y, e.w, e.h);
      if (s && s.range < LOGO_RANGE_FLOOR) {
        out.push({
          scene: m.scene,
          kind: "contrast",
          detail: `logo <img ${(e.src || "").slice(-28)}> nearly invisible against its surface (luminance range ${s.range.toFixed(3)} < ${LOGO_RANGE_FLOOR})`,
        });
      }
    }
    // v15: text nodes are judged by lib/render/text-contrast.ts (per-node
    // local-backdrop sampling) — the whole-box text arm here is RETIRED.
  }
  return out;
};

/** Measured empty quadrants on the rendered frame (reuses painted-content). */
export const findDeadRegion = async (
  m: SceneMeasurement,
): Promise<RenderTruthFinding[]> => {
  if (m.error || !m.screenshotPath) return [];
  try {
    const ink = await assessFrameInk(m.screenshotPath);
    const out: RenderTruthFinding[] = [];
    if (ink.inkRatio < INK_FLOOR) {
      out.push({ scene: m.scene, kind: "dead-region", detail: `near-empty frame (ink ${ink.inkRatio.toFixed(4)} < ${INK_FLOOR})` });
    }
    const empties = (Object.entries(ink.quadrants) as [string, number][])
      .filter(([, v]) => v < QUADRANT_FLOOR)
      .map(([k]) => k);
    if (empties.length > 0 && ink.inkRatio >= INK_FLOOR) {
      out.push({ scene: m.scene, kind: "dead-region", detail: `empty quadrant(s): ${empties.join(", ")}` });
    }
    return out;
  } catch {
    return [];
  }
};

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

// ── interior clip (v11 — dogfood cycle 2: price chips cut mid-glyph) ─────────
// Cycle 2 s2 shipped mock price chips ("$36.0", "4.8") clipped at their
// panel's edge — inside the frame, so every edge gate was blind. Measured
// truth: a text element sticking out past the union of its OWN piece's other
// elements by more than a third of its own width/height reads as content
// falling off its panel. ADVISORY by design: overhang is also a legitimate
// design pattern (badges breaking a card edge), so this surfaces the defect
// for the report/regen feedback without risking a wrongful blocking round.

/** Fraction of its own width/height a text element may extend past its
 *  piece's other-elements union before the advisory fires. */
export const INTERIOR_CLIP_FRAC = 0.3;
const IC_MIN_TEXT_LEN = 2;
const IC_MIN_SIBLING_AREA = 40_000; // the reduced union must be a real panel
const IC_MAX_PER_SCENE = 4;

/** Text elements protruding past their own piece's union (computed WITHOUT
 *  the element itself) by > INTERIOR_CLIP_FRAC of their own size. */
export const findInteriorClip = (m: SceneMeasurement): RenderTruthFinding[] => {
  if (m.error) return [];
  const byPiece = new Map<string, MeasuredElement[]>();
  for (const e of m.elements) {
    if (!e.piece || e.opacity <= 0.05) continue;
    byPiece.set(e.piece, [...(byPiece.get(e.piece) ?? []), e]);
  }
  const out: RenderTruthFinding[] = [];
  for (const [pieceId, els] of byPiece) {
    if (els.length < 3) continue; // a union of one sibling is not a panel
    for (const e of els) {
      if (out.length >= IC_MAX_PER_SCENE) return out;
      if (e.isImg || e.text.trim().length < IC_MIN_TEXT_LEN) continue;
      const siblings = els.filter((s) => s !== e);
      const x1 = Math.min(...siblings.map((s) => s.x));
      const y1 = Math.min(...siblings.map((s) => s.y));
      const x2 = Math.max(...siblings.map((s) => s.x + s.w));
      const y2 = Math.max(...siblings.map((s) => s.y + s.h));
      if ((x2 - x1) * (y2 - y1) < IC_MIN_SIBLING_AREA) continue;
      // The element must be MOSTLY inside (its center within the union) —
      // fully-outside elements are their own composition, not a clip.
      const cx = e.x + e.w / 2;
      const cy = e.y + e.h / 2;
      if (cx < x1 || cx > x2 || cy < y1 || cy > y2) continue;
      const overs: { edge: string; px: number; own: number }[] = [
        { edge: "right", px: e.x + e.w - x2, own: e.w },
        { edge: "left", px: x1 - e.x, own: e.w },
        { edge: "bottom", px: e.y + e.h - y2, own: e.h },
        { edge: "top", px: y1 - e.y, own: e.h },
      ];
      const worst = overs.filter((o) => o.own > 0 && o.px / o.own > INTERIOR_CLIP_FRAC).sort((a, b) => b.px / b.own - a.px / a.own)[0];
      if (!worst) continue;
      out.push({
        scene: m.scene,
        kind: "interior-clip",
        detail:
          `text "${e.text.slice(0, 24)}" (piece ${pieceId}) protrudes ${Math.round(worst.px)}px past its piece's ` +
          `${worst.edge} edge — ${Math.round((worst.px / worst.own) * 100)}% of its own ${worst.edge === "right" || worst.edge === "left" ? "width" : "height"} ` +
          `sticks out of the panel (likely clipped mid-glyph). Keep interior values fully inside their panel.`,
      });
    }
  }
  return out;
};

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
}

/**
 * Run all render-truth checks across measured scenes. Returns every finding;
 * `blocking` is the subset whose kind is in blockingKinds (default:
 * overflow + contrast + measure-error — the unambiguous correctness failures).
 */
export const findRenderTruthFailures = async (
  measurements: SceneMeasurement[],
  opts: RenderTruthOptions = {},
): Promise<{ findings: RenderTruthFinding[]; blocking: RenderTruthFinding[] }> => {
  // Default blockers: overflow (proven, zero-FP) + measure-error (fail-closed).
  // contrast + dead-region are ADVISORY: the contrast proxy false-positives on
  // monochrome logos, and logo-readability/taste is the vision gate's job.
  const blockingKinds = new Set<RenderTruthKind>(
    opts.blockingKinds ?? ["overflow", "measure-error"],
  );
  const findings: RenderTruthFinding[] = [];
  for (const m of measurements) {
    findings.push(...findOverflow(m));
    findings.push(...findTextOverlap(m));
    findings.push(...findCrossPieceOverlap(m));
    findings.push(...findStrandedHero(m, opts.registers?.[m.scene]));
    findings.push(...findInteriorClip(m));
    findings.push(...(await findEmptyBand(m)));
    findings.push(...(await findContrast(m)));
    findings.push(...(await findDeadRegion(m)));
  }
  // Cross-scene: light brand shipped on a dark canvas (advisory by default).
  findings.push(...(await findCanvasBrightness(measurements, opts.brandBackground)));
  const blocking = findings.filter((f) => blockingKinds.has(f.kind));
  return { findings, blocking };
};

// Re-exported for callers that only need the outDir convention.
export const measureOutDir = (genDir: string): string =>
  path.join(genDir, ".render-truth");
