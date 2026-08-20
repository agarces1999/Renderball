/**
 * Brief-substance signal — the first-outside-tester incident (2026-08-20).
 * His whole brief was one sentence with no company, product or metrics, so
 * the pipeline invented a $49,700 cost table. A brief that says almost
 * nothing must be RECOGNIZED as such, and a real brief must never be.
 */
import { briefSubstance, THIN_BRIEF_DIRECTIVE, buildUserMessage } from "./script-generator";
import type { AgentBrief } from "./script-generator";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("brief-substance");

check("the incident brief is THIN (verbatim from the friend's deck)", () => {
  const s = briefSubstance({
    freeform_prompt: "A pitch deck for a pre seed round that helps me get up to USD 4 MM",
    purpose: "A pitch deck for a pre seed round that helps me get up to USD 4 MM",
  } as never);
  assert(s.thin, `not thin: ${JSON.stringify(s)}`);
});

check("a real paragraph brief is NOT thin", () => {
  const s = briefSubstance({
    freeform_prompt:
      "Pitch deck for Meridian Robotics' Series A. We run autonomous floor robots in 12 grocery distribution centers, cut picking errors 38% in the first quarter, and are raising to expand to 50 sites next year. Investors care about the reliability record and the per-site payback.",
  } as never);
  assert(!s.thin, `false positive: ${JSON.stringify(s)}`);
  assert(s.numbers >= 3, `expected the user's figures counted, got ${s.numbers}`);
});

check("a SHORT brief backed by a real crawl is NOT thin (brand corpus grounds it)", () => {
  const s = briefSubstance({
    freeform_prompt: "deck for our launch",
    brand_extract: { body_excerpts: ["Renderball turns a brief into an editable deck."], headlines: ["Decks you can edit"] },
  } as never);
  assert(!s.thin, `crawl-backed brief flagged thin: ${JSON.stringify(s)}`);
  assert(s.hasBrandCorpus, "brand corpus not detected");
});

check("the thin directive reaches the outline prompt, and only when thin", () => {
  const thin = buildUserMessage({
    freeform_prompt: "A pitch deck for a pre seed round that helps me get up to USD 4 MM",
    kind: "deck",
    moment_count: 5,
    moments: [],
  } as unknown as AgentBrief);
  assert(thin.includes(THIN_BRIEF_DIRECTIVE), "thin brief did not get the directive");

  const rich = buildUserMessage({
    freeform_prompt:
      "Pitch deck for Meridian Robotics' Series A. We run autonomous floor robots in 12 grocery distribution centers, cut picking errors 38% in the first quarter, and are raising to expand to 50 sites next year. Investors care about reliability and per-site payback.",
    kind: "deck",
    moment_count: 5,
    moments: [],
  } as unknown as AgentBrief);
  assert(!rich.includes(THIN_BRIEF_DIRECTIVE), "rich brief wrongly got the directive");
});

check("the directive forbids invented FACTS and invented QUALITATIVE claims alike", () => {
  assert(/never state a fact the user did not give/i.test(THIN_BRIEF_DIRECTIVE), "missing fact rule");
  assert(/qualitative claims/i.test(THIN_BRIEF_DIRECTIVE), "missing qualitative-claim rule");
  assert(/slot/i.test(THIN_BRIEF_DIRECTIVE), "missing slot instruction");
});

check("a model-EXPANDED purpose can never rescue a thin brief (self-vouching)", () => {
  // The outline stage rewrites purpose into a fuller sentence. Counting it
  // let generated prose vouch for user material: the incident brief measured
  // 47 words at build time and escaped the check.
  const s = briefSubstance({
    freeform_prompt: "A pitch deck for a pre seed round that helps me get up to USD 4 MM",
  } as never);
  assert(s.thin, "user text alone should be thin");
  const withSynth = briefSubstance({
    freeform_prompt: "A pitch deck for a pre seed round that helps me get up to USD 4 MM",
    purpose:
      "A pre-seed investor pitch deck that raises up to USD 4 MM by telling the story of a market gap, what leaving it open costs, and why this team closes it now with a wedge nobody else has built yet.",
  } as never);
  assert(!withSynth.thin, "sanity: including synthesized text does inflate the measure");
  // The BUILD path must therefore pass user text only — asserted by the
  // pipeline call sites, which omit `purpose` deliberately.
});

console.log(`brief-substance: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
