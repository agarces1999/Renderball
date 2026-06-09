/**
 * Regression tests for findDuplicatedEyebrows (QA B3).
 *
 * Run: `npm test`. Locks the detector for the eyebrow/kicker duplication where
 * the per-scene editorial tag is echoed in the BrandChrome pill AND rendered as
 * the headline kicker (Coniglio "COMIENZA EL DÍA", Stripe "THE CHALLENGE").
 * No API key, no network.
 */
import {
  findDuplicatedEyebrows,
  findDecorativeFillerIcons,
  assessContinuity,
  assessFontFidelity,
  assessRegisterVariety,
  findRedundantCaptions,
  hasCornerLogoSuppression,
  assessVerticalFill,
  repairInvalidLucideImports,
} from "./quality-gates";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : err}`);
  }
};
const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg);
};

// The bug: eyebrow echoed in the chrome pill AND as the kicker.
const DUP = `
  <BrandChrome category="THE CHALLENGE" sceneIndex={1} totalScenes={5} />
  <h6 className="eyebrow">— THE CHALLENGE</h6>
  <h1>Payments for the internet</h1>`;
// Clean: chrome carries a stable label, eyebrow appears once (kicker only).
const CLEAN = `
  <BrandChrome category="LAUNCH · 2026" sceneIndex={1} totalScenes={5} />
  <h6 className="eyebrow">— THE CHALLENGE</h6>
  <h1>Payments for the internet</h1>`;

check("flags an eyebrow echoed in chrome + kicker", () => {
  const dup = findDuplicatedEyebrows(DUP, ["THE CHALLENGE"]);
  assert(dup.includes("THE CHALLENGE"), `expected flag, got ${JSON.stringify(dup)}`);
});

check("clean — eyebrow appears once (kicker only) → no flag", () => {
  const dup = findDuplicatedEyebrows(CLEAN, ["THE CHALLENGE"]);
  assert(dup.length === 0, `expected none, got ${JSON.stringify(dup)}`);
});

check("case-insensitive + dash-prefix tolerant", () => {
  const code = `<span>the challenge</span><div>— The Challenge</div>`;
  const dup = findDuplicatedEyebrows(code, ["THE CHALLENGE"]);
  assert(dup.includes("THE CHALLENGE"), "should match across case + dash prefix");
});

check("ignores trivial / empty eyebrows", () => {
  assert(findDuplicatedEyebrows("AA AA", ["AA"]).length === 0, "short skipped");
  assert(findDuplicatedEyebrows("x x x", [""]).length === 0, "empty skipped");
});

check("multiple scenes — only the duplicated tag is flagged", () => {
  const code = `<span>THE TURN</span> ... <span>THE PROOF</span><div>THE PROOF</div>`;
  const dup = findDuplicatedEyebrows(code, ["THE TURN", "THE PROOF"]);
  assert(
    !dup.includes("THE TURN") && dup.includes("THE PROOF"),
    `got ${JSON.stringify(dup)}`,
  );
});

// ── D4: generic decorative-filler icons (Sparkles/Sparkle) ───────────
check("flags Sparkles + Sparkle filler icons", () => {
  const code = `<Sparkles size={12} /> ... <Sparkle /> ... <Check />`;
  assert(findDecorativeFillerIcons(code) === 2, "should count both shine icons");
});
check("does not flag literal icons (Check / Lock / Zap)", () => {
  const code = `<Check /><Lock /><Zap /><Leaf /><Recycle />`;
  assert(findDecorativeFillerIcons(code) === 0, "literal icons are fine");
});
check("does not match a longer identifier that starts with Sparkle", () => {
  // \\b guards against <SparkleField> etc.
  assert(findDecorativeFillerIcons("<SparkleField />") === 0, "no false match");
});

// ── B4: throughline-drift detection (assessContinuity) ───────────────
const DRIFT = `
  <div data-throughline="orb" style={{ position: "absolute", left: 120, top: 120 }} />
  <div data-throughline="orb" style={{ position: "absolute", left: 120, top: 980 }} />`;
const STABLE = `
  <div data-throughline="orb" style={{ position: "absolute", left: 120, top: 120 }} />
  <div data-throughline="orb" style={{ position: "absolute", left: 120, top: 140 }} />`;

check("detects a large vertical drift (the teleport)", () => {
  const out = assessContinuity(DRIFT, "16:9");
  const orb = out.find((d) => d.slug === "orb");
  assert(!!orb && orb.driftY >= 800, `expected driftY≥800, got ${JSON.stringify(out)}`);
});
check("stable anchor → no drift finding", () => {
  assert(assessContinuity(STABLE, "16:9").length === 0, "small drift should not flag");
});
check("a motif used only once is ignored", () => {
  const once = `<div data-throughline="orb" style={{ left: 120, top: 120 }} />`;
  assert(assessContinuity(once, "16:9").length === 0, "single occurrence → nothing to compare");
});

// ── C2: display-font fidelity ────────────────────────────────────────
check("flags FONT_DISPLAY using a different family than the brand font", () => {
  const code = `const FONT_DISPLAY = '"Playfair Display", serif';`;
  assert(assessFontFidelity(code, "Splash", false) === "Splash", "should flag mismatch");
});
check("passes when FONT_DISPLAY uses the brand font (quotes/spaces tolerant)", () => {
  const code = `const FONT_DISPLAY = '"Cabinet Grotesk", sans-serif';`;
  assert(assessFontFidelity(code, "Cabinet Grotesk", false) === null, "match → null");
});
check("never flags when the brand font is a fallback", () => {
  const code = `const FONT_DISPLAY = '"Whatever", serif';`;
  assert(assessFontFidelity(code, "Inter", true) === null, "fallback → null");
});
check("null when there is no FONT_DISPLAY constant", () => {
  assert(assessFontFidelity("const x = 1;", "Splash", false) === null, "no const → null");
});

// ── D3: register variety ─────────────────────────────────────────────
check("flags a 5-scene video with all-same register", () => {
  const r = assessRegisterVariety(["centered", "centered", "centered", "centered", "centered"]);
  assert(!!r && r.distinct === 1 && r.total === 5, `expected {1,5}, got ${JSON.stringify(r)}`);
});
check("passes a varied video (≥3 distinct)", () => {
  const r = assessRegisterVariety(["full-bleed", "split", "quote", "stat", "centered"]);
  assert(r === null, `expected null, got ${JSON.stringify(r)}`);
});
check("flags 4 scenes with only 2 distinct registers", () => {
  const r = assessRegisterVariety(["split", "split", "centered", "centered"]);
  assert(!!r && r.distinct === 2, `expected distinct 2, got ${JSON.stringify(r)}`);
});
check("ignores videos with <3 scenes", () => {
  assert(assessRegisterVariety(["split", "split"]) === null, "2 scenes → null");
});
check("treats missing registers as non-distinct", () => {
  const r = assessRegisterVariety(["split", undefined, "", "split"]);
  assert(!!r && r.distinct === 1, `expected distinct 1, got ${JSON.stringify(r)}`);
});

// ── V2: redundant captions ───────────────────────────────────────────────
const corgiProofScene = {
  scenes: [
    {
      content: {
        headline: "Trusted by the best",
        caption: "Artisan · AthenaHQ · Bland · Deel · Slash",
        asset_ids: ["img1", "img2", "img3", "img4"],
      },
    },
  ],
  assets: {
    images: [
      { id: "img1", alt_text: "Artisan" },
      { id: "img2", alt_text: "Bland" },
      { id: "img3", alt_text: "Deel" },
      { id: "img4", alt_text: "Slash" },
    ],
  },
};

check("flags a caption that lists the names already shown as logos", () => {
  const r = findRedundantCaptions(corgiProofScene);
  assert(r.length === 1 && r[0].reason === "lists-shown-assets", `expected lists-shown-assets, got ${JSON.stringify(r)}`);
});

check("flags a caption that just restates the headline", () => {
  const r = findRedundantCaptions({
    scenes: [{ content: { headline: "Quote in minutes", caption: "Quote in minutes." } }],
  });
  assert(r.length === 1 && r[0].reason === "echoes-headline", `expected echoes-headline, got ${JSON.stringify(r)}`);
});

check("a caption that ADDS information is NOT flagged", () => {
  const r = findRedundantCaptions({
    scenes: [
      {
        content: {
          headline: "Trusted by the best",
          caption: "Hundreds of startups, one platform",
          asset_ids: ["img1", "img2", "img3", "img4"],
        },
      },
    ],
    assets: corgiProofScene.assets,
  });
  assert(r.length === 0, `expected none, got ${JSON.stringify(r)}`);
});

check("no caption / single asset → not flagged", () => {
  assert(findRedundantCaptions({ scenes: [{ content: { headline: "Hi" } }] }).length === 0, "no caption");
  assert(
    findRedundantCaptions({
      scenes: [{ content: { headline: "Hi", caption: "Acme", asset_ids: ["x"] } }],
      assets: { images: [{ id: "x", alt_text: "Acme" }] },
    }).length === 0,
    "one asset isn't a 'list'",
  );
});

// ── V4: sanctioned hero-logo suppression (don't false-flag the CTA pattern) ──
check("hasCornerLogoSuppression detects showCornerLogo={false}", () => {
  assert(hasCornerLogoSuppression('<BrandChrome sceneIndex={4} showCornerLogo={false} />') === true, "should detect");
  assert(hasCornerLogoSuppression('<BrandChrome sceneIndex={4} />') === false, "no suppression");
});

// ── V1: vertical fill (empty lower band) — conservative ──────────────────────
const topCluster = `<div style={{ position:'absolute', top: 40 }}/><div style={{ position:'absolute', top: 120 }}/><div style={{ position:'absolute', top: 200 }}/><div style={{ position:'absolute', top: 360 }}/><div style={{ position:'absolute', top: 520 }}/>`;
check("flags a top-cluster with an empty lower band (16:9)", () => {
  const r = assessVerticalFill(topCluster, "16:9");
  assert(r !== null && /empty lower band/i.test(r), `expected fill failure, got ${r}`);
});
check("does NOT flag when an element is anchored to the bottom", () => {
  assert(assessVerticalFill(topCluster + `<div style={{ position:'absolute', bottom: 80 }}/>`, "16:9") === null, "bottom anchor fills");
});
check("does NOT flag a flex space-between column", () => {
  assert(assessVerticalFill(topCluster + `<div style={{ justifyContent: 'space-between' }}/>`, "16:9") === null, "flex distributes");
});
check("does NOT flag when a tall element spans the band", () => {
  assert(assessVerticalFill(topCluster + `<div style={{ height: 720 }}/>`, "16:9") === null, "tall element fills");
});
check("does NOT flag when an element reaches the lower band (top: 800)", () => {
  assert(assessVerticalFill(topCluster + `<div style={{ position:'absolute', top: 800 }}/>`, "16:9") === null, "lower band used");
});
check("does NOT flag a flex layout with too few absolute tops", () => {
  assert(assessVerticalFill(`<div style={{ display:'flex' }}><h1/></div>`, "16:9") === null, "not enough positioned els");
});

// ── repairInvalidLucideImports (deterministic crash-prevention safety net) ──
check("aliases invalid brand icons to a real icon, preserving local usage", () => {
  const code = `import { Slack, CheckSquare, Github } from "lucide-react";
const icons = [Slack, Github];
const x = <Slack />;
const label = "Slack · #product";`;
  const out = repairInvalidLucideImports(code, ["Slack", "Github"]);
  assert(/Square as Slack/.test(out), "Slack aliased to Square");
  assert(/Square as Github/.test(out), "Github aliased to Square");
  assert(out.includes("CheckSquare"), "valid icon kept");
  // The bare invalid specifiers are gone — only the aliased form remains.
  const specs = out.match(/import\s*\{([^}]*)\}/)![1].split(",").map((s) => s.trim());
  assert(!specs.includes("Slack") && !specs.includes("Github"), "no bare invalid specifier left");
  // Usages still reference the (now-aliased) identifiers — code unbroken.
  assert(out.includes("[Slack, Github]") && out.includes("<Slack />"), "usages intact");
  // String literal label is untouched.
  assert(out.includes('"Slack · #product"'), "label string untouched");
});
check("no-op when there are no invalid names", () => {
  const code = `import { Square, Zap } from "lucide-react";`;
  assert(repairInvalidLucideImports(code, []) === code, "empty list → unchanged");
});
check("preserves an existing alias on an invalid icon", () => {
  const out = repairInvalidLucideImports(
    `import { Slack as BrandMark, Zap } from "lucide-react";`,
    ["Slack"],
  );
  assert(/Square as BrandMark/.test(out), "alias target preserved");
  assert(out.includes("Zap"), "valid icon kept");
});
check("idempotent — re-running finds nothing to repair", () => {
  const once = repairInvalidLucideImports(
    `import { Slack, Zap } from "lucide-react";`,
    ["Slack"],
  );
  // After repair the export is `Square`, so passing the old name again is a no-op.
  assert(repairInvalidLucideImports(once, ["Slack"]) === once, "second pass unchanged");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
