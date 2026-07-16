/**
 * CAST SPIKE — phase 2 of the model bake-off: the first REAL element-cast
 * build on Cerebras gpt-oss-120b, through the PRODUCTION cast path
 * (lib/agents/cast-build.ts + lib/llm/cast-provider.ts), rendered for the
 * founder's eyeball.
 *
 * One variable: the elements. Script + design system come from the validated
 * HubSpot reference build (01KXEAF0SNT0RR079Z1SJZ1KWZ); the theme is DERIVED
 * from that build's lego/manifest.json preamble (themeFromManifest below —
 * lossy mappings documented in the report), so the cast run and the reference
 * row share brand, copy, and narrative and differ only in who generated the
 * element bodies.
 *
 *   set -a && source .env.local && set +a && node scripts/cast-spike.mjs
 *   (RB_CAST_KEY arms the provider; the script also falls back to reading
 *    RB_CAST_* keys straight out of .env.local when they're not exported.)
 *
 * Outputs (.data/cast-spike/):
 *   scene{0..4}.png            the cast build's five scenes (1920x1080, settled)
 *   reference/scene{0..4}.png  the current engine's same five scenes (reassembled untouched)
 *   Composition.cast.tsx       the assembled cast composition (also in the genDir)
 *   build-report.json          full telemetry + theme-mapping decisions
 *   index.html                 two-row gallery: cast vs reference
 *
 * Scratch genDirs (gitignored — src/generated/ is fully ignored):
 *   src/generated/CAST_SPIKE_CAST/         cast Composition.tsx + shims
 *   src/generated/CAST_SPIKE_REFERENCE/    reassembled reference + shims
 *
 * Guardrails honored: ONE canary castCall before the build; castBuild throwing
 * still produces a report + the reference row; concurrency stays at the
 * provider default; no retry loops beyond what cast-build already owns.
 */
import { promises as fs } from "fs";
import path from "path";
import { castBuild, type CastBuildResult } from "../lib/agents/cast-build";
import { castCall, castConfigured } from "../lib/llm/cast-provider";
import type { Theme } from "../lib/edit/piece-model";
import type { Script } from "../src/schema";
import { readDecomposed } from "../lib/agents/lego-store";
import { reassemble } from "../lib/agents/lego-decompose";
import { injectLogoSrc } from "../lib/agents/logo-inject";
import { finalizeUndefinedRefs } from "../lib/agents/finalize-refs";
import { measureScenes } from "../lib/render/measure-scene";

const ROOT = process.cwd();
const REF_ID = "01KXEAF0SNT0RR079Z1SJZ1KWZ"; // the validated HubSpot build
const REF_DIR = path.join(ROOT, "src", "generated", REF_ID);
const OUT_DIR = path.join(ROOT, ".data", "cast-spike");
const REF_OUT_DIR = path.join(OUT_DIR, "reference");
const CAST_GEN = path.join(ROOT, "src", "generated", "CAST_SPIKE_CAST");
const REFERENCE_GEN = path.join(ROOT, "src", "generated", "CAST_SPIKE_REFERENCE");
const SCENE_INDICES = [0, 1, 2, 3, 4];
/** Same shim set bakeoff-eyeball copies — the composition's relative imports. */
const SHIMS = ["Img.tsx", "Piece.tsx", "BrandChrome.tsx", "Lottie.tsx", "Video.tsx"];

/** gpt-oss-120b on Cerebras, published pricing per M tokens. */
const PRICE_IN_PER_M = 0.35;
const PRICE_OUT_PER_M = 0.75;
/** The reference build's original wall (prod audit 2026-07-12: HubSpot ≈ 37min). */
const REFERENCE_BASELINE_MINUTES = 37;

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round4 = (n: number): number => Math.round(n * 10000) / 10000;

// ─── env: fall back to .env.local for RB_CAST_* when not exported ───────────

const loadCastEnv = async (): Promise<void> => {
  if (process.env.RB_CAST_KEY) return;
  let raw: string;
  try {
    raw = await fs.readFile(path.join(ROOT, ".env.local"), "utf8");
  } catch {
    return; // no .env.local — castConfigured() will report the miss
  }
  for (const line of raw.split("\n")) {
    const m = /^\s*(RB_CAST_[A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key] && val) process.env[key] = val;
  }
};

// ─── themeFromManifest: the controlled variable ──────────────────────────────
//
// The reference build predates the Theme contract — its design system lives as
// preamble consts (PALETTE object, FONT_*, BRAND_FONTS_CSS, SHARED_KEYFRAMES),
// not a theme.json. This parses those consts into a valid piece-model Theme
// whose palette KEYS are the const names assemble.ts will emit (bare consts,
// exactly what the element system prompt advertises). Every lossy decision is
// returned as a mapping note for the report.

interface DerivedTheme {
  theme: Theme;
  /** All brand hexes from the PALETTE block — the hue-lock vocabulary. */
  paletteHexes: string[];
  signatureAccent: string | undefined;
  logoSrc: string | undefined;
  mappingNotes: string[];
}

/** PALETTE.cardFill → CARD_FILL: bare-const spelling for the assemble contract. */
const camelToConst = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();

/** Extract the raw source of `const NAME = \`...\`;` and unescape it back to
 *  the runtime string (\` \$ \\ — the only escapes a design-agent CSS literal
 *  plausibly carries). */
const extractTemplateConst = (src: string, name: string): string | null => {
  const marker = `const ${name} = \``;
  const at = src.indexOf(marker);
  if (at === -1) return null;
  let i = at + marker.length;
  let out = "";
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      out += ch + (src[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (ch === "`") return out.replace(/\\([`$\\])/g, "$1");
    out += ch;
    i++;
  }
  return null;
};

const extractStringConst = (src: string, name: string): string | null => {
  const m = new RegExp(`const\\s+${name}\\s*=\\s*(['"])([^'"]*(?:"[^']*)?)\\1\\s*;`).exec(src);
  // Simpler + robust for this preamble: quote-delimited, no escapes inside.
  if (m) return m[2];
  const m2 = new RegExp(`const\\s+${name}\\s*=\\s*'([^']*)'`).exec(src);
  if (m2) return m2[1];
  const m3 = new RegExp(`const\\s+${name}\\s*=\\s*"([^"]*)"`).exec(src);
  return m3 ? m3[1] : null;
};

export const themeFromManifest = (preamble: string): DerivedTheme => {
  const notes: string[] = [];

  // — palette: the `const PALETTE = { key: "#hex", … }` block —
  const palStart = preamble.indexOf("const PALETTE");
  if (palStart === -1) throw new Error("themeFromManifest: no PALETTE block in preamble");
  const palEnd = preamble.indexOf("}", palStart);
  const palBlock = preamble.slice(palStart, palEnd === -1 ? palStart + 2000 : palEnd);
  const palette: Record<string, string> = {};
  const byOriginalKey: Record<string, string> = {};
  for (const m of palBlock.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*"([^"]+)"/g)) {
    palette[camelToConst(m[1])] = m[2];
    byOriginalKey[m[1]] = m[2];
  }
  if (Object.keys(palette).length === 0) throw new Error("themeFromManifest: PALETTE block parsed to zero entries");
  notes.push(
    `palette: PALETTE object keys re-spelled camelCase→CONST_CASE (${Object.keys(byOriginalKey)
      .map((k) => `${k}→${camelToConst(k)}`)
      .join(", ")}) — the cast/assemble contract emits BARE consts, so elements are generated against the new names; hex values carried verbatim.`,
    "palette: BRAND_ACCENT/BRAND_INK/BRAND_CANVAS/BRAND_MUTED alias consts dropped (redundant with the palette entries they alias).",
  );

  // — fonts: locked identity, carried verbatim —
  const display = extractStringConst(preamble, "FONT_DISPLAY");
  const body = extractStringConst(preamble, "FONT_BODY");
  const mono = extractStringConst(preamble, "FONT_MONO");
  const fontFaceCss = extractTemplateConst(preamble, "BRAND_FONTS_CSS");
  if (!display || !body || !mono) throw new Error("themeFromManifest: FONT_DISPLAY/FONT_BODY/FONT_MONO not all found");
  if (!fontFaceCss) throw new Error("themeFromManifest: BRAND_FONTS_CSS not found");
  notes.push("fonts: FONT_DISPLAY/FONT_BODY/FONT_MONO + BRAND_FONTS_CSS (embedded woff2 data URIs) carried verbatim.");

  // — keyframes: the shared vocabulary, carried verbatim —
  const keyframes = extractTemplateConst(preamble, "SHARED_KEYFRAMES");
  if (!keyframes) throw new Error("themeFromManifest: SHARED_KEYFRAMES not found");
  if (/\$\{/.test(keyframes) || /\$\{/.test(fontFaceCss)) {
    notes.push(
      "WARNING: SHARED_KEYFRAMES or BRAND_FONTS_CSS contains a ${…} interpolation — carried as inert text (assemble re-escapes it), values may differ from the original build.",
    );
  }
  notes.push(
    "keyframes: SHARED_KEYFRAMES carried verbatim, including the reference build's tl* throughline-motif keyframes — the cast elements see the same animation vocabulary the original pieces had.",
  );

  // — grammar: NOT authored in this preamble (the build predates the Theme
  //   grammar contract) — DERIVED from a scan of the build's lego pieces.
  //   This is the lossiest mapping in the spike; every choice documented. —
  const grammar: Theme["grammar"] = {
    radiusScale: [6, 12, 20],
    strokeWeight: 1,
    hairline: "SOFT_NEUTRAL",
    panelBg: "CARD_FILL",
    shadowRecipe: "0 14px 44px rgba(25,23,23,0.10), 0 2px 8px rgba(25,23,23,0.06)",
    dataFont: "mono",
  };
  notes.push(
    "grammar (DERIVED — no grammar consts exist in this preamble): hairline=SOFT_NEUTRAL (softNeutral is the dominant border color in the reference pieces, 22 uses), panelBg=CARD_FILL (the preamble's own 'soft card surface' comment, 16 uses), strokeWeight=1px, radiusScale=[6,12,20] (observed detail/surface/panel radii — the original's 2px micro-radii are chart details, not surfaces), shadowRecipe = the most-used ink-tinted recipe ('0 14px 44px rgba(25,23,23,.10), 0 2px 8px …'), dataFont=mono (FONT_MONO present and used for data labels).",
    "not carried (cast path owns these itself): THROUGHLINE_TABS + single-letter helper components (the cast throughline element re-invents the motif from the script's throughline text), CHOREO_CSS (choreograph.ts re-compiles motion), SECTION_FRAME (assemble emits its own), LOGO_SRC (re-injected by the production injectLogoSrc post-pass).",
  );

  // sanity: the composer's roles must resolve against these keys
  for (const need of ["CANVAS", "INK", "ACCENT", grammar.hairline, grammar.panelBg]) {
    if (!(need in palette)) throw new Error(`themeFromManifest: expected palette const ${need} missing`);
  }

  const logoSrc = extractStringConst(preamble, "LOGO_SRC") ?? undefined;

  return {
    theme: { palette, fonts: { display, body, mono, fontFaceCss }, keyframes, grammar },
    paletteHexes: [...new Set(Object.values(byOriginalKey))],
    signatureAccent: byOriginalKey["accent"],
    logoSrc,
    mappingNotes: notes,
  };
};

// ─── per-call instrumentation (cast-build.ts stays untouched) ────────────────

interface CallRecord {
  pieceId: string;
  attempt: number;
  seconds: number;
  inputTokens: number;
  outputTokens: number;
  stopReason: string | null;
  maxTokens: number;
  effort?: string;
  ok: boolean;
  error?: string;
}

const makeInstrumentedCaller = () => {
  const calls: CallRecord[] = [];
  const attempts = new Map<string, number>();
  const caller: typeof castCall = async (call) => {
    const pieceId = /piece id "([^"]+)"/.exec(call.user)?.[1] ?? "?";
    const attempt = (attempts.get(pieceId) ?? 0) + 1;
    attempts.set(pieceId, attempt);
    const t0 = Date.now();
    try {
      const res = await castCall(call);
      calls.push({
        pieceId,
        attempt,
        seconds: round2((Date.now() - t0) / 1000),
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
        stopReason: res.stopReason,
        maxTokens: call.maxTokens,
        effort: call.effort,
        ok: true,
      });
      return res;
    } catch (err) {
      calls.push({
        pieceId,
        attempt,
        seconds: round2((Date.now() - t0) / 1000),
        inputTokens: 0,
        outputTokens: 0,
        stopReason: null,
        maxTokens: call.maxTokens,
        effort: call.effort,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };
  return { caller, calls };
};

// ─── SPIKE-SIDE repair (NOT in the production cast path — the finding) ──────
//
// Run 1 evidence: gpt-oss-120b generalizes the palette-const pattern to the
// shared @keyframes names and writes `animation: \`${fadeRise} 0.6s …\`` — a
// JS identifier interpolation. It parses (the fragment gate binds no
// identifiers) but throws ReferenceError the moment a Section renders, killing
// every scene. Deterministic rewrite: `${name}` → literal CSS name, for names
// declared in the composition's own @keyframes. Counted + reported as the #1
// contract fix the production path needs (prompt line and/or normalize pass).
const repairKeyframeInterpolations = (code: string): { code: string; rewrites: number; byName: Record<string, number> } => {
  const names = new Set(
    [...code.matchAll(/@keyframes\s+([A-Za-z_][A-Za-z0-9_-]*)/g)].map((m) => m[1]),
  );
  let rewrites = 0;
  const byName: Record<string, number> = {};
  for (const n of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) continue; // hyphenated names can't be `${}` refs
    code = code.replace(new RegExp(`\\$\\{\\s*${n}\\s*\\}`, "g"), () => {
      rewrites++;
      byName[n] = (byName[n] ?? 0) + 1;
      return n;
    });
  }
  return { code, rewrites, byName };
};

// ─── render helpers ──────────────────────────────────────────────────────────

interface SceneCell {
  scene: number;
  png?: string; // relative to OUT_DIR
  error?: string;
}

/** Write a genDir (Composition + shims + script.json) and render all 5 scenes
 *  via the production render-truth path; copy PNGs into destDir. */
const renderRow = async (
  composition: string,
  genDir: string,
  script: unknown,
  destDir: string,
  relPrefix: string,
): Promise<SceneCell[]> => {
  await fs.rm(genDir, { recursive: true, force: true });
  await fs.mkdir(genDir, { recursive: true });
  await fs.mkdir(destDir, { recursive: true });
  await fs.writeFile(path.join(genDir, "Composition.tsx"), composition, "utf8");
  await fs.writeFile(path.join(genDir, "script.json"), JSON.stringify(script, null, 2), "utf8");
  for (const shim of SHIMS) {
    await fs.copyFile(path.join(REF_DIR, shim), path.join(genDir, shim)).catch(() => {});
  }
  const measurements = await measureScenes(genDir, script, genDir);
  const cells: SceneCell[] = [];
  for (const i of SCENE_INDICES) {
    const m = measurements.find((mm) => mm.scene === i);
    const shot = path.join(genDir, `measure-scene-${i}.png`);
    const exists = await fs.stat(shot).then(() => true).catch(() => false);
    if (m?.error || !exists) {
      cells.push({ scene: i, error: m?.error ?? "no screenshot produced" });
      continue;
    }
    await fs.copyFile(shot, path.join(destDir, `scene${i}.png`));
    cells.push({ scene: i, png: path.posix.join(relPrefix, `scene${i}.png`) });
  }
  return cells;
};

// ─── the gallery ─────────────────────────────────────────────────────────────

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

interface GalleryInput {
  model: string;
  sceneLabels: string[];
  cast: { cells: SceneCell[]; error?: string };
  reference: { cells: SceneCell[]; error?: string };
  stats: {
    wallSeconds: number | null;
    totalSpikeSeconds: number;
    elements: number | null;
    repairs: number | null;
    failures: number | null;
    normalizedColors: number | null;
    tokensIn: number;
    tokensOut: number;
    costUSD: number;
    concurrency: string;
  };
}

const galleryHtml = (g: GalleryInput): string => {
  const s = g.stats;
  const fmtWall = s.wallSeconds === null ? "—" : `${s.wallSeconds.toFixed(1)}s`;
  const statChips: [string, string][] = [
    ["cast wall-clock", fmtWall],
    ["elements", s.elements === null ? "—" : String(s.elements)],
    ["repairs", s.repairs === null ? "—" : String(s.repairs)],
    ["failures (placeholders)", s.failures === null ? "—" : String(s.failures)],
    ["colors hue-locked", s.normalizedColors === null ? "—" : String(s.normalizedColors)],
    ["tokens in / out", `${s.tokensIn.toLocaleString()} / ${s.tokensOut.toLocaleString()}`],
    ["projected cost", `$${s.costUSD.toFixed(4)}`],
    ["vs reference build", `~${REFERENCE_BASELINE_MINUTES} min (GLM engine, full pipeline)`],
  ];
  const chips = statChips
    .map(([k, v]) => `<div class="chip"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`)
    .join("\n");

  const row = (label: string, sub: string, r: { cells: SceneCell[]; error?: string }): string => {
    const cells = SCENE_INDICES.map((i) => {
      const cell = r.cells.find((c) => c.scene === i);
      if (r.error && !cell?.png) {
        return `<div class="cell"><div class="err">NO RENDER<br><span>${esc(r.error)}</span></div></div>`;
      }
      if (!cell) return `<div class="cell"><div class="err">no data</div></div>`;
      const visual = cell.png
        ? `<a href="${esc(cell.png)}" target="_blank"><img src="${esc(cell.png)}" alt="${esc(label)} scene ${i}"></a>`
        : `<div class="err">RENDER FAILED<br><span>${esc(cell.error ?? "")}</span></div>`;
      return `<div class="cell">${visual}</div>`;
    }).join("\n");
    return `<div class="row-label"><div class="row-name">${esc(label)}</div><div class="row-sub">${esc(sub)}</div></div>\n${cells}`;
  };

  const sceneHeads = SCENE_INDICES.map(
    (i) => `<div class="scene-head">scene ${i}<span>${esc(g.sceneLabels[i] ?? "")}</span></div>`,
  ).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cast spike — ${esc(g.model)} vs current engine</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0e0f12; color: #e8e8ea; font: 14px/1.45 ui-sans-serif, system-ui, sans-serif; padding: 28px; }
  h1 { font-size: 20px; font-weight: 700; }
  .sub { color: #9a9aa3; margin: 6px 0 18px; font-size: 13px; }
  .stats { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 24px; }
  .chip { background: #16171c; border: 1px solid #26272e; border-radius: 8px; padding: 10px 14px; min-width: 130px; }
  .chip .k { font-size: 11px; color: #8a8a93; font-family: ui-monospace, Menlo, monospace; }
  .chip .v { font-size: 16px; font-weight: 700; margin-top: 4px; }
  .grid { display: grid; grid-template-columns: 170px repeat(5, minmax(280px, 1fr)); gap: 12px; align-items: start; }
  .scene-head { font-family: ui-monospace, Menlo, monospace; font-size: 12px; color: #8a8a93; }
  .scene-head span { display: block; color: #c8c8cf; font-size: 11px; margin-top: 2px; }
  .row-label { padding-top: 6px; }
  .row-name { font-size: 15px; font-weight: 700; color: #fff; }
  .row-sub { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #8a8a93; margin-top: 4px; }
  .cell { background: #16171c; border: 1px solid #26272e; border-radius: 8px; padding: 6px; }
  .cell img { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: contain; border-radius: 4px; background: #000; }
  .cell a { display: block; }
  .err { aspect-ratio: 16 / 9; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
         border: 2px dashed #e0245e; border-radius: 4px; color: #e0245e; font-weight: 700; text-align: center; padding: 12px; }
  .err span { font-family: ui-monospace, Menlo, monospace; font-size: 11px; font-weight: 400; color: #b06; word-break: break-word; }
  .foot { margin-top: 22px; color: #75757e; font-size: 12px; max-width: 980px; }
</style>
</head>
<body>
  <h1>Cast spike — element-cast build (${esc(g.model)} via Cerebras) vs current engine</h1>
  <div class="sub">ref build ${esc(REF_ID)} (HubSpot) · same script, same derived design system — only the ELEMENTS differ · all five scenes at 1920x1080, settled state, production render-truth path · generated ${esc(new Date().toISOString())}</div>
  <div class="stats">
${chips}
  </div>
  <div class="grid">
    <div></div>
${sceneHeads}
${row("cast", `${g.model} · production cast-build path`, g.cast)}
${row("reference", "current engine (GLM-5.2) · reassembled untouched", g.reference)}
  </div>
  <div class="foot">
    The cast row is the REAL production element-cast path end to end: layout-composer contracts, ${esc(g.model)} element calls
    (effort=low, honest per-slot token caps), hue-lock, fragment verify + one surgical repair, deterministic assemble +
    choreograph. Failures ship as counted placeholders, never silent gaps. Cost is elements only (gpt-oss $${PRICE_IN_PER_M}/M in,
    $${PRICE_OUT_PER_M}/M out) — the head/script call is not part of this run; the ~${REFERENCE_BASELINE_MINUTES} min reference figure is the full original
    pipeline wall for this build. Dashed cells are honest render failures. Click any screenshot for full size.
  </div>
</body>
</html>
`;
};

// ─── main ────────────────────────────────────────────────────────────────────

const main = async (): Promise<void> => {
  const tSpike0 = Date.now();
  await loadCastEnv();
  const model = process.env.RB_CAST_MODEL || "gpt-oss-120b";

  if (!castConfigured()) {
    console.error(
      "RB_CAST_KEY is not set. Run:  set -a && source .env.local && set +a && node scripts/cast-spike.mjs",
    );
    process.exitCode = 1;
    return;
  }

  await fs.mkdir(OUT_DIR, { recursive: true });

  // ── load the reference build ────────────────────────────────────────────
  const script = JSON.parse(await fs.readFile(path.join(REF_DIR, "script.json"), "utf8")) as Script;
  const d = await readDecomposed(REF_DIR);
  const derived = themeFromManifest(d.preamble);
  console.log(`theme derived: ${Object.keys(derived.theme.palette).length} palette consts, accent ${derived.signatureAccent}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const report: any = {
    ref: REF_ID,
    model,
    baseUrl: process.env.RB_CAST_BASE_URL || "https://api.cerebras.ai/v1",
    concurrency: process.env.RB_CAST_CONCURRENCY || "default (14)",
    startedAt: new Date().toISOString(),
    referenceBaselineMinutes: REFERENCE_BASELINE_MINUTES,
    themeMapping: derived.mappingNotes,
    paletteHexes: derived.paletteHexes,
    signatureAccent: derived.signatureAccent,
  };

  // ── guardrail: ONE canary element call before the burst ────────────────
  console.log(`canary: one castCall against ${model} …`);
  try {
    const canary = await castCall({
      system: "You are a connectivity canary. Reply with exactly: OK",
      user: "ping",
      maxTokens: 256,
      effort: "low",
    });
    report.canary = {
      ok: canary.text.trim().length > 0,
      seconds: round2(canary.seconds),
      inputTokens: canary.inputTokens,
      outputTokens: canary.outputTokens,
      stopReason: canary.stopReason,
      text: canary.text.trim().slice(0, 80),
    };
    console.log(`canary ok in ${canary.seconds.toFixed(2)}s: ${JSON.stringify(canary.text.trim().slice(0, 40))}`);
    if (!report.canary.ok) throw new Error("canary returned empty text");
  } catch (err) {
    report.canary = { ok: false, error: err instanceof Error ? err.message : String(err) };
    console.error(`canary FAILED: ${report.canary.error}`);
  }

  // ── the cast build (only if the canary responded) ───────────────────────
  const { caller, calls } = makeInstrumentedCaller();
  let result: CastBuildResult | null = null;
  let castComposition: string | null = null;
  const castWarnings: string[] = [];

  if (report.canary.ok) {
    console.log(`cast build: ${script.scenes.length} scenes through the production cast path …`);
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      const line = args.map(String).join(" ");
      if (line.startsWith("[cast-build]")) castWarnings.push(line);
      origWarn(...args);
    };
    const tBuild0 = Date.now();
    try {
      result = await castBuild(
        {
          script,
          theme: derived.theme,
          palette: derived.paletteHexes,
          signatureAccent: derived.signatureAccent,
          aspect: "16:9",
        },
        { caller },
      );
      report.castBuild = { ok: true, telemetry: result.telemetry };
      console.log(
        `cast build DONE in ${result.telemetry.wallSeconds}s — ${result.telemetry.elements} elements, ` +
          `${result.telemetry.repairs} repairs, ${result.telemetry.failures} failures, ` +
          `${result.telemetry.tokensOut} tokens out, ${result.telemetry.normalizedColors} colors hue-locked`,
      );
    } catch (err) {
      report.castBuild = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        wallSecondsAtFailure: round2((Date.now() - tBuild0) / 1000),
      };
      console.error(`cast build THREW: ${report.castBuild.error}`);
    } finally {
      console.warn = origWarn;
    }
  } else {
    report.castBuild = { ok: false, error: "skipped — canary failed" };
  }
  report.castWarnings = castWarnings;

  // per-element telemetry (derived from the instrumented caller, in call order)
  const byPiece = new Map<string, CallRecord[]>();
  for (const c of calls) byPiece.set(c.pieceId, [...(byPiece.get(c.pieceId) ?? []), c]);
  report.perElement = [...byPiece.entries()].map(([pieceId, recs]) => ({
    pieceId,
    attempts: recs.length,
    seconds: round2(recs.reduce((n, r) => n + r.seconds, 0)),
    tokensIn: recs.reduce((n, r) => n + r.inputTokens, 0),
    tokensOut: recs.reduce((n, r) => n + r.outputTokens, 0),
    maxTokensCap: recs[0]?.maxTokens,
    stopReasons: recs.map((r) => r.stopReason ?? (r.error ? `ERROR: ${r.error.slice(0, 80)}` : "?")),
  }));
  report.calls = calls;

  const tokensIn = calls.reduce((n, c) => n + c.inputTokens, 0);
  const tokensOut = calls.reduce((n, c) => n + c.outputTokens, 0);
  const costUSD = round4((tokensIn * PRICE_IN_PER_M + tokensOut * PRICE_OUT_PER_M) / 1_000_000);
  report.tokens = { input: tokensIn, output: tokensOut };
  report.costUSD = {
    input: round4((tokensIn * PRICE_IN_PER_M) / 1_000_000),
    output: round4((tokensOut * PRICE_OUT_PER_M) / 1_000_000),
    total: costUSD,
    pricing: `$${PRICE_IN_PER_M}/M in, $${PRICE_OUT_PER_M}/M out (gpt-oss-120b)`,
  };

  // ── finalize + render the cast row ──────────────────────────────────────
  let castCells: SceneCell[] = [];
  let castRowError: string | undefined;
  if (result) {
    // Production finalize steps every build gets before render: the pipeline
    // owns LOGO_SRC, and undefined component refs are stubbed, not fatal.
    let code = injectLogoSrc(result.code, derived.logoSrc);
    const fin = await finalizeUndefinedRefs(code);
    code = fin.code;
    report.finalize = { logoInjected: Boolean(derived.logoSrc), ...{ added: fin.added, stubbed: fin.stubbed, neutralized: fin.neutralized } };
    // The spike-side repair (see the finding above) — production has no
    // equivalent pass; without it every scene of run 1 threw at render.
    const kfRepair = repairKeyframeInterpolations(code);
    code = kfRepair.code;
    report.spikeRepairs = {
      keyframeInterpolationRewrites: kfRepair.rewrites,
      byName: kfRepair.byName,
      note:
        "SPIKE-SIDE ONLY: `${keyframeName}` JS-identifier interpolations rewritten to literal CSS names. " +
        "gpt-oss treats shared @keyframes names like palette consts; passes the syntax gate, throws ReferenceError at render. " +
        "Production cast path needs a prompt line and/or a normalize pass for this defect class.",
    };
    if (kfRepair.rewrites > 0) {
      console.log(`spike repair: ${kfRepair.rewrites} \${keyframe} interpolations rewritten to literal CSS names`);
    }
    castComposition = code;
    await fs.writeFile(path.join(OUT_DIR, "Composition.cast.tsx"), code, "utf8");
    console.log("rendering cast row (5 scenes) …");
    try {
      castCells = await renderRow(code, CAST_GEN, script, OUT_DIR, "");
    } catch (err) {
      castRowError = err instanceof Error ? err.message : String(err);
      console.error(`cast render failed: ${castRowError}`);
    }
  } else {
    castRowError = report.castBuild.error ?? "cast build did not run";
  }

  // ── render the reference row (the current engine, reassembled untouched) ─
  console.log("rendering reference row (5 scenes) …");
  let refCells: SceneCell[] = [];
  let refRowError: string | undefined;
  try {
    const refComposition = reassemble(d);
    refCells = await renderRow(refComposition, REFERENCE_GEN, script, REF_OUT_DIR, "reference");
  } catch (err) {
    refRowError = err instanceof Error ? err.message : String(err);
    console.error(`reference render failed: ${refRowError}`);
  }

  report.scenes = {
    cast: castRowError && castCells.length === 0 ? { error: castRowError } : castCells,
    reference: refRowError && refCells.length === 0 ? { error: refRowError } : refCells,
  };
  report.totalSpikeSeconds = round2((Date.now() - tSpike0) / 1000);

  // ── artifacts ────────────────────────────────────────────────────────────
  await fs.writeFile(path.join(OUT_DIR, "build-report.json"), JSON.stringify(report, null, 2), "utf8");

  const sceneLabels = script.scenes.map((s) => (s as { label?: string }).label ?? "");
  const html = galleryHtml({
    model,
    sceneLabels,
    cast: { cells: castCells, error: castRowError },
    reference: { cells: refCells, error: refRowError },
    stats: {
      wallSeconds: result?.telemetry.wallSeconds ?? null,
      totalSpikeSeconds: report.totalSpikeSeconds,
      elements: result?.telemetry.elements ?? (calls.length > 0 ? byPiece.size : null),
      repairs: result?.telemetry.repairs ?? null,
      failures: result?.telemetry.failures ?? null,
      normalizedColors: result?.telemetry.normalizedColors ?? null,
      tokensIn,
      tokensOut,
      costUSD,
      concurrency: String(report.concurrency),
    },
  });
  await fs.writeFile(path.join(OUT_DIR, "index.html"), html, "utf8");

  console.log(`\nreport:  ${path.join(OUT_DIR, "build-report.json")}`);
  console.log(`gallery: ${path.join(OUT_DIR, "index.html")}`);
  console.log(
    `cast: ${castCells.filter((c) => c.png).length}/5 scenes rendered · reference: ${refCells.filter((c) => c.png).length}/5 scenes rendered`,
  );
  if (!report.castBuild.ok) {
    console.error(`NOTE: cast build did not complete — see build-report.json (${report.castBuild.error})`);
    process.exitCode = 1;
  }
  void castComposition; // kept for debuggability via OUT_DIR copy
};

await main();
