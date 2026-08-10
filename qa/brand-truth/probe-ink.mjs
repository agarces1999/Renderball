// Does "one hue owns the chromatic ink" separate the achromatic brands from the
// chromatic ones? Prints the two distributions sorted, so a gap (or the absence
// of one) is visible rather than argued.
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
      try {
        e = await p.readSiteBrand(row.host);
      } catch {}
      out.push({ row, ink: e?.chromatic_ink ?? null, declared: e?.declared_achromatic === true });
      process.stderr.write(".");
    }
  }),
);
process.stderr.write("\n");

const fmt = (r) =>
  `${r.row.host.padEnd(24)} ${r.row.half.padEnd(8)} share ${(r.ink?.share ?? 0).toFixed(3)}` +
  `  leaderCount ${String(r.ink?.leaderCount ?? 0).padStart(5)}  totalInk ${String(r.ink?.total ?? 0).padStart(6)}` +
  `  leader ${String(r.ink?.leader ?? "-").padEnd(8)}  declared-grey ${r.declared ? "yes" : "no "}`;

const ach = out.filter((r) => r.row.achromatic).sort((a, b) => (b.ink?.share ?? 0) - (a.ink?.share ?? 0));
const col = out.filter((r) => !r.row.achromatic).sort((a, b) => (a.ink?.share ?? 0) - (b.ink?.share ?? 0));

console.log("ACHROMATIC BRANDS (want: no accent) — highest share first\n");
ach.forEach((r) => console.log("  " + fmt(r)));
console.log("\nCOLOUR BRANDS (want: an accent) — lowest share first\n");
col.forEach((r) => console.log("  " + fmt(r)));

// Where would a threshold have to sit, and what does it cost?
console.log("\nthreshold sweep (fire 'no accent' when share < t):");
console.log("   t      achromatic caught      colour brands broken");
for (const t of [0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.6, 0.7]) {
  const caught = ach.filter((r) => (r.ink?.share ?? 0) < t).length;
  const broken = col.filter((r) => (r.ink?.share ?? 0) < t).length;
  console.log(
    `  ${t.toFixed(2)}   ${String(caught).padStart(2)}/${ach.length}                  ${String(broken).padStart(2)}/${col.length}` +
      (broken ? `   (${col.filter((r) => (r.ink?.share ?? 0) < t).map((r) => r.row.host).join(", ")})` : ""),
  );
}
