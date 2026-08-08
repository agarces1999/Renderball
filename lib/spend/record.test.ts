/**
 * Tests for the spend-ledger sink.
 *
 * What these defend, in the order that matters:
 *  1. The number is RIGHT — priced by lib/usage.ts's costUsd, never by a
 *     second rate table. Two ledgers disagreeing about the same call is worse
 *     than one being wrong.
 *  2. The number is HONEST — an unmeasurable call records a zero, never an
 *     estimate, and the flag that says so is on the row.
 *  3. Recording NEVER breaks the call it is recording, and never loses a row
 *     to concurrency. Both are exercised against the real append path, not a
 *     mock: PIPE_BUF atomicity is the actual property being relied on.
 *
 * No database, no network, no live model call. The real Postgres branch is
 * skipped by unsetting DATABASE_URL; that branch's own risk (Neon cold wake)
 * is already covered by withDbRetry in lib/db.ts.
 */
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { costUsd, imageCostUsd, EMPTY_USAGE } from "../usage";
import {
  makeSpendRow,
  recordSpend,
  flushSpend,
  spendOrigin,
  RATE_VERSION,
  __setSpendWriterForTests,
  type SpendRow,
} from "./record";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("spend/record (the ledger sink)");

const FW = "accounts/fireworks/routers/glm-5p2-fast";
const KIMI = "accounts/fireworks/models/kimi-k2p6";
const SDXL = "accounts/fireworks/models/stable-diffusion-xl-1024-v1-0";

// The runner disarms the ledger process-wide and loads a real DATABASE_URL
// from .env.local. This file is the ledger's own suite, so it re-arms it and
// points every write at a temp file — never the developer's .data, never Neon.
const saved: Record<string, string | undefined> = {
  RB_SPEND_DISABLE: process.env.RB_SPEND_DISABLE,
  RB_SPEND_LOG: process.env.RB_SPEND_LOG,
  RB_SPEND_ORIGIN: process.env.RB_SPEND_ORIGIN,
  DATABASE_URL: process.env.DATABASE_URL,
  NEXT_RUNTIME: process.env.NEXT_RUNTIME,
};
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rb-spend-"));
delete process.env.RB_SPEND_DISABLE;
delete process.env.DATABASE_URL; // force the file branch; no Postgres in unit tests
delete process.env.RB_SPEND_ORIGIN;
process.env.RB_SPEND_LOG = path.join(tmpDir, "spend.jsonl");

const readLog = async (file = process.env.RB_SPEND_LOG!): Promise<SpendRow[]> => {
  const raw = await fs.readFile(file, "utf8").catch(() => "");
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
};

// ── 1. the number is right ──────────────────────────────────────────────────

await check("cost is priced by lib/usage.ts costUsd — not a second rate table", async () => {
  const row = makeSpendRow({ model: FW, inputTokens: 40_000, outputTokens: 3_000 }, {});
  const expected = costUsd(FW, {
    ...EMPTY_USAGE,
    input_tokens: 40_000,
    output_tokens: 3_000,
  });
  assert(
    Math.abs(row.costUsd - expected) < 1e-8,
    `ledger priced ${row.costUsd}, costUsd() says ${expected} — the two must never diverge`,
  );
  // Sanity on the actual money: 40k in at $2.10/M + 3k out at $6.60/M.
  assert(Math.abs(row.costUsd - (40_000 * 2.1 + 3_000 * 6.6) / 1e6) < 1e-8, "GLM fast-router rate");
});

await check("the vision model prices on ITS row, not the text model's", async () => {
  const row = makeSpendRow({ model: KIMI, inputTokens: 10_000, outputTokens: 500 }, {});
  const expected = costUsd(KIMI, { ...EMPTY_USAGE, input_tokens: 10_000, output_tokens: 500 });
  assert(Math.abs(row.costUsd - expected) < 1e-8, `${row.costUsd} vs ${expected}`);
  assert(row.costUsd < makeSpendRow({ model: FW, inputTokens: 10_000, outputTokens: 500 }, {}).costUsd,
    "Kimi is cheaper than the GLM fast router — a model mix-up would show up here");
});

await check("an image row is priced per IMAGE and carries zero tokens", async () => {
  const row = makeSpendRow({ model: SDXL, images: 1 }, {});
  assert(row.images === 1, "image count recorded");
  assert(row.inputTokens === 0 && row.outputTokens === 0, "per-image billing has no tokens");
  assert(Math.abs(row.costUsd - imageCostUsd(SDXL, 1)) < 1e-8, `${row.costUsd} vs ${imageCostUsd(SDXL, 1)}`);
  assert(row.costUsd > 0, "an image is not free — this door bypasses both token transports");
});

await check("cached tokens are RECORDED but not discounted (unverified semantics)", async () => {
  // lib/usage.ts's standing rule is to overstate rather than understate, and
  // Fireworks' cached-input semantics are unverified on this account (no
  // invoice, and a live probe costs money). The count is stored so the first
  // real invoice can re-price history instead of us having to re-collect it.
  const plain = makeSpendRow({ model: FW, inputTokens: 10_000, outputTokens: 100 }, {});
  const cached = makeSpendRow({ model: FW, inputTokens: 10_000, outputTokens: 100, cachedTokens: 8_000 }, {});
  assert(cached.cachedTokens === 8_000, "cached count must be on the row");
  assert(cached.costUsd === plain.costUsd, "cached tokens must not silently discount an unverified rate");
  assert(cached.rateVersion === RATE_VERSION, "the row says which rate table priced it");
});

// ── 2. the number is honest ─────────────────────────────────────────────────

await check("an unmeasurable call records ZERO, never an estimate", async () => {
  const row = makeSpendRow({ model: FW, ok: false, tokensUnknown: true, latencyMs: 1_529_000 }, {});
  assert(row.costUsd === 0, `a marker must cost exactly 0, got ${row.costUsd}`);
  assert(row.inputTokens === 0 && row.outputTokens === 0, "no fabricated token counts");
  assert(row.tokensUnknown === true && row.ok === false, "the row says WHY it is zero");
  // The elapsed time is the whole point of the marker: 22 sub-2s failures in
  // August almost certainly never prefilled, while 7 that ran past 300s were
  // real billed generation. Without latency they are indistinguishable.
  assert(row.latencyMs === 1_529_000, "elapsed time is what makes the marker useful");
});

await check("garbage token counts cannot poison the total", async () => {
  const row = makeSpendRow(
    { model: FW, inputTokens: Number.NaN, outputTokens: -5, images: Number.POSITIVE_INFINITY },
    {},
  );
  assert(row.inputTokens === 0 && row.outputTokens === 0 && row.images === 0, "non-finite/negative → 0");
  assert(row.costUsd === 0 && Number.isFinite(row.costUsd), "cost stays a finite number");
});

await check("origin separates offline lab spend from customer spend", async () => {
  delete process.env.NEXT_RUNTIME;
  assert(spendOrigin() === "script", "a plain node process is a script");
  process.env.NEXT_RUNTIME = "nodejs";
  assert(spendOrigin() === "web", "the Next server is web");
  delete process.env.NEXT_RUNTIME;
  // Offline lab runs were the MAJORITY of August's spend; unit economics over
  // a table that mixes them with customers' are fiction.
  assert(makeSpendRow({ model: FW }, {}).origin === "script", "origin lands on the row");
});

// ── 3. recording never breaks the call, never loses a row ───────────────────

await check("RB_SPEND_DISABLE=1 writes nothing at all", async () => {
  const file = path.join(tmpDir, "disabled.jsonl");
  process.env.RB_SPEND_LOG = file;
  process.env.RB_SPEND_DISABLE = "1";
  try {
    await recordSpend({ model: FW, inputTokens: 999, outputTokens: 999 });
  } finally {
    delete process.env.RB_SPEND_DISABLE;
  }
  assert((await readLog(file)).length === 0, "a disabled ledger must write zero rows");
});

await check("a THROWING writer is swallowed and the row falls back to disk", async () => {
  const file = path.join(tmpDir, "fallback.jsonl");
  process.env.RB_SPEND_LOG = file;
  __setSpendWriterForTests(async () => {
    throw new Error("simulated Neon outage");
  });
  let threw: unknown = null;
  try {
    // The contract the whole module hangs on: this promise ALWAYS resolves.
    await recordSpend({ model: FW, inputTokens: 100, outputTokens: 10, stage: "build" });
  } catch (e) {
    threw = e;
  } finally {
    __setSpendWriterForTests(null);
  }
  assert(threw === null, `recordSpend must never reject — it threw ${String(threw)}`);
  const rows = await readLog(file);
  assert(rows.length === 1, `the row must survive the write failure on disk, got ${rows.length}`);
  assert(rows[0].stage === "build", "and survive intact");
});

await check("a caller that ignores the promise is never poisoned by the ledger", async () => {
  __setSpendWriterForTests(async () => {
    throw new Error("simulated outage");
  });
  const file = path.join(tmpDir, "voided.jsonl");
  process.env.RB_SPEND_LOG = file;
  // This is exactly how the transports call it: `void recordSpend(...)`. An
  // unhandled rejection here would crash the process the user's build runs in.
  let unhandled: unknown = null;
  const onUnhandled = (e: unknown) => { unhandled = e; };
  process.on("unhandledRejection", onUnhandled);
  void recordSpend({ model: FW, inputTokens: 1, outputTokens: 1 });
  await flushSpend();
  await new Promise((r) => setTimeout(r, 20)); // let any rejection surface
  process.off("unhandledRejection", onUnhandled);
  __setSpendWriterForTests(null);
  assert(unhandled === null, `void recordSpend must not produce an unhandled rejection: ${String(unhandled)}`);
});

await check("CONCURRENT calls do not lose rows (real append path, not a mock)", async () => {
  const file = path.join(tmpDir, "concurrent.jsonl");
  process.env.RB_SPEND_LOG = file;
  __setSpendWriterForTests(null);
  const N = 60; // more than a p90 build's ~45 provider calls
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      recordSpend({ model: FW, stage: `s${i}`, inputTokens: 1_000, outputTokens: 100 }),
    ),
  );
  const rows = await readLog(file);
  assert(rows.length === N, `expected ${N} rows, got ${rows.length} — concurrent writes lost data`);
  const stages = new Set(rows.map((r) => r.stage));
  assert(stages.size === N, `expected ${N} distinct stages, got ${stages.size} — rows overwrote each other`);
  // Lines must be whole: an interleaved partial write would have failed the
  // JSON.parse in readLog above, but assert the arithmetic too, since the
  // TOTAL is the number the founder actually reads.
  const total = rows.reduce((s, r) => s + Number(r.costUsd), 0);
  const one = costUsd(FW, { ...EMPTY_USAGE, input_tokens: 1_000, output_tokens: 100 });
  assert(Math.abs(total - N * one) < 1e-6, `total ${total} should be ${N * one}`);
});

await check("flushSpend awaits in-flight writes (the offline-script exit case)", async () => {
  const file = path.join(tmpDir, "flush.jsonl");
  process.env.RB_SPEND_LOG = file;
  __setSpendWriterForTests(null);
  // Fire-and-forget, exactly as a lab harness would, then flush before exit.
  for (let i = 0; i < 10; i++) void recordSpend({ model: FW, inputTokens: 10, outputTokens: 1 });
  await flushSpend();
  assert((await readLog(file)).length === 10, "flushSpend must leave nothing in flight");
});

await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
__setSpendWriterForTests(null);
for (const [k, v] of Object.entries(saved)) {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
