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
const HERO_TEAL = `<div style={{ width: "100%", height: "100%", background: PANEL_BG, borderRadius: 16, border: "1px solid", borderColor: HAIRLINE }}>
  <svg viewBox="0 0 100 60" style={{ width: "100%" }}><path d="M0 50 L30 20 L60 35 L100 5" stroke="#2dd4bf" fill="none" strokeWidth="2" /></svg>
  <div>${LEDE}</div>
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
// post-pass must rebase it to the wrapper origin.
const SELF_POS_HERO = `<div style={{ position: "absolute", left: 1020, top: 280, width: 780, height: 520, background: PANEL_BG, borderRadius: 12 }}>
  <span style={{ fontFamily: FONT_MONO, fontSize: 13, color: INK }}>Deals pipeline</span>
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
 *  (user prompt, routed effort, and the per-slot maxTokens cap). */
const makeFakeCaller = () => {
  const callCounts = new Map<string, number>();
  const log: { id: string; user: string; effort?: string; maxTokens: number }[] = [];
  const state = { inFlight: 0, maxInFlight: 0, calls: 0 };
  const caller = async (call: { system: string; user: string; maxTokens: number; effort?: string }) => {
    state.inFlight++;
    state.calls++;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    try {
      await new Promise((r) => setTimeout(r, 5)); // force real overlap
      const id = /piece id "([^"]+)"/.exec(call.user)?.[1] ?? "?";
      const nth = (callCounts.get(id) ?? 0) + 1;
      callCounts.set(id, nth);
      log.push({ id, user: call.user, effort: call.effort, maxTokens: call.maxTokens });
      return { text: cannedFor(id, nth), thinking: "", inputTokens: 50, outputTokens: 100, seconds: 0.005, stopReason: "stop" };
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
  assert(repairCall.user.includes("Emit corrected JSX only."), "repair prompt asks for corrected JSX only");
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
