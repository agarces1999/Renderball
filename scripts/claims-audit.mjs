#!/usr/bin/env node
// Claims audit — read-only report of numeric claims in script copy vs the
// brief's ALLOWED grounding sources (the user's prompt/purpose, verified
// claims, and the crawl's title/description/headlines/body_excerpts — never
// the script's own text).
//
// This is the reporting twin of the QA S5 gate (lib/agents/schema-validator.ts
// findUngroundedClaims, tightened to full-token matching after Sonnet invented
// "38ms p50" for Raycast — a latency stat appearing nowhere in the crawl). It
// bundles the REAL validator + the generator's source/copy helpers via esbuild
// (same pattern as scripts/run-tests.mjs), so the audit can never drift from
// what the gate enforces. No API calls, no writes outside the esbuild cache.
//
// Usage:
//   node scripts/claims-audit.mjs                      # the three trial builds
//   node scripts/claims-audit.mjs <scriptId> [...]     # specific builds
import * as esbuild from "esbuild";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_IDS = [
  "01KTQG2M93MDZV1EMGN2WQ211V", // raycast
  "01KTQH4GC70VM6R4412Q729152", // sentry
  "01KTQJCFVKEJYFK06FX52NCMGT", // posthog
];

const args = process.argv.slice(2).map((a) => a.replace(/\.json$/i, ""));
const ids = args.length > 0 ? args : DEFAULT_IDS;

const root = process.cwd();
const scriptsDir = join(root, ".data", "scripts");
const briefsDir = join(root, ".data", "briefs");

// ── Bundle the production validator + generator helpers (single source of
//    truth — the audit must report exactly what the gate would do). ─────────
const bundle = await esbuild.build({
  stdin: {
    contents: [
      'export { extractStatClaims, findUngroundedClaims } from "./lib/agents/schema-validator";',
      'export { claimGroundingSources, sceneClaimCopy } from "./lib/agents/script-generator";',
    ].join("\n"),
    resolveDir: root,
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  packages: "external",
  write: false,
  logLevel: "silent",
});
const work = join(root, "node_modules", ".cache", "rb-claims-audit");
mkdirSync(work, { recursive: true });
const outFile = join(work, "claims-audit-deps.mjs");
writeFileSync(outFile, bundle.outputFiles[0].text);
const { extractStatClaims, findUngroundedClaims, claimGroundingSources, sceneClaimCopy } =
  await import(pathToFileURL(outFile).href);

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

/** The brief that produced this script: matched by brief.script_id, with the
 *  script's brand_kit_id ("bk_<briefId>") as the fallback. */
const findBrief = (scriptId, script) => {
  let files = [];
  try {
    files = readdirSync(briefsDir).filter((f) => f.endsWith(".json"));
  } catch {
    return null;
  }
  for (const f of files) {
    const brief = readJson(join(briefsDir, f));
    if (brief?.script_id === scriptId) return brief;
  }
  const bk = script?.brand_kit_id;
  if (typeof bk === "string" && bk.startsWith("bk_")) {
    return readJson(join(briefsDir, `${bk.slice(3)}.json`));
  }
  return null;
};

console.log("CLAIMS AUDIT — numeric tokens in script copy vs allowed grounding sources");
console.log("sources: user prompt/purpose + verified claims + crawl title/description/headlines/body excerpts");
console.log("=".repeat(96));

let totalTokens = 0;
let totalFabricated = 0;

for (const id of ids) {
  const script = readJson(join(scriptsDir, `${id}.json`));
  if (!script) {
    console.log(`\n=== ${id}\n  !! script not found at .data/scripts/${id}.json — skipped`);
    continue;
  }
  const brief = findBrief(id, script);
  const brandLabel =
    brief?.brand_kit_url ?? script.brief?.purpose?.slice(0, 60) ?? "(unknown brand)";
  console.log(`\n=== ${id}  (${brandLabel})`);
  if (!brief) {
    console.log("  !! no brief found (no .data/briefs/*.json with this script_id) — grounding sources unavailable; every token below is UNVERIFIABLE, not necessarily fabricated");
  } else {
    console.log(`    brief ${brief.id}`);
  }
  const sourceText = brief ? claimGroundingSources(brief) : "";

  const scenes = Array.isArray(script.scenes) ? script.scenes : [];
  let sceneTokens = 0;
  let sceneFabricated = 0;
  for (const [i, scene] of scenes.entries()) {
    const copy = sceneClaimCopy([scene]);
    const tokens = extractStatClaims(copy);
    if (tokens.length === 0) continue;
    const ungrounded = new Set(findUngroundedClaims(copy, sourceText));
    console.log(`  scene ${i}  "${scene.label ?? "(unlabeled)"}"`);
    for (const token of tokens) {
      const verdict = ungrounded.has(token) ? "FABRICATED" : "grounded";
      console.log(`    ${token.padEnd(16)} ${verdict}`);
      sceneTokens++;
      if (ungrounded.has(token)) sceneFabricated++;
    }
  }
  if (sceneTokens === 0) {
    console.log("  no stat-shaped numeric tokens in scene copy — clean");
  } else {
    console.log(
      `  → ${sceneTokens} numeric token(s): ${sceneTokens - sceneFabricated} grounded, ${sceneFabricated} FABRICATED`,
    );
  }
  totalTokens += sceneTokens;
  totalFabricated += sceneFabricated;
}

console.log("\n" + "=".repeat(96));
console.log(
  `TOTAL: ${totalTokens} numeric token(s) across ${ids.length} script(s) — ${totalTokens - totalFabricated} grounded, ${totalFabricated} FABRICATED`,
);
