/**
 * Measure REAL character capacity per content role — the Layer-3 upstream
 * numbers (docs/TEXT_FIT.md): "measure each slot's real capacity ONCE,
 * offline, with real fonts, and put the budget in the generation schema."
 *
 * Method: render live text in Chromium at each role's ramp size inside the
 * CONSERVATIVE canonical copy column (780px — the narrowest 16:9 copy slot in
 * layout-composer; centered=960, band=900). Measure chars-per-line by filling
 * a line to just-before-wrap with pangram-ish prose, then multiply by the
 * lines the slot affords. Fonts: a WIDTH SPREAD of faces decks actually
 * resolve to (brand faces are unknowable upstream) — the WIDEST wins so the
 * budget survives wide brands.
 *
 *   node scripts/measure-copy-budgets.mjs
 */
import { chromium } from "playwright";

const COL = 780;
const FACES = [
  "Verdana, sans-serif",          // one of the widest common sans — the bound
  "Georgia, serif",
  "Arial, Helvetica, sans-serif",
  "system-ui, sans-serif",
];
// role → { px, weight, lines, sample } (ramp heads from type-scale.ts; lines
// from the canonical copy-slot heights at that size incl. line-height 1.1/1.4)
const ROLES = {
  headline: { px: 84, weight: 700, lines: 3, lh: 1.05 },
  lede: { px: 24, weight: 400, lines: 4, lh: 1.45 },
  bullet: { px: 20, weight: 400, lines: 2, lh: 1.4 },
  caption: { px: 16, weight: 400, lines: 2, lh: 1.4 },
  eyebrow: { px: 14, weight: 600, lines: 1, lh: 1.2, tracking: "0.14em", upper: true },
};
const PROSE = "The quick brown fox jumps over the lazy dog while measured capacity holds every claim to account across long real sentences";

const run = async () => {
  const b = await chromium.launch();
  const page = await (await b.newContext()).newPage();
  await page.setContent(`<div id="box" style="width:${COL}px"></div>`);
  const out = {};
  for (const [role, spec] of Object.entries(ROLES)) {
    let worstCpl = Infinity;
    let worstFace = "";
    for (const face of FACES) {
      const cpl = await page.evaluate(
        ([spec2, face2, prose]) => {
          const box = document.getElementById("box");
          const el = document.createElement("div");
          el.style.cssText = `font-family:${face2};font-size:${spec2.px}px;font-weight:${spec2.weight};line-height:${spec2.lh};letter-spacing:${spec2.tracking || "normal"};white-space:normal;word-break:normal;`;
          box.innerHTML = "";
          box.appendChild(el);
          const text = spec2.upper ? prose.toUpperCase() : prose;
          // grow until the FIRST wrap: chars-per-line at this face/size/col
          let n = 8;
          el.textContent = text.slice(0, n);
          const oneLine = el.getBoundingClientRect().height;
          while (n < text.length) {
            el.textContent = text.slice(0, n + 1);
            if (el.getBoundingClientRect().height > oneLine * 1.5) break;
            n += 1;
          }
          return n;
        },
        [spec, face, PROSE],
      );
      if (cpl < worstCpl) {
        worstCpl = cpl;
        worstFace = face.split(",")[0];
      }
    }
    // Budget = conservative chars/line × affordable lines, minus a word of
    // slack so a budget-exact string still wraps clean (never mid-word cliff).
    const budget = Math.floor(worstCpl * spec.lines * 0.94);
    out[role] = { budget, cpl: worstCpl, lines: spec.lines, px: spec.px, boundFace: worstFace };
    console.log(`${role.padEnd(9)} ${String(spec.px).padStart(3)}px × ${spec.lines} line(s) @ ${COL}px — ${worstCpl} cpl (${worstFace}) → budget ${budget}`);
  }
  await b.close();
  console.log("\nJSON:", JSON.stringify(out));
};
void run();
