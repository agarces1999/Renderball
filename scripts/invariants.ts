//
// INVARIANT SWEEP over the documents that actually shipped.
//
// Why this exists (2026-08-21). The suite had 1904 green tests and could not
// see a bug that broke six editor features at once: move, delete, upload-image,
// add-page, apply-brand and change-logo all failed on the same deck. Every
// store test decomposes its fixture in-process, so the store always matches the
// composition — the failure only exists in documents that have been through a
// real build, a real R2 snapshot and a real rehydrate. The unit tests were
// asking about a program; this asks about the artifacts.
//
// The probe that found it took two minutes to write and read 187 directories.
// That asymmetry is the whole argument for this file: the cheapest place to
// notice a shipped-artifact defect is a sweep over shipped artifacts.
//
// Checks, cheapest first:
//   store-parity     the lego store describes the same number of scenes as the script
//   store-roundtrip  the store reassembles to Composition.tsx byte-for-byte
//   piece-parity     every manifest piece id appears in the composition
//   renders          every scene SSRs without throwing        (--deep)
//
// Usage:
//   npx tsx scripts/invariants.ts             # fast checks, every document
//   npx tsx scripts/invariants.ts --deep      # + SSR every scene (slow)
//   npx tsx scripts/invariants.ts --id <ULID> # one document
//   npx tsx scripts/invariants.ts --json      # machine-readable, for CI
//
// Exit code is 1 when any document fails, so CI and a post-deploy hook can both
// gate on it.
//
import { promises as fs } from "fs";
import path from "path";
import { decompose, reassemble } from "../lib/agents/lego-decompose";
import { verifyScenesRender } from "../lib/render/ssr-render";

interface Failure {
  check: string;
  detail: string;
}
interface DocResult {
  id: string;
  skipped?: string;
  failures: Failure[];
}

const GEN_ROOT = path.join(process.cwd(), "src", "generated");

const readJson = async (p: string): Promise<Record<string, unknown> | null> => {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return null;
  }
};

const sweepOne = async (id: string, deep: boolean): Promise<DocResult> => {
  const dir = path.join(GEN_ROOT, id);
  const failures: Failure[] = [];

  const script = (await readJson(path.join(dir, "script.json"))) as {
    scenes?: unknown[];
  } | null;
  if (!script?.scenes) return { id, skipped: "no script.json", failures };
  const sceneCount = script.scenes.length;

  let code: string;
  try {
    code = await fs.readFile(path.join(dir, "Composition.tsx"), "utf8");
  } catch {
    return { id, skipped: "no Composition.tsx", failures };
  }

  const manifest = (await readJson(path.join(dir, "lego", "manifest.json"))) as {
    scenes?: { sceneIndex: number; pieces: { id: string }[] }[];
  } | null;

  // A document with no store predates the lego engine (video era). Not a defect.
  if (!manifest?.scenes) return { id, skipped: "no lego store", failures };

  // ── store-parity ────────────────────────────────────────────────────────────
  // The failure that started this file. A store describing a different number of
  // scenes than the document is not this document's store, and every edit op
  // reads it: page-ops refuses outright, move/delete/insert find no piece, and
  // re-skin reports it would stop the later pages rendering.
  if (manifest.scenes.length !== sceneCount) {
    const ids = manifest.scenes.flatMap((s) => s.pieces.map((p) => p.id)).slice(0, 4);
    failures.push({
      check: "store-parity",
      detail:
        `store describes ${manifest.scenes.length} scene(s), script has ${sceneCount}` +
        (ids.length ? ` — store pieces: ${ids.join(", ")}` : ""),
    });
  }

  // ── store-roundtrip ─────────────────────────────────────────────────────────
  // The store's contract is that it IS a decomposition of what renders. If the
  // composition does not decompose back to itself, an edit that reassembles from
  // the store writes a file that differs from the one the user approved.
  const fresh = decompose(code);
  if (reassemble(fresh) !== code) {
    failures.push({
      check: "store-roundtrip",
      detail: "Composition.tsx does not decompose→reassemble byte-identically",
    });
  }

  // ── piece-parity ────────────────────────────────────────────────────────────
  // Every id the manifest offers the editor has to exist in the render source;
  // otherwise selecting that element in the panel addresses nothing.
  const missing = manifest.scenes
    .flatMap((s) => s.pieces.map((p) => p.id))
    .filter((pid) => !code.includes(`id="${pid}"`));
  if (missing.length > 0) {
    failures.push({
      check: "piece-parity",
      detail: `${missing.length} manifest piece id(s) absent from the composition: ${missing.slice(0, 5).join(", ")}`,
    });
  }

  // ── renders (deep) ──────────────────────────────────────────────────────────
  // The check that found 14 of 106 decks with a scene that will not render —
  // a deck that opens as an error message and shares as one.
  if (deep) {
    try {
      const check = await verifyScenesRender(dir, sceneCount, script);
      for (const e of check.errors) {
        failures.push({ check: "renders", detail: `page ${e.scene + 1}: ${e.error}` });
      }
    } catch (err) {
      failures.push({
        check: "renders",
        detail: `could not SSR: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
      });
    }
  }

  return { id, failures };
};

const main = async () => {
  const argv = process.argv.slice(2);
  const deep = argv.includes("--deep");
  const asJson = argv.includes("--json");
  const only = argv[argv.indexOf("--id") + 1];
  const ids =
    argv.includes("--id") && only
      ? [only]
      : (await fs.readdir(GEN_ROOT, { withFileTypes: true }))
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .sort();

  const results: DocResult[] = [];
  for (const id of ids) results.push(await sweepOne(id, deep));

  const checked = results.filter((r) => !r.skipped);
  const bad = checked.filter((r) => r.failures.length > 0);

  if (asJson) {
    console.log(JSON.stringify({ deep, checked: checked.length, failing: bad.length, results: bad }, null, 2));
  } else {
    console.log(
      `\ninvariant sweep — ${checked.length} document(s) checked` +
        `, ${results.length - checked.length} skipped (pre-lego or unbuilt)` +
        `${deep ? ", SSR included" : ", fast checks only (--deep adds SSR)"}\n`,
    );
    // Per-check tallies first: one line that says whether a whole class is broken.
    const byCheck = new Map<string, number>();
    for (const r of bad) for (const f of r.failures) byCheck.set(f.check, (byCheck.get(f.check) ?? 0) + 1);
    for (const [check, n] of [...byCheck].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(4)}  ${check}`);
    }
    if (bad.length) console.log("");
    for (const r of bad) {
      console.log(`  ✗ ${r.id}`);
      for (const f of r.failures) console.log(`      [${f.check}] ${f.detail}`);
    }
    console.log(
      bad.length === 0
        ? `  ✓ every checked document holds\n`
        : `\n  ${bad.length} of ${checked.length} document(s) failing\n`,
    );
  }
  process.exit(bad.length > 0 ? 1 : 0);
};

void main();
