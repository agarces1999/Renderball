/**
 * Every door money can leave through must be metered — or declared here.
 *
 * WHY THIS EXISTS: in August the Fireworks dashboard said $37.69 and our own
 * records covered $6.52. The missing $31.17 was not a bug in the ledger; it was
 * a path that never wrote to it — `.data/outline-matrix/gen.mjs`, an esbuild
 * bundle of our own lib that called api.fireworks.ai with recordUsage
 * tree-shaken out. Nothing was broken. Something was simply never wired.
 *
 * That is the failure mode this file exists to make impossible. Metering by
 * convention — "remember to call recordUsage" — has already been tried: it has
 * eight call sites and still lost 83% of a month's spend, because every NEW
 * surface starts uninstrumented and no one notices until the invoice.
 *
 * So the rule is structural. Any file that reaches a paid provider must either
 * be one of the metered transports, or be listed below with a reason. Adding a
 * fifth door without doing one of those turns this test red.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`);
  }
};
const assert = (c: boolean, m: string) => {
  if (!c) throw new Error(m);
};

console.log("spend doors (every paid wire is metered or declared)");

/** Hosts that cost money when you talk to them. */
const PAID_HOSTS = /api\.fireworks\.ai|api\.z\.ai|api\.anthropic\.com|api\.openai\.com|api\.replicate\.com|api\.cerebras\.ai/;

/** The metered transports. Every paid call in the product goes through one. */
const TRANSPORTS = [
  "lib/llm/cast-provider.ts", // all text
  "lib/render/zai-vision.ts", // callZaiVision AND callZaiText — two functions, one file
  "lib/llm/image-provider.ts", // per-image billing, not per token
];

/**
 * Paid wires that are deliberately NOT metered. Each needs a reason, because
 * an entry here is a hole in the number by choice rather than by accident.
 */
const DECLARED: Record<string, string> = {
  "lib/anthropic.ts":
    "DEAD — zero call sites (asserted below). Kept per CLAUDE.md as dormant routing, " +
    "but it constructs a real client with a real key, so it stays on this list and " +
    "under the no-call-sites assertion until it is deleted.",
  "scripts/probe-model-speed.mjs":
    "Offline diagnostic (founder question 2026-08-20: faster models with " +
    "similar quality?): streams one deck-shaped prompt per candidate model " +
    "to measure TTFT + tokens/sec + wall-clock-to-complete. ~cents per run, " +
    "human-run only. Its finding (V4-Flash 1.8x faster wall-clock, ~20x " +
    "cheaper) drove the script-stage swap in script-generator.ts.",
  "scripts/probe-thinking-off.mjs":
    "Offline diagnostic (speed playbook 2026-08-18): probes which parameter " +
    "shapes disable GLM-5.2 reasoning on the Fireworks wire. Five ~8-token " +
    "calls, cents total, human-run only. Its finding (reasoning_effort:'none' " +
    "works — 663ms/8 tok vs 6790ms/768 tok) is wired into the shorten paths.",
  "scripts/model-bakeoff.mjs":
    "Offline model decision harness (the 2026-07-14 speed x quality pivot). Not " +
    "referenced by package.json or any product path; spends only when a human runs " +
    "it deliberately. Run `npm run spend` either side of it — the ledger will NOT " +
    "show these calls.",
};

const SCAN_DIRS = ["app", "lib", "scripts", "src", "components", "qa"];

const walk = (dir: string, out: string[] = []): string[] => {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === ".next" || e === ".data") continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(full)) out.push(full);
  }
  return out;
};

/**
 * Source with comments removed.
 *
 * The first run of this test reported lib/llm/build-client.ts as a caller of
 * getAnthropic(). It is not — the match was inside a comment explaining the
 * migration AWAY from it. A guard that cries wolf gets muted, which is the
 * same ending as a CI pipeline nobody reads, so it reads code and not prose.
 */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

const root = process.cwd();
const files = SCAN_DIRS.flatMap((d) => walk(join(root, d)));

check("no UNDECLARED file talks to a paid provider", () => {
  const offenders: string[] = [];
  for (const f of files) {
    const rel = relative(root, f);
    if (rel.includes(".test.")) continue; // tests assert on host strings
    if (TRANSPORTS.includes(rel) || rel in DECLARED) continue;
    const src = code(readFileSync(f, "utf8"));
    // A DOOR is a file that both names a paid host AND opens a connection to
    // one. Naming a host is not spending: scripts/cast-spike.ts carries a
    // default base-URL string but routes every call through castCall, the
    // metered transport — flagging it would train us to ignore this list.
    const opensAConnection = /\bfetch\s*\(/.test(src) || /new\s+Anthropic\s*\(/.test(src);
    if (PAID_HOSTS.test(src) && opensAConnection) offenders.push(rel);
  }
  assert(
    offenders.length === 0,
    `these reach a paid provider but are neither a metered transport nor declared:\n` +
      offenders.map((o) => `      ${o}`).join("\n") +
      `\n      Either route the call through a metered transport, or add it to DECLARED with a reason.`,
  );
});

check("every metered transport actually records", () => {
  for (const t of TRANSPORTS) {
    const src = code(readFileSync(join(root, t), "utf8"));
    assert(/recordSpend\s*\(/.test(src), `${t} reaches a provider but never calls recordSpend`);
  }
});

check("the dead Anthropic client stays dead", () => {
  // The moment someone imports it, its calls are unmetered — so this goes red
  // and they have to meter it or route through castCall.
  const callers = files.filter((f) => {
    const rel = relative(root, f);
    if (rel === "lib/anthropic.ts" || rel.includes(".test.")) return false;
    return /\bgetAnthropic\s*\(/.test(code(readFileSync(f, "utf8")));
  });
  assert(
    callers.length === 0,
    `getAnthropic() is now called from:\n${callers.map((c) => `      ${relative(root, c)}`).join("\n")}\n` +
      `      It bypasses the ledger. Meter it or use castCall.`,
  );
});

check("a declared exception must carry a reason", () => {
  for (const [file, reason] of Object.entries(DECLARED)) {
    assert(reason.trim().length > 40, `${file} is declared without a real reason`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
