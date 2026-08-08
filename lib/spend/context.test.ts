/**
 * Tests for the spend-ledger attribution context.
 *
 * The behaviour worth defending here is narrow and specific: a build fills its
 * scenes with Promise.all, so several stages are genuinely in flight at once
 * inside one process. A module-level global would pass a naive test and then
 * cross-attribute the most expensive part of the product in production. The
 * fan-out check below is the one that fails if anyone "simplifies" this to a
 * let-variable — verified by doing exactly that (see the break-and-restore
 * report in the PR body).
 *
 * Also pinned: a missing label must never LOSE a row. It lands as
 * "unattributed", which is the signal that an entrypoint still needs wiring —
 * not a dropped dollar.
 */
import { withSpend, spendContext } from "./context";
import { makeSpendRow, recordSpend, __setSpendWriterForTests, type SpendRow } from "./record";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("spend/context (AsyncLocalStorage attribution)");

const FW = "accounts/fireworks/routers/glm-5p2-fast";

// The runner disarms the ledger process-wide (scripts/run-tests.mjs). This file
// is the subject, so it turns it back on with its own in-memory writer — no
// database, no disk, no network.
const savedDisable = process.env.RB_SPEND_DISABLE;
delete process.env.RB_SPEND_DISABLE;
let rows: SpendRow[] = [];
__setSpendWriterForTests(async (r) => { rows.push(r); });
const reset = () => { rows = []; };

await check("no context: the row is still recorded, labelled 'unattributed'", async () => {
  reset();
  await recordSpend({ model: FW, inputTokens: 100, outputTokens: 10 });
  assert(rows.length === 1, `expected 1 row, got ${rows.length} — a missing label must never lose a row`);
  assert(rows[0].stage === "unattributed", `expected "unattributed", got "${rows[0].stage}"`);
  assert(rows[0].costUsd > 0, "an unattributed row still carries its real cost");
});

await check("withSpend labels every call made inside it", async () => {
  reset();
  await withSpend({ stage: "outline", scriptId: "deck-1", ownerId: "user-1" }, async () => {
    await recordSpend({ model: FW, inputTokens: 100, outputTokens: 10 });
  });
  assert(rows[0].stage === "outline", `stage: ${rows[0].stage}`);
  assert(rows[0].scriptId === "deck-1", `scriptId: ${rows[0].scriptId}`);
  assert(rows[0].ownerId === "user-1", `ownerId: ${rows[0].ownerId}`);
});

await check("nesting: inner stage wins, outer scriptId/ownerId are INHERITED", async () => {
  reset();
  await withSpend({ stage: "build", scriptId: "deck-2", ownerId: "user-2", runId: "run-2" }, async () => {
    await withSpend({ stage: "build.motion" }, async () => {
      await recordSpend({ model: FW, inputTokens: 1, outputTokens: 1 });
    });
  });
  assert(rows[0].stage === "build.motion", `inner stage must win, got ${rows[0].stage}`);
  // The failure this guards: a naive `run(ctx)` replaces the whole store, so a
  // phase that re-labels itself would silently orphan the deck it belongs to
  // and cost-per-deck would go quietly wrong rather than loudly missing.
  assert(rows[0].scriptId === "deck-2", `outer scriptId must be inherited, got ${rows[0].scriptId}`);
  assert(rows[0].runId === "run-2", `outer runId must be inherited, got ${rows[0].runId}`);
});

await check("an explicit call-site stage beats the ambient context", async () => {
  reset();
  await withSpend({ stage: "build" }, async () => {
    await recordSpend({ model: FW, stage: "gate.vision", inputTokens: 1, outputTokens: 1 });
  });
  assert(rows[0].stage === "gate.vision", `explicit stage must win, got ${rows[0].stage}`);
});

await check("precedence is caller → context → transport default → unattributed", async () => {
  // The transport default must sit BELOW the context, not above it. If it sat
  // above, every crawl vision call would read "vision" and the fact that it was
  // a crawl — the thing you need to answer "what does onboarding cost" —
  // would be erased at the transport.
  reset();
  await withSpend({ stage: "crawl" }, async () => {
    await recordSpend({ model: FW, defaultStage: "vision", inputTokens: 1, outputTokens: 1 });
  });
  assert(rows[0].stage === "crawl", `context must beat the transport default, got ${rows[0].stage}`);
  reset();
  await recordSpend({ model: FW, defaultStage: "vision", inputTokens: 1, outputTokens: 1 });
  assert(rows[0].stage === "vision", `with no context the transport default applies, got ${rows[0].stage}`);
});

await check("context survives an await boundary", async () => {
  reset();
  await withSpend({ stage: "build", scriptId: "deck-3" }, async () => {
    await new Promise((r) => setTimeout(r, 5));
    await recordSpend({ model: FW, inputTokens: 1, outputTokens: 1 });
  });
  assert(rows[0].stage === "build" && rows[0].scriptId === "deck-3", "context lost across await");
});

await check("PARALLEL FAN-OUT: each branch keeps its own stage (the Promise.all case)", async () => {
  // This is what runPreviewBuild actually does — five scenes filled at once.
  // A module-global implementation passes every test above and fails here,
  // attributing whichever branch wrote last to all five.
  reset();
  await withSpend({ stage: "build", scriptId: "deck-4" }, async () =>
    Promise.all(
      ["fill.0", "fill.1", "fill.2", "fill.3", "fill.4"].map((stage, i) =>
        withSpend({ stage }, async () => {
          // Staggered so the branches genuinely interleave rather than running
          // to completion one after another.
          await new Promise((r) => setTimeout(r, (5 - i) * 4));
          await recordSpend({ model: FW, inputTokens: 10, outputTokens: 1 });
        }),
      ),
    ),
  );
  assert(rows.length === 5, `expected 5 rows, got ${rows.length}`);
  const stages = rows.map((r) => r.stage).sort();
  assert(
    stages.join(",") === "fill.0,fill.1,fill.2,fill.3,fill.4",
    `each branch must keep its own stage — got ${stages.join(",")}`,
  );
  assert(rows.every((r) => r.scriptId === "deck-4"), "every branch inherits the deck");
});

await check("spendContext() is empty outside any scope and does not leak after one", async () => {
  assert(Object.keys(spendContext()).length === 0, "context leaked out of withSpend");
  await withSpend({ stage: "x" }, async () => {
    assert(spendContext().stage === "x", "inside the scope");
  });
  assert(spendContext().stage === undefined, "context must not persist after the scope ends");
});

await check("makeSpendRow reads the ambient context when the caller passes none", async () => {
  await withSpend({ stage: "outline", scriptId: "deck-5" }, async () => {
    const row = makeSpendRow({ model: FW, inputTokens: 5, outputTokens: 5 });
    assert(row.stage === "outline" && row.scriptId === "deck-5", "pure builder must see the context too");
  });
});

__setSpendWriterForTests(null);
if (savedDisable === undefined) delete process.env.RB_SPEND_DISABLE;
else process.env.RB_SPEND_DISABLE = savedDisable;

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
