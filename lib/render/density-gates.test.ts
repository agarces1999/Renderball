//
// Tests for the density gates — the sensors that make "thin" a measurable,
// blocking defect. Two layers:
//
//   1. REAL fixtures: the reference GLM build (01KXEAF0SNT0RR079Z1SJZ1KWZ,
//      reassembled from its lego artifacts) must pass clauses (a)(b)(c) with
//      zero findings, and the thin gpt-oss spike (CAST_SPIKE_FULL_HUBSPOT)
//      must fail every scene on (a), every scene on (b), the video on (c),
//      and scenes 1+3 on (d) — the audit's 5/5 vs 0/5 separation, replayed
//      through the shipped gate.
//
//      KNOWN TRUE POSITIVE: the reference build itself carries ONE latent
//      img-src defect the eyeball audit missed — scene 3 renders
//      `<Img src={siteImg}>` where `siteImg = (script.assets?.images||[])[0]`
//      is an asset OBJECT ({id, src, …}), so the img ships src="[object
//      Object]" (invisible in review: it paints at opacity 0.03). The gate is
//      required to catch exactly that class of defect, so the test pins it as
//      the reference's ONLY finding rather than papering over it.
//
//   2. Synthetic fixtures for the edges: a rich mock passes end-to-end, a
//      borderline 14-descendant mock fails clause (a), data: URIs pass the
//      whitelist, and the parser/signature helpers behave on hand-built HTML.
//
import { promises as fs } from "fs";
import path from "path";
import {
  assessDensity,
  renderSectionsForAnalysis,
  parseHtmlStructure,
  pieceStats,
  maxDomDepth,
  gradientSignatures,
  extractGradients,
  imgSrcs,
  assessDiegeticInterior,
  assessDomDepth,
  assessAtmosphereVariety,
  assessImgSrcs,
  countElementDescendants,
  countTextNodes,
  DIEGETIC_MIN_ELEMENTS,
  DIEGETIC_MIN_TEXT_NODES,
  HERO_MIN_ELEMENTS,
  HERO_MIN_TEXT_NODES,
  DEPTH_FLOOR,
  MIN_GRADIENT_SIGNATURES,
  MAX_SCENES_PER_SIGNATURE,
  IMG_SRC_WHITELIST,
  type DensityFinding,
  type HtmlNode,
} from "./density-gates";
import { readDecomposed } from "../agents/lego-store";
import { reassemble } from "../agents/lego-decompose";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

const ofKind = (fs_: DensityFinding[], kind: DensityFinding["kind"]) =>
  fs_.filter((f) => f.kind === kind);
const scenesOf = (fs_: DensityFinding[]) =>
  [...new Set(fs_.map((f) => f.scene))].sort((a, b) => a - b);

console.log("density-gates");

// ─────────────────────────────────────────────────────────────────────────────
// parser
// ─────────────────────────────────────────────────────────────────────────────

await check("parseHtmlStructure builds the tree: nesting, attrs, void tags, entities", () => {
  const roots = parseHtmlStructure(
    `<div data-piece="s0.mock" data-kind="diegetic" style="background:url(&quot;x&quot;)">` +
      `<span>Hello &amp; welcome</span><img src="https://a/b.png"/><br>tail</div>`,
  );
  assert(roots.length === 1, `1 root expected, got ${roots.length}`);
  const div = roots[0] as HtmlNode;
  assert(div.tag === "div", `root tag div, got ${div.tag}`);
  assert(div.attrs["data-kind"] === "diegetic", "data-kind attr parsed");
  assert(div.attrs.style === `background:url("x")`, `entities decoded in attrs, got ${div.attrs.style}`);
  assert(countElementDescendants(div) === 3, `span+img+br = 3 descendants, got ${countElementDescendants(div)}`);
  assert(countTextNodes(div) === 2, `"Hello & welcome" + "tail" = 2 text nodes, got ${countTextNodes(div)}`);
  const span = div.children[0] as HtmlNode;
  assert(span.children[0] === "Hello & welcome", "entities decoded in text");
});

await check("maxDomDepth counts element nesting (root = 1); text nodes add nothing", () => {
  const roots = parseHtmlStructure("<div><div><div><span>deep</span></div></div>flat</div>");
  assert(maxDomDepth(roots) === 4, `depth 4 expected, got ${maxDomDepth(roots)}`);
});

await check("parser survives comments and raw <style> content", () => {
  const roots = parseHtmlStructure(
    `<div><!-- note --><style>.a{content:"</div>"}</style><p>ok</p></div>`,
  );
  const div = roots[0] as HtmlNode;
  assert(countElementDescendants(div) === 2, `style+p = 2, got ${countElementDescendants(div)}`);
  assert((div.children.find((c) => typeof c !== "string" && c.tag === "p") as HtmlNode).children[0] === "ok", "p survives raw style");
});

// ─────────────────────────────────────────────────────────────────────────────
// gradient signatures
// ─────────────────────────────────────────────────────────────────────────────

await check("extractGradients: balanced parens, multiple gradients, normalization", () => {
  const gs = extractGradients(
    "background:radial-gradient(circle at 50% 50%, rgba(255, 122, 89, 0.3) 0%, transparent 55%)," +
      "linear-gradient(180deg, #fff 0%, #000 100%);opacity:0.5",
  );
  assert(gs.length === 2, `2 gradients, got ${gs.length}`);
  assert(gs[0] === "radial-gradient(circleat50%50%,rgba(255,122,89,0.3)0%,transparent55%)", `normalized verbatim signature, got ${gs[0]}`);
});

await check("gradientSignatures: absolute textless layers only (a gradient CTA is content)", () => {
  const roots = parseHtmlStructure(
    `<div>` +
      `<div style="position:absolute;background:radial-gradient(circle, #ff7a59 0%, transparent 55%)"></div>` +
      `<div style="position:absolute;background:linear-gradient(90deg, #fff, #000)">Get a demo</div>` +
      `<div style="background:conic-gradient(from 0deg, #fff, #000)"></div>` +
      `</div>`,
  );
  const sigs = gradientSignatures(roots);
  assert(sigs.size === 1, `only the textless absolute layer counts — got ${sigs.size}: ${[...sigs]}`);
});

await check("assessAtmosphereVariety: 4 distinct pass; verbatim repeat in >2 scenes fails", () => {
  const layer = (g: string) =>
    parseHtmlStructure(`<div><div style="position:absolute;background:${g}"></div></div>`);
  const g = (n: number) => `radial-gradient(circle at ${n}% 50%, #ff7a59 0%, transparent 55%)`;
  const ok = assessAtmosphereVariety([
    { scene: 0, roots: layer(g(10)) },
    { scene: 1, roots: layer(g(20)) },
    { scene: 2, roots: layer(g(30)) },
    { scene: 3, roots: layer(g(40)) },
  ]);
  assert(ok.length === 0, `4 distinct signatures must pass, got: ${ok.map((f) => f.detail)}`);
  const bad = assessAtmosphereVariety([
    { scene: 0, roots: layer(g(10)) },
    { scene: 1, roots: layer(g(10)) },
    { scene: 2, roots: layer(g(10)) },
    { scene: 3, roots: layer(g(40)) },
  ]);
  assert(bad.some((f) => f.detail.includes("VERBATIM in 3 scenes")), `same signature in 3 scenes must fail (max ${MAX_SCENES_PER_SIGNATURE}), got: ${bad.map((f) => f.detail)}`);
  assert(bad.some((f) => f.detail.includes(`only 2 distinct`)), `2 distinct < ${MIN_GRADIENT_SIGNATURES} must also fail`);
  assert(bad.every((f) => f.scene === -1 && f.blocking), "atmosphere findings are video-level and blocking");
});

// ─────────────────────────────────────────────────────────────────────────────
// clause helpers on hand-built markup
// ─────────────────────────────────────────────────────────────────────────────

const mockWithSpans = (n: number, kind = "diegetic") =>
  parseHtmlStructure(
    `<div><div data-piece="s0.mock" data-kind="${kind}"><div>` +
      Array.from({ length: n }, (_, i) => `<span>v${i}</span>`).join("") +
      `</div></div></div>`,
  );

await check(`clause (a): ${DIEGETIC_MIN_ELEMENTS - 1}-descendant diegetic fails, ${DIEGETIC_MIN_ELEMENTS} passes`, () => {
  // container div + N spans = N+1 element descendants of the piece wrapper.
  const borderline = assessDiegeticInterior(mockWithSpans(DIEGETIC_MIN_ELEMENTS - 2), 0);
  assert(borderline.length === 1, "14 descendants must fail the 15 floor");
  assert(borderline[0].kind === "thin-diegetic" && borderline[0].blocking, "thin-diegetic, blocking");
  assert(borderline[0].detail.includes("14 element descendants"), `measured number in detail: ${borderline[0].detail}`);
  const atFloor = assessDiegeticInterior(mockWithSpans(DIEGETIC_MIN_ELEMENTS - 1), 0);
  assert(atFloor.length === 0, `15 descendants + ${DIEGETIC_MIN_ELEMENTS - 1} texts must pass, got: ${atFloor.map((f) => f.detail)}`);
});

await check(`clause (a): enough elements but <${DIEGETIC_MIN_TEXT_NODES} text nodes still fails; non-diegetic pieces don't count`, () => {
  const hollow = parseHtmlStructure(
    `<div><div data-piece="s0.mock" data-kind="diegetic"><div>` +
      Array.from({ length: 20 }, () => `<span></span>`).join("") +
      `<span>a</span><span>b</span><span>c</span></div></div></div>`,
  );
  const f1 = assessDiegeticInterior(hollow, 2);
  assert(f1.length === 1 && f1[0].detail.includes("3 non-empty text nodes"), `24 elements / 3 texts must fail: ${f1.map((f) => f.detail)}`);
  const textPiece = assessDiegeticInterior(mockWithSpans(30, "text"), 1);
  assert(textPiece.length === 1 && textPiece[0].detail.includes(`no data-kind="diegetic" piece`), "a rich TEXT piece cannot satisfy the diegetic floor");
});

await check(`clause (a2): a hollow ".hero" fails EVEN when a rich sibling carries clause (a)`, () => {
  // The v5 scene-2 leak shape: hero = 1 element / 0 texts, sibling diegetic
  // rich enough to satisfy the any-diegetic floor on its own.
  const roots = parseHtmlStructure(
    `<div>` +
      `<div data-piece="s2.hero" data-kind="diegetic"><div></div></div>` +
      `<div data-piece="s2.throughline" data-kind="diegetic"><div>` +
      Array.from({ length: 16 }, (_, i) => `<span>v${i}</span>`).join("") +
      `</div></div></div>`,
  );
  const f = assessDiegeticInterior(roots, 2);
  assert(f.length === 1, `exactly the hero finding expected (sibling carries clause a), got: ${f.map((x) => x.kind).join(",")}`);
  assert(f[0].kind === "thin-hero" && f[0].scene === 2 && f[0].blocking, "thin-hero on scene 2, blocking");
  assert(f[0].detail.includes(`"s2.hero"`), `finding must NAME the hero id: ${f[0].detail}`);
  assert(f[0].detail.includes("1 element descendants") && f[0].detail.includes("0 non-empty text nodes"), `measured numbers in detail: ${f[0].detail}`);
  assert(f[0].repairInstruction.includes("s2.hero"), "repair instruction targets the hero by id");
});

await check(`clause (a2): a hero at the floor (${HERO_MIN_ELEMENTS}el/${HERO_MIN_TEXT_NODES}tx) passes; one under fails`, () => {
  const heroWith = (spans: number, texts: number) =>
    parseHtmlStructure(
      `<div><div data-piece="s0.hero" data-kind="diegetic"><div>` +
        Array.from({ length: spans }, (_, i) => `<span>${i < texts ? `t${i}` : ""}</span>`).join("") +
        `</div></div></div>`,
    );
  // container + N spans = N+1 element descendants of the hero wrapper.
  const atFloor = assessDiegeticInterior(heroWith(HERO_MIN_ELEMENTS - 1, HERO_MIN_TEXT_NODES), 0)
    .filter((f) => f.kind === "thin-hero");
  assert(atFloor.length === 0, `${HERO_MIN_ELEMENTS}el/${HERO_MIN_TEXT_NODES}tx hero must pass, got: ${atFloor.map((f) => f.detail)}`);
  const under = assessDiegeticInterior(heroWith(HERO_MIN_ELEMENTS - 2, HERO_MIN_TEXT_NODES), 0)
    .filter((f) => f.kind === "thin-hero");
  assert(under.length === 1 && under[0].detail.includes(`${HERO_MIN_ELEMENTS - 1} element descendants`), `one-under-floor hero must fail: ${under.map((f) => f.detail)}`);
  const noText = assessDiegeticInterior(heroWith(HERO_MIN_ELEMENTS + 4, 0), 0)
    .filter((f) => f.kind === "thin-hero");
  assert(noText.length === 1 && noText[0].detail.includes("0 non-empty text nodes"), `a 0-text hero must fail the text floor: ${noText.map((f) => f.detail)}`);
});

await check(`clause (b): depth ${DEPTH_FLOOR - 1} fails with measured number, ${DEPTH_FLOOR} passes`, () => {
  const nest = (n: number) => parseHtmlStructure("<div>".repeat(n) + "x" + "</div>".repeat(n));
  const shallow = assessDomDepth(nest(DEPTH_FLOOR - 1), 3);
  assert(shallow.length === 1 && shallow[0].kind === "shallow-dom" && shallow[0].blocking, "shallow-dom, blocking");
  assert(shallow[0].detail.includes(`depth is ${DEPTH_FLOOR - 1}`), `measured depth in detail: ${shallow[0].detail}`);
  assert(assessDomDepth(nest(DEPTH_FLOOR), 3).length === 0, `depth ${DEPTH_FLOOR} passes`);
});

await check("clause (d): data:/https:/root-relative pass; asset ids, [object Object], empty fail", () => {
  for (const good of ["data:image/svg+xml;base64,PHN2Zy8+", "https://a/b.png", "http://a/b.png", "/assets/x.png"]) {
    assert(IMG_SRC_WHITELIST.test(good), `${good} must pass the whitelist`);
  }
  for (const bad of ["site_img_0", "[object Object]", "", "logo.png"]) {
    assert(!IMG_SRC_WHITELIST.test(bad), `"${bad}" must fail the whitelist`);
  }
  const roots = parseHtmlStructure(
    `<div><img src="data:image/svg+xml;base64,PHN2Zy8+"/><img src="site_img_0"/><img src="https://a/b.png"/></div>`,
  );
  assert(imgSrcs(roots).length === 3, "3 imgs collected");
  const f = assessImgSrcs(roots, 1);
  assert(f.length === 1 && f[0].kind === "img-src" && f[0].blocking, "img-src, blocking");
  assert(f[0].detail.includes(`"site_img_0"`), `raw asset id flagged: ${f[0].detail}`);
  assert(f[0].detail.includes("1 <img> src(s)") && !f[0].detail.includes("PHN2Zy8"), `the data: URI must NOT be among the offenders: ${f[0].detail}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// SSR harness + assessDensity on synthetic compositions
// ─────────────────────────────────────────────────────────────────────────────

// Four distinct decorative layers + an Img + a deep NON-diegetic caption chain
// (so clause (b) is satisfied outside the mock) — shared by both fixtures so
// only the diegetic interior differs between them.
const FIXTURE_CHROME = `
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(circle at 20% 30%, #ff7a59 0%, transparent 40%)" }} />
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(circle at 80% 70%, #213343 0%, transparent 50%)" }} />
      <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, transparent 0%, #ff7a59 100%)" }} />
      <div style={{ position: "absolute", inset: 0, background: "conic-gradient(from 90deg, #ff7a59 0%, transparent 25%)" }} />
      <Img src="data:image/svg+xml;base64,PHN2Zy8+" style={{ width: 40, height: 40 }} />
      <div style={{ position: "absolute", left: 60, bottom: 60 }}>
        <div><div><div><div><div><span>caption</span></div></div></div></div></div>
      </div>`;

const fixture = (mockJsx: string) => `import React from "react";
import { Img } from "./Img";
import { Piece } from "./Piece";

export const Section0: React.FC<{ script?: unknown }> = () => (
  <div style={{ position: "absolute", inset: 0 }}>
${FIXTURE_CHROME}
    <Piece id="s0.mock" kind="diegetic">${mockJsx}</Piece>
  </div>
);
`;

// Rich mock: wrapper → container(1) → chrome chain div>div>div>div>span (5) →
// 4 rows × (div + 2 spans) (12) = 18 element descendants, 9 text nodes, and
// the deepest span sits 8 levels down.
const RICH_MOCK = `
      <div style={{ position: "absolute", left: 200, top: 200, width: 800, height: 500 }}>
        <div><div><div><div><span>CRM Dashboard</span></div></div></div></div>
        {[0, 1, 2, 3].map((i) => (
          <div key={i}><span>{"Deal " + i}</span><span>{"$" + i + "40"}</span></div>
        ))}
      </div>`;

// Borderline mock: wrapper → container(1) + 13 spans = 14 element descendants
// (one under the floor), 13 text nodes (texts alone can't save it). Depth and
// atmosphere are healthy via FIXTURE_CHROME, isolating the clause-(a) failure.
const BORDERLINE_MOCK = `
      <div style={{ position: "absolute", left: 100, top: 100 }}>
        {Array.from({ length: 13 }, (_, i) => (
          <span key={i}>{"v" + i}</span>
        ))}
      </div>`;

await check("SSR harness renders a Section through the Piece/Img shims", () => {
  const renders = renderSectionsForAnalysis(fixture(RICH_MOCK));
  assert(renders.length === 1 && renders[0].html != null, `render failed: ${renders[0]?.error}`);
  const roots = parseHtmlStructure(renders[0].html!);
  const pieces = pieceStats(roots);
  assert(pieces.length === 1 && pieces[0].kind === "diegetic", "Piece shim emitted data-piece/data-kind");
  assert(pieces[0].elements === 18, `rich mock = 18 element descendants, got ${pieces[0].elements}`);
  assert(pieces[0].textNodes >= 4, `rich mock has ≥4 texts, got ${pieces[0].textNodes}`);
});

await check("synthetic: a scene with a rich mock passes every clause", () => {
  const findings = assessDensity(fixture(RICH_MOCK));
  assert(findings.length === 0, `expected 0 findings, got: ${findings.map((f) => `[${f.kind}] ${f.detail}`).join(" | ")}`);
});

await check("synthetic: a borderline 14-descendant mock fails clause (a) and only clause (a)", () => {
  const findings = assessDensity(fixture(BORDERLINE_MOCK));
  assert(findings.length === 1, `expected exactly 1 finding, got: ${findings.map((f) => f.kind).join(",")}`);
  assert(findings[0].kind === "thin-diegetic" && findings[0].scene === 0 && findings[0].blocking, "thin-diegetic on scene 0, blocking");
  assert(findings[0].detail.includes("14 element descendants"), `measured 14 in detail: ${findings[0].detail}`);
  assert(findings[0].repairInstruction.length > 40, "carries an actionable repair instruction");
});

await check("fail-closed: a Section the script promises but the code lacks is a measure-error", () => {
  const findings = assessDensity(fixture(RICH_MOCK), { scenes: [{}, {}] });
  const errs = ofKind(findings, "density-measure-error");
  assert(errs.length === 1 && errs[0].scene === 1 && errs[0].blocking, `scene 1 must fail closed, got: ${findings.map((f) => `[${f.kind}]s${f.scene}`)}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// REAL fixtures — the audit's separation, replayed through the shipped gate
// ─────────────────────────────────────────────────────────────────────────────

const REF_DIR = path.join(process.cwd(), "src/generated/01KXEAF0SNT0RR079Z1SJZ1KWZ");
const SPIKE_DIR = path.join(process.cwd(), "src/generated/CAST_SPIKE_FULL_HUBSPOT");

let refFindings: DensityFinding[] | null = null;
let spikeFindings: DensityFinding[] | null = null;

await check("reference build reassembles from lego and SSRs on all 5 scenes", async () => {
  const script = JSON.parse(await fs.readFile(path.join(REF_DIR, "script.json"), "utf8"));
  const code = reassemble(await readDecomposed(REF_DIR));
  refFindings = assessDensity(code, script);
  assert(ofKind(refFindings, "density-measure-error").length === 0, `measure errors: ${ofKind(refFindings, "density-measure-error").map((f) => f.detail)}`);
});

await check("reference: 0 findings on diegetic-interior, depth, and atmosphere clauses", () => {
  assert(refFindings !== null, "reference did not load");
  for (const kind of ["thin-diegetic", "shallow-dom", "atmosphere-monotony"] as const) {
    const fs_ = ofKind(refFindings!, kind);
    assert(fs_.length === 0, `${kind}: expected 0, got ${fs_.length}: ${fs_.map((f) => f.detail).join(" | ")}`);
  }
});

await check("reference: img-src catches ONLY the known latent scene-3 [object Object] defect", () => {
  // A true positive, not a false one: scene 3's texture layer does
  // `<Img src={siteImg}>` with siteImg = script.assets.images[0] — an OBJECT.
  // It ships as src="[object Object]" at opacity 0.03 (why no eyeball caught
  // it). The gate exists to catch unfetchable srcs, so it must flag this.
  assert(refFindings !== null, "reference did not load");
  const imgs = ofKind(refFindings!, "img-src");
  assert(imgs.length === 1, `exactly 1 img-src finding expected, got ${imgs.length}: ${imgs.map((f) => f.detail).join(" | ")}`);
  assert(imgs[0].scene === 3 && imgs[0].detail.includes("[object Object]"), `scene 3 [object Object], got: ${imgs[0].detail}`);
});

await check("spike build loads and SSRs on all 5 scenes", async () => {
  const script = JSON.parse(await fs.readFile(path.join(SPIKE_DIR, "script.json"), "utf8"));
  const code = await fs.readFile(path.join(SPIKE_DIR, "Composition.tsx"), "utf8");
  spikeFindings = assessDensity(code, script);
  assert(ofKind(spikeFindings, "density-measure-error").length === 0, `measure errors: ${ofKind(spikeFindings, "density-measure-error").map((f) => f.detail)}`);
});

await check("spike: clause (a) thin-diegetic fires on EVERY scene (best interior 13el/3tx < 15/4)", () => {
  assert(spikeFindings !== null, "spike did not load");
  const thin = ofKind(spikeFindings!, "thin-diegetic");
  assert(scenesOf(thin).join(",") === "0,1,2,3,4", `all 5 scenes expected, got scenes ${scenesOf(thin).join(",")}`);
  assert(thin.every((f) => f.blocking), "all blocking");
});

await check(`spike: clause (b) shallow-dom fires on EVERY scene (flat depth 5 < ${DEPTH_FLOOR})`, () => {
  assert(spikeFindings !== null, "spike did not load");
  const shallow = ofKind(spikeFindings!, "shallow-dom");
  assert(scenesOf(shallow).join(",") === "0,1,2,3,4", `all 5 scenes expected, got scenes ${scenesOf(shallow).join(",")}`);
  assert(shallow.every((f) => f.detail.includes("depth is 5")), `spike is flat 5 everywhere: ${shallow.map((f) => f.detail)}`);
});

await check("spike: clause (c) atmosphere-monotony — 3 distinct signatures, one verbatim in 4 scenes", () => {
  assert(spikeFindings !== null, "spike did not load");
  const atmos = ofKind(spikeFindings!, "atmosphere-monotony");
  assert(atmos.length === 2, `both variety findings expected, got ${atmos.length}: ${atmos.map((f) => f.detail)}`);
  assert(atmos.some((f) => f.detail.includes(`only 3 distinct`)), "distinct-count floor finding");
  assert(atmos.some((f) => f.detail.includes("VERBATIM in 4 scenes (0, 2, 3, 4)")), "verbatim-repeat finding");
  assert(atmos.every((f) => f.scene === -1), "video-level");
});

await check("spike: clause (d) img-src fires on scenes 1 and 3 (raw site_img_* asset ids)", () => {
  assert(spikeFindings !== null, "spike did not load");
  const imgs = ofKind(spikeFindings!, "img-src");
  assert(scenesOf(imgs).join(",") === "1,3", `scenes 1,3 expected, got ${scenesOf(imgs).join(",")}`);
  assert(imgs.every((f) => f.detail.includes("site_img_0")), `raw asset ids named in detail: ${imgs.map((f) => f.detail)}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// REAL fixtures — clause (a2) per-hero calibration (acceptance v6)
// ─────────────────────────────────────────────────────────────────────────────

const A5_DIR = path.join(process.cwd(), "src/generated/CAST_SPIKE_A5_GLM52");
const DUO_REF_DIR = path.join(process.cwd(), "src/generated/01KWTMK9WXRZNF7X553R9AN63M");

await check("v5 genDir: thin-hero fires on EXACTLY scene 2 (s2.hero = 1el/0tx; sibling carried clause a)", async () => {
  const script = JSON.parse(await fs.readFile(path.join(A5_DIR, "script.json"), "utf8"));
  const code = await fs.readFile(path.join(A5_DIR, "Composition.tsx"), "utf8");
  const findings = assessDensity(code, script);
  const heroes = ofKind(findings, "thin-hero");
  assert(scenesOf(heroes).join(",") === "2", `scene 2 only expected, got scenes [${scenesOf(heroes).join(",")}]: ${heroes.map((f) => f.detail).join(" | ")}`);
  assert(heroes[0].detail.includes(`"s2.hero"`), `the finding must name the hero id: ${heroes[0].detail}`);
  assert(heroes[0].detail.includes("1 element descendants") && heroes[0].detail.includes("0 non-empty text nodes"), `measured 1el/0tx in detail: ${heroes[0].detail}`);
  // Calibration pin: the OTHER v5 heroes (83/5, 57/9, 122/16, 93/18) pass.
  assert(heroes.every((f) => f.blocking), "thin-hero blocks");
});

await check("Duolingo GLM reference: zero thin-hero findings (s3.hero = 34el/2tx passes the hero floor)", async () => {
  // Calibration pin: the reference hero is an illustrative tableau with only
  // 2 interior text nodes — the hero text floor (≥1) must admit it while the
  // element floor (≥15) still rejects the v5 lone-element hero.
  const script = JSON.parse(await fs.readFile(path.join(DUO_REF_DIR, "script.json"), "utf8"));
  const code = reassemble(await readDecomposed(DUO_REF_DIR));
  const findings = assessDensity(code, script);
  const heroes = ofKind(findings, "thin-hero");
  assert(heroes.length === 0, `reference heroes must pass, got: ${heroes.map((f) => f.detail).join(" | ")}`);
});

await check("every finding carries the gate contract: kind, scene, blocking, detail, repairInstruction", () => {
  assert(refFindings !== null && spikeFindings !== null, "fixtures did not load");
  for (const f of [...refFindings!, ...spikeFindings!]) {
    assert(typeof f.kind === "string" && Number.isInteger(f.scene), "kind + scene");
    assert(f.blocking === true, "density findings block");
    assert(f.detail.length > 20 && /\d/.test(f.detail), "humanized detail with measured numbers");
    assert(f.repairInstruction.length > 40, "actionable repair instruction");
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
