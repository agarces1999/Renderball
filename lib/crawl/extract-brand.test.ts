/**
 * R1 (audit-2): extractCssCanvasBackground — the DETERMINISTIC CSS canvas reader.
 *
 * With vision OFF (no z.ai) `background_color` was left undefined and
 * resolveCanvasPlan fell to a dark-biased palette path, so LIGHT brands
 * (Faire / Mailchimp) shipped DARK. This reader resolves the page canvas straight
 * from the concatenated stylesheet — the background(-color) declared on the root
 * layout selectors, resolving var(--x), first opaque color wins. No network.
 * Run: `npm test`.
 */
import { extractCssCanvasBackground } from "./extract-brand";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : err}`); }
};
const assert = (cond: boolean, msg: string) => { if (!cond) throw new Error(msg); };

check("a light brand: body{background:#fff} → the canvas is LIGHT (the Faire/Mailchimp fix)", () => {
  const css = "html,body{margin:0}body{background:#ffffff;color:#111}.hero{background:#0b0e13}";
  assert(extractCssCanvasBackground(css) === "#ffffff", `expected #ffffff, got ${extractCssCanvasBackground(css)}`);
});

check("background-color wins over the background shorthand; body wins over html", () => {
  const css = "html{background:#000}body{background-color:#faf9f7}";
  assert(extractCssCanvasBackground(css) === "#faf9f7", `body background-color wins, got ${extractCssCanvasBackground(css)}`);
});

check("resolves a var(--x) against the :root custom-property table", () => {
  const css = ":root{--bg:#f4f4f6;--ink:#101018}body{background:var(--bg)}";
  assert(extractCssCanvasBackground(css) === "#f4f4f6", `var resolved, got ${extractCssCanvasBackground(css)}`);
});

check("var() fallback is used when the property is undefined", () => {
  const css = "body{background:var(--missing, #efeff2)}";
  assert(extractCssCanvasBackground(css) === "#efeff2", `var fallback, got ${extractCssCanvasBackground(css)}`);
});

check("a genuinely dark brand: body dark hex → dark canvas (not flipped)", () => {
  const css = "body{background:#15191e;color:#f5f5f7}";
  assert(extractCssCanvasBackground(css) === "#15191e", `dark stays dark, got ${extractCssCanvasBackground(css)}`);
});

check("rgb()/rgba() are parsed; a fully-transparent background is skipped", () => {
  assert(extractCssCanvasBackground("body{background:rgb(250,250,252)}") === "#fafafc", "rgb parsed");
  // body transparent → fall through to html's opaque color.
  const css = "body{background:rgba(0,0,0,0)}html{background:#101014}";
  assert(extractCssCanvasBackground(css) === "#101014", `transparent body skipped → html, got ${extractCssCanvasBackground(css)}`);
});

check("the white/black keywords resolve; #__next / #root app roots are read", () => {
  assert(extractCssCanvasBackground("body{background:white}") === "#ffffff", "white keyword");
  assert(extractCssCanvasBackground("#__next{background:#0e0f13}") === "#0e0f13", "#__next root read");
  assert(extractCssCanvasBackground("#root{background-color:#fbfbfd}") === "#fbfbfd", "#root read");
});

check("a compound selector like `body .nav` does NOT count as the canvas", () => {
  const css = "body .nav{background:#ff0000}main{background:#f6f6f8}";
  assert(extractCssCanvasBackground(css) === "#f6f6f8", `compound selector ignored, main wins, got ${extractCssCanvasBackground(css)}`);
});

check("no rooted background declared → undefined (resolveCanvasPlan falls back)", () => {
  assert(extractCssCanvasBackground(".card{background:#fff}.btn{background:#000}") === undefined, "no root bg → undefined");
  assert(extractCssCanvasBackground("") === undefined, "empty css → undefined");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
