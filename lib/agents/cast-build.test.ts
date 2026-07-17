/**
 * Golden test for the cast orchestrator — the element-cast build path.
 * No network: the injected `caller` returns canned bodies keyed by piece id
 * (the brief embeds `piece id "sN.slot"`, the fake regexes it out).
 *
 * What it proves, end to end:
 *   - hue-locking ran (an off-brand teal in a diegetic body is gone from the
 *     final code),
 *   - content-field text flows through the copy element,
 *   - the DETERMINISTIC POST-PASSES ran on shipped bodies: `${keyframe}`
 *     interpolations rewritten, canvas-scale self-positioning rebased,
 *     unowned copy stripped (owner keeps it), filter:invert stripped,
 *   - the SVG CONNECTOR layer is cast for relationship scenes (and exactly
 *     one mid-video scene when no concept names one), briefed as an SVG system,
 *   - enriched briefs: diegetic carries the interior checklist + archetype,
 *     atmosphere carries the menu + per-scene variety, copy stays lean,
 *   - effort routing: diegetic/connector at medium, the rest at low; honest
 *     per-slot caps (hero 6000),
 *   - the ONE-repair path recovers a broken element (telemetry.repairs),
 *   - an element broken through repair ships as a placeholder and the build
 *     still completes + compiles (telemetry.failures),
 *   - telemetry counts are exact, scene structure is deterministic, and the
 *     semaphore actually bounds in-flight calls.
 */
import {
  castBuild,
  rewriteKeyframeInterpolations,
  stripCanvasSelfPositioning,
  stripUnownedCopy,
  stripColorMutationFilters,
  normalizeFontBindings,
  isRejectableUnownedCopy,
  neutralizeInk,
  modelFor,
  effortFor,
  wantsConnector,
  maxTokensFor,
  staticJsxDensity,
  substituteImgAssetIds,
  ensureHeroSurfaceContrast,
  forceHeroSurfaceLift,
  repaintInteriorTextForSurface,
  themeFontFamilyNames,
  stripMaskedValueRuns,
  extractJsxTextSegments,
  isMetaTextSegment,
  stripMetaText,
  unownedCopyValues,
  rejectableUnownedCopyValues,
  unownedBindingFields,
  stripUnownedBindings,
  isUrlLikeValue,
  META_TEXT_REJECT_FRAC,
  HERO_SURFACE_MIN_DELTA_L,
  HERO_SURFACE_MIN_CONTRAST_FRAC,
  PRE_RENDER_HERO_MIN_ELEMENTS,
  PRE_RENDER_HERO_MIN_TEXT,
  HERO_MAX_TOKENS_CEREBRAS,
  HERO_MAX_TOKENS_FIREWORKS,
  type CastBuildInput,
} from "./cast-build";
import { verifyCompilable } from "./code-extraction";
import type { Script } from "../../src/schema";
import type { Theme } from "../edit/piece-model";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("cast-build (element-cast orchestrator)");

// Model-routing env must not leak in from the shell — the golden build below
// asserts the DEFAULT (gpt-oss) model + effort routing.
delete process.env.RB_CAST_MODEL;
delete process.env.RB_CAST_MODEL_HERO;
delete process.env.RB_CAST_MODEL_LEAVES;

// ─── Fixtures ────────────────────────────────────────────────────────────────

// HubSpot-ish brand: orange signature + navy + neutrals (mirrors
// normalize-element.test.ts so the hue-lock expectations line up).
const PALETTE = ["#ff7a59", "#213343", "#ffffff", "#0b0e13"];

// Theme shape mirrors assemble.test.ts's fixture theme.
const theme: Theme = {
  palette: {
    BG: "#0b0e13", ACCENT: "#ff7a59", INK: "#f5f8fa",
    PANEL_BG: "rgba(245,248,250,0.05)", HAIRLINE: "rgba(245,248,250,0.14)",
  },
  fonts: {
    display: '"Display", sans-serif', body: '"Body", sans-serif', mono: '"Mono", monospace',
    fontFaceCss: "@font-face{font-family:'Display';src:url('https://cdn.x/f.woff2');}",
  },
  keyframes: "@keyframes fadeRise{from{opacity:0}to{opacity:1}}",
  grammar: { radiusScale: [8, 12, 16], strokeWeight: 1, hairline: "HAIRLINE", panelBg: "PANEL_BG", shadowRecipe: "0 30px 80px rgba(0,0,0,0.4)", dataFont: "mono" },
};

const LEDE = "Approve the story before the expensive render begins.";
const THROUGHLINE = "A glowing crystal ball that clarifies scene by scene";
const SLUG = "a-glowing-crystal-ball-that-clarifies-scene-by-s"; // slugify(...).slice(0,48)

// Minimal-valid script (the `as never` fixture idiom, see choreograph.test.ts):
// only the fields the cast path reads — register/content/visual_concept per
// scene, narrative.throughline, and start/end seconds for the choreographer.
// Scene 1's concept speaks in relationships ("network of connected …") so the
// connector heuristic fires on it; scenes 0/2 carry no relationship keywords.
const script = {
  narrative: { logline: "x", arc: "y", throughline: THROUGHLINE },
  config: { aspect_ratio: "16:9" },
  assets: { fonts: [], images: [], audio: [], videos: [] },
  scenes: [
    {
      label: "Hook", register: "split",
      visual_concept: "Composition: copy left, a rising line chart right.",
      content: { headline: "Ship the story first", lede: LEDE, illustration: "line-chart", asset_ids: [] },
      start_seconds: 0, end_seconds: 4,
    },
    {
      label: "Proof", register: "stat",
      visual_concept: "Composition: one massive metric with a network of connected support panels.",
      content: { headline: "3x faster", meta: [{ label: "BUILD", value: "under 10 min" }], asset_ids: [] },
      start_seconds: 4, end_seconds: 8,
    },
    {
      label: "Close", register: "quote",
      visual_concept: "Composition: a standalone manifesto line.",
      content: { headline: "Story before render.", asset_ids: [] },
      start_seconds: 8, end_seconds: 12,
    },
  ],
} as unknown as Script;

// Slots per scene (split/stat carry a hero; a text-only quote does not; the
// stat scene's "network of connected" concept earns the connector layer):
//   s0: atmosphere, hero, copy, throughline
//   s1: atmosphere, connector, hero, copy, throughline
//   s2: atmosphere, copy, throughline (no hero)
const NON_CHROME_IDS = [
  "s0.atmosphere", "s0.hero", "s0.copy", "s0.throughline",
  "s1.atmosphere", "s1.connector", "s1.hero", "s1.copy", "s1.throughline",
  "s2.atmosphere", "s2.copy", "s2.throughline",
];

// Canned bodies. #2dd4bf is a saturated teal — genuinely foreign to the
// orange/navy brand, so hue-locking MUST rewrite it. The atmosphere rgba is
// brand-orange-family and must survive untouched (keeps normalizedColors
// exact at 1). The hero also smuggles in the post-pass defect classes: the
// UNOWNED lede as a verbatim text node (copy owns it) and a filter:invert.
// Hero fixtures are RICH (≥15 elements / ≥4 static text values) because the
// v8 pre-render density gate now rejects hollow heroes in-round — a thin
// fixture would placeholder every hero and mask the defects under test.
const HERO_TEAL = `<div style={{ width: "100%", height: "100%", background: PANEL_BG, borderRadius: 16, border: "1px solid", borderColor: HAIRLINE, padding: 24 }}>
  <div style={{ display: "flex", gap: 8 }}>
    <span style={{ color: INK }}>Deals pipeline</span>
    <span style={{ color: INK }}>Q3 review</span>
    <span style={{ color: ACCENT }}>Live</span>
  </div>
  <svg viewBox="0 0 100 60" style={{ width: "100%" }}><path d="M0 50 L30 20 L60 35 L100 5" stroke="#2dd4bf" fill="none" strokeWidth="2" /></svg>
  <div>${LEDE}</div>
  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
    <div style={{ display: "flex", gap: 10 }}><span>Renewal — Borealis</span><span>$12,500</span><span>Won</span></div>
    <div style={{ display: "flex", gap: 10 }}><span>Pilot — Halcyon</span><span>$8,900</span><span>Open</span></div>
    <div style={{ display: "flex", gap: 10 }}><span>Upsell — Meridian</span><span>$21,300</span><span>Won</span></div>
  </div>
  <div style={{ filter: "invert(1)", opacity: 0.6 }} />
</div>`;
const COPY_BODY = `<div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
  <h1 data-content-path="headline" style={{ fontFamily: FONT_DISPLAY, fontSize: 88, margin: 0, color: INK }}>{c.headline}</h1>
  <p data-content-path="lede" style={{ fontFamily: FONT_BODY, fontSize: 28, margin: 0, color: INK }}>${LEDE}</p>
</div>`;
const BROKEN = `<div style={{ background: BG }}`; // unclosed opening tag — cannot parse
const FIXED_ATMOS = `<div style={{ position: "absolute", inset: 0, background: "radial-gradient(circle at 30% 20%, rgba(255,122,89,0.16), transparent 60%)" }} />`;
// s1.hero self-positions its root at CANVAS coordinates (stat hero bounds are
// 780×520 at (1020,280) — left 1020 > w 780 is the canvas-scale tell). The
// post-pass must rebase it to the wrapper origin. Rich interior for the same
// reason as HERO_TEAL (the pre-render density gate).
const SELF_POS_HERO = `<div style={{ position: "absolute", left: 1020, top: 280, width: 780, height: 520, background: PANEL_BG, borderRadius: 12, padding: 20 }}>
  <span style={{ fontFamily: FONT_MONO, fontSize: 13, color: INK }}>Deals pipeline</span>
  <div style={{ display: "flex", gap: 12 }}>
    <div><span>Win rate</span><span>64%</span></div>
    <div><span>Cycle</span><span>9 days</span></div>
    <div><span>Coverage</span><span>3.1x</span></div>
  </div>
  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
    <div style={{ display: "flex", gap: 10 }}><span>Renewal — Borealis</span><span>Won</span></div>
    <div style={{ display: "flex", gap: 10 }}><span>Pilot — Halcyon</span><span>Open</span></div>
    <div style={{ display: "flex", gap: 10 }}><span>Upsell — Meridian</span><span>Won</span></div>
    <div style={{ display: "flex", gap: 10 }}><span>Intro — Southpaw</span><span>New</span></div>
  </div>
</div>`;
// s2.copy interpolates a shared keyframe name as a JS identifier — the
// measured gpt-oss defect (passes esbuild, ReferenceError at render).
const KF_COPY = '<div data-content-path="headline" style={{ fontFamily: FONT_DISPLAY, fontSize: 72, color: INK, animation: `${fadeRise} 0.8s ease both` }}>{c.headline}</div>';
const CONNECTOR_BODY = `<svg viewBox="0 0 1920 1080" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
  <path d="M200 300 C 600 100, 1300 200, 1700 500" stroke={HAIRLINE} strokeDasharray="6 10" fill="none" />
  <circle cx="200" cy="300" r="6" fill={ACCENT} />
  <circle cx="1700" cy="500" r="6" fill={ACCENT} />
</svg>`;
const DEFAULT_BODY = `<div style={{ width: "100%", height: "100%" }} />`;
// The default HERO body for builds that don't test hero-specific defects —
// rich enough to clear the pre-render density gate, no font bindings (so
// root-injection expectations hold), no off-palette colors.
const RICH_HERO_DEFAULT = `<div style={{ width: "100%", height: "100%", background: PANEL_BG, borderRadius: 12, padding: 20 }}>
  <div style={{ display: "flex", gap: 8 }}>
    <span>Build console</span>
    <span>rb-2041</span>
    <span>Live</span>
  </div>
  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
    <div style={{ display: "flex", gap: 10 }}><span>choreograph</span><span>41ms</span></div>
    <div style={{ display: "flex", gap: 10 }}><span>hue-lock</span><span>12 rewrites</span></div>
    <div style={{ display: "flex", gap: 10 }}><span>assemble</span><span>ok</span></div>
    <div style={{ display: "flex", gap: 10 }}><span>render</span><span>queued</span></div>
  </div>
  <div style={{ height: 6, width: "62%", background: ACCENT, borderRadius: 3 }} />
</div>`;

const cannedFor = (id: string, nth: number): string => {
  if (id === "s0.hero") return HERO_TEAL; // proves hue-locking + unowned-copy + filter guards
  if (id === "s0.copy") return COPY_BODY; // proves content text flows (and the OWNER keeps the lede)
  if (id === "s1.hero") return SELF_POS_HERO; // proves the self-positioning rebase
  if (id === "s1.connector") return CONNECTOR_BODY;
  if (id === "s2.copy") return KF_COPY; // proves the ${keyframe} rewrite
  if (id === "s1.atmosphere") return nth === 1 ? BROKEN : FIXED_ATMOS; // proves repair
  if (id === "s2.throughline") return BROKEN; // stays broken — proves placeholder
  return DEFAULT_BODY;
};

/** Fake caster: canned bodies + in-flight tracking + a captured call log
 *  (user prompt, routed effort + model, and the per-slot maxTokens cap). The
 *  canned map is injectable so other builds can carry their own bodies. */
const makeFakeCaller = (canned: (id: string, nth: number) => string = cannedFor) => {
  const callCounts = new Map<string, number>();
  const log: { id: string; user: string; effort?: string; model?: string; maxTokens: number }[] = [];
  const state = { inFlight: 0, maxInFlight: 0, calls: 0 };
  const caller = async (call: { system: string; user: string; maxTokens: number; effort?: string; model?: string }) => {
    state.inFlight++;
    state.calls++;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    try {
      await new Promise((r) => setTimeout(r, 5)); // force real overlap
      const id = /piece id "([^"]+)"/.exec(call.user)?.[1] ?? "?";
      const nth = (callCounts.get(id) ?? 0) + 1;
      callCounts.set(id, nth);
      log.push({ id, user: call.user, effort: call.effort, model: call.model, maxTokens: call.maxTokens });
      return { text: canned(id, nth), thinking: "", inputTokens: 50, outputTokens: 100, seconds: 0.005, stopReason: "stop" };
    } finally {
      state.inFlight--;
    }
  };
  return { caller, state, log };
};

// ─── One build, many assertions ──────────────────────────────────────────────

const fake = makeFakeCaller();
const input: CastBuildInput = { script, theme, palette: PALETTE, signatureAccent: "#ff7a59", aspect: "16:9" };
const result = await castBuild(input, { caller: fake.caller as never, concurrency: 4 });

await check("the final composition COMPILES (verifyCompilable, independent re-check)", async () => {
  const err = await verifyCompilable(result.code);
  assert(err === null, `should compile but: ${err}`);
});

await check("every non-chrome piece id appears as data-piece; chrome earns no wrapper", () => {
  for (const id of NON_CHROME_IDS) {
    assert(result.code.includes(`data-piece="${id}"`), `${id} wrapper missing`);
  }
  assert(!result.code.includes('data-piece="s0.chrome"'), "chrome must not be wrapped (Section emits <Chrome/> itself)");
});

await check("hue-locking ran: the off-brand teal is GONE from the final code", () => {
  assert(!/2dd4bf/i.test(result.code), "foreign teal must be rewritten");
  assert(result.code.includes('data-piece="s0.hero"'), "hero body still shipped");
  assert(/rgba\(255,122,89,0\.16\)/.test(result.code), "brand-family rgba survives untouched");
});

await check("copy element carries the content-field text (headline binding + verbatim lede)", () => {
  assert(result.code.includes(`data-content-path="headline"`), "headline tagged");
  assert(result.code.includes("{c.headline}"), "headline binds via c (text edits stay LLM-free)");
  assert(result.code.includes(LEDE), "lede value present verbatim");
});

await check("unowned-copy guard: hero's stolen lede stripped, the owning copy element keeps it", () => {
  const hits = result.code.split(LEDE).length - 1;
  assert(hits === 1, `lede must appear exactly once (the owner's copy element), got ${hits}`);
  assert(result.code.includes('data-piece="s0.hero"'), "hero still shipped — deterministic strip, no repair burned");
});

await check("keyframe-interpolation rewrite: ${fadeRise} becomes the literal CSS name", () => {
  assert(!result.code.includes("${fadeRise}"), "JS interpolation of a keyframe name must not ship (ReferenceError at render)");
  assert(result.code.includes("fadeRise 0.8s ease both"), "the literal keyframe name shipped in its place");
});

await check("self-positioning strip: canvas-scale left/top rebased to the wrapper origin", () => {
  assert((result.code.match(/left: 1020/g) ?? []).length === 1, "the canvas coordinate appears only on the assembler's wrapper");
  assert(result.code.includes("left: 0, top: 0, width: 780"), "body root rebased to fill its wrapper");
});

await check("paint-time color-mutation guard: filter invert stripped from the shipped body", () => {
  assert(!result.code.includes("invert("), "invert() filter must not ship (flips brand colors invisibly to the hue-lock)");
  assert(result.code.includes("opacity: 0.6"), "the rest of the style object survives");
});

await check("connector layer: cast for the network/connected scene, briefed as an SVG system", () => {
  assert(result.code.includes('data-piece="s1.connector"'), "connector wrapper shipped");
  const piece = result.scenes[1].pieces.find((p) => p.id === "s1.connector");
  assert(!!piece && piece.kind === "atmosphere", "assembler-positioned full-bleed like atmosphere (no layout-composer changes)");
  assert(piece!.bounds.z === 0, "same numeric z as the base layer — later paint order puts it above atmosphere, below z≥1 content");
  assert(result.scenes[1].pieces[1].id === "s1.connector", "sits directly after the base atmosphere layer");
  const brief = fake.log.find((l) => l.id === "s1.connector")!.user;
  assert(brief.includes("inline SVG"), "brief demands an inline SVG system");
  assert(brief.includes("strokeDasharray"), "brief demands dashed connector paths");
  assert(brief.includes("at least 12 SVG primitives"), "brief demands ≥12 primitives");
  assert(!result.code.includes('data-piece="s0.connector"') && !result.code.includes('data-piece="s2.connector"'),
    "non-relationship scenes earn no connector (heuristic, not blanket)");
});

await check("connector fallback: no relationship concepts → exactly ONE mid-video scene gets it", async () => {
  const noKw = JSON.parse(JSON.stringify(script)) as Script;
  (noKw.scenes[1] as { visual_concept: string }).visual_concept = "Composition: one massive metric with a support panel.";
  const f2 = makeFakeCaller();
  const r2 = await castBuild({ ...input, script: noKw }, { caller: f2.caller as never, concurrency: 4 });
  const withConn = r2.scenes.filter((s) => s.pieces.some((p) => p.id.endsWith(".connector")));
  assert(withConn.length === 1, `exactly one connector scene expected, got ${withConn.length}`);
  assert(withConn[0].scene === 1, `the mid scene (1 of 3) should carry it, got scene ${withConn[0].scene}`);
});

await check("diegetic briefs carry the ported taste stack (interior checklist + archetype)", () => {
  const heroBrief = fake.log.find((l) => l.id === "s0.hero")!.user;
  assert(heroBrief.includes("at least 15 labeled interior elements"), "interior-density floor");
  assert(heroBrief.includes("at least 4 concrete text values"), "concrete-values floor");
  assert(heroBrief.includes("NO PLACEHOLDER DATA"), "no-placeholder contract");
  assert(heroBrief.includes('Register "split"'), "register→archetype guidance");
  const copyBrief = fake.log.find((l) => l.id === "s0.copy")!.user;
  assert(!copyBrief.includes("NO PLACEHOLDER DATA") && !copyBrief.includes("interior elements"), "copy briefs stay lean");
});

await check("atmosphere briefs: menu + per-scene variety directive (adjacent scenes differ)", () => {
  const a0 = fake.log.find((l) => l.id === "s0.atmosphere")!.user;
  const a1 = fake.log.find((l) => l.id === "s1.atmosphere")!.user;
  assert(a0.includes("orbital rings"), "the atmosphere MENU is in the brief");
  assert(a0.includes("must NOT reuse the same combination"), "variety directive present");
  const lean = (s: string) => /leans toward: ([^\n]+)/.exec(s)?.[1];
  assert(!!lean(a0) && !!lean(a1), "both scenes carry a lean");
  assert(lean(a0) !== lean(a1), "adjacent scenes steered toward DIFFERENT combinations");
});

await check("effort routing + honest caps: diegetic/connector think at medium, the rest emit at low", () => {
  const call = (id: string) => fake.log.find((l) => l.id === id)!;
  assert(call("s0.hero").effort === "medium", "hero (diegetic) → medium");
  assert(call("s1.connector").effort === "medium", "connector → medium");
  assert(call("s0.copy").effort === "low", "copy → low");
  assert(call("s0.atmosphere").effort === "low", "atmosphere → low");
  assert(call("s0.throughline").effort === "low", "throughline → low");
  assert(fake.log.every((l) => l.effort !== "high"), "effort high is HARMFUL (measured) — never routed");
  assert(call("s0.hero").maxTokens === 6000, "diegetic cap raised to 6000 (measured ~5.7k E-condition mocks)");
  assert(call("s1.connector").maxTokens === 3000, "connector cap 3000");
});

await check("repair path: broken-then-fixed element recovered, prompt carried the failure", () => {
  assert(result.code.includes("radial-gradient(circle at 30% 20%"), "the REPAIRED atmosphere body shipped");
  const repairCall = fake.log.filter((l) => l.id === "s1.atmosphere")[1];
  assert(!!repairCall, "a second (repair) call was made for s1.atmosphere");
  assert(repairCall.user.includes("Emit corrected JSX only"), "repair prompt asks for corrected JSX only");
  assert(/never narrate your reasoning/.test(repairCall.user), "repair prompt bans narrated reasoning (v11 meta-text leak class)");
  assert(repairCall.user.includes("--- previous attempt ---"), "repair prompt quotes the broken output");
});

await check("placeholder fallback: element broken through repair ships degraded, not dead", () => {
  assert(result.code.includes('data-piece="s2.throughline"'), "placeholder wrapper present");
  // The wrapper (not the body) carries the throughline tag — presence survives
  // even a failed body, so the motif thread never silently drops a scene.
  assert((result.code.match(new RegExp(`data-throughline="${SLUG}"`, "g")) ?? []).length === 3, "motif tagged in all 3 scenes");
});

await check("telemetry counts are exact", () => {
  const t = result.telemetry;
  assert(t.elements === 12, `12 element calls expected (incl. s1.connector), got ${t.elements}`);
  assert(t.repairs === 1, `1 recovered repair expected, got ${t.repairs}`);
  assert(t.failures === 1, `1 placeholder failure expected, got ${t.failures}`);
  // 12 first attempts + 2 repair calls (s1.atmosphere + s2.throughline) @100 out.
  assert(fake.state.calls === 14, `14 calls expected, got ${fake.state.calls}`);
  assert(t.tokensOut === 1400, `tokensOut 14×100=1400 expected, got ${t.tokensOut}`);
  assert(t.normalizedColors === 1, `exactly the one teal rewrite expected, got ${t.normalizedColors}`);
  assert(t.wallSeconds > 0, "wall clock measured");
});

await check("deterministic scene structure: manifests match the composer's contract", () => {
  assert(result.scenes.length === 3, "3 manifests");
  const ids = (i: number) => result.scenes[i].pieces.map((p) => p.id).join(",");
  assert(ids(0) === "s0.atmosphere,s0.hero,s0.copy,s0.throughline,s0.chrome", `s0 slots: ${ids(0)}`);
  assert(ids(1) === "s1.atmosphere,s1.connector,s1.hero,s1.copy,s1.throughline,s1.chrome", `s1 slots: ${ids(1)}`);
  assert(ids(2) === "s2.atmosphere,s2.copy,s2.throughline,s2.chrome", `text-only quote has no hero: ${ids(2)}`);
  const tl = result.scenes[0].pieces.find((p) => p.id === "s0.throughline")!;
  assert(tl.throughlineSlug === SLUG, `slug ${tl.throughlineSlug} must match pipeline slugify convention`);
  assert(result.scenes.every((s) => s.background === "BG"), "canvas role resolved to the BG theme const");
});

await check("choreographer ran as a compile step (CHOREO_CSS + tagged section roots)", () => {
  assert(result.code.includes("const CHOREO_CSS = "), "CHOREO_CSS const injected");
  assert(result.code.includes("data-scene={0}"), "Section0 root tagged");
  assert(result.code.includes("CHOREO_CSS + BRAND_FONTS_CSS + SHARED_KEYFRAMES"), "section <style> wired");
});

await check("semaphore respected: max in-flight equals the configured width", () => {
  assert(fake.state.maxInFlight <= 4, `in-flight peaked at ${fake.state.maxInFlight} > 4`);
  assert(fake.state.maxInFlight >= 2, "calls actually ran in parallel");
});

await check("briefs are element-scoped: values + mapped palette roles, nothing cross-element", () => {
  const copyBrief = fake.log.find((l) => l.id === "s0.copy")!.user;
  assert(copyBrief.includes('"Ship the story first"'), "copy brief carries the headline VALUE");
  assert(copyBrief.includes('data-content-path="lede"'), "copy brief names the choreograph path");
  const heroBrief = fake.log.find((l) => l.id === "s0.hero")!.user;
  assert(heroBrief.includes("panelBg → PANEL_BG"), "hero brief maps palette roles to theme const names");
  assert(heroBrief.includes('"line-chart"'), "hero brief carries the illustration intent");
  assert(!heroBrief.includes("Ship the story first"), "hero brief does NOT leak the copy element's text");
  const tlBrief = fake.log.find((l) => l.id === "s0.throughline")!.user;
  assert(tlBrief.includes(THROUGHLINE), "throughline brief carries the motif description");
});

await check("determinism: a second build yields byte-identical manifests", async () => {
  const again = makeFakeCaller();
  const r2 = await castBuild(input, { caller: again.caller as never, concurrency: 4 });
  assert(JSON.stringify(r2.scenes) === JSON.stringify(result.scenes), "SceneManifests must be deterministic");
});

// ─── Composed scenes: the head's blueprint drives the cast ───────────────────
// A second golden build where scenes carry SceneComposition blueprints
// (composition-head.ts output). Proves: briefs LEAD with the blueprint
// (inventory verbatim, generic checklist/archetype/menu OUT), spec ownsCopy
// redistributes copy ownership (brief lines + the unowned-copy guard), and
// connector casting obeys the SPEC, not the keyword heuristic — in both
// directions. The first golden build above is the un-composed fallback path,
// unchanged.

console.log("\ncast-build composed scenes (blueprint consumption)");

const COMPOSED_LEDE = "Approve the narrative before the render.";
const HERO_SUBJECT = "the Renderball build console in a browser frame";
const HERO_INVENTORY = [
  'URL bar "app.renderball.com/builds/rb-2041"',
  'status chip "Rendering — scene 5 of 8"',
  "progress bar at 62%",
  'log line "choreograph: 0 tokens, 41ms"',
  'KPI tile "Build 9:12"',
  'KPI tile "Cost $1.62"',
];
const S0_ATMOS = "deep navy radial wash with slow drifting film grain";
const S1_ATMOS = "cool charcoal field crossed by parallax bands drifting at different speeds";

// Scene 0's concept SPEAKS in relationships ("network of connected") but its
// composition casts NO connector — the spec must override the heuristic OFF.
// Scene 1's concept has no relationship keywords but its composition CASTS a
// connector — the spec must override the heuristic ON.
const composedScript = {
  narrative: { logline: "x", arc: "y", throughline: THROUGHLINE },
  config: { aspect_ratio: "16:9" },
  assets: { fonts: [], images: [], audio: [], videos: [] },
  scenes: [
    {
      label: "Hook", register: "split",
      visual_concept: "Composition: copy left, a network of connected build panels right.",
      content: {
        headline: "Every build tells a story", lede: COMPOSED_LEDE,
        bullets: ["Approve the arc first", "Render once"], asset_ids: [],
      },
      start_seconds: 0, end_seconds: 4,
      composition: {
        elements: [
          {
            role: "hero", subject: HERO_SUBJECT, interior: HERO_INVENTORY,
            // The head moved the BULLETS into the hero (diegetic checklist).
            ownsCopy: ["bullets"],
            motion: "the progress bar fills from 62% as the status chip ticks to scene 6",
          },
          { role: "copy", subject: "the editorial stack", interior: ["headline in display type", "lede beneath"], ownsCopy: ["headline", "lede"], motion: "the headline rises as one block" },
          { role: "atmosphere", subject: "deep navy wash", interior: ["radial glow upper-left", "film grain"], ownsCopy: [], motion: "the glow pulses on a 4s loop" },
        ],
        atmosphere: S0_ATMOS,
      },
    },
    {
      label: "Proof", register: "stat",
      visual_concept: "Composition: one massive metric with a support column.",
      content: { headline: "3x faster", meta: [{ label: "BUILD", value: "under 10 min" }], asset_ids: [] },
      start_seconds: 4, end_seconds: 8,
      composition: {
        elements: [
          {
            role: "hero", subject: "a KPI support column beside the metric",
            interior: ['delta chip "+212% vs agency"', 'baseline rule "agency: 6 weeks"', "radial gauge at 91%", 'sparkline over "last 30 builds"', 'tile "9:12 avg build"', 'tile "$1.62 avg cost"'],
            ownsCopy: [], motion: "the radial gauge sweeps to 91%",
          },
          { role: "copy", subject: "the massive metric stack", interior: ["one display-type metric", "meta row beneath"], ownsCopy: ["headline", "meta"], motion: "the metric counts up" },
          { role: "connector", subject: "a dashed convergence system feeding the metric", interior: ["five dashed paths meeting at a hub right of center"], ownsCopy: [], motion: "dashes crawl along the paths" },
          { role: "atmosphere", subject: "charcoal band field", interior: ["parallax bands", "vignette"], ownsCopy: [], motion: "bands drift at different speeds" },
        ],
        atmosphere: S1_ATMOS,
      },
    },
  ],
} as unknown as Script;

// s0.copy STEALS bullets[0] as an exact text node — under the SPEC, bullets
// belong to the hero, so the guard must strip it from the copy element even
// though the copy SLOT structurally owns bullets in the un-composed world.
const COMPOSED_COPY_S0 = `<div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
  <h1 data-content-path="headline" style={{ fontFamily: FONT_DISPLAY, fontSize: 88, margin: 0, color: INK }}>{c.headline}</h1>
  <p data-content-path="lede" style={{ fontFamily: FONT_BODY, fontSize: 28, margin: 0, color: INK }}>{c.lede}</p>
  <div>Approve the arc first</div>
</div>`;
const composedCanned = (id: string): string =>
  id === "s0.copy" ? COMPOSED_COPY_S0 : id.endsWith(".hero") ? RICH_HERO_DEFAULT : DEFAULT_BODY;

const cfake = makeFakeCaller(composedCanned);
const cresult = await castBuild(
  { script: composedScript, theme, palette: PALETTE, signatureAccent: "#ff7a59", aspect: "16:9" },
  { caller: cfake.caller as never, concurrency: 4 },
);
const cbrief = (id: string) => cfake.log.find((l) => l.id === id)!.user;

await check("composed build compiles; connector cast from SPEC, not heuristic (both directions)", async () => {
  const err = await verifyCompilable(cresult.code);
  assert(err === null, `should compile but: ${err}`);
  // Heuristic would say YES for s0 ("network of connected") — spec says no.
  assert(wantsConnector(composedScript.scenes[0].visual_concept), "sanity: the heuristic WOULD fire on s0");
  assert(!cresult.scenes[0].pieces.some((p) => p.id === "s0.connector"), "s0 composition casts no connector — spec overrides the keyword heuristic");
  // Heuristic would say NO for s1 — spec says yes.
  assert(!wantsConnector(composedScript.scenes[1].visual_concept), "sanity: the heuristic would NOT fire on s1");
  assert(cresult.scenes[1].pieces.some((p) => p.id === "s1.connector"), "s1 composition casts the connector — produced from spec");
  assert(cresult.scenes[1].pieces[1].id === "s1.connector", "connector still sits directly after the base atmosphere layer");
});

await check("hero brief LEADS with the blueprint: subject + inventory VERBATIM + motion; generic stack OUT", () => {
  const brief = cbrief("s0.hero");
  assert(brief.includes(`This element IS: ${HERO_SUBJECT}`), "subject line leads");
  assert(brief.includes("TRANSCRIBE this interior inventory — every item below must be visibly present, verbatim values:"), "transcription instruction");
  for (const item of HERO_INVENTORY) assert(brief.includes(`- ${item}`), `inventory item verbatim: ${item}`);
  assert(brief.includes("the progress bar fills from 62%"), "motion beat carried");
  assert(brief.indexOf("This element IS:") < brief.indexOf("Emit ONLY the JSX"), "blueprint precedes the emit instruction");
  // The generic taste stack is the FALLBACK — it must NOT dilute a composed brief.
  assert(!brief.includes("at least 15 labeled interior elements"), "generic interior checklist absent");
  assert(!brief.includes('Register "split"'), "register archetype absent");
  assert(!brief.includes("No visual fields given"), "invent-the-visual line absent");
});

await check("spec ownsCopy drives the briefs: bullets moved to the hero, copy keeps headline+lede", () => {
  const hero = cbrief("s0.hero");
  assert(hero.includes("COPY THIS ELEMENT OWNS"), "hero carries owned-copy instructions");
  assert(hero.includes(`bullets.0: "Approve the arc first" (data-content-path="bullets.0")`), "hero brief carries the bullet VALUE + choreograph path");
  const copy = cbrief("s0.copy");
  assert(copy.includes('"Every build tells a story"') && copy.includes(JSON.stringify(COMPOSED_LEDE)), "copy brief keeps its owned values");
  assert(!copy.includes("bullets.0"), "copy brief no longer carries bullets (the spec moved them)");
  assert(copy.includes("render EXACTLY the owned fields in the blueprint above"), "copy brief points at the blueprint");
  // A spec that owns NOTHING says so explicitly (s1.hero).
  assert(cbrief("s1.hero").includes("This element owns NO scene copy"), "owns-nothing is stated, not implied");
});

await check("unowned-copy guard strengthened by the spec: copy's stolen bullet stripped, no repair burned", () => {
  // In the un-composed world the copy SLOT owns bullets and the theft would be
  // legal. Under the spec, bullets are the hero's — the guard must strip it.
  assert(!cresult.code.includes("Approve the arc first"), "the stolen bullet text is GONE from the final code");
  assert(cresult.code.includes('data-piece="s0.copy"') && cresult.code.includes("{c.lede}"), "copy element still shipped with its owned bindings");
  assert(cresult.telemetry.repairs === 0 && cresult.telemetry.failures === 0, "deterministic strip — no repair, no placeholder");
  assert(cresult.telemetry.elements === 9, `9 elements expected (s0: 4 + s1: 5), got ${cresult.telemetry.elements}`);
});

await check("atmosphere briefs carry the AUTHORED treatment; the rotating menu is fallback-only", () => {
  const a0 = cbrief("s0.atmosphere");
  const a1 = cbrief("s1.atmosphere");
  assert(a0.includes(`ATMOSPHERE TREATMENT (authored for THIS scene — adjacent scenes carry different treatments): ${S0_ATMOS}`), "s0 authored treatment");
  assert(a1.includes(S1_ATMOS), "s1 authored treatment (differs by authorship, not rotation)");
  assert(!a0.includes("leans toward") && !a0.includes("ATMOSPHERE MENU"), "menu + variety rotation absent on composed scenes");
  assert(a0.includes("infinite-loop animations"), "the never-freeze demand survives in both modes");
});

await check("connector + throughline briefs under composition: blueprint topology, contract lines intact", () => {
  const conn = cbrief("s1.connector");
  assert(conn.includes("This element IS: a dashed convergence system feeding the metric"), "connector blueprint leads");
  assert(conn.includes("Derive the topology FROM the blueprint above"), "topology from the blueprint, not the concept");
  assert(conn.includes("at least 12 SVG primitives") && conn.includes("strokeDasharray"), "the SVG system contract survives");
  // No throughline spec authored → the un-spec'd element keeps its contract brief.
  const tl = cbrief("s0.throughline");
  assert(tl.includes(THROUGHLINE) && !tl.includes("This element IS:"), "un-spec'd element inside a composed scene falls back cleanly");
});

await check("fully-composed script with no connector specs: the mid-scene fallback is suppressed", async () => {
  const noConn = JSON.parse(JSON.stringify(composedScript)) as Script;
  noConn.scenes[1].composition!.elements = noConn.scenes[1].composition!.elements.filter((e) => e.role !== "connector");
  const f = makeFakeCaller(composedCanned);
  const r = await castBuild(
    { script: noConn, theme, palette: PALETTE, aspect: "16:9" },
    { caller: f.caller as never, concurrency: 4 },
  );
  assert(r.scenes.every((s) => !s.pieces.some((p) => p.id.endsWith(".connector"))), "the head cast no connector anywhere — that IS the decision");
});

// ─── Mixed casting: model routing + model-aware effort + fonts + ink ─────────
// Acceptance v3's deterministic fixes: hero/connector and leaf workloads route
// to different models (each with its own effort dial semantics), foreign font
// bindings are rewritten to theme faces, and a chromatic ink is neutralized on
// entry (v2's DS emitted ink=#57cc02 — every element painted copy green by
// contract).

console.log("\ncast-build mixed casting (model + effort routing, font binding, ink guard)");

await check("modelFor: hero/connector → RB_CAST_MODEL_HERO, leaves → RB_CAST_MODEL_LEAVES, unset → undefined", () => {
  assert(modelFor("hero") === undefined && modelFor("copy") === undefined, "unset env → provider default (undefined)");
  process.env.RB_CAST_MODEL_HERO = "zai-glm-4.7";
  process.env.RB_CAST_MODEL_LEAVES = "gemma-4-31b";
  try {
    assert(modelFor("hero") === "zai-glm-4.7", "hero → HERO model");
    assert(modelFor("connector") === "zai-glm-4.7", "connector → HERO model (it draws)");
    for (const k of ["copy", "atmosphere", "throughline"]) {
      assert(modelFor(k) === "gemma-4-31b", `${k} → LEAVES model`);
    }
  } finally {
    delete process.env.RB_CAST_MODEL_HERO;
    delete process.env.RB_CAST_MODEL_LEAVES;
  }
});

await check("effortFor is model-aware: zai-glm-* → \"none\", gemma-* → omitted, gpt-oss keeps medium/low", () => {
  assert(effortFor("hero", "zai-glm-4.7") === "none", "GLM hero → the off switch");
  assert(effortFor("copy", "zai-glm-4.7") === "none", "GLM copy → the off switch (no graded dial on GLM)");
  assert(effortFor("hero", "gemma-4-31b") === undefined, "gemma hero → param OMITTED (no reasoning dial)");
  assert(effortFor("copy", "gemma-4-31b") === undefined, "gemma copy → param OMITTED");
  assert(effortFor("hero", "gpt-oss-120b") === "medium", "gpt-oss hero keeps medium");
  assert(effortFor("connector", "gpt-oss-120b") === "medium", "gpt-oss connector keeps medium");
  assert(effortFor("copy", "gpt-oss-120b") === "low", "gpt-oss copy keeps low");
  assert(effortFor("hero") === "medium", "no per-call model, no env → the gpt-oss default routing");
  process.env.RB_CAST_MODEL = "zai-glm-4.7";
  try {
    assert(effortFor("hero") === "none", "RB_CAST_MODEL drives effort when there is no per-call model");
  } finally {
    delete process.env.RB_CAST_MODEL;
  }
});

// One mixed build: s0.copy emits FOREIGN serif bindings (must be rewritten to
// theme faces); everything else emits the bare default (copy/hero pieces earn
// a root injection). Both env models set → every call carries an explicit
// model + its model-correct effort.
const SERIF_COPY = `<div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
  <h1 data-content-path="headline" style={{ fontFamily: "Georgia, serif", fontSize: 88, margin: 0, color: INK }}>{c.headline}</h1>
  <p data-content-path="lede" style={{ fontFamily: "Georgia, serif", fontSize: 28, margin: 0, color: INK }}>${LEDE}</p>
</div>`;
const mixedCanned = (id: string): string =>
  id === "s0.copy" ? SERIF_COPY : id.endsWith(".hero") ? RICH_HERO_DEFAULT : DEFAULT_BODY;

process.env.RB_CAST_MODEL_HERO = "zai-glm-4.7";
process.env.RB_CAST_MODEL_LEAVES = "gemma-4-31b";
const mfake = makeFakeCaller(mixedCanned);
let mresult: Awaited<ReturnType<typeof castBuild>>;
try {
  mresult = await castBuild(input, { caller: mfake.caller as never, concurrency: 4 });
} finally {
  delete process.env.RB_CAST_MODEL_HERO;
  delete process.env.RB_CAST_MODEL_LEAVES;
}

await check("caller-arg capture: hero/connector carry the HERO model + effort \"none\"; leaves carry the LEAVES model + effort omitted", () => {
  const drawIds = new Set(["s0.hero", "s1.hero", "s1.connector"]);
  assert(mfake.log.length === 12, `12 calls expected, got ${mfake.log.length}`);
  for (const l of mfake.log) {
    if (drawIds.has(l.id)) {
      assert(l.model === "zai-glm-4.7", `${l.id} must route to the HERO model, got ${l.model}`);
      assert(l.effort === "none", `${l.id} on GLM must send effort "none", got ${l.effort}`);
    } else {
      assert(l.model === "gemma-4-31b", `${l.id} must route to the LEAVES model, got ${l.model}`);
      assert(l.effort === undefined, `${l.id} on gemma must OMIT effort, got ${l.effort}`);
    }
  }
});

await check("mixed build: foreign serif rewritten to theme faces by size, fontRewrites exact, compiles", async () => {
  const err = await verifyCompilable(mresult.code);
  assert(err === null, `should compile but: ${err}`);
  assert(!mresult.code.includes("Georgia"), "the serif fallback must be gone");
  assert(mresult.code.includes("fontFamily: FONT_DISPLAY, fontSize: 88"), "88px headline → display face");
  assert(mresult.code.includes("fontFamily: FONT_BODY, fontSize: 28"), "28px lede → body face");
  // 2 rewrites in s0.copy + 4 root injections (s0.hero, s1.hero, s1.copy,
  // s2.copy carry NO binding in the default body).
  assert(mresult.telemetry.fontRewrites === 6, `2 rewrites + 4 injections = 6, got ${mresult.telemetry.fontRewrites}`);
  assert(mresult.code.includes('fontFamily: FONT_BODY, width: "100%"'), "a bare copy/hero root earned an injected theme face");
  assert(mresult.telemetry.inkCorrected === false, "the fixture's near-white ink is neutral — no correction");
});

await check("ink guard end-to-end: chromatic ink corrected on entry, telemetry counts it, emitted const is near-black", async () => {
  const poisoned: Theme = { ...theme, palette: { ...theme.palette, INK: "#57cc02" } };
  const f = makeFakeCaller();
  const r = await castBuild({ ...input, theme: poisoned }, { caller: f.caller as never, concurrency: 4 });
  assert(r.telemetry.inkCorrected === true, "chromatic ink must be counted as corrected");
  assert(r.code.includes('const INK = "#1a1a1a"'), "the emitted INK const is the near-black override");
  assert(!r.code.includes("#57cc02"), "the poisoned ink never ships");
});

await check("neutralizeInk (unit): #57cc02 corrected, #10141c passes, pure, only ink touched", () => {
  const poisoned: Theme = { ...theme, palette: { ...theme.palette, INK: "#57cc02" } };
  const r = neutralizeInk(poisoned);
  assert(r.corrected === true, "streak-green ink must correct");
  assert(r.theme.palette.INK === "#1a1a1a", `near-black override expected, got ${r.theme.palette.INK}`);
  assert(r.theme.palette.ACCENT === "#ff7a59", "only the ink key is overridden");
  assert(poisoned.palette.INK === "#57cc02", "input theme must not be mutated");
  const navy: Theme = { ...theme, palette: { ...theme.palette, INK: "#10141c" } };
  const r2 = neutralizeInk(navy);
  assert(!r2.corrected && r2.theme.palette.INK === "#10141c", "near-black brand navy passes through");
  assert(!neutralizeInk(theme).corrected, "the fixture's near-white ink is neutral — passes");
});

await check("normalizeFontBindings (unit): foreign faces rewritten by size/tag; theme refs untouched; mono only via dataFont", () => {
  const body = [
    "<div>",
    '<h2 style={{ fontFamily: "Georgia, serif" }}>display by tag</h2>',
    "<div style={{ fontFamily: '\"Palatino\", serif', fontSize: 64 }}>display by size</div>",
    '<p style={{ fontFamily: "Menlo, monospace", fontSize: 14 }}>foreign mono</p>',
    "<span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>data</span>",
    "<em style={{ fontFamily: `${FONT_DISPLAY}`, fontSize: 90 }}>tpl const</em>",
    "<i style={{ fontFamily: '\"Mono\", monospace', fontSize: 12 }}>theme mono stack</i>",
    "</div>",
  ].join("\n");
  const r = normalizeFontBindings(body, theme, "copy");
  assert(r.rewrites === 3, `3 rewrites expected, got ${r.rewrites}`);
  assert(!/Georgia|Palatino|Menlo/.test(r.code), "foreign families gone");
  assert(r.code.includes("<h2 style={{ fontFamily: FONT_DISPLAY }}>"), "heading-ish tag → display face");
  assert(r.code.includes("fontFamily: FONT_DISPLAY, fontSize: 64"), "≥40px → display face");
  assert(r.code.includes("fontFamily: FONT_BODY, fontSize: 14"), "foreign mono → BODY (mono is NOT preserved off the theme's dataFont)");
  assert(r.code.includes("fontFamily: FONT_MONO, fontSize: 12"), "FONT_MONO const reference untouched");
  assert(r.code.includes("${FONT_DISPLAY}"), "template-interpolated theme const untouched");
  assert(r.code.includes("'\"Mono\", monospace'"), "the theme's own mono STACK is a theme value — untouched");
  assert(!r.injected, "bindings exist — no root injection");
});

await check("normalizeFontBindings (unit): CSS-string form → theme body stack; ${FONT_*} interpolation untouched", () => {
  const body =
    "<div style={{ fontFamily: FONT_BODY }}><style>{`.x{font-family: Comic Sans MS, cursive;} .y{font-family: ${FONT_MONO};}`}</style></div>";
  const r = normalizeFontBindings(body, theme, "copy");
  assert(r.rewrites === 1, `1 rewrite expected, got ${r.rewrites}`);
  assert(!r.code.includes("Comic Sans"), "foreign CSS family gone");
  assert(r.code.includes('font-family: "Body", sans-serif'), "theme body STACK in its place (no JS const inside a CSS string)");
  assert(r.code.includes("font-family: ${FONT_MONO}"), "interpolated theme const survives");
});

await check("normalizeFontBindings (unit): root injection for copy/hero only; face follows the root", () => {
  const bare = '<div style={{ display: "flex" }}><p>hello</p></div>';
  const c = normalizeFontBindings(bare, theme, "copy");
  assert(c.injected, "copy piece with no binding earns an injection");
  assert(c.code.startsWith('<div style={{ fontFamily: FONT_BODY, display: "flex" }}>'), `injected into the existing root style: ${c.code.slice(0, 60)}`);
  const noStyle = normalizeFontBindings("<section><p>hello</p></section>", theme, "hero");
  assert(noStyle.injected && noStyle.code.startsWith("<section style={{ fontFamily: FONT_BODY }}>"), "style attr synthesized when the root has none");
  const heading = normalizeFontBindings("<h1>Massive</h1>", theme, "copy");
  assert(heading.code.startsWith("<h1 style={{ fontFamily: FONT_DISPLAY }}>"), "heading-ish root → display face");
  const atmos = normalizeFontBindings(bare, theme, "atmosphere");
  assert(!atmos.injected && atmos.code === bare, "atmosphere pieces are never injected");
  const already = normalizeFontBindings('<div style={{ fontFamily: FONT_MONO }} />', theme, "copy");
  assert(!already.injected, "a bound piece is not re-injected (idempotent)");
});

await check("normalizeFontBindings (unit): a QUOTED const name is a serif trap — unquoted to the bare const (v7 fast-tier defect)", () => {
  const body = [
    "<div>",
    '<h2 style={{ fontFamily: "FONT_DISPLAY" }}>quoted display const</h2>',
    "<p style={{ fontFamily: 'FONT_BODY', fontSize: 14 }}>quoted body const</p>",
    '<style>{`.k{font-family: FONT_MONO;} .m{font-family: "FONT_DISPLAY";}`}</style>',
    "</div>",
  ].join("\n");
  const r = normalizeFontBindings(body, theme, "copy");
  assert(r.rewrites === 4, `4 rewrites expected (2 style-object + 2 CSS), got ${r.rewrites}`);
  assert(r.code.includes("fontFamily: FONT_DISPLAY }"), "quoted display const → BARE const (browser has no font named FONT_DISPLAY)");
  assert(r.code.includes("fontFamily: FONT_BODY, fontSize: 14"), "quoted body const → bare const, face kept");
  assert(!/font-family:\s*["'`]?FONT_/.test(r.code), "no literal FONT_* family survives inside CSS strings");
  assert(r.code.includes('.k{font-family: "Mono", monospace;}'), "bare const name in CSS → that face's full stack");
  assert(r.code.includes('.m{font-family: "Display", sans-serif;}'), "quoted const name in CSS → that face's full stack");
  assert(!r.injected, "bindings exist — no root injection");
});

await check("unowned-copy rejection floor: short single-token values strip but never REJECT (v7 'Klarna' false positive)", () => {
  assert(!isRejectableUnownedCopy("Klarna"), "a one-word brand-name headline must not reject an element");
  assert(!isRejectableUnownedCopy("$120"), "a bare price token must not reject");
  assert(isRejectableUnownedCopy("Tap. Done."), "two-word real copy still rejects");
  assert(isRejectableUnownedCopy("Get the app"), "multi-word CTA copy still rejects");
  assert(isRejectableUnownedCopy("Unmistakable"), "a single ≥12-char word is unambiguous — still rejects");
});

await check("normalizeFontBindings (unit): theme primary with a FOREIGN TAIL is normalized to the named face (v6 serif-fallback defect)", () => {
  const body = [
    "<div>",
    "<div style={{ fontFamily: '\"Body\", Georgia, serif', fontSize: 64 }}>named body face beats the size heuristic</div>",
    "<code style={{ fontFamily: '\"Mono\", Courier', fontSize: 12 }}>named mono survives as MONO, not BODY</code>",
    '<style>{`.pay{font-family: "Display", serif;} .ok{font-family: "Body", sans-serif;}`}</style>',
    "</div>",
  ].join("\n");
  const r = normalizeFontBindings(body, theme, "hero");
  assert(r.rewrites === 3, `3 rewrites expected (2 style-object + 1 CSS), got ${r.rewrites}`);
  assert(!/Georgia|Courier/.test(r.code), "foreign tail families gone");
  assert(r.code.includes("fontFamily: FONT_BODY, fontSize: 64"), "body-primary stack → FONT_BODY even at display size (the named face wins)");
  assert(r.code.includes("fontFamily: FONT_MONO, fontSize: 12"), "mono-primary stack → FONT_MONO (named face wins over the dataFont-only policy)");
  assert(r.code.includes('font-family: "Display", sans-serif'), "CSS-string form → the named face's FULL theme stack");
  assert(r.code.includes('font-family: "Body", sans-serif'), "a verbatim full theme stack in CSS stays untouched");
  assert(!r.injected, "bindings exist — no root injection");
});

// ─── The deterministic post-passes, unit-level ───────────────────────────────

console.log("\ncast-build post-passes (unit)");

await check("rewriteKeyframeInterpolations: theme + body-local names; literal CSS names emitted", () => {
  const body =
    '<div style={{ animation: `${fadeRise} 0.6s ease both, ${spin} 2s linear infinite` }}>' +
    "<style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style></div>";
  const r = rewriteKeyframeInterpolations(body, theme.keyframes);
  assert(r.rewrites === 2, `2 rewrites expected, got ${r.rewrites}`);
  assert(r.code.includes("fadeRise 0.6s") && r.code.includes("spin 2s"), "literal names in place");
  assert(!r.code.includes("${"), "no interpolations left");
});

await check("stripCanvasSelfPositioning: rebases canvas-scale roots, leaves local offsets alone", () => {
  const posd = stripCanvasSelfPositioning(
    '<div style={{ position: "absolute", left: 1056, top: 220, width: 768, height: 640 }}><span>x</span></div>',
    { w: 768, h: 640 },
  );
  assert(posd.stripped, "canvas-scale root detected");
  assert(posd.code.includes("left: 0") && posd.code.includes("top: 0"), "rebased to the wrapper origin");
  const local = stripCanvasSelfPositioning(
    '<div style={{ position: "absolute", left: 24, top: 16, width: 200 }} />',
    { w: 768, h: 640 },
  );
  assert(!local.stripped && local.code.includes("left: 24"), "local offsets pass through");
  const flow = stripCanvasSelfPositioning('<div style={{ display: "flex" }} />', { w: 100, h: 100 });
  assert(!flow.stripped, "non-absolute roots untouched");
});

await check("stripUnownedCopy: exact nodes stripped (text + string expression); subtler → residual", () => {
  const r = stripUnownedCopy(
    '<div><h2>Ship the story first</h2><p>{"Approve it."}</p><img alt="Ship the story first" /></div>',
    ["Ship the story first", "Approve it."],
  );
  assert(r.code.includes("<h2></h2>"), "exact text node stripped");
  assert(r.stripped.includes("Approve it.") && !r.code.includes("Approve it."), "string-expression node stripped");
  assert(r.residual.includes("Ship the story first"), "attribute-embedded remainder reported as residual (→ repair)");
});

await check("stripColorMutationFilters: invert/hue-rotate stripped, benign filters survive", () => {
  const r = stripColorMutationFilters(
    '<div style={{ filter: "invert(1)", opacity: 0.5 }}><i style={{ filter: "blur(8px)" }} />' +
    "<style>{`div{filter: hue-rotate(90deg) blur(2px);}`}</style></div>",
  );
  assert(r.stripped === 2, `2 strips expected, got ${r.stripped}`);
  assert(!r.code.includes("invert(") && !r.code.includes("hue-rotate("), "mutating filters gone");
  assert(r.code.includes('filter: "blur(8px)"'), "benign blur survives");
});

// ─── v8 pre-render gates (retry audit: hollow bookend heroes + img srcs) ─────

console.log("\ncast-build v8 pre-render gates (static hero density + img srcs + provider caps)");

await check("staticJsxDensity: hollow bookend bodies measure an order of magnitude under the floor", () => {
  const hollow = staticJsxDensity('<div style={{ width: "100%", height: "100%" }}><Img src="https://x.com/logo.svg" /><div style={{ opacity: 0.4 }} /></div>');
  assert(hollow.elements < PRE_RENDER_HERO_MIN_ELEMENTS, `hollow body must be under the element floor, got ${hollow.elements}`);
  assert(hollow.textNodes < PRE_RENDER_HERO_MIN_TEXT, `hollow body has no text, got ${hollow.textNodes}`);
});

await check("staticJsxDensity: rich fixture bodies clear the floor; strings can't fabricate tags/text", () => {
  const rich = staticJsxDensity(HERO_TEAL);
  assert(rich.elements >= PRE_RENDER_HERO_MIN_ELEMENTS, `HERO_TEAL must clear the element floor, got ${rich.elements}`);
  assert(rich.textNodes >= PRE_RENDER_HERO_MIN_TEXT, `HERO_TEAL must clear the text floor, got ${rich.textNodes}`);
  // A style string containing "<div>fake</div>" is masked — no phantom counts.
  const masked = staticJsxDensity('<div style={{ content: "<div>fake</div> <b>x</b>" }} />');
  assert(masked.elements === 1, `string contents must be masked, got ${masked.elements} elements`);
  assert(masked.textNodes === 0, `string contents must not count as text, got ${masked.textNodes}`);
});

await check("staticJsxDensity: {c.*} bindings, quoted child expressions and mapped data arrays count as text", () => {
  const r = staticJsxDensity(
    '<div><h1>{c.headline}</h1><span>{"$18.50"}</span>' +
    '{["Chip alpha", "Chip beta", "Chip gamma"].map((t) => <em key={t}>{t}</em>)}</div>',
  );
  // 1 c-binding + 1 quoted expression + 3 array items = 5 text values.
  assert(r.textNodes === 5, `5 text values expected, got ${r.textNodes}`);
  assert(r.elements === 4, `div+h1+span+em = 4 open tags, got ${r.elements}`);
});

await check("substituteImgAssetIds: known ids substituted in every src form; fetchable srcs untouched; unknown = bad", () => {
  const images = new Map([
    ["site_logo", "https://cdn.brand.com/logo.svg"],
    ["site_img_0", "https://cdn.brand.com/shot0.png"],
  ]);
  const r = substituteImgAssetIds(
    '<div><Img src="site_logo" /><img src={"site_img_0"} /><Img src={`site_img_9`} />' +
    '<Img src="https://ok.com/a.png" /><Img src={LOGO_SRC} /><img src="" /></div>',
    images,
  );
  assert(r.code.includes('src="https://cdn.brand.com/logo.svg"'), "quoted-attr id substituted");
  assert(r.code.includes('src={"https://cdn.brand.com/shot0.png"}'), "expression-string id substituted");
  assert(r.substituted.length === 2, `2 substitutions expected, got ${JSON.stringify(r.substituted)}`);
  assert(r.bad.includes("site_img_9") && r.bad.includes(""), `unknown id + empty src reported bad, got ${JSON.stringify(r.bad)}`);
  assert(r.code.includes('src="https://ok.com/a.png"') && r.code.includes("src={LOGO_SRC}"), "fetchable + expression srcs untouched");
});

await check("maxTokensFor is provider-aware: hero 11000 on Fireworks, 6000 on Cerebras; other slots unchanged", () => {
  assert(maxTokensFor("hero", "accounts/fireworks/routers/glm-5p2-fast") === HERO_MAX_TOKENS_FIREWORKS, "Fireworks hero → 11000 (no TPM pre-debit there)");
  assert(maxTokensFor("hero", "gpt-oss-120b") === HERO_MAX_TOKENS_CEREBRAS, "Cerebras hero → 6000 (pre-debit is real)");
  assert(maxTokensFor("hero") === HERO_MAX_TOKENS_CEREBRAS, "no model, no env → the gpt-oss default");
  process.env.RB_CAST_MODEL = "accounts/fireworks/models/glm-5p2";
  try {
    assert(maxTokensFor("hero") === HERO_MAX_TOKENS_FIREWORKS, "RB_CAST_MODEL drives the cap when there is no per-call model");
  } finally {
    delete process.env.RB_CAST_MODEL;
  }
  assert(maxTokensFor("atmosphere") === 3500 && maxTokensFor("copy") === 2500, "non-hero caps unchanged");
});

await check("build-level: a hollow hero fails the pre-render density gate → repair → placeholder; outcomes report it", async () => {
  const hollowCanned = (id: string): string => (id === "s0.hero" ? DEFAULT_BODY : cannedFor(id, 2));
  const f = makeFakeCaller(hollowCanned);
  const r = await castBuild(input, { caller: f.caller as never, concurrency: 4 });
  const heroCalls = f.log.filter((l) => l.id === "s0.hero");
  assert(heroCalls.length === 2, `hollow hero must earn the in-round repair, got ${heroCalls.length} call(s)`);
  assert(/hero interior too thin: statically measured/.test(heroCalls[1].user), "repair prompt carries the static density error");
  const outcome = r.elementOutcomes.find((o) => o.pieceId === "s0.hero");
  assert(!!outcome && outcome.failed, "elementOutcomes must report the failed hero (cache-invalidation signal)");
  assert(r.elementOutcomes.length === r.telemetry.elements, "one outcome per element call");
});

await check("build-level: a raw asset-id <Img> src is substituted from the script manifest at zero repair cost", async () => {
  const withAsset = JSON.parse(JSON.stringify(script)) as Script;
  (withAsset.assets as { images: unknown[] }).images = [
    { id: "site_logo", src: "https://cdn.brand.com/logo.svg", width: 512, height: 512, format: "svg", license_id: "lic", alt_text: "logo" },
  ];
  const IMG_HERO = HERO_TEAL.replace("<svg viewBox", '<Img src="site_logo" /><svg viewBox');
  const f = makeFakeCaller((id, nth) => (id === "s0.hero" ? IMG_HERO : cannedFor(id, nth)));
  const r = await castBuild({ ...input, script: withAsset }, { caller: f.caller as never, concurrency: 4 });
  assert(r.code.includes('src="https://cdn.brand.com/logo.svg"'), "asset id resolved to the crawled URL");
  assert(!r.code.includes('src="site_logo"'), "the raw id never ships");
  assert(f.log.filter((l) => l.id === "s0.hero").length === 1, "substitution is deterministic — no repair burned");
});

await check("build-level: an UNKNOWN non-fetchable src is a gate failure routed to the repair", async () => {
  const BAD_IMG_HERO = HERO_TEAL.replace("<svg viewBox", '<Img src="site_img_7" /><svg viewBox');
  const f = makeFakeCaller((id, nth) => (id === "s0.hero" && nth === 1 ? BAD_IMG_HERO : cannedFor(id, 2)));
  const r = await castBuild(input, { caller: f.caller as never, concurrency: 4 });
  const heroCalls = f.log.filter((l) => l.id === "s0.hero");
  assert(heroCalls.length === 2, `bad src must earn the in-round repair, got ${heroCalls.length}`);
  assert(/non-fetchable <Img> src\(s\): "site_img_7"/.test(heroCalls[1].user), "repair prompt names the bad src");
  assert(!r.code.includes('src="site_img_7"'), "the blank-rectangle src never ships");
});

// ─── (g) hero surface-contrast backstop (v9 — the washout class) ────────────

// A dark-canvas theme whose panel tokens sit in the canvas's own luminance
// band (the v8 dark-plum-on-dark-plum signature), plus one honest light token.
const washTheme: Theme = {
  ...theme,
  palette: {
    CANVAS: "#101018", INK: "#f5f8fa", ACCENT: "#b43cff",
    CARD_FILL: "#181824", SOFT_NEUTRAL: "#26262f", WHITE: "#ffffff",
  },
};

await check("surface backstop: all-canvas-tone panels → PRIMARY panel lifted to the contrast token", () => {
  const body = `<div style={{ width: "100%", background: CARD_FILL }}><div style={{ background: "#141420" }} /></div>`;
  const r = ensureHeroSurfaceContrast(body, washTheme);
  assert(r.corrected, "must correct — every panel sits within ΔL<15 of the canvas");
  assert(r.code.includes("background: WHITE"), `primary panel must lift to the most contrasting token, got: ${r.code}`);
  assert(r.code.includes('"#141420"'), "only the PRIMARY (first) panel is rewritten");
  // Idempotent: the corrected body now paints contrast → second pass no-ops.
  const again = ensureHeroSurfaceContrast(r.code, washTheme);
  assert(!again.corrected && again.code === r.code, "second pass must be a no-op");
});

await check("surface backstop: quoted-hex primary rewrites in quoted form", () => {
  const r = ensureHeroSurfaceContrast(`<div style={{ backgroundColor: "#12121c", padding: 20 }} />`, washTheme);
  assert(r.corrected, "canvas-tone hex panel must correct");
  assert(r.code.includes('backgroundColor: "#ffffff"'), `quoted hex must rewrite as a quoted hex, got: ${r.code}`);
});

await check("surface backstop: contrasting paint carrying real weight → no-op (count fallback: 1 of 2)", () => {
  const body = `<div style={{ background: CARD_FILL }}><div style={{ background: WHITE }} /></div>`;
  const r = ensureHeroSurfaceContrast(body, washTheme);
  assert(!r.corrected && r.code === body, "50% of the painted panels contrast — passes the 25% floor untouched");
});

// ── v10: AREA-WEIGHTED contrast (dogfood cycle 1 — a token chip must not vouch
//    for a washed-out hero) ──────────────────────────────────────────────────

await check("surface backstop v10: a TINY contrasting chip among big canvas-tone panels no longer vouches — LARGEST panel lifted", () => {
  const body = [
    `<div style={{ width: 700, height: 400, background: CARD_FILL }}>`,
    `<div style={{ width: 680, height: 200, background: "#141420" }} />`,
    `<div style={{ width: 40, height: 16, background: WHITE }} />`, // the chip: 640px² of 420,600px²
    `</div>`,
  ].join("");
  const r = ensureHeroSurfaceContrast(body, washTheme);
  assert(r.corrected, "contrast under the area floor must correct");
  assert(r.code.includes("width: 700, height: 400, background: WHITE"), `the LARGEST canvas-toned panel lifts, got: ${r.code}`);
  assert(r.code.includes('background: "#141420"'), "smaller canvas-toned panel untouched");
  assert(HERO_SURFACE_MIN_CONTRAST_FRAC === 0.25, "the area floor is the documented calibration");
});

await check("surface backstop v10: contrasting panel at ≥25% of painted area → no-op", () => {
  const body = [
    `<div style={{ width: 600, height: 400, background: CARD_FILL }}>`,
    `<div style={{ width: 400, height: 300, background: WHITE }} /></div>`, // 120k of 360k = 33%
  ].join("");
  const r = ensureHeroSurfaceContrast(body, washTheme);
  assert(!r.corrected && r.code === body, "a third of the painted area contrasts — untouched");
});

await check("surface backstop v10: unparseable sizes fall back to counting (1 of 5 panels = under-weighted → corrected)", () => {
  const body = [
    `<div style={{ width: "100%", background: CARD_FILL }}>`,
    `<div style={{ background: "#141420" }} />`,
    `<div style={{ background: "#12121c" }} />`,
    `<div style={{ background: "#16161f" }} />`,
    `<div style={{ background: WHITE }} /></div>`,
  ].join("");
  const r = ensureHeroSurfaceContrast(body, washTheme);
  assert(r.corrected, "1 contrasting of 5 counted panels (20%) is under the 25% floor");
  assert(r.code.includes("background: WHITE, ") || (r.code.match(/background: WHITE/g) ?? []).length === 2, `a canvas-toned panel lifted to WHITE, got: ${r.code}`);
});

await check("surface backstop: unresolvable paints (gradients/rgba/foreign consts) → no-op, never a guess", () => {
  const grad = `<div style={{ background: "linear-gradient(180deg, #101018, #26262f)" }} />`;
  assert(!ensureHeroSurfaceContrast(grad, washTheme).corrected, "gradient values are unjudgeable");
  const rgba = `<div style={{ background: PANEL_BG }} />`; // PANEL_BG not in washTheme
  assert(!ensureHeroSurfaceContrast(rgba, washTheme).corrected, "a foreign const resolves to nothing");
  assert(!ensureHeroSurfaceContrast(`<div style={{ color: INK }} />`, washTheme).corrected, "no backgrounds at all");
});

await check("surface backstop: light canvas corrects toward the DARK token; floor honored", () => {
  const lightTheme: Theme = {
    ...theme,
    palette: { CANVAS: "#faf9f7", INK: "#101018", ACCENT: "#ffd60a", CARD_FILL: "#f2f1ee", WHITE: "#ffffff" },
  };
  const r = ensureHeroSurfaceContrast(`<div style={{ background: CARD_FILL }} />`, lightTheme);
  assert(r.corrected, "pale-on-pale must correct");
  assert(r.code.includes("background: INK"), `light canvas lifts toward the darkest token, got: ${r.code}`);
  assert(HERO_SURFACE_MIN_DELTA_L === 15, "the ΔL floor is the documented calibration");
  // A mono-luminance palette (nothing clears the floor) disables the pass.
  const mono: Theme = { ...theme, palette: { CANVAS: "#101018", CARD_FILL: "#12121a" } };
  assert(!ensureHeroSurfaceContrast(`<div style={{ background: CARD_FILL }} />`, mono).corrected, "no target above the floor → no-op");
});

await check("surface backstop end-to-end: golden build heroes paint contrast → zero corrections counted", () => {
  assert(result.telemetry.heroSurfaceCorrections === 0, `fixture heroes contrast already, got ${result.telemetry.heroSurfaceCorrections}`);
});

// ─── (g2) FORCED hero surface lift (v12 — gate→backstop closure) ────────────
// The washout GATE measured the region — static conservatism no longer
// applies. Cycle 3's s4.hero: gradients/unparseable styles no-op'd the v9
// backstop for 3 straight rounds (spread 9 vs floor 45, corrections 0).

await check("forced lift: a canvas-toned GRADIENT panel (v9-backstop-invisible) rewrites to the contrast hex", () => {
  const grad = `<div style={{ background: "linear-gradient(180deg, #101018, #26262f)" }} />`;
  assert(!ensureHeroSurfaceContrast(grad, washTheme).corrected, "precondition: the conservative pass no-ops");
  const r = forceHeroSurfaceLift(grad, washTheme, { canvasColor: "#101018" });
  assert(r.lifted && r.via === "paint-rewrite", `gradient must lift, got ${JSON.stringify({ lifted: r.lifted, via: r.via })}`);
  assert(r.code.includes('background: "#ffffff"'), `gradient value replaced by the contrast hex: ${r.code}`);
  assert(!/gradient/.test(r.code), "the washed-out gradient is gone");
  assert(r.targetToken === "WHITE", `target is the max-|ΔL| token, got ${r.targetToken}`);
});

await check("forced lift: dilute rgba paint reads as canvas tone and lifts", () => {
  const r = forceHeroSurfaceLift(`<div style={{ backgroundColor: "rgba(255,255,255,0.06)" }} />`, washTheme, {});
  assert(r.lifted && r.code.includes('backgroundColor: "#ffffff"'), `dilute tint lifts: ${r.code}`);
});

await check("forced lift: the MEASURED dominant panel color picks WHICH paint lifts", () => {
  const body = `<div style={{ background: "#030304" }}><div style={{ background: "#1c1c26" }} /></div>`;
  const r = forceHeroSurfaceLift(body, washTheme, { measuredPanelColor: "rgb(28, 28, 38)", canvasColor: "#101018" });
  assert(r.lifted && r.via === "paint-rewrite", "lifts");
  assert(r.code.includes('background: "#030304"'), `the non-dominant paint stays: ${r.code}`);
  assert(!r.code.includes("#1c1c26") && r.code.includes('"#ffffff"'), `the measured dominant panel is the one rewritten: ${r.code}`);
});

await check("forced lift: an unresolvable foreign const is still a rewrite site (measured truth beats static doubt)", () => {
  const r = forceHeroSurfaceLift(`<div style={{ background: PANEL_BG }} />`, washTheme, {});
  assert(r.lifted && r.code.includes('background: "#ffffff"'), `foreign const rewritten: ${r.code}`);
});

await check("forced lift: NO background anywhere → override appended LAST to the root style object", () => {
  const r = forceHeroSurfaceLift(`<div style={{ width: 700, padding: 24 }}><span>rows</span></div>`, washTheme, {});
  assert(r.lifted && r.via === "root-override", `root override, got ${r.via}`);
  assert(r.code.includes(`width: 700, padding: 24, background: "#ffffff"`), `override appended last: ${r.code}`);
});

await check("forced lift: contrasting paints are never overwritten — the root gets the override instead", () => {
  const body = `<div style={{ width: 40, height: 16, background: WHITE }} />`;
  const r = forceHeroSurfaceLift(body, washTheme, {});
  assert(r.lifted && r.via === "root-override", `contrast paints stay; root overrides: ${JSON.stringify(r.via)}`);
  assert(r.code.includes(`background: "#ffffff" }}`), `override appended: ${r.code}`);
});

await check("forced lift: no style at all → a style attr is injected on the first tag", () => {
  const r = forceHeroSurfaceLift(`<section><span>bare</span></section>`, washTheme, {});
  assert(r.lifted && r.via === "root-override", "injects");
  assert(r.code.startsWith(`<section style={{ background: "#ffffff" }}>`), `style injected on the root: ${r.code}`);
});

await check("forced lift: the MEASURED canvas color overrides the theme canvas (light-canvas arm)", () => {
  // washTheme's canvas is dark, but the MEASURED scene canvas is pale — the
  // lift must push toward the DARKEST token, not white.
  const r = forceHeroSurfaceLift(`<div style={{ background: "#f2f1ee" }} />`, washTheme, { canvasColor: "#faf7f7" });
  assert(r.lifted, "pale-on-pale lifts");
  assert(r.targetToken === "CANVAS" && r.code.includes('"#101018"'), `darkest token wins on a light canvas: ${r.code} (target ${r.targetToken})`);
});

await check("forced lift: a mono-luminance palette stays a no-op (nothing to lift toward)", () => {
  const mono: Theme = { ...theme, palette: { CANVAS: "#101018", CARD_FILL: "#12121a" } };
  const r = forceHeroSurfaceLift(`<div style={{ background: CARD_FILL }} />`, mono, {});
  assert(!r.lifted && r.via === null, "no target above the ΔL floor → honest no-op");
});

// ─── (d5) masked bullet-run strip (v10) ─────────────────────────────────────

await check("stripMaskedValueRuns: bullet runs collapse to ONE bullet; legitimate singles survive", () => {
  const r = stripMaskedValueRuns(`<span>●●●</span><span>• item</span><div>{"•••• 4242"}</div>`);
  assert(r.stripped === 2, `two runs stripped, got ${r.stripped}`);
  assert(r.code === `<span>•</span><span>• item</span><div>{"• 4242"}</div>`, `runs collapse, singles keep: ${r.code}`);
  const clean = stripMaskedValueRuns(`<div>Sep • 2025 • $18.50</div>`);
  assert(clean.stripped === 0 && clean.code.includes("Sep • 2025 • $18.50"), "separator bullets untouched");
});

await check("element system prompt carries the v10 accent-is-punctuation hard rule", async () => {
  let system = "";
  const inner = makeFakeCaller();
  const spy = async (call: Parameters<typeof inner.caller>[0]) => {
    system = call.system;
    return inner.caller(call);
  };
  await castBuild(input, { caller: spy as never, concurrency: 4 });
  assert(/accent is PUNCTUATION/.test(system), "the punctuation doctrine is stated");
  assert(/NEVER paint a panel/.test(system), "panel fills are explicitly banned");
  assert(/deterministic gate/.test(system), "the gate consequence is named (models comply better with a stated sensor)");
});

await check("elementOutcomes: clean build reports zero failed, repaired flags match telemetry", async () => {
  const f = makeFakeCaller();
  const r = await castBuild(input, { caller: f.caller as never, concurrency: 4 });
  assert(r.elementOutcomes.filter((o) => o.failed).length === r.telemetry.failures, "failed count matches telemetry");
  assert(r.elementOutcomes.filter((o) => o.repaired).length === r.telemetry.repairs, "repaired count matches telemetry");
  assert(r.elementOutcomes.some((o) => o.pieceId === "s2.throughline" && o.failed), "the broken-through-repair piece is named");
  assert(r.elementOutcomes.some((o) => o.pieceId === "s1.atmosphere" && o.repaired && !o.failed), "the recovered piece is named");
});

// ─── (d6) META-TEXT LEAK gate (v11 — dogfood cycle 2 s2 class) ───────────────

// The ACTUAL leaked prose that shipped on Glossier scene 2 (cycle 2) — the
// calibration MUST-FIRE. Kept verbatim (trimmed) so the detector is pinned to
// the measured defect, not a stylized version of it.
const CYCLE2_LEAK_PROSE = `Looking at the QA findings: the headline text "One drop." and "And everything" straddle piece s2.hero's panel at x=642. My wrapper is 720px wide starting at x=120, so it ends at x=840 — overlapping the panel which starts at x=642. The headline spans the full wrapper width and crosses into the panel zone.

Fix: constrain the entire stack to a max-width that sits fully clear of the panel (642-120 = 522px from my left edge, so I cap content width at ~480px), and ensure no text node can flow past that bound.`;

await check("extractJsxTextSegments: leading prose, between-tag runs; attributes/styles/expressions masked", () => {
  const segs = extractJsxTextSegments(
    `Some leading prose here <div style={{ width: "720px", content: "at x=120" }} title="my wrapper is">Real copy{c.headline}more text</div>`,
  );
  const texts = segs.map((s) => s.text.trim());
  assert(texts.includes("Some leading prose here"), `leading prose extracted: ${JSON.stringify(texts)}`);
  assert(texts.includes("Real copy"), "between-tag run extracted");
  assert(texts.includes("more text"), "run after an expression extracted");
  assert(!texts.some((t) => t.includes("720px") || t.includes("x=120") || t.includes("my wrapper")), "style/attribute strings never surface as text segments");
});

await check("isMetaTextSegment: vocabulary arm fires on QA/wrapper/piece-id/coordinate prose", () => {
  assert(isMetaTextSegment("Looking at the QA findings: the headline straddles"), "QA findings");
  assert(isMetaTextSegment("My wrapper is 720px wide starting at x=120"), "wrapper + px + coords");
  assert(isMetaTextSegment("the panel of piece s2.hero starts at x=642"), "piece-id token");
  assert(isMetaTextSegment("so I cap content width at ~480px"), "first-person planning verb");
  assert(isMetaTextSegment("constrain the stack to a max-width clear of the panel"), "max-width as prose");
});

await check("isMetaTextSegment: structural arm fires on sentence-length px/planning prose without vocabulary", () => {
  const noVocab =
    "The content block needs to sit within 480px so the two columns never collide, and the second row should stay under 320px to leave the footer visible at the bottom of the frame area.";
  assert(isMetaTextSegment(noVocab), "long px-carrying prose flags structurally");
});

await check("isMetaTextSegment: real brand copy passes — short lines, long ledes, first-person taglines", () => {
  assert(!isMetaTextSegment("Come as you are."), "headline");
  assert(!isMetaTextSegment("THE INVITATION"), "eyebrow");
  assert(!isMetaTextSegment("Behind layers. Behind routines too heavy to hold. Behind the idea that beauty means covering up what's already there."), "118-char lede");
  assert(!isMetaTextSegment("I stopped hiding. And everything shifted for me, for good."), "first-person brand voice without planning verbs");
  assert(!isMetaTextSegment("Renewal — Acme Corp · $12,400 · Won"), "diegetic mock row");
  assert(!isMetaTextSegment("Complimentary shipping over $30 · Returns within 30 days"), "diegetic footer");
});

await check("stripMetaText: CALIBRATION MUST-FIRE — the verbatim cycle-2 s2 leak is detected and dominates (reject)", () => {
  const leakedBody = `${CYCLE2_LEAK_PROSE}\n\n<div style={{ width: '100%' }}>\n  <h1 data-content-path="headline">{c.headline}</h1>\n</div>`;
  const r = stripMetaText(leakedBody);
  assert(r.stripped.length >= 1, "the leak prose is flagged");
  assert(r.reject, "prose dominates the body's text → reject for a fresh emission");
  assert(!r.code.includes("QA findings"), "the prose is gone from the stripped code");
  assert(r.code.includes('data-content-path="headline"'), "the real JSX survives the strip");
});

await check("stripMetaText: minority prose strips in place (no reject) — the artwork keeps its copy", () => {
  const body = `<div>\n  I cap content width at ~480px to clear the panel\n  <h1>Beauty is not a performance.</h1>\n  <p>A thesis, not a tagline. An invitation to stop performing and start being. The world is open and the glow is yours to keep, always.</p>\n  <span>Futuredew · serum + oil highlight</span>\n</div>`;
  const r = stripMetaText(body);
  assert(r.stripped.length === 1, `one flagged segment, got ${r.stripped.length}`);
  assert(!r.reject, `minority prose must strip, not reject (frac ceiling ${META_TEXT_REJECT_FRAC})`);
  assert(!r.code.includes("I cap content"), "prose removed");
  assert(r.code.includes("Beauty is not a performance."), "real copy intact");
});

await check("stripMetaText: clean bodies untouched (every canned fixture body)", () => {
  for (const [name, body] of [["HERO_TEAL", HERO_TEAL], ["COPY_BODY", COPY_BODY], ["SELF_POS_HERO", SELF_POS_HERO], ["RICH_HERO_DEFAULT", RICH_HERO_DEFAULT], ["CONNECTOR_BODY", CONNECTOR_BODY]] as const) {
    const r = stripMetaText(body);
    assert(r.stripped.length === 0 && r.code === body, `${name} must pass clean (flagged: ${JSON.stringify(r.stripped)})`);
  }
});

await check("castBuild end-to-end: minority meta-text strips from the shipped body; telemetry counts it", async () => {
  const proseCopy = `<div>\n  so I cap content width at ~480px to clear the panel zone\n  <h1 data-content-path="headline" style={{ fontFamily: FONT_DISPLAY }}>{c.headline}</h1>\n  <p>A thesis, not a tagline. An invitation to stop performing and start being — the whole story, approved before the render.</p>\n</div>`;
  const f = makeFakeCaller((id, nth) => (id === "s2.copy" ? proseCopy : cannedFor(id, nth)));
  const r = await castBuild(input, { caller: f.caller as never, concurrency: 4 });
  assert(!r.code.includes("I cap content width"), "leaked prose never ships");
  assert(r.code.includes("A thesis, not a tagline"), "the real copy ships");
  assert(r.telemetry.metaTextStrips >= 1, `telemetry counts the strip, got ${r.telemetry.metaTextStrips}`);
});

await check("castBuild end-to-end: prose-DOMINATED emission rejects → repair → placeholder when unrepentant", async () => {
  const dominated = `${CYCLE2_LEAK_PROSE}\n<div><span>ok</span></div>`;
  const f = makeFakeCaller((id, nth) => (id === "s2.copy" ? dominated : cannedFor(id, nth)));
  const r = await castBuild(input, { caller: f.caller as never, concurrency: 4 });
  assert(!r.code.includes("QA findings"), "the reasoning never ships");
  const copyCalls = f.log.filter((l) => l.id === "s2.copy");
  assert(copyCalls.length === 2, `reject routed to the ONE repair (got ${copyCalls.length} calls)`);
  assert(/never narrate your reasoning/.test(copyCalls[1].user), "the repair prompt carries the anti-narration line");
  assert(r.elementOutcomes.some((o) => o.pieceId === "s2.copy" && o.failed), "unrepentant piece ships as placeholder, counted honestly");
});

await check("element system prompt carries the v11 anti-narration hard rule", async () => {
  let system = "";
  const inner = makeFakeCaller();
  const spy = async (call: Parameters<typeof inner.caller>[0]) => {
    system = call.system;
    return inner.caller(call);
  };
  await castBuild(input, { caller: spy as never, concurrency: 4 });
  assert(/NEVER narrate your reasoning/.test(system), "anti-narration rule stated");
  assert(/text node/.test(system), "the text-node consequence is named");
});

// ─── Meta-text CALIBRATION on real build artifacts (skips when absent) ───────
// MUST-FIRE: the cycle-2 Glossier composition's s2.copy piece (the shipped
// leak). MUST-PASS: every piece of every prior CLEAN build on disk. Guarded
// by existsSync so CI without .data/dogfood artifacts stays green.

{
  const { existsSync, readFileSync } = await import("fs");
  const { join } = await import("path");
  /** data-piece wrapper inner bodies from an assembled composition. Pieces
   *  are emitted sequentially inside a Section ending with <Chrome …>, so a
   *  body runs to the NEXT piece wrapper or the Chrome boundary — trailing
   *  closing tags in the slice are inert for text extraction (self-closing
   *  <div /> forms make brace-free div balancing unreliable). */
  const pieceBodies = (src: string): { id: string; body: string }[] => {
    const out: { id: string; body: string }[] = [];
    const marks: { id: string; start: number; at: number }[] = [];
    const re = /<div data-piece="([^"]+)"[^>]*>/g;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      marks.push({ id: m[1], start: m.index + m[0].length, at: m.index });
    }
    for (let i = 0; i < marks.length; i++) {
      const next = marks[i + 1]?.at ?? src.length;
      const chromeAt = src.indexOf("<Chrome ", marks[i].start);
      const end = chromeAt !== -1 && chromeAt < next ? chromeAt : next;
      out.push({ id: marks[i].id, body: src.slice(marks[i].start, end) });
    }
    return out;
  };
  const root = process.cwd();
  const leakPath = join(root, ".data/dogfood/cycle2-glossier/Composition.dogfood.tsx");
  if (existsSync(leakPath)) {
    await check("CALIBRATION artifact MUST-FIRE: cycle-2 Glossier s2.copy leak detected, and ONLY it", () => {
      const flagged = pieceBodies(readFileSync(leakPath, "utf8"))
        .filter((p) => stripMetaText(p.body).stripped.length > 0)
        .map((p) => p.id);
      assert(flagged.length === 1 && flagged[0] === "s2.copy", `exactly the known leak fires, got ${JSON.stringify(flagged)}`);
    });
  }
  const cleanArtifacts = [
    ".data/dogfood/cycle1-liquiddeath/Composition.dogfood.tsx",
    "src/generated/CAST_SPIKE_A8_KLARNA/Composition.tsx",
    "src/generated/CAST_SPIKE_A7_KLARNA/Composition.tsx",
  ].map((p) => join(root, p)).filter((p) => existsSync(p));
  for (const p of cleanArtifacts) {
    await check(`CALIBRATION artifact MUST-PASS: ${p.split("/").slice(-2).join("/")} — zero meta-text findings on every piece`, () => {
      for (const piece of pieceBodies(readFileSync(p, "utf8"))) {
        const r = stripMetaText(piece.body);
        assert(r.stripped.length === 0, `${piece.id} false-fired: ${JSON.stringify(r.stripped[0] ?? "")}`);
      }
    });
  }
}

// ─── Unowned-copy BINDING check (v11 — dogfood cycle 2 s4 class) ─────────────

await check("unownedCopyValues (v11): coverage widened to eyebrow/caption/cta", () => {
  const content = {
    eyebrow: "THE INVITATION",
    headline: "Come as you are.",
    lede: "The world is open.",
    caption: "Free standard shipping on orders $40+",
    cta: { primary: "Shop the world of Glossier", secondary: "glossier.com" },
  } as never;
  const vals = unownedCopyValues(content, []);
  for (const v of ["THE INVITATION", "Come as you are.", "Shop the world of Glossier", "glossier.com", "Free standard shipping on orders $40+"]) {
    assert(vals.includes(v), `${v} hunted`);
  }
  assert(unownedCopyValues(content, ["cta", "eyebrow", "caption", "headline", "lede"]).length === 0, "owned fields are never hunted");
});

await check("rejectableUnownedCopyValues: only headline/lede/bullets/cta.primary may reject; isUrlLikeValue carve-out", () => {
  const content = {
    eyebrow: "THE RANGE",
    headline: "Not one bottle. A world.",
    cta: { primary: "Shop the world of Glossier", secondary: "glossier.com" },
    caption: "Real products. Real textures.",
  } as never;
  const rej = rejectableUnownedCopyValues(content, []);
  assert(rej.includes("Not one bottle. A world.") && rej.includes("Shop the world of Glossier"), "headline + cta.primary rejectable");
  assert(!rej.includes("THE RANGE") && !rej.includes("Real products. Real textures."), "eyebrow/caption are strip-only");
  assert(isUrlLikeValue("glossier.com") && isUrlLikeValue("https://linear.app/features"), "domains/urls detected");
  assert(!isUrlLikeValue("Come as you are.") && !isRejectableUnownedCopy("glossier.com"), "a bare domain never rejects an element");
});

await check("stripUnownedCopy (v11): trailing-punct + case variants strip the cycle-2 s4 retype shapes", () => {
  // The measured s4 hero: headline retyped WITHOUT its period (the period
  // lived in a nested accent span) + the eyebrow retyped in a different case.
  const heroBody = `<div>\n  <div>The Invitation</div>\n  <div>Come as you are<span style={{ color: ACCENT }}>.</span></div>\n  <span>Shop the world of Glossier</span>\n</div>`;
  const r = stripUnownedCopy(heroBody, ["THE INVITATION", "Come as you are.", "Shop the world of Glossier"]);
  assert(r.stripped.length === 3, `all three retypes stripped, got ${JSON.stringify(r.stripped)}`);
  assert(!/The Invitation|Come as you are|Shop the world of Glossier/.test(r.code), `no retype survives: ${r.code}`);
  assert(r.residual.length === 0, "clean strip leaves no residual");
});

await check("unownedBindingFields: content-present fields not owned by this element", () => {
  const content = { headline: "H", lede: "L", cta: { primary: "P" }, meta: [{ label: "a", value: "b" }] } as never;
  assert([...unownedBindingFields(content, ["headline", "lede"])].sort().join(",") === "cta,meta", "cta+meta unowned");
  assert(unownedBindingFields(content, ["headline", "lede", "cta", "meta"]).length === 0, "owner binds freely");
  assert(!unownedBindingFields(content, []).includes("bullets"), "fields absent from content are not hunted");
});

await check("stripUnownedBindings: exact child expressions strip (bare, helper-wrapped, indexed)", () => {
  const body = `<div>\n  <h1>{c.headline}</h1>\n  <p>{lastWordAccent(c.lede, ACCENT)}</p>\n  <span>{c.cta.primary}</span>\n  <em>{c.bullets[0]}</em>\n  <b>ours to keep</b>\n</div>`;
  const r = stripUnownedBindings(body, ["headline", "lede", "cta", "bullets"]);
  assert(r.residual.length === 0, `all bindings strippable, residual: ${JSON.stringify(r.residual)}`);
  assert(r.stripped.length === 4, `four fields stripped, got ${JSON.stringify(r.stripped)}`);
  assert(!/c\.(headline|lede|cta|bullets)/.test(r.code), `no unowned binding survives: ${r.code}`);
  assert(r.code.includes("ours to keep"), "unrelated text intact");
});

await check("stripUnownedBindings: attribute references are RESIDUAL (reject); template CHILD expressions strip", () => {
  const body = `<div title={c.headline}><span>{\`— \${c.lede} —\`}</span></div>`;
  const r = stripUnownedBindings(body, ["headline", "lede"]);
  assert(r.residual.includes("headline"), "attribute binding is residual (rejects)");
  assert(r.stripped.includes("lede") && !r.residual.includes("lede"), "a template literal in CHILD position is still a text child — stripped deterministically");
  assert(!/c\.lede/.test(r.code) && /title=\{c\.headline\}/.test(r.code), "child strip applied; attribute left for the repair to remove");
});

await check("stripUnownedBindings: owned fields and c-free bodies untouched", () => {
  const body = `<h1 data-content-path="headline">{c.headline}</h1>`;
  const owned = stripUnownedBindings(body, []);
  assert(owned.code === body && owned.stripped.length === 0 && owned.residual.length === 0, "owner untouched");
  const free = stripUnownedBindings(`<div><span>static</span></div>`, ["headline"]);
  assert(free.code.includes("static") && free.residual.length === 0, "no bindings → no-op");
});

await check("castBuild end-to-end: hero binding theft rejects in-round; repair that drops it ships clean", async () => {
  // Round 1: s0.hero binds the copy element's headline in an ATTRIBUTE
  // (non-strippable → reject). Round 2 (repair): same rich hero without it.
  const thief = RICH_HERO_DEFAULT.replace("<div style={{ display: \"flex\", gap: 8 }}>", "<div aria-label={c.headline} style={{ display: \"flex\", gap: 8 }}>");
  const f = makeFakeCaller((id, nth) => (id === "s0.hero" ? (nth === 1 ? thief : RICH_HERO_DEFAULT) : cannedFor(id, nth)));
  const r = await castBuild(input, { caller: f.caller as never, concurrency: 4 });
  const heroCalls = f.log.filter((l) => l.id === "s0.hero");
  assert(heroCalls.length === 2, `binding theft cost exactly ONE in-round repair, got ${heroCalls.length}`);
  assert(/binds scene copy it does not own/.test(heroCalls[1].user), "the repair prompt names the theft");
  assert(/c\.headline/.test(heroCalls[1].user), "the stolen field is named");
  assert(r.elementOutcomes.some((o) => o.pieceId === "s0.hero" && o.repaired && !o.failed), "repair recovered the hero");
});

// ─── (v15 #3) LIFT INTERIOR REPAINT — a lift never creates a ghost ───────────
// Cycle-6 s0: a washout lift repainted a panel WHITE under WHITE text → a
// white-on-white ghost. The invariant: forceHeroSurfaceLift recolors interior
// text that would ghost against the NEW surface, in the SAME deterministic pass.

/** Does any `color:` in `code` resolve within the ΔL floor of `surfaceHex`? */
const anyGhostText = (code: string, surfaceHex: string, pal: Record<string, string>): boolean => {
  const sl = parseInt(surfaceHex.slice(1, 3), 16) * 0.2126 + parseInt(surfaceHex.slice(3, 5), 16) * 0.7152 + parseInt(surfaceHex.slice(5, 7), 16) * 0.0722;
  const rx = /(?<![A-Za-z-])color\s*:\s*(?:"(#[0-9a-fA-F]{6})"|([A-Z][A-Z0-9_]{2,}))/g;
  for (let m = rx.exec(code); m; m = rx.exec(code)) {
    const hex = m[1] ?? pal[m[2]];
    if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) continue;
    const l = parseInt(hex.slice(1, 3), 16) * 0.2126 + parseInt(hex.slice(3, 5), 16) * 0.7152 + parseInt(hex.slice(5, 7), 16) * 0.0722;
    if (Math.abs(l - sl) < HERO_SURFACE_MIN_DELTA_L) return true;
  }
  return false;
};

await check("lift interior repaint: white text on a lifted-white panel is recolored — the ghost invariant holds", () => {
  const body = `<div style={{ background: CARD_FILL }}><span style={{ color: "#ffffff" }}>Built for you</span></div>`;
  const r = forceHeroSurfaceLift(body, washTheme, { canvasColor: "#101018" });
  assert(r.lifted && r.targetHex === "#ffffff", `panel lifts to white, got ${JSON.stringify({ lifted: r.lifted, hex: r.targetHex })}`);
  assert(r.interiorTextRepaints === 1, `the ghost text is recolored, got ${r.interiorTextRepaints}`);
  assert(!/color: "#ffffff"/.test(r.code), `no white text survives on the white surface: ${r.code}`);
  assert(!anyGhostText(r.code, "#ffffff", washTheme.palette), "INVARIANT: no text remains same-tone as the new surface");
});

await check("lift interior repaint: text that ALREADY contrasts the new surface is left untouched", () => {
  const body = `<div style={{ background: CARD_FILL }}><span style={{ color: "#101018" }}>dark ink</span></div>`;
  const r = forceHeroSurfaceLift(body, washTheme, { canvasColor: "#101018" });
  assert(r.lifted && r.interiorTextRepaints === 0, `contrasting text stays, got ${r.interiorTextRepaints}`);
  assert(/color: "#101018"/.test(r.code), "the dark ink survives verbatim");
});

await check("repaintInteriorTextForSurface: only standalone `color:` moves; backgroundColor / *Color props never do", () => {
  const code = `<div style={{ backgroundColor: "#ffffff", borderColor: "#ffffff", color: "#ffffff" }}>x</div>`;
  const r = repaintInteriorTextForSurface(code, "#ffffff", washTheme);
  assert(r.repaints === 1, `exactly the one text color, got ${r.repaints}`);
  assert(/backgroundColor: "#ffffff"/.test(r.code) && /borderColor: "#ffffff"/.test(r.code), "surface props untouched");
  assert(!/[^A-Za-z-]color: "#ffffff"/.test(r.code), "the text color moved off white");
  // A bare palette const text color resolves + recolors too.
  const bareC = `<div style={{ color: WHITE }}>y</div>`;
  const rb = repaintInteriorTextForSurface(bareC, "#ffffff", washTheme);
  assert(rb.repaints === 1 && !/color: WHITE\b/.test(rb.code), `palette-const text recolors: ${rb.code}`);
});

// ─── (v15 #6a) font-family names join the meta-text vocabulary ────────────────
const nibTheme: Theme = {
  ...theme,
  fonts: { display: '"Nib Pro", serif', body: '"Geist", sans-serif', mono: '"Geist Mono", monospace', fontFaceCss: "" },
};

await check("themeFontFamilyNames: distinctive first-family names extracted; generic keywords skipped", () => {
  const names = themeFontFamilyNames(nibTheme);
  assert(names.includes("Nib Pro") && names.includes("Geist") && names.includes("Geist Mono"), `got ${JSON.stringify(names)}`);
  assert(!names.some((n) => /^(serif|sans-serif|monospace)$/i.test(n)), "generic stack keywords are not names");
  // A purely-generic stack contributes nothing.
  const generic: Theme = { ...theme, fonts: { display: "system-ui, sans-serif", body: "Arial, sans-serif", mono: "monospace", fontFaceCss: "" } };
  assert(themeFontFamilyNames(generic).length === 0, `generic stacks yield no names, got ${JSON.stringify(themeFontFamilyNames(generic))}`);
});

await check("isMetaTextSegment: a font-family name leaking as chrome fires (the 'NIB PRO REGISTRATION' leak); real copy passes", () => {
  const names = themeFontFamilyNames(nibTheme);
  assert(isMetaTextSegment("NIB PRO REGISTRATION", names), "the font-name-as-chrome leak fires");
  assert(isMetaTextSegment("Set in Geist Mono", names), "any face name leaking fires");
  assert(!isMetaTextSegment("NIB PRO REGISTRATION"), "without the name vocab (no theme), it's just copy");
  assert(!isMetaTextSegment("Built for the bold", names), "real brand copy never trips the name arm");
  assert(!isMetaTextSegment("A nibble of progress", names), "a substring inside another word does not trip (word-bounded)");
});

await check("stripMetaText: a leaked font-name text node strips when theme names are supplied", () => {
  const body = `<div><span>NIB PRO REGISTRATION</span><h1>Built for you</h1></div>`;
  const withNames = stripMetaText(body, themeFontFamilyNames(nibTheme));
  assert(withNames.stripped.length === 1 && !withNames.code.includes("NIB PRO"), `font-name node stripped: ${withNames.code}`);
  assert(withNames.code.includes("Built for you"), "real copy survives");
  const without = stripMetaText(body);
  assert(without.stripped.length === 0, "without the name vocab the node is untouched (backward-compatible)");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
