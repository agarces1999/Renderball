/**
 * Tests for once-per-build font calibration (P4b).
 *
 * Run: `node scripts/run-tests.mjs lib/render/calibrate-build-fonts.test.ts`
 *
 * No network and no browser: the font downloader and the page opener are both
 * injected, which is also how the contract is asserted — we can COUNT how many
 * times a page is opened and how many faces are measured.
 *
 * The invariants under test are the ones a build depends on:
 *  - ONE page for the whole run, never one per face (a per-element or per-face
 *    browser launch would serialize the parallel cast burst);
 *  - cache-first, so a repeat build measures nothing;
 *  - a face whose bytes we cannot supply is NEVER measured — measuring a
 *    Chromium substitute and persisting it as `source:"chromium"` would ship
 *    confident budgets on the tight margin for a face nobody measured;
 *  - every failure path degrades to flagged fallback metrics and NEVER throws.
 */
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import {
  type FontMetrics,
  CALIBRATION_GLYPHS,
  METRICS_VERSION,
  isCalibrated,
  metricsKey,
  saveFontMetrics,
} from "./font-metrics";
import {
  BODY_WEIGHT,
  DISPLAY_WEIGHT,
  calibrateBuildFonts,
  facesToCalibrate,
  isMeasurable,
  primaryFamilyOf,
  resolveMetricsFor,
} from "./calibrate-build-fonts";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`);
  }
};
const assert = (c: boolean, m: string) => {
  if (!c) throw new Error(m);
};

const STACKS = { display: '"Cabinet Grotesk", sans-serif', body: '"Geist", sans-serif' };
const FONTS = [
  { family: "Cabinet Grotesk", weights: [400, 700], src: "https://cdn.brand/cabinet.woff2" },
  { family: "Geist", weights: [400, 600], src: "https://cdn.brand/geist.woff2" },
];

const tmpDir = async (): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), "rb-fontmetrics-"));

/** A page whose in-browser measurement returns a usable advance table, plus a
 *  counter for how many times a page was OPENED. */
const fakePageFactory = () => {
  const state = { opens: 0, closes: 0, measured: [] as string[] };
  const openPage = async () => {
    state.opens++;
    return {
      page: {
        setContent: async (html: string) => {
          state.measured.push(html.includes("@font-face") ? "with-face" : "no-face");
        },
        evaluate: async (_fn: unknown, arg?: unknown) => {
          if (!arg) return undefined;
          const glyphs = (arg as { glyphs?: string[] }).glyphs ?? [];
          return {
            adv: Object.fromEntries(glyphs.map((g) => [g, 50])),
            kern: {},
            normalLineHeight: 1.2,
            // The in-page RESOLUTION ASSERTION verdict. A fake page must state
            // it: `resolved:false` is exactly how a substituted face reports,
            // and calibrateFont then refuses to stamp `source:"chromium"`.
            resolved: true,
          };
        },
      },
      close: async () => {
        state.closes++;
      },
    };
  };
  return { openPage, state };
};

const fakeFetch = async (u: string): Promise<string | null> =>
  `data:font/woff2;base64,${Buffer.from(u).toString("base64")}`;

// ── face selection ──────────────────────────────────────────────────────────

await check("primaryFamilyOf strips quotes and the fallback tail", () => {
  assert(primaryFamilyOf('"Cabinet Grotesk", sans-serif') === "Cabinet Grotesk", "quoted primary");
  assert(primaryFamilyOf("system-ui, sans-serif") === "system-ui", "bare primary");
  assert(primaryFamilyOf("") === "", "empty stack");
});

await check("selects the DISPLAY face at bold and the BODY face at regular, snapped to declared weights", () => {
  const faces = facesToCalibrate(FONTS, STACKS);
  assert(faces.length === 2, `expected 2 faces, got ${faces.length}`);
  const display = faces.find((f) => f.family === "Cabinet Grotesk");
  const body = faces.find((f) => f.family === "Geist");
  assert(display?.weight === DISPLAY_WEIGHT, `display weight ${display?.weight}`);
  // Geist ships 400/600 — 400 is nearest to the body convention.
  assert(body?.weight === BODY_WEIGHT, `body weight ${body?.weight}`);
  assert(display?.src === FONTS[0].src, "the brand src must ride along");
});

await check("a family the brand declares no asset for still selects, at the conventional weight", () => {
  const faces = facesToCalibrate([], STACKS);
  assert(faces.length === 2, `expected 2, got ${faces.length}`);
  assert(faces.every((f) => f.src === undefined), "no asset ⇒ no src");
});

await check("isMeasurable requires actual font bytes (no src ⇒ never measured)", () => {
  assert(isMeasurable({ src: "data:font/woff2;base64,AA" }), "data URL is measurable");
  assert(isMeasurable({ src: "https://cdn/x.woff2" }), "remote URL is measurable pre-inline");
  assert(!isMeasurable({}), "no src is NOT measurable");
  assert(!isMeasurable({ src: "  " }), "blank src is NOT measurable");
});

// ── the once-per-build contract ─────────────────────────────────────────────

await check("ONCE PER BUILD: two faces are measured on ONE shared page, which is then closed", async () => {
  const dir = await tmpDir();
  const { openPage, state } = fakePageFactory();
  const table = await calibrateBuildFonts({ fonts: FONTS, stacks: STACKS, dir, fetchFont: fakeFetch, openPage });
  assert(state.opens === 1, `expected exactly 1 page open, got ${state.opens}`);
  assert(state.closes === 1, `page must be closed, closes=${state.closes}`);
  assert(state.measured.length === 2, `expected 2 measurements, got ${state.measured.length}`);
  assert(state.measured.every((m) => m === "with-face"), "each measurement must inject the real @font-face");
  assert(table.calibrated === 2, `expected 2 calibrated, got ${table.calibrated}`);
  assert(table.estimated === 0, `expected 0 estimated, got ${table.estimated}`);
});

await check("CACHE-FIRST: a face measured by an earlier build opens no page at all", async () => {
  const dir = await tmpDir();
  const cached: FontMetrics = {
    family: "Cabinet Grotesk",
    weight: DISPLAY_WEIGHT,
    adv: Object.fromEntries(CALIBRATION_GLYPHS.map((g) => [g, 48])),
    kern: {},
    meanAdv: 48,
    fallbackAdv: 60,
    normalLineHeight: 1.18,
    source: "chromium",
    calibratedAt: new Date().toISOString(),
    version: METRICS_VERSION,
    resolution: "asserted",
  };
  await saveFontMetrics(cached, dir);
  const { openPage, state } = fakePageFactory();
  const table = await calibrateBuildFonts({
    // One family, one declared weight — so display and body resolve to the
    // SAME (family, weight) key, which the cache already holds.
    fonts: [{ family: "Cabinet Grotesk", weights: [700], src: FONTS[0].src }],
    stacks: { display: STACKS.display, body: STACKS.display },
    dir,
    fetchFont: fakeFetch,
    openPage,
  });
  assert(state.opens === 0, `a fully-cached run must open no page, got ${state.opens}`);
  assert(table.metrics[metricsKey("Cabinet Grotesk", DISPLAY_WEIGHT)]?.meanAdv === 48, "cached metrics not returned");
});

await check("HERMETIC: a build with no font assets measures nothing and launches nothing", async () => {
  const dir = await tmpDir();
  const { openPage, state } = fakePageFactory();
  const table = await calibrateBuildFonts({ fonts: [], stacks: STACKS, dir, fetchFont: fakeFetch, openPage });
  assert(state.opens === 0, `no supplied bytes ⇒ no browser, got ${state.opens} opens`);
  assert(table.calibrated === 0 && table.estimated === 2, `expected 0/2, got ${table.calibrated}/${table.estimated}`);
  assert(
    Object.values(table.metrics).every((m) => m.source === "fallback"),
    "unmeasurable faces must be FLAGGED as fallbacks, never presented as measurements",
  );
});

// ── degradation ─────────────────────────────────────────────────────────────

await check("a dead font URL degrades to a flagged fallback, and never throws", async () => {
  const dir = await tmpDir();
  const { openPage, state } = fakePageFactory();
  const table = await calibrateBuildFonts({
    fonts: FONTS,
    stacks: STACKS,
    dir,
    fetchFont: async () => null, // every download fails
    openPage,
  });
  assert(state.opens === 0, "nothing downloadable ⇒ no browser");
  assert(table.estimated === 2, `expected 2 estimated, got ${table.estimated}`);
});

await check("a page that THROWS mid-run degrades that face and still closes the page", async () => {
  const dir = await tmpDir();
  let closed = 0;
  const table = await calibrateBuildFonts({
    fonts: FONTS,
    stacks: STACKS,
    dir,
    fetchFont: fakeFetch,
    openPage: async () => ({
      page: {
        setContent: async () => {
          throw new Error("navigation crashed");
        },
        evaluate: async () => undefined,
      },
      close: async () => {
        closed++;
      },
    }),
  });
  assert(closed === 1, `page must be closed even on failure, closed=${closed}`);
  assert(table.estimated === 2, `expected both faces flagged, got ${table.estimated}`);
  assert(table.calibrated === 0, "a crashed measurement must never count as calibrated");
});

await check("an openPage that itself rejects does not propagate (a build must not wedge on fonts)", async () => {
  const dir = await tmpDir();
  const table = await calibrateBuildFonts({
    fonts: FONTS,
    stacks: STACKS,
    dir,
    fetchFont: fakeFetch,
    openPage: async () => {
      throw new Error("playwright missing");
    },
  });
  assert(table.metrics !== undefined, "must still return a table");
  assert(table.calibrated === 0, "nothing can be calibrated without a browser");
});

// ── resolution ──────────────────────────────────────────────────────────────

await check("resolveMetricsFor finds the exact key, then any calibrated weight, then flags a fallback", async () => {
  const dir = await tmpDir();
  const { openPage } = fakePageFactory();
  const table = await calibrateBuildFonts({ fonts: FONTS, stacks: STACKS, dir, fetchFont: fakeFetch, openPage });
  const exact = resolveMetricsFor(STACKS.display, table.metrics, DISPLAY_WEIGHT);
  assert(exact.source === "chromium" && exact.family === "Cabinet Grotesk", "exact lookup failed");
  // A weight nobody measured falls back to the same family's measured weight.
  const otherWeight = resolveMetricsFor(STACKS.display, table.metrics, 300);
  assert(otherWeight.source === "chromium", "should reuse the family's measured weight");
  // A family nobody measured is flagged, never silently borrowed from another.
  const unknown = resolveMetricsFor('"Nobody Has This", serif', table.metrics, 400);
  assert(unknown.source === "fallback", "an unknown family must flag");
  assert(unknown.family === "Nobody Has This", `family should be preserved, got ${unknown.family}`);
});

// ── The COUNTER must derive from the assertion, not the label ───────────────
// This is the reason the substitution went unnoticed for a whole phase: the
// telemetry line counted `source === "chromium"` and therefore reported
// "2 face(s) calibrated / 0 estimated" in the exact case where BOTH tables were
// Chromium's substituted default face.

await check("SUBSTITUTED FACE: a page reporting resolved:false yields 0 calibrated / N estimated", async () => {
  const dir = await tmpDir();
  const state = { opens: 0, closes: 0 };
  // Identical to fakePageFactory except the in-page assertion says the
  // requested family never resolved — a full, plausible, WRONG advance table.
  const openPage = async () => {
    state.opens++;
    return {
      page: {
        setContent: async () => {},
        evaluate: async (_fn: unknown, arg?: unknown) => {
          if (!arg) return undefined;
          const glyphs = (arg as { glyphs?: string[] }).glyphs ?? [];
          return {
            adv: Object.fromEntries(glyphs.map((g) => [g, 50])),
            kern: {},
            normalLineHeight: 1.2,
            resolved: false,
          };
        },
      },
      close: async () => {
        state.closes++;
      },
    };
  };
  const table = await calibrateBuildFonts({ fonts: FONTS, stacks: STACKS, dir, fetchFont: fakeFetch, openPage });
  assert(table.calibrated === 0, `expected 0 calibrated, got ${table.calibrated} (the label was trusted again)`);
  assert(table.estimated === 2, `expected 2 estimated, got ${table.estimated}`);
  for (const m of Object.values(table.metrics)) {
    assert(m.source === "fallback", `${m.family}: a substituted face must not be stamped chromium`);
    assert(!isCalibrated(m), `${m.family}: must not count as calibrated`);
  }
  // …and nothing is written to disk, so the next build does not inherit it.
  const written = await fs.readdir(dir).catch(() => [] as string[]);
  assert(written.length === 0, `a substituted face must not be cached, found ${written.join(",")}`);
  assert(state.closes === 1, "the shared page must still be closed");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
