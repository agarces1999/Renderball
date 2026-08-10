// Route 2's predicate: "we have no strong claim on this colour, so ASK rather
// than assert." Strong claim = a chromatic --brand/--primary/--accent token,
// or a chromatic fill in the brand's own logo mark. Everything else is a guess
// off frequency, and this measures how well that separates.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { loadPicker } from "./harness.mjs";

const HERE = dirname(new URL(import.meta.url).pathname);
const rows = [
  ...JSON.parse(readFileSync(join(HERE, "truth-tune.json"), "utf8")).rows,
  ...JSON.parse(
    Buffer.from(readFileSync(join(HERE, "_sealed", "truth-holdout.b64"), "utf8"), "base64").toString("utf8"),
  ).rows,
];
const p = await loadPicker();
const out = [];
let i = 0;
await Promise.all(
  Array.from({ length: 6 }, async () => {
    while (i < rows.length) {
      const row = rows[i++];
      let e = null;
      try { e = await p.readSiteBrand(row.host); } catch {}
      const namedChromatic = e?.declared_tokens?.chromatic ?? 0;
      const logo = e?.logo_color ?? null;
      out.push({ row, namedChromatic, logo, unconfirmed: namedChromatic === 0 && !logo });
      process.stderr.write(".");
    }
  }),
);
process.stderr.write("\n");

const flagged = out.filter((r) => r.unconfirmed);
const ach = out.filter((r) => r.row.achromatic);
console.log(`flagged UNCONFIRMED: ${flagged.length}/${out.length} sites\n`);
console.log("  achromatic brands flagged (the ones we get wrong today):");
for (const r of ach) console.log(`    ${r.row.host.padEnd(24)} ${r.unconfirmed ? "FLAGGED" : "missed  "} namedChromatic=${r.namedChromatic} logo=${r.logo ?? "-"}`);
console.log("\n  colour brands flagged (a confirmation prompt they don't need):");
for (const r of flagged.filter((x) => !x.row.achromatic))
  console.log(`    ${r.row.host.padEnd(24)} truth ${r.row.accent}`);
const caught = ach.filter((r) => r.unconfirmed).length;
const noise = flagged.length - caught;
console.log(
  `\n  ${caught}/${ach.length} achromatic caught,  ${noise} colour brands also asked,` +
    `  precision ${(caught / Math.max(1, flagged.length) * 100).toFixed(0)}%`,
);
