// The offline gate for the text-fit runtime (docs/TEXT_FIT.md layer 1) —
// the allocator's precedent: no layout behavior ships on reasoning alone.
//
// For every stored build under src/generated with a Composition.tsx + a
// script, run the REAL measurement + gates twice — RB_TEXT_FIT=off, then on —
// and print the blocking-finding delta by kind. The measurement engine, the
// walker and the gates are the production functions, esbuild-bundled the way
// every replay script in this repo does it; nothing is reimplemented.
//
//   node scripts/replay-text-fit.mjs             # all stored builds
//   node scripts/replay-text-fit.mjs <scriptId>  # one build
//
// Zero model calls. Wall cost ≈ one headless chromium per build per arm.
import * as esbuild from "esbuild";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO = process.cwd();
const only = process.argv[2] ?? null;
const SCRATCH = path.join(
  "/private/tmp/claude-501/-Users-alfonsogarces-VIDEO-GEN/66a0320e-ab42-4115-8600-78bdda8062ed/scratchpad",
  "text-fit-replay",
);
mkdirSync(SCRATCH, { recursive: true });

// ── load the real functions ──────────────────────────────────────────────────
const work = path.join(REPO, "node_modules", ".cache", "rb-fit-replay");
mkdirSync(work, { recursive: true });
const entry = path.join(work, "entry.ts");
writeFileSync(
  entry,
  `export { measureScenes } from ${JSON.stringify(path.join(REPO, "lib/render/measure-scene.ts"))};
export { findRenderTruthFailures } from ${JSON.stringify(path.join(REPO, "lib/render/render-truth-gates.ts"))};`,
);
const out = await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  packages: "external",
  write: false,
  logLevel: "silent",
});
const modPath = path.join(work, `bundle-${process.pid}.mjs`);
writeFileSync(modPath, out.outputFiles[0].text);
const { measureScenes, findRenderTruthFailures } = await import(pathToFileURL(modPath).href);

// ── the corpus: stored builds with a composition and a script ────────────────
const genRoot = path.join(REPO, "src", "generated");
const builds = readdirSync(genRoot).filter((id) => {
  if (only && id !== only) return false;
  return (
    existsSync(path.join(genRoot, id, "Composition.tsx")) &&
    existsSync(path.join(genRoot, id, "script.json"))
  );
});
if (builds.length === 0) {
  console.error("no stored builds with Composition.tsx + script.json");
  process.exit(1);
}
console.log(`replaying ${builds.length} stored build(s), two arms each\n`);

const tallyBlocking = (gate) => {
  const t = {};
  for (const f of gate.blocking ?? []) t[f.kind] = (t[f.kind] ?? 0) + 1;
  return t;
};
const fmt = (t) =>
  Object.entries(t)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${v}`)
    .join(" ") || "clean";

const totals = { off: {}, on: {} };
const add = (into, t) => {
  for (const [k, v] of Object.entries(t)) into[k] = (into[k] ?? 0) + v;
};
let floored = 0;

for (const id of builds) {
  const genDir = path.join(genRoot, id);
  const script = JSON.parse(readFileSync(path.join(genDir, "script.json"), "utf8"));
  const row = { id, arms: {} };
  for (const arm of ["off", "on"]) {
    process.env.RB_TEXT_FIT = arm === "off" ? "off" : "";
    const outDir = path.join(SCRATCH, `${id}-${arm}`);
    mkdirSync(outDir, { recursive: true });
    try {
      const measurements = await measureScenes(genDir, script, outDir);
      const gate = await findRenderTruthFailures(measurements, {});
      row.arms[arm] = tallyBlocking(gate);
      add(totals[arm], row.arms[arm]);
      if (arm === "on") {
        // fit-floor marks ride the element walk if the walker captured them;
        // count via the raw measurement attributes when present.
        for (const m of measurements) {
          for (const el of m.elements ?? []) {
            if (el.fitFloor) floored++;
          }
        }
      }
    } catch (err) {
      row.arms[arm] = { "replay-error": 1 };
      add(totals[arm], row.arms[arm]);
      console.error(`  ${id} [${arm}] failed: ${err?.message ?? err}`);
    }
  }
  console.log(
    `${id}\n   off: ${fmt(row.arms.off)}\n   on : ${fmt(row.arms.on)}`,
  );
}

console.log("\n=== TOTALS (blocking findings) ===");
console.log("  off:", fmt(totals.off));
console.log("  on :", fmt(totals.on));
const sum = (t) => Object.values(t).reduce((a, b) => a + b, 0);
const off = sum(totals.off);
const on = sum(totals.on);
console.log(
  `\n  ${off} → ${on}  (${off === 0 ? "no baseline findings" : `${Math.round((1 - on / off) * 100)}% reduction`})`,
);
console.log(
  "  A NEW kind appearing in the on-arm that the off-arm lacks = the pass",
  "\n  manufactured a defect — that is a launch blocker, not a trade-off.",
);
