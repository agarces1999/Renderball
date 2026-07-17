/**
 * Tests for the COMPOSITION HEAD — the thinking head of the cast doctrine.
 * No network: the caller is a fake returning canned responses in sequence;
 * the validator is an injected spy (the real composition checks live in
 * schema-validator.ts and arrive by injection — this module never imports it).
 *
 * What it proves:
 *   - the prompt pair carries the full blueprint contract (roles, concrete
 *     subject, hero interior ≥6 with real values, exclusive ownsCopy +
 *     headline-owned-once, motion tied to an interior item, atmosphere ≥6
 *     words differing from neighbors, ONLY-JSON output) plus ONE worked
 *     example branded ILLUSTRATIVE with copying named a validation failure,
 *   - the user prompt carries THIS script's material (brand, palette, notes,
 *     narrative, every scene's content manifest) and demands exactly N
 *     compositions in scene order,
 *   - generateComposition parses robustly (bare JSON, ```json fences, prose
 *     around the array), attaches per scene on COPIES, and runs the injected
 *     validator on the attached scenes,
 *   - validation errors repair-retry with the errors quoted VERBATIM and the
 *     broken output attached; a first-invalid-then-valid run lands attempts=2,
 *   - unparseable output repair-retries into parseable; unparseable through
 *     every attempt THROWS (the only throw),
 *   - terminal validation failure RETURNS the last attempt's scenes plus the
 *     full error log — never throws on validation,
 *   - the head call is effort "high" at maxTokens 28000 (the one call where
 *     thinking is the point; 16k measurably truncated v6's 5-scene head).
 */
import {
  buildCompositionPrompt,
  generateComposition,
  parseCompositionJson,
  HEAD_MAX_TOKENS,
  HEAD_EFFORT,
  WORKED_EXAMPLE,
  type CompositionHeadCall,
} from "./composition-head";
// The one place this suite touches schema-validator: proving the prompt's own
// worked example passes the REAL contract it advertises (never injected into
// composition-head itself — the module stays validator-free by injection).
import { checkSceneComposition } from "./schema-validator";
import type { Script, Scene, SceneComposition } from "../../src/schema";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("composition-head (the thinking head)");

// ─── Fixtures ────────────────────────────────────────────────────────────────

// Minimal-valid script (the `as never` fixture idiom): only the fields the
// head's prompt reads — narrative + per-scene label/register/description/
// visual_concept/content.
const script = {
  narrative: {
    logline: "Founders ship brand videos without an agency.",
    arc: "Open on the cost of the old way, turn on the product, resolve on the invitation.",
    throughline: "a crystal ball that clarifies scene by scene",
  },
  config: { duration_seconds: 12, aspect_ratio: "16:9" },
  assets: { fonts: [], images: [], audio: [], videos: [] },
  scenes: [
    {
      label: "Hook", register: "split",
      description: "The old way burns weeks.",
      visual_concept: "Composition: copy left, a build console right.",
      content: { headline: "Ship the story first", lede: "Approve the narrative before the render.", asset_ids: [] },
      start_seconds: 0, end_seconds: 6,
    },
    {
      label: "Close", register: "quote",
      visual_concept: "Composition: a standalone manifesto line.",
      content: { headline: "Story before render.", asset_ids: [] },
      start_seconds: 6, end_seconds: 12,
    },
  ],
} as unknown as Script;

// A head output that satisfies the contract for both scenes.
const VALID_COMPOSITIONS: SceneComposition[] = [
  {
    elements: [
      {
        role: "hero",
        subject: "the Renderball build console in a browser frame",
        interior: [
          'URL bar "app.renderball.com/builds/rb-2041"',
          'status chip "Rendering — scene 5 of 8"',
          "progress bar at 62%",
          'log line "choreograph: 0 tokens, 41ms"',
          'KPI tile "Build 9:12"',
          'KPI tile "Cost $1.62"',
        ],
        ownsCopy: [],
        motion: "the progress bar fills from 62% as the status chip ticks to scene 6",
      },
      { role: "copy", subject: "the editorial stack", interior: ["headline in display type", "lede beneath"], ownsCopy: ["headline", "lede"], motion: "the headline rises as one block" },
      { role: "atmosphere", subject: "deep navy wash", interior: ["radial glow", "grain"], ownsCopy: [], motion: "the glow pulses on a 4s loop" },
    ],
    atmosphere: "deep navy radial wash with slow drifting film grain",
  },
  {
    elements: [
      { role: "copy", subject: "the manifesto line, centered", interior: ["one display-type line"], ownsCopy: ["headline"], motion: "the line settles with a soft rise" },
      { role: "atmosphere", subject: "charcoal band field", interior: ["parallax bands", "vignette"], ownsCopy: [], motion: "bands drift at different speeds" },
    ],
    atmosphere: "charcoal parallax bands drifting under a luminous vignette center",
  },
];
const VALID_JSON = JSON.stringify(VALID_COMPOSITIONS);

// Same output minus scene 0's hero — what the injected validator flags.
const MISSING_HERO_JSON = JSON.stringify([
  { ...VALID_COMPOSITIONS[0], elements: VALID_COMPOSITIONS[0].elements.filter((e) => e.role !== "hero") },
  VALID_COMPOSITIONS[1],
]);

/** Fake caller: canned responses in call order (last one repeats), full log. */
const makeCaller = (responses: string[]) => {
  const calls: CompositionHeadCall[] = [];
  const caller = async (call: CompositionHeadCall) => {
    calls.push(call);
    return { text: responses[Math.min(calls.length - 1, responses.length - 1)] };
  };
  return { caller, calls };
};

/** Validator spy: canned error lists in call order (last repeats), and every
 *  scenes[] it was handed. */
const makeValidator = (returns: string[][]) => {
  const seen: Scene[][] = [];
  const fn = (scenes: Scene[]): string[] => {
    seen.push(scenes);
    return returns[Math.min(seen.length - 1, returns.length - 1)];
  };
  return { fn, seen };
};

// ─── The prompt ──────────────────────────────────────────────────────────────

const { system, user } = buildCompositionPrompt(script, {
  brandName: "Renderball",
  paletteHint: "deep navy canvas, coral accent #ff7a59",
  designNotes: "quiet chrome, crystal-ball motif",
});

await check("system: the director contract (roles, subject, interior floor, ownership, motion, atmosphere)", () => {
  assert(system.includes("COMPOSITION DIRECTOR"), "director framing");
  assert(system.includes("author the complete blueprint the builders will transcribe"), "the transcription doctrine, verbatim");
  assert(system.includes(`"hero" | "copy" | "atmosphere" | "connector" | "throughline"`), "the role vocabulary");
  assert(system.includes("AT LEAST 6"), "hero interior floor ≥6");
  assert(system.includes("REAL value authored for THIS brand and THIS scene"), "real-values demand");
  assert(system.includes("NEVER sample, masked, or placeholder values"), "anti-placeholder/anti-mask demand");
  assert(system.includes("Ownership is exclusive"), "ownsCopy exclusivity");
  assert(system.includes("headline is owned EXACTLY once"), "headline owned exactly once");
  assert(system.includes("tied BY NAME to an item in that element's interior list"), "motion tied to a named interior item");
  assert(system.includes("at least 6 words") && system.includes("MUST differ from the adjacent scenes"), "atmosphere floor + anti-repeat");
  assert(system.includes("ONLY JSON") && system.includes("in scene order"), "output contract: only JSON, scene order");
});

await check("system: ONE worked example, branded ILLUSTRATIVE, copying = validation failure", () => {
  assert(system.includes("WORKED EXAMPLE") && system.includes("UNRELATED brand"), "example present, unrelated brand");
  assert(system.includes("Brewline"), "the example's fictional brand");
  assert(system.includes("ILLUSTRATIVE — your values must come from this script's content and brand"), "illustrative note");
  assert(system.includes("copying any example value is a validation failure"), "copying named a validation failure");
  assert((system.match(/WORKED EXAMPLE/g) ?? []).length === 1, "exactly ONE example (more = more leakage surface)");
});

await check("system: the v11 full-bleed vertical-fill clause is STATED (cycle-2 s4 barbell class)", () => {
  assert(system.includes("FULL-BLEED VERTICAL FILL"), "clause present");
  assert(system.includes("UPPER third") && system.includes("LOWER third"), "upper+lower-third inventory demand");
  assert(/barbell/.test(system), "the barbell consequence is named");
  assert(/fails a blocking gate/.test(system), "the gate consequence is named (models comply better with a stated sensor)");
});

await check("system: the v12 mock-territory clause — a full-canvas app shell forfeits the copy column (cycle-3 s1 interleave)", () => {
  assert(system.includes("MOCK TERRITORY"), "clause present");
  assert(system.includes("the mock FORFEITS the copy column"), "the forfeit rule stated");
  assert(system.includes("never author a full-canvas app shell on such a scene"), "full-canvas shells banned when a copy element exists");
  assert(/fails a blocking collision gate/.test(system), "the collision-gate consequence named");
  assert(system.includes("author the copy as interior items ON one of the shell's own panels"), "the full-canvas escape hatch stated");
});

await check("system: the bookend-hero density contract + interior/ownsCopy ownership rule are STATED (retry audit classes 1+9)", () => {
  assert(system.includes("AT LEAST 4 of a hero's items must CARRY TEXT"), "hero text-bearing floor stated");
  assert(system.includes("NESTED structure"), "nested-structure demand stated");
  assert(system.includes("must NEVER contain the text of any copy field an element ownsCopy"), "the ownership rule the validator enforces is stated");
  assert(system.includes("reference the WIDGET, not the words"), "widget-not-words phrasing present");
  assert(system.includes("no interior[] item anywhere in the scene may restate it"), "ownsCopy bullet amended");
});

await check("system: the v9 washout contract — hero surface tone must CONTRAST with the scene canvas", () => {
  assert(system.includes("SURFACE CONTRAST"), "surface-contrast clause present");
  assert(
    system.includes("if the scene canvas is dark, the hero's primary panel must be a light surface or carry high-luminance content"),
    "the concrete dark-canvas rule, verbatim",
  );
  assert(system.includes("renders as a washout and is a validation failure"), "washout named a validation failure");
});

await check("system: the v9 over-compliance line — copy widgets described concretely, never 'placeholder'", () => {
  assert(system.includes("Describe the copy widget CONCRETELY"), "copy-widget concreteness line present");
  assert(system.includes(`"headline set in display type"`), "the worked phrasing");
  assert(system.includes(`NEVER with the word "placeholder"`), "the word 'placeholder' banned explicitly");
});

await check("system: the v9 adjacent-scene variety clause (archetype ≤2 in a row, vary artifact + side)", () => {
  assert(system.includes("ADJACENT-SCENE VARIETY"), "variety clause present");
  assert(system.includes("more than 2 in a row"), "the 2-in-a-row bound stated");
  assert(system.includes("implied placement side"), "hero placement side named");
});

await check("system: the v9 mock-value carve-out — diegetic set dressing is plausible+concrete, masks are failures", () => {
  assert(system.includes("set dressing, not marketing claims"), "carve-out stated");
  assert(system.includes(`"$— — —"`) && system.includes(`"•••"`), "masked forms named as failures");
});

await check("system: the v10 accent-discipline clause — accent is punctuation, never a panel fill", () => {
  assert(system.includes("ACCENT DISCIPLINE"), "accent-discipline clause present");
  assert(/accent is PUNCTUATION/.test(system), "the punctuation doctrine stated");
  assert(system.includes("never a panel fill"), "panel fills banned verbatim");
  assert(/deterministic gate rejects/.test(system), "the gate consequence named");
});

await check("system: the v10 attempt-1 negative example (placeholder 'A1' → concrete product card)", () => {
  assert(system.includes("CONCRETENESS ON ATTEMPT 1"), "attempt-1 concreteness block present");
  assert(system.includes(`product card placeholder "A1"`), "the BAD form quoted");
  assert(system.includes(`product card "Mountain Water 12-pack — $14.99"`), "the GOOD form quoted");
  assert(/BAD:.*GOOD:/s.test(system), "framed as a BAD→GOOD contrast pair");
});

await check("the Brewline worked example COMPLIES with the contract the prompt states (validator-verified)", () => {
  // The prompt's own exemplar must pass the validator it advertises (retry
  // audit class 9: blueprint attempt-1 failed 100% of builds on a rule the
  // prompt itself modeled violating). Attach the example to a synthetic
  // Brewline scene whose content carries the fields the example owns.
  const example = JSON.parse(WORKED_EXAMPLE) as SceneComposition[];
  const brewScene = [{
    index: 0,
    label: "Checkout",
    visual_concept: "The Brewline checkout in a phone frame, editorial stack left.",
    content: {
      eyebrow: "NEVER RUN DRY",
      headline: "Your next bag ships itself",
      lede: "Fresh beans on your schedule, not the store's.",
      asset_ids: [],
    },
    composition: example[0],
  }] as unknown as Scene[];
  const errors = checkSceneComposition(brewScene);
  assert(errors.length === 0, `the worked example must pass its own contract, got ${JSON.stringify(errors)}`);
  // The hero's text-bearing floor is met with margin.
  const hero = example[0].elements.find((e) => e.role === "hero")!;
  const textBearing = hero.interior.filter((i) => /\d/.test(i) || /["'“”‘’][^"'“”‘’]*["'“”‘’]/.test(i)).length;
  assert(textBearing >= 4, `hero example must model ≥4 text-bearing items, got ${textBearing}`);
  // v9 washout contract: the example MODELS the surface-tone item (a light
  // surface named against the roast-brown wash).
  assert(
    hero.interior.some((i) => /\boff-white\b/i.test(i)),
    "the hero example must model the named contrasting surface tone",
  );
  // v9 over-compliance: no interior anywhere says "placeholder"; the copy
  // widget is described concretely.
  const allItems = example[0].elements.flatMap((e) => e.interior);
  assert(!allItems.some((i) => /placeholder/i.test(i)), "no example interior may contain the word 'placeholder'");
  assert(!allItems.some((i) => /[•●]{2,}|[—–]\s?[—–]|\$\s?[—–]/.test(i)), "no example interior may carry a masked value");
  // No interior anywhere retypes the owned eyebrow/headline/lede text.
  const copyEl = example[0].elements.find((e) => e.role === "copy")!;
  assert(!copyEl.interior.some((i) => /NEVER RUN DRY/i.test(i)), "the copy element must reference the widget, not the words");
});

await check("user: THIS script's material — brand, palette, notes, narrative, every scene", () => {
  assert(user.includes("Brand: Renderball"), "brand name");
  assert(user.includes("coral accent #ff7a59"), "palette hint");
  assert(user.includes("crystal-ball motif"), "design notes");
  assert(user.includes("throughline motif: a crystal ball that clarifies scene by scene"), "narrative throughline threaded");
  assert(user.includes(`Scene 0 — "Hook" (register split)`) && user.includes(`Scene 1 — "Close" (register quote)`), "scenes in order with registers");
  assert(user.includes('"Ship the story first"') && user.includes('"Story before render."'), "content manifests verbatim");
  assert(user.includes("intent: The old way burns weeks."), "scene description rides along");
  assert(user.includes("ALL 2 scenes") && user.includes("exactly 2 SceneComposition objects"), "count demanded twice");
});

await check("user: empty opts leak nothing (no 'undefined', no dangling labels)", () => {
  const bare = buildCompositionPrompt(script).user;
  assert(!bare.includes("undefined"), "no undefined leakage");
  assert(!bare.includes("Brand:") && !bare.includes("Palette:") && !bare.includes("Design notes:"), "absent opts emit no lines");
});

// ─── Parsing ─────────────────────────────────────────────────────────────────

await check("parseCompositionJson: bare JSON, ```json fence, prose-wrapped array all parse", () => {
  for (const text of [
    VALID_JSON,
    `Here is the blueprint:\n\`\`\`json\n${VALID_JSON}\n\`\`\`\nDone.`,
    `Sure — the compositions follow.\n${VALID_JSON}\nLet me know.`,
    JSON.stringify({ scenes: VALID_COMPOSITIONS }), // the courtesy wrapper
  ]) {
    const r = parseCompositionJson(text);
    assert(Array.isArray(r), `should parse: ${text.slice(0, 40)}…`);
    assert((r as SceneComposition[]).length === 2, "both scenes present");
  }
});

await check("parseCompositionJson: prose-only and non-composition JSON report errors", () => {
  const prose = parseCompositionJson("I would recommend a split layout for scene one.");
  assert(!Array.isArray(prose) && "error" in prose, "prose is an error");
  const wrong = parseCompositionJson(`["a", "b"]`);
  assert(!Array.isArray(wrong) && (wrong as { error: string }).error.includes("elements"), "items must carry elements[]");
});

// ─── generateComposition ─────────────────────────────────────────────────────

await check("happy path: attempts=1, errors=[], compositions attached in scene order, input unmutated", async () => {
  const fake = makeCaller([VALID_JSON]);
  const spy = makeValidator([[]]);
  const r = await generateComposition({ script, caller: fake.caller, validate: spy.fn });
  assert(r.attempts === 1, `attempts=1 expected, got ${r.attempts}`);
  assert(r.errors.length === 0, `no errors expected, got ${JSON.stringify(r.errors)}`);
  assert(r.scenes.length === 2, "both scenes returned");
  assert(r.scenes[0].composition?.elements.some((e) => e.role === "hero") === true, "scene 0 got the hero-bearing composition");
  assert(r.scenes[0].composition?.atmosphere === VALID_COMPOSITIONS[0].atmosphere, "scene 0 atmosphere attached");
  assert(r.scenes[1].composition?.atmosphere === VALID_COMPOSITIONS[1].atmosphere, "scene 1 atmosphere attached (order held)");
  assert(r.scenes[0].label === "Hook", "scene fields survive the attach");
  assert(script.scenes[0].composition === undefined, "the INPUT script is never mutated");
  assert(spy.seen.length === 1, "validator ran exactly once");
  assert(spy.seen[0][0].composition !== undefined, "validator received scenes WITH compositions attached");
});

await check("head call shape: effort high, maxTokens 28000 — the one call where thinking is the point", async () => {
  const fake = makeCaller([VALID_JSON]);
  await generateComposition({ script, caller: fake.caller });
  assert(fake.calls[0].effort === "high" && HEAD_EFFORT === "high", "effort high");
  // 28000, not 16000: v6's Klarna head truncated attempts 1-2 at exactly 16k.
  assert(fake.calls[0].maxTokens === 28000 && HEAD_MAX_TOKENS === 28000, "maxTokens 28000");
  assert(fake.calls[0].system.includes("COMPOSITION DIRECTOR"), "the director system prompt shipped");
});

await check("validation repair: missing hero flagged → repair quotes it VERBATIM → attempts=2", async () => {
  const fake = makeCaller([MISSING_HERO_JSON, VALID_JSON]);
  const spy = makeValidator([["scene 0: no hero element in the composition"], []]);
  const r = await generateComposition({ script, caller: fake.caller, validate: spy.fn });
  assert(r.attempts === 2, `attempts=2 expected, got ${r.attempts}`);
  assert(r.scenes[0].composition?.elements.some((e) => e.role === "hero") === true, "the VALID second attempt's scenes returned");
  assert(r.errors.some((e) => e.includes("scene 0: no hero element in the composition")), "error log carries the flag");
  const repair = fake.calls[1].user;
  assert(repair.includes("- scene 0: no hero element in the composition"), "repair quotes the error VERBATIM");
  assert(repair.includes("--- previous output ---") && repair.includes(MISSING_HERO_JSON), "repair carries the broken output");
  assert(repair.includes("COMPLETE corrected JSON array"), "repair demands a full re-emit, not a diff");
  assert(spy.seen.length === 2, "validator ran on both attempts");
});

await check("unparseable → repair → parseable: prose first response recovers on attempt 2", async () => {
  const fake = makeCaller(["I think scene one should feel urgent, with a console motif.", VALID_JSON]);
  const spy = makeValidator([[]]);
  const r = await generateComposition({ script, caller: fake.caller, validate: spy.fn });
  assert(r.attempts === 2, `attempts=2 expected, got ${r.attempts}`);
  assert(r.scenes[0].composition !== undefined, "compositions attached from the recovered attempt");
  assert(fake.calls[1].user.includes("Your previous output FAILED"), "repair prompt sent");
  assert(spy.seen.length === 1, "validator never sees an unparseable attempt");
});

await check("unparseable through every attempt THROWS (the only throw)", async () => {
  const fake = makeCaller(["no json here", "still prose", "and again"]);
  let threw: Error | null = null;
  try { await generateComposition({ script, caller: fake.caller, maxAttempts: 3 }); }
  catch (e) { threw = e as Error; }
  assert(threw !== null, "must throw");
  assert(/unparseable after 3 attempts/.test(threw!.message), `message names the condition: ${threw!.message}`);
  assert(fake.calls.length === 3, "all attempts spent");
});

await check("terminal validation failure RETURNS last scenes + error log — never throws", async () => {
  const fake = makeCaller([MISSING_HERO_JSON]);
  const spy = makeValidator([["scene 0: no hero element in the composition"]]);
  const r = await generateComposition({ script, caller: fake.caller, validate: spy.fn, maxAttempts: 2 });
  assert(r.attempts === 2, `attempts=2 expected, got ${r.attempts}`);
  assert(r.scenes[0].composition !== undefined, "LAST attempt's scenes returned (caller decides fallback)");
  assert(!r.scenes[0].composition!.elements.some((e) => e.role === "hero"), "…and they are the flagged ones, honestly");
  assert(r.errors.length === 2, `one error per attempt, got ${JSON.stringify(r.errors)}`);
  assert(r.errors[0].startsWith("attempt 1:") && r.errors[1].startsWith("attempt 2:"), "log names the attempts");
});

await check("scene-count mismatch is a structural error: repaired like validation, attach stays positional", async () => {
  const one = JSON.stringify([VALID_COMPOSITIONS[0]]); // 1 composition, 2 scenes
  const fake = makeCaller([one, VALID_JSON]);
  const r = await generateComposition({ script, caller: fake.caller });
  assert(r.attempts === 2, `attempts=2 expected, got ${r.attempts}`);
  assert(r.errors.some((e) => e.includes("returned 1 compositions for 2 scenes")), "structural error logged");
  assert(fake.calls[1].user.includes("returned 1 compositions for 2 scenes"), "…and quoted verbatim in the repair");
  assert(r.scenes[1].composition?.atmosphere === VALID_COMPOSITIONS[1].atmosphere, "recovered attempt attached fully");
});

await check("maxAttempts defaults to 3", async () => {
  const fake = makeCaller([VALID_JSON]);
  const spy = makeValidator([["always broken"]]);
  const r = await generateComposition({ script, caller: fake.caller, validate: spy.fn });
  assert(r.attempts === 3, `default 3 attempts expected, got ${r.attempts}`);
  assert(fake.calls.length === 3 && r.errors.length === 3, "one call + one logged error per attempt");
});

// ─── Frame-authoring: the head composes the whole frame ──────────────────────

await check("system: the FRAME COMPOSITION clause — the head composes the whole frame", () => {
  assert(system.includes("FRAME COMPOSITION"), "frame-composition section present");
  assert(system.includes("1920×1080"), "the 16:9 canvas is stated");
  assert(system.includes("ONE DOMINANT FOCAL OBJECT"), "the dominant-focal rule");
  assert(system.includes("DELIBERATE NEGATIVE SPACE"), "the negative-space rule");
  assert(system.includes("SINGULARITY BUDGET"), "the brand-mark/CTA budget rule");
  assert(system.includes("optical center"), "optical-center placement demand");
  assert(/corner/i.test(system), "the corner-cluster defect named");
  assert(system.includes("focalRank") && system.includes("bounds"), "per-element focalRank + bounds named");
  assert(system.includes("negativeSpace") && system.includes("budget"), "scene-level negativeSpace + budget named");
});

await check("output contract + user carry the new frame fields + the canvas", () => {
  assert(
    system.includes(`"focalRank"`) && system.includes(`"bounds"`) && system.includes(`"negativeSpace"`) && system.includes(`"budget"`),
    "the OUTPUT shape lists focalRank/bounds/negativeSpace/budget",
  );
  assert(user.includes("Canvas: 1920×1080"), "the user prompt states the 16:9 canvas");
});

await check("buildCompositionPrompt threads the canvas per aspect (9:16 = 1080×1920)", () => {
  const vertical = buildCompositionPrompt(script, { aspect: "9:16" });
  assert(vertical.system.includes("1080×1920"), "vertical canvas in the system prompt");
  assert(vertical.user.includes("Canvas: 1080×1920"), "vertical canvas in the user prompt");
});

await check("WORKED_EXAMPLE carries head-authored bounds + focalRank + negativeSpace + budget", () => {
  const scene = (JSON.parse(WORKED_EXAMPLE) as SceneComposition[])[0] as SceneComposition & {
    negativeSpace?: string;
    budget?: { brandMark: string; cta: string };
  };
  assert(typeof scene.negativeSpace === "string" && scene.negativeSpace.trim().split(/\s+/).length >= 4, "negativeSpace present, ≥4 words");
  assert(!!scene.budget && typeof scene.budget.brandMark === "string" && typeof scene.budget.cta === "string", "budget { brandMark, cta } present");
  const hero = scene.elements.find((e) => e.role === "hero")!;
  const copy = scene.elements.find((e) => e.role === "copy")!;
  assert(hero.focalRank === 1, "the hero is focalRank 1");
  assert(!!hero.bounds && !!copy.bounds, "hero + copy carry pixel bounds");
  const cx = hero.bounds!.x + hero.bounds!.w / 2;
  assert(Math.abs(cx - 960) <= 0.4 * 1920, "the focal hero is near the optical center, not corner-jammed");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
