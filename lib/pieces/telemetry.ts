/**
 * Variant-distribution telemetry — the anti-sameness instrument the founder
 * asked for ("how do you avoid all our graphs looking the same?"). Counts
 * every compiled variant per class in .data/piece-variants.json; when one
 * variant's share of a class exceeds DOMINANCE_WARN across a meaningful
 * sample, the console line is the signal to nudge the fill prompt's variant
 * guidance (a prompt fix, not a code fix). Best-effort: telemetry must
 * never break a build.
 */
import fs from "node:fs";
import path from "node:path";

const FILE = path.join(process.cwd(), ".data", "piece-variants.json");
const DOMINANCE_WARN = 0.4;
const MIN_SAMPLE = 12;

type Tally = Record<string, Record<string, number>>;

const load = (): Tally => {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8")) as Tally;
  } catch {
    return {};
  }
};

export const recordVariantUse = (
  piece: string,
  variant: string,
  scriptId?: string,
): void => {
  if (process.env.RB_PIECE_TELEMETRY === "off") return;
  try {
    const t = load();
    t[piece] = t[piece] ?? {};
    t[piece][variant] = (t[piece][variant] ?? 0) + 1;
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(t, null, 2));
    const total = Object.values(t[piece]).reduce((a, b) => a + b, 0);
    const share = t[piece][variant] / total;
    if (total >= MIN_SAMPLE && share > DOMINANCE_WARN) {
      console.warn(
        `[piece-variants] ${piece}:${variant} at ${(share * 100).toFixed(0)}% of ${total} uses${
          scriptId ? ` (latest: ${scriptId})` : ""
        } — dominance above ${DOMINANCE_WARN * 100}%, nudge variant guidance in the fill prompt`,
      );
    }
  } catch {
    /* telemetry is best-effort */
  }
};

export const variantDistribution = (): Tally => load();
