// Self-test for the SCORER's own judgement. An instrument nobody has tried to
// break is a number generator, not a measurement.
//
// Run: node selftest.mjs   (exit 1 on any failure)
import { rgbDistance, deltaE2000Lab, bandOf } from "./color.mjs";
import { scoreAccent, scoreFont } from "./scoring.mjs";
import { halfOf, bucketOf } from "./split.mjs";

let failed = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    failed++;
    console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  }
};

// --- the bands reproduce the founder's hand table exactly -------------------
eq("stripe near", bandOf(rgbDistance("#533afd", "#635bff")), "NEAR");
eq("klarna exact", bandOf(rgbDistance("#ffa8cd", "#ffb3c7")), "EXACT");
eq("robinhood exact", bandOf(rgbDistance("#ccff00", "#ccff00")), "EXACT");
eq("duolingo wrong", bandOf(rgbDistance("#00b086", "#58cc02")), "WRONG");
eq("shopify grey wrong", bandOf(rgbDistance("#71717a", "#95bf47")), "WRONG");
eq("posthog marginal near", bandOf(rgbDistance("#f7a501", "#f54e00")), "NEAR");
// boundaries are half-open exactly as documented
eq("29.9 is exact", bandOf(29.9), "EXACT");
eq("30 is near", bandOf(30), "NEAR");
eq("89.9 is near", bandOf(89.9), "NEAR");
eq("90 is wrong", bandOf(90), "WRONG");

// --- CIEDE2000 against Sharma's published pairs -----------------------------
for (const [a, b, want] of [
  [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
  [[50, 2.49, -0.001], [50, -2.49, 0.0009], 7.1792],
  [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
]) {
  const got = deltaE2000Lab(a, b);
  if (Math.abs(got - want) > 0.0002) {
    failed++;
    console.log(`FAIL ciede2000 ${want}: got ${got.toFixed(4)}`);
  }
}

// --- achromatic brands score on the other axis ------------------------------
const ach = { accent: null, achromatic: true };
eq("achromatic + no pick = hit", scoreAccent(null, ach).band, "CORRECT-NONE");
eq("achromatic + invented colour = miss", scoreAccent("#0070f3", ach).band, "INVENTED");
const chrom = { accent: "#58cc02", achromatic: false };
eq("chromatic + no pick = miss", scoreAccent(null, chrom).band, "MISSING");
eq("chromatic + right pick", scoreAccent("#58cc02", chrom).band, "EXACT");

// --- the font matcher's whole point: variants pass, novelty cuts don't ------
eq("sohne-var ~ sohne", scoreFont("sohne-var", "sohne", "stripe.com").band, "EXACT");
eq("NotionInter ~ Inter", scoreFont("NotionInter", "Inter", "notion.com").band, "NEAR");
eq("MonzoSansText ~ MonzoSansDisplay", scoreFont("MonzoSansText", "MonzoSansDisplay", "monzo.com").band, "NEAR");
eq("Capsule Sans Display ~ Capsule Sans", scoreFont("Capsule Sans Display", "Capsule Sans", "robinhood.com").band, "NEAR");
eq("ToledoTS-Bold ~ ToledoTS", scoreFont("ToledoTS-Bold", "ToledoTS", "brooklinen.com").band, "NEAR");
eq("saansFont ~ Saans", scoreFont("saansFont", "Saans", "retool.com").band, "EXACT");
// the two failures the brief named, which must NOT be forgiven
eq("GeistPixelGrid is NOT Geist", scoreFont("GeistPixelGrid", "Geist", "vercel.com").band, "WRONG");
eq("Noto Sans Arabic is NOT Inter", scoreFont("Noto Sans Arabic", "Inter", "notion.com").band, "WRONG");
eq("no font found", scoreFont(null, "Geist", "vercel.com").band, "MISSING");
eq("no truth = unscored", scoreFont("Anything", null, "x.com").band, "UNSCORED");

// --- the split is deterministic and depends only on the hostname ------------
eq("split stable 1", halfOf("stripe.com"), halfOf("stripe.com"));
eq("split known 1", halfOf("stripe.com"), "tune");
eq("split known 2", halfOf("klarna.com"), "holdout");
eq("bucket range", [0, 1, 2].includes(bucketOf("anything.example")), true);

console.log(failed === 0 ? "selftest: all assertions passed" : `selftest: ${failed} FAILURES`);
process.exitCode = failed === 0 ? 0 : 1;
