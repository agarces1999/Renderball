/**
 * Tests for the DETERMINISTIC VOID FURNISH (P3-C3 void convergence). The panel
 * builder must emit self-contained, brand-consistent JSX; the surface must
 * CONTRAST the canvas both ways (light + dark) and never be a saturated accent;
 * the band→rect mapping and Section injection must land in the right place.
 * Run: `npm test`.
 */
import {
  buildFurnishPanelJsx,
  injectFurnishIntoSection,
  furnishRectForBand,
  furnishRectForRowBand,
  pickFurnishSurface,
  pickElevatedSurface,
  pairValueRows,
  parseHex,
  relLuminance,
  textOnSurface,
  hairlineOnSurface,
} from "./void-furnish";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : err}`); }
};
const assert = (cond: boolean, msg: string) => { if (!cond) throw new Error(msg); };

const CANVAS_169 = { w: 1920, h: 1080 };

// ── color helpers ────────────────────────────────────────────────────────────

check("parseHex handles #rgb and #rrggbb, rejects junk", () => {
  assert(JSON.stringify(parseHex("#fff")) === "[255,255,255]", "#fff");
  assert(JSON.stringify(parseHex("#16181d")) === "[22,24,29]", "#16181d");
  assert(parseHex("nope") === null, "junk → null");
});

check("relLuminance: white bright, black dark", () => {
  assert(relLuminance("#ffffff") > 0.9, "white ~1");
  assert(relLuminance("#000000") < 0.1, "black ~0");
});

check("textOnSurface + hairlineOnSurface flip with surface luminance", () => {
  assert(textOnSurface("#16181d") === "#f4f4f6", "dark surface → light text");
  assert(textOnSurface("#f4f4f6") === "#16181d", "light surface → dark text");
  assert(/255,255,255/.test(hairlineOnSurface("#16181d")), "dark surface → light hairline");
  assert(/0,0,0/.test(hairlineOnSurface("#f4f4f6")), "light surface → dark hairline");
});

// ── surface picker (the washout-safety-by-construction guarantee) ─────────────

check("pickFurnishSurface: LIGHT canvas → a DARK surface (contrast)", () => {
  // Deel-shaped: near-white canvas, palette has a dark ink + a purple accent.
  const surface = pickFurnishSurface(["#0f1115", "#a88cf5", "#fefefe"], "#fefefe");
  assert(relLuminance(surface) < 0.4, `expected a dark surface on a white canvas, got ${surface} (lum ${relLuminance(surface).toFixed(2)})`);
});

check("pickFurnishSurface: DARK canvas → a LIGHT surface (contrast)", () => {
  const surface = pickFurnishSurface(["#f5f5f7", "#ff5900", "#15191e"], "#15191e");
  assert(relLuminance(surface) > 0.6, `expected a light surface on a dark canvas, got ${surface}`);
});

check("pickFurnishSurface: never picks a SATURATED accent (chroma guard)", () => {
  // Only the accent contrasts the canvas by luminance, but it is saturated → the
  // computed neutral fallback must win (a flat accent panel would trip accent-fill).
  // R2 (audit-2): the dark-canvas fallback is a MID-elevated DARK card, NEVER
  // stark white (the Mailchimp debug-box).
  const surface = pickFurnishSurface(["#ff5900"], "#101216");
  assert(surface === "#1c1e24", `expected the dark-elevated fallback, got ${surface}`);
});

check("pickFurnishSurface: unparseable palette → computed neutral fallback", () => {
  assert(pickFurnishSurface([], "#ffffff") === "#181a1f", "white canvas → dark card");
  // R2: dark canvas → a mid-elevated DARK card, not a stark-white slab.
  assert(pickFurnishSurface([], "#111111") === "#1c1e24", "dark canvas → dark-elevated card");
});

// ── R2 (audit-2): the shared elevated-surface picker — MID-elevated on dark ─────
check("pickElevatedSurface: DARK brand → a MID-elevated DARK card, NOT the stark-white token", () => {
  // Mailchimp-shaped: near-black canvas, a YELLOW accent (chroma-excluded), a
  // light ink, and a real dark card token. Must pick the dark card, not the ink.
  const mailchimp: Array<[string, string]> = [["CANVAS", "#06040a"], ["ACCENT", "#ffe01b"], ["INK", "#f7f7f2"], ["CARD", "#1c1a12"]];
  const p = pickElevatedSurface("#06040a", mailchimp);
  assert(p !== null && p.name === "CARD", `mid-elevated dark card, got ${JSON.stringify(p)}`);
  assert(relLuminance(p!.hex) < 0.4, `the surface stays a DARK card (not stark white), got ${p!.hex}`);
});

check("pickElevatedSurface: Vanta-shaped plum canvas → the least-distant elevated card, not the lightest", () => {
  const vanta: Array<[string, string]> = [["CANVAS", "#250743"], ["CARD", "#33244a"], ["MUTED", "#68537d"], ["SOFT", "#877697"]];
  const p = pickElevatedSurface("#250743", vanta);
  assert(p !== null && p.name === "CARD", `nearest elevated plum card, got ${JSON.stringify(p)}`);
  assert(p!.name !== "SOFT", "NOT the lightest token — that would be the stark lift");
  assert(relLuminance(p!.hex) < 0.4, `stays a DARK card, got ${p!.hex}`);
});

check("pickElevatedSurface: Fuse-shaped maroon canvas → the elevated maroon card, accent excluded by chroma", () => {
  // ACCENT #ff8c42 (high chroma) is excluded; the near-neutral maroon card wins.
  const fuse: Array<[string, string]> = [["CANVAS", "#440b12"], ["CARD", "#5a2028"], ["ACCENT", "#ff8c42"], ["INK", "#ecf3fb"]];
  const p = pickElevatedSurface("#440b12", fuse);
  assert(p !== null && p.name === "CARD", `elevated maroon card, got ${JSON.stringify(p)}`);
});

check("pickElevatedSurface: LIGHT brand → a solid DARK card (reads on the pale field)", () => {
  const light: Array<[string, string]> = [["CANVAS", "#ffffff"], ["INK", "#0f1115"], ["CARD", "#f2f1ee"], ["ACCENT", "#a88cf5"]];
  const p = pickElevatedSurface("#ffffff", light);
  assert(p !== null && relLuminance(p!.hex) < 0.4, `dark card on a light canvas, got ${JSON.stringify(p)}`);
});

check("pickElevatedSurface: no qualifying low-chroma token → null (caller falls back)", () => {
  // only the canvas + a saturated accent: nothing neutral clears the floor.
  assert(pickElevatedSurface("#101216", [["CANVAS", "#101216"], ["ACCENT", "#ff5900"]]) === null, "no elevated token → null");
});

// ── R3 (audit-2): label:value pairing (no raw token dump) ─────────────────────
check("pairValueRows: a short label followed by a digit value pairs into label:value", () => {
  const rows = pairValueRows(["Opens", "1,247", "Clicks", "342", "A long descriptive clause with no digit"]);
  assert(rows.some((r) => r.label === "Opens" && r.value === "1,247"), `Opens:1,247 paired, got ${JSON.stringify(rows)}`);
  assert(rows.some((r) => r.label === "Clicks" && r.value === "342"), "Clicks:342 paired");
  assert(rows.some((r) => !r.label && /long descriptive/.test(r.value)), "a prose clause stays a standalone row");
});

// ── band → rect mapping ───────────────────────────────────────────────────────

check("furnishRectForBand: a right-half void → a right-half inset rect", () => {
  const rect = furnishRectForBand({ startFracW: 0.5, endFracW: 1.0 }, CANVAS_169);
  assert(rect !== null, "right-half band must be furnishable");
  assert(rect!.x > 950 && rect!.x < 1010, `x inset into the right half, got ${rect!.x}`);
  assert(rect!.x + rect!.w <= 1920, "stays on canvas");
  assert(rect!.h > 600 && rect!.h < 900, `comfortable central height, got ${rect!.h}`);
});

check("furnishRectForBand: a too-thin band → null (not furnishable)", () => {
  assert(furnishRectForBand({ startFracW: 0.48, endFracW: 0.54 }, CANVAS_169) === null, "6% band too thin");
});

check("furnishRectForRowBand: a bottom-third void → a wide bottom-anchored inset rect (Vanta s3)", () => {
  const rect = furnishRectForRowBand({ startFracH: 0.67, endFracH: 1.0 }, CANVAS_169);
  assert(rect !== null, "bottom band must be furnishable");
  assert(rect!.y > 0.67 * 1080 && rect!.y < 0.72 * 1080, `y inset into the bottom band, got ${rect!.y}`);
  assert(rect!.y + rect!.h <= 1080, "stays on canvas");
  assert(rect!.w > 1500 && rect!.w <= 1920, `wide central strip, got ${rect!.w}`);
});

check("furnishRectForRowBand: a too-short band → null (not furnishable)", () => {
  assert(furnishRectForRowBand({ startFracH: 0.9, endFracH: 0.98 }, CANVAS_169) === null, "8%H band too short");
});

// ── the panel JSX ─────────────────────────────────────────────────────────────

const goodOpts = () => ({
  pieceId: "s1.furnish",
  rect: { x: 1000, y: 150, w: 860, h: 780 },
  values: ["Germany · Fixed-term", "Brazil · Contractor", "India · Full-time", "5 of 12 reviews pending"],
  title: "a global onboarding tracker",
  surfaceHex: "#16181d",
  accentHex: "#a88cf5",
  fontDisplay: "BagossFont",
  fontBody: "InterFont",
});

check("buildFurnishPanelJsx: carries data-piece/data-kind + is positioned in the rect", () => {
  const jsx = buildFurnishPanelJsx(goodOpts());
  assert(jsx.includes('data-piece="s1.furnish"'), "data-piece present");
  assert(jsx.includes('data-kind="diegetic"'), "data-kind present");
  assert(/left: 1000/.test(jsx) && /top: 150/.test(jsx) && /width: 860/.test(jsx) && /height: 780/.test(jsx), "positioned literally in the rect");
  assert(/position: "absolute"/.test(jsx), "absolutely positioned");
});

check("buildFurnishPanelJsx: renders the blueprint values verbatim + the title", () => {
  const jsx = buildFurnishPanelJsx(goodOpts());
  for (const v of ["Germany · Fixed-term", "5 of 12 reviews pending"]) assert(jsx.includes(v), `value ${v} rendered`);
  assert(jsx.includes("a global onboarding tracker"), "title rendered");
});

check("buildFurnishPanelJsx: self-contained — literal colors/fonts, no bare const refs", () => {
  const jsx = buildFurnishPanelJsx(goodOpts());
  assert(jsx.includes('"#16181d"') || jsx.includes("#16181d"), "surface literal");
  assert(jsx.includes('"#a88cf5"'), "accent literal");
  assert(jsx.includes('"BagossFont"') && jsx.includes('"InterFont"'), "fonts as literals");
  // No reference to emitted consts (INK/ACCENT/FONT_BODY) that might be absent
  // wherever the panel is injected.
  assert(!/background: (INK|ACCENT|CANVAS|FONT_BODY)\b/.test(jsx), "no bare emitted-const refs");
});

check("buildFurnishPanelJsx: empty values → empty string (caller flags residual)", () => {
  assert(buildFurnishPanelJsx({ ...goodOpts(), values: [] }) === "", "no values → no panel");
  assert(buildFurnishPanelJsx({ ...goodOpts(), values: ["a"] }) === "", "one 1-char value drops below min");
});

check("buildFurnishPanelJsx: JSX-unsafe chars are stripped from values/title", () => {
  const jsx = buildFurnishPanelJsx({ ...goodOpts(), values: ["a <script> b", "clean value here"], title: "t<>{}itle" });
  assert(!/<script>/.test(jsx), "angle brackets stripped from values");
  assert(!/t<>\{\}itle/.test(jsx), "unsafe title chars stripped");
});

// ── injection into the assembled composition ─────────────────────────────────

const fakeSection = (n: number) =>
  `export const Section${n} = ({ script }) => {\n` +
  `  return (\n` +
  `    <div style={{ position: "absolute", inset: 0 }}>\n` +
  `      <Piece id="s${n}.hero" kind="diegetic"><div data-piece="s${n}.hero" /></Piece>\n` +
  `      <Chrome sceneIndex={${n}} totalScenes={5} />\n` +
  `    </div>\n` +
  `  );\n};\n`;

check("injectFurnishIntoSection: inserts the panel just before <Chrome sceneIndex={N}", () => {
  const code = fakeSection(1) + fakeSection(2);
  const panel = buildFurnishPanelJsx({ ...goodOpts(), pieceId: "s1.furnish" });
  const out = injectFurnishIntoSection(code, 1, panel);
  assert(out.injected, "injection reported success");
  const furnishAt = out.code.indexOf('data-piece="s1.furnish"');
  const chrome1At = out.code.indexOf("<Chrome sceneIndex={1}");
  assert(furnishAt !== -1 && furnishAt < chrome1At, "furnish sits before its section's Chrome");
  // it targeted scene 1, not scene 2
  assert((out.code.match(/data-piece="s1\.furnish"/g) || []).length === 1, "exactly one furnish injected");
  assert(out.code.indexOf('data-piece="s2.furnish"') === -1, "scene 2 untouched");
});

check("injectFurnishIntoSection: missing section anchor → untouched, injected:false", () => {
  const code = fakeSection(1);
  const out = injectFurnishIntoSection(code, 9, buildFurnishPanelJsx(goodOpts()));
  assert(!out.injected && out.code === code, "no anchor → no change (residual flagged by caller)");
});

check("injectFurnishIntoSection: empty panel (no values) → untouched", () => {
  const code = fakeSection(1);
  const out = injectFurnishIntoSection(code, 1, "");
  assert(!out.injected && out.code === code, "empty panel is a no-op");
});

if (failed > 0) {
  console.error(`\nvoid-furnish: ${failed} failed, ${passed} passed`);
  process.exitCode = 1;
} else {
  console.log(`\nvoid-furnish: all ${passed} passed`);
}
