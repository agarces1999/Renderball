// WHICH STAGE produced the colour? pickSignatureColor (ranked palette / theme),
// the logo fallback, or the last-resort rescue? A suppression aimed at the
// wrong stage changes nothing, so this reads the stage off the real functions
// rather than guessing from the value.
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
const want = new Set(process.argv.slice(2));
const sel = want.size ? rows.filter((r) => want.has(r.host)) : rows.filter((r) => r.achromatic);

const p = await loadPicker();
for (const row of sel) {
  const e = await p.readSiteBrand(row.host);
  const ranked = p.pickSignatureColor(e.palette ?? [], e.theme_color, e.named);
  const full = p.signatureWithLogoFallback(e.palette ?? [], e.theme_color, e.logo_color, e.named);
  const stage = ranked ? "ranked/theme" : full ? (full === e.logo_color?.toLowerCase() ? "logo" : "rescue") : "none";
  console.log(
    [
      row.host.padEnd(24),
      row.achromatic ? "ACHROMATIC" : `truth ${row.accent}`,
      `-> ${String(full ?? "(none)").padEnd(9)}`,
      `stage=${stage.padEnd(13)}`,
      `declared-grey=${String(e.declared_achromatic === true).padEnd(5)}`,
      `theme=${String(e.theme_color ?? "-").padEnd(9)}`,
      `logo=${String(e.logo_color ?? "-").padEnd(9)}`,
      `palette=${JSON.stringify((e.palette ?? []).slice(0, 5))}`,
    ].join(" "),
  );
}
