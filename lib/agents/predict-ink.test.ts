/**
 * Tests for predict-ink — predicted text ink vs the 10 MEASURED scenes.
 * Run: `node scripts/run-tests.mjs lib/agents/predict-ink.test.ts`
 * (no API key, no network, no filesystem — the golden data is embedded).
 *
 * THE GOLDEN TEST. The fixture below is the verbatim (declared box, painted
 * rect, owned copy strings) triple of every measured text piece in
 * `.data/dogfood/{flags-notion,flags-on-rappi}/_measure/rects-scene-N.json`,
 * plus the advance/kern table of the genuinely-calibrated face those renders
 * used (notioninter-400, v2 "asserted"), trimmed to the glyphs the strings
 * contain. Embedding keeps the suite hermetic — the .data artifacts are
 * gitignored build outputs and must not be a test dependency.
 *
 * Two of the ten scenes are labelled `emissionHonoredOwnership: false`, with
 * the evidence in the fixture comment: a plan-time predictor cannot see an
 * emitter DISOBEYING the ownership contract, so those scenes bound what
 * emission variance does to the prediction (30–70%), while the other eight
 * bound the predictor itself (~10% mean). Both bounds are pinned.
 */
import {
  predictCopyInk,
  predictInkRect,
  inkSizedBox,
  typicalSansMetrics,
  INK_MODEL,
  TYPICAL_SANS_ADVANCE_100,
  type OwnedField,
} from "./predict-ink";
import { deriveTypeScale } from "../render/type-scale";
import { fallbackMetrics, type FontMetrics } from "../render/font-metrics";

let passed = 0;
let failed = 0;
const checks: { name: string; fn: () => void }[] = [];
const check = (name: string, fn: () => void) => checks.push({ name, fn });
const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg);
};

const CANVAS = { w: 1920, h: 1080 };

// ─── Golden fixture (embedded — see module note) ────────────────────────────

interface GoldenScene {
  build: string;
  scene: number;
  declared: { x: number; y: number; w: number; h: number };
  painted: { w: number; h: number };
  owns: string[];
  content: Record<string, unknown>;
  /** false ⇒ the render provably broke the ownership contract:
   *  flags-notion s4 dropped its owned headline (no h1 in the measured walk);
   *  flags-on-rappi s3's copy leaf duplicated the hero-owned stat + chips. */
  emissionHonoredOwnership: boolean;
}

const GOLDEN: GoldenScene[] = [{"build":"flags-notion","scene":0,"declared":{"x":310,"y":70,"w":1529,"h":210},"painted":{"w":1300,"h":190},"owns":["eyebrow","headline","lede"],"content":{"eyebrow":"BEFORE NOTION","headline":"Work stalls while you sleep","lede":"The ticket came in at 2 AM. Nobody saw it until standup."},"emissionHonoredOwnership":true},{"build":"flags-notion","scene":1,"declared":{"x":1120,"y":200,"w":700,"h":700},"painted":{"w":700,"h":581},"owns":["eyebrow","headline","lede","bullets","caption"],"content":{"eyebrow":"THE COST","headline":"Every repeatable task is a tax","lede":"Triage, resolve, respond — the same loop, every day, pulling your team out of deep work.","bullets":["Manual triage across tabs","Tickets waiting for the right person","Alerts that sit until morning"],"caption":"Three tasks · Zero agents · All manual"},"emissionHonoredOwnership":true},{"build":"flags-notion","scene":2,"declared":{"x":1040,"y":214,"w":800,"h":666},"painted":{"w":800,"h":466},"owns":["eyebrow","headline","lede","bullets"],"content":{"eyebrow":"THE TURN","headline":"Agents pick up the work","lede":"Custom Agents assign, prioritize, and route tasks on their own — summarizing, writing, and sending reports while you focus elsewhere.","bullets":["Assigns and routes on its own","Searches across all your apps","Keeps work moving 24/7"]},"emissionHonoredOwnership":true},{"build":"flags-notion","scene":3,"declared":{"x":360,"y":560,"w":1714,"h":200},"painted":{"w":1200,"h":137},"owns":["caption","bullets"],"content":{"caption":"of the Forbes Cloud 100","bullets":["Q&A agents answer instantly","Custom Agents for any repeating work","Work keeps moving 24/7"]},"emissionHonoredOwnership":true},{"build":"flags-notion","scene":4,"declared":{"x":260,"y":140,"w":1400,"h":280},"painted":{"w":1401,"h":167},"owns":["eyebrow","headline","lede"],"content":{"eyebrow":"NOTION · THE AI WORKSPACE","headline":"Where teams and agents think together.","lede":"Build Custom Agents, search across all your apps, and automate busywork — in one AI workspace."},"emissionHonoredOwnership":false},{"build":"flags-on-rappi","scene":0,"declared":{"x":360,"y":70,"w":1200,"h":110},"painted":{"w":1200,"h":95},"owns":["eyebrow","headline"],"content":{"eyebrow":"ANTES DE RAPPI","headline":"Otra espera, otra llamada"},"emissionHonoredOwnership":true},{"build":"flags-on-rappi","scene":1,"declared":{"x":100,"y":230,"w":580,"h":640},"painted":{"w":580,"h":344},"owns":["eyebrow","headline","lede","caption"],"content":{"eyebrow":"EL COSTO DE LO DE SIEMPRE","headline":"Cada día, el mismo enredo","lede":"Llamas, esperas, vuelves a llamar. El tiempo se va entre gestiones que deberían ser simples.","caption":"Y todavía no sabes cuánto va a tardar."},"emissionHonoredOwnership":true},{"build":"flags-on-rappi","scene":2,"declared":{"x":100,"y":260,"w":720,"h":560},"painted":{"w":720,"h":296},"owns":["eyebrow","headline","lede"],"content":{"eyebrow":"TODO EN UNA APP","headline":"Todo llega a tu puerta","lede":"Restaurantes, mercado y farmacias en una sola búsqueda. Pides, y Rappi hace el resto."},"emissionHonoredOwnership":true},{"build":"flags-on-rappi","scene":3,"declared":{"x":120,"y":280,"w":780,"h":520},"painted":{"w":780,"h":332},"owns":["lede"],"content":{"lede":"De McDonald's a tu tienda del barrio — los aliados que ya trabajan con Rappi."},"emissionHonoredOwnership":false},{"build":"flags-on-rappi","scene":4,"declared":{"x":120,"y":220,"w":800,"h":640},"painted":{"w":800,"h":616},"owns":["eyebrow","headline","cta","caption","meta"],"content":{"eyebrow":"ENTREGAMOS CON AMOR","headline":"Empieza con Rappi Colombia","cta":{"primary":"Comenzar","secondary":"rappi.com"},"caption":"Tus tiendas favoritas están en Rappi.","meta":[{"label":"Disponible en","value":"Colombia"}]},"emissionHonoredOwnership":true}];

/** notioninter-400 (v2, resolution "asserted"), trimmed to the fixture's glyphs. */
const CALIBRATED: FontMetrics = {
  ...fallbackMetrics("notioninter", 400),
  source: "chromium",
  resolution: "asserted",
  meanAdv: 58.56,
  fallbackAdv: 82.1,
  normalLineHeight: 1.21,
  adv: {" ":28.12,"&":63.92,"'":22.16,",":27.98,".":27.56,"/":35.65,"0":62.5,"1":46.45,"2":60.51,"4":64.21,"7":57.1,"A":67.61,"B":65.06,"C":72.73,"D":71.88,"E":59.8,"F":58.67,"G":74.29,"H":74.01,"I":26.42,"J":54.26,"K":65.2,"L":56.25,"M":88.92,"N":75.28,"O":76.14,"P":63.49,"Q":76.14,"R":63.92,"S":63.78,"T":64.21,"U":74.15,"V":67.61,"W":94.89,"X":64.21,"Y":66.48,"Z":62.5,"a":56.39,"b":62.07,"c":55.82,"d":62.07,"e":58.24,"f":36.08,"g":60.94,"h":59.09,"i":23.72,"j":23.72,"k":54.4,"l":23.72,"m":86.93,"n":58.52,"o":59.66,"p":60.94,"q":60.94,"r":37.22,"s":52.27,"t":36.36,"u":58.1,"v":55.68,"w":81.25,"x":53.98,"y":55.68,"z":54.12,"·":27.56,"Á":67.61,"Í":26.42,"Ú":74.15,"á":56.39,"í":23.72,"ú":58.1,"—":100},
  kern: {"17":0.01,"40":0.01,"41":-0.98,"44":0.01,"70":-1.56,"71":0.01,"74":-5.82,"77":2.0,"Ay":-6.81,"Av":-6.81,"Aw":-6.82,"Ar":0.01,"Fe":-3.97,"Fo":-3.97,"Fu":-3.4,"Fy":-3.41,"Fv":-3.41,"Fr":-0.57,"Fc":-3.97,"La":0.01,"Le":0.01,"Lo":0.01,"Lu":0.01,"Ly":-6.81,"Lv":-6.81,"Lá":0.01,"Pe":-0.56,"Po":-0.56,"Py":0.01,"Pv":0.01,"Ps":0.01,"Pc":-0.57,"Ta":-7.38,"Te":-7.94,"To":-7.94,"Tu":-7.38,"Ty":-6.25,"Tv":-6.25,"Tw":-6.24,"Tr":-5.67,"Ts":-7.38,"Tc":-7.95,"Tá":-7.38,"Va":-5.1,"Ve":-5.1,"Vo":-5.1,"Vw":0.01,"Vr":0.01,"Vs":-4.54,"Vc":-5.11,"Vá":-5.1,"Wa":-5.11,"We":-5.11,"Wo":-5.11,"Wr":-3.4,"Ws":-3.41,"Wc":-5.1,"Wá":-5.11,"Ya":-7.09,"Ye":-7.67,"Yo":-7.67,"Yu":-3.97,"Yy":0.01,"Yv":0.01,"Yr":-3.98,"Ys":-6.81,"Yc":-7.66,"Yá":-7.09,"Ke":-3.97,"Ko":-3.97,"Ku":-3.41,"Ky":-3.98,"Kv":-3.98,"Kw":-6.25,"Ks":0.01,"Kc":-3.98,"Re":-0.57,"Ro":-0.56,"Ru":0.01,"Rc":-0.56,"AV":-6.81,"AW":-5.67,"AY":-7.37,"AT":-8.52,"AO":-3.41,"AC":-3.4,"VA":-6.24,"VJ":-9.66,"VO":-3.41,"VC":-3.4,"WA":-5.67,"WY":0.01,"WJ":-6.24,"WO":-3.4,"WC":-3.4,"YA":-7.37,"YW":0.01,"YY":0.01,"YT":4.55,"YJ":-3.4,"YO":-3.4,"YC":-3.41,"TA":-8.52,"TT":0.01,"TJ":-9.09,"TO":-2.98,"TC":-2.98,"LA":4.56,"LV":-6.82,"LY":-3.4,"LT":-9.66,"LO":-2.84,"LC":-2.84,"PA":-7.37,"PY":0.01,"PJ":-9.65,"PC":0.01,"FA":-9.09,"FW":0.01,"FY":0.01,"FJ":-6.82,"FO":0.01,"FC":0.01,"r.":-6.24,"r,":-6.25,"v.":-3.4,"v,":-3.4,"w.":-7.39,"w,":-7.37,"y.":-3.4,"y,":-3.4,"f.":-5.67,"f,":-5.67,"T.":-3.4,"T,":-3.41,"V.":-9.66,"V,":-9.66,"W.":-9.65,"W,":-9.65,"Y.":-3.41,"Y,":-3.4,"P.":-3.4,"P,":-3.98,"F.":-3.41,"F,":-3.98,"1.":-4.26,"1,":-4.26,"7.":-12.49,"7,":-12.49,"4.":-3.4,"4,":-3.41},
};

const fieldsOf = (g: GoldenScene): OwnedField[] =>
  g.owns.map((name) => ({ name, value: g.content[name] })).filter((f) => f.value !== undefined);

// ─── The golden accuracy pin ────────────────────────────────────────────────

check("GOLDEN: height error vs the 10 measured scenes (reported per scene)", () => {
  const rows: string[] = [];
  const contract: number[] = [];
  const broken: number[] = [];
  for (const g of GOLDEN) {
    const p = predictCopyInk(fieldsOf(g), { w: g.declared.w, h: g.declared.h }, CANVAS, CALIBRATED);
    const err = (p.h - g.painted.h) / g.painted.h;
    (g.emissionHonoredOwnership ? contract : broken).push(err);
    rows.push(
      `      ${g.build} s${g.scene}: declared ${g.declared.w}×${g.declared.h} → painted h ${g.painted.h}, predicted h ${p.h} (${(err * 100).toFixed(1)}%)${g.emissionHonoredOwnership ? "" : "  [emission broke ownership]"}`,
    );
  }
  console.log(rows.join("\n"));
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const meanAbsContract = mean(contract.map(Math.abs));
  const worstContract = Math.max(...contract.map(Math.abs));
  const bias = mean(contract);
  const meanAbsAll = mean([...contract, ...broken].map(Math.abs));
  console.log(
    `      contract-honoring (n=${contract.length}): mean |hErr| ${(meanAbsContract * 100).toFixed(1)}%, worst ${(worstContract * 100).toFixed(1)}%, bias ${(bias * 100).toFixed(1)}% · all 10: mean |hErr| ${(meanAbsAll * 100).toFixed(1)}%`,
  );
  // The pins. Loosened one notch above the measured values (9.6% / 19.0% /
  // −4.9% / 18.0%) so glyph-table rounding can never flake the suite, and
  // tight enough that a real regression in the model trips them.
  assert(meanAbsContract <= 0.12, `contract-honoring mean |hErr| ${meanAbsContract} > 0.12 — the predictor regressed`);
  assert(worstContract <= 0.22, `contract-honoring worst |hErr| ${worstContract} > 0.22`);
  assert(Math.abs(bias) <= 0.08, `contract-honoring bias ${bias} — the model drifted one-sided`);
  assert(meanAbsAll <= 0.2, `all-10 mean |hErr| ${meanAbsAll} > 0.20`);
  // The premise the whole ink program rests on: the DECLARED box flatters.
  for (const g of GOLDEN) {
    assert(g.declared.w * g.declared.h >= g.painted.w * g.painted.h, `${g.build} s${g.scene}: painted exceeds declared — premise violated`);
  }
});

check("GOLDEN: predictions track painted ink far better than declared boxes do", () => {
  // The reason ink scoring exists: |declared − painted| vs |predicted − painted|.
  let declaredErr = 0;
  let predictedErr = 0;
  for (const g of GOLDEN) {
    const p = predictCopyInk(fieldsOf(g), { w: g.declared.w, h: g.declared.h }, CANVAS, CALIBRATED);
    declaredErr += Math.abs(g.declared.h - g.painted.h) / g.painted.h;
    predictedErr += Math.abs(p.h - g.painted.h) / g.painted.h;
  }
  assert(
    predictedErr < declaredErr * 0.5,
    `predicted ink (${predictedErr.toFixed(2)}) must halve the declared-box height error (${declaredErr.toFixed(2)}) or the re-score measures nothing`,
  );
});

// ─── Structural idioms ──────────────────────────────────────────────────────

check("empty fields → zero ink, zero blocks", () => {
  const p = predictCopyInk([], { w: 800, h: 600 }, CANVAS, CALIBRATED);
  assert(p.blocks === 0 && p.h === 0 && p.w === 0, `expected empty prediction, got ${JSON.stringify(p)}`);
  const p2 = predictCopyInk([{ name: "headline", value: "   " }], { w: 800, h: 600 }, CANVAS, CALIBRATED);
  assert(p2.blocks === 0, "whitespace-only content must not count as a block");
});

check("chip idiom: short bullets in a wide strip pack into rows, not stacked lines", () => {
  const bullets = ["Fast setup", "No config", "Ships today"];
  const strip = predictCopyInk([{ name: "bullets", value: bullets }], { w: 1600, h: 200 }, CANVAS, CALIBRATED);
  const column = predictCopyInk([{ name: "bullets", value: bullets }], { w: 500, h: 700 }, CANVAS, CALIBRATED);
  // Same content: the strip's chip row must be SHORTER than the column's
  // stacked rows even though the strip derives an equal-or-larger type step.
  assert(strip.h < column.h, `strip chips (${strip.h}) must be shorter than stacked rows (${column.h})`);
});

check("cta renders as button chrome, one per value", () => {
  const bare = predictCopyInk([{ name: "caption", value: "Comenzar" }], { w: 800, h: 600 }, CANVAS, CALIBRATED);
  const cta = predictCopyInk([{ name: "cta", value: "Comenzar" }], { w: 800, h: 600 }, CANVAS, CALIBRATED);
  assert(cta.h > bare.h, `a CTA (${cta.h}) must be taller than the same string as caption (${bare.h})`);
  const two = predictCopyInk([{ name: "cta", value: { primary: "Comenzar", secondary: "rappi.com" } }], { w: 800, h: 600 }, CANVAS, CALIBRATED);
  assert(two.h > cta.h, `a two-value CTA (${two.h}) must be taller than one button (${cta.h})`);
});

check("meta renders one row per entry", () => {
  const one = predictCopyInk([{ name: "meta", value: [{ label: "A", value: "1" }] }], { w: 700, h: 700 }, CANVAS, CALIBRATED);
  const three = predictCopyInk(
    [{ name: "meta", value: [{ label: "A", value: "1" }, { label: "B", value: "2" }, { label: "C", value: "3" }] }],
    { w: 700, h: 700 },
    CANVAS,
    CALIBRATED,
  );
  assert(three.h > one.h, `three meta rows (${three.h}) must out-height one (${one.h})`);
});

check("deterministic: identical input → byte-identical prediction", () => {
  const fields: OwnedField[] = [
    { name: "eyebrow", value: "THE TURN" },
    { name: "headline", value: "Agents pick up the work" },
    { name: "bullets", value: ["a", "b", "c"] },
  ];
  const a = JSON.stringify(predictCopyInk(fields, { w: 800, h: 666 }, CANVAS, CALIBRATED));
  const b = JSON.stringify(predictCopyInk(fields, { w: 800, h: 666 }, CANVAS, CALIBRATED));
  assert(a === b, "prediction is not deterministic");
});

check("typicalSansMetrics is a PREDICTION posture, distinct from the budget fallback", () => {
  const t = typicalSansMetrics();
  assert(t.meanAdv === TYPICAL_SANS_ADVANCE_100 && t.fallbackAdv === TYPICAL_SANS_ADVANCE_100, "typical sans must use the 0.52em prediction advance");
  assert(fallbackMetrics("sans-serif", 400).meanAdv > t.meanAdv, "the budget fallback must stay wider than the prediction posture");
});

// ─── predictInkRect placement ───────────────────────────────────────────────

check("ink rect is top-left anchored in the declared bounds, full measure, unclipped", () => {
  const g = GOLDEN[2]; // notion s2 — the founder's own example (800×666 → 800×466)
  const { rect, prediction } = predictInkRect(g.declared, fieldsOf(g), CANVAS, CALIBRATED);
  assert(rect.x === g.declared.x && rect.y === g.declared.y, "ink must anchor at the box's top-left");
  assert(rect.w === g.declared.w, "ink width = the measure");
  assert(rect.h === prediction.h && rect.h < g.declared.h, `ink height ${rect.h} must be the prediction, under the declared ${g.declared.h}`);
});

// ─── inkSizedBox (the RB_ALLOCATE sizing primitive) ─────────────────────────

check("inkSizedBox shrinks a flattering box and accounts the freed px", () => {
  const g = GOLDEN[2];
  const r = inkSizedBox(g.declared, fieldsOf(g), CANVAS, CALIBRATED);
  assert(!r.kept, "an over-declared box must shrink");
  assert(r.box.w === g.declared.w, "the measure must be preserved verbatim");
  assert(r.box.h < g.declared.h, `h ${r.box.h} must shrink under ${g.declared.h}`);
  assert(r.box.h >= r.prediction.h, "the box must still hold its own predicted ink");
  assert(r.freedPx === g.declared.w * g.declared.h - r.box.w * r.box.h, "freedPx must equal the exact area delta");
});

check("inkSizedBox NEVER grows: ink exceeding the box keeps the box (flagged kept)", () => {
  const fields: OwnedField[] = [
    { name: "headline", value: "A very long headline that wraps and wraps and wraps across many lines of the column" },
    { name: "lede", value: "And a long lede that keeps adding wrapped lines to the stack so the ink cannot fit the box at all." },
  ];
  const tight = { w: 400, h: 120 };
  const r = inkSizedBox(tight, fields, CANVAS, CALIBRATED);
  assert(r.kept, "an under-declared box must be KEPT, not grown");
  assert(r.box.w === tight.w && r.box.h === tight.h, "kept box must be byte-identical");
  assert(r.freedPx === 0, "a kept box frees nothing");
});

check("inkSizedBox preserves the type-scale step (budget/box consistency by construction)", () => {
  for (const g of GOLDEN) {
    const fields = fieldsOf(g);
    if (fields.length === 0) continue;
    const r = inkSizedBox(g.declared, fields, CANVAS, CALIBRATED);
    const after = deriveTypeScale({ role: "copy", box: r.box, canvas: CANVAS });
    assert(
      after.step === r.prediction.scale.step,
      `${g.build} s${g.scene}: step drifted ${r.prediction.scale.step} → ${after.step} after sizing-to-ink — box and budget would disagree`,
    );
  }
});

check("INK_MODEL constants are frozen at their calibrated values", () => {
  // Not ceremony: the golden pins above hold only at THESE constants. A tune
  // must re-run the golden and update both together.
  assert(INK_MODEL.BLOCK_GAP_EM === 1.3 && INK_MODEL.CONTAINER_PAD_EM === 0.9 && INK_MODEL.CTA_CHROME_EM === 1.7, "structural ems changed");
  assert(INK_MODEL.CHIP_MAX_CHARS === 40 && INK_MODEL.STRIP_ASPECT === 4, "chip idiom thresholds changed");
});

for (const { name, fn } of checks) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : err}`);
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
