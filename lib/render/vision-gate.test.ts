/**
 * Tests for the vision gate. The judge is injected, so the aggregation logic +
 * tolerant verdict parsing are verified without any real vision-model spend.
 */
import { readFileSync } from "fs";
import { join } from "path";
import sharp from "sharp";
import {
  runVisionGate,
  parseVerdict,
  buildRubric,
  buildSequenceRubric,
  judgeSequence,
  stampSceneIndexBadge,
  extractPlannedElements,
  buildBrandColorPrompt,
  parseBrandFidelity,
  checkBrandColorFidelity,
  isSanctionedChromeFinding,
  SEQUENCE_SCENE,
  type VisionJudge,
  type VisionVerdict,
  type SequenceJudge,
} from "./vision-gate";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("vision-gate");

await check("parseVerdict: clean verdict → ok, no issues", () => {
  const v = parseVerdict('{"ok": true, "issues": []}');
  assert(v.ok && v.issues.length === 0, JSON.stringify(v));
});

await check("parseVerdict: issues present → not ok, issues carried", () => {
  const v = parseVerdict('{"ok": false, "issues": ["logos washed out", "wall of type"]}');
  assert(!v.ok && v.issues.length === 2 && v.issues[0] === "logos washed out", JSON.stringify(v));
});

await check("parseVerdict: ok:true with issues is treated as not-ok (consistency)", () => {
  const v = parseVerdict('{"ok": true, "issues": ["text clipped"]}');
  assert(!v.ok && v.issues.length === 1, JSON.stringify(v));
});

await check("parseVerdict: tolerates prose around the JSON", () => {
  const v = parseVerdict('Here is my assessment:\n{"ok": false, "issues": ["bg is black not burgundy"]}\nDone.');
  assert(!v.ok && v.issues[0] === "bg is black not burgundy", JSON.stringify(v));
});

await check("parseVerdict: garbage → ok (advisory, never block on parse failure)", () => {
  const v = parseVerdict("the model rambled with no json");
  assert(v.ok && v.issues.length === 0, JSON.stringify(v));
});

await check("runVisionGate: aggregates issues across scenes, skips clean ones", async () => {
  const verdicts: Record<number, VisionVerdict> = {
    0: { ok: true, issues: [] },
    1: { ok: false, issues: ["logos unreadable", "near-black canvas"] },
    2: { ok: false, issues: ["wall of type"] },
  };
  const judge: VisionJudge = async (_p, scene) => verdicts[scene];
  const findings = await runVisionGate(
    [{ scene: 0, screenshotPath: "a.png" }, { scene: 1, screenshotPath: "b.png" }, { scene: 2, screenshotPath: "c.png" }],
    { name: "Fuse", backgroundColor: "#440b12" },
    judge,
  );
  assert(findings.length === 3, `got ${findings.length}`);
  assert(findings.filter((f) => f.scene === 1).length === 2, "scene 1 → 2 issues");
  assert(findings.some((f) => f.scene === 2 && /wall of type/.test(f.issue)), "scene 2 wall-of-type");
});

await check("runVisionGate: scenes without a screenshot are skipped", async () => {
  const judge: VisionJudge = async () => ({ ok: false, issues: ["x"] });
  const findings = await runVisionGate([{ scene: 0, screenshotPath: undefined }], { }, judge);
  assert(findings.length === 0, "no screenshot → no judge call");
});

await check("runVisionGate: a judge error on one scene is skipped (advisory)", async () => {
  const judge: VisionJudge = async (_p, scene) => {
    if (scene === 0) throw new Error("vision timeout");
    return { ok: false, issues: ["real issue"] };
  };
  const findings = await runVisionGate(
    [{ scene: 0, screenshotPath: "a.png" }, { scene: 1, screenshotPath: "b.png" }],
    {},
    judge,
  );
  assert(findings.length === 1 && findings[0].scene === 1, `got ${JSON.stringify(findings)}`);
});

await check("buildRubric: names the brand background color when provided", () => {
  const r = buildRubric({ backgroundColor: "#440b12", fonts: ["Merriweather"] });
  assert(r.includes("#440b12") && /Merriweather/.test(r), "rubric should cite brand truth");
});

// ── sanctioned BrandChrome post-filter ──────────────────────────────
// GLM-4.5V flags the by-design corner wordmark + context pill as "web-page
// chrome" despite the rubric's explicit exemption (verbatim Oura FP below).
await check("isSanctionedChromeFinding: the real Oura FP is filtered", () => {
  const oura =
    "Visible web-page chrome: 'Oura' wordmark in top-left and 'OURA RING' navigation pill in top-right read as website UI, not a film frame";
  assert(isSanctionedChromeFinding(oura), "verbatim Oura finding must be sanctioned");
});

await check("isSanctionedChromeFinding: wordmark-only phrasing is filtered", () => {
  assert(
    isSanctionedChromeFinding("Brand wordmark in the top-left corner looks like website navigation"),
    "wordmark + corner, no defect → sanctioned",
  );
});

await check("isSanctionedChromeFinding: chrome finding WITH a real defect survives", () => {
  assert(
    !isSanctionedChromeFinding("Wordmark in top-left overlaps the headline text"),
    "overlap is a real defect",
  );
  assert(
    !isSanctionedChromeFinding("Context pill in the top-right corner is unreadable against the photo"),
    "unreadable is a real defect",
  );
  assert(
    !isSanctionedChromeFinding("Corner logo in top-left is clipped at the frame edge"),
    "clipped is a real defect",
  );
});

await check("isSanctionedChromeFinding: non-chrome findings survive", () => {
  assert(!isSanctionedChromeFinding("Pagination dots at the bottom read as a carousel"), "dots are not sanctioned");
  assert(!isSanctionedChromeFinding("Navigation bar with links across the top"), "a nav bar is not the corner marks");
  assert(!isSanctionedChromeFinding("wall of type"), "unrelated finding untouched");
});

await check("runVisionGate: sanctioned-chrome findings are dropped, real ones kept", async () => {
  const judge: VisionJudge = async () => ({
    ok: false,
    issues: [
      "Visible web-page chrome: 'Oura' wordmark in top-left and 'OURA RING' navigation pill in top-right read as website UI, not a film frame",
      "hero illustration too dim to read",
    ],
  });
  const findings = await runVisionGate([{ scene: 0, screenshotPath: "a.png" }], { name: "Oura" }, judge);
  assert(findings.length === 1, `expected 1 surviving finding, got ${findings.length}: ${JSON.stringify(findings)}`);
  assert(/too dim/.test(findings[0].issue), "the real finding survives");
});

// ── density/craft dimension ─────────────────────────────────────────
// The parity audit's core finding: the rubric was a defect detector with no
// absolute quality bar — near-empty mocks passed because emptiness wasn't in
// its vocabulary. The density block makes reference-grade furnishing the bar.
await check("buildRubric: density/craft block demands furnished containers", () => {
  const r = buildRubric({ name: "HubSpot" });
  assert(/Density\/craft/.test(r), "density block present");
  assert(r.includes("a large mock or panel whose interior is empty or a plain wash"), "empty-panel flag phrase present");
  assert(r.includes("lower half is entirely empty canvas"), "empty-lower-half flag phrase present");
  assert(/labeled rows/.test(r) && /timestamps/.test(r), "names concrete interior content (rows, timestamps)");
  assert(/negative space/.test(r), "deliberate hero negative space stays exempt");
});

await check("buildRubric: sanctioned-chrome exemption survives the density upgrade", () => {
  const r = buildRubric({ name: "Oura" });
  assert(/SANCTIONED EXEMPTION/.test(r), "exemption block intact");
  assert(/TOP-LEFT/.test(r) && /TOP-RIGHT/.test(r), "corner marks still described");
  assert(/Never report them/.test(r), "never-report instruction intact");
});

// ── plan fidelity: full concept + per-element verification ─────────
await check("buildRubric: concept is no longer truncated at 500 chars", () => {
  const tail = "THE-PLANNED-CLOSING-BEAT-SENTINEL";
  const concept = `Composition: ${"x".repeat(900)} then ${tail}`;
  const r = buildRubric({}, concept);
  assert(r.includes(tail), "text past the old 500-char slice must reach the judge");
});

await check("buildRubric: fidelity is phrased as per-element verification", () => {
  const r = buildRubric({}, "Composition: A dashboard panel with a headline 'One platform'.");
  assert(/PRESENT/.test(r) && /FURNISHED/.test(r) && /RECOGNIZABLE/.test(r), "present/furnished/recognizable triad");
  assert(/Planned elements to verify one by one/.test(r), "checklist line present");
  assert(r.includes('"One platform"'), "quoted label lands in the checklist");
});

await check("buildRubric: explicit plannedElements override the auto-extraction", () => {
  const r = buildRubric({}, "Composition: stuff.", ["ticker tape", "orbit diagram"]);
  assert(r.includes('"ticker tape"') && r.includes('"orbit diagram"'), "override list used");
});

await check("buildRubric: no concept → no fidelity block (back-compat)", () => {
  const r = buildRubric({ backgroundColor: "#440b12" });
  assert(!/Plan fidelity/.test(r) && !/Planned elements/.test(r), "fidelity only with a concept");
});

await check("extractPlannedElements: quoted labels + nouns from the real reference concept", () => {
  const script = JSON.parse(
    readFileSync(join(process.cwd(), "src", "generated", "01KXEAF0SNT0RR079Z1SJZ1KWZ", "script.json"), "utf8"),
  ) as { scenes: { visual_concept: string }[] };
  const els = extractPlannedElements(script.scenes[1].visual_concept);
  assert(els.includes("Email Tool") && els.includes("CRM"), `quoted tab labels extracted, got ${JSON.stringify(els)}`);
  assert(els.includes("Your tools are everywhere"), "quoted headline extracted");
  assert(
    els.some((e) => /\btabs?\b/i.test(e)) && els.some((e) => /\bheadline\b/i.test(e)),
    `concrete nouns (tabs, headline) extracted, got ${JSON.stringify(els)}`,
  );
});

await check("extractPlannedElements: possessive apostrophes don't open phantom quotes", () => {
  const els = extractPlannedElements("Composition: The scene's tabs collide. The brand's logo sits above a label 'Real Label'.");
  assert(els.includes("Real Label"), "the real quoted label extracted");
  assert(!els.some((e) => /s tabs/.test(e)), `no phantom span between possessives: ${JSON.stringify(els)}`);
});

await check("extractPlannedElements: deduped and bounded", () => {
  const els = extractPlannedElements(`Composition: ${Array.from({ length: 30 }, (_, i) => `a card labeled 'L${i}'`).join(", ")}.`);
  assert(els.length <= 14, `capped at 14, got ${els.length}`);
  assert(new Set(els.map((e) => e.toLowerCase())).size === els.length, "no duplicates");
});

// ── sequence-level gate ─────────────────────────────────────────────
// Five separate CLEAN per-frame verdicts missed the same radial glow in 4/5
// scenes; monotony/arc only exist ACROSS frames, so all frames go in one call.
await check("buildSequenceRubric: names monotony, repetition, arc, and throughline checks", () => {
  const r = buildSequenceRubric(5, { name: "Fuse", backgroundColor: "#440b12" });
  assert(/Atmosphere monotony/.test(r) && /3 or more scenes/.test(r) && /radial glow/.test(r), "monotony check with the glow example");
  assert(/Archetype repetition/.test(r), "archetype repetition check");
  assert(/Arc progression/.test(r) && /interchangeable with an early frame/.test(r), "arc progression check");
  assert(/Throughline evolution/.test(r), "throughline evolution check");
  assert(/5 frames IN ORDER/.test(r) && /scene 4/.test(r), "frame ordering spelled out for the judge");
  assert(r.includes("#440b12") && /never flag the canvas color/i.test(r), "brand canvas consistency exempted");
  assert(/SANCTIONED CHROME/.test(r) && /Never report them/.test(r), "chrome discipline carried over");
  assert(r.includes('{"ok": boolean, "issues"'), "same JSON contract as the per-scene rubric");
});

await check("judgeSequence: canned verdict → findings with sequence scope, scene -1", async () => {
  let gotImages: string[] = [];
  let gotPrompt = "";
  const judge: SequenceJudge = async (imgs, prompt) => {
    gotImages = imgs;
    gotPrompt = prompt;
    return '{"ok": false, "issues": ["scenes 0, 2, 3 all use the same centered radial glow", "closing scene restates the opening composition"]}';
  };
  const findings = await judgeSequence(["b64a", "b64b", "b64c", "b64d"], { name: "Fuse" }, judge);
  assert(gotImages.length === 4, "all frames sent in one call");
  assert(/Atmosphere monotony/.test(gotPrompt), "judge got the sequence rubric");
  assert(findings.length === 2, `got ${JSON.stringify(findings)}`);
  assert(findings.every((f) => f.scene === SEQUENCE_SCENE && f.scope === "sequence"), "distinguishable sequence shape");
  assert(/radial glow/.test(findings[0].issue), "issue text carried");
});

await check("judgeSequence: clean verdict → no findings", async () => {
  const findings = await judgeSequence(["a", "b"], {}, async () => '{"ok": true, "issues": []}');
  assert(findings.length === 0, JSON.stringify(findings));
});

await check("judgeSequence: malformed JSON → one graceful error finding, no throw", async () => {
  const findings = await judgeSequence(["a", "b"], {}, async () => "the model rambled with no json");
  assert(findings.length === 1, `got ${JSON.stringify(findings)}`);
  assert(findings[0].scene === SEQUENCE_SCENE && findings[0].scope === "sequence", "error finding uses the sequence shape");
  assert(/SEQUENCE-JUDGE-ERROR/.test(findings[0].issue), "distinguishable from a real sequence issue");
});

await check("judgeSequence: broken JSON braces → graceful error finding", async () => {
  const findings = await judgeSequence(["a"], {}, async () => '{"ok": false, "issues": ["unterminated }');
  assert(findings.length === 1 && /SEQUENCE-JUDGE-ERROR/.test(findings[0].issue), JSON.stringify(findings));
});

await check("judgeSequence: judge throw → error finding, never propagates", async () => {
  const findings = await judgeSequence(["a"], {}, async () => {
    throw new Error("vision timeout");
  });
  assert(findings.length === 1 && /SEQUENCE-JUDGE-ERROR/.test(findings[0].issue) && /vision timeout/.test(findings[0].issue), JSON.stringify(findings));
});

await check("judgeSequence: sanctioned-chrome sequence findings are filtered", async () => {
  const findings = await judgeSequence(["a", "b", "c"], { name: "Oura" }, async () =>
    '{"ok": false, "issues": ["Brand wordmark repeated in the top-left corner of every scene", "scenes 0 and 2 share the same gradient wash"]}',
  );
  assert(findings.length === 1, `chrome-repetition dropped, real one kept: ${JSON.stringify(findings)}`);
  assert(/gradient wash/.test(findings[0].issue), "the real monotony finding survives");
});

await check("judgeSequence: no frames → no judge call, no findings", async () => {
  let called = false;
  const findings = await judgeSequence([], {}, async () => { called = true; return "{}"; });
  assert(findings.length === 0 && !called, "empty input short-circuits");
});

// ── brand-color fidelity backstop (text-only) ──────────────────────
await check("parseBrandFidelity: explicit onBrand:false + issue → flags", () => {
  const v = parseBrandFidelity('```json {"present":false,"onBrand":false,"issue":"green missing — palette is blue"} ```');
  assert(!v.onBrand && /green missing/.test(v.issue), JSON.stringify(v));
});
await check("parseBrandFidelity: onBrand:true → passes", () => {
  const v = parseBrandFidelity('{"present":true,"onBrand":true,"issue":""}');
  assert(v.onBrand && v.issue === "", JSON.stringify(v));
});
await check("parseBrandFidelity: unparseable → defaults on-brand (no false alarm)", () => {
  assert(parseBrandFidelity("sorry can't tell").onBrand, "must default on-brand");
});
await check("buildBrandColorPrompt: cites brand name + the palette, no image", () => {
  const p = buildBrandColorPrompt("Robinhood", ["#0668e1", "#ffffff"]);
  assert(/Robinhood/.test(p) && p.includes("#0668e1"), "prompt cites brand + palette");
});
await check("checkBrandColorFidelity: missing brand color → flags (injected)", async () => {
  const v = await checkBrandColorFidelity({ name: "Robinhood" }, ["#0668e1", "#fff"], async () =>
    '{"brandColor":"green #00d094","present":false,"onBrand":false,"issue":"Robinhood green missing — palette is blue"}',
  );
  assert(!v.onBrand && /green missing/.test(v.issue), JSON.stringify(v));
});
await check("checkBrandColorFidelity: no name or empty palette → on-brand, no call", async () => {
  let called = false;
  const v1 = await checkBrandColorFidelity({ name: undefined }, ["#fff"], async () => { called = true; return "{}"; });
  const v2 = await checkBrandColorFidelity({ name: "X" }, [], async () => { called = true; return "{}"; });
  assert(v1.onBrand && v2.onBrand && !called, "skips the call when there's nothing to check");
});

// ── v15 (#5): sequence-judge index stamping ──────────────────────────────────
await check("buildSequenceRubric: instructs the judge to use the burned-in SCENE badge, not position", () => {
  const r = buildSequenceRubric(5, { name: "Superhuman", backgroundColor: "#0b0b1a" });
  assert(/SCENE INDEX/.test(r) && /badge/i.test(r), "names the badge convention");
  assert(/BOTTOM-LEFT/.test(r), "locates the badge away from the top-corner sanctioned chrome");
  assert(/never critique|not part of the design/i.test(r), "tells the judge to ignore it aesthetically");
});

await check("stampSceneIndexBadge: burns a same-dimension badge that actually changes the frame", async () => {
  const base = await sharp({ create: { width: 480, height: 270, channels: 3, background: { r: 12, g: 12, b: 26 } } }).png().toBuffer();
  const stamped = await stampSceneIndexBadge(base, 3);
  const bm = await sharp(base).metadata();
  const sm = await sharp(stamped).metadata();
  assert(sm.width === bm.width && sm.height === bm.height, `dims preserved ${sm.width}×${sm.height}`);
  assert(!stamped.equals(base), "the badge modifies the buffer");
  // The magenta badge lives in the bottom-left — sample a pixel there.
  const { data } = await sharp(stamped).raw().toBuffer({ resolveWithObject: true });
  const meta = await sharp(stamped).metadata();
  const W = meta.width!;
  const px = (x: number, y: number) => { const i = (y * W + x) * (meta.channels ?? 3); return [data[i], data[i + 1], data[i + 2]]; };
  const [r, g, b] = px(Math.round(W * 0.05), Math.round((meta.height ?? 270) * 0.9));
  assert(r > 180 && b > 180 && g < 120, `bottom-left carries magenta, got rgb(${r},${g},${b})`);
});

await check("stampSceneIndexBadge: a non-PNG buffer degrades to the original (never throws)", async () => {
  const junk = Buffer.from("not an image");
  const out = await stampSceneIndexBadge(junk, 0);
  assert(out.equals(junk), "unreadable input returns unchanged");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
