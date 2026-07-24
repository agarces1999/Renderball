/**
 * Snapshot real built decks into components/demo-decks.ts for the landing.
 *
 *   node scripts/snapshot-demo-decks.mjs <scriptId> [<scriptId> …]
 *
 * The landing claims "real elements, never images", so its proof can't be a
 * screenshot. This SSRs each scene through the SAME renderer the preview and
 * the PDF export use (lib/render/scene-iframe.ts, settle mode), lifts the
 * slide's markup out of the returned document, and writes it into a typed
 * module the landing inlines.
 *
 * Safety: <script> tags are stripped (the lottie/lockup mounts are runtime
 * conveniences the landing doesn't need, and inlining third-party script into
 * a marketing page is a needless hole). Sizes are reported per slide because
 * this ships in the landing's payload.
 */
import { promises as fs } from "fs";
import path from "path";
import * as esbuild from "esbuild";

const ids = process.argv.slice(2);
if (ids.length === 0) {
  console.error("usage: node scripts/snapshot-demo-decks.mjs <scriptId> [...]");
  process.exit(1);
}

const OUT = path.join(process.cwd(), "components", "demo-decks.ts");
const TMP = path.join(process.cwd(), ".snapshot-scene-iframe.cjs");

// Bundle the real renderer so this script uses production code paths.
await esbuild.build({
  entryPoints: [path.join(process.cwd(), "lib", "render", "scene-iframe.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outfile: TMP,
  external: ["react", "react-dom", "react-dom/server", "esbuild", "recharts", "lucide-react", "shiki", "simple-icons", "remotion", "@remotion/lottie"],
  logLevel: "silent",
});
const { renderSceneDoc } = await import(`file://${TMP}`);

/** Pull the slide's markup out of the returned document. */
const extractCanvas = (doc) => {
  const open = doc.indexOf('<div class="renderball-canvas">');
  if (open === -1) return null;
  const start = open + '<div class="renderball-canvas">'.length;
  // The canvas div is closed by the last </div> before the trailing scripts.
  const tail = doc.lastIndexOf("</div>");
  if (tail <= start) return null;
  return doc.slice(start, tail);
};

const stripScripts = (html) =>
  html.replace(/<script\b[\s\S]*?<\/script>/gi, "").trim();

/**
 * The build inlines brand webfonts as base64 @font-face — right for the PDF
 * and MP4 renders (they must be self-contained), catastrophic for a landing:
 * one 94 KB face repeated per slide was 474 KB of the first snapshot. The
 * families here (Cabinet Grotesk, Geist, Geist Mono) are ALREADY loaded by
 * app/layout.tsx from CDN, so dropping the embedded copies costs nothing
 * visually — the slides resolve the same families off the page.
 */
const PAGE_FONTS = /"?(Cabinet Grotesk|Geist Mono|Geist)"?/i;
const stripPageFonts = (html) =>
  html.replace(/@font-face\s*\{[^}]*\}/gi, (block) =>
    PAGE_FONTS.test(block) ? "" : block,
  );

/** Collapse the SSR pretty-printing; inline styles keep their semantics. */
const minify = (html) =>
  html
    .replace(/>\s+</g, "><")
    .replace(/\s{2,}/g, " ")
    .trim();

/** First background declaration on the outermost element = the canvas color. */
const sniff = (html) => {
  const bg = html.match(/background(?:-color)?:\s*([^;"']+)/i)?.[1]?.trim();
  const colors = [...html.matchAll(/#[0-9a-f]{6}\b/gi)].map((m) => m[0].toLowerCase());
  const freq = new Map();
  for (const c of colors) freq.set(c, (freq.get(c) ?? 0) + 1);
  const ranked = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  return {
    bg: bg && bg.length < 120 ? bg : (ranked[0] ?? "#ffffff"),
    ink: ranked[1] ?? "#10141c",
    accent: ranked[2] ?? ranked[1] ?? "#00c28a",
  };
};

const decks = [];
for (const id of ids) {
  const dir = path.join(process.cwd(), "src", "generated", id);
  let script;
  try {
    script = JSON.parse(await fs.readFile(path.join(dir, "script.json"), "utf8"));
  } catch {
    console.error(`✗ ${id}: no script.json — build it first`);
    continue;
  }
  const slides = [];
  for (let i = 0; i < script.scenes.length; i++) {
    const r = await renderSceneDoc(id, i, script, { settle: true });
    if (!r.ok) {
      console.error(`  ✗ scene ${i}: ${r.message}`);
      continue;
    }
    const raw = extractCanvas(r.html);
    if (!raw) {
      console.error(`  ✗ scene ${i}: could not isolate the canvas`);
      continue;
    }
    const html = minify(stripPageFonts(stripScripts(raw)));
    const { bg, ink, accent } = sniff(html);
    slides.push({ label: script.scenes[i].label ?? `Slide ${i + 1}`, bg, ink, accent, html });
    console.log(`  ✓ scene ${i} "${script.scenes[i].label}" — ${(html.length / 1024).toFixed(1)} KB`);
  }
  decks.push({ id, note: script.narrative?.logline?.slice(0, 120) ?? "", slides });
}

const header = await fs.readFile(OUT, "utf8").then((s) => s.slice(0, s.indexOf("export const DEMO_DECKS")));
const body = `export const DEMO_DECKS: DemoDeck[] = ${JSON.stringify(decks, null, 2)};\n`;
await fs.writeFile(OUT, header + body, "utf8");
await fs.rm(TMP, { force: true });

const total = decks.reduce((n, d) => n + d.slides.reduce((m, s) => m + s.html.length, 0), 0);
console.log(`\nwrote ${decks.length} deck(s), ${decks.reduce((n, d) => n + d.slides.length, 0)} slides → components/demo-decks.ts`);
console.log(`total inlined markup: ${(total / 1024).toFixed(1)} KB (pre-gzip)`);
