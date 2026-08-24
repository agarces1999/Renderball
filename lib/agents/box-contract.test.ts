/**
 * Half 2 (task #114): the box-contract PROMPT — under RB_BOX_CONTRACT the
 * element brief must switch from box DATA ("your wrapper is W×H at canvas
 * (x,y). Fill it.") to the box CONTRACT proven by insert-element's
 * generate-piece (17/17 measured compliance): state only the size, forbid
 * geometry on the outermost element, never hand the model canvas coordinates
 * to echo into styles. The witnessed C1 escape was models double-offsetting
 * canvas-scale left/top INSIDE already-positioned wrappers — the coordinates
 * in the prompt are where those numbers came from.
 *
 * Locked here: the flag is genuinely off by default (byte-identical BOUNDS
 * line), the contract text carries the load-bearing phrases, canvas coords
 * vanish under contract, and the three exemptions (atmosphere / connector /
 * throughline) keep today's wording even with the flag on.
 */
import { elementBrief } from "./cast-build";
import type { ElementSlot } from "./layout-composer";
import type { Theme } from "../edit/piece-model";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

const theme: Theme = {
  palette: {
    BG: "#110e09", ACCENT: "#ccff00", INK: "#f4f1ea",
    PANEL_BG: "rgba(244,241,234,0.04)", HAIRLINE: "rgba(244,241,234,0.12)",
  },
  fonts: {
    display: '"Display", sans-serif', body: '"Body", sans-serif', mono: '"Mono", monospace',
    fontFaceCss: "",
  },
  keyframes: "",
  grammar: { radiusScale: [8, 12, 16], strokeWeight: 1, hairline: "HAIRLINE", panelBg: "PANEL_BG", shadowRecipe: "0 30px 80px rgba(0,0,0,0.4)", dataFont: "mono" },
};

type BriefArgs = Parameters<typeof elementBrief>[0];
const script = {
  scenes: [
    {
      label: "Problem",
      description: "The problem, stated plainly.",
      visual_concept: "A stat panel on the right, copy on the left.",
      content: { headline: "Six hours a week", lede: "That is the cost." },
    },
  ],
} as unknown as BriefArgs["script"];

const slot = (over: Partial<ElementSlot>): ElementSlot =>
  ({
    id: "copy",
    kind: "text",
    bounds: { x: 80, y: 180, w: 460, h: 606, z: 2 },
    contentFields: ["headline"],
    paletteRoles: [],
    ...over,
  }) as ElementSlot;

const brief = (s: ElementSlot): string =>
  elementBrief({ theme, script, sceneIndex: 0, register: "editorial", slot: s, pieceId: `s0.${s.id}`, throughline: "a progress motif" });

const withContract = (v: string | undefined, fn: () => string): string => {
  const prev = process.env.RB_BOX_CONTRACT;
  if (v === undefined) delete process.env.RB_BOX_CONTRACT;
  else process.env.RB_BOX_CONTRACT = v;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.RB_BOX_CONTRACT;
    else process.env.RB_BOX_CONTRACT = prev;
  }
};

console.log("box-contract prompt (Half 2, task #114)");

check("OFF by default: the BOUNDS line is byte-identical to the pre-contract wording", () => {
  const off = withContract(undefined, () => brief(slot({})));
  assert(off.includes("BOUNDS: your wrapper is 460×606px at canvas (80,180) — width is a MAX, height flows. Fill it."), `old wording must survive verbatim:\n${off.split("\n").find((l) => l.startsWith("BOUNDS"))}`);
  assert(!off.includes("BOX CONTRACT"), "no contract text when the flag is off");
});

check("ON, text slot: contract text, no canvas coordinates, flow-height variant", () => {
  const on = withContract("on", () => brief(slot({})));
  assert(on.includes("BOX CONTRACT"), "contract header");
  assert(on.includes("OUTERMOST element"), "outermost-element rule");
  assert(on.includes("Do NOT set position:absolute, left, top, right, bottom, width, or height"), "the proven prohibition list");
  assert(on.includes("width is a MAX; height flows"), "text keeps flowing height");
  assert(on.includes("shrink-to-fit"), "the model is told overflow shrinks, honestly");
  assert(on.includes("never write canvas coordinates"), "canvas-echo ban");
  assert(!on.includes("at canvas (80,180)"), "canvas coords must VANISH — they are what models echoed into styles");
  assert(!on.includes("(80,180)"), "no bare coordinate tuple either");
});

check("ON, non-text slot: EXACT size + clip warning, 100% fill instruction", () => {
  const on = withContract("on", () => brief(slot({ id: "hero", kind: "diegetic", bounds: { x: 960, y: 140, w: 840, h: 780, z: 2 }, contentFields: [] })));
  assert(on.includes("EXACTLY 840×780px"), "exact size stated");
  assert(on.includes("interior overflow is CLIPPED"), "clip consequence stated — enforcement is implied by the same flag");
  assert(on.includes("width/height 100%"), "fill instruction");
  assert(!on.includes("at canvas (960,140)"), "no canvas coords");
});

check("ON, exempt slots keep today's wording: atmosphere, connector, throughline", () => {
  const atmos = withContract("on", () => brief(slot({ id: "atmosphere", kind: "atmosphere", bounds: { x: 0, y: 0, w: 1920, h: 1080, z: 0 }, contentFields: [] })));
  assert(atmos.includes("at canvas (0,0)"), "atmosphere keeps canvas wording");
  assert(!atmos.includes("BOX CONTRACT"), "atmosphere is exempt (inset:0 full-bleed)");
  const conn = withContract("on", () => brief(slot({ id: "connector", kind: "diegetic", bounds: { x: 0, y: 0, w: 1920, h: 1080, z: 1 }, contentFields: [] })));
  assert(!conn.includes("BOX CONTRACT"), "connector is exempt (its own inset-0 contract)");
  const thru = withContract("on", () => brief(slot({ id: "throughline", kind: "diegetic", bounds: { x: 80, y: 690, w: 300, h: 6, z: 5 }, contentFields: [] })));
  assert(!thru.includes("BOX CONTRACT"), "throughline is exempt (anchor-frozen coords)");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
