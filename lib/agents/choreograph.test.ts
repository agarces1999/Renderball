/**
 * Tests for the deterministic choreographer. The load-bearing proof: run the
 * REAL gate functions (assessDeadAir / findUndwelledText / findSlowTextEntrances)
 * on choreographed output and assert they pass — pacing is correct by
 * construction. Plus direct proof that scheduleScene satisfies the dwell
 * inequality (delay + duration + max(1.2, words*0.3) ≤ T) for every field.
 */
import {
  scheduleScene,
  fieldsOf,
  buildSceneCss,
  applyChoreography,
  CHOREO_KEYFRAMES,
  type SceneField,
} from "./choreograph";
import { findUndwelledText, findSlowTextEntrances } from "./quality-gates";
import { assessDeadAir } from "./pipeline";
import { sectionsAreSpliceable } from "./scene-scope";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("choreograph");

// ── scheduleScene: dwell inequality holds by construction ────────────
const fld = (path: string, words: number): SceneField =>
  ({ path, role: path.startsWith("bullets") ? "bullets" : (path as never), words });

check("scheduleScene: every field satisfies delay+duration+readTime ≤ T", () => {
  const T = 6;
  const fields: SceneField[] = fieldsOf({
    eyebrow: "Live now",
    headline: "One number tells you everything today",
    lede: "Your readiness score distills twenty signals into a single clear answer for the day.",
    bullets: ["Resting heart rate", "Heart rate variability", "Body temperature"],
    cta: { primary: "Get yours" },
  });
  const sched = scheduleScene(fields, T, "medium");
  for (const s of sched) {
    const readTime = Math.max(1.2, s.words * 0.3);
    const landsAt = s.delayS + s.durationS;
    assert(landsAt + readTime <= T + 1e-9, `${s.path}: lands ${landsAt}+read ${readTime} > T ${T}`);
    assert(s.durationS <= 1.0, `${s.path}: entrance ${s.durationS}s exceeds slow-text 1.0s`);
    assert(s.delayS >= 0, `${s.path}: negative delay`);
  }
});

check("scheduleScene: reading-order stagger (later roles start no earlier)", () => {
  const fields = fieldsOf({ eyebrow: "A", headline: "B B", lede: "C C C", cta: { primary: "Go" } });
  const sched = scheduleScene(fields, 8, "medium");
  const byPath = Object.fromEntries(sched.map((s) => [s.path, s.delayS]));
  assert(byPath["eyebrow"] <= byPath["headline"], "eyebrow before headline");
  assert(byPath["headline"] <= byPath["lede"], "headline before lede");
});

check("scheduleScene: over-long copy lands at 0 (gate skips it, we don't force impossible)", () => {
  // 40 words → readTime 12s, in a 5s scene: dwell is impossible; land ASAP.
  const words40 = Array.from({ length: 40 }, () => "word").join(" ");
  const sched = scheduleScene(fieldsOf({ lede: words40 }), 5, "medium");
  assert(sched[0].delayS === 0, `over-long copy should land at 0, got ${sched[0].delayS}`);
});

check("buildSceneCss: text rules use `both`, throughline has an infinite loop", () => {
  const sched = scheduleScene(fieldsOf({ headline: "Hello world" }), 6, "medium");
  const css = buildSceneCss(0, sched, "medium");
  assert(/\[data-scene="0"\] \[data-content-path="headline"\] \{ animation: choreoFadeRise/.test(css), "headline rule");
  assert(/both;/.test(css), "text entrance uses both fill-mode");
  assert(/\[data-throughline\][\s\S]*infinite/.test(css), "throughline has an infinite loop");
});

// ── the real proof: choreograph a static composition, run the real gates ──
const STATIC = `import React from "react";
const SECTION_FRAME = { position: "absolute", inset: 0, display: "flex" } as const;
const PALETTE = { ink: "#111", white: "#fff", accent: "#5f4bff" };
const FONT_DISPLAY = "Cabinet Grotesk";
const FONT_BODY = "Geist";
const BRAND_FONTS_CSS = "@font-face{font-family:Geist;src:local(Geist);}";

export const Section0: React.FC<{ script: Script }> = ({ script }) => {
  const c = script.scenes[0].content;
  return (
    <div style={{ ...SECTION_FRAME, background: PALETTE.white, fontFamily: FONT_BODY, color: PALETTE.ink }}>
      <style dangerouslySetInnerHTML={{ __html: BRAND_FONTS_CSS }} />
      <span data-content-path="eyebrow">{c.eyebrow}</span>
      <h1 data-content-path="headline" style={{ fontFamily: FONT_DISPLAY, fontSize: 96, margin: 0 }}>{c.headline}</h1>
      <p data-content-path="lede" style={{ fontSize: 24 }}>{c.lede}</p>
      <div data-throughline="motif" style={{ position: "absolute", left: 1360, top: 540 }} />
    </div>
  );
};

export const Section1: React.FC<{ script: Script }> = ({ script }) => {
  const c = script.scenes[1].content;
  return (
    <div style={{ ...SECTION_FRAME, background: PALETTE.white, fontFamily: FONT_BODY, color: PALETTE.ink }}>
      <style dangerouslySetInnerHTML={{ __html: BRAND_FONTS_CSS }} />
      <h1 data-content-path="headline" style={{ fontSize: 72, margin: 0 }}>{c.headline}</h1>
      <div data-content-path="cta.primary" style={{ padding: 20 }}>{c.cta.primary}</div>
    </div>
  );
};

export const Generated = () => (<><Section0 /><Section1 /></>);
`;

const SCRIPT = {
  config: { aspect_ratio: "16:9", fps: 30 },
  scenes: [
    {
      label: "Hook",
      start_seconds: 0,
      end_seconds: 6,
      content: {
        eyebrow: "Live now",
        headline: "One number tells you everything",
        lede: "Your readiness score distills twenty signals into a single clear answer.",
      },
    },
    {
      label: "Close",
      start_seconds: 6,
      end_seconds: 11,
      content: { headline: "Take control of your recovery", cta: { primary: "Get yours" } },
    },
  ],
} as never;

const animated = applyChoreography(STATIC, SCRIPT, "medium");

check("applyChoreography: injects CHOREO_CSS const + keyframes", () => {
  assert(animated.includes("const CHOREO_CSS = "), "CHOREO_CSS const injected");
  assert(animated.includes("@keyframes choreoFadeRise"), "keyframes present");
  assert(animated.includes("@keyframes choreoAmbient"), "ambient keyframe present");
});

check("applyChoreography: tags each section root + inline ambient + wires <style>", () => {
  assert((animated.match(/data-scene=\{0\}/g) || []).length >= 1, "Section0 root tagged");
  assert(/data-scene=\{1\}/.test(animated), "Section1 root tagged");
  assert((animated.match(/choreoAmbient .*infinite/g) || []).length === 2, "one inline ambient per section");
  assert((animated.match(/CHOREO_CSS \+ BRAND_FONTS_CSS/g) || []).length === 2, "each <style> wired");
});

check("applyChoreography: preserves the splice contract (Section0..1 + Generated)", () => {
  assert(sectionsAreSpliceable(animated, 2), "still contiguous + spliceable after choreography");
});

check("REAL GATE: assessDeadAir passes on the choreographed output", () => {
  const r = assessDeadAir(animated, SCRIPT);
  assert(r.ok, `dead-air should pass by construction: ${r.ok ? "" : r.error}`);
});

check("REAL GATE: findUndwelledText finds nothing on the choreographed output", () => {
  const u = findUndwelledText(animated, SCRIPT);
  assert(u.length === 0, `no undwelled text expected, got ${JSON.stringify(u)}`);
});

check("REAL GATE: findSlowTextEntrances finds nothing (all entrances ≤1.0s)", () => {
  const s = findSlowTextEntrances(animated);
  assert(s.length === 0, `no slow entrances expected, got ${JSON.stringify(s)}`);
});

check("applyChoreography: non-composition input returned unchanged (best-effort)", () => {
  const junk = "export const notASection = 1;";
  assert(applyChoreography(junk, SCRIPT, "medium") === junk, "no sections → unchanged");
});

check("CHOREO_KEYFRAMES: is a non-empty CSS string with the core vocabulary", () => {
  assert(CHOREO_KEYFRAMES.includes("choreoFadeRise") && CHOREO_KEYFRAMES.includes("choreoScaleIn"), "core keyframes");
});

// ── exit choreography (film-not-slides: elements leave before the cut) ──
check("exits: scheduled only when requested, never before reading completes", () => {
  const fields = fieldsOf({
    eyebrow: "Live",
    headline: "One number tells you everything",
    lede: "Your readiness score distills twenty signals into one clear answer.",
  });
  const noExits = scheduleScene(fields, 6, "medium");
  assert(noExits.every((s) => s.exitAtS === null), "no exits unless opted in");
  const withExits = scheduleScene(fields, 6, "medium", { exits: true });
  for (const s of withExits) {
    if (s.exitAtS === null) continue;
    const readDone = s.delayS + s.durationS + Math.max(1.2, s.words * 0.3);
    assert(s.exitAtS >= readDone - 1e-9, `${s.path}: exit ${s.exitAtS} before reading done ${readDone}`);
    assert(s.exitAtS <= 6 + 0.1, `${s.path}: exit ${s.exitAtS} past the overlap window`);
  }
});

check("exits: reverse reading order — headline lingers closest to the cut", () => {
  const sched = scheduleScene(
    fieldsOf({ eyebrow: "A", headline: "Big idea", cta: { primary: "Go" } }),
    8,
    "medium",
    { exits: true },
  );
  const at = Object.fromEntries(sched.map((s) => [s.path, s.exitAtS]));
  assert(at["headline"] != null && at["cta.primary"] != null, "both exit");
  assert(at["headline"]! >= at["cta.primary"]!, "headline exits after (or with) the cta");
});

check("exits: skipped (ride the crossfade) when reading lands too late", () => {
  // 12 words → readTime 3.6s in a 4s scene: reading barely fits; exit would
  // land past the overlap → element keeps its dignity and skips the exit.
  const sched = scheduleScene(
    fieldsOf({ lede: Array.from({ length: 12 }, () => "word").join(" ") }),
    4,
    "medium",
    { exits: true },
  );
  const lede = sched.find((s) => s.path === "lede")!;
  const readDone = lede.delayS + lede.durationS + Math.max(1.2, lede.words * 0.3);
  if (readDone > 4 + 0.1) assert(lede.exitAtS === null, "too-late exit must be skipped");
  else assert(lede.exitAtS !== null && lede.exitAtS >= readDone, "exit after reading");
});

check("applyChoreography: exits are FILM-GATED — never in the base rules", () => {
  const out = applyChoreography(STATIC, SCRIPT, "medium");
  const lines = out.split("\n");
  const base0 = lines.filter((l) => l.trimStart().startsWith('[data-scene="0"] [data-content-path='));
  const film0 = lines.filter((l) => l.includes('[data-rb-film] [data-scene="0"] [data-content-path='));
  const film1 = lines.filter((l) => l.includes('[data-rb-film] [data-scene="1"]'));
  // The P0 the architecture review caught: ungated exits get settled to their
  // END state by measure-scene's animation-delay override → gates measured
  // post-exit (invisible-text) frames, and the editor iframe watched copy
  // vanish. Base rules must NEVER carry an exit.
  assert(base0.every((l) => !l.includes("choreoExitUp")), "base rules exit-free (measurement + editor safe)");
  assert(film0.length > 0 && film0.every((l) => l.includes("choreoExitUp")), "film rules carry the exits");
  assert(
    film0.every((l) => l.includes("both, choreoExitUp")),
    "film rule re-declares the FULL chain (animation overrides wholesale)",
  );
  assert(film1.length === 0, "last scene holds for the CTA — no film exits");
});

check("match cut: throughline enters ONLY in scene 0, breathe-only after", () => {
  const out = applyChoreography(STATIC, SCRIPT, "medium");
  const rules = out.split("\n").filter((l) => l.includes("[data-throughline]"));
  const s0 = rules.find((l) => l.includes('[data-scene="0"]'))!;
  const s1 = rules.find((l) => l.includes('[data-scene="1"]'))!;
  assert(/choreoScaleIn/.test(s0), "scene 0: the motif ENTERS once");
  assert(!/choreoScaleIn/.test(s1) && /choreoBreathe/.test(s1), "scene 1+: visible at t=0, breathe only — survives the cut");
});

// ── the self-closing blank-stub regression (real failure 2026-07-09) ──
// A network-dead fill ships its scaffold stub: `() => <div style={{...}} />`.
// Injecting a <style> SIBLING after that self-closing root makes the arrow
// body two expressions — the whole build died at the hard compile gate with
// "Expected ';' but found 'dangerouslySetInnerHTML'". The choreographer must
// leave stub sections structurally intact.
const STATIC_WITH_STUB = `import React from "react";
const SECTION_FRAME = { position: "absolute", inset: 0 } as const;
const BRAND_FONTS_CSS = "@font-face{font-family:Geist;src:local(Geist);}";

export const Section0: React.FC<{ script: Script }> = ({ script }) => {
  const c = script.scenes[0].content;
  return (
    <div style={{ ...SECTION_FRAME, background: "#fff" }}>
      <style dangerouslySetInnerHTML={{ __html: BRAND_FONTS_CSS }} />
      <h1 data-content-path="headline">{c.headline}</h1>
    </div>
  );
};

export const Section1: React.FC<{ script: Script }> = () => <div style={{ ...SECTION_FRAME }} />;

export const Generated = () => (<><Section0 /><Section1 /></>);
`;

const STUB_SCRIPT = {
  config: { aspect_ratio: "16:9", fps: 30 },
  scenes: [
    { label: "A", start_seconds: 0, end_seconds: 6, content: { headline: "Hello there" } },
    { label: "B", start_seconds: 6, end_seconds: 11, content: { headline: "Unfilled" } },
  ],
} as never;

await check("blank-stub regression: choreographed output with a stub COMPILES", async () => {
  const { verifyCompilable } = await import("./code-extraction");
  const out = applyChoreography(STATIC_WITH_STUB, STUB_SCRIPT, "medium");
  assert(out !== STATIC_WITH_STUB, "choreography applied (real section changed)");
  const err = await verifyCompilable(out);
  assert(err === null, `must compile — got: ${String(err).slice(0, 200)}`);
});

await check("blank-stub regression: stub root stays self-closing, no sibling <style>", () => {
  const out = applyChoreography(STATIC_WITH_STUB, STUB_SCRIPT, "medium");
  const stub = out.slice(out.indexOf("export const Section1"), out.indexOf("export const Generated"));
  assert(!/dangerouslySetInnerHTML/.test(stub), "no <style> injected into the stub");
  assert(/data-scene=\{1\}/.test(stub), "stub root still tagged (inert ambient is fine)");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
