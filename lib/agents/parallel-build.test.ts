/**
 * Tests for the parallel per-scene build helpers (RB_BUILD_MODE=parallel).
 * Pure functions only — no live model calls. The end-to-end scaffold→fill→
 * assemble path is validated by a live build; here we lock the mechanics:
 * bounded concurrency + failure isolation, the deterministic throughline pins,
 * the copy-slot contract, the scaffold prompt contract, and the splice contract
 * that assembly depends on.
 */
import {
  mapWithConcurrency,
  slugify,
  throughlineAnchorFor,
  buildSceneCopyLines,
  buildScaffoldUserMessage,
  type BuildInput,
} from "./pipeline";
import { sectionsAreSpliceable } from "./scene-scope";
import { replaceSection, extractSection, listSectionIndices } from "./section-splice";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("parallel-build");

// ── mapWithConcurrency ──────────────────────────────────────────────
await check("mapWithConcurrency: runs every item, preserves order", async () => {
  const out = await mapWithConcurrency([0, 1, 2, 3, 4], 2, async (n) => n * 10);
  assert(out.length === 5, `len ${out.length}`);
  assert(out.every((r) => r.status === "fulfilled"), "all fulfilled");
  assert(
    out.map((r) => (r.status === "fulfilled" ? r.value : -1)).join(",") === "0,10,20,30,40",
    "order + values preserved",
  );
});

await check("mapWithConcurrency: never exceeds the cap in flight", async () => {
  let inFlight = 0;
  let peak = 0;
  await mapWithConcurrency(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return true;
  });
  assert(peak <= 3, `peak concurrency ${peak} exceeded cap 3`);
  assert(peak >= 2, `expected real concurrency, peak was ${peak}`);
});

await check("mapWithConcurrency: a throwing item settles rejected, batch survives", async () => {
  const out = await mapWithConcurrency([0, 1, 2, 3], 2, async (n) => {
    if (n === 2) throw new Error("boom");
    return n;
  });
  assert(out.length === 4, "all slots present");
  assert(out[2].status === "rejected", "the throwing item is rejected, not fatal");
  assert(
    out.filter((r) => r.status === "fulfilled").length === 3,
    "the other three still fulfilled",
  );
});

await check("mapWithConcurrency: empty input → empty output, no hang", async () => {
  const out = await mapWithConcurrency([], 5, async () => 1);
  assert(out.length === 0, "empty");
});

// ── slugify / throughline anchor (the cross-scene continuity pins) ───
await check("slugify: stable kebab slug, capped", () => {
  assert(slugify("The Signal Within") === "the-signal-within", "spaces→dashes, lowercased");
  assert(slugify("  Réady, Set — Go!! ") === "r-ady-set-go", `punctuation collapsed: ${slugify("  Réady, Set — Go!! ")}`);
  assert(slugify("") === "", "empty stays empty");
  assert(slugify("x".repeat(80)).length === 48, "capped at 48");
});

await check("throughlineAnchorFor: one stable anchor per aspect (drift-gate pin)", () => {
  assert(throughlineAnchorFor("16:9").left === 1360 && throughlineAnchorFor("16:9").top === 540, "16:9");
  assert(throughlineAnchorFor("9:16").left === 540 && throughlineAnchorFor("9:16").top === 1280, "9:16");
  assert(throughlineAnchorFor("1:1").left === 620, "1:1");
  // Unknown aspect falls back to the landscape anchor (deterministic, never undefined).
  assert(throughlineAnchorFor("weird").left === 1360, "unknown → landscape default");
});

// ── copy slots (shared by the monolithic brief AND each fill) ────────
await check("buildSceneCopyLines: renders every provided slot, skips absent ones", () => {
  const lines = buildSceneCopyLines({
    eyebrow: "LIVE",
    headline: "One number tells you everything",
    bullets: ["a", "b"],
    // no lede / caption / meta / cta
    texts: [],
    asset_ids: [],
  } as never);
  const joined = lines.join("\n");
  assert(/Copy to render/.test(joined), "header present");
  assert(joined.includes('eyebrow:') && joined.includes("LIVE"), "eyebrow slot");
  assert(joined.includes("One number tells you everything"), "headline slot");
  assert(/bullets \(2\)/.test(joined) && joined.includes('- "a"'), "bullets slot");
  assert(!/lede:/.test(joined) && !/cta\.primary/.test(joined), "absent slots omitted");
});

await check("buildSceneCopyLines: empty content → just the header", () => {
  const lines = buildSceneCopyLines(undefined as never);
  assert(lines.length === 1 && /Copy to render/.test(lines[0]), "only the header line");
});

// ── scaffold prompt contract ────────────────────────────────────────
const fixtureInput = (): BuildInput =>
  ({
    script: {
      config: { aspect_ratio: "16:9", fps: 30 },
      narrative: {
        logline: "A ring that reads your body.",
        arc: "unknown → clarity",
        throughline: "The Signal Within",
      },
      scenes: [
        { label: "Hook", description: "open cold", visual_concept: "a pulse", register: "full-bleed", content: { headline: "Your body is always talking" } },
        { label: "Proof", description: "the number", visual_concept: "readiness dial", register: "stat", content: { headline: "One number", meta: [{ label: "HRV", value: "42ms" }] } },
        { label: "Close", description: "cta", visual_concept: "logo lockup", register: "centered", content: { cta: { primary: "Get yours" } } },
      ],
      assets: { images: [] },
    },
  }) as unknown as BuildInput;

await check("buildScaffoldUserMessage: emits the scaffold contract, not scene bodies", () => {
  const msg = buildScaffoldUserMessage(fixtureInput());
  assert(/SCAFFOLD/.test(msg), "framed as scaffold");
  assert(msg.includes("Section{N}") && /Section0\.\.Section2/.test(msg), "stub instruction for all N");
  assert(msg.includes("export const Generated"), "requires the trailing Generated boundary");
  assert(!/Copy to render/.test(msg), "does NOT dump per-scene copy slots (those go to fills)");
});

await check("buildScaffoldUserMessage: pins the throughline slug + anchor when a narrative exists", () => {
  const msg = buildScaffoldUserMessage(fixtureInput());
  assert(msg.includes('data-throughline="the-signal-within"'), "exact slug pinned");
  assert(msg.includes("1360") && msg.includes("540"), "canonical 16:9 anchor pinned");
});

await check("buildScaffoldUserMessage: storyboard lists every scene", () => {
  const msg = buildScaffoldUserMessage(fixtureInput());
  assert(/Section0 — "Hook"/.test(msg) && /Section2 — "Close"/.test(msg), "all scenes in the storyboard");
});

// ── the splice contract assembly depends on ─────────────────────────
await check("assembly: a scaffold of stubs is spliceable and fills replace one at a time", () => {
  const scaffold = [
    'import React from "react";',
    "const SECTION_FRAME = { position: 'absolute', inset: 0 } as const;",
    "export const Section0: React.FC = () => <div style={{ ...SECTION_FRAME }} />;",
    "export const Section1: React.FC = () => <div style={{ ...SECTION_FRAME }} />;",
    "export const Section2: React.FC = () => <div style={{ ...SECTION_FRAME }} />;",
    "export const Generated = () => (<><Section0 /><Section1 /><Section2 /></>);",
  ].join("\n\n");
  assert(sectionsAreSpliceable(scaffold, 3), "3 contiguous stubs + Generated → spliceable");
  assert(listSectionIndices(scaffold).join(",") === "0,1,2", "indices 0,1,2");
  const filled = replaceSection(
    scaffold,
    1,
    "export const Section1: React.FC = () => <div style={{ ...SECTION_FRAME }}><h1>Real</h1></div>;",
  );
  assert(filled !== null, "section 1 spliced");
  assert(sectionsAreSpliceable(filled!, 3), "still contiguous after a fill");
  assert(/Real/.test(extractSection(filled!, 1) ?? ""), "the filled body landed in Section1");
  assert(!/Real/.test(extractSection(filled!, 0) ?? ""), "neighbours untouched");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
