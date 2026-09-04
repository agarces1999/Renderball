/**
 * Parallel authoring plumbing: the design reply parses into preamble + plans,
 * a page reply yields exactly its Section, and assembly produces a file every
 * downstream gate recognizes. Zero model spend.
 */
import { parseDesign, extractSection, assembleParallel } from "./parallel-author";
import { assemblePack, type PackInput } from "./pack";
import { missingSections } from "./author";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("parallel-author");

const PREAMBLE = `import React from "react";
import { Piece } from "./Piece";
type Script = any;
const PALETTE = { accent: "#635BFF", canvas: "#0A2540", ink: "#fff", muted: "#ADBDCC", surface: "#12304f", line: "#1f3f60" };
const FONT_DISPLAY = "Inter, sans-serif";
const FONT_BODY = "Inter, sans-serif";
const FONT_MONO = "SF Mono, Menlo, monospace";
const DeckStyle: React.FC = () => <style>{\`@keyframes rb-rise { from { opacity: 0; transform: translateY(24px) } to { opacity: 1; transform: none } }\`}</style>;
const Chrome: React.FC<{ page: number }> = ({ page }) => (<div><DeckStyle />{page}</div>);
`;
const section = (k: number, label: string) =>
  `export const Section${k}: React.FC<{ script?: Script }> = () => (\n  <div style={{ position: "absolute", inset: 0, background: PALETTE.canvas }}>\n    <Piece id="s${k + 1}.p1" kind="diegetic"><h1 style={{ fontFamily: FONT_DISPLAY }}>${label}</h1></Piece>\n    ${"<div />".repeat(30)}\n    <Piece id="s${k + 1}.p9" kind="chrome"><Chrome page={${k + 1}} /></Piece>\n  </div>\n);\n`;

await check("design reply → preamble (cut at any stray Section) + plans", () => {
  const raw = "Sure.\n```tsx\n" + PREAMBLE + section(0, "stray") + "```\n\n```text\nPage 1 — Open\n- device: vault map\nPage 2 — Crew\n- device: tool rack\n```";
  const d = parseDesign(raw);
  assert(!!d, "parsed");
  assert(!/export const Section/.test(d!.preamble), "stray section cut from the preamble");
  assert(/const Chrome/.test(d!.preamble), "preamble kept");
  assert(/Page 2 — Crew/.test(d!.plans), "plans captured");
});

await check("design reply without plans is refused", () => {
  assert(parseDesign("```tsx\n" + PREAMBLE + "```") === null, "no plans → null");
});

await check("page reply → exactly its Section (extra sections and prose ignored; imports refused)", () => {
  const raw = "Here is page 3:\n```tsx\n" + section(2, "Inside the vault") + section(3, "extra") + "```";
  const got = extractSection(raw, 2);
  assert(!!got && /export const Section2/.test(got.code) && !/Section3/.test(got.code), `got ${got?.code.slice(0, 60)}`);
  assert(got!.leaked === false, "no module-level leak");
  const withImport = "```tsx\nimport React from \"react\";\n" + section(2, "x") + "```";
  assert(extractSection(withImport, 2) === null, "a page that re-imports is refused");
  const leaked = "```tsx\nconst LOCAL = 3;\n" + section(2, "x") + "```";
  const l = extractSection(leaked, 2);
  assert(!!l && l.leaked && /const LOCAL = 3/.test(l.code), "a module-level leak is kept and flagged");
});

await check("a reply holding exactly one mis-numbered section is taken as the page (renamed), not retried", () => {
  const raw = "```tsx\n" + section(2, "off by one") + "```";
  const got = extractSection(raw, 1);
  assert(!!got && /export const Section1\b/.test(got.code) && !/Section2/.test(got.code), `got ${got?.code.slice(0, 50)}`);
  const two = "```tsx\n" + section(2, "a") + section(3, "b") + "```";
  assert(extractSection(two, 1) === null, "two sections, neither mine → still refused");
});

await check("assembly yields a file with every Section, in order, preamble first", () => {
  const code = assembleParallel(PREAMBLE, [
    { index: 2, code: section(2, "c") },
    { index: 0, code: section(0, "a") },
    { index: 1, code: section(1, "b") },
  ]);
  assert(missingSections(code, 3).length === 0, "all sections present");
  assert(code.indexOf("Section0") < code.indexOf("Section1") && code.indexOf("Section1") < code.indexOf("Section2"), "ordered");
  assert(code.startsWith('import React from "react";'), "preamble first");
});

await check("pack passes: design asks for preamble + plans and no sections; page asks for ONE section against the fixed preamble", () => {
  const base: PackInput = {
    briefPrompt: "b", tone: undefined, aspect: "16:9",
    scenes: [{ label: "Open", description: "d", content: "{}" }, { label: "Crew", description: "d2", content: "{}" }],
    brand: { brandName: "X", palette: [], logoSrc: null, mode: "light", background: "#fff" }, assetUrls: [],
  };
  const design = assemblePack({ ...base, parallel: { pass: "design" } });
  assert(/DESIGN PASS/.test(design) && /PAGE PLANS/.test(design) && /Do NOT emit any `SectionN`/.test(design), "design contract");
  assert(/```text block/.test(design), "design output shape");
  const page = assemblePack({ ...base, parallel: { pass: "page", page: 1, preamble: PREAMBLE, plans: "Page 1 — Open\nPage 2 — Crew" } });
  assert(/Emit ONLY `export const Section1/.test(page), "page contract names its section");
  assert(/THE FIXED MODULE PREAMBLE/.test(page) && page.includes("const Chrome"), "preamble in view");
  assert(/Define NOTHING at module scope/.test(page), "no module-level declarations");
  assert(/THE APPROVED OUTLINE/.test(page) && /MOTION \(the deck is presented live/.test(page), "outline + motion directives still read by the page pass");
  const one = assemblePack(base);
  assert(/Export exactly 2 components/.test(one) && !/DESIGN PASS/.test(one), "one-call contract unchanged");
});

await check("prompt-only story: the pack asks the design pass to write the story; plans parse back into scenes", async () => {
  const { storyFromPlans } = await import("./parallel-author");
  const base: PackInput = { briefPrompt: "Pitch Acme's new API to CTOs", tone: undefined, aspect: "16:9", scenes: [{ label: "", description: "", content: "" }, { label: "", description: "", content: "" }], brand: { brandName: "Acme", palette: [], logoSrc: null, mode: "light", background: "#fff" }, assetUrls: [], storyFromPrompt: true, parallel: { pass: "design" } };
  const pack = assemblePack(base);
  assert(/THE STORY \(yours to write/.test(pack) && /You write the story: 2 pages/.test(pack), "story instruction present");
  assert(/first the STORY lines/.test(pack) && /Headline:/.test(pack), "design pass asked for story lines per page");
  assert(!/THE APPROVED OUTLINE/.test(pack), "no outline header");
  const plans = "Page 1 — Casing the target\nIntent: make CTOs feel the blind spot.\nHeadline: The vault has no blueprint\nCopy: You deployed a model you cannot read.\n- device: radar\nPage 2 — The crew\nIntent: introduce the tools.\nHeadline: Meet the crew\nCopy: Probes, autoencoders.\n- device: rack";
  const story = storyFromPlans(plans, 2);
  assert(story[0].label === "Casing the target" && /blind spot/.test(story[0].description) && /vault has no blueprint/.test(story[0].content), `page 1 parsed: ${JSON.stringify(story[0])}`);
  assert(story[1].label === "The crew" && /Meet the crew/.test(story[1].content), `page 2 parsed: ${JSON.stringify(story[1])}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
