/**
 * Chromium-calibrated font metrics — Phase A (measure once) + Phase B (pure
 * Node arithmetic forever after).
 *
 * WHY THIS EXISTS
 * ---------------
 * Every published layout system PREDICTS whether text will fit, statistically.
 * We don't have to: the build already runs a headless Chromium (see
 * ./measure-scene.ts). So we MEASURE the real per-glyph advance widths in the
 * exact engine that will render the MP4, cache them, and then answer "does this
 * string fit in this box?" with pure arithmetic — no browser at call time.
 *
 * That turns a capacity budget ("this box holds ≤N headline chars, ≤R rows")
 * into something an emitter can be TOLD before it writes a single word, instead
 * of something a gate discovers after the fact.
 *
 * TWO PHASES
 *   Phase A — `calibrateFont()`. Runs once per (family, weight), at brand-crawl
 *     time, inside Playwright Chromium. Measures per-character advance widths at
 *     font-size:100px for ~200 glyphs (ASCII + the accented Latin set we ship,
 *     since we generate Spanish copy) with kerning DISABLED, plus a curated
 *     kern-pair sample WITH kerning enabled. Persists as JSON keyed by family +
 *     weight.
 *   Phase B — `textWidth()`. Pure Node: width(text, size) = Σ adv100[c]·size/100
 *     (+ measured kern deltas). No browser, no I/O, microseconds.
 *
 * MEASUREMENT DETAIL (why repeats, why kerning off)
 *   Chromium quantizes a shaped glyph RUN to LayoutUnit (1/64 px), not each
 *   glyph. Measuring a single char therefore carries up to 1/64 px of snap
 *   error; measuring the char repeated REPEAT times and dividing spreads that
 *   error over REPEAT glyphs. Kerning is disabled for the per-char pass so a
 *   repeated pair like "AA" can't contaminate A's own advance — kerning is then
 *   captured separately, as a delta, in the pair table.
 *
 * NEVER SILENTLY UNDER-ESTIMATE
 *   An uncalibrated font, or a glyph outside the calibrated set, falls back to a
 *   deliberately WIDE advance and sets `fallbackUsed` on the result. A budget
 *   that quietly under-estimates width is worse than no budget: it tells a blind
 *   emitter it has room it does not have, and ships overflow.
 *
 * NEVER MEASURE A SUBSTITUTED FACE (the assertion — see the RESOLUTION ASSERTION in PAGE_MEASURE)
 *   The failure this module is most exposed to is not a face that measures
 *   ZERO; it is a face that measures FINE and is the wrong face. If the
 *   requested family never loads, Chromium silently substitutes its default
 *   (Times) and every advance comes back plausible and non-zero — sailing past
 *   the zero-table guard and persisting as `source:"chromium"`, i.e. as a
 *   measurement. Downstream, capacity.ts then applies its TIGHT 4% calibrated
 *   margin to numbers nobody measured.
 *
 *   This really happened: all four caches written before this assertion existed
 *   were byte-identical to the browser's default face (proven by measuring a
 *   deliberately-nonexistent family locally and comparing advance tables). So
 *   calibration now PROVES the requested family resolved before stamping
 *   `source:"chromium"`, and `METRICS_VERSION` invalidates every cache written
 *   without that proof.
 */
import { promises as fs } from "fs";
import path from "path";

// ── the calibrated glyph set ────────────────────────────────────────────────
// ASCII printable (0x20–0x7E) — everything an English headline can contain.
const ASCII = Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) =>
  String.fromCharCode(0x20 + i),
).join("");

// Accented Latin. We generate SPANISH copy (and crawl Portuguese/French/German
// brands), so these are load-bearing, not decorative: an uncalibrated "ñ" in
// "diseño" is a real width the budget has to know.
const LATIN_ACCENTS =
  "áéíóúüñÁÉÍÓÚÜÑ¿¡çÇàèìòùÀÈÌÒÙâêîôûÂÊÎÔÛãõÃÕäëïöÄËÏÖßåÅøØæÆœŒ";

// Typographic punctuation the script generator actually emits (curly quotes,
// dashes, ellipsis) plus the symbol set that shows up in stat/chip copy.
const TYPOGRAPHIC = "—–‑‘’“”…•·«»€£¥¢°™®©±×÷→←↑↓✓✔★☆§¶†‡‰′″⁄№";

/** The ~200-glyph calibration set. Deduped, stable order. */
export const CALIBRATION_GLYPHS: string[] = Array.from(
  new Set([...ASCII, ...LATIN_ACCENTS, ...TYPOGRAPHIC]),
);

/**
 * Curated kern-pair sample. Kerning in Latin text is dominated by a small,
 * well-known set of shapes (diagonal caps before round/flat lowercase, T/V/W/Y
 * before vowels, punctuation after round letters). Measuring all 200² pairs
 * would be 40k measurements and a multi-MB cache for a sub-0.5% accuracy gain,
 * so we sample the pairs that carry nearly all the delta.
 */
export const KERN_PAIRS: string[] = (() => {
  const caps = ["A", "F", "L", "P", "T", "V", "W", "Y", "K", "R"];
  const lowers = ["a", "e", "o", "u", "y", "v", "w", "r", "s", "c", "á", "é", "ó"];
  const pairs: string[] = [];
  for (const c of caps) for (const l of lowers) pairs.push(c + l);
  // Cap–cap diagonals.
  for (const a of ["A", "V", "W", "Y", "T", "L", "P", "F"])
    for (const b of ["A", "V", "W", "Y", "T", "J", "O", "C"]) pairs.push(a + b);
  // Round/ascender letters before terminal punctuation.
  for (const a of ["r", "v", "w", "y", "f", "T", "V", "W", "Y", "P", "F"])
    for (const b of [".", ",", "-", "’"]) pairs.push(a + b);
  // Quotes and parens hugging their content.
  for (const a of ["“", "‘", "(", "["]) for (const b of ["A", "T", "V", "W", "Y", "J"]) pairs.push(a + b);
  // Digits — stat copy is full of them, and many faces kern "1" tightly.
  for (const a of ["1", "7", "4"]) for (const b of ["0", "1", "4", "7", "%", ".", ","]) pairs.push(a + b);
  return Array.from(new Set(pairs));
})();

// ── the persisted shape ─────────────────────────────────────────────────────

/**
 * Cache schema/contract version. BUMP whenever the meaning of a persisted
 * table changes, so stale caches are re-measured instead of trusted.
 *
 *   1 — original (no font-resolution assertion; a substituted face persisted as
 *       `source:"chromium"`). Every v1 cache is untrustworthy by construction.
 *   2 — `calibrateFont` proves the requested family actually resolved before
 *       stamping `source:"chromium"` (see the RESOLUTION ASSERTION in PAGE_MEASURE).
 */
export const METRICS_VERSION = 2;

/** How a face's identity was established. */
export type FontResolution =
  /** A CSS generic keyword (`serif`, `sans-serif`, …). Whatever Chromium maps
   *  it to IS the requested face — substitution is not a possible failure. */
  | "generic"
  /** A named family that PASSED the sentinel-advance differential (and, when an
   *  `@font-face` was declared, `document.fonts.check`). */
  | "asserted"
  /** Never measured — synthesized fallback metrics. */
  | "none";

export interface FontMetrics {
  family: string;
  weight: number;
  /** Advance width in px at font-size:100px, per character, kerning OFF. */
  adv: Record<string, number>;
  /**
   * Kern delta at 100px per sampled pair: measured(pair) − adv[a] − adv[b].
   * Almost always ≤ 0 (kerning tightens). Absent pair ⇒ assume 0, which
   * over-estimates width — the safe direction.
   */
  kern: Record<string, number>;
  /** Mean advance over the calibrated set (diagnostic / coarse estimates). */
  meanAdv: number;
  /**
   * Advance used for any glyph OUTSIDE the calibrated set: the p90 of the
   * calibrated advances, i.e. deliberately wide. An unknown glyph must never
   * make a string look narrower than it renders.
   */
  fallbackAdv: number;
  /** Ratio of a rendered line box to font-size at line-height:normal. */
  normalLineHeight: number;
  /** "chromium" = really measured. "fallback" = synthesized, never measured. */
  source: "chromium" | "fallback";
  /** ISO timestamp of the calibration run. */
  calibratedAt: string;
  /** Cache schema version — see `METRICS_VERSION`. */
  version: number;
  /** How the face's identity was proven. See `FontResolution`. */
  resolution: FontResolution;
}

/**
 * THE predicate for "were these advances really measured on the face we asked
 * for?". Everything that changes behaviour on calibration status — the capacity
 * safety margin, the `estimated` flag surfaced to an emitter, the
 * calibrated/estimated telemetry counter — must ask THIS, never `source` alone.
 *
 * `source` is a LABEL. Before the resolution assertion existed it was stamped
 * on substituted faces, so a counter keyed off it reported 100% success in the
 * exact failure case it was built to catch. This predicate requires the label
 * AND the current schema version AND a real resolution proof, so a stale v1
 * cache can never masquerade as calibrated.
 */
export const isCalibrated = (m: FontMetrics | null | undefined): boolean =>
  !!m &&
  m.source === "chromium" &&
  m.version === METRICS_VERSION &&
  (m.resolution === "generic" || m.resolution === "asserted");

export interface WidthResult {
  /** Predicted rendered width in px. */
  width: number;
  /** Count of characters that had no calibrated advance. */
  uncalibratedChars: number;
  /**
   * True when ANY conservative fallback was used (uncalibrated font, or an
   * uncalibrated glyph). Callers that surface budgets to an emitter should
   * propagate this — a flagged budget is an estimate, not a measurement.
   */
  fallbackUsed: boolean;
}

// ── Phase B: pure Node arithmetic ───────────────────────────────────────────

/**
 * Conservative advance for a font we have never calibrated, at 100px.
 * 0.62em sits comfortably ABOVE the mixed-case mean of every UI sans we've
 * measured (Inter ≈ 0.52, Helvetica ≈ 0.53, Geist ≈ 0.51) and above most
 * condensed display faces' uppercase mean. Wide on purpose.
 */
export const UNCALIBRATED_ADVANCE_100 = 62;

/** Line-height:normal is ~1.2× font-size across the faces we ship. */
export const DEFAULT_NORMAL_LINE_HEIGHT = 1.2;

/** Metrics for a font that was never calibrated. Always flags. */
export const fallbackMetrics = (family: string, weight = 400): FontMetrics => ({
  family,
  weight,
  adv: {},
  kern: {},
  meanAdv: UNCALIBRATED_ADVANCE_100,
  fallbackAdv: UNCALIBRATED_ADVANCE_100,
  normalLineHeight: DEFAULT_NORMAL_LINE_HEIGHT,
  source: "fallback",
  calibratedAt: new Date(0).toISOString(),
  version: METRICS_VERSION,
  resolution: "none",
});

/**
 * Phase B. width(text, size) = Σ adv100[c]·size/100, plus measured kern deltas.
 *
 * Detailed variant — returns the fallback flag alongside the width. Use this
 * anywhere the answer is handed to an emitter or a gate; use `textWidth` when
 * you only need the number.
 */
export const measureText = (
  m: FontMetrics,
  text: string,
  sizePx: number,
): WidthResult => {
  if (!text) return { width: 0, uncalibratedChars: 0, fallbackUsed: m.source === "fallback" };
  const scale = sizePx / 100;
  let sum = 0;
  let uncalibrated = 0;
  // Iterate by code POINT (Array.from splits surrogate pairs correctly) so an
  // emoji or astral glyph counts once, at the fallback advance, not twice.
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const a = m.adv[c];
    if (a === undefined) {
      uncalibrated++;
      sum += m.fallbackAdv;
    } else {
      sum += a;
    }
    if (i + 1 < chars.length) {
      const k = m.kern[c + chars[i + 1]];
      if (k !== undefined) sum += k;
    }
  }
  return {
    width: sum * scale,
    uncalibratedChars: uncalibrated,
    fallbackUsed: m.source === "fallback" || uncalibrated > 0,
  };
};

/** Phase B, width only. */
export const textWidth = (m: FontMetrics, text: string, sizePx: number): number =>
  measureText(m, text, sizePx).width;

// ── persistence ─────────────────────────────────────────────────────────────

/** Filesystem-safe cache key for a (family, weight). */
export const metricsKey = (family: string, weight = 400): string =>
  `${family.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unknown"}-${weight}`;

/** Default cache location. `.data/` is gitignored — these are build artifacts. */
export const DEFAULT_METRICS_DIR = path.join(process.cwd(), ".data", "font-metrics");

export const saveFontMetrics = async (
  m: FontMetrics,
  dir: string = DEFAULT_METRICS_DIR,
): Promise<string> => {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${metricsKey(m.family, m.weight)}.json`);
  await fs.writeFile(file, JSON.stringify(m), "utf8");
  return file;
};

/**
 * Load cached metrics, or null when this font was never calibrated. Never
 * throws — a corrupt/absent cache degrades to the flagged fallback path.
 *
 * A cache from an OLDER schema version is treated as absent, not as data. That
 * is the whole point of `METRICS_VERSION`: v1 files were written before the
 * resolution assertion existed, so a v1 table is indistinguishable from a
 * measurement of Chromium's substituted default face. Re-measuring costs one
 * ~1s Chromium pass; trusting it costs every budget derived from it.
 */
export const loadFontMetrics = async (
  family: string,
  weight = 400,
  dir: string = DEFAULT_METRICS_DIR,
): Promise<FontMetrics | null> => {
  try {
    const raw = await fs.readFile(path.join(dir, `${metricsKey(family, weight)}.json`), "utf8");
    const parsed = JSON.parse(raw) as FontMetrics;
    if (!parsed || typeof parsed.adv !== "object" || !parsed.adv) return null;
    if (typeof parsed.fallbackAdv !== "number" || !(parsed.fallbackAdv > 0)) return null;
    if (!isCalibrated(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
};

/**
 * Load-or-fallback. ALWAYS returns usable metrics; check `.source` (or the
 * `fallbackUsed` flag on width results) to know whether they were measured.
 */
export const getFontMetrics = async (
  family: string,
  weight = 400,
  dir: string = DEFAULT_METRICS_DIR,
): Promise<FontMetrics> => (await loadFontMetrics(family, weight, dir)) ?? fallbackMetrics(family, weight);

// ── Phase A: Chromium calibration ───────────────────────────────────────────

/** Repeats per glyph — spreads Chromium's 1/64px run snap over N advances. */
const REPEAT = 24;

/** CSS generic family keywords — these must NOT be quoted or they stop being
 *  generics and become a hunt for a literal family named "monospace". */
const CSS_GENERIC_FAMILIES = new Set([
  "serif", "sans-serif", "monospace", "cursive", "fantasy",
  "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded",
  "math", "emoji", "fangsong",
]);

/**
 * True for a CSS generic keyword. A generic is EXEMPT from the substitution
 * assertion: whatever Chromium maps `serif` to IS the requested face, so there
 * is no "wrong face" to detect. The exemption is also load-bearing in the other
 * direction — Chromium's default fallback IS its `serif` face, so a `serif`
 * calibration is byte-identical to the sentinel and the differential below
 * would reject it. (Measured locally: `serif@400` and a nonexistent family at
 * 400 produce the same 194-glyph advance table.)
 */
export const isGenericFamily = (family: string): boolean =>
  CSS_GENERIC_FAMILIES.has(family.trim().toLowerCase());

/** A family as it must appear in a `font-family` declaration. */
export const cssFontFamily = (family: string): string =>
  isGenericFamily(family)
    ? family.trim().toLowerCase()
    : `"${family.replace(/["\\]/g, "")}"`;

/**
 * A family name no font on earth carries, used as the differential SENTINEL: it
 * matches nothing, so it renders in Chromium's default fallback face — exactly
 * what a family that failed to load also renders in.
 */
export const SENTINEL_FAMILY = "__rb_no_such_family_7f3a9c__";

/**
 * The differential probe string. Deliberately glyph-diverse (caps, lowercase,
 * digits, punctuation, accents) and long, so two genuinely different faces
 * cannot tie by coincidence: at font-size 100px this measures several thousand
 * px, and the equality test uses a sub-pixel epsilon.
 */
export const RESOLUTION_PROBE =
  "Hamburgefonstiv 0123456789 AVWTYjgqp .,;:!? MMMiiilll ñáüßœ @#%&";

/** Width equality tolerance for the sentinel differential, in px at 100px type. */
const SENTINEL_EPSILON_PX = 0.5;

/**
 * The in-page measurement routine. Kept dependency-free and self-contained
 * because it is serialized into the browser (same constraint as
 * measure-scene.ts's PAGE_WALK).
 */
const PAGE_MEASURE = async (args: {
  /** Ready-to-use `font-family` value (already quoted, or a bare generic). */
  cssFamily: string;
  weight: number;
  glyphs: string[];
  pairs: string[];
  repeat: number;
  /** True when `cssFamily` is a CSS generic keyword — exempt from the assertion. */
  generic: boolean;
  /** `font-family` value for a family that matches nothing (the differential control). */
  sentinelFamily: string;
  /** Glyph-diverse string measured under both families. */
  probe: string;
  /** Sub-pixel tolerance for calling two probe widths equal. */
  epsilon: number;
}) => {
  const { cssFamily, weight, glyphs, pairs, repeat, generic, sentinelFamily, probe, epsilon } = args;
  const host = document.createElement("div");
  host.style.cssText =
    "position:absolute;left:-99999px;top:0;width:auto;height:auto;visibility:hidden;";
  document.body.appendChild(host);

  const span = document.createElement("span");
  const baseFor = (family: string) =>
    `display:inline-block;white-space:pre;letter-spacing:0;word-spacing:0;` +
    `font-family:${family};font-weight:${weight};font-size:100px;` +
    `font-variant-ligatures:none;font-feature-settings:"liga" 0,"clig" 0,"calt" 0;`;
  const base = baseFor(cssFamily);
  host.appendChild(span);

  const measureWith = (family: string, text: string, kerning: boolean): number => {
    span.style.cssText =
      baseFor(family) +
      (kerning
        ? `font-kerning:normal;`
        : `font-kerning:none;font-feature-settings:"liga" 0,"clig" 0,"calt" 0,"kern" 0;`);
    span.textContent = text;
    return span.getBoundingClientRect().width;
  };
  const measure = (text: string, kerning: boolean): number =>
    measureWith(cssFamily, text, kerning);

  // ── THE RESOLUTION ASSERTION ──────────────────────────────────────────────
  // Ask the browser to actually LOAD the face first. This is not just belt and
  // braces, it is the root-cause fix: nothing on the page referenced the
  // family, so the @font-face was never requested, `document.fonts.ready`
  // resolved vacuously, and the measurement below raced a lazy load it always
  // won — measuring the substituted default face every time.
  const spec = `${weight} 100px ${cssFamily}`;
  let checkOk = true;
  if (!generic) {
    try {
      if (document.fonts && typeof document.fonts.load === "function") {
        await document.fonts.load(spec, probe);
      }
    } catch {
      /* load() rejects on an undecodable face — the differential still decides */
    }
    try {
      checkOk =
        !document.fonts || typeof document.fonts.check !== "function"
          ? true
          : document.fonts.check(spec);
    } catch {
      checkOk = true;
    }
  }
  // The AUTHORITATIVE signal: does the requested family measure differently
  // from a family that matches nothing? Both fall back to Chromium's default
  // face, so identical probe widths mean the requested family contributed
  // NOTHING — i.e. we are about to measure a substitute.
  //
  // `check()` alone cannot carry this: per spec it returns TRUE for a family
  // with no matching @font-face rule (vacuously — "all zero matched faces are
  // loaded"), which is precisely the undeclared-family case. It is kept as a
  // necessary condition, not a sufficient one.
  const probeRequested = generic ? 0 : measureWith(cssFamily, probe, false);
  const probeSentinel = generic ? 0 : measureWith(`"${sentinelFamily}"`, probe, false);
  const differsFromSentinel = generic || Math.abs(probeRequested - probeSentinel) > epsilon;
  const resolved = generic || (checkOk && differsFromSentinel);

  // Per-glyph advance, kerning OFF, averaged over `repeat` copies.
  const adv: Record<string, number> = {};
  for (const g of glyphs) {
    adv[g] = measure(g.repeat(repeat), false) / repeat;
  }

  // Kern deltas, kerning ON: measured(pair) − adv[a] − adv[b].
  const kern: Record<string, number> = {};
  for (const p of pairs) {
    const a = p[0];
    const b = p[1];
    if (adv[a] === undefined || adv[b] === undefined) continue;
    // Average over `repeat` copies of the pair. Repeating a pair introduces the
    // b→a junction too, so measure the run and subtract the (repeat-1) junctions
    // by also measuring the reversed junction run. Cheaper + exact enough: one
    // pair, one measurement — the 1/64px snap is 0.016px against a ~120px pair,
    // i.e. 0.013%, far under the safety margin.
    const d = measure(p, true) - adv[a] - adv[b];
    if (Math.abs(d) > 0.01) kern[p] = d;
  }

  // line-height:normal, as a multiple of font-size.
  const probeEl = document.createElement("div");
  probeEl.style.cssText =
    `position:absolute;left:-99999px;font-family:${cssFamily};font-weight:${weight};` +
    `font-size:100px;line-height:normal;white-space:pre;`;
  probeEl.textContent = "Hxg";
  document.body.appendChild(probeEl);
  const normalLineHeight = probeEl.getBoundingClientRect().height / 100;
  probeEl.remove();
  host.remove();

  return {
    adv,
    kern,
    normalLineHeight,
    resolved,
    checkOk,
    differsFromSentinel,
    probeRequested,
    probeSentinel,
  };
};

const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return UNCALIBRATED_ADVANCE_100;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))];
};

export interface CalibrateOpts {
  family: string;
  weight?: number;
  /**
   * Optional @font-face source (the brand's woff2/otf, ideally already inlined
   * as a data: URL by font-inline.ts). Omit for a system/generic family.
   */
  src?: string;
  /** Reuse an already-open Playwright page instead of launching a browser. */
  page?: CalibrationPage;
}

/**
 * The slice of Playwright's Page this module needs. Declared with METHOD
 * syntax (bivariant parameters) so a real `Page` — whose `setContent`/`evaluate`
 * carry narrower option and generic types — is assignable without importing
 * Playwright's types into a module that must load without it.
 */
export interface CalibrationPage {
  setContent(html: string, options?: unknown): Promise<unknown>;
  evaluate(fn: unknown, arg?: unknown): Promise<unknown>;
}

/**
 * Phase A. Measure a font family/weight in real headless Chromium.
 *
 * Best-effort by contract: any browser/font failure returns the FLAGGED
 * fallback metrics rather than throwing, so a calibration problem degrades the
 * budget to a conservative estimate instead of failing a build.
 */
export const calibrateFont = async (opts: CalibrateOpts): Promise<FontMetrics> => {
  const { family, weight = 400, src } = opts;
  const run = async (page: CalibrationPage): Promise<FontMetrics> => {
    const face =
      src && family
        ? `@font-face{font-family:"${family}";font-weight:${weight};src:url("${src}");font-display:block;}`
        : "";
    await page.setContent(
      `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;}${face}</style></head><body></body></html>`,
      { waitUntil: "networkidle", timeout: 30000 },
    ).catch(async () => {
      await page.setContent(
        `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;}${face}</style></head><body></body></html>`,
        { waitUntil: "load", timeout: 30000 },
      );
    });
    await page.evaluate("document.fonts && document.fonts.ready").catch(() => {});
    const generic = isGenericFamily(family);
    const measured = (await page.evaluate(PAGE_MEASURE, {
      cssFamily: cssFontFamily(family),
      weight,
      glyphs: CALIBRATION_GLYPHS,
      pairs: KERN_PAIRS,
      repeat: REPEAT,
      generic,
      sentinelFamily: SENTINEL_FAMILY,
      probe: RESOLUTION_PROBE,
      epsilon: SENTINEL_EPSILON_PX,
    })) as {
      adv: Record<string, number>;
      kern: Record<string, number>;
      normalLineHeight: number;
      resolved: boolean;
    };

    // THE ASSERTION. A substituted face measures fine, so this — not the
    // zero-table guard below — is what stands between us and persisting Times
    // as "the brand's display face". Failing it is not an error: it degrades to
    // flagged fallback metrics and capacity.ts's wider 10% margin, which is the
    // honest answer for a face we could not put in front of the engine.
    if (!measured.resolved) return fallbackMetrics(family, weight);

    const advances = Object.values(measured.adv).filter((v) => v > 0);
    if (advances.length < CALIBRATION_GLYPHS.length / 2) {
      // The face never loaded (nearly everything measured 0) — do NOT persist a
      // table of zeros; that would silently under-estimate every string.
      return fallbackMetrics(family, weight);
    }
    const mean = advances.reduce((a, b) => a + b, 0) / advances.length;
    return {
      family,
      weight,
      adv: measured.adv,
      kern: measured.kern,
      meanAdv: mean,
      // p90 of the real advances: an unknown glyph is assumed WIDE.
      fallbackAdv: Math.max(percentile(advances, 0.9), mean),
      normalLineHeight: measured.normalLineHeight > 0.5 ? measured.normalLineHeight : DEFAULT_NORMAL_LINE_HEIGHT,
      source: "chromium",
      calibratedAt: new Date().toISOString(),
      version: METRICS_VERSION,
      resolution: generic ? "generic" : "asserted",
    };
  };

  if (opts.page) {
    try {
      return await run(opts.page);
    } catch {
      return fallbackMetrics(family, weight);
    }
  }

  // Same dynamic-import + interop dance as measure-scene.ts: a missing package
  // or missing chromium BINARY must degrade, never crash the caller.
  let chromium: typeof import("playwright").chromium;
  try {
    const pw = (await import("playwright")) as unknown as {
      chromium?: typeof import("playwright").chromium;
      default?: { chromium?: typeof import("playwright").chromium };
    };
    const resolved = pw.chromium ?? pw.default?.chromium;
    if (!resolved) throw new Error("playwright `chromium` export undefined");
    chromium = resolved;
  } catch {
    return fallbackMetrics(family, weight);
  }
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  try {
    browser = await chromium.launch({ args: ["--no-sandbox"] });
  } catch {
    return fallbackMetrics(family, weight);
  }
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    return await run(page);
  } catch {
    return fallbackMetrics(family, weight);
  } finally {
    await browser.close().catch(() => {});
  }
};

/**
 * Calibrate a set of brand fonts and persist each. Intended call site is the
 * brand crawl (where a Chromium is already warm and the brand's faces have just
 * been inlined). Returns the metrics keyed by `metricsKey`.
 */
export const calibrateBrandFonts = async (
  fonts: { family?: string; weight?: number; src?: string }[],
  dir: string = DEFAULT_METRICS_DIR,
): Promise<Record<string, FontMetrics>> => {
  const out: Record<string, FontMetrics> = {};
  for (const f of fonts) {
    if (!f.family) continue;
    const weight = f.weight ?? 400;
    const cached = await loadFontMetrics(f.family, weight, dir);
    if (cached) {
      out[metricsKey(f.family, weight)] = cached;
      continue;
    }
    const m = await calibrateFont({ family: f.family, weight, src: f.src });
    if (isCalibrated(m)) await saveFontMetrics(m, dir).catch(() => "");
    out[metricsKey(f.family, weight)] = m;
  }
  return out;
};
