//
// Put the QA fixture document on disk and in the database.
//
// WHY THIS EXISTS. `src/generated/` and `.data/` are both gitignored, so a
// fresh checkout — CI, a new machine, a worktree — has no documents at all. The
// QA suite drives a built deck and the invariant sweep reads built decks, so on
// a clean checkout the suite has nothing to drive and the sweep scans zero
// directories and passes. A gate that passes because it found nothing to check
// is worse than no gate: it reports green and means nothing.
//
// So one small deck lives in the repo (qa/fixtures/deck, ~350KB): the render
// source, its lego store, its script and warnings, plus the Project and
// ScriptDoc rows it needs to be loadable. Deliberately NOT included are
// .render-truth (4MB of measurement PNGs, regenerated on demand) and lego/.undo
// (an edit history no fixture needs).
//
//   node scripts/qa-fixture.mjs            # restore files + database rows
//   node scripts/qa-fixture.mjs --check    # report what is missing, change nothing
//
// Idempotent: safe to run before every QA run, and safe to run on a machine
// that already has the document (it overwrites the files back to their pristine
// state, which is exactly what a fixture should do between runs).
//
import { promises as fs } from "fs";
import path from "path";
import { existsSync, readFileSync } from "fs";

const ROOT = process.cwd();
const FIXTURE = path.join(ROOT, "qa", "fixtures", "deck");
const CHECK = process.argv.includes("--check");

// Load .env.local the same way the QA runner does — this script needs
// DATABASE_URL and nothing else sets it outside `next dev`.
const envFile = path.join(ROOT, ".env.local");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    if (process.env[m[1]] !== undefined) continue; // a real env var always wins
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const scriptId = (await fs.readFile(path.join(FIXTURE, ".script-id"), "utf8")).trim();
const genDir = path.join(ROOT, "src", "generated", scriptId);

/** Copy the fixture tree, skipping the dot-files that describe it. */
const restoreFiles = async () => {
  let copied = 0;
  const walk = async (rel) => {
    for (const e of await fs.readdir(path.join(FIXTURE, rel), { withFileTypes: true })) {
      if (rel === "." && e.name.startsWith(".")) continue; // .script-id, .rows.json
      const r = path.join(rel, e.name);
      if (e.isDirectory()) {
        await fs.mkdir(path.join(genDir, r), { recursive: true });
        await walk(r);
      } else {
        await fs.copyFile(path.join(FIXTURE, r), path.join(genDir, r));
        copied++;
      }
    }
  };
  await fs.mkdir(genDir, { recursive: true });
  await walk(".");
  return copied;
};

const restoreRows = async () => {
  const { project, scriptDoc } = JSON.parse(
    await fs.readFile(path.join(FIXTURE, ".rows.json"), "utf8"),
  );
  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient();
  try {
    // Dates round-trip through JSON as strings; Prisma needs Date objects.
    const dates = (o) =>
      Object.fromEntries(
        Object.entries(o).map(([k, v]) =>
          /At$/.test(k) && typeof v === "string" ? [k, new Date(v)] : [k, v],
        ),
      );
    const doc = dates(scriptDoc);
    const proj = dates(project);
    await db.scriptDoc.upsert({ where: { id: doc.id }, update: doc, create: doc });
    await db.project.upsert({ where: { id: proj.id }, update: proj, create: proj });
  } finally {
    await db.$disconnect();
  }
};

if (CHECK) {
  const onDisk = existsSync(path.join(genDir, "Composition.tsx"));
  const hasStore = existsSync(path.join(genDir, "lego", "manifest.json"));
  console.log(`fixture ${scriptId}`);
  console.log(`  files on disk: ${onDisk ? "yes" : "NO"}`);
  console.log(`  lego store:    ${hasStore ? "yes" : "NO"}`);
  process.exit(onDisk && hasStore ? 0 : 1);
}

const copied = await restoreFiles();
console.log(`fixture ${scriptId}: ${copied} file(s) restored to src/generated/`);
try {
  await restoreRows();
  console.log(`fixture ${scriptId}: Project + ScriptDoc rows upserted`);
} catch (err) {
  // A missing database is fatal for the QA suite but NOT for the invariant
  // sweep, which only reads files. Say which half succeeded rather than
  // failing both.
  console.error(
    `fixture ${scriptId}: database rows NOT restored (${err instanceof Error ? err.message.split("\n")[0] : err})`,
  );
  console.error("  the invariant sweep will work; the QA suite will not be able to open the document");
  process.exit(1);
}

// The suite pins its subject to this file; point it at the fixture so a fresh
// checkout does not go hunting for "the newest document on disk" and find none.
const pinFile = path.join(ROOT, ".data", "qa-fixtures", "PINNED");
await fs.mkdir(path.dirname(pinFile), { recursive: true });
await fs.writeFile(pinFile, scriptId, "utf8");
console.log(`fixture ${scriptId}: pinned as the QA subject`);
