// THE SCORER. Runs the repo's real brand read against the truth set and prints
// the numbers. No model call, no repo modification, no npm dependency.
//
//   node score.mjs                      # both halves, cached network, tune detail
//   node score.mjs --half tune          # tune only
//   node score.mjs --half holdout       # holdout aggregate only
//   node score.mjs --reveal-holdout     # per-site holdout detail (auditing only)
//   node score.mjs --only stripe.com    # one site, verbose
//   node score.mjs --refetch            # ignore the byte cache, re-record live
//   node score.mjs --json out.json      # machine-readable snapshot
//
// WHAT IT SCORES. Two outputs, because they are not the same answer and only
// one of them is what the product ships:
//   signature — resolveBrandIdentity(extract).signature, the value the design
//               pipeline actually paints with. THIS IS THE HEADLINE.
//   palette0  — extract.palette[0], the raw head of the crawl's ranked list,
//               which is what the brief's hand table measured.
// They diverge: on klarna.com palette0 is #ffa8cd (the pink, EXACT) while
// signature is #5c32b8 (a purple, WRONG) — pickSignatureColor re-ranks by
// vividness and demotes pale brand colours. A fix aimed only at palette0 can
// leave the shipped answer untouched, so both are reported.
//
// BANDS (accent): EXACT < 30, NEAR < 90, WRONG >= 90, euclidean sRGB.
// For an achromatic brand (accent: null) returning NO accent is a HIT and
// inventing a colour is a MISS — the row still counts, it just scores on a
// different axis.
//
// BANDS (display font): EXACT = same family after stripping variant suffixes
// (var/variable/vf/web/std/pro/font/fallback). NEAR = one name contains the
// other and the leftover is a known optical/weight qualifier (text, display,
// sans, serif, mono, tight, condensed, bold, book, medium, regular, light) or
// the brand's own name — so "sohne-var" ~ "sohne" and "NotionInter" ~ "Inter"
// pass, while "GeistPixelGrid" vs "Geist" does NOT (leftover "pixelgrid" is a
// novelty cut, and the brief calls that answer wrong). WRONG otherwise.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { BANDS } from "./color.mjs";
import { scoreAccent, scoreFont, HIT_BANDS, STRICT_BANDS } from "./scoring.mjs";
import { loadPicker, stats, CACHE_DIR } from "./harness.mjs";

const HERE = dirname(new URL(import.meta.url).pathname);
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const half = opt("half", "both");
const revealHoldout = flag("reveal-holdout");
const only = opt("only", null);
if (flag("refetch")) process.env.RB_TRUTH_REFETCH = "1";

const loadRows = () => {
  const rows = [];
  if (half === "tune" || half === "both") {
    rows.push(...JSON.parse(readFileSync(join(HERE, "truth-tune.json"), "utf8")).rows);
  }
  if (half === "holdout" || half === "both") {
    const p = join(HERE, "_sealed", "truth-holdout.b64");
    if (!existsSync(p)) throw new Error(`missing ${p} — run: node split.mjs`);
    const decoded = JSON.parse(Buffer.from(readFileSync(p, "utf8"), "base64").toString("utf8"));
    rows.push(...decoded.rows);
  }
  return only ? rows.filter((r) => r.host === only) : rows;
};

const summarize = (results, key) => {
  const bands = {};
  let hits = 0,
    strict = 0,
    n = 0;
  const dists = [];
  for (const r of results) {
    const s = r[key];
    if (s.band === "UNSCORED") continue;
    n++;
    bands[s.band] = (bands[s.band] ?? 0) + 1;
    if (HIT_BANDS.has(s.band)) hits++;
    if (STRICT_BANDS.has(s.band)) strict++;
    if (typeof s.d === "number") dists.push(s.d);
  }
  dists.sort((a, b) => a - b);
  return {
    n,
    bands,
    hitRate: n ? hits / n : 0,
    strictRate: n ? strict / n : 0,
    medianDist: dists.length ? dists[Math.floor(dists.length / 2)] : null,
    meanDist: dists.length ? dists.reduce((a, b) => a + b, 0) / dists.length : null,
  };
};

const pct = (x) => `${(x * 100).toFixed(0)}%`;
const fmtSummary = (label, s) => {
  const order = ["EXACT", "NEAR", "WRONG", "MISSING", "CORRECT-NONE", "INVENTED"];
  const parts = order.filter((b) => s.bands[b]).map((b) => `${b} ${s.bands[b]}`);
  const d =
    s.medianDist === null
      ? ""
      : `  median Δrgb ${s.medianDist.toFixed(0)}  mean ${s.meanDist.toFixed(0)}`;
  return `${label.padEnd(22)} n=${String(s.n).padStart(2)}  hit ${pct(s.hitRate).padStart(4)}  strict ${pct(
    s.strictRate,
  ).padStart(4)}   ${parts.join("  ")}${d}`;
};

// ---------------------------------------------------------------------- main
const rows = loadRows();
if (rows.length === 0) {
  console.error("no rows selected");
  process.exit(1);
}

const picker = await loadPicker();
const results = [];
let idx = 0;
const CONC = 6;
await Promise.all(
  Array.from({ length: CONC }, async () => {
    while (idx < rows.length) {
      const row = rows[idx++];
      const t0 = Date.now();
      let extract, identity, err = null;
      try {
        extract = await picker.readSiteBrand(row.host);
        identity = picker.resolveBrandIdentity(extract);
      } catch (e) {
        err = e instanceof Error ? e.message : String(e);
      }
      const signature = identity?.signature ?? null;
      const palette0 = extract?.palette?.[0] ?? null;
      const font =
        identity && identity.fonts.display && !identity.fonts.display.fallback
          ? identity.fonts.display.family
          : null;
      results.push({
        host: row.host,
        half: row.half,
        row,
        ok: extract?.ok === true,
        error: err ?? extract?.error ?? null,
        signature,
        palette0,
        font,
        ms: Date.now() - t0,
        sig: scoreAccent(signature, row),
        pal: scoreAccent(palette0, row),
        fnt: scoreFont(font, row.display_font, row.host),
      });
      process.stderr.write(".");
    }
  }),
);
process.stderr.write("\n");
results.sort((a, b) => rows.findIndex((r) => r.host === a.host) - rows.findIndex((r) => r.host === b.host));

const line = (r) => {
  const t = r.row.achromatic ? "(none)" : r.row.accent;
  const dd = (s) => (s.d === null ? "" : ` Δ${s.d.toFixed(0)}/dE${s.de.toFixed(0)}`);
  return [
    r.host.padEnd(22),
    (r.row.builder ?? "-").padEnd(11),
    `truth ${String(t).padEnd(8)}`,
    `sig ${String(r.signature ?? "(none)").padEnd(8)} ${r.sig.band.padEnd(12)}${dd(r.sig)}`.padEnd(40),
    `pal0 ${String(r.palette0 ?? "(none)").padEnd(8)} ${r.pal.band.padEnd(12)}`.padEnd(30),
    r.row.display_font
      ? `font ${String(r.font ?? "(none)").slice(0, 20).padEnd(20)} ${r.fnt.band}`
      : "",
    r.ok ? "" : `  !! ${r.error ?? "crawl failed"}`,
  ].join(" ");
};

const halves = half === "both" ? ["tune", "holdout"] : [half];
const out = { generated: new Date().toISOString(), bands: BANDS, halves: {} };

for (const h of halves) {
  const sub = results.filter((r) => r.half === h);
  if (sub.length === 0) continue;
  const showDetail = h === "tune" || revealHoldout || only;
  console.log(`\n${"=".repeat(112)}\n${h.toUpperCase()}  (${sub.length} sites)\n${"=".repeat(112)}`);
  if (showDetail) for (const r of sub) console.log(line(r));
  else console.log("(per-site detail withheld — this is the holdout. --reveal-holdout to audit.)");

  const sig = summarize(sub, "sig");
  const pal = summarize(sub, "pal");
  const fnt = summarize(sub, "fnt");
  const hi = sub.filter((r) => r.row.confidence === "high");
  console.log("");
  console.log(fmtSummary("ACCENT signature", sig));
  console.log(fmtSummary("ACCENT palette[0]", pal));
  console.log(fmtSummary("DISPLAY FONT", fnt));
  console.log(fmtSummary("  (high-confidence rows)", summarize(hi, "sig")));
  const failed = sub.filter((r) => !r.ok);
  if (failed.length) console.log(`  crawl failures: ${failed.map((r) => r.host).join(", ")}`);
  out.halves[h] = {
    n: sub.length,
    signature: sig,
    palette0: pal,
    font: fnt,
    highConfidenceSignature: summarize(hi, "sig"),
    sites:
      showDetail && (h === "tune" || revealHoldout)
        ? sub.map((r) => ({
            host: r.host,
            truth: r.row.achromatic ? null : r.row.accent,
            signature: r.signature,
            palette0: r.palette0,
            font: r.font,
            sig: r.sig.band,
            pal: r.pal.band,
            fnt: r.fnt.band,
            drgb: r.sig.d,
            de00: r.sig.de,
          }))
        : undefined,
  };
}

console.log(
  `\nnetwork: ${stats.hits} cached, ${stats.misses} fetched, ${stats.errors} errors  (cache: ${CACHE_DIR})`,
);
const jsonPath = opt("json", null);
if (jsonPath) {
  writeFileSync(jsonPath, JSON.stringify(out, null, 2));
  console.log(`snapshot → ${jsonPath}`);
}
