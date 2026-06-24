/**
 * Regression tests for headlineProblem (QA S4) — hero headlines must be one
 * punchy clause, not a crammed headline+subhead. Run: `npm test`.
 */
import {
  headlineProblem,
  findUngroundedClaims,
  findUngroundedStageLabels,
  extractStatClaims,
  validateScript,
  findTypeOnlyScenes,
  normalizeScriptContent,
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
// cta.primary per test; everything else is a minimal valid script.
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
  const r = validateScript(scriptWithCta("See how Ramp works", "See how Ramp works"));
  assert(!r.ok && /duplicates the headline/.test(r.error), `got ${JSON.stringify(r)}`);
});

check("CTA duplication is caught case/space-insensitively", () => {
  const r = validateScript(scriptWithCta("Get Started Today", "  get started today "));
  assert(!r.ok && /duplicates the headline/.test(r.error), `got ${JSON.stringify(r)}`);
});

check("a distinct verb-led CTA passes", () => {
  const r = validateScript(scriptWithCta("See how Ramp works", "Get a demo"));
  assert(r.ok, `expected ok, got ${JSON.stringify(r)}`);
});

check("a scene with no cta is a no-op for the duplication check", () => {
  const r = validateScript(scriptWithCta("See how Ramp works", undefined));
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
