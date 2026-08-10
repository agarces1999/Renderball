// Deterministic TUNE / HOLDOUT split, then seal the holdout.
//
// The bucket is sha256(hostname) mod 3 — 0,1 -> TUNE, 2 -> HOLDOUT. Nothing
// about the row feeds the hash but the hostname, so the split cannot be nudged
// by editing a truth value, and anyone can recompute it from the host alone.
//
// The holdout is written base64. That is not encryption and is not pretending
// to be: it stops a fixer eyeballing the answers while iterating, which is the
// realistic failure mode. A determined reader can decode it in one command,
// and should, when auditing.
//
// Usage: node split.mjs
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);

export const bucketOf = (host) => {
  const h = createHash("sha256").update(host).digest();
  return h.readUInt32BE(0) % 3;
};
export const halfOf = (host) => (bucketOf(host) === 2 ? "holdout" : "tune");

const main = () => {
const src = JSON.parse(readFileSync(join(HERE, "_sealed", "truth-source.json"), "utf8"));
const rows = src.rows.map((r) => ({ ...r, half: halfOf(r.host) }));

const scored = rows.filter((r) => r.status === "scored");
const excluded = rows.filter((r) => r.status !== "scored");
const tune = scored.filter((r) => r.half === "tune");
const holdout = scored.filter((r) => r.half === "holdout");

const meta = {
  generated: new Date().toISOString(),
  method: src._method,
  fields: src._fields,
  bands: { EXACT: "< 30", NEAR: "< 90", WRONG: ">= 90", metric: "euclidean distance in sRGB" },
};

mkdirSync(join(HERE, "_sealed"), { recursive: true });
writeFileSync(
  join(HERE, "truth-tune.json"),
  JSON.stringify({ ...meta, half: "tune", count: tune.length, rows: tune }, null, 2),
);
writeFileSync(
  join(HERE, "_sealed", "truth-holdout.b64"),
  Buffer.from(
    JSON.stringify({ ...meta, half: "holdout", count: holdout.length, rows: holdout }, null, 2),
  ).toString("base64"),
);
writeFileSync(
  join(HERE, "truth-excluded.json"),
  JSON.stringify(
    { note: "Not scored. Kept visible so the exclusions are auditable.", rows: excluded },
    null,
    2,
  ),
);

const tally = (list) => {
  const t = { n: list.length, achromatic: 0, builder: 0, high: 0 };
  for (const r of list) {
    if (r.achromatic) t.achromatic++;
    if (r.builder) t.builder++;
    if (r.confidence === "high") t.high++;
  }
  return t;
};
console.log("scored:", scored.length, "excluded:", excluded.length);
console.log("TUNE   ", JSON.stringify(tally(tune)));
console.log("HOLDOUT", JSON.stringify(tally(holdout)));
console.log(
  "\nholdout hosts are sealed in _sealed/truth-holdout.b64 (base64 -d to audit)\n" +
    "tune hosts:\n  " +
    tune.map((r) => r.host).join(" "),
);
};

// Importable for its hash helpers without rewriting any file.
if (process.argv[1] && process.argv[1].endsWith("split.mjs")) main();
