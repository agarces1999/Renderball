//
// QA entry point. See scripts/run-qa.mjs for invocation.
//
import { promises as fs } from "fs";
import path from "path";
import { runFlows, type Tier } from "./harness";
import { loadScript, saveScript, DEV_OWNER_ID } from "../lib/store";
import { editorFlows } from "./flows/editor";
import { documentFlows } from "./flows/document";

const BASE = process.env.QA_BASE ?? "http://localhost:3000";
const TIER = (process.env.QA_TIER ?? "free") as Tier;
const CONCURRENCY = Number(process.env.QA_CONCURRENCY ?? 3);
const ARTIFACTS = process.env.QA_ARTIFACTS ?? path.join(process.cwd(), ".data", "qa");

/**
 * Pick a deck the dev harness can open.
 *
 * /dev/edit loads scripts owned by DEV_OWNER_ID, so the suite needs one that
 * exists locally. Explicit QA_DEV_SCRIPT_ID wins; otherwise the newest built
 * document on disk is used, which is almost always what a developer wants.
 */
const resolveDevScript = async (): Promise<string> => {
  if (process.env.QA_DEV_SCRIPT_ID) return process.env.QA_DEV_SCRIPT_ID;
  const dir = path.join(process.cwd(), "src", "generated");
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  const withTime = await Promise.all(
    entries.map(async (id) => {
      const manifest = path.join(dir, id, "lego", "manifest.json");
      const st = await fs.stat(manifest).catch(() => null);
      return st ? { id, at: st.mtimeMs } : null;
    }),
  );
  const usable = withTime.filter((v): v is { id: string; at: number } => v !== null);
  usable.sort((a, b) => b.at - a.at);
  return usable[0]?.id ?? "";
};

/**
 * Snapshot and restore the document under test.
 *
 * The flows genuinely edit the deck — that is the point — but without a reset
 * every run starts from the wreckage of the last one: pieces deleted, s0.addN
 * accumulating, and the element a flow targets drifting run to run. Results stop
 * being comparable and failures stop being reproducible, which is exactly what
 * happened while building this.
 *
 * A restore also runs BEFORE the suite, so a crashed or cancelled run cannot
 * leave the fixture permanently altered.
 */
const genDirOf = (id: string) => path.join(process.cwd(), "src", "generated", id);
const backupOf = (id: string) => path.join(process.cwd(), ".data", "qa-fixtures", id);

/**
 * The script row, snapshotted alongside the files.
 *
 * A document is TWO things: the generated sources on disk and the script in the
 * database. Page operations change the script — add, duplicate, remove, reorder
 * — so restoring only the directory leaves the two disagreeing about how many
 * pages exist, and every page-op flow afterwards fails for reasons that have
 * nothing to do with page ops. Both halves are captured, both are put back.
 */
let scriptSnapshot: unknown = null;

const snapshotFixture = async (id: string): Promise<void> => {
  const src = genDirOf(id);
  const dst = backupOf(id);
  const already = await fs.stat(dst).then(() => true).catch(() => false);
  if (already) return; // an earlier snapshot is the pristine one — keep it
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.cp(src, dst, { recursive: true });
};

/** Captured once per run, before anything has touched the document. */
const snapshotScript = async (id: string): Promise<void> => {
  if (scriptSnapshot) return;
  scriptSnapshot = await loadScript(id, DEV_OWNER_ID).catch(() => null);
};

const restoreFixture = async (id: string): Promise<boolean> => {
  const src = backupOf(id);
  const ok = await fs.stat(src).then(() => true).catch(() => false);
  if (!ok) return false;
  await fs.rm(genDirOf(id), { recursive: true, force: true });
  await fs.cp(src, genDirOf(id), { recursive: true });
  if (scriptSnapshot) {
    await saveScript(scriptSnapshot as Parameters<typeof saveScript>[0], DEV_OWNER_ID).catch(() => {});
  }
  return true;
};

const main = async (): Promise<void> => {
  const scriptId = await resolveDevScript();
  if (!scriptId) {
    console.log(
      "\nNo built document found under src/generated with a lego/ directory.\n" +
        "The editor flows need one to drive. Build a deck, or set QA_DEV_SCRIPT_ID.\n",
    );
    process.exitCode = 1;
    return;
  }
  process.env.QA_DEV_SCRIPT_ID = scriptId;

  // Pristine fixture in, pristine fixture out.
  await snapshotScript(scriptId);
  await snapshotFixture(scriptId);
  const restored = await restoreFixture(scriptId);

  console.log(`\n▶ QA — tier "${TIER}", ${CONCURRENCY} in parallel`);
  console.log(`  target:   ${BASE}`);
  console.log(`  document: ${scriptId}${restored ? " (reset to snapshot)" : ""}`);
  if (TIER === "free") console.log("  (free tier: no model calls, nothing billed)");
  console.log("");

  const summary = await runFlows({
    base: BASE,
    tier: TIER,
    flows: [...editorFlows, ...documentFlows],
    concurrency: CONCURRENCY,
    headless: process.env.QA_HEADED !== "1",
    artifactDir: ARTIFACTS,
    // Every mutating flow starts from the same document.
    resetFixture: () => restoreFixture(scriptId).then(() => undefined),
  });

  // Hand the fixture back the way it was found, whatever happened above.
  await restoreFixture(scriptId);

  console.log(
    `\n  ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped ` +
      `· ${(summary.ms / 1000).toFixed(1)}s`,
  );
  if (summary.failed > 0) {
    console.log("\n  failures:");
    for (const r of summary.results.filter((x) => x.status === "failed")) {
      console.log(`    ✗ ${r.name}\n        ${r.reason}`);
    }
    process.exitCode = 1;
  }
};

await main();
