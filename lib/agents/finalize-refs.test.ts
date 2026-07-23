//
// Tests for the canonical undefined-reference finalize net (build + M2 editor).
// The individual repairs are covered in quality-gates.test.ts; this locks their
// COMPOSITION in finalizeUndefinedRefs — a piece regen relies on all three firing
// in one pass (import a used-but-unimported icon, stub an invented component,
// neutralize a brand-logo lucide name) so the render can't crash.
//
// Repair #4 (undefined VALUE identifiers) is locked by the regression section
// below. Anchor: cast build 01KY86J312SRPDXY6D58MSXJ81 shipped ok:true while
// s2.hero called `rows.map(...)` with `rows` defined NOWHERE — esbuild is
// syntax-only, repairs 1–3 only see JSX tags, so the scene compiled clean and
// threw `ReferenceError: rows is not defined` at SSR (500 on /api/dev/export).
// The contract: a piece body referencing an undefined identifier must either
// be STUBBED (renders empty, never crashes) or fail the build — never ship as
// a crashing scene.
//
import {
  finalizeUndefinedRefs,
  assessInvalidLucideImports,
  stubUndefinedValueRefs,
  undefinedNameFromRenderError,
} from "./finalize-refs";
import { renderSectionsForAnalysis } from "../render/density-gates";

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

// ─── repair #4: undefined VALUE identifiers (runtime-truth stub net) ─────────

// React SSR logs each render throw's componentStack via console.error — those
// crashes are the EXPECTED inputs here, not failures. Mute around renders.
const mutedRender = (code: string, script: unknown) => {
  const realError = console.error;
  console.error = () => {};
  try { return renderSectionsForAnalysis(code, script); }
  finally { console.error = realError; }
};
const mutedFinalize = async (code: string, opts?: { script?: unknown }) => {
  const realError = console.error;
  console.error = () => {};
  try { return await finalizeUndefinedRefs(code, opts); }
  finally { console.error = realError; }
};

const SCRIPT = {
  scenes: [{ content: { headline: "Zero" } }, { content: { headline: "One" } }],
};

// Scene 1's hero is the 01KY86J312SRPDXY6D58MSXJ81 s2.hero shape verbatim:
// `rows.map((row, i) => ...)` with `rows` declared nowhere in the module.
const CRASHING = `import React from "react";

interface Script {
  scenes: Array<{ content: any }>;
}

const INK = "#fbfbfb";
const CARD_FILL = "#101014";

export const Section0: React.FC<{ script: Script }> = ({ script }) => {
  const c = script.scenes[0].content;
  return (
    <div style={{ position: "absolute", inset: 0, background: CARD_FILL, color: INK }}>
      <div data-piece="s0.copy" data-kind="text">{c.headline}</div>
      <div data-piece="s0.hero" data-kind="diegetic">
        {[{ label: "Inbox" }, { label: "Reviews" }].map((item, i) => (
          <div key={i}>{item.label}</div>
        ))}
      </div>
    </div>
  );
};

export const Section1: React.FC<{ script: Script }> = ({ script }) => {
  const c = script.scenes[1].content;
  return (
    <div style={{ position: "absolute", inset: 0, background: CARD_FILL, color: INK }}>
      <div data-piece="s1.hero" data-kind="diegetic">
        {rows.map((row, i) => (
          <div key={i}>
            <span>{row.status}</span>
            <span>{row.title}</span>
            <span>{row.id}</span>
          </div>
        ))}
      </div>
      <div data-piece="s1.copy" data-kind="text">{c.headline}</div>
    </div>
  );
};

export const Generated: React.FC<{ script: Script }> = ({ script }) => (
  <>
    <Section0 script={script} />
    <Section1 script={script} />
  </>
);
`;

// The correct emission of the same layout: data inlined, params in scope, a
// JS global (Math) in use — nothing here may be flagged or rewritten.
const HEALTHY = CRASHING.replace(
  "{rows.map((row, i) => (",
  `{[
        { status: "Done", title: "Faster launch", id: "FAL-" + Math.round(128) },
      ].map((row, i) => (`,
);

await check("undefinedNameFromRenderError parses V8 ReferenceErrors only", () => {
  assert(undefinedNameFromRenderError("render: rows is not defined") === "rows", "render: prefix");
  assert(undefinedNameFromRenderError("compile/eval: ReferenceError: cfg is not defined") === "cfg", "compile/eval prefix");
  assert(undefinedNameFromRenderError("render: Cannot read properties of undefined (reading 'hex')") === null, "TypeError must not match");
  assert(undefinedNameFromRenderError(undefined) === null, "undefined error");
  assert(undefinedNameFromRenderError("render: document is not defined") === null, "blocklisted runtime global");
});

await check("PRECONDITION: the crashing composition throws `rows is not defined` at SSR, scene 1 only", () => {
  const renders = mutedRender(CRASHING, SCRIPT);
  const s0 = renders.find((r) => r.scene === 0);
  const s1 = renders.find((r) => r.scene === 1);
  assert(!!s0?.html, `scene 0 should render, got: ${s0?.error}`);
  assert(s1?.html === null, "scene 1 should fail to render");
  assert(/rows is not defined/.test(s1?.error ?? ""), `expected ReferenceError, got: ${s1?.error}`);
});

await check("REGRESSION: finalizeUndefinedRefs (with script) stubs `rows` and every scene renders", async () => {
  const fin = await mutedFinalize(CRASHING, { script: SCRIPT });
  assert(
    fin.valueStubbed.some((v) => v.name === "rows" && v.scenes.includes(1)),
    `rows not in valueStubbed: ${JSON.stringify(fin.valueStubbed)}`,
  );
  assert(/var rows: any = \[\];/.test(fin.code), "stub declaration missing from the code");
  const renders = mutedRender(fin.code, SCRIPT);
  assert(
    renders.every((r) => r.html !== null),
    `stubbed composition must render every scene: ${JSON.stringify(renders.filter((r) => r.error).map((r) => ({ scene: r.scene, error: r.error })))}`,
  );
});

await check("healthy composition (data inlined, params + Math in use) is untouched", async () => {
  const fin = await mutedFinalize(HEALTHY, { script: SCRIPT });
  assert(fin.valueStubbed.length === 0, `false positive: ${JSON.stringify(fin.valueStubbed)}`);
  assert(fin.code === HEALTHY, "healthy composition was rewritten");
});

await check("without opts.script the value net is OFF (edit-path parity)", async () => {
  const fin = await mutedFinalize(CRASHING);
  assert(fin.valueStubbed.length === 0, "value net ran without a script");
  assert(!/var rows/.test(fin.code), "stub written without a script");
});

await check("undefined JSX components stay the component net's (never value-stubbed)", async () => {
  const withTag = CRASHING.replace(
    '<div data-piece="s0.copy" data-kind="text">{c.headline}</div>',
    '<div data-piece="s0.copy" data-kind="text"><Widget label={c.headline} /></div>',
  );
  const fin = await mutedFinalize(withTag, { script: SCRIPT });
  assert(fin.stubbed.includes("Widget"), `Widget not component-stubbed: ${JSON.stringify(fin.stubbed)}`);
  assert(!fin.valueStubbed.some((v) => v.name === "Widget"), "Widget leaked into the value net");
  const renders = mutedRender(fin.code, SCRIPT);
  assert(renders.every((r) => r.html !== null), "finalized composition must render");
});

await check("multi-pass: a stub unmasks the NEXT undefined identifier in the same scene", async () => {
  const twoBugs = CRASHING.replace(
    '<div data-piece="s1.copy" data-kind="text">{c.headline}</div>',
    '<div data-piece="s1.copy" data-kind="text">{items.map((it: any) => <span key={it.id}>{it.label}</span>)}</div>',
  );
  const fin = await mutedFinalize(twoBugs, { script: SCRIPT });
  const names = fin.valueStubbed.map((v) => v.name);
  assert(
    names.includes("rows") && names.includes("items"),
    `expected both rows+items stubbed, got: ${names.join(", ")}`,
  );
  const renders = mutedRender(fin.code, SCRIPT);
  assert(renders.every((r) => r.html !== null), "both stubs must leave every scene renderable");
});

await check("blocklisted runtime globals are never stubbed (left for the fail-closed gate)", () => {
  const usesDocument = CRASHING.replace(
    "{rows.map((row, i) => (",
    "{[document.title].map((row: any, i: number) => (",
  );
  const out = stubUndefinedValueRefs(usesDocument, SCRIPT);
  assert(out.valueStubbed.length === 0, `stubbed a runtime global: ${JSON.stringify(out.valueStubbed)}`);
  assert(out.code === usesDocument, "code must be unchanged");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
