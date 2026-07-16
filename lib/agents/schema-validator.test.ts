/**
 * Regression tests for headlineProblem (QA S4) — hero headlines must be one
 * punchy clause, not a crammed headline+subhead. Run: `npm test`.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  headlineProblem,
  findUngroundedClaims,
  findUngroundedStageLabels,
  extractStatClaims,
  validateScript,
  findTypeOnlyScenes,
  normalizeScriptContent,
  backfillSceneRegisters,
  checkScriptRichness,
  latestExplicitBeat,
  countDrawableNouns,
  countInteriorSpecifics,
  BEAT_COVERAGE_MIN_FRACTION,
  checkSceneComposition,
  TEMPLATE_LEAK_RX,
} from "./schema-validator";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : err}`); }
};
const assert = (cond: boolean, msg: string) => { if (!cond) throw new Error(msg); };

check("clean punchy headline → null", () => {
  assert(headlineProblem("Murder Your Thirst") === null, "LD headline should pass");
  assert(headlineProblem("Payments for the internet") === null, "Stripe headline should pass");
});

check("single long-ish clause (47c) → null", () => {
  assert(headlineProblem("Configure each workspace to match your workflow") === null, "single clause OK");
});

check("Fuse two-sentence cram (50c) → flagged", () => {
  const p = headlineProblem("Building takes years. Buying means losing control.");
  assert(p !== null && /two sentences/.test(p), `expected two-sentence flag, got ${p}`);
});

check("Fuse two-sentence cram (59c) → flagged", () => {
  const p = headlineProblem("Open loans & accounts like a Fintech. Without becoming one.");
  assert(p !== null && /two sentences/.test(p), `expected two-sentence flag, got ${p}`);
});

check("short stylistic two-beat (24c) → allowed", () => {
  assert(headlineProblem("Move fast. Break things.") === null, "short two-beat should pass");
});

check("paragraph (>72c) → flagged for length", () => {
  const long = "This is an extremely long headline that reads like a full paragraph and keeps going well past any reasonable hero limit";
  const p = headlineProblem(long);
  assert(p !== null && /cap at 72/.test(p), `expected length flag, got ${p}`);
});

// ── S5: ungrounded numeric claims ────────────────────────────────────
check("flags a stat not in the source", () => {
  const u = findUngroundedClaims("We process $840M every year. 99.97% uptime.", "Fuse helps banks move money.");
  assert(u.includes("$840M") && u.some((t) => t.includes("99.97")), `expected both flagged, got ${JSON.stringify(u)}`);
});
check("grounded stat (digits present in source) → not flagged", () => {
  const u = findUngroundedClaims("$840M processed annually", "We process $840M in volume across 2.4 million accounts.");
  assert(u.length === 0, `expected none, got ${JSON.stringify(u)}`);
});
check("digit-core match grounds a variant", () => {
  const u = findUngroundedClaims("$2.4M in fees", "serving 2.4 million customers");
  assert(u.length === 0, `2.4 present in source → grounded, got ${JSON.stringify(u)}`);
});
check("bare integers / years / qualitative copy are NOT flagged", () => {
  const u = findUngroundedClaims("5 sourcing principles, 3 weeks, founded 2024, Millions joined", "");
  assert(u.length === 0, `expected none, got ${JSON.stringify(u)}`);
});
check("multiplier + percent are stat-shaped and checked", () => {
  const u = findUngroundedClaims("10x faster", "");
  assert(u.includes("10x"), `expected 10x flagged, got ${JSON.stringify(u)}`);
});

// ── S5 tightened (the fabricated-38ms fix): full-token grounding ─────────
// Raycast's crawl says "Fast. Think in milliseconds." and "99.8% crash-free
// rate" — it contains NO latency number. Sonnet invented "38ms" / "38ms p50"
// at script time and the old digit-core matching let lookalike digits launder
// such fabrications. These pin the full-token behavior.
const RAYCAST_CRAWL =
  "Fast. Think in milliseconds. Ergonomic. Keyboard First. Native. Pure performance. Reliable. 99.8% crash-free rate.";

check("38ms-style fabricated latency → flagged (crawl has no latency number)", () => {
  const u = findUngroundedClaims("38ms Raycast executes in 38ms p50", RAYCAST_CRAWL);
  assert(u.includes("38ms"), `expected 38ms flagged, got ${JSON.stringify(u)}`);
  assert(u.includes("p50"), `expected p50 flagged, got ${JSON.stringify(u)}`);
});

check("99.8% crawl-grounded → accepted", () => {
  const u = findUngroundedClaims("99.8% crash-free", RAYCAST_CRAWL);
  assert(u.length === 0, `99.8% is in the crawl → grounded, got ${JSON.stringify(u)}`);
});

check("prompt-grounded duration ('30-second') → accepted", () => {
  const u = findUngroundedClaims(
    "Your story in 30 seconds. A 30-second launch.",
    "A 30-second video for Raycast — a blazing-fast launcher.",
  );
  assert(u.length === 0, `30s duration is in the prompt → grounded, got ${JSON.stringify(u)}`);
});

check("digit-core lookalikes do NOT cross-ground", () => {
  // "3x" must not ground on the "3" inside "30-second".
  const a = findUngroundedClaims("3x faster", "A 30-second video for Raycast.");
  assert(a.includes("3x"), `expected 3x flagged, got ${JSON.stringify(a)}`);
  // "38ms" must not ground on a unitless "38".
  const b = findUngroundedClaims("38ms", "Browse all 38 extensions in the store.");
  assert(b.includes("38ms"), `expected 38ms flagged, got ${JSON.stringify(b)}`);
  // "10x" must not ground on the "10" inside "2010" (old digit-core bug).
  const c = findUngroundedClaims("10x faster", "Trusted since 2010.");
  assert(c.includes("10x"), `expected 10x flagged, got ${JSON.stringify(c)}`);
  // "99.8%" must not ground on a bare "99.8" with a different unit.
  const d = findUngroundedClaims("99.8% uptime", "scored 99.8 in the benchmark");
  assert(d.some((t) => t.includes("99.8")), `expected 99.8% flagged, got ${JSON.stringify(d)}`);
});

check("full token grounds across unit spellings", () => {
  assert(
    findUngroundedClaims("38ms response", "executes in 38 ms flat").length === 0,
    "38ms should ground on '38 ms'",
  );
  assert(
    findUngroundedClaims("responds in 200 milliseconds", "200ms cold start").length === 0,
    "'200 milliseconds' should ground on '200ms'",
  );
  assert(
    findUngroundedClaims("10x faster", "10 times faster than stock").length === 0,
    "10x should ground on '10 times'",
  );
  assert(
    findUngroundedClaims("p99 latency under control", "our p99 stays flat").length === 0,
    "p99 should ground on a literal p99",
  );
});

check("extractStatClaims pulls full stat tokens, skips safe forms", () => {
  const t = extractStatClaims(
    "38ms p50, 99.8% crash-free, $2.4M raised, 10x faster, founded 2024, 3 weeks, 5 principles",
  );
  assert(t.includes("38ms"), `expected 38ms, got ${JSON.stringify(t)}`);
  assert(t.includes("p50"), `expected p50, got ${JSON.stringify(t)}`);
  assert(t.includes("99.8%"), `expected 99.8%, got ${JSON.stringify(t)}`);
  assert(t.includes("$2.4M"), `expected $2.4M, got ${JSON.stringify(t)}`);
  assert(t.includes("10x"), `expected 10x, got ${JSON.stringify(t)}`);
  assert(
    !t.some((x) => /2024|weeks|principles/.test(x)),
    `years/durations/ordinals must be out of scope, got ${JSON.stringify(t)}`,
  );
});

// ── G5: ungrounded funding-stage labels ──────────────────────────────────
check("flags an invented 'Series C' (corgi: brief only says funding round)", () => {
  const u = findUngroundedStageLabels(
    "Corgi just raised $250M. Series C.",
    "Announce Corgi's $250M funding round and introduce the product.",
  );
  assert(u.length === 1 && /series c/i.test(u[0]), `expected Series C, got ${JSON.stringify(u)}`);
});
check("a grounded stage (stated in source) → not flagged", () => {
  const u = findUngroundedStageLabels("Our Series B is closed", "We just closed our Series B round.");
  assert(u.length === 0, `expected none, got ${JSON.stringify(u)}`);
});
check("pre-seed grounded across hyphen/space normalization", () => {
  const u = findUngroundedStageLabels("Built at pre-seed", "raised at preseed stage");
  assert(u.length === 0, `expected none (normalized match), got ${JSON.stringify(u)}`);
});
check("ordinary copy with 'series of' / 'a series' is NOT flagged", () => {
  const u = findUngroundedStageLabels("a series of breakthroughs, Series Capital partners", "");
  assert(u.length === 0, `expected none, got ${JSON.stringify(u)}`);
});
check("flags growth/bridge round when unsupported; dedupes", () => {
  const u = findUngroundedStageLabels("Closed a growth round. The growth round scales us.", "");
  assert(u.length === 1 && /growth round/i.test(u[0]), `expected one growth round, got ${JSON.stringify(u)}`);
});

// ── CTA must not echo the headline (SCENE-QA P7) ─────────────────────────────
// A two-scene script whose final scene carries a cta. Override its headline /
// cta.primary per test; everything else is a minimal valid script. The
// fixtures are DELIBERATELY minimal (stored-script shaped), so these calls
// pass { richness: false } — the richness contract has its own suite below.
const RICHNESS_OFF = { richness: false } as const;
const scriptWithCta = (headline: string, ctaPrimary: string | undefined) => ({
  config: { duration_seconds: 10, aspect_ratio: "16:9" },
  brief: {},
  assets: [],
  scenes: [
    {
      start_seconds: 0,
      end_seconds: 5,
      label: "Hook",
      visual_concept: "Opening hook on a dark field.",
      content: { headline: "The problem, stated", asset_ids: [] },
    },
    {
      start_seconds: 5,
      end_seconds: 10,
      label: "CTA",
      visual_concept: "Closing call to action, brand-color pill.",
      content: {
        headline,
        ...(ctaPrimary !== undefined ? { cta: { primary: ctaPrimary } } : {}),
        asset_ids: [],
      },
    },
  ],
});

check("CTA primary equal to the headline is flagged (the Ramp defect)", () => {
  const r = validateScript(scriptWithCta("See how Ramp works", "See how Ramp works"), RICHNESS_OFF);
  assert(!r.ok && /duplicates the headline/.test(r.error), `got ${JSON.stringify(r)}`);
});

check("CTA duplication is caught case/space-insensitively", () => {
  const r = validateScript(scriptWithCta("Get Started Today", "  get started today "), RICHNESS_OFF);
  assert(!r.ok && /duplicates the headline/.test(r.error), `got ${JSON.stringify(r)}`);
});

check("a distinct verb-led CTA passes", () => {
  const r = validateScript(scriptWithCta("See how Ramp works", "Get a demo"), RICHNESS_OFF);
  assert(r.ok, `expected ok, got ${JSON.stringify(r)}`);
});

check("a scene with no cta is a no-op for the duplication check", () => {
  const r = validateScript(scriptWithCta("See how Ramp works", undefined), RICHNESS_OFF);
  assert(r.ok, `expected ok, got ${JSON.stringify(r)}`);
});

// ── Visual richness: every scene needs a diegetic element (findTypeOnlyScenes) ──
// Fixtures mirror the real specimens: Fuse ② manifesto (01KV37AP…) scenes 0/2
// are type-only and MUST flag; its scenes 1/3/4 and all Tailscale (01KTVZE8…)
// scenes name a diegetic element and MUST pass.
const vc = (visual_concept: string) => ({ visual_concept });

check("type-only headline + ember/glow/hairline is flagged (Fuse scene 0)", () => {
  const s = [vc("A near-black field with a small ember-spark lower-left. A massive display headline 'Built to last. Not to wait.' sits upper-two-thirds. A thin hairline anchors beneath. Animations: headline fadeRise; ember flickers; radial glow loops.")];
  assert(JSON.stringify(findTypeOnlyScenes(s)) === "[0]", `got ${JSON.stringify(findTypeOnlyScenes(s))}`);
});

check("'single enormous manifesto line on a dark field' is flagged (Fuse scene 2)", () => {
  const s = [vc("Edge-to-edge dark field. A single enormous manifesto line fills the frame: 'Move like a Fintech.' The ember glows large behind 'Fintech'. Light rays drift.")];
  assert(JSON.stringify(findTypeOnlyScenes(s)) === "[0]", `got ${JSON.stringify(findTypeOnlyScenes(s))}`);
});

check("a scene with a diegetic panel passes (Fuse scene 1)", () => {
  const s = [vc("Left half holds a beveled legacy origination panel titled 'LOAN ORIGINATION' with pending rows. Right half holds an editorial headline.")];
  assert(findTypeOnlyScenes(s).length === 0, `got ${JSON.stringify(findTypeOnlyScenes(s))}`);
});

check("a logo trust-bar passes; a CTA logo passes", () => {
  const s = [
    vc("Centered headline 'Over 100 already are.' Below it a horizontal trust-bar of partner logos in rounded frames."),
    vc("Center-frame the Fuse logo with a glow, a CTA line beneath, then an accent bar and a URL."),
  ];
  assert(findTypeOnlyScenes(s).length === 0, `got ${JSON.stringify(findTypeOnlyScenes(s))}`);
});

check("diagram / mesh / mockup all pass (Tailscale-style)", () => {
  const s = [
    vc("A chaotic network diagram fills the canvas — six device nodes with tangled red connection lines."),
    vc("A clean hexagonal mesh of nodes with a center checkmark."),
    vc("Split layout: a laptop mockup showing the status popup with a device list; three text blocks right."),
  ];
  assert(findTypeOnlyScenes(s).length === 0, `got ${JSON.stringify(findTypeOnlyScenes(s))}`);
});

check("a lone accent hairline does NOT count as diegetic", () => {
  const s = [vc("A bold headline with a thin accent hairline underneath and a soft gradient wash.")];
  assert(JSON.stringify(findTypeOnlyScenes(s)) === "[0]", `got ${JSON.stringify(findTypeOnlyScenes(s))}`);
});

check("empty visual_concept is not flagged (false-negative direction)", () => {
  assert(findTypeOnlyScenes([vc(""), vc("   ")]).length === 0, "empty should not flag");
});

check("returns the correct mixed indices across a sequence", () => {
  const s = [
    vc("A dashboard panel with rows."),               // 0 pass
    vc("A giant headline over an ember glow field."),  // 1 flag
    vc("A bar chart of revenue over time."),           // 2 pass
    vc("One enormous manifesto line on a dark frame."),// 3 flag
  ];
  assert(JSON.stringify(findTypeOnlyScenes(s)) === "[1,3]", `got ${JSON.stringify(findTypeOnlyScenes(s))}`);
});

// ── normalizeScriptContent: strip prose-as-value KPI meta ──────────────────
// The Stripe overnight build emitted meta values that were DESCRIPTIONS, not
// numbers — {label:"Volume", value:"in payments volume processed in 2025"} —
// rendering KPI tiles with blank number slots. The normalizer drops them.
const metaScenes = (meta: { label: string; value: string }[]) => ({
  scenes: [{ content: { headline: "The scale", meta } }],
});
const firstMeta = (out: unknown): unknown =>
  ((out as { scenes?: { content?: { meta?: unknown } }[] }).scenes?.[0].content?.meta);

check("normalizeScriptContent drops prose-as-value KPI entries", () => {
  const out = normalizeScriptContent(
    metaScenes([
      { label: "Volume", value: "in payments volume processed in 2025" },
      { label: "Subscriptions", value: "active subscriptions on Stripe Billing" },
      { label: "Fortune 100", value: "50% have used Stripe to grow" },
    ]),
  );
  // All three values are phrases → all dropped → meta key removed entirely.
  assert(firstMeta(out) === undefined, `expected meta removed, got ${JSON.stringify(firstMeta(out))}`);
});

check("normalizeScriptContent keeps terse numeric/datum values", () => {
  const kept = [
    { label: "Total volume", value: "$1.4T" },
    { label: "Uptime", value: "99.99%" },
    { label: "Stage", value: "Series B" },
    { label: "Date", value: "Mar 2025" },
  ];
  const out = normalizeScriptContent(metaScenes(kept));
  assert(JSON.stringify(firstMeta(out)) === JSON.stringify(kept), `terse values must survive, got ${JSON.stringify(firstMeta(out))}`);
});

check("normalizeScriptContent prunes only the bad entries, keeps the good", () => {
  const out = normalizeScriptContent(
    metaScenes([
      { label: "Total volume", value: "$1.4T" },
      { label: "Volume", value: "in payments volume processed in 2025" },
    ]),
  );
  assert(JSON.stringify(firstMeta(out)) === JSON.stringify([{ label: "Total volume", value: "$1.4T" }]), `only the prose entry should drop, got ${JSON.stringify(firstMeta(out))}`);
});

check("normalizeScriptContent is a no-op on clean input (returns same ref)", () => {
  const clean = metaScenes([{ label: "Uptime", value: "99.99%" }]);
  assert(normalizeScriptContent(clean) === clean, "unchanged input should return the same reference");
});

check("normalizeScriptContent leaves malformed shapes for the validator", () => {
  // Non-object meta entries / missing scenes must pass through untouched so
  // validateScript owns the shape error message.
  assert(normalizeScriptContent({ nope: 1 }) !== undefined, "non-script object passes through");
  const bad = { scenes: [{ content: { headline: "x", meta: [{ label: "a" }] } }] };
  assert(normalizeScriptContent(bad) === bad, "malformed meta entry (no value) is left for validateScript");
});

// ── backfillSceneRegisters (GLM sporadically omits register wholesale) ──────

const regScenes = (scenes: Record<string, unknown>[]) => ({ scenes });
const regsOf = (out: unknown): (string | undefined)[] =>
  ((out as { scenes: { register?: string }[] }).scenes ?? []).map((s) => s.register);

check("backfill is a no-op when every register is valid (same ref)", () => {
  const s = regScenes([{ register: "stat" }, { register: "quote" }]);
  assert(backfillSceneRegisters(s) === s, "should return same reference");
});

check("backfill fills all-null registers with a varied, adjacent-distinct sequence", () => {
  const out = regsOf(
    backfillSceneRegisters(
      regScenes([
        { content: { headline: "Your calendar is full" } },
        { content: { headline: "22M+ learners", meta: [{ label: "PEOPLE", value: "22M+" }] } },
        { content: { headline: "How it works", bullets: ["a", "b", "c"] } },
        { content: { headline: "One more thing" } },
        { content: { headline: "Get started free" } },
      ]),
    ),
  );
  assert(out.every((r) => typeof r === "string" && r.length > 0), `all assigned: ${out}`);
  for (let i = 1; i < out.length; i++) assert(out[i] !== out[i - 1], `adjacent dup at ${i}: ${out}`);
  assert(out[1] === "stat", `numeric meta+headline → stat, got ${out[1]}`);
  assert(out[2] === "list", `3 bullets → list, got ${out[2]}`);
});

check("backfill preserves valid registers and only fills the gaps", () => {
  const out = regsOf(
    backfillSceneRegisters(
      regScenes([{ register: "split" }, { content: { headline: "x" } }, { register: "centered" }]),
    ),
  );
  assert(out[0] === "split" && out[2] === "centered", `kept: ${out}`);
  assert(!!out[1] && out[1] !== "split" && out[1] !== "centered", `gap filled distinct: ${out}`);
});

check("backfill rejects invalid register strings (not in vocabulary)", () => {
  const out = regsOf(backfillSceneRegisters(regScenes([{ register: "hero-banner" }, { register: "quote" }])));
  assert(out[0] !== "hero-banner" && !!out[0], `invalid replaced: ${out}`);
  assert(out[1] === "quote", "valid kept");
});

// ── Uncertainty decisions (the /review checkpoint batch) ─────────────────────
const scriptWithDecisions = (decisions: unknown) => ({
  ...scriptWithCta("See how Ramp works", "Get a demo"),
  decisions,
});

check("decisions: absent is fine (unambiguous brief) and a valid batch passes", () => {
  assert(validateScript(scriptWithCta("See how Ramp works", "Get a demo"), RICHNESS_OFF).ok, "absent must pass");
  const r = validateScript(
    scriptWithDecisions([
      {
        id: "audience-focus",
        question: "Who is this aimed at?",
        context: "The brief mentions both founders and finance teams.",
        options: ["Founders", "Finance teams"],
      },
      {
        id: "lead-product",
        question: "Lead with the platform or the card?",
        options: ["Platform", "Card", "Both equally"],
        resolved: "Card",
      },
    ]),
    RICHNESS_OFF,
  );
  assert(r.ok, `valid decisions must pass, got ${JSON.stringify(r)}`);
});

check("decisions: rejects >3, bad slug ids, duplicate ids, and <2 options", () => {
  const four = Array.from({ length: 4 }, (_, i) => ({
    id: `d-${i}`, question: "q?", options: ["a", "b"],
  }));
  assert(!validateScript(scriptWithDecisions(four), RICHNESS_OFF).ok, ">3 must fail (batched, not a survey)");
  assert(
    !validateScript(scriptWithDecisions([{ id: "Not A Slug", question: "q?", options: ["a", "b"] }]), RICHNESS_OFF).ok,
    "non-kebab id must fail",
  );
  assert(
    !validateScript(
      scriptWithDecisions([
        { id: "dup", question: "q?", options: ["a", "b"] },
        { id: "dup", question: "q2?", options: ["a", "b"] },
      ]),
      RICHNESS_OFF,
    ).ok,
    "duplicate ids must fail",
  );
  assert(
    !validateScript(scriptWithDecisions([{ id: "one-opt", question: "q?", options: ["only"] }]), RICHNESS_OFF).ok,
    "a single option is not a decision",
  );
});

// ── Script-richness contract (bake-off follow-up) ────────────────────────────
// gpt-oss met every machine-checked rule and missed every prose-only norm:
// latest beats at 0-17% of scene duration, bare containers delegated to
// site_img_*, and the prompt's fallback atmosphere copied into all 5 scenes.
// These pin the contract that turns those norms into static checks. The gold
// standard is the HubSpot reference script (01KXEAF0SNT0RR079Z1SJZ1KWZ) —
// constants are calibrated so it passes everything.

const rs = (visual_concept: string, start = 0, end = 6) => ({
  start_seconds: start,
  end_seconds: end,
  visual_concept,
});

// A scene that satisfies all per-scene checks (75% beat coverage, >120 chars,
// many drawable nouns, furnished container) — the control fixture. Multi-scene
// tests append a per-scene ambient clause via richScene() so the shared base
// carries NO atmosphere grams of its own (the base has no infinite clause).
const RICH_BASE =
  "Composition: A dashboard panel sits center with three KPI tiles labeled 'Volume', 'Uptime', 'Speed', a left sidebar with nav items, and a bar chart beneath. Animations: panel fadeRise at 0s; tiles cascade from 1.2s; chart bars draw at 3s; accent bar extends at 4.5s;";
const richScene = (ambient: string) => rs(`${RICH_BASE} ${ambient}`);
const RICH_VC = `${RICH_BASE} the chart baseline shimmer loops infinite from 0s.`;

check("richness: a rich scene is clean", () => {
  const e = checkScriptRichness([rs(RICH_VC)]);
  assert(e.length === 0, `expected clean, got ${JSON.stringify(e)}`);
});

// — beat parsing —
check("latestExplicitBeat reads at/from times, ignores durations/staggers/cycles", () => {
  assert(
    latestExplicitBeat(
      "Window enters at 0s. Fields fill at 1s, each 0.4s. Modal pops at 2.3s, duration 0.9s. Glow loops infinite (3s cycle) from 4.8s.",
    ) === 4.8,
    "should read 4.8 (the infinite-loop START is a timed beat)",
  );
  assert(
    latestExplicitBeat("Headline fadeRise, duration 5.5s, with 0.4s stagger (4s cycle), over 0.6s.") === 0,
    "durations / staggers / cycle lengths are not beats",
  );
});

check("beat coverage: exactly at the fraction passes, just under fails with the measured %", () => {
  const dur = 6;
  const atFloor = rs(`${RICH_VC} Final caption fadeRise at ${dur * BEAT_COVERAGE_MIN_FRACTION}s.`, 0, dur);
  assert(checkScriptRichness([atFloor]).length === 0, "beat at exactly 50% of D must pass");
  const under = rs(
    "Composition: A dashboard panel with rows, labels, and a chart. Animations: panel fadeRise at 0s; rows cascade at 1s; glow loops infinite from 0s. Nothing after that lands late in the scene.",
    0,
    dur,
  );
  const e = checkScriptRichness([under]);
  assert(e.some((x) => /Scene 0: latest timed beat 1s = 17% of its 6s/.test(x)), `expected 17% beat error, got ${JSON.stringify(e)}`);
});

check("beat coverage: scenes under 3s are exempt (matches the dead-air gate)", () => {
  const e = checkScriptRichness([
    rs("Composition: The logo, wordmark, and accent bar sit centered on the canvas holding one still beat for a fast cut between sections of the story.", 0, 2.5),
  ]);
  assert(!e.some((x) => /timed beat/.test(x)), `short scene must skip beat check, got ${JSON.stringify(e)}`);
});

// — visual_concept floor —
check("floor: distinct drawable nouns are counted once across case/plural", () => {
  assert(countDrawableNouns("cards Card CARDS") === 1, "one distinct noun");
  assert(countDrawableNouns("a logo, a wordmark, an accent bar, more logos") === 3, "logo+wordmark+bar");
});

check("floor: short or noun-poor visual_concepts fail with measured numbers", () => {
  const short = checkScriptRichness([rs("A logo and accent bar over a glow. Logo scaleIn at 0s, bar settles at 3.5s.")]);
  assert(short.some((x) => /Scene 0: visual_concept too thin \(\d+ chars, 2 drawable nouns\)/.test(x)), `got ${JSON.stringify(short)}`);
  const nounPoor = checkScriptRichness([
    rs(
      "Composition: An enormous headline dominates the frame while a warm radial glow breathes behind it and gentle gradients wash the backdrop in the brand hue. Animations: headline settles at 0s; glow deepens at 3.4s.",
    ),
  ]);
  assert(nounPoor.some((x) => /too thin \(\d+ chars, 0 drawable nouns\)/.test(x)), `got ${JSON.stringify(nounPoor)}`);
});

// — interior furnishing —
check("furnishing: distinct interior specifics counted once", () => {
  assert(countInteriorSpecifics("rows and rows of labels") === 2, "row + label");
});

check("furnishing: a bare container fails, quoting the container phrase", () => {
  const e = checkScriptRichness([
    rs(
      "Composition: Three window mockups slide across the canvas representing the product suite, with a tangled network of gray lines behind them. Animations: windows slide in at 0s, 1s, and 3.2s.",
    ),
  ]);
  const f = e.find((x) => /interior detail/.test(x));
  assert(!!f && f.includes('"Three window mockups"'), `expected the bare container quoted verbatim, got ${JSON.stringify(e)}`);
});

check("furnishing: a container with ≥2 named interiors passes; no container = not applicable", () => {
  const furnished = checkScriptRichness([rs(RICH_VC)]);
  assert(!furnished.some((x) => /interior detail/.test(x)), `got ${JSON.stringify(furnished)}`);
  const noContainer = checkScriptRichness([
    rs(
      "Composition: A constellation of nodes and connectors spans the canvas with the logo at center and an accent bar beneath. Animations: nodes cascade from 0.5s; connectors draw at 2s; bar extends at 4.2s.",
    ),
  ]);
  assert(!noContainer.some((x) => /interior detail/.test(x)), `got ${JSON.stringify(noContainer)}`);
});

// — atmosphere anti-copy —
check("anti-copy: the same normalized ambience in 3 scenes fires (hex/timing changes don't hide it)", () => {
  const stamp = (hex: string, cycle: number, from: number) =>
    richScene(`A soft ${hex} glow pulse loops infinite (${cycle}s cycle) from ${from}s.`);
  const e = checkScriptRichness([stamp("#ff7a59", 4, 0), stamp("#191717", 2, 1), stamp("#786959", 3, 2)]);
  const f = e.find((x) => /share the same atmosphere phrase/.test(x));
  assert(!!f, `expected anti-copy to fire, got ${JSON.stringify(e)}`);
  assert(/glow pulse/.test(f!), `expected the shared phrase quoted, got ${f}`);
  assert(/Scenes 0, 1, 2/.test(f!), `expected all three scenes named, got ${f}`);
});

check("anti-copy: two scenes sharing a phrase stay clean (threshold is 3)", () => {
  const twin = richScene("Decorative dots drift infinite with slow sinusoidal motion from 0s.");
  const other = richScene("The hub icon rotates slowly infinite through the scene tail.");
  const e = checkScriptRichness([twin, twin, other]);
  assert(!e.some((x) => /atmosphere phrase/.test(x)), `got ${JSON.stringify(e)}`);
});

// — the real thin specimen: gpt-oss's HubSpot script (full-pipeline spike;
//   summarized in .data/full-spike/build-report.json under "script") —
//   Fails beat coverage in ALL scenes, furnishing in scene 1 ("three window
//   mockups" whose interiors were delegated to site_img_*), and anti-copy
//   (the prompt's fallback atmosphere pasted across scenes). Scenes verbatim.
const GPT_OSS_THIN = [
  rs(
    "Composition: Centered on a #f5f0e8 canvas, the HubSpot logo (asset site_logo) fades in with a spring scale, while a glowing hub icon composed of three #ff7a59 nodes appears behind it, initially spaced apart. Animations: Logo scaleIn at 0s (duration 0.8s); hub nodes fadeIn and drift outward from center at 0.3s intervals; a subtle #ff7a59 radial glow pulses infinite (4s cycle) from 0s; two decorative dots drift infinite with slow sinusoidal motion from 0s.",
    0,
    4,
  ),
  rs(
    "Composition: Left side displays three window mockups (assets site_img_0, site_img_1, site_img_2) representing Marketing Hub, Sales Hub, and Service Hub on a #f5f0e8 canvas, each with header colors #b69987, #191717, #786959; right side shows a tangled network of gray lines. Animations: Windows slide in from left at 0s, 0.5s, and 1s respectively, each with a brief loading flicker; a soft #ff7a59 glow pulse loops infinite across the canvas from 0s; three accent dots drift infinite with sin‑based motion at varied speeds from 1s.",
    4,
    11,
  ),
  rs(
    "Composition: A central #ff7a59 hub icon expands on the #f5f0e8 canvas, merging the three scattered nodes into one solid circle; surrounding it, three cards labeled \"Marketing Hub\", \"Sales Hub\", and \"Service Hub\" slide in from left, center, and right. Animations: Hub icon scaleIn at 0s (duration 0.8s); cards fadeRise and slideIn at 1s, 1.3s, and 1.6s; the hub emits a subtle pulse (scale 1→1.05) looping infinite from 2s; two decorative dots drift infinite with slow sinusoidal motion from 0s.",
    11,
    19,
  ),
  rs(
    "Composition: A vertical list of three panels on the #f5f0e8 canvas, each showing a screenshot (assets site_img_0, site_img_1, site_img_2) of Marketing Hub, Sales Hub, and Service Hub with overlaid titles; a solid #ff7a59 hub icon sits above the list, pulsing gently. Animations: Panels fadeRise with 0.5s stagger starting at 1s; hub icon pulse (scale 1→1.04) loops infinite from 2s; background subtle glow pulse loops infinite from 0s.",
    19,
    25,
  ),
  rs(
    "Composition: Centered CTA button 'Start free trial' on the #f5f0e8 canvas, with a #ff7a59 underline drawing left‑to‑right beneath it; the unified hub icon now a solid circle sits faintly behind the button, and the HubSpot logo appears in the top‑left corner with a soft glow. Animations: CTA text scaleIn at 0s (duration 0.7s); underline drawWidth 0→100% at 0.8s (duration 0.9s); hub icon pulse loops infinite from 1s; logo glow pulse loops infinite from 0s.",
    25,
    30,
  ),
];

check("THIN specimen: every gpt-oss scene fails beat coverage (beats land at 8-33%)", () => {
  const beats = checkScriptRichness(GPT_OSS_THIN).filter((x) => /timed beat/.test(x));
  assert(beats.length === 5, `expected all 5 scenes flagged, got ${beats.length}: ${JSON.stringify(beats)}`);
  for (let i = 0; i < 5; i++) {
    assert(beats.some((x) => x.startsWith(`Scene ${i}:`)), `scene ${i} missing from ${JSON.stringify(beats)}`);
  }
  assert(beats.some((x) => /Scene 1: latest timed beat 1s = 14% of its 7s/.test(x)), `expected the measured % verbatim, got ${JSON.stringify(beats)}`);
});

check("THIN specimen: 'three window mockups' flagged as a bare container", () => {
  const e = checkScriptRichness(GPT_OSS_THIN);
  const f = e.find((x) => x.startsWith("Scene 1:") && /interior detail/.test(x));
  assert(!!f && f.includes('"three window mockups"'), `expected the bare container quoted, got ${JSON.stringify(e)}`);
});

check("THIN specimen: copy-pasted fallback atmosphere fires anti-copy across ≥3 scenes", () => {
  const f = checkScriptRichness(GPT_OSS_THIN).find((x) => /share the same atmosphere phrase/.test(x));
  assert(!!f, "expected the anti-copy error");
  assert(/drift infinite|pulse loops infinite/.test(f!), `expected the copied signature quoted, got ${f}`);
});

check("THIN specimen: the floor is NOT what catches it (fails are beat/furnishing/anti-copy)", () => {
  const e = checkScriptRichness(GPT_OSS_THIN);
  assert(!e.some((x) => /too thin/.test(x)), `thin specimen passes the floor by design, got ${JSON.stringify(e)}`);
});

// — the gold standard: the HubSpot reference script must pass EVERYTHING —
//   (generated fixture, gitignored — skip cleanly when absent)
const refScriptPath = join(process.cwd(), "src/generated/01KXEAF0SNT0RR079Z1SJZ1KWZ/script.json");
if (existsSync(refScriptPath)) {
  const refScript = JSON.parse(readFileSync(refScriptPath, "utf8")) as {
    scenes: { start_seconds: number; end_seconds: number; visual_concept: string }[];
  };
  check("REFERENCE script (gold standard) meets the full richness contract", () => {
    const e = checkScriptRichness(refScript.scenes);
    assert(e.length === 0, `the reference must pass every check — calibration broke: ${JSON.stringify(e)}`);
  });
  check("REFERENCE script passes validateScript with richness ON (the default)", () => {
    const r = validateScript(refScript);
    assert(r.ok, `expected ok, got ${JSON.stringify(!r.ok && r.error)}`);
  });
} else {
  console.log("  - skipped REFERENCE richness calibration (generated fixture not present)");
}

// — generation-path wiring + stored-script back-compat —
const storedThinScript = {
  config: { duration_seconds: 6, aspect_ratio: "16:9" },
  brief: {},
  assets: [],
  scenes: [
    {
      start_seconds: 0,
      end_seconds: 6,
      label: "Open",
      visual_concept: "Logo fades in over a soft glow.",
      content: { headline: "Hello world", asset_ids: [] },
    },
  ],
};

check("validateScript enforces richness by default (the generation repair loop path)", () => {
  const r = validateScript(storedThinScript);
  assert(!r.ok, "thin script must fail on the generation path");
  if (!r.ok) {
    assert(/timed beat/.test(r.error) && /too thin/.test(r.error), `expected both richness errors joined, got ${r.error}`);
  }
});

check("validateScript({richness:false}) loads a stored thin script (back-compat)", () => {
  const r = validateScript(storedThinScript, { richness: false });
  assert(r.ok, `stored scripts predate the contract and must keep loading, got ${JSON.stringify(r)}`);
});

check("richness errors each stay ≤200 chars and name the scene", () => {
  for (const e of checkScriptRichness(GPT_OSS_THIN)) {
    assert(e.length <= 200, `error over 200 chars (${e.length}): ${e}`);
    assert(/Scene(s)? \d/.test(e), `error must name the scene: ${e}`);
  }
});

// ── Composition contract (checkSceneComposition — the cast-doctrine blueprint) ──
// The thinking head authors per-scene SceneComposition blueprints; these checks
// make richness machine-checkable BEFORE any element generates. Acceptance-run
// evidence: the fast emitter copied template examples verbatim ("Deal won —
// $12,400" CRM rows in a Duolingo language app) and duplicated copy across
// elements. Fixtures below are Duolingo-flavored on purpose.

type CompScenes = Parameters<typeof checkSceneComposition>[0];
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

// GOOD fixture: a two-scene Duolingo composed script that passes everything.
// Scene 0 hero has EXACTLY 6 interior items (the boundary: 6 passes, 5 fails).
const duoGood = () =>
  clone([
    {
      index: 0,
      label: "Hook",
      visual_concept: "A Duolingo lesson screen in a phone frame, headline left.",
      content: {
        headline: "Streaks make Spanish stick",
        lede: "Five minutes a day, every day.",
        asset_ids: [],
      },
      composition: {
        atmosphere:
          "Feather-green confetti drifts slowly upward behind the phone, soft and celebratory",
        elements: [
          {
            role: "hero",
            subject: "a Duolingo lesson screen in a phone frame",
            interior: [
              "XP bar 340/500",
              "streak flame '7'",
              "chips: días / noches",
              "hearts counter 4/5",
              "crown level 12 badge",
              "green owl mascot mid-hop",
            ],
            motion: "the streak flame pulses each time the XP bar fills",
          },
          {
            role: "copy",
            subject: "headline block left of the phone",
            interior: ["headline 'Streaks make Spanish stick'", "lede set beneath in Feather Book"],
            ownsCopy: ["headline", "lede"],
          },
          {
            role: "atmosphere",
            subject: "confetti field behind the phone",
            interior: ["feather-green confetti pieces"],
          },
        ],
      },
    },
    {
      index: 1,
      label: "Proof",
      visual_concept: "A streak leaderboard card with the headline above.",
      content: { headline: "22 million learners strong", asset_ids: [] },
      composition: {
        atmosphere:
          "Warm sunrise gradient washes the canvas while tiny owls parade along the base",
        elements: [
          {
            role: "hero",
            subject: "a streak leaderboard card",
            interior: [
              "leaderboard row: Ana — 214 day streak",
              "leaderboard row: Luis — 198 day streak",
              "weekly XP total 1,240",
              "gem count 505",
              "league badge 'Obsidian'",
              "daily goal ring 80%",
            ],
            motion: "leaderboard rows cascade in one by one",
          },
          {
            role: "copy",
            subject: "headline above the card",
            interior: ["headline '22 million learners strong'"],
            ownsCopy: ["headline"],
          },
          {
            role: "connector",
            subject: "dotted flight path from the owl to the card",
            interior: ["dotted arc with arrowhead"],
          },
        ],
      },
    },
  ]) as unknown as CompScenes;

// Typed accessors into the loose fixture (keeps mutations readable).
const sceneOf = (s: CompScenes, i: number) =>
  s[i] as unknown as {
    content: Record<string, unknown>;
    composition: {
      atmosphere?: string;
      elements: {
        role: string;
        interior: string[];
        ownsCopy?: string[];
        motion?: string;
      }[];
    };
  };

check("composition: the good Duolingo composed script passes every check", () => {
  const e = checkSceneComposition(duoGood());
  assert(e.length === 0, `expected clean, got ${JSON.stringify(e)}`);
});

check("composition: scenes without a composition field are skipped", () => {
  const bare = [
    { label: "Open", visual_concept: "Logo over a glow.", content: { headline: "Hi", asset_ids: [] } },
  ] as unknown as CompScenes;
  assert(checkSceneComposition(bare).length === 0, "uncomposed scripts must produce no errors");
  const mixed = [...duoGood(), ...bare] as unknown as CompScenes;
  assert(checkSceneComposition(mixed).length === 0, "an uncomposed trailing scene must be skipped");
});

// — 1) roles —
check("composition: an off-vocabulary role is rejected with the closed set", () => {
  const s = duoGood();
  sceneOf(s, 0).composition.elements[2].role = "background";
  const e = checkSceneComposition(s);
  assert(
    e.some((x) => /Scene 0 element 2: role "background" invalid/.test(x) && /hero\|copy\|atmosphere\|connector\|throughline/.test(x)),
    `expected the closed-set role error, got ${JSON.stringify(e)}`,
  );
});

check("composition: a composed scene needs ≥1 hero and ≥1 copy element", () => {
  const noHero = duoGood();
  sceneOf(noHero, 0).composition.elements[0].role = "connector";
  const a = checkSceneComposition(noHero);
  assert(a.some((x) => /Scene 0: composition has no hero element/.test(x)), `expected no-hero, got ${JSON.stringify(a)}`);
  const noCopy = duoGood();
  sceneOf(noCopy, 1).composition.elements[1].role = "throughline";
  const b = checkSceneComposition(noCopy);
  assert(b.some((x) => /Scene 1: composition has no copy element/.test(x)), `expected no-copy, got ${JSON.stringify(b)}`);
});

// — 2) hero inventory —
check("composition boundary: a 5-item hero fails, 6 passes", () => {
  const s = duoGood();
  sceneOf(s, 0).composition.elements[0].interior.pop(); // 6 → 5
  const e = checkSceneComposition(s);
  assert(
    e.some((x) => /Scene 0 hero: 5 interior item\(s\)/.test(x) && /≥6/.test(x)),
    `expected the 5-item count error, got ${JSON.stringify(e)}`,
  );
  // 6 items = the good fixture itself, asserted clean above.
  assert(checkSceneComposition(duoGood()).length === 0, "6 items must pass");
});

check("composition: generic filler interior items are rejected ('some data rows', 'sample content')", () => {
  const s = duoGood();
  const hero = sceneOf(s, 0).composition.elements[0];
  hero.interior[3] = "some data rows";
  hero.interior[4] = "sample content";
  const e = checkSceneComposition(s).filter((x) => /is generic filler/.test(x));
  assert(e.length === 2, `expected both filler items flagged, got ${JSON.stringify(e)}`);
  assert(e.some((x) => x.includes('"some data rows"')), `expected the item quoted, got ${JSON.stringify(e)}`);
});

check("composition: a vague 2-word item fails concreteness; digit/quoted/3-word items pass", () => {
  const s = duoGood();
  sceneOf(s, 0).composition.elements[0].interior[3] = "blue thing";
  const e = checkSceneComposition(s);
  assert(
    e.some((x) => /Scene 0 hero: interior item "blue thing" is not concrete/.test(x)),
    `expected the vague-item error, got ${JSON.stringify(e)}`,
  );
  // "XP bar 340/500" (digit), "streak flame '7'" (quoted) and "chips: días /
  // noches" (3 words + specific noun) all live in the clean good fixture.
});

// — 3) template-leak guard —
check("composition: the acceptance-run '$12,400' leak is rejected verbatim", () => {
  const s = duoGood();
  sceneOf(s, 0).composition.elements[0].interior[3] = "Deal won — $12,400";
  const e = checkSceneComposition(s);
  const f = e.find((x) => /template example value — author real values for THIS brand/.test(x));
  assert(!!f, `expected the template-leak error, got ${JSON.stringify(e)}`);
  assert(f!.includes('"Deal won — $12,400"') && f!.startsWith("Scene 0 hero:"), `expected item + role named, got ${f}`);
});

check("composition: leak guard is case-insensitive and covers the audit set; near-values pass", () => {
  const s = duoGood();
  sceneOf(s, 1).composition.elements[2].interior = [
    "ACME CORP account row",
    "avatar chip for sarah chen",
    "signup john.doe@example.com",
    "pipeline row $12,500", // near-value: NOT a leak
  ];
  const e = checkSceneComposition(s).filter((x) => /template example value/.test(x));
  assert(e.length === 3, `expected exactly the 3 leaks (not $12,500), got ${JSON.stringify(e)}`);
  assert(e.every((x) => x.startsWith("Scene 1 connector:")), `leaks must name the element role, got ${JSON.stringify(e)}`);
});

check("TEMPLATE_LEAK_RX covers the full audit/acceptance leak set", () => {
  for (const leak of [
    "Deal won — $12,400", "$8,300 closed", "Acme Corp", "Beta LLC", "Gamma Inc",
    "Sarah Chen", "47 deals", "152 users", "3.8 rating", "john.doe@example.com", "John Doe",
  ]) {
    assert(TEMPLATE_LEAK_RX.test(leak), `expected leak match: ${leak}`);
  }
  for (const real of ["XP bar 340/500", "22 million learners", "$12,500 pipeline", "38 rating widgets"]) {
    assert(!TEMPLATE_LEAK_RX.test(real), `real value must not match: ${real}`);
  }
});

// — 4) ownership —
check("composition: ownsCopy naming a field absent from scene.content is flagged", () => {
  const s = duoGood();
  sceneOf(s, 1).composition.elements[1].ownsCopy = ["headline", "lede"]; // scene 1 has no lede
  const e = checkSceneComposition(s);
  assert(
    e.some((x) => /Scene 1 copy: ownsCopy field "lede" is not in scene\.content/.test(x)),
    `expected the orphaned-field error, got ${JSON.stringify(e)}`,
  );
});

check("composition: a field owned by two elements is flagged by name", () => {
  const s = duoGood();
  sceneOf(s, 0).composition.elements[0].ownsCopy = ["headline"]; // hero grabs the copy's field
  const e = checkSceneComposition(s);
  assert(
    e.some((x) => /Scene 0: content field "headline" owned by 2 elements \(hero, copy\)/.test(x)),
    `expected the double-owner error, got ${JSON.stringify(e)}`,
  );
});

check("composition: ownsCopy must collectively cover the headline", () => {
  const s = duoGood();
  sceneOf(s, 1).composition.elements[1].ownsCopy = [];
  const e = checkSceneComposition(s);
  assert(
    e.some((x) => /Scene 1: no element owns "headline"/.test(x)),
    `expected the headline-coverage error, got ${JSON.stringify(e)}`,
  );
});

// — 5) atmosphere variety —
check("composition: atmosphere is required and must be ≥6 words", () => {
  const missing = duoGood();
  delete sceneOf(missing, 0).composition.atmosphere;
  const a = checkSceneComposition(missing);
  assert(a.some((x) => /Scene 0: composition\.atmosphere is required/.test(x)), `expected required error, got ${JSON.stringify(a)}`);
  const short = duoGood();
  sceneOf(short, 0).composition.atmosphere = "Soft green glow pulses gently";
  const b = checkSceneComposition(short);
  assert(b.some((x) => /Scene 0: composition\.atmosphere is 5 word\(s\)/.test(x)), `expected 5-word error, got ${JSON.stringify(b)}`);
});

check("composition: adjacent scenes sharing a normalized atmosphere fail (digits/hex can't hide it)", () => {
  const s = duoGood();
  sceneOf(s, 0).composition.atmosphere = "Confetti drifts upward at 3s in #58cc02 bursts across the whole canvas";
  sceneOf(s, 1).composition.atmosphere = "Confetti drifts upward at 6s in #1cb0f6 bursts across the whole canvas";
  const e = checkSceneComposition(s);
  assert(
    e.some((x) => /Scenes 0 and 1: same atmosphere/.test(x) && /confetti drifts upward/.test(x)),
    `expected the adjacent-duplicate error with the phrase quoted, got ${JSON.stringify(e)}`,
  );
});

check("composition: the same atmosphere on NON-adjacent scenes passes", () => {
  const s = duoGood();
  const scene2 = clone(s[1]) as unknown as (typeof s)[number]; // scene 1 sits between 0 and 2
  s.push(scene2);
  sceneOf(s, 2).composition.atmosphere = sceneOf(s, 0).composition.atmosphere!;
  const e = checkSceneComposition(s);
  assert(!e.some((x) => /same atmosphere/.test(x)), `non-adjacent repeats must pass, got ${JSON.stringify(e)}`);
});

// — 6) motion tied to named content —
check("composition: a scene where no motion references its element's own interior fails", () => {
  const none = duoGood();
  delete sceneOf(none, 0).composition.elements[0].motion;
  const a = checkSceneComposition(none);
  assert(a.some((x) => /Scene 0: no element's motion references its own interior/.test(x)), `expected motion error, got ${JSON.stringify(a)}`);
  const ambient = duoGood();
  sceneOf(ambient, 0).composition.elements[0].motion = "a soft glow pulses gently forever";
  const b = checkSceneComposition(ambient);
  assert(b.some((x) => /Scene 0: no element's motion/.test(x)), `generic ambience must not count, got ${JSON.stringify(b)}`);
});

check("composition: motion token match is case-insensitive", () => {
  const s = duoGood();
  sceneOf(s, 0).composition.elements[0].motion = "The STREAK Flame pulses once per correct answer";
  assert(checkSceneComposition(s).length === 0, "uppercase STREAK must match the interior's 'streak'");
});

check("composition: motion referencing ANOTHER element's interior does not count", () => {
  const s = duoGood();
  const scene1 = sceneOf(s, 1);
  delete scene1.composition.elements[0].motion; // hero motion gone
  scene1.composition.elements[2].motion = "leaderboard rows sweep past"; // connector quoting the HERO's interior
  const e = checkSceneComposition(s);
  assert(
    e.some((x) => /Scene 1: no element's motion references its own interior/.test(x)),
    `cross-element references must not satisfy the check, got ${JSON.stringify(e)}`,
  );
});

// — error hygiene: ≤200 chars, scene named, repair-loop ready —
check("composition errors each stay ≤200 chars and name the scene", () => {
  const broken = duoGood();
  const s0 = sceneOf(broken, 0);
  s0.composition.atmosphere = "Soft green glow pulses gently";
  s0.composition.elements[0].interior = ["some data rows", "blue thing", "Deal won — $12,400"];
  s0.composition.elements[0].ownsCopy = ["headline", "subtitle"];
  s0.composition.elements[1].role = "background";
  delete s0.composition.elements[0].motion;
  const errors = checkSceneComposition(broken);
  assert(errors.length >= 7, `expected a broad failure set, got ${JSON.stringify(errors)}`);
  for (const e of errors) {
    assert(e.length <= 200, `error over 200 chars (${e.length}): ${e}`);
    assert(/Scene(s)? \d/.test(e), `error must name the scene: ${e}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
