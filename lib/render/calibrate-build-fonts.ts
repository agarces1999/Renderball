/**
 * ONCE-PER-BUILD FONT CALIBRATION.
 *
 * `capacityFor()` is only as honest as the glyph advances behind it, and those
 * come from measuring the REAL brand face in headless Chromium
 * (./font-metrics.ts, Phase A). This module is the single place a build pays
 * that cost: it resolves the brand's faces, measures the ones it has never
 * measured, persists them, and hands back a lookup table.
 *
 * IT RUNS ONCE, BEFORE THE CAST FAN-OUT — NEVER PER ELEMENT.
 * A build fires ~20 element calls in a parallel burst. Calibrating inside that
 * burst would (a) serialize it behind a browser launch and (b) repeat the same
 * measurement ~20 times for the same two faces. So castBuild awaits this once
 * and every element reads the resulting table synchronously, at zero cost.
 *
 * WHY IT FETCHES THE FONT BYTES ITSELF
 * ------------------------------------
 * A brand `@font-face` src is a cross-origin CDN URL, and cross-origin web fonts
 * are CORS-restricted — the exact failure font-inline.ts exists to fix for the
 * render. The same failure applies to the measuring page: an `about:blank`
 * origin cannot load `https://brand.cdn/Display.woff2`, the face silently never
 * loads, and calibrateFont would (correctly, by its own zero-advance guard)
 * return flagged FALLBACK metrics for every brand font we ship. So we reuse
 * font-inline's own Node-side downloader to turn each src into a `data:` URL
 * first — origin-less, never CORS-blocked — and measure the real face.
 *
 * FAILURE POSTURE: NEVER WEDGE A BUILD.
 * Every failure mode — no Playwright, no chromium binary, a dead font URL, a
 * corrupt cache, a page that throws — degrades to `fallbackMetrics`, which is
 * flagged `source:"fallback"` and carries capacity.ts's wider 10% margin. A
 * missing measurement makes budgets conservative; it never makes them absent,
 * and it never throws.
 */
import {
  type FontMetrics,
  type CalibrationPage,
  calibrateFont,
  calibrateBrandFonts,
  fallbackMetrics,
  loadFontMetrics,
  saveFontMetrics,
  metricsKey,
  DEFAULT_METRICS_DIR,
} from "./font-metrics";
import { makeFontFetcher } from "./font-inline";

/** The subset of a script's FontAsset this module needs. */
export interface BrandFace {
  family?: string;
  weights?: number[];
  src?: string;
}

/**
 * Weight conventions. Display/headline type ships bold, body copy ships
 * regular; those are the two weights whose advances actually drive a budget.
 */
export const DISPLAY_WEIGHT = 700;
export const BODY_WEIGHT = 400;

/**
 * Hard ceiling on measurements per build. Each is a real Chromium measurement
 * pass (~1–2s on a shared page). A brand with a dozen declared faces does not
 * get to spend a minute of the build budget proving it — the faces beyond the
 * cap degrade to flagged estimates, which is the designed behavior.
 */
export const MAX_CALIBRATIONS_PER_BUILD = 4;

export interface BuildFontTable {
  /** Keyed by `metricsKey(family, weight)`. */
  metrics: Record<string, FontMetrics>;
  /** Faces whose advances were really measured in Chromium (cache hits count). */
  calibrated: number;
  /** Faces that fell back to synthesized advances. */
  estimated: number;
}

/** Primary family of a CSS stack: '"Cabinet Grotesk", sans-serif' → "Cabinet Grotesk". */
export const primaryFamilyOf = (stack: string): string =>
  (stack.split(",")[0] ?? "").replace(/["'`]/g, "").trim();

/** The weight in `weights` nearest `want` (ties → the heavier). */
const nearestWeight = (weights: number[] | undefined, want: number): number => {
  const ws = (weights ?? []).filter((w) => Number.isFinite(w) && w > 0);
  if (ws.length === 0) return want;
  return ws.reduce((best, w) =>
    Math.abs(w - want) < Math.abs(best - want) || (Math.abs(w - want) === Math.abs(best - want) && w > best)
      ? w
      : best,
  );
};

/**
 * Resolve the metrics for a CSS font stack. Falls back, in order, to: the exact
 * (family, weight) key → any calibrated weight of the same family → flagged
 * fallback metrics. Pure and synchronous — this is what runs per element.
 */
export const resolveMetricsFor = (
  stack: string,
  table: Record<string, FontMetrics>,
  weight: number,
): FontMetrics => {
  const family = primaryFamilyOf(stack);
  if (!family) return fallbackMetrics(stack || "unknown", weight);
  const exact = table[metricsKey(family, weight)];
  if (exact) return exact;
  const prefix = `${metricsKey(family, weight).replace(/-\d+$/, "")}-`;
  for (const [key, m] of Object.entries(table)) {
    if (key.startsWith(prefix) && m.source === "chromium") return m;
  }
  return fallbackMetrics(family, weight);
};

/** The (family, weight, src) set worth measuring for this build. */
export const facesToCalibrate = (
  fonts: BrandFace[],
  stacks: { display: string; body: string },
): { family: string; weight: number; src?: string }[] => {
  const wanted: { family: string; weight: number }[] = [
    { family: primaryFamilyOf(stacks.display), weight: DISPLAY_WEIGHT },
    { family: primaryFamilyOf(stacks.body), weight: BODY_WEIGHT },
  ].filter((f) => f.family.length > 0);

  const byFamily = new Map<string, BrandFace>();
  for (const f of fonts) {
    if (f.family && f.family.trim()) byFamily.set(f.family.trim().toLowerCase(), f);
  }

  const out: { family: string; weight: number; src?: string }[] = [];
  const seen = new Set<string>();
  for (const w of wanted) {
    const asset = byFamily.get(w.family.toLowerCase());
    // Only snap to a declared weight when the brand actually ships one; a
    // family we know nothing about is measured at the conventional weight.
    const weight = asset ? nearestWeight(asset.weights, w.weight) : w.weight;
    const key = metricsKey(w.family, weight);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ family: w.family, weight, src: asset?.src });
  }
  return out.slice(0, MAX_CALIBRATIONS_PER_BUILD);
};

/**
 * Is this face worth putting in front of Chromium?
 *
 * ONLY when we can hand the page the actual font FILE. Measuring a family we
 * cannot supply looks like it works — the page renders *something* and the
 * advances come back non-zero — but that something is whatever system font
 * Chromium substituted, and the result would be persisted as `source:
 * "chromium"`, i.e. as a MEASUREMENT. That is strictly worse than admitting we
 * do not know: it would ship confident budgets, on the tight 4% margin, for a
 * face nobody ever measured. A face with no src degrades to flagged fallback
 * metrics and the wider 10% margin instead — the honest answer.
 *
 * (This is also what keeps the unit suite hermetic: fixtures declare no font
 * assets, so no test build launches a browser.)
 */
export const isMeasurable = (face: { src?: string }): boolean =>
  typeof face.src === "string" && face.src.trim().length > 0;

export interface CalibrateBuildFontsArgs {
  /** `script.assets.fonts` — carries the brand src URLs. */
  fonts: BrandFace[];
  /** The theme's CSS stacks; their PRIMARY families are what elements render. */
  stacks: { display: string; body: string };
  dir?: string;
  /** Injectable for tests (no network). Defaults to font-inline's downloader. */
  fetchFont?: (u: string) => Promise<string | null>;
  /** Injectable for tests — a Playwright-shaped page, or null to skip Chromium. */
  openPage?: () => Promise<{ page: CalibrationPage; close: () => Promise<void> } | null>;
}

/**
 * Open ONE Chromium page for the whole calibration run. `calibrateFont` accepts
 * an existing page precisely so a caller can amortize the launch across faces
 * (the alternative — its own browser per call — is 2–4s each).
 */
const defaultOpenPage = async (): Promise<{ page: CalibrationPage; close: () => Promise<void> } | null> => {
  try {
    const pw = (await import("playwright")) as unknown as {
      chromium?: typeof import("playwright").chromium;
      default?: { chromium?: typeof import("playwright").chromium };
    };
    const chromium = pw.chromium ?? pw.default?.chromium;
    if (!chromium) return null;
    const browser = await chromium.launch({ args: ["--no-sandbox"] });
    try {
      const page = await browser.newPage({
        viewport: { width: 1920, height: 1080 },
        deviceScaleFactor: 1,
      });
      return { page, close: () => browser.close().catch(() => {}) };
    } catch {
      await browser.close().catch(() => {});
      return null;
    }
  } catch {
    return null;
  }
};

/**
 * Calibrate this build's brand faces, once. Cache-first: a face measured by an
 * earlier build is read off disk and never re-measured.
 *
 * Contractually total — it resolves to a usable table for every requested face
 * under every failure mode, and never throws.
 */
export const calibrateBuildFonts = async (
  args: CalibrateBuildFontsArgs,
): Promise<BuildFontTable> => {
  const dir = args.dir ?? DEFAULT_METRICS_DIR;
  const faces = facesToCalibrate(args.fonts ?? [], args.stacks);
  const metrics: Record<string, FontMetrics> = {};
  if (faces.length === 0) return { metrics, calibrated: 0, estimated: 0 };

  // 1. Cache first — zero cost, and the common case after the first build.
  //    A face we cannot supply the bytes for is never measured (see
  //    isMeasurable); it takes flagged fallback metrics straight away.
  const misses: typeof faces = [];
  for (const f of faces) {
    const key = metricsKey(f.family, f.weight);
    const cached = await loadFontMetrics(f.family, f.weight, dir).catch(() => null);
    if (cached) metrics[key] = cached;
    else if (isMeasurable(f)) misses.push(f);
    else metrics[key] = fallbackMetrics(f.family, f.weight);
  }

  if (misses.length > 0) {
    const fetchFont = args.fetchFont ?? makeFontFetcher();
    // 2. Inline each remote src to a data: URL so the face is not CORS-blocked
    //    inside the measuring page (see the module note).
    const inlined = await Promise.all(
      misses.map(async (f) => {
        if (f.src && /^data:/i.test(f.src)) return f;
        const data = f.src ? await fetchFont(f.src).catch(() => null) : null;
        return { ...f, src: data ?? undefined };
      }),
    );
    // A src that would not download (dead CDN URL, network) leaves us unable to
    // supply the face — same reasoning as isMeasurable: record the flagged
    // fallback rather than measure a substitute and call it a measurement.
    const prepared = inlined.filter(isMeasurable);
    for (const f of inlined) {
      if (!isMeasurable(f)) metrics[metricsKey(f.family, f.weight)] = fallbackMetrics(f.family, f.weight);
    }

    const opened =
      prepared.length > 0 ? await (args.openPage ?? defaultOpenPage)().catch(() => null) : null;
    if (opened) {
      try {
        for (const f of prepared) {
          const m = await calibrateFont({
            family: f.family,
            weight: f.weight,
            src: f.src,
            page: opened.page,
          }).catch(() => fallbackMetrics(f.family, f.weight));
          if (m.source === "chromium") await saveFontMetrics(m, dir).catch(() => "");
          metrics[metricsKey(f.family, f.weight)] = m;
        }
      } finally {
        await opened.close().catch(() => {});
      }
    } else {
      // No shared page. In PRODUCTION that means Playwright or the chromium
      // binary is unavailable, so hand the misses to calibrateBrandFonts, which
      // owns exactly the same cache-first + degrade-to-fallback contract on its
      // own browser: the run still succeeds when only the SHARED-page
      // optimization is missing, and still degrades cleanly when Chromium is
      // truly absent.
      //
      // When the caller INJECTED an openPage (tests), that injection is the
      // whole contract — falling through to a real browser behind its back
      // would make a test that says "no browser" quietly launch one.
      const table =
        args.openPage || prepared.length === 0
          ? ({} as Record<string, FontMetrics>)
          : await calibrateBrandFonts(prepared, dir).catch(() => ({}) as Record<string, FontMetrics>);
      for (const f of prepared) {
        const key = metricsKey(f.family, f.weight);
        metrics[key] = table[key] ?? fallbackMetrics(f.family, f.weight);
      }
    }
  }

  const all = Object.values(metrics);
  return {
    metrics,
    calibrated: all.filter((m) => m.source === "chromium").length,
    estimated: all.filter((m) => m.source !== "chromium").length,
  };
};
