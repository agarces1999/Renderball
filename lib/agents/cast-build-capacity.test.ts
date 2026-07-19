/**
 * P4b integration: capacity budgets on the element-emission path.
 *
 * Run: `node scripts/run-tests.mjs lib/agents/cast-build-capacity.test.ts`
 *
 * Kept in its own file rather than appended to the (already large) cast-build
 * golden so the two suites can be edited independently.
 *
 * What it proves end to end, with no network and no browser:
 *   - every element brief carries the DECLARED type scale and the capacity
 *     budget computed at that scale (a budget the emitter never sees is not a
 *     budget);
 *   - calibration runs ONCE PER BUILD, before the fan-out — not once per
 *     element, which would serialize the parallel burst;
 *   - an uncalibrated face degrades to a FLAGGED estimate and never blocks a
 *     build;
 *   - an element whose owned copy OVERFLOWS its box is rejected and re-emitted
 *     before any render pass, and the repair is counted;
 *   - an overflow that survives the repair budget still ships the REAL copy —
 *     an overflowing headline beats a placeholdered one.
 */
import { castBuild, ownedCopyEntries, type CastBuildInput } from "./cast-build";
import { calibrateBuildFonts } from "../render/calibrate-build-fonts";
import { CALIBRATION_GLYPHS, type FontMetrics, METRICS_VERSION, metricsKey } from "../render/font-metrics";
import type { Script } from "../../src/schema";
import type { Theme } from "../edit/piece-model";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("cast-build × capacity budgets (P4b)");

delete process.env.RB_CAST_MODEL;
delete process.env.RB_CAST_MODEL_HERO;
delete process.env.RB_CAST_MODEL_LEAVES;

// ─── Fixtures ────────────────────────────────────────────────────────────────

const PALETTE = ["#ff7a59", "#213343", "#ffffff", "#0b0e13"];

const theme: Theme = {
  palette: {
    BG: "#0b0e13", ACCENT: "#ff7a59", INK: "#f5f8fa",
    PANEL_BG: "rgba(245,248,250,0.05)", HAIRLINE: "rgba(245,248,250,0.14)",
  },
  fonts: {
    display: '"Display", sans-serif', body: '"Body", sans-serif', mono: '"Mono", monospace',
    fontFaceCss: "",
  },
  keyframes: "@keyframes fadeRise{from{opacity:0}to{opacity:1}}",
  grammar: { radiusScale: [8, 12, 16], strokeWeight: 1, hairline: "HAIRLINE", panelBg: "PANEL_BG", shadowRecipe: "0 30px 80px rgba(0,0,0,0.4)", dataFont: "mono" },
};

/** Long enough that no sane box swallows it at display size. */
const LONG_HEADLINE =
  "Cada marca merece un video que explique su producto con una claridad inmediata y sostenida";

const script = {
  narrative: { logline: "x", arc: "y", throughline: "A glowing crystal ball" },
  config: { aspect_ratio: "16:9" },
  assets: { fonts: [], images: [], audio: [], videos: [] },
  scenes: [
    {
      label: "Hook", register: "split",
      visual_concept: "Composition: copy left, a rising line chart right.",
      content: { headline: LONG_HEADLINE, asset_ids: [] },
      start_seconds: 0, end_seconds: 4,
    },
  ],
  status: "ready",
} as unknown as Script;

const input: CastBuildInput = { script, theme, palette: PALETTE, signatureAccent: "#ff7a59", aspect: "16:9" };

/** Monospace-by-construction metrics — every glyph 0.5em, so line counts are
 *  arithmetic. Marked `chromium` so budgets read as MEASURED. */
const MONO: FontMetrics = {
  family: "Display",
  weight: 700,
  adv: Object.fromEntries(CALIBRATION_GLYPHS.map((g) => [g, 50])),
  kern: {},
  meanAdv: 50,
  fallbackAdv: 50,
  normalLineHeight: 1.2,
  source: "chromium",
  calibratedAt: new Date().toISOString(),
  version: METRICS_VERSION,
  resolution: "asserted",
};

/** A calibrate stub that reports MEASURED metrics for both theme faces, and
 *  counts how many times the whole build invoked it. */
const makeCalibrator = (opts: { calibrated?: boolean } = {}) => {
  const state = { calls: 0 };
  const calibrate = (async () => {
    state.calls++;
    if (opts.calibrated === false) return { metrics: {}, calibrated: 0, estimated: 2 };
    return {
      metrics: {
        [metricsKey("Display", 700)]: MONO,
        [metricsKey("Body", 400)]: { ...MONO, family: "Body", weight: 400 },
      },
      calibrated: 2,
      estimated: 0,
    };
  }) as unknown as typeof calibrateBuildFonts;
  return { calibrate, state };
};

const RICH_HERO = `<div style={{ width: "100%", height: "100%", background: PANEL_BG, borderRadius: 12, padding: 20 }}>
  <div style={{ display: "flex", gap: 8 }}><span>Build console</span><span>rb-2041</span><span>Live</span></div>
  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
    <div style={{ display: "flex", gap: 10 }}><span>choreograph</span><span>41ms</span></div>
    <div style={{ display: "flex", gap: 10 }}><span>hue-lock</span><span>12 rewrites</span></div>
    <div style={{ display: "flex", gap: 10 }}><span>assemble</span><span>ok</span></div>
    <div style={{ display: "flex", gap: 10 }}><span>render</span><span>queued</span></div>
  </div>
  <div style={{ height: 6, width: "62%", background: ACCENT, borderRadius: 3 }} />
</div>`;
const PLAIN = `<div style={{ width: "100%", height: "100%" }} />`;
/** A headline set absurdly large — guaranteed to overflow any authored box. */
const HUGE_COPY = `<div><h1 data-content-path="headline" style={{ fontFamily: FONT_DISPLAY, fontSize: 220, color: INK }}>{c.headline}</h1></div>`;
/** The same copy at a sane size — fits. */
const TIGHT_COPY = `<div><h1 data-content-path="headline" style={{ fontFamily: FONT_DISPLAY, fontSize: 34, lineHeight: 1.1, color: INK }}>{c.headline}</h1></div>`;

const makeFakeCaller = (canned: (id: string, nth: number) => string) => {
  const counts = new Map<string, number>();
  const log: { id: string; user: string }[] = [];
  const caller = async (call: { system: string; user: string; maxTokens: number }) => {
    const id = /piece id "([^"]+)"/.exec(call.user)?.[1] ?? "?";
    const nth = (counts.get(id) ?? 0) + 1;
    counts.set(id, nth);
    log.push({ id, user: call.user });
    return { text: canned(id, nth), thinking: "", inputTokens: 50, outputTokens: 100, seconds: 0.005, stopReason: "stop" };
  };
  return { caller, log };
};

const cleanBodies = (id: string): string =>
  id.endsWith(".hero") ? RICH_HERO : id.endsWith(".copy") ? TIGHT_COPY : PLAIN;

// ─── The budget reaches the emitter ──────────────────────────────────────────

const cal = makeCalibrator();
const clean = makeFakeCaller(cleanBodies);
const result = await castBuild(input, { caller: clean.caller as never, concurrency: 4, calibrate: cal.calibrate });

await check("ONCE PER BUILD: calibration is invoked exactly once, not once per element", () => {
  assert(clean.log.length >= 3, `expected a multi-element build, got ${clean.log.length} calls`);
  assert(cal.state.calls === 1, `expected 1 calibration for ${clean.log.length} element calls, got ${cal.state.calls}`);
});

await check("every element brief declares the TYPE SCALE it must render at", () => {
  for (const entry of clean.log) {
    assert(/TYPE SCALE \(the capacity budget below is computed at THIS size/.test(entry.user), `${entry.id}: no type scale`);
    assert(/headline\/display text \d+px/.test(entry.user), `${entry.id}: no headline size`);
    assert(/CEILING/.test(entry.user), `${entry.id}: the size is not stated as a ceiling`);
  }
});

await check("every element brief carries the CAPACITY budget computed at that scale", () => {
  for (const entry of clean.log) {
    assert(/CAPACITY: This box holds at most \d+ headline characters/.test(entry.user), `${entry.id}: no capacity budget`);
    // The UPPERCASE budget rides along on every budget — our eyebrow/kicker
    // copy is routinely caps, and the mixed-case number is wrong by LINES there.
    assert(/if set in ALL CAPS/.test(entry.user), `${entry.id}: no uppercase budget`);
  }
});

await check("a MEASURED face produces budgets that are not flagged as estimates", () => {
  for (const entry of clean.log) {
    assert(!/ESTIMATE — font not calibrated/.test(entry.user), `${entry.id}: measured metrics must not flag`);
  }
  assert(result.telemetry.budgetsEstimated === 0, `expected 0 estimated budgets, got ${result.telemetry.budgetsEstimated}`);
  assert(result.telemetry.budgetsCalibrated === clean.log.length, `expected every element budgeted from measurements`);
  assert(result.telemetry.fontsCalibrated === 2, `expected 2 calibrated faces, got ${result.telemetry.fontsCalibrated}`);
});

await check("a smaller box gets a smaller declared scale (the downshift reaches the prompt)", () => {
  const sizes = clean.log.map((e) => ({
    id: e.id,
    px: Number(/headline\/display text (\d+)px/.exec(e.user)?.[1]),
    h: Number(/your wrapper is \d+×(\d+)px/.exec(e.user)?.[1]),
  }));
  const copy = sizes.find((s) => s.id.endsWith(".copy"));
  const through = sizes.find((s) => s.id.endsWith(".throughline"));
  assert(!!copy && !!through, "expected both a copy and a throughline element");
  // The throughline motif is a small pinned anchor; the copy column is the
  // frame's editorial stack. Its declared type must be larger.
  assert(copy!.px > through!.px, `copy ${copy!.px}px should exceed throughline ${through!.px}px`);
});

// ─── Uncalibrated degradation ────────────────────────────────────────────────

const uncal = makeCalibrator({ calibrated: false });
const uncalCaller = makeFakeCaller(cleanBodies);
const uncalResult = await castBuild(input, { caller: uncalCaller.caller as never, concurrency: 4, calibrate: uncal.calibrate });

await check("UNCALIBRATED font: the build completes, and every budget self-labels as an ESTIMATE", () => {
  assert(uncalResult.code.length > 0, "an uncalibrated face must never block a build");
  for (const entry of uncalCaller.log) {
    assert(/ESTIMATE — font not calibrated; stay well under/.test(entry.user), `${entry.id}: missing the estimate label`);
  }
  assert(uncalResult.telemetry.budgetsCalibrated === 0, "no budget can claim calibration");
  assert(uncalResult.telemetry.budgetsEstimated === uncalCaller.log.length, "every budget must be flagged");
  assert(uncalResult.telemetry.fontsEstimated === 2, `expected 2 estimated faces, got ${uncalResult.telemetry.fontsEstimated}`);
});

await check("UNCALIBRATED budgets are strictly TIGHTER than calibrated ones (10% vs 4% margin)", () => {
  const budgetOf = (log: { id: string; user: string }[]): number => {
    const copy = log.find((e) => e.id.endsWith(".copy"));
    return Number(/holds at most (\d+) headline characters/.exec(copy?.user ?? "")?.[1] ?? 0);
  };
  const measured = budgetOf(clean.log);
  const estimated = budgetOf(uncalCaller.log);
  assert(measured > 0 && estimated > 0, `budgets should be positive: ${measured} / ${estimated}`);
  assert(estimated < measured, `uncalibrated budget ${estimated} must be tighter than measured ${measured}`);
});

// ─── The overflow → re-emit path ─────────────────────────────────────────────

const repairCal = makeCalibrator();
const repairCaller = makeFakeCaller((id, nth) => {
  if (id.endsWith(".copy")) return nth === 1 ? HUGE_COPY : TIGHT_COPY;
  return cleanBodies(id);
});
const repaired = await castBuild(input, { caller: repairCaller.caller as never, concurrency: 4, calibrate: repairCal.calibrate });

await check("OVERFLOW REJECTED then REPAIRED: the oversized emission is re-emitted before any render pass", () => {
  assert(repaired.telemetry.overflowRejections === 1, `expected 1 rejection, got ${repaired.telemetry.overflowRejections}`);
  assert(repaired.telemetry.overflowRepaired === 1, `expected 1 repair, got ${repaired.telemetry.overflowRepaired}`);
  // The 220px body must NOT be what shipped.
  assert(!repaired.code.includes("fontSize: 220"), "the overflowing emission shipped");
  assert(repaired.code.includes("fontSize: 34"), "the re-emitted, fitting body should have shipped");
});

await check("the repair prompt names the overflow, forbids rewriting the copy, and prescribes smaller type", () => {
  const retry = repairCaller.log.filter((e) => e.id.endsWith(".copy"))[1];
  assert(!!retry, "expected a second call for the copy element");
  assert(/copy OVERFLOWS its wrapper/.test(retry.user), "the repair must state the overflow");
  assert(/must NOT be shortened/.test(retry.user), "the repair must forbid rewriting fixed copy");
  assert(/set the headline at \d+px or less/.test(retry.user), "the repair must prescribe a tighter size");
});

await check("a CLEAN build fires no overflow rejections (the gate is not a tax on every element)", () => {
  assert(result.telemetry.overflowRejections === 0, `clean build rejected ${result.telemetry.overflowRejections}`);
  assert(result.telemetry.overflowRepaired === 0, "clean build should report no repairs");
});

// ─── Never lose the copy ─────────────────────────────────────────────────────

const stuckCal = makeCalibrator();
const stuckCaller = makeFakeCaller((id) => (id.endsWith(".copy") ? HUGE_COPY : cleanBodies(id)));
const stuck = await castBuild(input, { caller: stuckCaller.caller as never, concurrency: 4, calibrate: stuckCal.calibrate });

await check("an overflow that survives the repair budget ships the REAL copy, never a placeholder", () => {
  assert(stuck.telemetry.overflowRejections >= 2, `expected the gate to fire on every attempt, got ${stuck.telemetry.overflowRejections}`);
  // The invariant: an overflowing headline is a design nit; a placeholdered
  // copy column has lost the headline outright.
  assert(stuck.code.includes('data-content-path="headline"'), "the headline must still ship");
  assert(stuck.code.includes("fontSize: 220"), "the real (if tight) emission should ship as the salvage");
});

// ─── The measured set ────────────────────────────────────────────────────────

await check("ownedCopyEntries returns the same fields the brief tells the element to render", () => {
  const entries = ownedCopyEntries(
    { headline: "Ship the story first", lede: "Approve before render.", meta: [{ label: "BUILD", value: "under 10 min" }] } as never,
    ["headline", "lede", "meta"],
  );
  const byPath = new Map(entries.map((e) => [e.path, e.text]));
  assert(byPath.get("headline") === "Ship the story first", `headline: ${byPath.get("headline")}`);
  assert(byPath.get("lede") === "Approve before render.", `lede: ${byPath.get("lede")}`);
  // A meta row measures the tagged VALUE, not its label.
  assert(byPath.get("meta.0.value") === "under 10 min", `meta value: ${byPath.get("meta.0.value")}`);
});

await check("ownedCopyEntries measures nothing an element does not own", () => {
  const entries = ownedCopyEntries({ headline: "Owned", lede: "Not owned" } as never, ["headline"]);
  assert(entries.length === 1 && entries[0].path === "headline", `got ${JSON.stringify(entries)}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
