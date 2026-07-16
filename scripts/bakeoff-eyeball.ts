/**
 * EYEBALL GALLERY — the founder-judgment surface for the model bake-off.
 *
 * The bake-off harness (scripts/model-bakeoff.mjs) scores syntax + speed, but the
 * decision needs EYES: what does each provider's generated element output LOOK
 * like when mounted in the real reference build? This tool renders scenes 0-2 of
 * the reference HubSpot build once per provider — each provider's generated piece
 * bodies swapped into the REAL composition — and emits a static side-by-side
 * gallery of screenshots.
 *
 *   node scripts/bakeoff-eyeball.mjs [runFile...]
 *     default: the newest .data/bakeoff/*.json PER PROVIDER (a provider appears
 *     once, from the most recent run that contains it). Unparseable files (a
 *     bake-off may be mid-write) are skipped with a note.
 *
 * Output:
 *   .data/bakeoff/eyeball/<provider>/scene<N>.png   1920x1080, settled state
 *   .data/bakeoff/eyeball/index.html                rows = scenes, cols = providers
 *   .data/bakeoff/eyeball/.work/<provider>/         the assembled genDir (debuggable)
 *
 * MANIFEST → ASSEMBLY MAPPING (documented adaptation):
 * The reference build's lego/manifest.json is a serialized `Decomposed` tree
 * (lego-store `Manifest`: preamble + tail + per-scene Section `template` with
 * `{/*RB:id*​/}` slots), NOT a piece-model `SceneManifest[]`. Piece bounds live
 * INSIDE the self-positioned piece bodies, so `assembleComposition`'s
 * `AssembleInput` (theme + bounds-carrying manifests) does not map onto it.
 * The production machinery for THIS artifact is `readDecomposed` +
 * `reassemble` — exactly what `reassembleFromDisk` runs after every piece
 * edit/regen — so that is what we use, with `bodyOf` swapping in each
 * provider's generated bodies for scenes 0-2. Scenes 3-4 keep their original
 * bodies purely so the composition compiles (the tail's `Generated` references
 * Section3/4); they are never rendered here.
 *
 * HONESTY RULES:
 *  - An element that failed (`ok: false`), is missing from the run, has no
 *    persisted `code` (pre-fix runs), or fails the in-context syntax check gets
 *    a clearly-labeled dashed-border placeholder at its kind's nominal bounds —
 *    the eyeball sees the failure, never a silent gap.
 *  - Generated code is passed through normalizeElementColors (the production
 *    hue-lock) against the brand palette parsed from the manifest preamble's
 *    PALETTE const, exactly as cast-build.ts does before shipping an element.
 *
 * Rendering reuses lib/render/measure-scene.ts verbatim — the same
 * esbuild-bundle + Playwright mount + settle-animations + 1920x1080 screenshot
 * path the render-truth gates use, so "looks like this here" == "looks like
 * this in the preview/MP4".
 */
import { promises as fs } from "fs";
import path from "path";
import * as esbuild from "esbuild";
import { reassemble, type Decomposed, type DecomposedPiece } from "../lib/agents/lego-decompose";
import { readDecomposed } from "../lib/agents/lego-store";
import { normalizeElementColors } from "../lib/agents/normalize-element";
import { measureScenes } from "../lib/render/measure-scene";

const ROOT = process.cwd();
const BAKEOFF_DIR = path.join(ROOT, ".data", "bakeoff");
const EYEBALL_DIR = path.join(BAKEOFF_DIR, "eyeball");
const SCENE_INDICES = [0, 1, 2];
/** z.ai baseline first, then the harness's provider order; unknowns append. */
const PROVIDER_ORDER = ["zai-glm52", "sonnet5", "haiku45", "opus48", "together-glm", "cerebras", "gemini"];

// ── run-file shapes (what model-bakeoff.mjs persists) ────────────────────────

interface RunElement {
  id: string;
  kind: string;
  out: number;
  secs: number;
  visible: number;
  thinking: number;
  ok: boolean;
  stop: string;
  /** The emitted JSX — persisted since the eyeball fix; absent on older runs. */
  code?: string;
}
interface RunResult {
  elements?: RunElement[];
  head?: { out: number; secs: number; ok: boolean; stop?: string } | null;
  errors?: string[];
}
interface RunFile {
  ref: string;
  results: Record<string, RunResult>;
}

interface ProviderRun {
  provider: string;
  file: string;
  ref: string;
  result: RunResult;
}

// ── input selection ──────────────────────────────────────────────────────────

/** Read + parse one run file; null (with a note) when unparseable/not-a-run —
 *  a bake-off may be writing a new JSON concurrently, so never assume validity. */
const readRun = async (file: string): Promise<RunFile | null> => {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as RunFile;
    if (!parsed || typeof parsed.ref !== "string" || typeof parsed.results !== "object" || parsed.results === null) {
      console.warn(`skip (not a bake-off run): ${file}`);
      return null;
    }
    return parsed;
  } catch (err) {
    console.warn(`skip (unreadable/unparseable — possibly mid-write): ${file} — ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    return null;
  }
};

/** Resolve the provider runs to render: explicit files, or newest-per-provider
 *  across .data/bakeoff/*.json. */
const selectRuns = async (args: string[]): Promise<ProviderRun[]> => {
  let files: string[];
  if (args.length > 0) {
    files = args.map((a) => path.resolve(ROOT, a));
  } else {
    const names = (await fs.readdir(BAKEOFF_DIR).catch(() => [] as string[])).filter((n) => n.endsWith(".json"));
    const stats = await Promise.all(
      names.map(async (n) => {
        const p = path.join(BAKEOFF_DIR, n);
        const s = await fs.stat(p).catch(() => null);
        return { p, mtime: s?.mtimeMs ?? 0 };
      }),
    );
    files = stats.sort((a, b) => b.mtime - a.mtime).map((s) => s.p); // newest first
  }

  const chosen = new Map<string, ProviderRun>();
  for (const file of files) {
    const run = await readRun(file);
    if (!run) continue;
    for (const [provider, result] of Object.entries(run.results)) {
      if (!Array.isArray(result?.elements) || result.elements.length === 0) continue;
      if (chosen.has(provider)) continue; // newest-first scan: first hit wins
      chosen.set(provider, { provider, file, ref: run.ref, result });
    }
  }
  const order = (id: string): number => {
    const i = PROVIDER_ORDER.indexOf(id);
    return i === -1 ? PROVIDER_ORDER.length : i;
  };
  return [...chosen.values()].sort((a, b) => order(a.provider) - order(b.provider) || a.provider.localeCompare(b.provider));
};

// ── palette (the hue vocabulary the production normalizer locks to) ──────────

/** Parse the brand hexes out of the manifest preamble's `const PALETTE = {...}`
 *  block (the design agent emits palette keys as crawled brand hexes). */
const extractPalette = (preamble: string): string[] => {
  const start = preamble.indexOf("const PALETTE");
  if (start === -1) return [];
  const close = preamble.indexOf("}", start);
  const block = preamble.slice(start, close === -1 ? start + 2000 : close);
  return [...new Set(block.match(/#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g) ?? [])];
};

// ── placeholder (the honest failure surface) ─────────────────────────────────

/** Nominal per-kind bounds — the SAME table the bake-off briefs gave every
 *  provider (model-bakeoff.mjs BOUNDS), so a placeholder sits where the real
 *  element was asked to live. */
const KIND_BOUNDS: Record<string, { x: number; y: number; w: number; h: number }> = {
  atmosphere: { x: 0, y: 0, w: 1920, h: 1080 },
  text: { x: 120, y: 260, w: 700, h: 420 },
  diegetic: { x: 960, y: 200, w: 820, h: 640 },
  image: { x: 960, y: 200, w: 820, h: 640 },
  chrome: { x: 0, y: 1000, w: 1920, h: 80 },
};

/** A dashed-border, loudly-labeled placeholder body. `stagger` offsets the label
 *  so two full-bleed placeholders in one scene don't overlap their chips. */
const placeholderBody = (piece: DecomposedPiece, reason: string, stagger: number): string => {
  const b = KIND_BOUNDS[piece.kind] ?? KIND_BOUNDS.diegetic;
  const label = `${piece.id} — ${reason}`;
  return [
    `<div style={{ position: "absolute", left: ${b.x}, top: ${b.y}, width: ${b.w}, height: ${b.h}, zIndex: 400, pointerEvents: "none", boxSizing: "border-box", border: "3px dashed #e0245e", background: "rgba(224, 36, 94, 0.05)" }}>`,
    `  <div style={{ position: "absolute", left: 14, top: ${14 + stagger * 52}, maxWidth: ${Math.max(b.w - 28, 200)}, fontFamily: "ui-monospace, Menlo, monospace", fontSize: 24, fontWeight: 700, color: "#ffffff", background: "#e0245e", padding: "6px 14px", borderRadius: 4, whiteSpace: "nowrap" }}>{${JSON.stringify(label)}}</div>`,
    `</div>`,
  ].join("\n");
};

/** Same in-context syntax probe the harness uses — protects the whole-provider
 *  composition from one truncated/broken body taking down all three scenes. */
const syntaxOk = async (frag: string): Promise<boolean> => {
  try {
    await esbuild.transform(`export const T = () => (<div>${frag}</div>);`, { loader: "tsx" });
    return true;
  } catch {
    return false;
  }
};

// ── per-provider assembly + render ───────────────────────────────────────────

interface CellStats {
  okCount: number;
  total: number;
  meanSecs: number;
  meanOut: number;
  locked: number; // off-brand colors hue-locked by the normalizer
  placeholders: number;
}
interface Cell {
  png?: string; // relative to EYEBALL_DIR
  error?: string;
  stats: CellStats;
}
interface Column {
  provider: string;
  runFile: string;
  ref: string;
  head: RunResult["head"];
  cells: Map<number, Cell>;
}

const SHIMS = ["Img.tsx", "Piece.tsx", "BrandChrome.tsx", "Lottie.tsx", "Video.tsx"];
const safeDirName = (id: string): string => id.replace(/[^a-zA-Z0-9_-]/g, "_");
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

const renderProvider = async (
  run: ProviderRun,
  d: Decomposed,
  palette: string[],
  genDir: string,
): Promise<Column> => {
  const provDir = safeDirName(run.provider);
  const workDir = path.join(EYEBALL_DIR, ".work", provDir);
  const outDir = path.join(EYEBALL_DIR, provDir);
  await fs.rm(workDir, { recursive: true, force: true });
  await fs.rm(outDir, { recursive: true, force: true }); // never leave stale screenshots lying
  await fs.mkdir(workDir, { recursive: true });
  await fs.mkdir(outDir, { recursive: true });

  const byId = new Map((run.result.elements ?? []).map((e) => [e.id, e]));

  // Resolve every scene-0..2 piece body up front (async syntax probe), so the
  // reassemble callback below stays sync like production's.
  const bodies = new Map<string, string>();
  const lockedByScene = new Map<number, number>();
  const placeholdersByScene = new Map<number, number>();
  for (const scene of d.scenes) {
    if (!SCENE_INDICES.includes(scene.sceneIndex)) continue;
    // Label chips stagger only among placeholders sharing the SAME bounds (two
    // full-bleed atmospheres) — a global counter would push a short bar's label
    // (chrome, 80px tall) outside its own box.
    const staggerByBounds = new Map<string, number>();
    for (const piece of scene.pieces) {
      const entry = byId.get(piece.id);
      let reason: string | null;
      if (!entry) reason = "MISSING FROM RUN";
      else if (!entry.ok) reason = `FAILED (${entry.stop || "unknown"})`;
      else if (!entry.code) reason = "OK BUT NO CODE PERSISTED (pre-fix run)";
      else if (!(await syntaxOk(entry.code))) reason = "SYNTAX FAIL IN CONTEXT";
      else reason = null;

      if (reason !== null) {
        const b = KIND_BOUNDS[piece.kind] ?? KIND_BOUNDS.diegetic;
        const boundsKey = `${b.x},${b.y}`;
        const stagger = staggerByBounds.get(boundsKey) ?? 0;
        staggerByBounds.set(boundsKey, stagger + 1);
        bodies.set(piece.id, placeholderBody(piece, reason, stagger));
        placeholdersByScene.set(scene.sceneIndex, (placeholdersByScene.get(scene.sceneIndex) ?? 0) + 1);
        continue;
      }
      // Production post-pass: hue-lock off-brand colors (cast-build.ts does the
      // same before an element ships). Skip only when the palette parse failed.
      let code = entry!.code!;
      if (palette.length > 0) {
        const norm = normalizeElementColors(code, palette);
        code = norm.code;
        const locked = norm.changes.reduce((n, c) => n + c.count, 0);
        lockedByScene.set(scene.sceneIndex, (lockedByScene.get(scene.sceneIndex) ?? 0) + locked);
      }
      bodies.set(piece.id, code);
    }
  }

  // Reassemble with the production splicer: provider bodies for scenes 0-2,
  // original bodies for 3-4 (compile-safety only — never rendered here).
  const composition = reassemble(d, (sceneIndex, piece) =>
    SCENE_INDICES.includes(sceneIndex) ? (bodies.get(piece.id) ?? piece.body) : piece.body,
  );
  await fs.writeFile(path.join(workDir, "Composition.tsx"), composition, "utf8");
  for (const shim of SHIMS) {
    await fs.copyFile(path.join(genDir, shim), path.join(workDir, shim)).catch(() => {});
  }

  // Render via the production render-truth path (bundle → mount → settle →
  // 1920x1080 screenshot). Slicing the script to 3 scenes limits the walk to
  // Section0-2 (measure-scene derives sceneCount from script.scenes.length).
  const script = JSON.parse(await fs.readFile(path.join(genDir, "script.json"), "utf8"));
  const sliced = { ...script, scenes: (script.scenes ?? []).slice(0, SCENE_INDICES.length) };
  const measurements = await measureScenes(workDir, sliced, workDir);

  const cells = new Map<number, Cell>();
  for (const i of SCENE_INDICES) {
    const scene = d.scenes.find((s) => s.sceneIndex === i);
    const pieces = scene?.pieces ?? [];
    const entries = pieces.map((p) => byId.get(p.id)).filter((e): e is RunElement => !!e);
    const stats: CellStats = {
      okCount: entries.filter((e) => e.ok).length,
      total: pieces.length,
      meanSecs: mean(entries.map((e) => e.secs)),
      meanOut: mean(entries.map((e) => e.out)),
      locked: lockedByScene.get(i) ?? 0,
      placeholders: placeholdersByScene.get(i) ?? 0,
    };
    const m = measurements.find((mm) => mm.scene === i);
    const shot = path.join(workDir, `measure-scene-${i}.png`);
    const exists = await fs.stat(shot).then(() => true).catch(() => false);
    if (m?.error || !exists) {
      cells.set(i, { error: m?.error ?? "no screenshot produced", stats });
      continue;
    }
    const rel = path.posix.join(provDir, `scene${i}.png`);
    await fs.copyFile(shot, path.join(outDir, `scene${i}.png`));
    cells.set(i, { png: rel, stats });
  }
  return { provider: run.provider, runFile: run.file, ref: run.ref, head: run.result.head ?? null, cells };
};

// ── the gallery ──────────────────────────────────────────────────────────────

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** "2026-07-14T01-01-19-481Z.json" → "2026-07-14T01:01:19.481Z" for display. */
const runTimestamp = (file: string): string => {
  const base = path.basename(file, ".json");
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d+)Z$/.exec(base);
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : base;
};

const galleryHtml = (columns: Column[]): string => {
  const cols = columns.length;
  const header = columns
    .map((c) => {
      const head = c.head
        ? `head: ${c.head.ok ? "ok" : "FAIL"} · ${Math.round(c.head.out)} tok · ${c.head.secs.toFixed(0)}s`
        : "head: —";
      return `<div class="prov">
        <div class="prov-name">${esc(c.provider)}</div>
        <div class="prov-meta">${esc(runTimestamp(c.runFile))}</div>
        <div class="prov-meta">${esc(head)}</div>
      </div>`;
    })
    .join("\n");

  const rows = SCENE_INDICES.map((i) => {
    const cells = columns
      .map((c) => {
        const cell = c.cells.get(i);
        if (!cell) return `<div class="cell"><div class="err">no data</div></div>`;
        const s = cell.stats;
        const stat = `${s.okCount}/${s.total} ok · ${s.meanSecs.toFixed(1)}s mean · ${Math.round(s.meanOut)} tok mean` +
          (s.placeholders ? ` · ${s.placeholders} placeholder${s.placeholders === 1 ? "" : "s"}` : "") +
          (s.locked ? ` · ${s.locked} colors hue-locked` : "");
        const visual = cell.png
          ? `<a href="${esc(cell.png)}" target="_blank"><img src="${esc(cell.png)}" alt="${esc(c.provider)} scene ${i}"></a>`
          : `<div class="err">RENDER FAILED<br><span>${esc(cell.error ?? "")}</span></div>`;
        return `<div class="cell">${visual}<div class="stat">${esc(stat)}</div></div>`;
      })
      .join("\n");
    return `<div class="scene-label">scene ${i}</div>\n${cells}`;
  }).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bake-off eyeball gallery</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0e0f12; color: #e8e8ea; font: 14px/1.45 ui-sans-serif, system-ui, sans-serif; padding: 28px; }
  h1 { font-size: 20px; font-weight: 700; letter-spacing: 0.01em; }
  .sub { color: #9a9aa3; margin: 6px 0 24px; font-size: 13px; }
  .grid { display: grid; grid-template-columns: 92px repeat(${cols}, minmax(360px, 1fr)); gap: 14px; align-items: start; }
  .corner { }
  .prov { padding: 4px 2px; }
  .prov-name { font-size: 16px; font-weight: 700; color: #ffffff; }
  .prov-meta { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #8a8a93; margin-top: 2px; }
  .scene-label { font-family: ui-monospace, Menlo, monospace; font-size: 12px; color: #8a8a93; padding-top: 8px; position: sticky; left: 0; }
  .cell { background: #16171c; border: 1px solid #26272e; border-radius: 8px; padding: 8px; }
  .cell img { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: contain; border-radius: 4px; background: #000; }
  .cell a { display: block; }
  .stat { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #a9aab3; margin-top: 8px; }
  .err { aspect-ratio: 16 / 9; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
         border: 2px dashed #e0245e; border-radius: 4px; color: #e0245e; font-weight: 700; text-align: center; padding: 12px; }
  .err span { font-family: ui-monospace, Menlo, monospace; font-size: 11px; font-weight: 400; color: #b06; word-break: break-word; }
  .foot { margin-top: 22px; color: #75757e; font-size: 12px; max-width: 900px; }
</style>
</head>
<body>
  <h1>Bake-off eyeball gallery</h1>
  <div class="sub">ref build ${esc(columns[0]?.ref ?? "?")} · scenes 0-2 rendered at 1920x1080 (settled state) via the production render-truth path · generated ${esc(new Date().toISOString())}</div>
  <div class="grid">
    <div class="corner"></div>
${header}
${rows}
  </div>
  <div class="foot">
    Dashed red boxes are HONEST placeholders: the element failed, was missing from the run, or carried no persisted code —
    the box sits at the bounds the provider was briefed with. Generated code is hue-locked to the brand palette by the
    production normalizer before rendering ("colors hue-locked" counts the rewrites). Per-cell means are over ALL attempted
    elements in the scene (failures included — the honest cost). Click a screenshot for full size.
  </div>
</body>
</html>
`;
};

// ── main ─────────────────────────────────────────────────────────────────────

const main = async (): Promise<void> => {
  const runs = await selectRuns(process.argv.slice(2));
  if (runs.length === 0) {
    console.error(`no usable bake-off runs found in ${BAKEOFF_DIR} (or the given files)`);
    process.exitCode = 1;
    return;
  }
  console.log(`providers: ${runs.map((r) => `${r.provider} (${path.basename(r.file)})`).join(", ")}`);

  // Decompose + palette per distinct ref build (providers usually share one).
  const decomposed = new Map<string, { d: Decomposed; palette: string[]; genDir: string }>();
  const columns: Column[] = [];
  for (const run of runs) {
    let ctx = decomposed.get(run.ref);
    if (!ctx) {
      const genDir = path.join(ROOT, "src", "generated", run.ref);
      try {
        const d = await readDecomposed(genDir);
        const palette = extractPalette(d.preamble);
        if (palette.length === 0) console.warn(`WARNING: no PALETTE consts found in ${run.ref} preamble — hue-lock skipped`);
        ctx = { d, palette, genDir };
        decomposed.set(run.ref, ctx);
      } catch (err) {
        console.error(`skip ${run.provider}: cannot load ref build ${run.ref} — ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
        continue;
      }
    }
    console.log(`rendering ${run.provider} against ${run.ref} …`);
    try {
      columns.push(await renderProvider(run, ctx.d, ctx.palette, ctx.genDir));
    } catch (err) {
      console.error(`render failed for ${run.provider}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    }
  }

  if (columns.length === 0) {
    console.error("nothing rendered — no gallery written");
    process.exitCode = 1;
    return;
  }

  await fs.mkdir(EYEBALL_DIR, { recursive: true });
  const indexPath = path.join(EYEBALL_DIR, "index.html");
  await fs.writeFile(indexPath, galleryHtml(columns), "utf8");
  const shots = columns.flatMap((c) => SCENE_INDICES.map((i) => c.cells.get(i)?.png).filter(Boolean));
  console.log(`\ngallery: ${indexPath}`);
  console.log(`screenshots: ${shots.length} (${columns.map((c) => c.provider).join(", ")})`);
};

await main();
