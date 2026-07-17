/**
 * Tests for the script agent's user-message assembly — specifically the
 * canvas-plan injection (QA 2026-07-08). The design pass ENFORCES the resolved
 * canvas via its machine contract; a visual_concept written for a conflicting
 * backdrop ("dark ultra-premium" on a light brand — the Oura build) gets
 * overridden at design time and then reads as plan-infidelity to the vision
 * gate. The storyteller must be told the ground it is painting on.
 */
import { buildUserMessage, type AgentBrief } from "./script-generator";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("script-user-message (canvas-plan injection)");

const brief = (extract: Partial<AgentBrief["brand_extract"]>): AgentBrief => ({
  duration_seconds: 30,
  moment_count: 5,
  freeform_prompt: "Launch video for the brand.",
  brand_extract: { url: "https://example.com", ok: true, ...extract },
});

check("crawled light background → canvas line names it, mode light, crawl-sourced", () => {
  const msg = buildUserMessage(brief({ background_color: "#faf9f7", palette: ["#1a1a1a", "#faf9f7", "#5f4bff"] }));
  assert(msg.includes("background WILL be #faf9f7"), "must name the resolved canvas hex");
  assert(/a light canvas/.test(msg), "light brand → light mode in the line");
  assert(/sampled from the brand's site/.test(msg), "crawl source cited");
  assert(/never specify a conflicting backdrop/i.test(msg), "the instruction itself is present");
});

check("no crawl background → palette-extremity canvas, palette-sourced wording", () => {
  // Oura shape: light brand, no background_color extracted. The extreme-
  // luminance palette member (near-white) must win — NOT a dark prior.
  const msg = buildUserMessage(brief({ palette: ["#fbfaf8", "#2c2a29", "#8a7350"] }));
  assert(msg.includes("background WILL be #fbfaf8"), "extremity pick must be the near-white entry");
  assert(/a light canvas/.test(msg), "resolved mode is light");
  assert(/derived from the brand palette/.test(msg), "palette source cited");
});

check("dark brand → canvas line says dark", () => {
  const msg = buildUserMessage(brief({ background_color: "#0a0a0a" }));
  assert(msg.includes("background WILL be #0a0a0a") && /a dark canvas/.test(msg), "dark canvas named as dark");
});

check("no brand extract → no canvas line (nothing to enforce against)", () => {
  const msg = buildUserMessage({
    duration_seconds: 30,
    moment_count: 5,
    freeform_prompt: "Launch video.",
  });
  assert(!/background WILL be/.test(msg), "no extract → no canvas injection");
});

// ── Computed per-scene beat floor (retry audit class 6) ──────────────────────
// The beat-coverage rule lived in the prompt but the model flubbed the
// per-scene arithmetic on most first attempts — the user message now carries
// the arithmetic WORKED per scene at the even split + the recompute rule.

check("beat floor: 30s/5 → every scene's worked floor line present (3.0s floor, 3.6s target)", () => {
  const msg = buildUserMessage(brief({ palette: ["#111111", "#ffffff"] }));
  assert(msg.includes("BEAT-COVERAGE ARITHMETIC (computed for THIS brief"), "the block header is present");
  for (let i = 0; i < 5; i++) {
    assert(
      msg.includes(`Scene ${i} runs ${(6 * i).toFixed(1)}-${(6 * (i + 1)).toFixed(1)}s (D=6.0s): your latest timed beat must be ≥0.5×6.0 = 3.0s, target ≥0.6×6.0 = 3.6s.`),
      `scene ${i} worked line missing from:\n${msg.split("BEAT-COVERAGE")[1]?.slice(0, 700)}`,
    );
  }
  assert(/REDO this arithmetic with YOUR D per scene/.test(msg), "the recompute rule is present");
  assert(/Beats are scene-relative/.test(msg), "the scene-relative clock is stated");
});

check("beat floor: uneven division rounds honestly (20s/3 → D=6.7s, floor 3.3s, target 4.0s)", () => {
  const msg = buildUserMessage({ duration_seconds: 20, moment_count: 3, freeform_prompt: "x" });
  assert(
    msg.includes("(D=6.7s): your latest timed beat must be ≥0.5×6.7 = 3.3s, target ≥0.6×6.7 = 4.0s"),
    `expected the rounded arithmetic, got:\n${msg.split("BEAT-COVERAGE")[1]?.slice(0, 500)}`,
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
