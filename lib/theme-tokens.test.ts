/**
 * Design tokens must be usable by every utility that references them.
 *
 * WHY THIS EXISTS: `hairline` was registered under `borderColor` ONLY. So
 * `border-hairline` worked, and `bg-hairline` / `bg-hairline-strong` silently
 * generated no CSS and rendered rgba(0, 0, 0, 0) — a missing 1px rule or an
 * absent dot looks like intentional spacing, so it survives review. It had
 * already swallowed the toolbar separators in EditorShell and LandingEditor,
 * an indicator in AppShell, and every pending step dot in the outline panel.
 *
 * Found by measuring computed styles in a real browser, not by reading code.
 * This test is the cheap guard that keeps it fixed: any token used with a
 * background/text utility must live in `theme.extend.colors`.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import config from "../tailwind.config";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`);
  }
};
const assert = (c: boolean, m: string) => {
  if (!c) throw new Error(m);
};

console.log("theme tokens (utilities must resolve to real CSS)");

type ColorTree = Record<string, unknown>;
const colors = (config.theme?.extend?.colors ?? {}) as ColorTree;

check("hairline is a COLOR, so bg-/text-/border- all resolve", () => {
  const hairline = colors.hairline as Record<string, string> | undefined;
  assert(!!hairline, "theme.extend.colors.hairline is missing — bg-hairline renders transparent");
  assert(
    typeof hairline?.DEFAULT === "string" && hairline.DEFAULT.includes("--hairline"),
    `hairline.DEFAULT must point at the CSS variable, got ${JSON.stringify(hairline?.DEFAULT)}`,
  );
  assert(
    typeof hairline?.strong === "string" && hairline.strong.includes("--hairline-strong"),
    `hairline.strong must point at the CSS variable, got ${JSON.stringify(hairline?.strong)}`,
  );
});

// ── the general rule, enforced against the real source ──────────────────────
const SRC_DIRS = ["app", "components", "src"];
const walk = (dir: string, out: string[] = []): string[] => {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === ".next") continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx?|jsx?)$/.test(full)) out.push(full);
  }
  return out;
};

check("every bg-/text- utility built on a theme token has that token in colors", () => {
  const root = process.cwd();
  const files = SRC_DIRS.flatMap((d) => walk(join(root, d)));
  const known = new Set(Object.keys(colors));
  // Tokens that Tailwind ships itself never need registering.
  const BUILT_IN = new Set([
    "white", "black", "transparent", "current", "inherit", "red", "green", "blue",
    "gray", "slate", "zinc", "neutral", "stone", "amber", "yellow", "orange",
    "lime", "emerald", "teal", "cyan", "sky", "indigo", "violet", "purple",
    "fuchsia", "pink", "rose", "clip", "cover", "contain", "center", "none",
    "auto", "top", "bottom", "left", "right", "repeat", "gradient", "origin",
    "size", "opacity", "blend", "position", "local", "fixed", "scroll", "no",
  ]);
  const offenders: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/\b(?:bg|text)-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\b/g)) {
      const base = m[1].split("-")[0];
      if (BUILT_IN.has(base) || known.has(base)) continue;
      // Arbitrary values (bg-[#fff]) and numeric scales (text-\[13px\]) are fine.
      if (/^\[/.test(m[1]) || /^\d/.test(base)) continue;
      // Only flag tokens that DO exist somewhere in the theme but not in colors
      // — an unknown word is far more likely to be a normal Tailwind utility
      // (text-center, bg-clip) than a broken token.
      const borderColors = (config.theme?.extend?.borderColor ?? {}) as ColorTree;
      if (Object.keys(borderColors).includes(base)) {
        offenders.push(`${f.replace(root + "/", "")}: ${m[0]} — "${base}" is only a borderColor`);
      }
    }
  }
  assert(
    offenders.length === 0,
    `these utilities resolve to nothing:\n      ${offenders.join("\n      ")}`,
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
