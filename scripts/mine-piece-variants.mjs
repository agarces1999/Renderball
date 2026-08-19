/**
 * Mine the stored-deck corpus for the morphologies freeform generation
 * ACTUALLY produced per standard piece class — the variant sets for the
 * piece-spec are observed, not invented (founder requirement: variety must
 * survive standardization).
 *
 * v2 (founder: "at least 20 per type"): classification is CONTENT-based —
 * the v1 filename heuristic saw 49 of the corpus's 1051 pieces and
 * undercounted the real diversity. A statTile is recognized by its anatomy
 * (display-scale short value + small label), a bulletStack by repeated
 * item structure; ~20 ornament detectors then tally which visual features
 * real pieces carry.
 *
 *   node scripts/mine-piece-variants.mjs            # summary
 *   node scripts/mine-piece-variants.mjs --json     # full tally as JSON
 */
import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";

const GEN = "src/generated";
const decks = readdirSync(GEN).filter((d) => existsSync(join(GEN, d, "Composition.tsx")));

/** Anatomy-based class recognition over a piece's TSX source. */
const classify = (src) => {
  const bigType = /fontSize:\s*["'`]?(?:4[8-9]|[5-9]\d|1\d\d)/.test(src);
  const shortValue = /[>{]\s*["'`]?[~$€+-]?\d[\d,.]*\s*(?:%|[kKmMxX×]|pts?|ms|s)?["'`]?\s*[<}]/.test(src);
  const mapsItems = /\.map\(\s*\(/.test(src);
  const repeatedRows = (src.match(/display:\s*["']flex["']/g) ?? []).length >= 3;
  const listWords = /bullet|checklist|steps|features|points|items|list/i.test(src.slice(0, 600));
  const quote = /["'“][^"'”]{40,}["'”]/.test(src) && /[—–-]\s*\w+|cite|author|attribution/i.test(src);

  if (bigType && shortValue && !mapsItems) return "statTile";
  if ((mapsItems || repeatedRows) && (listWords || mapsItems)) return "bulletStack";
  if (quote && /quote|testimonial|said/i.test(src)) return "quoteCard";
  return null;
};

/**
 * Ornament/feature detectors — each is a cheap, honest signal for a visual
 * treatment observed in the wild. A variant candidate = a feature (or
 * combination) carried by real pieces.
 */
const DETECTORS = {
  boxed: (s) => /background(?:Color)?:/.test(s) && /borderRadius/.test(s),
  borderedBox: (s) => /border:\s*["'`]/.test(s),
  framedHairline: (s) => /border:\s*["'`]1px solid/.test(s) && !/background(?:Color)?:/.test(s),
  dashed: (s) => /dashed/.test(s),
  shadowCard: (s) => /boxShadow/.test(s),
  gradientPanel: (s) => /linear-gradient|radial-gradient/.test(s) && /background/.test(s),
  inversePanel: (s) => /background(?:Color)?:\s*[^,}]*(?:PALETTE\.(?:ink|bg|dark)|#0|#1[0-9a-f])/i.test(s),
  accentBarLeft: (s) => /borderLeft:\s*["'`][^"'`]*(?:accent|ACCENT)/i.test(s) || /width:\s*["'`]?[2-6]px["'`]?[^}]{0,80}height:\s*["'`]?(?:100%|\d{2,})/.test(s),
  ruledTop: (s) => /borderTop:\s*["'`][^"'`]*(?:accent|ACCENT|solid)/i.test(s),
  underline: (s) => /borderBottom:\s*["'`][^"'`]*(?:accent|ACCENT)/i.test(s) || /height:\s*["'`]?[2-4]px["'`]?[^}]{0,60}background[^}]{0,40}(?:accent|ACCENT)/i.test(s),
  pillBadge: (s) => /borderRadius:\s*["'`]?9{3,}/.test(s),
  mono: (s) => /FONT_MONO|monospace/.test(s),
  bigNumber: (s) => /fontSize:\s*["'`]?(?:8\d|9\d|1\d\d)/.test(s),
  ghostNumber: (s) => /opacity:\s*0?\.(?:0\d|1\d?)\b[^}]{0,120}fontSize:\s*["'`]?(?:1\d\d|[89]\d)/.test(s) || /fontSize:\s*["'`]?(?:1\d\d|[89]\d)[^}]{0,120}opacity:\s*0?\.(?:0\d|1\d?)\b/.test(s),
  iconled: (s) => /<(?:Check|Zap|Target|Shield|TrendingUp|Sparkles|Activity|Gauge|Rocket|ArrowUpRight)\b/.test(s),
  deltaArrow: (s) => /<(?:TrendingUp|TrendingDown|ArrowUp(?:Right)?|ArrowDown)\b/.test(s),
  sparkline: (s) => /<(?:polyline|path)\b[^>]*points?=/.test(s) && /viewBox/.test(s),
  indexNumbered: (s) => /0\{?\s*(?:i|idx|index)\s*\+\s*1|padStart\(2/.test(s) || /["'`]0[1-9]["'`]/.test(s),
  checkLed: (s) => /<Check(?:Circle2?)?\b/.test(s),
  arrowLed: (s) => /<(?:ArrowRight|ChevronRight)\b/.test(s),
  dotMarker: (s) => /width:\s*["'`]?[5-9]px["'`]?[^}]{0,60}borderRadius:\s*["'`]?(?:9{3,}|50%)/.test(s),
  dashMarker: (s) => /width:\s*["'`]?1[0-8]px["'`]?[^}]{0,60}height:\s*["'`]?[1-3]px/.test(s),
  horizontal: (s) => /flexDirection:\s*["']row/.test(s),
  grid: (s) => /display:\s*["']grid/.test(s),
  timeline: (s) => /position:\s*["']absolute[^}]{0,80}(?:width|height):\s*["'`]?[12]px/.test(s) && /\.map\(/.test(s),
  splitTone: (s) => /<span[^>]*color[^>]*>[^<]*<\/span>\s*<span[^>]*color/.test(s),
  captioned: (s) => /caption|sublabel|subtext|detail/i.test(s),
  letterSpaced: (s) => /letterSpacing:\s*["'`]?0?\.\d|textTransform:\s*["']uppercase/.test(s),
};

const tally = {}; // class → feature → { n, exemplars: [] }
const sigTally = {}; // class → signature → n
let piecesScanned = 0;
const byClass = { statTile: 0, bulletStack: 0, quoteCard: 0 };

for (const d of decks) {
  const dir = join(GEN, d, "lego", "pieces");
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".tsx"))) {
    const src = readFileSync(join(dir, f), "utf8");
    piecesScanned++;
    const cls = classify(src);
    if (!cls) continue;
    byClass[cls]++;
    tally[cls] = tally[cls] ?? {};
    const carried = [];
    for (const [name, det] of Object.entries(DETECTORS)) {
      if (!det(src)) continue;
      carried.push(name);
      tally[cls][name] = tally[cls][name] ?? { n: 0, exemplars: [] };
      tally[cls][name].n++;
      if (tally[cls][name].exemplars.length < 2) tally[cls][name].exemplars.push(`${d}/lego/pieces/${f}`);
    }
    const sig = carried.slice(0, 4).sort().join("+") || "plain";
    sigTally[cls] = sigTally[cls] ?? {};
    sigTally[cls][sig] = (sigTally[cls][sig] ?? 0) + 1;
  }
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ decks: decks.length, piecesScanned, byClass, tally, sigTally }, null, 1));
} else {
  console.log(`${decks.length} decks, ${piecesScanned} pieces scanned; classified:`, byClass);
  for (const [cls, feats] of Object.entries(tally)) {
    console.log(`\n${cls} — feature carriage (n pieces):`);
    for (const [name, v] of Object.entries(feats).sort((a, b) => b[1].n - a[1].n)) {
      console.log(`  ${String(v.n).padStart(4)}  ${name}   e.g. ${v.exemplars[0] ?? ""}`);
    }
    const sigs = Object.entries(sigTally[cls] ?? {}).sort((a, b) => b[1] - a[1]);
    console.log(`  distinct 4-feature signatures: ${sigs.length}`);
  }
}
