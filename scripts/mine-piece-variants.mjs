/**
 * Mine the stored-deck corpus for the morphologies freeform generation
 * ACTUALLY produced per standard piece class — the variant sets for the
 * piece-spec are observed, not invented (founder requirement: variety must
 * survive standardization).
 *   node scripts/mine-piece-variants.mjs
 */
import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";

const GEN = "src/generated";
const decks = readdirSync(GEN).filter((d) => existsSync(join(GEN, d, "Composition.tsx")));

// Feature extractors over a piece's TSX source — cheap, honest signals.
const features = (src) => ({
  bordered: /border(?:Top|Bottom|Left|Right)?:\s*["'`]/.test(src),
  ruled: /border(Top|Bottom):/.test(src),
  boxed: /backgroundColor|background:/.test(src) && /borderRadius/.test(src),
  bigNumber: /fontSize:\s*(?:[5-9]\d|1\d\d)/.test(src),
  mono: /FONT_MONO|monospace/.test(src),
  horizontal: /flexDirection:\s*["']row/.test(src),
  iconled: /<svg|Icon\b/.test(src),
  underlineAccent: /borderBottom:\s*["'`][^"'`]*(?:accent|ACCENT|PALETTE)/.test(src),
});
const sig = (f) => Object.entries(f).filter(([, v]) => v).map(([k]) => k).sort().join("+") || "plain";

const CLASSES = [
  ["statTile", /stat|kpi|metric|number/i],
  ["quoteCard", /quote|testimonial/i],
  ["bulletStack", /bullet|list|points/i],
];

const tally = {}; // class → signature → { n, exemplar }
let piecesScanned = 0;
for (const d of decks) {
  const dir = join(GEN, d, "lego", "pieces");
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".tsx"))) {
    const src = readFileSync(join(dir, f), "utf8");
    const cls = CLASSES.find(([, rx]) => rx.test(f) || rx.test(src.slice(0, 400)))?.[0];
    if (!cls) continue;
    piecesScanned += 1;
    const s = sig(features(src));
    tally[cls] ??= {};
    tally[cls][s] ??= { n: 0, exemplar: `${d}/lego/pieces/${f}` };
    tally[cls][s].n += 1;
  }
}

console.log(`decks: ${decks.length} · classified pieces: ${piecesScanned}\n`);
for (const [cls, sigs] of Object.entries(tally)) {
  const total = Object.values(sigs).reduce((a, b) => a + b.n, 0);
  console.log(`── ${cls} (${total} pieces, ${Object.keys(sigs).length} distinct morphologies)`);
  const sorted = Object.entries(sigs).sort((a, b) => b[1].n - a[1].n);
  for (const [s, v] of sorted.slice(0, 8)) {
    console.log(`   ${String(v.n).padStart(4)}  ${Math.round((v.n / total) * 100)}%  ${s}`);
  }
  console.log(`   exemplar of top: ${sorted[0][1].exemplar}`);
}
