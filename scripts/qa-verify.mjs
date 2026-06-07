// QA-fix verifier — run against one built scriptId. Checks the deterministic
// signals from the C/D/E + B QA batch on the generated Composition + warnings.
// Usage: node scripts/qa-verify.mjs <scriptId> [brandLabel]
import * as esbuild from "esbuild";
import { readFileSync } from "fs";
import { join } from "path";

const sid = process.argv[2];
const label = process.argv[3] || sid;
if (!sid) {
  console.error("usage: node scripts/qa-verify.mjs <scriptId> [label]");
  process.exit(2);
}
const dir = join(process.cwd(), "src", "generated", sid);
const read = (f) => {
  try { return readFileSync(join(dir, f), "utf8"); } catch { return null; }
};

const code = read("Composition.tsx");
if (!code) {
  console.log(`✗ ${label} (${sid}): no Composition.tsx — build did not write (likely ok:false).`);
  process.exit(1);
}
let warnings = {};
try { warnings = JSON.parse(read("warnings.json") || "{}"); } catch {}
let script = {};
try { script = JSON.parse(read("script.json") || "{}"); } catch {}

const checks = [];
const ok = (name, pass, detail = "") =>
  checks.push({ name, pass, detail });

// Compile (the verifyCompilable gate guarantees this when ok:true).
let compiles = false;
try { await esbuild.transform(code, { loader: "tsx", jsx: "automatic", logLevel: "silent" }); compiles = true; } catch (e) {
  ok("compiles", false, String(e.message || e).split("\n").find((l) => /ERROR/.test(l)) || "");
}
if (compiles) ok("compiles", true);

// Logo render (A3): LOGO_SRC injected + referenced.
const logoInjected = /const LOGO_SRC\s*=\s*["'`]/.test(code);
const logoReferenced = code.includes("LOGO_SRC") && (code.match(/LOGO_SRC/g) || []).length > 1;
ok("logo injected + referenced", logoInjected && logoReferenced);

// FONT_DISPLAY present (C2 fidelity gate enforces the right family; warning below catches misses).
const fd = code.match(/FONT_DISPLAY\s*=\s*([^\n;]+)/);
ok("FONT_DISPLAY set", !!fd, fd ? fd[1].trim().slice(0, 40) : "missing");

// Register variety (D3): ≥3 distinct across scenes.
const regs = (script.scenes || []).map((s) => (s.register || "").trim()).filter(Boolean);
const distinct = new Set(regs).size;
ok("register variety ≥3 distinct", (script.scenes || []).length < 3 || distinct >= 3, `${distinct}/${(script.scenes || []).length}`);

// Warning-level gate signals — all of these should be ABSENT on a clean build.
const W = (k) => warnings[k] !== undefined && warnings[k] !== null &&
  (Array.isArray(warnings[k]) ? warnings[k].length > 0 : true);
ok("no severe contrast (B1)", !W("low_contrast_severe"), JSON.stringify(warnings.low_contrast_severe || ""));
ok("no invented claims (E2)", !W("invented_claims"), JSON.stringify(warnings.invented_claims || ""));
ok("no duplicate eyebrow (B3)", !W("duplicate_eyebrow"), JSON.stringify(warnings.duplicate_eyebrow || ""));
ok("no font infidelity (C2)", !W("font_infidelity"), String(warnings.font_infidelity || ""));
ok("register variety not flagged (D3)", !W("low_register_variety"), JSON.stringify(warnings.low_register_variety || ""));
ok("no throughline drift (B4)", !W("throughline_drift"), JSON.stringify(warnings.throughline_drift || ""));
ok("no missing charts (E1)", !W("missing_charts"), JSON.stringify(warnings.missing_charts || ""));
ok("decorative filler icons ≤1 (D4)", (warnings.decorative_icons || 0) <= 1, String(warnings.decorative_icons || 0));
ok("no duplicate logo", !W("duplicate_logo"), String(warnings.duplicate_logo || ""));
ok("no overflow crop", !W("overflow_crop"), JSON.stringify(warnings.overflow_crop || ""));

const failed = checks.filter((c) => !c.pass);
console.log(`\n── ${label} (${sid}) ──`);
for (const c of checks) console.log(`  ${c.pass ? "✓" : "✗"} ${c.name}${c.detail ? `  [${c.detail}]` : ""}`);
console.log(`  palette: ${[...new Set(code.match(/#[0-9a-fA-F]{6}/g) || [])].slice(0, 8).join(" ")}`);
console.log(`  headlines: ${JSON.stringify((script.scenes || []).map((s) => (s.content?.headline || "")).slice(0, 6))}`);
console.log(`  → C1 (signature color leads) + D2 (chrome variety) are VISUAL — eyeball the preview.`);
console.log(`  preview: http://localhost:3000/preview/${sid}`);
console.log(failed.length ? `\n  RESULT: ${failed.length} check(s) failed` : `\n  RESULT: all deterministic checks passed ✓`);
process.exitCode = failed.length ? 1 : 0;
