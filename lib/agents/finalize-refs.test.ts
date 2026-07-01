//
// Tests for the canonical undefined-reference finalize net (build + M2 editor).
// The individual repairs are covered in quality-gates.test.ts; this locks their
// COMPOSITION in finalizeUndefinedRefs — a piece regen relies on all three firing
// in one pass (import a used-but-unimported icon, stub an invented component,
// neutralize a brand-logo lucide name) so the render can't crash.
//
import { finalizeUndefinedRefs, assessInvalidLucideImports } from "./finalize-refs";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

const HEAD = `import React from "react";
import { Camera, Square } from "lucide-react";

const PALETTE = { accent: "#ff2d78" };
`;

console.log("\n▶ finalize-refs");

await check("imports a used-but-unimported valid lucide icon (<Zap/>)", async () => {
  const code = `import React from "react";
import { Square } from "lucide-react";
export const Section0 = () => <div><Square/><Zap/></div>;`;
  const { code: out, added } = await finalizeUndefinedRefs(code);
  assert(added.includes("Zap"), `expected Zap added, got [${added.join(",")}]`);
  assert(/import \{[^}]*\bZap\b[^}]*\} from "lucide-react"/.test(out), "Zap not spliced into lucide import");
});

await check("null-stubs a genuinely invented component (<Thumb/>)", async () => {
  const code = `import React from "react";
export const Section0 = () => <div><Thumb/></div>;`;
  const { code: out, stubbed } = await finalizeUndefinedRefs(code);
  assert(stubbed.includes("Thumb"), `expected Thumb stubbed, got [${stubbed.join(",")}]`);
  assert(/const Thumb\b/.test(out), "Thumb stub not inserted");
});

await check("neutralizes an invalid brand-logo lucide import (Slack → real icon)", async () => {
  const code = `import React from "react";
import { Square, Slack } from "lucide-react";
export const Section0 = () => <div><Slack/></div>;`;
  const { code: out, neutralized } = await finalizeUndefinedRefs(code);
  assert(neutralized.includes("Slack"), `expected Slack neutralized, got [${neutralized.join(",")}]`);
  // Repair aliases the invalid name to a real icon (Square as Slack) so <Slack/>
  // still renders instead of being an undefined import — no bare Slack export.
  const imp = out.match(/import \{[^}]*\} from "lucide-react"/)?.[0] ?? "";
  assert(/Square as Slack/.test(imp), `Slack not aliased to a real icon: ${imp}`);
  assert(!/(^|[{,\s])Slack(\s*[,}])/.test(imp.replace(/Square as Slack/, "")), "a bare Slack import survived");
});

await check("all three repairs compose in ONE pass", async () => {
  const code = `import React from "react";
import { Square, Slack } from "lucide-react";
export const Section0 = () => <div><Square/><Camera/><Slack/><Thumb/></div>;`;
  const { code: out, added, stubbed, neutralized } = await finalizeUndefinedRefs(code);
  assert(added.includes("Camera"), "Camera not imported");
  assert(stubbed.includes("Thumb"), "Thumb not stubbed");
  assert(neutralized.includes("Slack"), "Slack not neutralized");
  const imp = out.match(/import \{[^}]*\} from "lucide-react"/)?.[0] ?? "";
  assert(/\bCamera\b/.test(imp) && /Square as Slack/.test(imp), `final lucide import wrong: ${imp}`);
});

await check("idempotent — re-running on finalized code is a no-op", async () => {
  const code = `${HEAD}export const Section0 = () => <div><Camera/><Square/></div>;`;
  const first = await finalizeUndefinedRefs(code);
  const second = await finalizeUndefinedRefs(first.code);
  assert(second.code === first.code, "second pass changed already-finalized code");
  assert(second.added.length === 0 && second.stubbed.length === 0, "second pass added/stubbed on clean code");
});

await check("assessInvalidLucideImports finds brand names, ignores real icons", () => {
  assert(assessInvalidLucideImports(HEAD).length === 0, "clean import flagged");
  const bad = `import { Camera, Figma, Notion } from "lucide-react";`;
  const found = assessInvalidLucideImports(bad);
  assert(found.includes("Figma") && found.includes("Notion") && !found.includes("Camera"),
    `wrong brands: [${found.join(",")}]`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
