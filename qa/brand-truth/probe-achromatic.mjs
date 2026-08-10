// Does "the site DECLARED greyscale" separate the achromatic brands from the
// chromatic ones? Prints the signal against truth for every scored row so the
// answer is a table, not a hunch.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { loadPicker, stats } from "./harness.mjs";

const HERE = dirname(new URL(import.meta.url).pathname);
const rows = [
  ...JSON.parse(readFileSync(join(HERE, "truth-tune.json"), "utf8")).rows,
  ...JSON.parse(
    Buffer.from(readFileSync(join(HERE, "_sealed", "truth-holdout.b64"), "utf8"), "base64").toString("utf8"),
  ).rows,
];

const picker = await loadPicker();
const out = [];
let i = 0;
await Promise.all(
  Array.from({ length: 6 }, async () => {
    while (i < rows.length) {
      const row = rows[i++];
      let e = null;
      try {
        e = await picker.readSiteBrand(row.host);
      } catch {}
      const id = e ? picker.resolveBrandIdentity(e) : null;
      out.push({
        host: row.host,
        half: row.half,
        achromatic: !!row.achromatic,
        declared: e?.declared_achromatic === true,
        namedCount: (e?.palette ?? []).length,
        sig: id?.signature ?? null,
        theme: e?.theme_color ?? null,
      });
      process.stderr.write(".");
    }
  }),
);
process.stderr.write("\n");
out.sort((a, b) => Number(b.achromatic) - Number(a.achromatic) || a.host.localeCompare(b.host));

let tp = 0, fp = 0, fn = 0, tn = 0;
for (const r of out) {
  if (r.achromatic && r.declared) tp++;
  else if (!r.achromatic && r.declared) fp++;
  else if (r.achromatic && !r.declared) fn++;
  else tn++;
  console.log(
    [
      r.host.padEnd(24),
      r.half.padEnd(8),
      `truth ${(r.achromatic ? "ACHROMATIC" : "colour").padEnd(11)}`,
      `declared-grey ${String(r.declared).padEnd(6)}`,
      `sig ${String(r.sig ?? "(none)").padEnd(9)}`,
      `theme ${String(r.theme ?? "-").padEnd(9)}`,
      r.achromatic && !r.declared ? "  <- MISSED" : "",
      !r.achromatic && r.declared ? "  <- FALSE POSITIVE" : "",
    ].join(" "),
  );
}
console.log(
  `\ndeclared-greyscale signal:  caught ${tp}/${tp + fn} achromatic brands,` +
    ` ${fp} false positives out of ${fp + tn} chromatic brands`,
);
console.log(`network: ${stats.hits} cached, ${stats.misses} fetched, ${stats.errors} errors`);
