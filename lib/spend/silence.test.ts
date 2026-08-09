/**
 * The ledger noticing its own silence.
 *
 * The counts come from Postgres, so these drive the real query through an
 * injected prisma double rather than mocking the module — what matters is the
 * DECISION (when is silence evidence?), and that is pure.
 */
import { checkLedgerSilence } from "./silence";
import { prisma } from "../db";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try {
    await fn();
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

console.log("spend ledger silence");

/** Swap the two counts the check reads, then put the real ones back. */
const withCounts = async (docs: number | Error, rows: number, fn: () => Promise<void>) => {
  const realDoc = prisma.scriptDoc.count;
  const realSpend = prisma.spendRecord.count;
  (prisma.scriptDoc as { count: unknown }).count = async () => {
    if (docs instanceof Error) throw docs;
    return docs;
  };
  (prisma.spendRecord as { count: unknown }).count = async () => rows;
  try {
    await fn();
  } finally {
    (prisma.scriptDoc as { count: unknown }).count = realDoc;
    (prisma.spendRecord as { count: unknown }).count = realSpend;
  }
};

await check("documents generated, ledger empty → SILENT", async () => {
  await withCounts(12, 0, async () => {
    const r = await checkLedgerSilence();
    assert(r.silent, "twelve documents and zero spend rows is the failure this exists for");
    assert(/\$31|cannot see|unwired/.test(r.reason), `the reason must name what happened: ${r.reason}`);
  });
});

await check("documents generated AND spend recorded → healthy", async () => {
  await withCounts(12, 9, async () => {
    const r = await checkLedgerSilence();
    assert(!r.silent, "recording is working; nothing to report");
    assert(r.reason === "", "a healthy check says nothing");
  });
});

await check("a QUIET product is not an alarm", async () => {
  // Nobody generated. Zero spend is correct, not suspicious.
  await withCounts(0, 0, async () => {
    const r = await checkLedgerSilence();
    assert(!r.silent, "no activity must never alarm");
  });
});

await check("one or two documents is not enough evidence", async () => {
  // A blank document created and abandoned never reaches a model, so it
  // SHOULD record nothing. Alarming on that trains everyone to ignore this.
  await withCounts(2, 0, async () => {
    const r = await checkLedgerSilence();
    assert(!r.silent, "below the floor, silence is not evidence");
  });
});

await check("a database that cannot answer does NOT raise a false alarm", async () => {
  // A monitoring query must never take the product down, and a false alarm
  // here is how the last signal died — 40 red CI runs nobody read.
  await withCounts(new Error("neon cold start"), 0, async () => {
    const r = await checkLedgerSilence();
    assert(!r.silent, "an unanswerable query is not evidence of silence");
    assert(r.reason === "", "and it must not shout");
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
