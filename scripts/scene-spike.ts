/**
 * SCENE-PARALLEL SPIKE — bake-off phase 2, the comparison row against the
 * element-cast spike.
 *
 * The experiment: generate each of the 5 HubSpot scenes as ONE whole-Section
 * call on Cerebras gpt-oss-120b (today's scene-granularity architecture on the
 * fast model), 5 calls in parallel, then compose + render — so the founder can
 * compare scene-parallel vs element-parallel vs the current engine on
 * IDENTICAL inputs (the 01KXEAF0… reference build's script + design system).
 *
 *   set -a && source .env.local && set +a && node scripts/scene-spike.mjs
 *
 * Inputs (the same controlled theme the cast spike uses):
 *   src/generated/01KXEAF0SNT0RR079Z1SJZ1KWZ/script.json
 *   src/generated/01KXEAF0SNT0RR079Z1SJZ1KWZ/lego/manifest.json (preamble/tail)
 *
 * Output:
 *   .data/scene-spike/scene{0..4}.png     1920x1080 settled-state renders
 *   .data/scene-spike/build-report.json   wall, per-scene secs/tokens, repairs,
 *                                         failures, projected cost
 *   .data/scene-spike/index.html          self-contained one-row gallery
 *   src/generated/CAST_SPIKE_SCENE_HUBSPOT/   the composed scratch genDir
 *
 * THE SECTION CONTRACT (derived from the reference build, not invented):
 *   - lego/manifest.json's scene templates show each Section as
 *     `export const Section{i}: React.FC<{ script: Script }> = ({ script }) =>`
 *     with `const c = script.scenes[i].content`, a data-scene root spreading
 *     SECTION_FRAME, and a <style> block mounting CHOREO_CSS + BRAND_FONTS_CSS
 *     + SHARED_KEYFRAMES.
 *   - Major elements sit inside `<Piece id="s{i}.<role>" kind="…">` markers —
 *     build-wrapper.ts's PIECE_SHIM renders them as display:contents wrappers
 *     carrying data-piece/data-kind, which is what lego-decompose.ts slices on
 *     and what measure-scene.ts's gate walk reads. Emitting the same markers
 *     keeps this output decomposable + gateable.
 *   - Copy renders verbatim with dot-form data-content-path tags (bullets.0,
 *     cta.primary) — choreograph.ts's fieldsOf convention.
 *   - The throughline motif anchors at (1360, 540) in a data-throughline
 *     wrapper (assemble.ts contract; the preamble's ThroughlineMotif does it).
 *   - Composition = preamble + Section0..4 + tail, exactly the concatenation
 *     lib/agents/lego-decompose.ts `reassemble` performs (the tail's
 *     `Generated` mounts <Section0 …/> … <Section4 …/>).
 */
import { promises as fs } from "fs";
import path from "path";
import * as esbuild from "esbuild";
import { castCall, castConfigured, type CastResult } from "../lib/llm/cast-provider";
import { normalizeElementColors } from "../lib/agents/normalize-element";
import { stripCodeFence, verifyCompilable } from "../lib/agents/code-extraction";
import { measureScenes } from "../lib/render/measure-scene";
import type { Manifest } from "../lib/agents/lego-store";

const ROOT = process.cwd();
const REF_BUILD = "01KXEAF0SNT0RR079Z1SJZ1KWZ";
const REF_DIR = path.join(ROOT, "src", "generated", REF_BUILD);
const OUT_DIR = path.join(ROOT, ".data", "scene-spike");
// Scratch genDir — CAST_SPIKE_ prefix keeps it visibly disposable in src/generated.
const GEN_DIR = path.join(ROOT, "src", "generated", "CAST_SPIKE_SCENE_HUBSPOT");
const SCENES = [0, 1, 2, 3, 4];
// Cerebras PRE-DEBITS max_completion_tokens against the TPM bucket before
// generating, so the cap must be honest: a whole Section is ~2.5-4k visible
// tokens + low-effort reasoning; 8k covers it, and 5×8k = 40k pre-debit fits
// the 1M TPM bucket easily even with the repair retries on top.
const MAX_TOKENS = 8000;
const EFFORT = "low" as const;
// Projected pricing for the report ($/M tokens): gpt-oss-120b on Cerebras.
const USD_PER_M_IN = 0.35;
const USD_PER_M_OUT = 0.75;

// Same elision model-bakeoff.mjs uses: base64 payloads (the 150k-char font
// data URIs) are noise to the model — family names and every const stay visible.
const elide = (s: string): string => s.replace(/data:[a-zA-Z0-9/+;=,._-]{200,}/g, "data:ELIDED");

/** Brand hexes from the preamble's PALETTE block — the hue vocabulary the
 *  production normalizer locks to (same parse as bakeoff-eyeball.ts). */
const extractPalette = (preamble: string): string[] => {
  const start = preamble.indexOf("const PALETTE");
  if (start === -1) return [];
  const close = preamble.indexOf("}", start);
  const block = preamble.slice(start, close === -1 ? start + 2000 : close);
  return [...new Set(block.match(/#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g) ?? [])];
};

// ── prompts ──────────────────────────────────────────────────────────────────

const systemPrompt = (preamble: string): string => `You BUILD one complete scene ("Section") of a 30-second animated brand video (1920x1080) as a SINGLE self-contained React component.

You are given the video's shared design system — a TSX module preamble whose consts and components are ALREADY IN SCOPE where your code is inlined — and the brief for ONE scene. Emit the complete Section component for that scene.

HARD RULES — the output contract:
- Output ONLY TSX — no imports, no prose, no markdown fences, nothing before or after the component.
- Export EXACTLY \`export const Section{N}: React.FC<{ script: Script }> = ({ script }) => { … }\` for the scene index N you are given. Read copy via \`const c = script.scenes[N].content;\`.
- Root element: \`<div data-scene={N} style={{ animation: "choreoAmbient 8s ease-in-out infinite", ...SECTION_FRAME, background: PALETTE.canvas, fontFamily: FONT_BODY }}>\`.
- Its FIRST child is the style mount: \`<style dangerouslySetInnerHTML={{ __html: CHOREO_CSS + BRAND_FONTS_CSS + "\\n" + SHARED_KEYFRAMES }} />\`. You MAY append scene-specific @keyframes to that string (+ \`…\`) — never redefine a shared keyframe name.
- Reference the preamble consts/components (PALETTE.*, FONT_DISPLAY/BODY/MONO, LOGO_SRC, SECTION_FRAME, Chrome, LogoMark, ThroughlineMotif, THROUGHLINE_TABS, GrainOverlay, RadialGlow, DriftDot, Eyebrow, AccentBar, GlassCard, BrowserTabCard, Piece, Img, the shared @keyframes names) EXACTLY as defined. NEVER invent colors, fonts, or redefine preamble consts.
- Composition is absolutely positioned inside the 1920x1080 frame: every major block places itself with explicit left/top/width (px). No top-level flow layout.
- Wrap EVERY major element in a \`<Piece id="s{N}.<role>" kind="<kind>">…</Piece>\` marker (it renders display:contents — zero layout cost). Kinds: "atmosphere" (full-bleed decorative layer), "text" (the copy stack), "diegetic" (hero visual / product mock), "image" (logo/photo), "chrome" (the bottom brand bar). A scene has 4-5 pieces: one atmosphere, one text, one or two diegetic/image, one chrome. Role names are short slugs (atmos, copy, tabs, app, logo, chrome, …).
- COPY IS VERBATIM: render every provided copy field exactly as given, read from \`c.*\`, and tag the element that renders it with data-content-path using DOT-form paths: "eyebrow", "headline", "lede", "bullets.0", "bullets.1", …, "caption", "cta.primary", "cta.secondary". Example: \`<span data-content-path="bullets.0">{c.bullets[0]}</span>\`. Never invent numbers or claims.
- Emit the brand chrome inside the chrome piece: \`<Chrome sceneIndex={N} />\` (plus its props where the brief calls for them).
- The narrative throughline motif MUST appear in the scene, anchored at (left 1360, top 540), inside a \`<div data-throughline="…">\` wrapper. The preamble's \`<ThroughlineMotif phase="chaos" | "converge" | "unified" />\` does exactly this — pick the phase that fits this scene's story beat, or build a variation on THROUGHLINE_TABS keeping the anchor + data-throughline wrapper.
- Animation: CSS only — animation/@keyframes with seconds-based delays/durations from the brief's Animations spec, "both" fill for entrances. No Remotion hooks, no useState/useEffect, no Math.random, no Date.now.
- Rich, dense, production-grade — a premium brand-video frame, not a wireframe: layered atmosphere (glow, grain, drift), editorial copy hierarchy, a concrete detailed hero visual.
- Valid TSX that compiles as a module-level statement: balanced tags, nothing after the component's closing \`};\`.

SHARED DESIGN SYSTEM (in scope at inline time; base64 font payloads elided here for brevity — the real consts are complete):
\`\`\`tsx
${preamble}
\`\`\``;

interface ScriptScene {
  index: number;
  label: string;
  register?: string;
  description?: string;
  visual_concept?: string;
  start_seconds?: number;
  end_seconds?: number;
  content: Record<string, unknown>;
}
interface Script {
  scenes: ScriptScene[];
  narrative?: { throughline?: string; arc?: string; logline?: string };
  config?: { aspect_ratio?: string };
  assets?: unknown;
}

/** Verbatim copy fields as tagged lines — dot-form paths (choreograph.ts
 *  fieldsOf convention; bracket-form never receives entrance choreography). */
const copyLines = (c: Record<string, unknown>): string => {
  const out: string[] = [];
  const push = (path_: string, v: unknown) => {
    if (typeof v === "string" && v) out.push(`${path_}: ${JSON.stringify(v)} (data-content-path="${path_}")`);
  };
  push("eyebrow", c.eyebrow);
  push("headline", c.headline);
  push("lede", c.lede);
  if (Array.isArray(c.bullets)) c.bullets.forEach((b, i) => push(`bullets.${i}`, b));
  push("caption", c.caption);
  const cta = c.cta as { primary?: string; secondary?: string } | undefined;
  if (cta) {
    push("cta.primary", cta.primary);
    push("cta.secondary", cta.secondary);
  }
  if (typeof c.illustration === "string" && c.illustration)
    out.push(`illustration hint (a visual to build, NOT copy to render as text): "${c.illustration}"`);
  return out.join("\n");
};

const MOTIF_PHASE = ["chaos", "chaos", "converge", "unified", "unified"];

const userPrompt = (script: Script, i: number): string => {
  const s = script.scenes[i];
  return [
    `BUILD Section${i} — scene ${i} of 5, "${s.label}", register ${s.register ?? "n/a"}, ${s.start_seconds ?? "?"}s-${s.end_seconds ?? "?"}s of the video.`,
    ``,
    `Scene intent: ${s.description ?? s.label}`,
    ``,
    `Visual concept (follow the composition and its Animations spec):`,
    String(s.visual_concept ?? ""),
    ``,
    `SCENE COPY (verbatim, tagged with data-content-path):`,
    copyLines(s.content) || "(no copy fields — visual scene)",
    ``,
    `NARRATIVE THROUGHLINE (the recurring motif across all 5 scenes): ${script.narrative?.throughline ?? ""}`,
    `Story position for the motif in THIS scene: phase "${MOTIF_PHASE[i]}".`,
    ``,
    `Emit ONLY the complete \`export const Section${i}\` component.`,
  ].join("\n");
};

const repairPrompt = (i: number, code: string, error: string): string => [
  `Your Section${i} component failed to compile when inlined after the design-system preamble.`,
  ``,
  `COMPILER ERROR:`,
  error,
  ``,
  `THE CODE YOU EMITTED:`,
  "```tsx",
  code,
  "```",
  ``,
  `Fix ONLY what is needed to compile — keep the design, layout, and copy identical.`,
  `Emit ONLY the corrected complete \`export const Section${i}\` component — no prose, no fences.`,
].join("\n");

// ── validation / placeholder ─────────────────────────────────────────────────

/** Syntax + contract probe for one emitted Section (module-level statement). */
const sectionError = async (i: number, code: string): Promise<string | null> => {
  if (!new RegExp(`export\\s+const\\s+Section${i}\\b`).test(code))
    return `missing \`export const Section${i}\` — the component must be exported under exactly that name`;
  try {
    await esbuild.transform(code, { loader: "tsx", jsx: "automatic", logLevel: "silent" });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message.split("\n").slice(0, 6).join("\n") : String(err);
  }
};

/** Loudly-labeled full-frame placeholder Section — the honest failure surface
 *  (evidence either way; the composition still compiles and renders). */
const placeholderSection = (i: number, reason: string): string => {
  const label = `Section${i} PLACEHOLDER — ${reason.split("\n")[0].slice(0, 160)}`;
  return [
    `export const Section${i}: React.FC<{ script: Script }> = () => (`,
    `  <div data-scene={${i}} style={{ ...SECTION_FRAME, background: PALETTE.canvas }}>`,
    `    <div style={{ position: "absolute", left: 40, top: 40, right: 40, bottom: 40, boxSizing: "border-box", border: "4px dashed #e0245e", background: "rgba(224,36,94,0.05)" }}>`,
    `      <div style={{ position: "absolute", left: 24, top: 24, maxWidth: 1700, fontFamily: "ui-monospace, Menlo, monospace", fontSize: 26, fontWeight: 700, color: "#ffffff", background: "#e0245e", padding: "10px 18px", borderRadius: 6 }}>{${JSON.stringify(label)}}</div>`,
    `    </div>`,
    `  </div>`,
    `);`,
  ].join("\n");
};

// ── per-scene generation ─────────────────────────────────────────────────────

interface SceneStat {
  scene: number;
  label: string;
  ok: boolean;
  placeholder: boolean;
  repaired: boolean;
  secs: number; // wall for this scene's call(s), repair included
  inputTokens: number;
  outputTokens: number;
  stopReason: string | null;
  hueLocked: number;
  failReason?: string;
}

const generateScene = async (
  script: Script,
  system: string,
  palette: string[],
  i: number,
): Promise<{ code: string; stat: SceneStat }> => {
  const label = script.scenes[i]?.label ?? `scene ${i}`;
  const stat: SceneStat = {
    scene: i, label, ok: false, placeholder: false, repaired: false,
    secs: 0, inputTokens: 0, outputTokens: 0, stopReason: null, hueLocked: 0,
  };
  const t0 = Date.now();
  const account = (r: CastResult) => {
    stat.inputTokens += r.inputTokens;
    stat.outputTokens += r.outputTokens;
    stat.stopReason = r.stopReason;
  };

  let code = "";
  let err: string;
  try {
    const first = await castCall({ system, user: userPrompt(script, i), maxTokens: MAX_TOKENS, effort: EFFORT });
    account(first);
    code = stripCodeFence(first.text);
    const e1 = await sectionError(i, code);
    if (e1 === null) {
      stat.ok = true;
    } else {
      // ONE surgical repair retry, quoting the exact error (repairCompile's
      // policy, inlined — one attempt, cast transport).
      console.warn(`scene ${i}: compile fail — repairing (${e1.split("\n")[0]})`);
      const fix = await castCall({ system, user: repairPrompt(i, code, e1), maxTokens: MAX_TOKENS, effort: EFFORT });
      account(fix);
      const fixed = stripCodeFence(fix.text);
      const e2 = await sectionError(i, fixed);
      stat.repaired = true;
      if (e2 === null) {
        code = fixed;
        stat.ok = true;
      } else {
        err = e2;
        stat.failReason = `after repair: ${e2.split("\n")[0]}`;
      }
    }
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
    stat.failReason = `call failed: ${err.split("\n")[0]}`;
  }

  if (!stat.ok) {
    // Terminal failure → labeled placeholder; render what exists (evidence
    // either way, per the spike guardrails).
    code = placeholderSection(i, stat.failReason ?? "unknown failure");
    stat.placeholder = true;
  } else if (palette.length > 0) {
    // Production post-pass: hue-lock off-brand colors before composing —
    // exactly what cast-build.ts does before an element ships.
    const norm = normalizeElementColors(code, palette);
    code = norm.code;
    stat.hueLocked = norm.changes.reduce((n, c) => n + c.count, 0);
  }
  stat.secs = (Date.now() - t0) / 1000;
  return { code, stat };
};

// ── gallery (self-contained single row; the three-way gallery merges later) ──

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const galleryHtml = (report: Record<string, unknown>, stats: SceneStat[], renderErrors: Map<number, string>): string => {
  const cost = report.cost as { usd: number; inputTokens: number; outputTokens: number };
  const headline = [
    `model ${esc(String(report.model))} · effort ${EFFORT}`,
    `scene-gen wall ${(report.sceneGenWallSeconds as number).toFixed(1)}s (5 parallel whole-Section calls)`,
    `run total ${(report.wallTotalSeconds as number).toFixed(1)}s`,
    `${cost.inputTokens} in / ${cost.outputTokens} out tok · projected $${cost.usd.toFixed(4)}`,
    `${stats.filter((s) => s.repaired).length} repaired · ${stats.filter((s) => s.placeholder).length} placeholder`,
  ].join(" · ");

  const cells = stats
    .map((s) => {
      const renderErr = renderErrors.get(s.scene);
      const png = `scene${s.scene}.png`;
      const visual = renderErr
        ? `<div class="err">RENDER FAILED<br><span>${esc(renderErr)}</span></div>`
        : `<a href="${png}" target="_blank"><img src="${png}" alt="scene ${s.scene}"></a>`;
      const stat =
        `${s.secs.toFixed(1)}s · ${s.outputTokens} tok out` +
        (s.repaired ? " · repaired" : "") +
        (s.placeholder ? ` · PLACEHOLDER (${esc(s.failReason ?? "")})` : "") +
        (s.hueLocked ? ` · ${s.hueLocked} colors hue-locked` : "");
      return `<div class="cell"><div class="cell-title">scene ${s.scene} — ${esc(s.label)}</div>${visual}<div class="stat">${esc(stat)}</div></div>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Scene-parallel spike — whole-Section calls on Cerebras</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0e0f12; color: #e8e8ea; font: 14px/1.45 ui-sans-serif, system-ui, sans-serif; padding: 28px; }
  h1 { font-size: 20px; font-weight: 700; }
  .sub { font-family: ui-monospace, Menlo, monospace; color: #9a9aa3; margin: 8px 0 22px; font-size: 12px; }
  .row { display: grid; grid-template-columns: repeat(5, minmax(300px, 1fr)); gap: 14px; align-items: start; }
  .cell { background: #16171c; border: 1px solid #26272e; border-radius: 8px; padding: 8px; }
  .cell-title { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #a9aab3; margin-bottom: 6px; }
  .cell img { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: contain; border-radius: 4px; background: #000; }
  .cell a { display: block; }
  .stat { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #a9aab3; margin-top: 8px; }
  .err { aspect-ratio: 16 / 9; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
         border: 2px dashed #e0245e; border-radius: 4px; color: #e0245e; font-weight: 700; text-align: center; padding: 12px; }
  .err span { font-family: ui-monospace, Menlo, monospace; font-size: 11px; font-weight: 400; color: #b06; word-break: break-word; }
  .foot { margin-top: 20px; color: #75757e; font-size: 12px; max-width: 960px; }
</style>
</head>
<body>
  <h1>Scene-parallel spike — one whole-Section call per scene (Cerebras gpt-oss-120b)</h1>
  <div class="sub">ref ${esc(String(report.ref))} · ${esc(headline)} · generated ${esc(String(report.generatedAt))}</div>
  <div class="row">
${cells}
  </div>
  <div class="foot">
    Each scene is ONE ${MAX_TOKENS}-token-capped whole-Section call (effort ${EFFORT}), all five fired in parallel after a canary,
    then composed with the reference build's real preamble/tail and rendered via the production render-truth path
    (settled-state 1920x1080). Dashed red = honest placeholder (terminal generation failure) or render failure.
    Per-scene seconds include that scene's repair retry when one ran. Cost projected at $${USD_PER_M_IN}/M in, $${USD_PER_M_OUT}/M out.
  </div>
</body>
</html>
`;
};

// ── main ─────────────────────────────────────────────────────────────────────

const main = async (): Promise<void> => {
  if (!castConfigured()) {
    console.error("RB_CAST_KEY missing — run: set -a && source .env.local && set +a && node scripts/scene-spike.mjs");
    process.exitCode = 1;
    return;
  }
  const tRun = Date.now();
  const model = process.env.RB_CAST_MODEL || "gpt-oss-120b";

  const manifest: Manifest = JSON.parse(await fs.readFile(path.join(REF_DIR, "lego", "manifest.json"), "utf8"));
  const script: Script = JSON.parse(await fs.readFile(path.join(REF_DIR, "script.json"), "utf8"));
  const palette = extractPalette(manifest.preamble);
  if (palette.length === 0) console.warn("WARNING: no PALETTE hexes parsed — hue-lock skipped");
  const system = systemPrompt(elide(manifest.preamble.trim()));

  // ONE canary before the burst: proves transport + key + model without
  // spending a scene, and keeps the 5-scene wall an honest parallel number.
  console.log(`canary call (${model}) …`);
  const canary = await castCall({
    system: "You are a connectivity canary. Reply with exactly: OK",
    user: "Reply with exactly: OK",
    maxTokens: 256,
    effort: EFFORT,
  });
  console.log(`canary ok — ${canary.seconds.toFixed(1)}s, ${canary.outputTokens} tok out, stop=${canary.stopReason}`);

  // The experiment: 5 whole-Section calls in parallel (repairs run inside each
  // scene's own promise, so the wall is the honest end-to-end scene-gen time).
  console.log("firing 5 whole-Section calls in parallel …");
  const tScenes = Date.now();
  const results = await Promise.all(SCENES.map((i) => generateScene(script, system, palette, i)));
  const sceneGenWallSeconds = (Date.now() - tScenes) / 1000;
  const stats = results.map((r) => r.stat);
  for (const s of stats) {
    console.log(
      `scene ${s.scene} (${s.label}): ${s.placeholder ? "PLACEHOLDER" : "ok"} · ${s.secs.toFixed(1)}s · ` +
        `${s.outputTokens} tok out${s.repaired ? " · repaired" : ""}${s.hueLocked ? ` · ${s.hueLocked} hue-locked` : ""}`,
    );
  }

  // Compose exactly as reassemble does: preamble + sections + tail (the tail's
  // `Generated` mounts Section0..4, so all five exports must exist).
  const preamble = manifest.preamble;
  const sections = results.map((r) => r.code.trim()).join("\n\n");
  const composition = preamble + (preamble.endsWith("\n") ? "" : "\n") + sections + "\n\n" + manifest.tail;
  const compileError = await verifyCompilable(composition);
  if (compileError) console.error(`FINAL COMPOSITION DOES NOT COMPILE: ${compileError.split("\n")[0]}`);
  else console.log(`composition compiles (${composition.length} chars)`);

  // Scratch genDir: composition + the ref build's shims (same set
  // bakeoff-eyeball copies) + script.json for debuggability.
  await fs.rm(GEN_DIR, { recursive: true, force: true });
  await fs.mkdir(GEN_DIR, { recursive: true });
  await fs.writeFile(path.join(GEN_DIR, "Composition.tsx"), composition, "utf8");
  for (const shim of ["Img.tsx", "Piece.tsx", "BrandChrome.tsx", "Lottie.tsx", "Video.tsx"]) {
    await fs.copyFile(path.join(REF_DIR, shim), path.join(GEN_DIR, shim)).catch(() => {});
  }
  await fs.copyFile(path.join(REF_DIR, "script.json"), path.join(GEN_DIR, "script.json")).catch(() => {});

  // Render all 5 scenes via the production render-truth path (same call
  // bakeoff-eyeball uses: bundle → mount → settle animations → screenshot).
  console.log("rendering 5 scenes via measureScenes …");
  await fs.rm(OUT_DIR, { recursive: true, force: true });
  await fs.mkdir(OUT_DIR, { recursive: true });
  const measurements = await measureScenes(GEN_DIR, script, GEN_DIR);
  const renderErrors = new Map<number, string>();
  for (const i of SCENES) {
    const m = measurements.find((mm) => mm.scene === i);
    const shot = path.join(GEN_DIR, `measure-scene-${i}.png`);
    const exists = await fs.stat(shot).then(() => true).catch(() => false);
    if (m?.error || !exists) {
      renderErrors.set(i, m?.error ?? "no screenshot produced");
      console.error(`scene ${i}: RENDER FAILED — ${renderErrors.get(i)}`);
      continue;
    }
    await fs.copyFile(shot, path.join(OUT_DIR, `scene${i}.png`));
    console.log(`scene ${i}: ${path.join(OUT_DIR, `scene${i}.png`)}`);
  }

  // ── report ──────────────────────────────────────────────────────────────
  const inputTokens = canary.inputTokens + stats.reduce((n, s) => n + s.inputTokens, 0);
  const outputTokens = canary.outputTokens + stats.reduce((n, s) => n + s.outputTokens, 0);
  const usd = (inputTokens * USD_PER_M_IN + outputTokens * USD_PER_M_OUT) / 1e6;
  const report = {
    experiment: "scene-parallel: 5 whole-Section calls in parallel (one per scene)",
    ref: REF_BUILD,
    model,
    effort: EFFORT,
    maxTokensPerScene: MAX_TOKENS,
    generatedAt: new Date().toISOString(),
    canary: { secs: canary.seconds, inputTokens: canary.inputTokens, outputTokens: canary.outputTokens, stopReason: canary.stopReason },
    sceneGenWallSeconds,
    wallTotalSeconds: (Date.now() - tRun) / 1000,
    scenes: stats,
    repairs: stats.filter((s) => s.repaired).length,
    failures: stats.filter((s) => s.placeholder).map((s) => ({ scene: s.scene, reason: s.failReason })),
    composition: { chars: composition.length, compileError },
    render: SCENES.map((i) => ({ scene: i, ok: !renderErrors.has(i), error: renderErrors.get(i) })),
    cost: { inputTokens, outputTokens, usdPerMIn: USD_PER_M_IN, usdPerMOut: USD_PER_M_OUT, usd },
    genDir: GEN_DIR,
  };
  await fs.writeFile(path.join(OUT_DIR, "build-report.json"), JSON.stringify(report, null, 2), "utf8");
  await fs.writeFile(path.join(OUT_DIR, "index.html"), galleryHtml(report, stats, renderErrors), "utf8");

  console.log(`\nreport:  ${path.join(OUT_DIR, "build-report.json")}`);
  console.log(`gallery: ${path.join(OUT_DIR, "index.html")}`);
  console.log(
    `wall ${report.wallTotalSeconds.toFixed(1)}s (scene-gen ${sceneGenWallSeconds.toFixed(1)}s) · ` +
      `${inputTokens} in / ${outputTokens} out tok · $${usd.toFixed(4)} projected · ` +
      `${report.repairs} repairs · ${report.failures.length} placeholders`,
  );
};

await main();
