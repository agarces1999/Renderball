//
// cycle-9 P1 — text-integrity gate calibration.
//
//  Arm 1 (icon-font-in-a-text-role) MUST fire on the cycle-8 Tony's product-path
//  Composition (swiper-icons led FONT_DISPLAY + FONT_BODY — the exact class the
//  whole gate battery missed) and MUST pass every clean spike text stack.
//  Arm 2 (orphaned copy fragment) fires on lone-char / label-colon / dotted-
//  initials copy nodes and never on real copy, diegetic labels, or numeric stats.
//
import {
  findIconFontTextStacks,
  stripIconFontsFromTextStacks,
  findOrphanedFragments,
  enumeratePieceSpans,
  resolveContentPath,
  findCrossPieceStatDup,
  findBrandMarkDefects,
  assessAccentedGlyphCoverage,
  ensureLatin1Fallback,
} from "./text-integrity";
import { isIconFont } from "./crawl-theme";
import type { SceneMeasurement, MeasuredElement } from "./measure-scene";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("text-integrity (cycle-9 P1)");

// ── isIconFont classifier ────────────────────────────────────────────────────
check("isIconFont: catches icon/symbol families, spares real text fonts", () => {
  for (const f of ["swiper-icons", "FontAwesome", "Font Awesome 6 Free", "Material Icons", "Material Symbols Outlined", "glyphicons-halflings", "ionicons", "dashicons", "icomoon", "feather-icons", "boxicons", "remixicon"])
    assert(isIconFont(f), `${f} should be an icon font`);
  for (const f of ["Chocolate letter", "American typewriter", "Inter", "Cabinet Grotesk", "Geist", "Geist Mono", "Nib Pro", "Proxima Nova", "Helvetica Neue", "system-ui"])
    assert(!isIconFont(f), `${f} is a real text font — must NOT be flagged`);
  assert(!isIconFont(undefined), "undefined → false");
});

// ── arm 1: MUST-FIRE on the cycle-8 archived consts ──────────────────────────
// Verbatim from .data/dogfood/cycle8-tonys/gen/Composition.tsx lines 19-21.
const CYCLE8_CONSTS = `const FONT_DISPLAY = "swiper-icons, Inter, system-ui, sans-serif";
const FONT_BODY = "swiper-icons, Inter, system-ui, sans-serif";
const FONT_MONO = "ui-monospace, \\"SF Mono\\", Menlo, monospace";`;

check("arm1: cycle-8 Tony's consts FIRE on FONT_DISPLAY + FONT_BODY (not FONT_MONO)", () => {
  const findings = findIconFontTextStacks(CYCLE8_CONSTS);
  const sites = findings.map((f) => f.site).sort();
  assert(sites.length === 2, `expected 2 findings, got ${sites.length}: ${sites.join(",")}`);
  assert(sites[0] === "FONT_BODY" && sites[1] === "FONT_DISPLAY", `expected DISPLAY+BODY, got ${sites.join(",")}`);
  assert(findings.every((f) => f.family === "swiper-icons"), "offending family is swiper-icons");
});

check("arm1: strip fixes the cycle-8 consts (copy set in a letterform font after)", () => {
  const { code, stripped } = stripIconFontsFromTextStacks(CYCLE8_CONSTS);
  assert(stripped.length === 2, `stripped 2 stacks, got ${stripped.length}`);
  assert(/const FONT_DISPLAY = "Inter, system-ui, sans-serif";/.test(code), "FONT_DISPLAY now leads with Inter");
  assert(/const FONT_BODY = "Inter, system-ui, sans-serif";/.test(code), "FONT_BODY now leads with Inter");
  assert(findIconFontTextStacks(code).length === 0, "no icon-font stack remains after strip");
});

check("arm1: inline fontFamily literal with an icon primary fires + strips", () => {
  const code = `<div style={{ fontFamily: "swiper-icons, Inter, sans-serif" }}>x</div>`;
  assert(findIconFontTextStacks(code).some((f) => f.site === "inline"), "inline icon fontFamily fires");
  const { code: fixed } = stripIconFontsFromTextStacks(code);
  assert(/fontFamily: "Inter, sans-serif"/.test(fixed), "inline icon family stripped");
});

check("arm1: clean spike stacks pass (no false fire)", () => {
  const clean = [
    `const FONT_DISPLAY = "\\"Nib Pro\\", Georgia, serif";\nconst FONT_BODY = "Inter, system-ui, sans-serif";\nconst FONT_MONO = "ui-monospace, Menlo, monospace";`, // Robinhood-class
    `const FONT_DISPLAY = "\\"Cabinet Grotesk\\", sans-serif";\nconst FONT_BODY = "\\"American typewriter\\", Courier New, monospace";`, // Tony's AFTER the P0 crawl-theme fix
    `<div style={{ fontFamily: FONT_BODY }}>real copy</div>`,
  ];
  for (const c of clean) assert(findIconFontTextStacks(c).length === 0, `clean stack must not fire: ${c.slice(0, 40)}`);
});

// ── arm 2: orphaned copy fragments (measured) ────────────────────────────────
const el = (p: Partial<MeasuredElement>): MeasuredElement => ({
  tag: "div", x: 0, y: 0, w: 40, h: 40, color: "rgb(0,0,0)", bg: "rgba(0,0,0,0)",
  text: "", isImg: false, fontSize: 20, opacity: 1, piece: "s1.copy", pieceKind: "text",
  onOpaqueSurface: false, coveredAtCenter: false, ...p,
});
const scene = (n: number, els: Partial<MeasuredElement>[]): SceneMeasurement => ({
  scene: n, width: 1920, height: 1080, elements: els.map(el), screenshotPath: `/x/s${n}.png`,
});

check("arm2: cycle-8-shaped copy fragments FIRE (lone char / label-colon / dotted initials)", () => {
  const m = scene(1, [
    { piece: "s1.copy", pieceKind: "text", text: "D", fontSize: 46 },        // headline collapsed
    { piece: "s1.copy", pieceKind: "text", text: "T.R.A.T.", fontSize: 15 }, // lede sentence-initials
    { piece: "s1.copy", pieceKind: "text", text: "S:", fontSize: 13.5 },     // bullet label-colon
    { piece: "s1.copy", pieceKind: "text", text: "P :", fontSize: 13.5 },    // spaced variant
  ]);
  const findings = findOrphanedFragments(m);
  assert(findings.length === 4, `expected 4 fragment findings, got ${findings.length}`);
  const forms = findings.map((f) => f.form).sort();
  assert(forms.includes("lone-char") && forms.includes("dotted-initials") && forms.includes("label-colon"), `forms: ${forms.join(",")}`);
});

check("arm2: real full copy PASSES (no false fire)", () => {
  const m = scene(1, [
    { text: "Decades of looking away", fontSize: 46 },
    { text: "The system works because nobody asks. Reports get filed.", fontSize: 15 },
    { text: "Supply reports: filed and forgotten", fontSize: 13.5 },
    { text: "THE INDUSTRY LOOKS AWAY", fontSize: 11 },
    { text: "Looking away is not an accident — it's the system.", fontSize: 11 },
  ]);
  assert(findOrphanedFragments(m).length === 0, "full copy must not fire");
});

check("arm2: diegetic labels + numeric stats + accent punctuation are excluded", () => {
  const m = scene(1, [
    { piece: "s1.hero", pieceKind: "diegetic", text: "S", fontSize: 24 },     // a mock initial — not copy
    { piece: "s1.hero", pieceKind: "diegetic", text: "6 TIER", fontSize: 20 },// stat value
    { piece: "s3.hero", pieceKind: "diegetic", text: "P:", fontSize: 14 },    // mock field label
    { piece: "s1.copy", pieceKind: "text", text: "/", fontSize: 20 },         // accent slash (not alnum)
    { piece: "s1.copy", pieceKind: "text", text: "5", fontSize: 46 },         // lone DIGIT is not a letter
    { piece: "s1.copy", pieceKind: "text", text: "D", fontSize: 9 },          // below the copy font floor
  ]);
  assert(findOrphanedFragments(m).length === 0, "diegetic/numeric/punct/tiny must all be excluded");
});

// ── cycle-10 P1 (arm 3): cross-piece stat dedup + numeric-format drift ────────
//
// Faithful reproduction of the cycle-9 Tailscale s4 defect (verbatim structure
// from .data/dogfood/cycle9-tailscale/gen/Composition.tsx): the hero paints the
// stat as a CSS-counter (--n: 30000 → "30000") + carries aria-label "30,000
// businesses", while the copy column ALSO paints it via {c.meta[0].value} →
// "30,000". Same figure, two pieces, thousands-separator drift. Both the counter
// (::after) and the copy binding are invisible to the measured text layer.
const CYCLE9_S4 = `
<Piece id="s4.atmosphere" kind="atmosphere">
  <div data-piece="s4.atmosphere" data-kind="atmosphere" style={{ background: "radial-gradient(circle, rgba(36,36,36,0.05), transparent)" }} />
</Piece>
<Piece id="s4.hero" kind="diegetic">
  <div data-piece="s4.hero" data-kind="diegetic">
    <style>{\`@keyframes s4_hero_statCounterInt_s4hero { from { --n: 0; } to { --n: 30000; } }
      .stat-int-s4hero { counter-reset: n var(--n); }
      .stat-int-s4hero::after { content: counter(n); }\`}</style>
    <div data-content-path="site.logo" style={{ height: "34px", width: "120px" }}>
      <Img src="https://tailscale.com/static/logo.svg" style={{ height: "100%" }} />
    </div>
    <div data-content-path="stat.primary" style={{ fontFamily: FONT_DISPLAY, fontWeight: 800, fontSize: "118px", color: "#242424" }}>
      <span className="stat-int-s4hero" style={{ fontSize: "inherit" }} aria-label="30,000 businesses" />
    </div>
    <div style={{ fontFamily: FONT_BODY, fontSize: "20px" }}>businesses</div>
  </div>
</Piece>
<Piece id="s4.copy" kind="text">
  <div data-piece="s4.copy" data-kind="text">
    <div data-content-path="logo" style={{ marginTop: "4px" }}>
      <svg width="118" height="22" viewBox="0 0 200 36"><g fill="#000000"><rect x="14" y="2" width="16" height="16" rx="3" /></g><path d="M86 9.5h4.4v16.2H86V9.5z" fill="#000000" /></svg>
    </div>
    <div data-content-path="eyebrow" style={{ fontFamily: FONT_MONO, fontSize: "11px" }}>{c.eyebrow}</div>
    <div data-content-path="meta.0.value" style={{ fontFamily: FONT_DISPLAY, fontSize: "86px", fontWeight: 700, color: "#000000" }}>{c.meta[0].value}</div>
    <div style={{ fontFamily: FONT_BODY, fontSize: "24px" }}>{c.meta[0].label.toLowerCase()}</div>
    <div data-content-path="headline" style={{ fontFamily: FONT_DISPLAY, fontSize: "26px" }}>{c.headline}</div>
  </div>
</Piece>`;
const CYCLE9_SCENES = [
  {}, {}, {}, {},
  { content: { meta: [{ label: "Businesses", value: "30,000" }], eyebrow: "TRUSTED BY 30,000 BUSINESSES", headline: "30,000 businesses choose Tailscale" } },
];

check("arm3 MUST-FIRE: cycle-9 s4 cross-piece stat dup + format drift ('30,000' vs '30000')", () => {
  const dups = findCrossPieceStatDup(CYCLE9_S4, CYCLE9_SCENES);
  assert(dups.length === 1, `one stat-dup finding on s4, got ${JSON.stringify(dups.map((d) => ({ scene: d.scene, forms: d.forms, pieces: d.pieces })))}`);
  const f = dups[0];
  assert(f.scene === 4, `scene 4, got ${f.scene}`);
  assert(f.digits === "30000", `digits 30000, got ${f.digits}`);
  assert(f.duplicated, "duplicated across two pieces");
  assert(f.pieces.includes("s4.hero") && f.pieces.includes("s4.copy"), `both pieces, got ${f.pieces}`);
  assert(f.formatDrift && f.forms.includes("30,000") && f.forms.includes("30000"), `format drift with both forms, got ${JSON.stringify(f.forms)}`);
  assert(f.primaryPiece === "s4.hero" && f.redundantPieces.includes("s4.copy"), "hero kept, copy routed as redundant");
});

check("arm3: a single stat in one piece (clean scene) does NOT fire", () => {
  const clean = `
<Piece id="s1.hero" kind="diegetic">
  <div data-piece="s1.hero" data-kind="diegetic">
    <div data-content-path="stat.value" style={{ fontSize: "120px" }}>{c.stat.value}</div>
  </div>
</Piece>
<Piece id="s1.copy" kind="text">
  <div data-piece="s1.copy" data-kind="text">
    <div data-content-path="headline" style={{ fontSize: "40px" }}>{c.headline}</div>
    <div data-content-path="lede" style={{ fontSize: "18px" }}>{c.lede}</div>
  </div>
</Piece>`;
  const scenes = [{}, { content: { stat: { value: "940 Mbps" }, headline: "It just works", lede: "Secure mesh in minutes." } }];
  assert(findCrossPieceStatDup(clean, scenes).length === 0, "one stat, one piece → clean");
});

check("arm3 helpers: enumeratePieceSpans + resolveContentPath", () => {
  const spans = enumeratePieceSpans(CYCLE9_S4);
  assert(spans.map((s) => s.id).join(",") === "s4.atmosphere,s4.hero,s4.copy", `spans, got ${spans.map((s) => s.id)}`);
  assert(spans[1].scene === 4 && spans[1].kind === "diegetic", "hero span scene/kind");
  assert(resolveContentPath(CYCLE9_SCENES[4].content, "meta.0.value") === "30,000", "bracket-free path");
  assert(resolveContentPath(CYCLE9_SCENES[4].content, "meta[0].value") === "30,000", "bracket path");
  assert(resolveContentPath(CYCLE9_SCENES[4].content, "nope.x") === undefined, "missing path → undefined");
});

// ── cycle-10 P1 (arm 3b): garbled / duplicate brand mark ─────────────────────

check("arm3b MUST-FIRE: cycle-9 s4 duplicate brand mark (hero lockup + copy garbled SVG)", () => {
  const defects = findBrandMarkDefects(CYCLE9_S4, "Tailscale");
  const dup = defects.filter((d) => d.kind === "duplicate-brand-mark");
  assert(dup.length === 1, `one duplicate-brand-mark on s4, got ${JSON.stringify(defects.map((d) => ({ k: d.kind, s: d.scene, p: d.pieces })))}`);
  assert(dup[0].scene === 4, `scene 4, got ${dup[0].scene}`);
  assert(dup[0].pieces.includes("s4.hero") && dup[0].pieces.includes("s4.copy"), `both marks, got ${dup[0].pieces}`);
  assert(dup[0].pieceId === "s4.copy", `routes the copy (non-hero) mark, got ${dup[0].pieceId}`);
});

check("arm3b MENU-WORD FP (Vanta s1): a spreadsheet menu bar 'Data' is not a garbled 'Vanta'", () => {
  // Vanta s1 shipped a diegetic spreadsheet with a "File Edit View Data Insert
  // Format" menu bar. "Data" is within edit-distance 2 of "Vanta" (a 5-letter
  // brand), so the garble arm false-fired on it. UI-chrome menu words are never
  // scrambled wordmarks.
  const code = `
<Piece id="s1.hero" kind="diegetic">
  <div data-piece="s1.hero" data-kind="diegetic">
    <span>File</span><span>Edit</span><span>View</span><span>Data</span><span>Insert</span><span>Format</span>
  </div>
</Piece>`;
  const d = findBrandMarkDefects(code, "Vanta");
  assert(d.length === 0, `menu words must not garble-fire vs 'Vanta', got ${JSON.stringify(d.map((x) => ({ k: x.kind, t: x.garbledText })))}`);
});

check("arm3b: a GENUINE scramble still fires even for a menu-word-adjacent brand", () => {
  // The exclusion is menu-word-scoped, not brand-scoped: a real scrambled wordmark
  // ("Vnata" for "Vanta") must still be caught.
  const code = `
<Piece id="s1.copy" kind="text">
  <div data-piece="s1.copy" data-kind="text"><span style={{ fontWeight: 700 }}>Vnata</span></div>
</Piece>`;
  const g = findBrandMarkDefects(code, "Vanta").filter((d) => d.kind === "garbled-brand-mark");
  assert(g.length === 1 && g[0].garbledText === "Vnata", `real scramble 'Vnata' still fires, got ${JSON.stringify(g)}`);
});

check("arm3b: garbled text-node wordmark (near-miss spelling) fires", () => {
  const code = `
<Piece id="s0.copy" kind="text">
  <div data-piece="s0.copy" data-kind="text">
    <span style={{ fontWeight: 700 }}>Tialscale</span>
  </div>
</Piece>`;
  const g = findBrandMarkDefects(code, "Tailscale").filter((d) => d.kind === "garbled-brand-mark");
  assert(g.length === 1 && g[0].garbledText === "Tialscale", `garbled 'Tialscale' fires, got ${JSON.stringify(g)}`);
});

check("arm3b FALABELLA-FP: a messy crawl title never makes the CORRECT wordmark read as garbled", () => {
  // The Falabella build's brand title was "falabella.com⚡El Cyber de las Mejores
  // Marcas"; the correct diegetic mentions "Falabella" (AVAILABLE AT Falabella /
  // A Falabella label) must NOT read as a scrambled "falabellacomel".
  const code = `
<Piece id="s0.hero" kind="diegetic">
  <div data-piece="s0.hero" data-kind="diegetic">
    <div data-content-path="site.logo"><Img src="/logo.svg" /></div>
    <span>AVAILABLE AT</span><span>Falabella</span>
    <div>A Falabella label</div>
  </div>
</Piece>`;
  const d = findBrandMarkDefects(code, "falabella.com⚡El Cyber de las Mejores Marcas");
  assert(d.length === 0, `no garble/dup on correct 'Falabella' mentions, got ${JSON.stringify(d.map((x) => ({ k: x.kind, t: x.garbledText })))}`);
});

check("arm3b: a diegetic brand MENTION in a mock is not counted as a duplicate mark", () => {
  // A single logo lockup + the brand named as retail copy ("AVAILABLE AT Falabella")
  // is ONE mark, not two — retailers name themselves in-frame legitimately.
  const code = `
<Piece id="s0.hero" kind="diegetic">
  <div data-piece="s0.hero" data-kind="diegetic">
    <div data-content-path="site.logo"><Img src="/logo.svg" /></div>
  </div>
</Piece>
<Piece id="s0.copy" kind="text">
  <div data-piece="s0.copy" data-kind="text"><span>Falabella</span></div>
</Piece>`;
  assert(findBrandMarkDefects(code, "Falabella").length === 0, "one logo + a mention → not a duplicate");
});

check("arm3b: one brand lockup + exact brand mentions do NOT fire", () => {
  const code = `
<Piece id="s0.hero" kind="diegetic">
  <div data-piece="s0.hero" data-kind="diegetic">
    <div data-content-path="site.logo"><Img src="/logo.svg" /></div>
    <span>login.tailscale.com/admin</span>
  </div>
</Piece>
<Piece id="s0.copy" kind="text">
  <div data-piece="s0.copy" data-kind="text"><div data-content-path="headline">Tailscale for teams</div></div>
</Piece>`;
  const d = findBrandMarkDefects(code, "Tailscale");
  assert(d.length === 0, `single lockup + exact mentions clean, got ${JSON.stringify(d.map((x) => x.kind))}`);
});

// ── cycle-10 P2: Spanish / accented-glyph coverage ───────────────────────────

const SPANISH_COPY = JSON.stringify({ headline: "Diseñado para tí", lede: "Envío rápido, atención en español, más beneficios." });

check("P2: Falabella-shape stack (brand + Inter/sans-serif tail) covers á/é/í/ó/ñ — 0 findings", () => {
  const code = `const FONT_DISPLAY = "Falabella Sans, Inter, system-ui, sans-serif";
const FONT_BODY = "Falabella Text, Inter, system-ui, sans-serif";
const FONT_MONO = "ui-monospace, Menlo, monospace";`;
  const gaps = assessAccentedGlyphCoverage({ code, copyText: SPANISH_COPY });
  assert(gaps.length === 0, `safe fallbacks cover accents, got ${JSON.stringify(gaps.map((g) => ({ s: g.stack, m: g.missingChars })))}`);
});

check("P2 MUST-FIRE: an ASCII-only stack (unicode-range excludes ñ, no generic) drops the diacritic", () => {
  const code = `@font-face { font-family: "AsciiBrand"; src: url("/a.woff2") format("woff2"); unicode-range: U+0000-007F; }
const FONT_DISPLAY = "AsciiBrand";
const FONT_BODY = "AsciiBrand";
const FONT_MONO = "ui-monospace, monospace";`;
  const gaps = assessAccentedGlyphCoverage({ code, copyText: SPANISH_COPY });
  assert(gaps.length >= 1, `ASCII-only stack should drop ñ/á, got ${gaps.length}`);
  assert(gaps.some((g) => g.missingChars.includes("ñ")), `ñ flagged, got ${JSON.stringify(gaps.map((g) => g.missingChars))}`);
  // deterministic repair appends a Latin-1-safe generic → coverage restored
  const fixed = ensureLatin1Fallback(code);
  assert(fixed.appended.some((a) => a.stack === "FONT_DISPLAY"), "FONT_DISPLAY got a fallback appended");
  assert(assessAccentedGlyphCoverage({ code: fixed.code, copyText: SPANISH_COPY }).length === 0, "post-repair: fully covered");
});

check("P2: English copy (no accents) never fires, regardless of stack", () => {
  const code = `@font-face { font-family: "AsciiBrand"; unicode-range: U+0000-007F; }
const FONT_DISPLAY = "AsciiBrand";
const FONT_BODY = "AsciiBrand";
const FONT_MONO = "AsciiBrand";`;
  assert(assessAccentedGlyphCoverage({ code, copyText: JSON.stringify({ h: "Ship it faster" }) }).length === 0, "no accents → no probe findings");
});

check("P2: ensureLatin1Fallback is a no-op when a safe generic is already present", () => {
  const code = `const FONT_DISPLAY = "MDIO, Inter, system-ui, sans-serif";
const FONT_BODY = "Inter, system-ui, sans-serif";
const FONT_MONO = "ui-monospace, Menlo, monospace";`;
  assert(ensureLatin1Fallback(code).appended.length === 0, "safe stacks unchanged");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
