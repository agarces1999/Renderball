//
// QA entry point. See scripts/run-qa.mjs for invocation.
//
import { promises as fs } from "fs";
import path from "path";
import { runFlows, type Tier } from "./harness";
import { loadScript, saveScript, DEV_OWNER_ID } from "../lib/store";
import { editorFlows } from "./flows/editor";
import { documentFlows } from "./flows/document";
import { securityFlows } from "./flows/security";
import { shareFlows } from "./flows/share";
import { accountFlows } from "./flows/account";
import { journeyFlows } from "./flows/journeys";
import { authenticator, testCredentials } from "./auth";

const BASE = process.env.QA_BASE ?? "http://localhost:3000";
const TIER = (process.env.QA_TIER ?? "free") as Tier;
const CONCURRENCY = Number(process.env.QA_CONCURRENCY ?? 3);
const ARTIFACTS = process.env.QA_ARTIFACTS ?? path.join(process.cwd(), ".data", "qa");

/**
 * Pick a deck the dev harness can open — and then keep picking the same one.
 *
 * /dev/edit loads scripts owned by DEV_OWNER_ID, so the suite needs one that
 * exists locally. Explicit QA_DEV_SCRIPT_ID wins; otherwise the newest built
 * document on disk is used, which is almost always what a developer wants.
 *
 * The choice is PINNED to a file after the first run. Resolving it fresh every
 * time meant the suite could silently change subject: when a damaged fixture
 * lost its manifest, the next run picked a different deck, snapshotted it in
 * whatever state it happened to be in, and blamed the product for the
 * differences. A suite that quietly changes what it is testing is worse than
 * one that fails.
 */
const PIN_FILE = path.join(process.cwd(), ".data", "qa-fixtures", "PINNED");

const resolveDevScript = async (): Promise<string> => {
  if (process.env.QA_DEV_SCRIPT_ID) return process.env.QA_DEV_SCRIPT_ID;

  const hasManifest = async (id: string): Promise<boolean> =>
    fs
      .stat(path.join(process.cwd(), "src", "generated", id, "lego", "manifest.json"))
      .then(() => true)
      .catch(() => false);

  const pinned = (await fs.readFile(PIN_FILE, "utf8").catch(() => "")).trim();
  // A pin survives only while the document does, or while its snapshot can put
  // it back — otherwise it would strand the suite on a deck that is gone.
  if (pinned && ((await hasManifest(pinned)) || (await fs.stat(backupOf(pinned)).then(() => true).catch(() => false)))) {
    return pinned;
  }

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
  const chosen = usable[0]?.id ?? "";
  if (chosen) {
    await fs.mkdir(path.dirname(PIN_FILE), { recursive: true });
    await fs.writeFile(PIN_FILE, chosen, "utf8").catch(() => {});
  }
  return chosen;
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

/**
 * The snapshot's OWN script.json is the source of truth, not the database.
 *
 * Reading the row instead was tried and silently returned nothing, so the guard
 * below never fired: the files were reset to 5 pages every run while the
 * database kept climbing to 7, and page-op refused every request with
 * "store/script scene mismatch". Taking the script from the same snapshot the
 * files come from makes the two halves consistent by construction.
 */
const snapshotScript = async (id: string): Promise<void> => {
  if (scriptSnapshot) return;
  const fromSnapshot = await fs
    .readFile(path.join(backupOf(id), "script.json"), "utf8")
    .then((t) => JSON.parse(t) as unknown)
    .catch(() => null);
  scriptSnapshot = fromSnapshot ?? (await loadScript(id, DEV_OWNER_ID).catch(() => null));
};

/**
 * Delete a directory the server may still be writing into.
 *
 * A flow's last edit can still be landing when the next reset starts, and a
 * recursive rm that races a write fails with ENOTEMPTY — which took down a whole
 * run after 26 green flows. Retrying is enough: the writer finishes in
 * milliseconds, and the alternative (waiting on the server to be idle) is a
 * synchronisation problem the harness does not need to solve.
 */
const rmDirWithRetry = async (dir: string, attempts = 5): Promise<void> => {
  for (let i = 0; i < attempts; i++) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      if (i === attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, 150 * (i + 1)));
    }
  }
};

/**
 * Restore the document, without a window in which it does not exist.
 *
 * The obvious implementation — delete, then copy back — has a failure mode that
 * cost a whole run and then some: the delete raced a write, threw ENOTEMPTY, and
 * left `src/generated/<id>` half-gone. With no manifest there, the NEXT run's
 * resolveDevScript quietly picked a different deck, snapshotted that one in its
 * already-edited state, and reported three flows broken that were not. Copying
 * beside and renaming into place means the fixture is either the old one or the
 * new one at every instant, and a crash costs a temp directory.
 */
const restoreFixture = async (id: string): Promise<boolean> => {
  const src = backupOf(id);
  const ok = await fs.stat(src).then(() => true).catch(() => false);
  if (!ok) return false;
  const staging = `${genDirOf(id)}.restoring`;
  const retired = `${genDirOf(id)}.old`;
  await rmDirWithRetry(staging);
  await rmDirWithRetry(retired);
  await fs.cp(src, staging, { recursive: true });
  const live = await fs.stat(genDirOf(id)).then(() => true).catch(() => false);
  if (live) await fs.rename(genDirOf(id), retired);
  await fs.rename(staging, genDirOf(id));
  await rmDirWithRetry(retired).catch(() => {});
  if (scriptSnapshot) {
    await saveScript(scriptSnapshot as Parameters<typeof saveScript>[0], DEV_OWNER_ID).catch((e) => {
      // Loud: a silent failure here is what let the document and its row drift
      // apart in the first place.
      console.log(`  ! could not restore the script row: ${e instanceof Error ? e.message : e}`);
    });
  }
  return true;
};

/**
 * Compile every page the suite drives, one at a time, before any flow starts.
 *
 * `next dev` compiles routes on first request, and compiling several at once
 * under parallel load intermittently throws from inside React itself —
 * "Cannot read properties of null (reading 'useContext')" out of
 * next-server/app-page, with none of our own code in the stack. The flow that
 * happened to trigger it reported a 500 and looked like a product bug; it moved
 * between flows run to run and never reproduced twice in the same place.
 *
 * Production serves pre-built routes and cannot hit this, so warming is the
 * honest fix rather than a retry: scripts/dev.mjs already does the same thing
 * for the heavy API routes at startup.
 *
 * Best-effort throughout — a warm-up that fails must never stop the suite.
 */
const warmRoutes = async (base: string, scriptId: string): Promise<number> => {
  const routes = [
    "/",
    "/sign-in",
    "/documents",
    "/account",
    "/billing",
    "/api/health",
    "/api/usage",
    `/dev/edit/${scriptId}`,
    `/dev/preview/${scriptId}`,
    "/s/warmup-not-a-real-token-0000000000000",
  ];
  let compiled = 0;
  for (const route of routes) {
    try {
      // The status is irrelevant — a 404 or a redirect to sign-in compiles the
      // route just as well as a 200 does.
      await fetch(`${base}${route}`, { signal: AbortSignal.timeout(120_000) });
      compiled++;
    } catch {
      /* a route that will not warm still gets its chance in the flow itself */
    }
  }
  return compiled;
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
  await snapshotFixture(scriptId);
  await snapshotScript(scriptId);
  const restored = await restoreFixture(scriptId);

  const creds = testCredentials();

  console.log(`\n▶ QA — tier "${TIER}", ${CONCURRENCY} in parallel`);
  console.log(`  target:   ${BASE}`);
  console.log(`  document: ${scriptId}${restored ? " (reset to snapshot)" : ""}`);
  console.log(
    `  account:  ${creds ? creds.email : "none — signed-in flows will skip (set QA_TEST_EMAIL / QA_TEST_PASSWORD)"}`,
  );
  if (TIER === "free") console.log("  (free tier: no model calls, nothing billed)");

  const warmed = await warmRoutes(BASE, scriptId);
  console.log(`  warmed:   ${warmed} routes compiled before the first flow`);
  console.log("");

  // QA_ONLY=<substring> reruns just the flows whose names match — so verifying
  // one failure costs one flow (and, for a journey, one generation) instead of
  // the whole suite. Case-insensitive; comma-separates multiple substrings.
  const all = [...editorFlows, ...documentFlows, ...securityFlows, ...shareFlows, ...accountFlows, ...journeyFlows];
  const only = (process.env.QA_ONLY ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const flows = only.length
    ? all.filter((f) => only.some((s) => f.name.toLowerCase().includes(s)))
    : all;
  if (only.length) console.log(`  QA_ONLY: ${flows.length} of ${all.length} flows match [${only.join(", ")}]\n`);

  const summary = await runFlows({
    base: BASE,
    tier: TIER,
    flows,
    concurrency: CONCURRENCY,
    headless: process.env.QA_HEADED !== "1",
    artifactDir: ARTIFACTS,
    // Every mutating flow starts from the same document.
    resetFixture: () => restoreFixture(scriptId).then(() => undefined),
    // Null when no test account is configured, which makes the harness skip
    // every needsAuth flow with a reason instead of failing them.
    ...(authenticator(BASE) ? { authenticate: authenticator(BASE)! } : {}),
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
