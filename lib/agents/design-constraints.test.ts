/**
 * Tests for the Design Agent machine contract (CONSTRAINTS block).
 *
 * Run: `npm test`. The load-bearing check: every icon in ALLOWED_LUCIDE_ICONS
 * must be a REAL export of the installed lucide-react — the whole point of the
 * allowlist is that it can never drift into hallucination territory. No API
 * key, no network.
 */
import { createRequire } from "module";
import { join } from "path";
import { ALLOWED_LUCIDE_ICONS, buildDesignConstraints } from "./design-constraints";

const nodeRequire = createRequire(join(process.cwd(), "package.json"));
const lucide: Record<string, unknown> = nodeRequire("lucide-react");

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

check("every allowed icon is a real lucide-react export", () => {
  const missing = ALLOWED_LUCIDE_ICONS.filter((n) => !(n in lucide));
  assert(missing.length === 0, `not in lucide-react: ${missing.join(", ")}`);
});

check("the filler icons the gate flags are NOT in the allowlist", () => {
  assert(
    !ALLOWED_LUCIDE_ICONS.includes("Sparkles" as never) &&
      !ALLOWED_LUCIDE_ICONS.includes("Sparkle" as never),
    "Sparkles/Sparkle would contradict findDecorativeFillerIcons",
  );
});

check("no brand-logo names in the allowlist", () => {
  const brands = ["Slack", "Github", "Figma", "Twitter", "Chrome", "Framer"];
  const hits = ALLOWED_LUCIDE_ICONS.filter((n) => brands.includes(n));
  assert(hits.length === 0, `brand names present: ${hits.join(", ")}`);
});

check("16:9 constraints carry the right canvas numbers + logo trust path", () => {
  const s = buildDesignConstraints("16:9", { hasLogo: true });
  assert(s.includes("1920x1080"), "canvas dims");
  assert(s.includes("1760"), "safe width");
  assert(s.includes("showCornerLogo={false}"), "suppression pattern");
  assert(s.includes("LOGO_SRC"), "LOGO_SRC contract");
  assert(s.includes('import { BrandChrome } from "./BrandChrome"'), "provided import");
});

check("9:16 uses the vertical safe width", () => {
  const s = buildDesignConstraints("9:16", { hasLogo: true });
  assert(s.includes("1080x1920") && s.includes("920"), "vertical canvas + safe width");
});

check("wide-lockup logos get the omit-wordmark rule (real-logo contract only)", () => {
  const s = buildDesignConstraints("16:9", { hasLogo: true });
  assert(s.includes("wide-lockup logo"), "lockup row present");
  assert(/OMIT the wordmark prop/.test(s), "omit-wordmark instruction");
  assert(s.includes("2.5:1"), "ratio stated so the agent can judge the asset");
  const noLogo = buildDesignConstraints("16:9", { hasLogo: false });
  assert(!/OMIT the wordmark prop/.test(noLogo), "no lockup row without a logo");
});

check("no-logo brands get the wordmark-only contract", () => {
  const s = buildDesignConstraints("16:9", { hasLogo: false });
  assert(s.includes("WORDMARK TEXT"), "wordmark contract");
  assert(!s.includes("hero <Img src={LOGO_SRC}"), "no hero-logo row without a logo");
});

// ── Scene-review taste rules (2026-06) — the contract must state what the
// new gates check, so first-pass output can simply not violate them.
check("text-size floors are stated (and match the detector's numbers)", () => {
  const s = buildDesignConstraints("16:9", { hasLogo: true });
  assert(s.includes("TEXT FLOORS"), "floors block present");
  assert(s.includes("24px") && s.includes("18px"), "p/li floor numbers");
  assert(s.includes("0.12em"), "caption-chrome exemption stated");
});

check("accent discipline states the per-section border cap", () => {
  const s = buildDesignConstraints("16:9", { hasLogo: true });
  assert(s.includes("ACCENT DISCIPLINE"), "accent block present");
  assert(/AT MOST 4 elements per section/i.test(s), "cap of 4 stated");
  assert(/focal element/i.test(s), "focal-element framing");
});

check("text dwell states the reading-time formula", () => {
  const s = buildDesignConstraints("16:9", { hasLogo: true });
  assert(s.includes("TEXT DWELL"), "dwell block present");
  assert(s.includes("max(1.2s, words × 0.3s)"), "read-time formula");
});

check("the taste contract carries all four judgment rules", () => {
  const s = buildDesignConstraints("16:9", { hasLogo: true });
  assert(s.includes("TASTE CONTRACT"), "taste block present");
  assert(/ONE must be featured/i.test(s), "featured-card rule");
  assert(/mostly-empty box/i.test(s), "empty-card rule");
  assert(/must NOT repeat the headline/i.test(s), "CTA-duplication rule");
  assert(/axis\/label context/i.test(s), "chart-context rule");
});

check("copy binding states the contract (and matches findUnboundCopy)", () => {
  const s = buildDesignConstraints("16:9", { hasLogo: true });
  assert(s.includes("COPY BINDING"), "binding block present");
  assert(s.includes("script.scenes[N].content"), "binding pattern stated");
  assert(/Retyping a field's text as literal JSX is REJECTED/.test(s), "rejection stated");
  assert(/split and re-cased fragments/.test(s), "split/re-case coverage stated");
  assert(/diegetic labels[\s\S]*are fine/i.test(s), "diegetic-label allowance");
});

check("taste lines are aspect-independent (9:16 carries them too)", () => {
  const s = buildDesignConstraints("9:16", { hasLogo: false });
  assert(
    s.includes("TEXT FLOORS") &&
      s.includes("ACCENT DISCIPLINE") &&
      s.includes("TEXT DWELL") &&
      s.includes("TASTE CONTRACT"),
    "all four blocks present on the vertical canvas",
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
