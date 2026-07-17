/**
 * Occupancy budget (v15, Lever B) — measured negative-space discipline.
 *
 * Cycle-6 evidence (Robinhood): s0's right half shipped near-EMPTY (dim
 * percent bars floating in a void beside a clipped panel), s3's product cards
 * were half-empty below their titles, and cycle-4 Oatly s2 shipped the same
 * class (a postage-stamp carton in a void). Every existing gate was blind by
 * construction: dead-region is quadrant-ink ADVISORY, barbell only sees
 * full-width HORIZONTAL bands, hero-underscale only sees the hero piece's own
 * painted area.
 *
 * METRIC LESSON (calibration 2026-07-17, all six surviving dogfood genDirs):
 * the originally-specced painted+text RECT-UNION per half is ANTI-monotone
 * with the eyeball verdicts — cycle-6 s0's "void" right half measured MORE
 * union coverage (22.7%) than must-pass halves (LiquidDeath s1 right 8.2%,
 * Robinhood s2 left 7.5%) because getBoundingClientRect reports PHANTOM
 * layout: the s0 hero panel measured 822px wide while only ~400px painted
 * (overflow-clipped), and its interior rows/ghost spans padded the union with
 * invisible extent. Rect unions cannot see clipping or near-canvas dimness.
 * So the FIRING metric is pixel truth instead:
 *
 *   EMPTY-COLUMN RUN — the widest contiguous run of columns carrying almost
 *   no ink (painted-content assessEmptyColumnRun: dominant-background
 *   subtraction, column ink floor COLUMN_INK_FLOOR so hairlines/faint
 *   texture don't break a void), as a fraction of frame width.
 *
 * with a DIEGETIC-ANCHOR EXEMPTION: a wide low-ink region that carries a
 * deliberate drawn motif is STAGED negative space, not a defect (LiquidDeath
 * s1's skull-anchored manifesto void — supervisor-verified strongest frame of
 * its cycle — vs Robinhood s0's anchorless void). An anchor is a substantial
 * visible element (svg / <img> / gradient surface / own text, ≥80px in both
 * dims, visible-rect center inside the run band) of a content piece. Plain
 * opaque near-canvas slabs deliberately do NOT anchor — an invisible panel
 * is exactly the defect.
 *
 * CALIBRATION (run@colFloor 0.015, fraction of W; floor 0.23 — re-measured on
 * the archived frames by agent #2, 2026-07-17; numbers below are the ACTUAL
 * assessEmptyColumnRun outputs):
 *   MUST FIRE (blocking, quote/centered) —
 *               Robinhood s0 (quote):    26.5% @x74–100 (the cycle-6 void; its
 *               percent-bar throughline is transparent divs — no anchor)
 *             — Oatly     s2 (centered): 25.0% @x75–100 (postage-stamp carton)
 *   ADVISE (split — non-blocking) —
 *               Robinhood s2 (split): 28.5% @x27–56 (supervisor-eyeball-
 *               CONFIRMED "under-furnished left half"; advisory honors the
 *               fix-list's "s2 must pass" while surfacing the void)
 *   fires too (blocking where quote/centered) — Glossier s1 41.9% (the
 *               postage-stamp tablet) · Linear s3 24.0% (right-edge void; the
 *               anchor exemption is the safety valve if it carries a mock)
 *   below floor now — Robinhood s4 (centered) 21.9% (was claimed 24%; the
 *               "vast dark left region" QA note sits just under 0.23 — the
 *               card/contrast arms cover it) · LiquidDeath s2 22.7% (the FP
 *               the 0.23 bump removes)
 *   MUST PASS — Robinhood s1 (stat):     8.5% (stat → advisory register anyway)
 *             — LiquidDeath s1 (quote): 35.2% BUT skull-svg anchored → EXEMPT
 *             — Oatly s0 (quote) 4.4% · Glossier s0 14.8% · LiquidDeath s0
 *               19.0% · Linear s4 19.6% · Patagonia s2 20.6% (nearest
 *               unanchored pass, 0.90x floor — the class is a continuum, so the
 *               repair asks for furnishing, never relayout)
 *   Full-bleed scenes are exempt (the barbell gate owns their voids);
 *   split/stat/list registers ADVISE instead of blocking (a column/rows/tiles
 *   legitimately weight one side).
 *
 * Card interiors: an opaque card panel (≥60k px², ≤50% of canvas) whose
 * interior painted+text coverage (visible rects) is under CARD_INTERIOR_FLOOR
 * advises (never blocks — interior air can be deliberate; the advisory rides
 * along on pieces already regenerating). Calibration: Robinhood s3's product
 * cards measure 5.9% interior (the cycle-6 "card interiors half-empty" QA
 * finding) and Oatly s0's REGISTER stage card 3.1% (the cycle-4 QA class) —
 * both advise; the furnished Robinhood s0 lifted panel measures 27.3%,
 * LiquidDeath s0 ledger 36.7% (floor 0.4 keeps a gap below the strong
 * interiors, which measure 0.5+).
 *
 * Fail posture: findings returned, never thrown; a missing screenshot or
 * sharp failure records an error and skips the scene (never fabricates).
 */
import { assessEmptyColumnRun, assessRegionInk, COLUMN_INK_FLOOR } from "./painted-content";
import { rectUnionArea, isPaintedElement } from "./hero-contrast";
import type { MeasuredElement, SceneMeasurement } from "./measure-scene";

// ── calibrated floors ────────────────────────────────────────────────────────

/** Widest empty-column run ≥ this fraction of frame W = a void band.
 *  v15 agent-#2 correction (0.22→0.23): the archived-frame re-measurement
 *  showed LiquidDeath s2 at 22.7% (a right-edge band on a supervisor-verified
 *  STRONG, never-void-flagged cycle) — a false positive at 0.22. 0.23 removes
 *  it while every MUST-FIRE keeps ≥2pt margin (Robinhood s0 26.5%, Oatly s2
 *  25.0%, Robinhood s2 28.5%) and the nearest must-pass (Patagonia s2 20.6%)
 *  gains margin. */
export const OCCUPANCY_RUN_FLOOR = 0.23;
/** Registers where a void band BLOCKS (the composition owns the full frame).
 *  v15 agent-#2 correction: `split` moved to ADVISORY (below). The task's
 *  cycle-6 calibration says "s1/s2 MUST pass"; Robinhood s2 is a `split` scene
 *  measuring 28.5% (a real under-furnished left half per the supervisor's own
 *  later eyeball). Making split advisory-only honors "s2 must pass" (no
 *  blocking finding / no retry target) while STILL surfacing the void as a
 *  ride-along advisory — and is materially safer against false positives on
 *  intentionally-asymmetric software-UI split layouts (the Superhuman build). */
export const OCCUPANCY_BLOCKING_REGISTERS: ReadonlySet<string> = new Set([
  "quote",
  "centered",
]);
/** Registers where a void band only ADVISES. full-bleed is exempt entirely.
 *  split lives here (see OCCUPANCY_BLOCKING_REGISTERS note): one column can
 *  legitimately weight, so a split void advises, never blocks. */
export const OCCUPANCY_ADVISORY_REGISTERS: ReadonlySet<string> = new Set([
  "split",
  "stat",
  "list",
]);
/** Anchor: a deliberate motif in the void — min size (both dims, visible). */
export const OCCUPANCY_ANCHOR_MIN_PX = 80;
/** …and its region must actually PAINT: ink share ≥ this (pixel-verified —
 *  LiquidDeath's skull measures ~0.05+; a transparent wrapper ~0). */
export const OCCUPANCY_ANCHOR_MIN_INK = 0.03;

/** Card-interior furnish floor (advisory only). */
export const CARD_INTERIOR_FLOOR = 0.4;
/** A "card" is an opaque panel at least this big… */
export const CARD_MIN_AREA_PX = 60_000;
/** …and at most this fraction of the canvas (bigger = a stage, not a card). */
const CARD_MAX_CANVAS_FRAC = 0.5;
const MAX_CARD_ADVISORIES_PER_SCENE = 4;

// ── types ────────────────────────────────────────────────────────────────────

export interface OccupancySceneStat {
  scene: number;
  register?: string;
  /** Widest empty-column run as a fraction of W + its band. */
  runFracW: number;
  band: { startFracW: number; endFracW: number };
  /** Anchor element found inside the band (exemption applied), if any. */
  anchor?: { pieceId: string; tag: string; w: number; h: number };
}

export interface OccupancyVoidFinding {
  kind: "occupancy-void";
  scene: number;
  /** Routing target — the scene's hero owns furnishing the frame. */
  pieceId: string;
  blocking: boolean;
  runFracW: number;
  band: { startFracW: number; endFracW: number };
  region: "left" | "center" | "right";
  register: string;
  detail: string;
  repairInstruction: string;
}

export interface CardOccupancyAdvisory {
  kind: "card-interior-occupancy";
  scene: number;
  pieceId: string;
  blocking: false;
  card: { x: number; y: number; w: number; h: number };
  /** Interior painted+text coverage of the card, 0..1 (visible rects). */
  coverage: number;
  detail: string;
  advisory: string;
}

export interface OccupancyResult {
  stats: OccupancySceneStat[];
  findings: OccupancyVoidFinding[];
  cardAdvisories: CardOccupancyAdvisory[];
  errors: string[];
}

// ── helpers ──────────────────────────────────────────────────────────────────

const cssAlpha = (color: string): number => {
  if (/^#/.test(color?.trim() ?? "")) return 1;
  const m = /rgba?\(([^)]+)\)/.exec(color || "");
  if (!m) return 0;
  const p = m[1].split(",").map((v) => parseFloat(v.trim()));
  return p.length >= 4 ? (Number.isNaN(p[3]) ? 1 : p[3]) : 1;
};

/** The element's VISIBLE rect (clip-aware when the walk provides it). */
const visibleRect = (
  e: MeasuredElement,
): { x: number; y: number; w: number; h: number } =>
  typeof e.vw === "number" && typeof e.vh === "number"
    ? { x: e.vx ?? e.x, y: e.vy ?? e.y, w: e.vw, h: e.vh }
    : { x: e.x, y: e.y, w: e.w, h: e.h };

/** A deliberate drawn motif: svg/img/gradient-surface/text — NEVER a plain
 *  opaque slab (a near-canvas panel is the defect, not an anchor). */
const isAnchorElement = (e: MeasuredElement): boolean =>
  !!e.piece &&
  e.pieceKind !== "atmosphere" &&
  e.pieceKind !== "chrome" &&
  e.opacity > 0.1 &&
  (e.tag === "svg" || e.isImg || !!e.hasBgImage || e.text.trim().length >= 2);

const clampRect = (
  e: { x: number; y: number; w: number; h: number },
  box: { x: number; y: number; w: number; h: number },
): { x: number; y: number; w: number; h: number } => {
  const x0 = Math.max(e.x, box.x);
  const y0 = Math.max(e.y, box.y);
  const x1 = Math.min(e.x + e.w, box.x + box.w);
  const y1 = Math.min(e.y + e.h, box.y + box.h);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
};

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

// ── the gate ─────────────────────────────────────────────────────────────────

/**
 * Void-band + card-interior occupancy for measured scenes. `registers` is the
 * per-scene script register list. Needs the scene screenshots (pixel truth);
 * the card arm is pure rect math.
 */
export const assessOccupancy = async (
  measurements: SceneMeasurement[],
  registers: (string | undefined)[],
): Promise<OccupancyResult> => {
  const result: OccupancyResult = { stats: [], findings: [], cardAdvisories: [], errors: [] };
  for (const m of measurements) {
    if (m.error) continue;
    const register = registers[m.scene];
    const canvasArea = m.width * m.height;
    if (canvasArea <= 0) continue;

    // ── void band (pixel truth + anchor exemption) ──────────────────────────
    const judgedBlocking = !!register && OCCUPANCY_BLOCKING_REGISTERS.has(register);
    const judgedAdvisory = !!register && OCCUPANCY_ADVISORY_REGISTERS.has(register);
    if ((judgedBlocking || judgedAdvisory) && m.screenshotPath) {
      try {
        const run = await assessEmptyColumnRun(m.screenshotPath, { colInkFloor: COLUMN_INK_FLOOR });
        const stat: OccupancySceneStat = {
          scene: m.scene,
          register,
          runFracW: run.runFracW,
          band: { startFracW: run.startFracW, endFracW: run.endFracW },
        };
        if (run.runFracW >= OCCUPANCY_RUN_FLOOR) {
          // Anchor exemption: a substantial drawn motif centered in the band —
          // PIXEL-VERIFIED (its region must actually paint ink; a transparent
          // wrapper or near-canvas gradient claims nothing).
          const x0 = run.startFracW * m.width;
          const x1 = run.endFracW * m.width;
          const candidates = m.elements.filter((e) => {
            if (!isAnchorElement(e)) return false;
            const v = visibleRect(e);
            if (v.w < OCCUPANCY_ANCHOR_MIN_PX || v.h < OCCUPANCY_ANCHOR_MIN_PX) return false;
            const cx = v.x + v.w / 2;
            return cx >= x0 && cx <= x1;
          });
          let anchor: MeasuredElement | undefined;
          if (candidates.length > 0) {
            const inks = await assessRegionInk(
              m.screenshotPath,
              candidates.map((e) => {
                const v = visibleRect(e);
                return { x: v.x / m.width, y: v.y / m.height, w: v.w / m.width, h: v.h / m.height };
              }),
            );
            const hit = inks.findIndex((ink) => ink >= OCCUPANCY_ANCHOR_MIN_INK);
            if (hit !== -1) anchor = candidates[hit];
          }
          if (anchor) {
            const v = visibleRect(anchor);
            stat.anchor = { pieceId: anchor.piece, tag: anchor.tag, w: v.w, h: v.h };
          } else {
            const mid = (run.startFracW + run.endFracW) / 2;
            const region: "left" | "center" | "right" = mid < 0.38 ? "left" : mid > 0.62 ? "right" : "center";
            const bandPx = Math.round(run.runFracW * m.width);
            result.findings.push({
              kind: "occupancy-void",
              scene: m.scene,
              pieceId: `s${m.scene}.hero`,
              blocking: judgedBlocking,
              runFracW: run.runFracW,
              band: { startFracW: run.startFracW, endFracW: run.endFracW },
              region,
              register: register!,
              detail:
                `scene ${m.scene}: a ${bandPx}px-wide VOID BAND (${pct(run.runFracW)} of the frame width, the ` +
                `${region} region, x≈${Math.round(run.startFracW * m.width)}–${Math.round(run.endFracW * m.width)}) ` +
                `carries no visible ink on this ${register} scene (floor ${pct(OCCUPANCY_RUN_FLOOR)}) and no ` +
                `anchoring motif. That side of the frame reads abandoned, not staged.`,
              repairInstruction:
                `FURNISH THE VOID — do not relayout and do not stretch existing items apart. Populate the ${region} ` +
                `region with REGISTER-CONSISTENT interior items in the same diegetic world as your existing ` +
                `content` +
                `${register === "split" ? " (the column owning that region must fill it: real rows, a chart, KPI tiles, captions)" : " (supporting labels, badges, stat chips, annotation lines, a secondary panel, or one substantial drawn motif in the brand's own vocabulary)"} ` +
                `— VISIBLE against the canvas, not near-canvas-toned. Scaling the existing artifact decisively into ` +
                `that region also counts when it is the natural owner of the space.`,
            });
          }
        }
        result.stats.push(stat);
      } catch (err) {
        result.errors.push(
          `scene ${m.scene}: column-run sampling failed — ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
        );
      }
    }

    // ── card interiors (advisory, visible-rect math) ────────────────────────
    const childIx = new Map<number, number[]>();
    m.elements.forEach((e, i) => {
      if (typeof e.parentIx === "number" && e.parentIx >= 0) {
        childIx.set(e.parentIx, [...(childIx.get(e.parentIx) ?? []), i]);
      }
    });
    const descendantsOf = (root: number): number[] => {
      const out: number[] = [];
      const stack = [...(childIx.get(root) ?? [])];
      while (stack.length > 0) {
        const i = stack.pop()!;
        out.push(i);
        stack.push(...(childIx.get(i) ?? []));
      }
      return out;
    };
    let cardCount = 0;
    for (const [i, e] of m.elements.entries()) {
      if (cardCount >= MAX_CARD_ADVISORIES_PER_SCENE) break;
      if (!e.piece || e.pieceKind === "atmosphere" || e.pieceKind === "chrome") continue;
      if (e.opacity <= 0.1) continue;
      const card = visibleRect(e);
      const area = card.w * card.h;
      if (area < CARD_MIN_AREA_PX || area > CARD_MAX_CANVAS_FRAC * canvasArea) continue;
      if (cssAlpha(e.bg) < 0.5 && !e.hasBgImage) continue;
      const kids = descendantsOf(i);
      if (kids.length === 0) continue; // an empty slab is skeleton/washout territory
      const interior = kids
        .map((k) => m.elements[k])
        .filter((k) => isPaintedElement(k))
        .map((k) => clampRect(visibleRect(k), card))
        .filter((r) => r.w > 0 && r.h > 0);
      const coverage = rectUnionArea(interior) / area;
      if (coverage >= CARD_INTERIOR_FLOOR) continue;
      cardCount += 1;
      result.cardAdvisories.push({
        kind: "card-interior-occupancy",
        scene: m.scene,
        pieceId: e.piece,
        blocking: false,
        card,
        coverage,
        detail:
          `scene ${m.scene}: a ${card.w}×${card.h} card in piece "${e.piece}" is UNDER-FURNISHED — interior ` +
          `painted+text coverage ${pct(coverage)} (furnish floor ${pct(CARD_INTERIOR_FLOOR)}). ` +
          `Most of the card reads as dead panel.`,
        advisory:
          `ADVISORY (non-blocking) — a ${card.w}×${card.h} card interior in this piece is ${pct(coverage)} furnished ` +
          `(target comfortably >${pct(CARD_INTERIOR_FLOOR)}). While regenerating, ALSO fill the card's empty ` +
          `region with real interior content in the same register (rows, meta lines, a chart strip, concrete ` +
          `values) — never ship a card that is mostly empty panel.`,
      });
    }
  }
  result.findings.sort((a, b) => a.scene - b.scene);
  return result;
};
