/**
 * Regression tests for findDuplicatedEyebrows (QA B3).
 *
 * Run: `npm test`. Locks the detector for the eyebrow/kicker duplication where
 * the per-scene editorial tag is echoed in the BrandChrome pill AND rendered as
 * the headline kicker (Coniglio "COMIENZA EL DÍA", Stripe "THE CHALLENGE").
 * No API key, no network.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  findDuplicatedEyebrows,
  findDecorativeFillerIcons,
  assessContinuity,
  repositionThroughline,
  assessFontFidelity,
  assessRegisterVariety,
  findRedundantCaptions,
  hasCornerLogoSuppression,
  assessVerticalFill,
  repairInvalidLucideImports,
  addMissingLucideImports,
  findUndefinedJsxComponents,
  stubUndefinedComponents,
  findDrawnLogoStandIns,
  findProvidedComponentRedefinitions,
  findUndersizedText,
  findUndwelledText,
  countAccentBorders,
  findUnboundCopy,
  assessThroughlinePresence,
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

// ── deterministic drift repair (repositionThroughline) ───────────────
check("reposition snaps a drifted motif to a stable anchor → drift clears", () => {
  const { code, moved } = repositionThroughline(DRIFT, "16:9");
  assert(moved === 2, `expected both occurrences moved, got ${moved}`);
  // After the snap, assessContinuity must find NO drift (this is what clears
  // driftFailure and skips the whole-composition re-emit).
  assert(assessContinuity(code, "16:9").length === 0, "drift must be gone after reposition");
});
check("reposition preserves the px unit + quotes (real fill form)", () => {
  const q = `
    <div data-throughline={SLUG} style={{ left: "740px", top: "300px" }}>a</div>
    <div data-throughline={SLUG} style={{ left: "740px", top: "980px" }}>b</div>`;
  const { code, moved } = repositionThroughline(q, "16:9");
  assert(moved >= 1, "at least the drifted occurrence moves");
  assert(/top:\s*"\d+px"/.test(code), `px+quote form must be preserved: ${code}`);
  assert(assessContinuity(code, "16:9").length === 0, "drift cleared on the quoted-px form");
});
check("a stable motif is left untouched (no needless churn)", () => {
  const { code, moved } = repositionThroughline(STABLE, "16:9");
  assert(moved === 0, "nothing drifts → nothing moves");
  assert(code === STABLE, "stable code returned byte-identical");
});
check("non-throughline tags are never touched", () => {
  const mixed = `
    <div data-throughline="orb" style={{ left: 100, top: 100 }} />
    <div data-throughline="orb" style={{ left: 100, top: 900 }} />
    <div className="other" style={{ left: 500, top: 500 }} />`;
  const { code } = repositionThroughline(mixed, "16:9");
  assert(/className="other" style=\{\{ left: 500, top: 500 \}\}/.test(code), "unrelated element must be byte-identical");
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

// ── A1(b): undefined JSX components (guaranteed render crash) ────────────────
// A capitalized tag resolving to neither a local definition nor an import is
// React's "Element type is invalid" white screen. Heavy false-positive guards
// (the detector favors false negatives — a false positive burns an Opus retry).
const UNDEF_BASE = `import React from "react";
import { Img } from "./Img";
import {
  Check,
  Square as Slack,
} from "lucide-react";
const Card = ({ title }: { title: string }) => <div>{title}</div>;
function Banner() { return <div />; }
export const Section0 = () => (
  <div>
    <Card title="x" /><Banner /><Img src="https://a/b.png" /><Slack /><Check />
  </div>
);`;

check("clean file — locals + named/aliased/default/multi-line imports resolve", () => {
  const r = findUndefinedJsxComponents(UNDEF_BASE);
  assert(r.length === 0, `expected none, got ${JSON.stringify(r)}`);
});

check("flags a rendered tag with no definition or import", () => {
  const r = findUndefinedJsxComponents(
    UNDEF_BASE + `\nexport const Section1 = () => <HeroPanel />;`,
  );
  assert(r.length === 1 && r[0] === "HeroPanel", `got ${JSON.stringify(r)}`);
});

check("lists every distinct undefined tag, deduped", () => {
  const r = findUndefinedJsxComponents(
    UNDEF_BASE + `\nconst S = () => <><Ghost /><Ghost /><Phantom /></>;`,
  );
  assert(
    r.length === 2 && r.includes("Ghost") && r.includes("Phantom"),
    `got ${JSON.stringify(r)}`,
  );
});

check("stubUndefinedComponents: stubs invented customs, leaves lucide/defined alone", () => {
  const code = UNDEF_BASE + `\nexport const S1 = () => <><HeroPanel /><Check /></>;`;
  const { code: out, stubbed } = stubUndefinedComponents(code, (n) => n === "Check" || n === "Slack");
  assert(stubbed.length === 1 && stubbed[0] === "HeroPanel", `stubbed: ${JSON.stringify(stubbed)}`);
  assert(out.includes("const HeroPanel: React.FC<any> = () => null;"), "stub injected at module scope");
  assert(!out.includes("const Check:") && !out.includes("const Slack:"), "lucide names not stubbed");
  assert(findUndefinedJsxComponents(out).length === 0, "nothing undefined remains after stubbing");
});

check("stubUndefinedComponents: no-op when everything resolves", () => {
  const { code: out, stubbed } = stubUndefinedComponents(UNDEF_BASE, () => false);
  assert(stubbed.length === 0 && out === UNDEF_BASE, "clean file untouched");
});

check("JSX member tags (<Foo.Bar>) are skipped", () => {
  const r = findUndefinedJsxComponents(
    `import * as Icons from "lucide-react";\nconst S = () => <Icons.Slack />;\nconst T = () => <Unknowns.Deep />;`,
  );
  assert(r.length === 0, `member tags must not flag, got ${JSON.stringify(r)}`);
});

check("lowercase html tags are never flagged", () => {
  const r = findUndefinedJsxComponents(`const S = () => <div><p>hi</p><svg /></div>;`);
  assert(r.length === 0, `got ${JSON.stringify(r)}`);
});

check("generics in type positions don't flag", () => {
  const code = `import React from "react";
type Props = { x: number };
type Item = string;
const f: React.FC<Props> = () => null;
const xs = new Array<Item>(3);
const g = <T,>(t: T): T => t;
const h = <T extends object>(t: T) => t;
export const Section0 = () => <div />;`;
  const r = findUndefinedJsxComponents(code);
  assert(r.length === 0, `got ${JSON.stringify(r)}`);
});

check("`<` comparisons with globals / defined consts don't flag", () => {
  const code = `const START = 10;
const S = ({ frame }: { frame: number }) => (
  <div>{frame < START && frame < Infinity && frame < Math.PI ? "a" : "b"}</div>
);`;
  const r = findUndefinedJsxComponents(code);
  assert(r.length === 0, `got ${JSON.stringify(r)}`);
});

check("strings and comments are not render sites", () => {
  const code = `import React from "react";
// TODO: maybe add <Ghost> here
/* legacy: <Phantom /> */
const label = "render <Spectre> later";
const css = \`.x { content: "<Wraith>"; }\`;
export const Section0 = () => <div>{label}{css}</div>;`;
  const r = findUndefinedJsxComponents(code);
  assert(r.length === 0, `got ${JSON.stringify(r)}`);
});

check("memo/forwardRef/styled-defined components resolve", () => {
  const code = `import React from "react";
const Card = React.memo(() => <div />);
const Field = React.forwardRef(() => <input />);
const S = () => <><Card /><Field /></>;`;
  const r = findUndefinedJsxComponents(code);
  assert(r.length === 0, `got ${JSON.stringify(r)}`);
});

check("destructured + plain-parameter bindings resolve", () => {
  const code = `import { Code2, Users } from "lucide-react";
const { Mark } = pack;
const rows = items.map(({ icon: Icon }) => <Icon />);
const tiles = [Code2, Users].map((Glyph, i) => <Glyph key={i} />);
const S = () => <Mark />;`;
  const r = findUndefinedJsxComponents(code);
  assert(r.length === 0, `got ${JSON.stringify(r)}`);
});

check("the regression class — a hallucinated component never imported", () => {
  // The 87c785f family: the agent renders a mark it never wrote. The lucide
  // denylist can't see it (no lucide import involved) and esbuild compiles it
  // clean; only the binding-level scan catches the guaranteed crash.
  const code = `import React from "react";
const LogoMark = () => <svg viewBox="0 0 10 10" />;
export const Section0 = () => (
  <div><LogoMark /><BrandBolt size={20} /></div>
);`;
  const r = findUndefinedJsxComponents(code);
  assert(r.length === 1 && r[0] === "BrandBolt", `got ${JSON.stringify(r)}`);
});

// ── A1(c): drawn-logo stand-ins (the Supabase replica loophole) ──────────────
// A real logo resolved, but the agent hand-drew a replica of the mark as a
// local SVG component instead of mounting <Img src={LOGO_SRC}> — looks like
// the logo on screen, is a fabrication (eyeballed paths, approximated color).
const DRAWN_LOGO = `
const LogoMark: React.FC<{ size?: number }> = ({ size = 64 }) => (
  <svg viewBox="0 0 109 113" width={size}>
    <path d="M63.7 110.2 ..." fill="#3ECF8E" />
  </svg>
);
const Grain: React.FC = () => (
  <svg viewBox="0 0 10 10"><rect /></svg>
);
export const Section0 = () => (<div><LogoMark size={22} /><Grain /></div>);`;

check("flags a hand-drawn, logo-named, rendered SVG component", () => {
  const r = findDrawnLogoStandIns(DRAWN_LOGO);
  assert(
    r.length === 1 && r[0] === "LogoMark",
    `expected just the logo-named drawn mark, got ${JSON.stringify(r)}`,
  );
});

check("an <Img src={LOGO_SRC}> wrapper named LogoMark is NOT a stand-in", () => {
  const code = `
const LogoMark = ({ h = 28 }) => <Img src={LOGO_SRC} style={{ height: h }} />;
export const Section0 = () => <LogoMark />;`;
  assert(findDrawnLogoStandIns(code).length === 0, "sanctioned wrapper flagged");
});

check("a drawn mark that is never rendered is not flagged", () => {
  const code = `const LogoMark = () => (<svg viewBox="0 0 10 10" />);\nexport const Section0 = () => <div />;`;
  assert(findDrawnLogoStandIns(code).length === 0, "unrendered def flagged");
});

check("non-logo-named svg components are not flagged", () => {
  const code = `const Grain = () => (<svg viewBox="0 0 10 10" />);\nexport const Section0 = () => <Grain />;`;
  assert(findDrawnLogoStandIns(code).length === 0, "Grain is not a logo name");
});

check("function-declared brand mark counts; name match is case-insensitive", () => {
  const code = `function BrandMark() { return <svg viewBox="0 0 4 4" />; }
const SupabaseLogo = () => (<svg viewBox="0 0 9 9" />);
export const Section0 = () => (<div><BrandMark /><SupabaseLogo /></div>);`;
  const r = findDrawnLogoStandIns(code);
  assert(
    r.includes("BrandMark") && r.includes("SupabaseLogo") && r.length === 2,
    `got ${JSON.stringify(r)}`,
  );
});

// ── provided-component contract: BrandChrome must be imported, not authored ──
check("flags a const redefinition of the provided BrandChrome", () => {
  const r = findProvidedComponentRedefinitions(
    `const BrandChrome: React.FC<{}> = () => <div />;`,
  );
  assert(r.length === 1 && r[0] === "BrandChrome", `expected flag, got ${JSON.stringify(r)}`);
});
check("flags function/class forms too", () => {
  assert(findProvidedComponentRedefinitions(`function BrandChrome() { return null; }`).length === 1, "function form");
  assert(findProvidedComponentRedefinitions(`class BrandChrome extends React.Component {}`).length === 1, "class form");
});
check("importing + rendering the provided component is NOT a redefinition", () => {
  const ok = `import { BrandChrome } from "./BrandChrome";
const Chrome = (p: { sceneIndex: number }) => <BrandChrome {...p} totalScenes={5} ink="#fff" accent="#0f0" fontDisplay="x" fontBody="y" />;`;
  assert(findProvidedComponentRedefinitions(ok).length === 0, "wrapper config is sanctioned");
});
check("similarly-named components don't false-positive", () => {
  assert(
    findProvidedComponentRedefinitions(`const BrandChromeProps = {}; const MyBrandChrome = () => null;`).length === 0,
    "word-boundary guard",
  );
});

// ── Scene review #1: text-size floors (findUndersizedText) ───────────────────
check("flags a body <p> below the 24px floor", () => {
  const code = `<p style={{ fontSize: 18, fontFamily: FONT_BODY, color: "#fff", lineHeight: 1.5 }}>Members waiting for modern experiences.</p>`;
  const r = findUndersizedText(code);
  assert(
    r.length === 1 && r[0].tag === "p" && r[0].fontSize === 18 && r[0].floor === 24,
    `got ${JSON.stringify(r)}`,
  );
});

check("flags an <li> below the 18px floor", () => {
  const r = findUndersizedText(`<li style={{ fontSize: 15, color: "#ccc" }}>One-click approvals</li>`);
  assert(r.length === 1 && r[0].tag === "li" && r[0].floor === 18, `got ${JSON.stringify(r)}`);
});

check("at/above the floors → no flag", () => {
  const code = `
    <p style={{ fontSize: 24, color: "#fff" }}>Lede.</p>
    <li style={{ fontSize: 18 }}>Point</li>
    <p style={{ fontSize: "26px" }}>Body.</p>`;
  assert(findUndersizedText(code).length === 0, "compliant sizes flagged");
});

check("string px form is parsed", () => {
  const r = findUndersizedText(`<p style={{ fontSize: "16px", color: "#fff" }}>Tiny.</p>`);
  assert(r.length === 1 && r[0].fontSize === 16, `got ${JSON.stringify(r)}`);
});

check("mono caption (wide letterSpacing) is exempt", () => {
  const code = `<p style={{ fontSize: 13, letterSpacing: "0.14em", color: "#888" }}>RENDER 01 / 05</p>`;
  assert(findUndersizedText(code).length === 0, "caption chrome flagged");
});

check("uppercase chrome and mono fontFamily are exempt", () => {
  const code = `
    <p style={{ fontSize: 14, textTransform: "uppercase", color: "#888" }}>The proof</p>
    <p style={{ fontSize: 14, fontFamily: FONT_MONO }}>00:12 · 1080p</p>
    <p style={{ fontSize: 14, fontFamily: '"Geist Mono", monospace' }}>v2.4.1</p>`;
  assert(findUndersizedText(code).length === 0, "chrome/mono flagged");
});

check("no inline fontSize → skipped (favor false negatives)", () => {
  assert(findUndersizedText(`<p style={{ color: "#fff", opacity: 0.85 }}>Inherited.</p>`).length === 0, "inherited size flagged");
});

check("narrow letterSpacing does NOT exempt", () => {
  const r = findUndersizedText(`<p style={{ fontSize: 16, letterSpacing: "-0.01em" }}>Tight lede.</p>`);
  assert(r.length === 1, `tracking below 0.12em must not exempt, got ${JSON.stringify(r)}`);
});

check("headlines / spans / divs are out of scope", () => {
  const code = `<h1 style={{ fontSize: 12 }}>X</h1><span style={{ fontSize: 11 }}>y</span><div style={{ fontSize: 10 }}>z</div>`;
  assert(findUndersizedText(code).length === 0, "non-p/li tags flagged");
});

// ── Scene review #2: late-beat dwell (findUndwelledText) ──────────────────────
const dwellScript = { scenes: [{ start_seconds: 0, end_seconds: 8 }] };

check("flags a headline that lands in the final moments of a scene", () => {
  const code = `export const Section0 = () => (<div>
    <h1 style={{ opacity: 0, animation: "fadeRise 0.4s cubic-bezier(.2,.8,.2,1) 7.2s forwards" }}>Approve loans instantly</h1>
  </div>);`;
  const r = findUndwelledText(code, dwellScript);
  assert(
    r.length === 1 && r[0].section === 0 && r[0].tag === "h1" && r[0].landsAt === 7.6,
    `got ${JSON.stringify(r)}`,
  );
});

check("an early text beat with dwell time passes", () => {
  const code = `export const Section0 = () => (<div>
    <h1 style={{ opacity: 0, animation: "fadeRise 0.4s ease 0.6s forwards" }}>Approve loans instantly</h1>
  </div>);`;
  assert(findUndwelledText(code, dwellScript).length === 0, "early beat flagged");
});

check("a long lede needs words×0.3s — flagged even mid-scene", () => {
  // 20 words → readTime 6s; lands at 4.5s → needs 10.5s in an 8s scene.
  const code = `export const Section0 = () => (<div>
    <p style={{ fontSize: 26, opacity: 0, animation: "fadeRise 0.5s ease 4s forwards" }}>one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty</p>
  </div>);`;
  const r = findUndwelledText(code, dwellScript);
  assert(r.length === 1 && r[0].readTime === 6, `got ${JSON.stringify(r)}`);
});

check("very short scenes are skipped", () => {
  const code = `export const Section0 = () => (<h1 style={{ animation: "fadeRise 0.4s ease 2s forwards" }}>Quick beat lands late</h1>);`;
  const r = findUndwelledText(code, { scenes: [{ start_seconds: 0, end_seconds: 2.5 }] });
  assert(r.length === 0, "short scene flagged");
});

check("an unfixable reading budget does NOT flag (copy length ≠ late beat)", () => {
  // Duolingo FP-rebuild regression: a 25-word lede in a 5s scene (readTime
  // 7.5s > 85% of 5s) already landing at 0.5s — no earlier landing can
  // satisfy the budget, so the late-beat retry instruction is unactionable.
  const words = Array.from({ length: 25 }, (_, i) => `w${i}`).join(" ");
  const code = `export const Section0 = () => (<div>
    <p style={{ fontSize: 26, opacity: 0, animation: "fadeRise 0.4s ease 0.1s forwards" }}>${words}</p>
  </div>);`;
  const r = findUndwelledText(code, { scenes: [{ start_seconds: 0, end_seconds: 5 }] });
  assert(r.length === 0, `unfixable budget flagged: ${JSON.stringify(r)}`);
});

check("a knife-edge budget (>85% of scene) does NOT flag either", () => {
  // 20 words → readTime 6s = 92% of a 6.5s scene: the only 'fix' is shaving
  // ~0.1s off the entrance — not a meaningful quality signal.
  const words = Array.from({ length: 20 }, (_, i) => `w${i}`).join(" ");
  const code = `export const Section0 = () => (<div>
    <p style={{ fontSize: 26, opacity: 0, animation: "fadeRise 0.4s ease 0.2s forwards" }}>${words}</p>
  </div>);`;
  const r = findUndwelledText(code, { scenes: [{ start_seconds: 0, end_seconds: 6.5 }] });
  assert(r.length === 0, `knife-edge budget flagged: ${JSON.stringify(r)}`);
});

check("infinite/atmosphere animations never flag", () => {
  const code = `export const Section0 = () => (<h1 style={{ animation: "pulse 2s ease-in-out 7s infinite" }}>Glowing headline</h1>);`;
  assert(findUndwelledText(code, dwellScript).length === 0, "infinite loop flagged");
});

check("mono caption chrome is exempt from dwell", () => {
  const code = `export const Section0 = () => (<p style={{ letterSpacing: "0.16em", animation: "fadeIn 0.3s ease 7.5s forwards" }}>01 / 05</p>);`;
  assert(findUndwelledText(code, dwellScript).length === 0, "caption flagged");
});

check("unanimated text never flags (visible from t=0)", () => {
  const code = `export const Section0 = () => (<h1 style={{ fontSize: 120 }}>Always on screen</h1>);`;
  assert(findUndwelledText(code, dwellScript).length === 0, "static text flagged");
});

check("maps Section index to its own scene duration", () => {
  // Same late-ish beat: fine in the 12s scene, fatal in the 4s scene.
  const code = `
export const Section0 = () => (<h1 style={{ animation: "fadeRise 0.4s ease 3.4s forwards" }}>Three word beat</h1>);
export const Section1 = () => (<h1 style={{ animation: "fadeRise 0.4s ease 3.4s forwards" }}>Three word beat</h1>);`;
  const r = findUndwelledText(code, {
    scenes: [{ start_seconds: 0, end_seconds: 12 }, { start_seconds: 12, end_seconds: 16 }],
  });
  assert(r.length === 1 && r[0].section === 1, `got ${JSON.stringify(r)}`);
});

check("falls back to frame-based scene timing", () => {
  const code = `export const Section0 = () => (<h1 style={{ animation: "fadeRise 0.4s ease 7.2s forwards" }}>Approve loans instantly</h1>);`;
  const r = findUndwelledText(code, { scenes: [{ start_frame: 0, end_frame: 240 }] }); // 8s @30fps
  assert(r.length === 1, `got ${JSON.stringify(r)}`);
});

check("a `both`-filled lede that lands late is flagged (fill-mode parity)", () => {
  // Fill-mode parity specimen: a 7-word lede (readTime 2.1s — comfortably
  // fixable, 42% of the scene) with fill-mode `both` landing at 3.2s of a 5s
  // scene. Before the fix the gate matched only `forwards` and skipped every
  // `both` entrance, so this passed blind. (The original Ramp 18-word
  // specimen moved under the copy-length exemption — readTime 5.4s can't fit
  // a 5s scene at ANY landing, which is now correctly not a late-beat fire.)
  const code = `export const Section0 = () => (<div>
    <p style={{ fontSize: 26, opacity: 0, animation: "fadeRise 0.4s cubic-bezier(.2,.8,.2,1) 2.8s both" }}>finance teams spend weeks manually processing expenses</p>
  </div>);`;
  const r = findUndwelledText(code, { scenes: [{ start_seconds: 0, end_seconds: 5 }] });
  assert(
    r.length === 1 && r[0].section === 0 && r[0].landsAt === 3.2 && r[0].readTime === 2.1,
    `got ${JSON.stringify(r)}`,
  );
});

check("a `both`-filled early beat with dwell time still passes", () => {
  const code = `export const Section0 = () => (<div>
    <h1 style={{ opacity: 0, animation: "fadeRise 0.4s ease 0.6s both" }}>Approve loans instantly</h1>
  </div>);`;
  assert(findUndwelledText(code, dwellScript).length === 0, "`both` early beat flagged");
});

check("`forwards` and `both` produce identical dwell verdicts", () => {
  const mk = (fill: string) =>
    `export const Section0 = () => (<h1 style={{ animation: "fadeRise 0.4s ease 7.2s ${fill}" }}>Approve loans instantly</h1>);`;
  const fwd = findUndwelledText(mk("forwards"), dwellScript);
  const both = findUndwelledText(mk("both"), dwellScript);
  assert(
    fwd.length === 1 && both.length === 1 && fwd[0].landsAt === both[0].landsAt,
    `fwd=${JSON.stringify(fwd)} both=${JSON.stringify(both)}`,
  );
});

// The Opus Tailscale blind spot (.data/ab/opus-gendir/Composition.tsx): every
// section binds copy via `const c = script.scenes[N].content` + `{c.lede}`, so
// the literal word count was 0, readTime collapsed to the 1.2s floor, and
// three provably-late ledes shipped unflagged. Real timings + copy, condensed.
const opusScenes = {
  scenes: [
    { start_seconds: 0, end_seconds: 5.5, content: { headline: "Config hell", lede: "Traditional VPNs trap you in firewall rules, subnet conflicts, and hours of maintenance." } },
    { start_seconds: 5.5, end_seconds: 11.5, content: { headline: "Zero-config mesh network", lede: "Connect your devices, servers, and team in minutes — no firewall changes, no subnet planning." } },
    { start_seconds: 11.5, end_seconds: 18.5, content: { headline: "Access that just works", lede: "Identity-based security with direct access to SSH, K8s, databases, and more." } },
    { start_seconds: 18.5, end_seconds: 24.5, content: { headline: "30,000", lede: "From startups to enterprises — Instacart, Duolingo, and thousands more." } },
  ],
};
const opusSection = (i: number, ledeDelay: number) => `
export const Section${i} = ({ script }) => {
  const c = script.scenes[${i}].content;
  return (<div>
    <h1 style={{ fontSize: 132, opacity: 0, animation: "fadeRise 0.4s ease-out 0.2s forwards" }}>{c.headline}</h1>
    <p style={{ fontSize: 26, opacity: 0, animation: "fadeRise 0.5s ease-out ${ledeDelay}s forwards" }}>{c.lede}</p>
  </div>);
};`;

check("resolves expression-bound ledes through the section's content alias (Opus blind spot)", () => {
  // Ledes land at 4.0 / 4.4 / 1.7 / 3.5s; resolved read times 3.9 / 4.2 /
  // 3.3 / 2.7s → sections 0, 1, 3 overrun their scenes, section 2 fits.
  const code = [opusSection(0, 3.5), opusSection(1, 3.9), opusSection(2, 1.2), opusSection(3, 3.0)].join("\n");
  const r = findUndwelledText(code, opusScenes);
  assert(
    r.length === 3 && r.every((u) => u.tag === "p") &&
      JSON.stringify(r.map((u) => u.section)) === "[0,1,3]",
    `expected sections [0,1,3], got ${JSON.stringify(r)}`,
  );
  // 13-word lede → 3.9s, NOT the 1.2s floor (the word count actually resolved).
  assert(r[0].readTime === 3.9, `expected readTime 3.9, got ${r[0].readTime}`);
});

check("literal lede landing with ~0.1s margin still passes (the Fable pattern)", () => {
  // .data/ab/fable-gendir scene 0: 13 literal words → 3.9s read, lands at
  // 1.5s of a 5.5s scene → 5.4 ≤ 5.5. The margin must not erode.
  const code = `export const Section0 = () => (<div>
    <p style={{ fontSize: 26, opacity: 0, animation: "fadeRise 0.5s ease-out 1.0s forwards" }}>Traditional VPNs trap you in firewall rules, subnet conflicts, and hours of maintenance.</p>
  </div>);`;
  assert(findUndwelledText(code, opusScenes).length === 0, "0.1s-margin literal lede flagged");
});

check("unresolvable expression falls back to the 1.2s floor (no flag)", () => {
  // Same late beat as the Opus scene-0 lede; the binding can't be resolved,
  // so 4.0 + 1.2 = 5.2 ≤ 5.5 — false-negative direction preserved.
  const code = `export const Section0 = ({ script }) => (<div>
    <p style={{ fontSize: 26, opacity: 0, animation: "fadeRise 0.5s ease-out 3.5s forwards" }}>{someUnknownVar}</p>
  </div>);`;
  assert(findUndwelledText(code, opusScenes).length === 0, "unresolved expression flagged");
});

check("direct script.scenes[N].content access and non-'c' aliases both resolve", () => {
  const code = `
export const Section0 = ({ script }) => (<div>
  <p style={{ fontSize: 26, opacity: 0, animation: "fadeRise 0.5s ease-out 3.5s forwards" }}>{script.scenes[0].content.lede}</p>
</div>);
export const Section1 = ({ script }) => {
  const copy = script.scenes[1].content;
  return (<p style={{ fontSize: 26, opacity: 0, animation: "fadeRise 0.5s ease-out 3.9s forwards" }}>{copy.lede}</p>);
};`;
  const r = findUndwelledText(code, opusScenes);
  assert(
    r.length === 2 && r[0].section === 0 && r[1].section === 1,
    `got ${JSON.stringify(r)}`,
  );
});

// ── Scene review #3: accent-as-decoration (countAccentBorders) ────────────────
const SIG = "#00C28A";
const accentCard = (i: number) =>
  `<div style={{ border: "1.5px solid #00c28a", borderRadius: 12, padding: 24 }}>card ${i}</div>`;

check("flags 6 identical accent-bordered cards in one section", () => {
  const code = `export const Section0 = () => (<div>${[1, 2, 3, 4, 5, 6].map(accentCard).join("\n")}</div>);`;
  const r = countAccentBorders(code, SIG);
  assert(r.length === 1 && r[0].section === 0 && r[0].count === 6, `got ${JSON.stringify(r)}`);
});

check("4 accent borders per section is allowed (the focal-element budget)", () => {
  const code = `export const Section0 = () => (<div>${[1, 2, 3, 4].map(accentCard).join("\n")}</div>);`;
  assert(countAccentBorders(code, SIG).length === 0, "within-cap section flagged");
});

check("accent borders spread across sections don't flag", () => {
  const code = `
export const Section0 = () => (<div>${[1, 2, 3].map(accentCard).join("")}</div>);
export const Section1 = () => (<div>${[4, 5, 6].map(accentCard).join("")}</div>);`;
  assert(countAccentBorders(code, SIG).length === 0, "spread usage flagged");
});

check("resolves const + palette-entry aliases of the signature hex", () => {
  const code = `
const BRAND_ACCENT = "#00C28A";
const PALETTE = { primary: "#0a0a0a", accent: "#00C28A" };
export const Section0 = () => (<div>
  <div style={{ border: \`1px solid \${BRAND_ACCENT}\` }} />
  <div style={{ border: \`1px solid \${BRAND_ACCENT}\` }} />
  <div style={{ borderColor: PALETTE.accent, borderWidth: 1 }} />
  <div style={{ borderTop: "2px solid #00c28a" }} />
  <div style={{ border: "1px solid #00C28A" }} />
</div>);`;
  const r = countAccentBorders(code, SIG);
  assert(r.length === 1 && r[0].count === 5, `got ${JSON.stringify(r)}`);
});

check("non-signature borders are not counted", () => {
  const neutral = `<div style={{ border: "1px solid rgba(255,255,255,0.12)" }} />`.repeat(6);
  const code = `export const Section0 = () => (<div>${neutral}</div>);`;
  assert(countAccentBorders(code, SIG).length === 0, "neutral hairlines counted");
});

check("signature used as fill/text (not border) is not counted", () => {
  const fills = `<div style={{ background: "#00c28a", color: "#fff" }}>x</div>`.repeat(6);
  const code = `export const Section0 = () => (<div>${fills}</div>);`;
  assert(countAccentBorders(code, SIG).length === 0, "fills counted as borders");
});

check("missing / null signature → no findings", () => {
  const code = `export const Section0 = () => (<div>${accentCard(1).repeat(6)}</div>);`;
  assert(countAccentBorders(code, null).length === 0, "null signature flagged");
  assert(countAccentBorders(code, undefined).length === 0, "undefined signature flagged");
  assert(countAccentBorders(code, "teal").length === 0, "non-hex signature flagged");
});

// ── Copy-binding contract (findUnboundCopy) ──────────────────────────────────
// The A/B pair this gate exists for: the Opus build binds all copy
// ({c.headline} from const c = script.scenes[N].content); the Fable build
// bakes every field as literal JSX, including a two-tone "30," + "000" split.
const copyScenes = [
  {
    content: {
      eyebrow: "the old way",
      headline: "Config hell",
      lede: "Traditional VPNs trap you in firewall rules.",
      bullets: ["No bastions required", "Direct access to infra"],
      cta: { primary: "Start free", secondary: "Go" },
    },
  },
];

check("literal headline in the scene's section flags", () => {
  const code = `export const Section0 = () => (<div><h1>Config hell</h1></div>);`;
  const r = findUnboundCopy(code, copyScenes);
  assert(
    r.some((u) => u.scene === 0 && u.field === "headline"),
    `expected headline flag, got ${JSON.stringify(r)}`,
  );
});

check("bound {c.headline} passes", () => {
  const code = `export const Section0 = ({ script }) => {
  const c = script.scenes[0].content;
  return (<div><h1>{c.headline}</h1><p>{c.lede}</p></div>);
};`;
  assert(findUnboundCopy(code, copyScenes).length === 0, "bound copy flagged");
});

check("split two-tone spans flag via concatenation (the '30,'+'000' treatment)", () => {
  const code = `export const Section0 = () => (<h1>
    <span style={{ color: "#fff" }}>30,</span>
    <span style={{ color: "rgba(252,252,252,0.5)" }}>000</span>
  </h1>);`;
  const r = findUnboundCopy(code, [{ content: { headline: "30,000" } }]);
  assert(
    r.length === 1 && r[0].field === "headline",
    `expected the split headline flag, got ${JSON.stringify(r)}`,
  );
});

check("copy text only in a comment passes (the Opus :1049 trap)", () => {
  const code = `export const Section0 = ({ script }) => {
  const c = script.scenes[0].content;
  // hero pill reuses the headline: "Config hell"
  return (<div>
    {/* hero headline = cta.primary "Start free" */}
    <h1>{c.headline}</h1><button>{c.cta.primary}</button>
  </div>);
};`;
  assert(findUnboundCopy(code, copyScenes).length === 0, "comment quote flagged");
});

check("uppercase literal of a lowercase eyebrow flags (case-insensitive)", () => {
  const code = `export const Section0 = () => (<div><h6>THE OLD WAY</h6></div>);`;
  const r = findUnboundCopy(code, copyScenes);
  assert(
    r.some((u) => u.field === "eyebrow"),
    `re-cased literal must flag, got ${JSON.stringify(r)}`,
  );
});

check("eyebrow baked as a string ATTRIBUTE flags (the Fable <Eyebrow text=…> form)", () => {
  const code = `export const Section0 = () => (<div><Eyebrow text="THE OLD WAY" centered /></div>);`;
  const r = findUnboundCopy(code, copyScenes);
  assert(
    r.some((u) => u.field === "eyebrow"),
    `attribute-baked copy must flag, got ${JSON.stringify(r)}`,
  );
});

check("invented diegetic mockup labels never flag", () => {
  const code = `export const Section0 = ({ script }) => {
  const c = script.scenes[0].content;
  return (<div>
    <div>STATUS: DEGRADED</div>
    <div>tailscale.com — status</div>
    <h1>{c.headline}</h1>
  </div>);
};`;
  assert(findUnboundCopy(code, copyScenes).length === 0, "diegetic label flagged");
});

check("chrome attr CONTAINING a bound field's value passes (whole-value attr match)", () => {
  // Archived Vercel build: headline "Deployed" bound, BrandChrome carries an
  // invented category="Deployed · Live" — a chrome label, not a retype.
  const code = `export const Section0 = ({ script }) => {
  const c = script.scenes[0].content;
  return (<div>
    <BrandChrome sceneIndex={0} category="Config hell · Live" />
    <h1>{c.headline}</h1>
  </div>);
};`;
  assert(findUnboundCopy(code, copyScenes).length === 0, "containing attr flagged");
});

check("attr EQUAL to a field's value still flags (fused, re-cased)", () => {
  const code = `export const Section0 = ({ script }) => {
  const c = script.scenes[0].content;
  return (<div>
    <BrandChrome sceneIndex={0} category="Config Hell" />
    <h1>{c.headline}</h1>
  </div>);
};`;
  const r = findUnboundCopy(code, copyScenes);
  assert(
    r.some((u) => u.field === "headline"),
    `whole-value attr retype must flag, got ${JSON.stringify(r)}`,
  );
});

check("bullets bound via {b} in a map pass; literal bullets flag", () => {
  const bound = `export const Section0 = ({ script }) => {
  const c = script.scenes[0].content;
  return (<ul>{c.bullets.map((b, i) => (<li key={i}>{b}</li>))}</ul>);
};`;
  assert(findUnboundCopy(bound, copyScenes).length === 0, "bound bullets flagged");
  const literal = `export const Section0 = () => (<ul>
    <li>No bastions required</li>
    <li>Direct access to infra</li>
  </ul>);`;
  const r = findUnboundCopy(literal, copyScenes);
  assert(
    r.some((u) => u.field === "bullets[0]") && r.some((u) => u.field === "bullets[1]"),
    `literal bullets must flag, got ${JSON.stringify(r)}`,
  );
});

check("fields shorter than 4 chars are skipped (cta 'Go')", () => {
  const code = `export const Section0 = () => (<button>Go</button>);`;
  assert(findUnboundCopy(code, copyScenes).length === 0, "short field flagged");
});

check("scene with no content fields → no findings", () => {
  const code = `export const Section0 = () => (<h1>Anything at all</h1>);`;
  assert(findUnboundCopy(code, [{ content: {} }]).length === 0, "empty content flagged");
  assert(findUnboundCopy(code, [{}]).length === 0, "missing content flagged");
});

check("dropped/transformed copy is out of scope (neither bound nor literal)", () => {
  const code = `export const Section0 = () => (<h1>A different paraphrase</h1>);`;
  assert(
    findUnboundCopy(code, [{ content: { headline: "Config hell" } }]).length === 0,
    "absent field flagged",
  );
});

// REAL-specimen smoke tests against the archived A/B builds (stable fixtures
// under .data/ab; .data is gitignored, so skip cleanly when absent).
const abScriptPath = join(process.cwd(), ".data/scripts/01KTVZE8P6A371SS8AR9W8C4DA.json");
const opusCompPath = join(process.cwd(), ".data/ab/opus-gendir/Composition.tsx");
const fableCompPath = join(process.cwd(), ".data/ab/fable-gendir/Composition.tsx");
if ([abScriptPath, opusCompPath, fableCompPath].every((p) => existsSync(p))) {
  const abScenes = (
    JSON.parse(readFileSync(abScriptPath, "utf8")) as { scenes: { content?: unknown }[] }
  ).scenes;
  check("REAL specimen — the compliant Opus build has zero findings", () => {
    const r = findUnboundCopy(readFileSync(opusCompPath, "utf8"), abScenes);
    assert(r.length === 0, `false positive(s) on the compliant build: ${JSON.stringify(r)}`);
  });
  check("REAL specimen — the baked Fable build flags every copy field", () => {
    const r = findUnboundCopy(readFileSync(fableCompPath, "utf8"), abScenes);
    assert(
      r.length >= 15,
      `expected the baked build heavily flagged, got ${r.length}: ${JSON.stringify(
        r.map((u) => `${u.scene}.${u.field}`),
      )}`,
    );
  });
} else {
  console.log("  - skipped REAL-specimen smoke tests (.data/ab fixtures not present)");
}

// addMissingLucideImports — the deterministic fix for valid lucide icons used
// but not imported (the Coinbase "BadgeCheck is not defined" build-killer). A
// mock validator stands in for the 5,800-icon module.
const isMockIcon = (n: string) => ["BadgeCheck", "ShieldCheck", "Zap"].includes(n);
check("auto-imports a valid lucide icon used but not imported", () => {
  const code = `import { Zap } from "lucide-react";\nexport const S = () => <div><Zap/><BadgeCheck/></div>;`;
  const r = addMissingLucideImports(code, isMockIcon);
  assert(r.added.includes("BadgeCheck"), `expected BadgeCheck added, got ${JSON.stringify(r.added)}`);
  assert(/import\s*\{[^}]*\bBadgeCheck\b[^}]*\bZap\b|import\s*\{[^}]*\bZap\b[^}]*\bBadgeCheck\b/.test(r.code), "BadgeCheck spliced into the existing lucide import");
});
check("leaves invented / non-lucide components untouched", () => {
  const code = `export const S = () => <div><OrbitCursors/><BadgeCheck/></div>;`;
  const r = addMissingLucideImports(code, isMockIcon);
  assert(r.added.length === 1 && r.added[0] === "BadgeCheck", `only the valid icon, got ${JSON.stringify(r.added)}`);
  assert(!r.code.includes("OrbitCursors }") && !/OrbitCursors.*lucide/.test(r.code), "invented OrbitCursors not imported");
});
check("creates a lucide import when none exists", () => {
  const code = `import React from "react";\nexport const S = () => <ShieldCheck/>;`;
  const r = addMissingLucideImports(code, isMockIcon);
  assert(/import\s*\{\s*ShieldCheck\s*\}\s*from\s*["']lucide-react["']/.test(r.code), "new lucide import created");
});
check("no-op when nothing is missing", () => {
  const code = `import { Zap } from "lucide-react";\nexport const S = () => <Zap/>;`;
  const r = addMissingLucideImports(code, isMockIcon);
  assert(r.added.length === 0 && r.code === code, "unchanged when all icons resolve");
});

// ── throughline presence: counts BOTH attr forms ─────────────────────
// Validation 2026-07-09: parallel fills emit data-throughline={THROUGHLINE_SLUG}
// (a JSX expression referencing a scaffold const); the literal-only regex
// reported tagged:0 on a build whose every real scene carried the motif.
check("assessThroughlinePresence: JSX-expression form counts (const identifier)", () => {
  const script = { narrative: { throughline: "a ticket travels" }, scenes: [{}, {}, {}, {}, {}] };
  const code = Array.from({ length: 4 }, () => `<div data-throughline={THROUGHLINE_SLUG} style={{}} />`).join("\n");
  const r = assessThroughlinePresence(code, script);
  assert(r === null, `4/5 const-identifier tags should clear the bar, got ${JSON.stringify(r)}`);
});

check("assessThroughlinePresence: quoted + template-in-braces forms still count", () => {
  const script = { narrative: { throughline: "a ticket travels" }, scenes: [{}, {}, {}] };
  const code = [
    `<div data-throughline="order-ticket" />`,
    "<div data-throughline={`order-ticket`} />",
  ].join("\n");
  const r = assessThroughlinePresence(code, script);
  assert(r === null, `mixed quoted+template forms (2/3, bar 2) should pass, got ${JSON.stringify(r)}`);
});

check("assessThroughlinePresence: still fires when the motif is genuinely absent", () => {
  const script = { narrative: { throughline: "a ticket travels" }, scenes: [{}, {}, {}, {}, {}] };
  const r = assessThroughlinePresence(`<div data-throughline="x" />`, script);
  assert(r !== null && r.tagged === 1, `1/5 must still fire, got ${JSON.stringify(r)}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
