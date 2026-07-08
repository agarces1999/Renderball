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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
