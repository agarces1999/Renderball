#!/usr/bin/env node
/**
 * Real cost report from .data/usage.jsonl (written by lib/usage.ts recordUsage).
 *
 * Each line is one costing op (generate / build) with a cache-aware cost_usd
 * already computed at write time, so this script just aggregates. A "build" =
 * one scriptId that reached the build stage; its cost = generate + build.
 *
 * Usage: node scripts/usage-report.mjs
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const logPath = path.join(process.cwd(), ".data", "usage.jsonl");
let raw;
try {
  raw = await fs.readFile(logPath, "utf8");
} catch {
  console.log("No usage recorded yet (.data/usage.jsonl missing).");
  console.log("It populates as builds run — every /api/dev/generate and /api/preview/build appends a row.");
  process.exit(0);
}

const rows = raw
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

if (rows.length === 0) {
  console.log("No usage rows parsed.");
  process.exit(0);
}

const usd = (n) => "$" + n.toFixed(4);
const k = (n) => (n / 1000).toFixed(1) + "k";

// Per-op aggregation.
const ops = {};
const tok = { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
let total = 0;
const byScript = {};
for (const r of rows) {
  const o = (ops[r.op] = ops[r.op] ?? { count: 0, cost: 0 });
  o.count++;
  o.cost += r.cost_usd ?? 0;
  total += r.cost_usd ?? 0;
  const u = r.usage ?? {};
  tok.input += u.input_tokens ?? 0;
  tok.output += u.output_tokens ?? 0;
  tok.cache_read += u.cache_read_input_tokens ?? 0;
  tok.cache_creation += u.cache_creation_input_tokens ?? 0;
  if (r.scriptId) {
    const s = (byScript[r.scriptId] = byScript[r.scriptId] ?? { cost: 0, ops: new Set() });
    s.cost += r.cost_usd ?? 0;
    s.ops.add(r.op);
  }
}

// A full build = a scriptId that reached the build stage.
const builds = Object.values(byScript).filter((s) => s.ops.has("build"));
const buildCosts = builds.map((s) => s.cost).sort((a, b) => a - b);
const sum = (a) => a.reduce((x, y) => x + y, 0);
const avg = buildCosts.length ? sum(buildCosts) / buildCosts.length : 0;
const median = buildCosts.length
  ? buildCosts[Math.floor((buildCosts.length - 1) / 2)]
  : 0;

const dates = rows.map((r) => r.ts).filter(Boolean).sort();

console.log("RENDERBALL — measured cost report");
console.log("=".repeat(48));
console.log(`records: ${rows.length}   span: ${dates[0] ?? "?"} → ${dates[dates.length - 1] ?? "?"}`);
console.log("");
console.log("By operation:");
for (const [op, o] of Object.entries(ops)) {
  console.log(`  ${op.padEnd(10)} n=${String(o.count).padStart(4)}   total ${usd(o.cost).padStart(10)}   avg ${usd(o.cost / o.count)}`);
}
console.log("");
console.log(`FULL BUILDS (generate+build): ${builds.length}`);
if (builds.length) {
  console.log(`  avg per build:    ${usd(avg)}`);
  console.log(`  median per build: ${usd(median)}`);
  console.log(`  min / max:        ${usd(buildCosts[0])} / ${usd(buildCosts[buildCosts.length - 1])}`);
}
console.log("");
const totalInputish = tok.input + tok.cache_read + tok.cache_creation;
const cacheShare = totalInputish ? (tok.cache_read / totalInputish) * 100 : 0;
console.log("Tokens:");
console.log(`  output:          ${k(tok.output)}`);
console.log(`  fresh input:     ${k(tok.input)}`);
console.log(`  cache read:      ${k(tok.cache_read)}  (${cacheShare.toFixed(0)}% of input — billed at 10%)`);
console.log(`  cache write:     ${k(tok.cache_creation)}`);
console.log("");
console.log(`TOTAL SPEND (cache-aware): ${usd(total)}`);
console.log("Note: cost_usd is computed cache-aware at write time (cache read 10%, write 125%).");
