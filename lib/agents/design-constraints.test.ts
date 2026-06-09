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

check("no-logo brands get the wordmark-only contract", () => {
  const s = buildDesignConstraints("16:9", { hasLogo: false });
  assert(s.includes("WORDMARK TEXT"), "wordmark contract");
  assert(!s.includes("hero <Img src={LOGO_SRC}"), "no hero-logo row without a logo");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
