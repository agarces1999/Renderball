// Build .data/dogfood/frameauth-klarna/compare.html — a scene-by-scene gallery:
// reference (60-min GLM) on top, old cast (v8) middle, new frame-authoring build
// bottom. Relative image paths (open the HTML from its own dir).
import { writeFileSync, existsSync } from "fs";
import { join } from "path";

const OUT = process.env.RB_FA_OUT ?? join(process.cwd(), ".data", "dogfood", "frameauth-klarna");
const REF = "../../acceptance8/reference"; // reference frames (relative to OUT)
const V8 = "../../acceptance8/v8"; // old-cast frames
const NEW = "frames"; // this build's frames

const scenes = [0, 1, 2, 3, 4];
const rows = [
  { label: "REFERENCE — 60-min GLM 5.2 (the bar)", dir: REF, abs: join(process.cwd(), ".data/acceptance8/reference") },
  { label: "OLD CAST — v8 (before this PR)", dir: V8, abs: join(process.cwd(), ".data/acceptance8/v8") },
  { label: "NEW — frame-authoring (this PR)", dir: NEW, abs: join(OUT, "frames") },
];

const cell = (dir, i, abs) => {
  const present = existsSync(join(abs, `scene${i}.png`));
  return present
    ? `<img src="${dir}/scene${i}.png" alt="scene ${i}" loading="lazy">`
    : `<div class="missing">scene ${i} — not rendered</div>`;
};

const sceneBlock = (i) => `
  <section class="scene">
    <h2>Scene ${i}</h2>
    <div class="grid">
      ${rows.map((r) => `<figure><figcaption>${r.label}</figcaption>${cell(r.dir, i, r.abs)}</figure>`).join("\n      ")}
    </div>
  </section>`;

const html = `<!doctype html><meta charset="utf-8"><title>Frame-authoring vs reference — Klarna</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #0b0b10; color: #e8e8ee; font: 14px/1.5 -apple-system, system-ui, sans-serif; }
  header { padding: 24px 32px; border-bottom: 1px solid #232330; }
  header h1 { margin: 0 0 6px; font-size: 20px; }
  header p { margin: 0; color: #9a9ab0; max-width: 900px; }
  .scene { padding: 24px 32px; border-bottom: 1px solid #1a1a24; }
  .scene h2 { margin: 0 0 12px; font-size: 15px; color: #b8b8d0; letter-spacing: .04em; text-transform: uppercase; }
  .grid { display: grid; grid-template-columns: 1fr; gap: 16px; }
  figure { margin: 0; background: #000; border-radius: 8px; overflow: hidden; border: 1px solid #232330; }
  figcaption { padding: 8px 12px; font-size: 12px; color: #8a8aa0; background: #12121a; border-bottom: 1px solid #232330; }
  img { display: block; width: 100%; height: auto; }
  .missing { aspect-ratio: 16/9; display: flex; align-items: center; justify-content: center; color: #e0245e; border: 2px dashed #e0245e; }
  @media (min-width: 1200px) { .grid { grid-template-columns: repeat(3, 1fr); } }
</style>
<header>
  <h1>Frame-authoring vs the 60-min reference — Klarna</h1>
  <p>Same script (the reference build's own script.json, scene-0 headline &ldquo;You know the feeling&rdquo;) held constant.
  Top = the 60-min GLM 5.2 reference (the bar). Middle = the old cast (v8, pre-PR). Bottom = the NEW frame-authoring head + cast (this PR).
  The variable isolated is the composition/emission code.</p>
</header>
${scenes.map(sceneBlock).join("\n")}
`;

writeFileSync(join(OUT, "compare.html"), html);
console.log(`wrote ${join(OUT, "compare.html")}`);
