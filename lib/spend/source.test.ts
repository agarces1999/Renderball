/**
 * Where the numbers come FROM — and what happens when a source is missing.
 *
 * Run: `node scripts/run-tests.mjs lib/spend/source.test.ts`. No database and
 * no network: these drive the two file paths against real temp files, which is
 * exactly the state production degrades to when Postgres cannot answer.
 *
 * The property under test is not "parsing works". It is that a source being
 * absent produces a LABELLED gap rather than a confident $0.00 — the failure
 * mode that let August's real $37.69 read as $6.52 without anyone noticing.
 */
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { fallbackRowToLedgerRow, legacyRowToSpendRow, loadSpendRows } from "./source";
import { summarize } from "./ledger";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => Promise<void> | void) => {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : err}`);
  }
};
const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg);
};
const near = (a: number, b: number, eps = 1e-9) => {
  if (Math.abs(a - b) > eps) throw new Error(`expected ${a} ≈ ${b}`);
};

/**
 * Every test in this file runs with DATABASE_URL removed and RB_SPEND_LOG
 * pointed at a temp file. Both matter: the first keeps a real Neon out of a
 * unit test, the second keeps phantom rows out of the developer's own ledger.
 */
const savedDb = process.env.DATABASE_URL;
const savedLog = process.env.RB_SPEND_LOG;
delete process.env.DATABASE_URL;

let tmpDir = "";
const withFiles = async (
  files: { spend?: string; usage?: string },
  body: () => Promise<void>,
): Promise<void> => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rb-spend-"));
  const spendFile = path.join(tmpDir, "spend.jsonl");
  if (files.spend !== undefined) await fs.writeFile(spendFile, files.spend, "utf8");
  process.env.RB_SPEND_LOG = spendFile;
  // The legacy file is resolved from cwd, so it cannot be redirected the same
  // way; tests that need it pass includeJsonl and assert only on shape.
  try {
    await body();
  } finally {
    process.env.RB_SPEND_LOG = savedLog ?? spendFile;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
};

const fallbackLine = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    at: "2026-08-08T10:00:00.000Z",
    provider: "fireworks",
    model: "accounts/fireworks/routers/glm-5p2-fast",
    stage: "build.fill",
    inputTokens: 1000,
    outputTokens: 500,
    cachedTokens: 0,
    images: 0,
    costUsd: 0.0054,
    rateVersion: "2026-08-08",
    ownerId: null,
    scriptId: "deck1",
    runId: null,
    ok: true,
    tokensUnknown: false,
    latencyMs: 1200,
    origin: "script",
    ...over,
  });

await check("rows that never reached Postgres are INCLUDED, not merely mentioned", async () => {
  await withFiles(
    { spend: [fallbackLine(), fallbackLine({ costUsd: 0.0046, stage: "outline" })].join("\n") + "\n" },
    async () => {
      const loaded = await loadSpendRows();
      assert(loaded.rows.length === 2, `expected 2 rows, got ${loaded.rows.length}`);
      assert(loaded.source === "file", `source should be "file", got ${loaded.source}`);
      assert(!loaded.postgresAvailable, "no DATABASE_URL means no Postgres");
      const s = summarize(loaded.rows, { now: new Date("2026-08-08T14:00:00.000Z") });
      // A failed DB write must not become invisible spend — that is the exact
      // shape of the bug this whole system exists to end.
      near(s.today.costUsd, 0.01);
      assert(s.integrity.fromFallbackFile === 2, "both rows attributed to the fallback file");
    },
  );
});

await check("a missing fallback file is silent, not an error", async () => {
  await withFiles({}, async () => {
    const loaded = await loadSpendRows();
    assert(loaded.rows.length === 0, "no rows");
    assert(loaded.source === "none", `source should be "none", got ${loaded.source}`);
    assert(
      loaded.notes.some((n) => n.includes("DATABASE_URL")),
      "but the reader must SAY the database was not consulted",
    );
  });
});

await check("an unparsable line is skipped and counted, never fatal", async () => {
  await withFiles({ spend: [fallbackLine(), "{not json", ""].join("\n") + "\n" }, async () => {
    const loaded = await loadSpendRows();
    assert(loaded.rows.length === 1, "the good row still loads");
    assert(
      loaded.notes.some((n) => n.includes("unparsable")),
      "a corrupt line must be reported, not swallowed — it is money we cannot see",
    );
  });
});

await check("the window filter is applied to file rows too", async () => {
  await withFiles(
    {
      spend:
        [
          fallbackLine({ at: "2026-08-01T10:00:00.000Z" }),
          fallbackLine({ at: "2026-08-08T10:00:00.000Z" }),
          fallbackLine({ at: "2026-08-20T10:00:00.000Z" }),
        ].join("\n") + "\n",
    },
    async () => {
      const loaded = await loadSpendRows({
        since: new Date("2026-08-05T00:00:00.000Z"),
        until: new Date("2026-08-10T00:00:00.000Z"),
      });
      assert(loaded.rows.length === 1, `expected 1 row in window, got ${loaded.rows.length}`);
      assert(loaded.rows[0].at.toISOString() === "2026-08-08T10:00:00.000Z", "the right one");
    },
  );
});

await check("the LEGACY file is not read unless asked for", async () => {
  // recordUsage and recordSpend both run today. Merging them silently would
  // double count the same money, which is exactly as wrong as missing it.
  await withFiles({ spend: fallbackLine() + "\n" }, async () => {
    const off = await loadSpendRows();
    const on = await loadSpendRows({ includeJsonl: true });
    assert(
      on.rows.length >= off.rows.length,
      "includeJsonl can only add rows",
    );
    assert(
      off.rows.every((r) => r.source !== "usage-jsonl"),
      "the legacy ledger must stay out of the default read",
    );
  });
});

await check("fallback rows keep every field the report reasons about", () => {
  const r = fallbackRowToLedgerRow(
    JSON.parse(fallbackLine({ ok: false, tokensUnknown: true, latencyMs: 310_000 })),
  );
  assert(r !== null, "parsed");
  assert(r!.stage === "build.fill" && r!.scriptId === "deck1", "stage and deck");
  assert(r!.ok === false, "a failed call stays marked failed");
  assert(r!.tokensUnknown === true && r!.latencyMs === 310_000, "the honest-floor fields survive");
  assert(r!.source === "spend-jsonl", "labelled by where it came from");
});

await check("a row with no timestamp is rejected rather than dated 1970", () => {
  assert(fallbackRowToLedgerRow({} as never) === null, "no `at`");
  assert(fallbackRowToLedgerRow({ at: "not-a-date" } as never) === null, "unparsable `at`");
  // A row silently stamped 1970 lands outside every window and vanishes from
  // both the daily and the monthly total — the worst kind of missing.
});

await check("legacy ops map onto the stage vocabulary the transports write", () => {
  const map = (op: string) =>
    legacyRowToSpendRow({ ts: "2026-08-08T10:00:00.000Z", op, model: "glm-5.2", cost_usd: 1 })?.stage;
  assert(map("generate") === "outline", `generate → outline, got ${map("generate")}`);
  assert(map("vision-qa") === "vision", `vision-qa → vision, got ${map("vision-qa")}`);
  assert(map("insert-element") === "edit.insert", "insert-element → edit.insert");
  assert(map("crawl") === "crawl", "crawl stays crawl");
  // An unrecognised op passes through verbatim: renaming it to "other" would
  // hide a category of spend, which is the failure, not the fix.
  assert(map("some-future-op") === "some-future-op", "unknown ops pass through");
});

await check("legacy cache tokens are carried, not dropped", () => {
  const r = legacyRowToSpendRow({
    ts: "2026-08-08T10:00:00.000Z",
    op: "build",
    model: "claude-opus-4-8",
    cost_usd: 1.41,
    usage: {
      input_tokens: 27706,
      output_tokens: 37323,
      cache_creation_input_tokens: 50400,
      cache_read_input_tokens: 47056,
    },
  });
  assert(r !== null, "parsed");
  assert(r!.cachedTokens === 97456, `cache read + write, got ${r!.cachedTokens}`);
  near(r!.costUsd, 1.41);
});

if (savedDb !== undefined) process.env.DATABASE_URL = savedDb;
if (savedLog === undefined) delete process.env.RB_SPEND_LOG;
else process.env.RB_SPEND_LOG = savedLog;

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
