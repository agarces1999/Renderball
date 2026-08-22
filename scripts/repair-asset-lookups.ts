//
// Sweep every stored deck for the string-predicate asset lookup and repair it.
// See lib/edit/asset-lookup-repair.ts for what the defect is and why the <Img> shim
// fix alone is not sufficient (it stops the broken image; this picks the right one).
//
//   npx tsx scripts/repair-asset-lookups.ts --check   # report only
//   npx tsx scripts/repair-asset-lookups.ts           # apply + reassemble
//
import { promises as fs } from "fs";
import path from "path";
import { repairDeckAssetLookups } from "../lib/edit/asset-lookup-repair";

const ROOT = path.join(process.cwd(), "src", "generated");
const CHECK = process.argv.includes("--check");

const main = async (): Promise<void> => {
  let scanned = 0, decksRepaired = 0, total = 0;
  for (const id of await fs.readdir(ROOT)) {
    if (!(await fs.stat(path.join(ROOT, id)).catch(() => null))?.isDirectory()) continue;
    if (!(await fs.stat(path.join(ROOT, id, "lego", "manifest.json")).catch(() => null))) continue;
    scanned++;
    let repairs;
    try {
      repairs = await repairDeckAssetLookups(path.join(ROOT, id), { dryRun: CHECK });
    } catch (err) {
      console.log(`  ! ${id}: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    if (!repairs.length) continue;
    decksRepaired++;
    total += repairs.length;
    console.log(`  ${CHECK ? "would repair" : "repaired"} ${id}`);
    for (const r of repairs) console.log(`      ${r.assetId}: ${r.before.slice(0, 76)}…`);
  }
  console.log(`\ndecks with a store: ${scanned}`);
  console.log(`decks ${CHECK ? "needing" : "given"} repair: ${decksRepaired}  (${total} lookup(s))`);
};

void main();
