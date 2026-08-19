/**
 * Piece-spec system: every mined variant compiles to VALID and PAIRWISE-
 * DISTINCT TSX; deck tokens flow through (same spec themes differently per
 * deck); the marker expander splices fail-open. House idiom: top-level
 * assertions, no framework.
 */
import * as esbuild from "esbuild";
import {
  STAT_TILE_VARIANTS,
  BULLET_STACK_VARIANTS,
  parsePieceSpec,
  type StatTileSpec,
  type BulletStackSpec,
} from "./spec";
import { compilePieceSpec, resolveDeckTokens } from "./compile";
import { expandSpecMarkers } from "./expand";

process.env.RB_PIECE_TELEMETRY = "off"; // tests must not pollute variant counts

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("pieces (spec → compile → expand)");

const BRANDED_SCAFFOLD = `
import React from "react";
import { Check, TrendingUp, ArrowRight } from "lucide-react";
const PALETTE = { accent: "#f26539", ink: "#101418", surface: "#f5f1ea", line: "#d9d2c5" };
const FONT_DISPLAY = '"Cabinet Grotesk", sans-serif';
const FONT_BODY = '"Geist", sans-serif';
const FONT_MONO = '"Geist Mono", monospace';
`;
const BARE_SCAFFOLD = `import React from "react";\n`;

const validate = (fragment: string) => {
  const mod = `${BRANDED_SCAFFOLD}\nexport const P = () => (${fragment});`;
  esbuild.transformSync(mod, { loader: "tsx" });
};

const statSpec = (variant: StatTileSpec["variant"]): StatTileSpec => ({
  piece: "statTile",
  variant,
  value: "97.4%",
  label: "retention after 12 months",
  caption: "cohort n=1,204",
});
const stackSpec = (variant: BulletStackSpec["variant"]): BulletStackSpec => ({
  piece: "bulletStack",
  variant,
  items: [
    { text: "Ship the wedge first", detail: "decks before docs" },
    { text: "Meter tokens, not seats" },
    { text: "Editing is the moat" },
  ],
});

const tokens = resolveDeckTokens(BRANDED_SCAFFOLD);

await check("every statTile variant compiles to valid TSX", () => {
  for (const v of STAT_TILE_VARIANTS) validate(compilePieceSpec(statSpec(v), tokens));
});

await check("every bulletStack variant compiles to valid TSX", () => {
  for (const v of BULLET_STACK_VARIANTS) validate(compilePieceSpec(stackSpec(v), tokens));
});

await check("variants are pairwise distinct (anti-sameness contract)", () => {
  const stats = STAT_TILE_VARIANTS.map((v) => compilePieceSpec(statSpec(v), tokens));
  assert(new Set(stats).size === STAT_TILE_VARIANTS.length, "statTile variants collide");
  const stacks = BULLET_STACK_VARIANTS.map((v) => compilePieceSpec(stackSpec(v), tokens));
  assert(new Set(stacks).size === BULLET_STACK_VARIANTS.length, "bulletStack variants collide");
});

await check("references the deck's own tokens, never bakes hexes", () => {
  const out = compilePieceSpec(statSpec("bordered-boxed"), tokens);
  assert(out.includes("FONT_DISPLAY"), "missing FONT_DISPLAY");
  assert(out.includes("PALETTE.surface"), "missing PALETTE.surface");
  assert(out.includes("PALETTE.line"), "missing PALETTE.line");
  assert(!out.includes("#f26539"), "baked a brand hex");
});

await check("knobs change output (underline, mono, center)", () => {
  const plain = compilePieceSpec(statSpec("plain"), tokens);
  const knobbed = compilePieceSpec(
    { ...statSpec("plain"), knobs: { underline: true, mono: true, align: "center" } },
    tokens,
  );
  assert(knobbed !== plain, "knobs were a no-op");
  assert(knobbed.includes("FONT_MONO"), "mono knob ignored");
  validate(knobbed);
});

await check("bare deck falls back to translucent neutrals and still parses", () => {
  const bare = resolveDeckTokens(BARE_SCAFFOLD);
  const out = compilePieceSpec(statSpec("boxed"), bare);
  assert(!out.includes("PALETTE"), "referenced PALETTE on a deck without one");
  assert(out.includes("rgba(127,127,127"), "no neutral fallback");
  esbuild.transformSync(`import React from "react";\nexport const P = () => (${out});`, { loader: "tsx" });
});

await check("escapes JSX-hostile copy", () => {
  validate(
    compilePieceSpec(
      { piece: "statTile", variant: "plain", value: "<3 & {90}", label: "a > b" },
      tokens,
    ),
  );
});

await check("parse: unknown variant defaults to plain; malformed rejected; items capped", () => {
  const s = parsePieceSpec({ piece: "statTile", variant: "hologram", value: "1", label: "x" });
  assert(s?.piece === "statTile" && s.variant === "plain", "unknown variant not defaulted");
  assert(parsePieceSpec({ piece: "statTile", value: 42, label: "x" }) === null, "bad value accepted");
  assert(parsePieceSpec({ piece: "bulletStack", items: [] }) === null, "empty items accepted");
  assert(parsePieceSpec({ piece: "waffle" }) === null, "unknown piece accepted");
  assert(parsePieceSpec(null) === null, "null accepted");
  const capped = parsePieceSpec({
    piece: "bulletStack",
    variant: "plain",
    items: Array.from({ length: 9 }, (_, i) => ({ text: `item ${i}` })),
  }) as BulletStackSpec;
  assert(capped.items.length === 6, `cap failed: ${capped.items.length}`);
});

const marker = (json: string) => `{/* @rb-spec ${json} */}`;
const doc = (inner: string) =>
  `${BRANDED_SCAFFOLD}\nexport const Section0 = () => (<div style={{ position: "absolute", left: 120, top: 340, width: 420 }}>${inner}</div>);`;

await check("expander splices a compiled piece in place of the marker", () => {
  const r = expandSpecMarkers(doc(marker(JSON.stringify(statSpec("boxed")))));
  assert(r.expanded === 1, `expanded ${r.expanded}`);
  assert(!r.code.includes("@rb-spec"), "marker left behind");
  assert(r.code.includes("PALETTE.surface"), "tokens missing in splice");
  esbuild.transformSync(r.code, { loader: "tsx" });
});

await check("fail-open: invalid JSON leaves the comment untouched", () => {
  const src = doc(marker(`{"piece": "statTile", value:}`));
  const r = expandSpecMarkers(src);
  assert(r.expanded === 0 && r.code === src, "mutated on bad JSON");
  assert(r.skipped[0]?.reason === "invalid JSON", `reason ${r.skipped[0]?.reason}`);
  esbuild.transformSync(r.code, { loader: "tsx" });
});

await check("fail-open: unknown piece leaves the comment", () => {
  const r = expandSpecMarkers(doc(marker(`{"piece":"waffle"}`)));
  assert(r.expanded === 0, "expanded an unknown piece");
  assert(r.skipped[0]?.reason === "unknown piece/shape", `reason ${r.skipped[0]?.reason}`);
});

await check("adds missing lucide icons for iconled; refuses without lucide", () => {
  const slim = `import { ArrowRight } from "lucide-react";\nconst FONT_BODY = "x";\nexport const S = () => (<div>${marker(JSON.stringify(statSpec("iconled")))}</div>);`;
  const r = expandSpecMarkers(slim);
  assert(r.expanded === 1, "iconled not expanded");
  {
    const importLine = r.code.split("\n")[0];
    for (const dep of ["TrendingUp", "Check", "ArrowRight", "ArrowUpRight"]) {
      assert(importLine.includes(dep), `import missing ${dep}: ${importLine}`);
    }
  }
  esbuild.transformSync(r.code, { loader: "tsx" });
  const noLucide = expandSpecMarkers(
    `const FONT_BODY="x";\nexport const S=()=>(<div>${marker(JSON.stringify(statSpec("iconled")))}</div>);`,
  );
  assert(noLucide.expanded === 0 && (noLucide.skipped[0]?.reason ?? "").includes("lucide"), "expanded without lucide");
  const noLucideArrow = expandSpecMarkers(
    `const FONT_BODY="x";\nexport const S=()=>(<div>${marker(JSON.stringify(stackSpec("arrow")))}</div>);`,
  );
  assert(noLucideArrow.expanded === 0, "arrow variant expanded without lucide");
});

await check("expands multiple markers in one pass", () => {
  const r = expandSpecMarkers(
    doc(marker(JSON.stringify(statSpec("plain"))) + marker(JSON.stringify(stackSpec("boxed-ruled")))),
  );
  assert(r.expanded === 2, `expanded ${r.expanded}`);
});

console.log(`pieces: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
