/** Chapter mechanics: range-aware section checks and the duplicate-proof merge. */
import { missingSections, mergeChapters, extractDeckFile } from "./author";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("harness-author");

await check("missingSections is range-aware for continuations", () => {
  const code = "export const Section6 = 1; export const Section7 = 1;";
  assert(missingSections(code, 8, 6).length === 0, "6..8 present but reported missing");
  assert(missingSections(code, 8, 5).join() === "Section5", "Section5 gap not reported");
  assert(missingSections(code, 2).join() === "Section0,Section1", "full-range check broke");
});

await check("mergeChapters appends and detects duplicate sections", () => {
  const base = "import React from \"react\";\nexport const Section0 = 1;\nexport const Section1 = 1;";
  const merged = mergeChapters(base, ["export const Section2 = 1;"]);
  assert(merged.includes("Section2") && merged.startsWith("import React"), "merge lost content");
  let threw = false;
  try { mergeChapters(base, ["export const Section1 = 2;"]); } catch { threw = true; }
  assert(threw, "duplicate Section1 not rejected");
});

await check("extractDeckFile takes the largest fenced block, thinking stripped", () => {
  const raw = "<think>plan plan</think>\n```tsx\nconst a = 1;\n```\ntext\n```tsx\nexport const Section0 = () => null; // the real file, longer\n```";
  const code = extractDeckFile(raw);
  assert(!!code && code.includes("Section0") && !code.includes("plan"), `got ${code?.slice(0, 40)}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
