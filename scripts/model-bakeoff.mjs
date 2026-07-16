#!/usr/bin/env node
/**
 * Model bake-off — the speed×quality decision harness (pivot 2026-07-14).
 *
 * Runs the SAME two workloads against every provider whose key is present:
 *   1. ELEMENT CAST — 14 creation-grade element briefs from a real build's
 *      lego manifest (the M0 set): the "emit fast at the leaves" workload.
 *      Anthropic-native providers run these thinking-OFF; GLM runs thinking-on
 *      (its floor) — that handicap IS the honest comparison.
 *   2. HEAD — one merged script+design-system call: the "think once at the
 *      head" workload (thinking ON/adaptive where supported).
 *
 * Measures per call: wall, output tokens, visible/thinking split, TSX syntax
 * check (esbuild). Writes .data/bakeoff/<ts>.json + prints a comparison table.
 * Quality scoring beyond syntax (render-truth gates + vision + eyeball) runs
 * in phase 2 on the winner's full build — this harness picks the shortlist.
 *
 * Providers (skipped silently when the env key is absent):
 *   zai-glm52        ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY   (baseline/control)
 *   sonnet5          BAKEOFF_ANTHROPIC_KEY                     claude-sonnet-5
 *   haiku45          BAKEOFF_ANTHROPIC_KEY                     claude-haiku-4-5-20251001
 *   opus48           BAKEOFF_ANTHROPIC_KEY                     claude-opus-4-8
 *   together-glm     BAKEOFF_TOGETHER_KEY                      zai-org/GLM-5.2 (fast-served control)
 *   cerebras         BAKEOFF_CEREBRAS_KEY + BAKEOFF_CEREBRAS_MODEL
 *   gemini           BAKEOFF_GEMINI_KEY + BAKEOFF_GEMINI_MODEL (openai-compat endpoint)
 *
 * Usage: set -a && source .env.local && set +a && node scripts/model-bakeoff.mjs [--head-only|--elements-only]
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as esbuild from "esbuild";

const ROOT = process.cwd();
const REF_BUILD = "01KXEAF0SNT0RR079Z1SJZ1KWZ"; // last clean HubSpot build

// ── providers ────────────────────────────────────────────────────────────────

const PROVIDERS = [
  {
    id: "zai-glm52", wire: "anthropic", model: "glm-5.2",
    baseURL: process.env.ANTHROPIC_BASE_URL, key: process.env.ANTHROPIC_API_KEY,
    // GLM cannot think less than "high" and breaks with thinking off — this is
    // the measured baseline handicap, represented honestly.
    elementThinking: { thinking: { type: "enabled" }, reasoning_effort: "high" },
    headThinking: { thinking: { type: "enabled" }, reasoning_effort: "high" },
  },
  {
    id: "sonnet5", wire: "anthropic", model: "claude-sonnet-5",
    baseURL: "https://api.anthropic.com", key: process.env.BAKEOFF_ANTHROPIC_KEY,
    elementThinking: {}, // thinking OFF at the leaves
    headThinking: { thinking: { type: "adaptive" } },
  },
  {
    id: "haiku45", wire: "anthropic", model: "claude-haiku-4-5-20251001",
    baseURL: "https://api.anthropic.com", key: process.env.BAKEOFF_ANTHROPIC_KEY,
    elementThinking: {},
    headThinking: {}, // haiku: no adaptive; run plain
  },
  {
    id: "opus48", wire: "anthropic", model: "claude-opus-4-8",
    baseURL: "https://api.anthropic.com", key: process.env.BAKEOFF_ANTHROPIC_KEY,
    elementThinking: {},
    headThinking: { thinking: { type: "adaptive" } },
  },
  {
    id: "together-glm", wire: "openai", model: process.env.BAKEOFF_TOGETHER_MODEL || "zai-org/GLM-5.2",
    baseURL: "https://api.together.xyz/v1", key: process.env.BAKEOFF_TOGETHER_KEY,
    elementThinking: {}, headThinking: {},
  },
  {
    id: "cerebras", wire: "openai", model: process.env.BAKEOFF_CEREBRAS_MODEL,
    baseURL: "https://api.cerebras.ai/v1", key: process.env.BAKEOFF_CEREBRAS_KEY,
    // Cerebras pre-debits max_completion_tokens against the TPM bucket before
    // generating — send the param their docs name, keep caps tight upstream.
    tokenParam: "max_completion_tokens",
    // The doctrine as literal API params. gpt-oss has a REAL graded effort
    // dial (low/medium/high) — think at the head, emit at the leaves.
    // zai-glm-4.7 on Cerebras supports reasoning_effort "none" (a true off
    // switch, added 2026-02-27) — the mode z.ai's own API refuses to serve.
    elementThinking: (process.env.BAKEOFF_CEREBRAS_MODEL ?? "").startsWith("gpt-oss")
      ? { reasoning_effort: "low" }
      : (process.env.BAKEOFF_CEREBRAS_MODEL ?? "").startsWith("zai-glm")
        ? { reasoning_effort: "none" }
        : {},
    headThinking: (process.env.BAKEOFF_CEREBRAS_MODEL ?? "").startsWith("gpt-oss")
      ? { reasoning_effort: "high" }
      : {},
  },
  {
    id: "gemini", wire: "openai", model: process.env.BAKEOFF_GEMINI_MODEL,
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", key: process.env.BAKEOFF_GEMINI_KEY,
    elementThinking: {}, headThinking: {},
  },
];

async function callAnthropic(p, system, user, extra, maxTokens) {
  const t0 = Date.now();
  const res = await fetch(`${p.baseURL}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": p.key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: p.model, max_tokens: maxTokens, ...extra, system, messages: [{ role: "user", content: user }] }),
    signal: AbortSignal.timeout(600000),
  });
  const j = await res.json();
  if (j?.error) throw new Error(`${j.error.type ?? ""} ${String(j.error.message ?? "").slice(0, 120)}`);
  const text = (j.content ?? []).find((c) => c.type === "text")?.text ?? "";
  const thinking = (j.content ?? []).find((c) => c.type === "thinking")?.thinking ?? "";
  return { text, thinking, out: j.usage?.output_tokens ?? 0, in: j.usage?.input_tokens ?? 0, secs: (Date.now() - t0) / 1000, stop: j.stop_reason };
}

async function callOpenai(p, system, user, extra, maxTokens) {
  const t0 = Date.now();
  const res = await fetch(`${p.baseURL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${p.key}` },
    body: JSON.stringify({
      model: p.model,
      [p.tokenParam ?? "max_tokens"]: maxTokens,
      // Per-workload reasoning config (reasoning_effort etc.) — dropping this
      // silently ran every openai-wire provider at its default effort.
      ...extra,
      messages: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: user }],
    }),
    signal: AbortSignal.timeout(600000),
  });
  const j = await res.json();
  if (j?.error) throw new Error(String(j.error.message ?? j.error).slice(0, 120));
  const msg = j.choices?.[0]?.message ?? {};
  return {
    text: msg.content ?? "", thinking: msg.reasoning_content ?? msg.reasoning ?? "",
    out: j.usage?.completion_tokens ?? 0, in: j.usage?.prompt_tokens ?? 0,
    secs: (Date.now() - t0) / 1000, stop: j.choices?.[0]?.finish_reason,
  };
}

const call = (p, ...args) => (p.wire === "anthropic" ? callAnthropic(p, ...args) : callOpenai(p, ...args));

// ── workloads (mirrors the validated M0 + merged-head probes) ────────────────

const manifest = JSON.parse(readFileSync(path.join(ROOT, `src/generated/${REF_BUILD}/lego/manifest.json`), "utf8"));
const script = JSON.parse(readFileSync(path.join(ROOT, `src/generated/${REF_BUILD}/script.json`), "utf8"));
const elide = (s) => s.replace(/data:[a-zA-Z0-9/+;=,._-]{200,}/g, "data:ELIDED");
const preamble = elide(manifest.preamble.trim());

const ELEMENT_SYSTEM = `You CREATE one element ("piece") of an animated brand-video scene from a brief.
You are given the scene's shared design system (module consts already in scope) and a brief for ONE new element. Emit ONLY the JSX for this ONE element.
HARD RULES:
- Output ONLY the JSX — no imports, no prose, no markdown fence.
- Reference the shared consts (PALETTE.*, FONT_*, LOGO_SRC, the @keyframes names) EXACTLY as defined. NEVER invent colors, fonts, or @keyframes.
- position:absolute inside the given BOUNDS on a 1920x1080 canvas.
- Text renders the given copy VERBATIM with data-content-path tags. Never invent numbers or claims.
- CSS animation only; no Remotion hooks; no Math.random. Nothing at module scope; no undefined components.
- Rich, production-grade, dense — a hero element of a premium brand video.
- Valid TSX that compiles when inlined.
SHARED DESIGN SYSTEM:
\`\`\`tsx
${preamble}
\`\`\``;

const BOUNDS = {
  atmosphere: "left 0, top 0, width 1920, height 1080 (full-bleed decorative layer)",
  text: "left 120, top 260, width 700 (flow height — the copy column)",
  diegetic: "left 960, top 200, width 820, height 640 (the hero visual column)",
  image: "left 960, top 200, width 820, height 640",
  chrome: "bottom bar: left 0, top 1000, width 1920, height 80",
};
const copyLines = (scene) => {
  const c = scene.content || {};
  const out = [];
  if (c.eyebrow) out.push(`eyebrow: "${c.eyebrow}" (data-content-path="eyebrow")`);
  if (c.headline) out.push(`headline: "${c.headline}" (data-content-path="headline")`);
  if (c.lede) out.push(`lede: "${c.lede}" (data-content-path="lede")`);
  // Dot-form paths — choreograph.ts fieldsOf() convention; bracket-form tags
  // never receive entrance choreography (cast-build contract review 2026-07-14).
  if (Array.isArray(c.bullets)) c.bullets.forEach((b, i) => out.push(`bullet[${i}]: "${b}" (data-content-path="bullets.${i}")`));
  return out.join("\n");
};
const elementBrief = (sceneIdx, piece) => {
  const scene = script.scenes[sceneIdx];
  const lines = [
    `CREATE this element — scene ${sceneIdx} ("${scene.label}", register ${scene.register}), piece id "${piece.id}", kind "${piece.kind}".`,
    `Scene intent: ${scene.description ?? scene.label}`,
    `Visual concept (this piece's role within it): ${String(scene.visual_concept || "").slice(0, 600)}`,
    `BOUNDS: ${BOUNDS[piece.kind] ?? BOUNDS.diegetic}`,
  ];
  if (piece.kind === "text") lines.push(`SCENE COPY (verbatim, tagged):\n${copyLines(scene)}`);
  // Anchor matches throughlineAnchorFor("16:9") = (1360, 540) — the wrapper div
  // carries data-throughline + placement in production (assemble.ts contract);
  // here the element self-positions since the harness renders bodies standalone.
  if (piece.id.includes("throughline")) lines.push(`This piece IS the throughline motif: ${script.narrative?.throughline ?? ""}. Wrap in <div data-throughline="THROUGHLINE_SLUG"> anchored near (left 1360, top 540).`);
  if (piece.kind === "chrome") lines.push(`BrandChrome bar: use the shared Chrome/logo consts.`);
  lines.push("", "Emit ONLY the JSX for THIS element.");
  return lines.join("\n");
};
const ELEMENT_JOBS = manifest.scenes.slice(0, 3).flatMap((sc) => sc.pieces.map((p) => ({ scene: sc.sceneIndex, piece: p })));

const HEAD_TASK = `You are the creative director for a 30-second HubSpot brand video (1920x1080, 5 scenes).
Brief: The all-in-one customer platform... marketing, sales, and service run from one place. Confident, modern, product-forward. Brand: HubSpot orange #ff7a59 on deep navy/white; Lexend/Inter.
Deliver BOTH in ONE response:
## PART 1 — SCRIPT (JSON): 5 scenes (label, register, description, visual_concept with Animations timings in seconds, content{eyebrow,headline,lede,bullets[],caption}) + narrative{logline,arc,throughline (ONE concrete recurring visual motif)}.
## PART 2 — DESIGN SYSTEM (TSX module block): PALETTE, FONT_DISPLAY/BODY/MONO, EASE_*, 6-10 shared @keyframes as SHARED_KEYFRAMES, a BrandChrome component, a ThroughlineMotif component (CSS-animated, phase prop), 2-3 helper components — one coherent design grammar. Inline styles, no imports, production-grade.`;

// ── scoring ──────────────────────────────────────────────────────────────────

async function syntaxOk(frag) {
  try {
    await esbuild.transform(`export const T = () => (<div>${frag}</div>);`, { loader: "tsx" });
    return true;
  } catch {
    return false;
  }
}

// ── run ──────────────────────────────────────────────────────────────────────

const mode = process.argv[2] ?? "";
const active = PROVIDERS.filter((p) => p.baseURL && p.key && p.model);
console.log(`providers: ${active.map((p) => p.id).join(", ") || "(none)"} — skipped: ${PROVIDERS.filter((p) => !active.includes(p)).map((p) => p.id).join(", ")}`);

const results = {};
for (const p of active) {
  const r = { elements: [], head: null, errors: [] };
  results[p.id] = r;
  console.log(`\n=== ${p.id} (${p.model}) ===`);

  if (mode !== "--head-only") {
    // cache-warm serially, then wave (10-wide max)
    const jobs = [...ELEMENT_JOBS];
    const runOne = async (job) => {
      try {
        const res = await call(p, ELEMENT_SYSTEM, elementBrief(job.scene, job.piece), p.elementThinking, 6000);
        const frag = res.text.trim().replace(/^```\w*\n?|```$/g, "");
        const ok = frag.length > 40 && !/^\s*import\b/.test(frag) && /</.test(frag) && (await syntaxOk(frag));
        // `code` persists the emitted JSX so the eyeball gallery (scripts/bakeoff-eyeball.ts)
        // can render what each provider actually generated — stats alone can't be eyeballed.
        return { id: job.piece.id, kind: job.piece.kind, out: res.out, secs: res.secs, visible: frag.length, thinking: res.thinking.length, ok, stop: res.stop, code: frag };
      } catch (e) {
        r.errors.push(`${job.piece.id}: ${e.message}`);
        return { id: job.piece.id, kind: job.piece.kind, out: 0, secs: 0, visible: 0, thinking: 0, ok: false, stop: "error" };
      }
    };
    r.elements.push(await runOne(jobs[0])); // warm
    for (let i = 1; i < jobs.length; i += 10) {
      r.elements.push(...(await Promise.all(jobs.slice(i, i + 10).map(runOne))));
    }
    const oks = r.elements.filter((e) => e.ok);
    const mean = (a, f) => (a.length ? a.reduce((x, y) => x + f(y), 0) / a.length : 0);
    console.log(`elements: ${oks.length}/${r.elements.length} ok | mean out=${mean(oks, (e) => e.out).toFixed(0)} tok | mean wall=${mean(oks, (e) => e.secs).toFixed(1)}s | REGEN TARGET <20s: ${oks.filter((e) => e.secs < 20).length}/${oks.length} meet it`);
  }

  if (mode !== "--elements-only") {
    try {
      const res = await call(p, "", HEAD_TASK, p.headThinking, 60000);
      const hasScript = /"scenes"|## PART 1|headline/.test(res.text);
      const hasDS = /PALETTE|SHARED_KEYFRAMES|BrandChrome/.test(res.text);
      r.head = { out: res.out, secs: res.secs, visible: res.text.length, thinking: res.thinking.length, ok: hasScript && hasDS, stop: res.stop };
      console.log(`head: out=${res.out} wall=${res.secs.toFixed(0)}s complete=${r.head.ok}`);
    } catch (e) {
      r.errors.push(`head: ${e.message}`);
      console.log(`head: ERROR ${e.message}`);
    }
  }
  if (r.errors.length) console.log(`errors: ${r.errors.length} — ${r.errors.slice(0, 3).join(" | ")}`);
}

// ── summary + persist ────────────────────────────────────────────────────────

console.log("\n=== BAKE-OFF SUMMARY ===");
console.log("provider       | elem ok | elem mean tok | elem mean s | <20s | head tok | head s");
for (const [id, r] of Object.entries(results)) {
  const oks = r.elements.filter((e) => e.ok);
  const mean = (f) => (oks.length ? oks.reduce((x, y) => x + f(y), 0) / oks.length : 0);
  console.log(
    `${id.padEnd(14)} | ${String(oks.length + "/" + r.elements.length).padEnd(7)} | ${mean((e) => e.out).toFixed(0).padStart(13)} | ${mean((e) => e.secs).toFixed(1).padStart(11)} | ${String(oks.filter((e) => e.secs < 20).length + "/" + oks.length).padEnd(4)} | ${String(r.head?.out ?? "-").padStart(8)} | ${r.head ? r.head.secs.toFixed(0) : "-"}`,
  );
}
console.log("\nDecision needs phase 2 on the shortlist: full build behind the provider + render-truth gates + vision + founder eyeball.");

mkdirSync(path.join(ROOT, ".data", "bakeoff"), { recursive: true });
const file = path.join(ROOT, ".data", "bakeoff", `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(file, JSON.stringify({ ref: REF_BUILD, results }, null, 2));
console.log(`written: ${file}`);
