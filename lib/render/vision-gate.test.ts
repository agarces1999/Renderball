/**
 * Tests for the vision gate. The judge is injected, so the aggregation logic +
 * tolerant verdict parsing are verified without any real vision-model spend.
 */
import {
  runVisionGate,
  parseVerdict,
  buildRubric,
  buildBrandColorPrompt,
  parseBrandFidelity,
  checkBrandColorFidelity,
  isSanctionedChromeFinding,
  type VisionJudge,
  type VisionVerdict,
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
