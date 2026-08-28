/**
 * RB_BUILD_MODE=harness — the one-author engine (docs/HARNESS.md).
 *
 * retrieve → author → verify → revise-once → decompose. Models do all
 * judgment; this module only feeds (pack), executes (render), and checks
 * (validators). Mirrors runCastPreviewBuild's contract exactly so the route,
 * ceremony UI, editor, persistence, and metering are untouched.
 *
 * The loop (render → critic → one revision) ships behind RB_HARNESS_LOOP
 * (default on) with a strict-improvement guard: a revised page is kept only
 * if it beats its own predecessor pairwise — the loop cannot make the deck
 * worse. Its measured value is still an open experiment (docs/HARNESS.md).
 */
import { promises as fsp } from "fs";
import path from "path";

import { BuildTimeline } from "../agents/build-timeline";
import { decomposeGenDir } from "../agents/lego-store";
import { resolveCornerBrandMark } from "../agents/logo-inject";
import { resolveCanvasPlan, signatureWithLogoFallback, brandShortName } from "../crawl/brand-identity";
import { deriveCrawlTheme } from "../render/crawl-theme";
import { persistGenDir } from "../render/gen-store";
import { measureScenes } from "../render/measure-scene";
import { measureOutDir } from "../render/render-truth-gates";
import { verifyScenesRender } from "../render/ssr-render";
import { writeGeneratedFiles } from "../render/build-wrapper";
import { callZaiVision, extractJsonFromReasoning } from "../render/zai-vision";
import { castCall } from "../llm/cast-provider";

import { assemblePack, packAssetAllowlist, type PackInput } from "./pack";
import { authorDeck } from "./author";
import { validateDeck, type TruthViolation } from "./validators";

interface HarnessBuildArgs {
  // Loose on purpose: LoadedScript/LoadedBrief stay owned by run-preview-build.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  script: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  brief: any;
  scriptId: string;
  ownerId: string;
  genDir: string;
  timeline: BuildTimeline;
  buildT0: number;
  brandTruthDegraded: string[] | undefined;
}

interface RouteResult {
  status: number;
  body: Record<string, unknown>;
}

const CRITIC_TOKENS = 8192; // judgment thinking ate 2048 in M5 — never lower.

const sceneIntent = (s: { label?: string; description?: string }, i: number): string =>
  `Page ${i + 1} — ${s.label ?? "untitled"}: ${s.description ?? ""}`;

export const runHarnessPreviewBuild = async (args: HarnessBuildArgs): Promise<RouteResult> => {
  const { script, brief, scriptId, genDir, timeline, buildT0 } = args;
  const scenes: PackInput["scenes"] = (script.scenes ?? []).map(
    (s: { label?: string; description?: string; content?: unknown }) => ({
      label: s.label ?? "",
      description: s.description ?? "",
      content: typeof s.content === "string" ? s.content : JSON.stringify(s.content ?? {}),
    }),
  );
  const n = scenes.length;
  if (!n) return { status: 400, body: { error: "script has no scenes", stage: "harness" } };

  try {
    // ── Brand facts: the crawl's retrieved reality, same helpers as cast. ──
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const be: any = brief?.brand_extract?.ok ? brief.brand_extract : undefined;
    const canvasPlan = resolveCanvasPlan(be);
    const signature =
      signatureWithLogoFallback(be?.palette ?? [], be?.theme_color, be?.logo_color, be?.named) ??
      be?.theme_color ??
      (be?.palette ?? [])[0] ??
      "#666666";
    const brand = brandShortName(be);
    const derived = deriveCrawlTheme(be, canvasPlan.background, canvasPlan.mode, signature, be?.palette ?? []);
    void derived; // theme derivation is validated context; the author owns styling.
    const userLogo = brief?.brand_files?.find((f: { is_logo?: boolean }) => f.is_logo);
    const { logoSrc } = resolveCornerBrandMark({
      userLogoUrl: userLogo?.url,
      logoHd: be?.logo_hd,
      brandName: brand,
    });
    const aspect = (["16:9", "9:16", "1:1"].includes(script.config?.aspect_ratio ?? "")
      ? script.config.aspect_ratio
      : "16:9") as PackInput["aspect"];

    const packInput: PackInput = {
      briefPrompt: String(brief?.prompt ?? brief?.brief ?? ""),
      tone: script.config?.tone,
      aspect,
      scenes,
      brand: {
        brandName: brand,
        palette: (be?.palette ?? []).slice(0, 8),
        logoSrc: logoSrc ?? null,
        mode: canvasPlan.mode === "light" ? "light" : "dark",
        background: canvasPlan.background,
      },
      assetUrls: (brief?.brand_files ?? [])
        .map((f: { url?: string }) => f.url)
        .filter((u: unknown): u is string => typeof u === "string"),
    };
    const pack = assemblePack(packInput);
    const approvedText = [packInput.briefPrompt, ...scenes.map((s) => `${s.label} ${s.description} ${s.content}`)].join("\n");
    const allowedUrls = packAssetAllowlist(packInput);

    // ── Author: one call, whole deck, one mind. ──
    timeline.mark("harness:author:start");
    const authored = await authorDeck(pack, n, {
      onAttempt: (a) => timeline.mark(`harness:author:${a.model.split("/").pop()}:${a.ok ? "ok" : "failed"} (${a.seconds}s, ${a.outputTokens}tok)`),
    });
    let code = authored.code;
    timeline.mark("design:scaffold:done");
    // Trace review is protocol: persist the author's reasoning next to the deck.
    // mkdir first — this runs BEFORE writeGeneratedFiles creates the genDir, and
    // the verification build proved the silent .catch was eating the ENOENT.
    await fsp.mkdir(genDir, { recursive: true }).catch(() => {});
    await fsp
      .writeFile(
        path.join(genDir, "harness-trace.json"),
        JSON.stringify({ model: authored.model, attempts: authored.attempts, thinking: authored.thinking }, null, 2),
      )
      .catch(() => {});

    // ── Truth validators → one targeted patch, then ship FLAGGED if needed. ──
    let violations = validateDeck({ code, approvedText, sceneCount: n, allowedUrls, logoSrc: packInput.brand.logoSrc });
    // Instrument-distrust ceiling (timing autopsy, 2026-08-27): the A/B batch
    // burned 116-142s per build patching 28-55 PHANTOM violations from validator
    // bugs. A deck does not invent dozens of numerals; an instrument does.
    // Untrusted measurements can't block — and they can't SPEND either.
    const SANITY_CEILING = 12;
    if (violations.length > SANITY_CEILING) {
      timeline.mark(`harness:validate:INSTRUMENT-SUSPECT (${violations.length} > ${SANITY_CEILING}) — no patch spent, shipping flagged for review`);
    } else if (violations.length) {
      timeline.mark(`harness:validate:${violations.length} violation(s) — patching`);
      const patched = await surgicalPatch(code, violations, authored.model);
      if (patched) {
        code = patched;
        violations = validateDeck({ code, approvedText, sceneCount: n, allowedUrls, logoSrc: packInput.brand.logoSrc });
      }
    }
    timeline.mark(`harness:validate:${violations.length ? `residual ${violations.length} (shipping flagged)` : "clean"}`);

    // ── Write genDir through the guarded shared path (code jail + shims). ──
    await writeGeneratedFiles(genDir, {
      code,
      designCode: code,
      script,
      warnings: violations.length ? { harness_truth_residual: violations } : undefined,
    });

    let renderCheck = await verifyScenesRender(genDir, n, script);
    timeline.mark(`harness:gate:ssr-render:${renderCheck.ok ? "passed" : "failed"}`);
    if (!renderCheck.ok) {
      // One mechanical repair: feed the render errors back to the author model.
      const repaired = await surgicalPatch(
        code,
        renderCheck.errors.map((e: unknown) => ({
          kind: "invented-numeral" as const,
          detail: String(e).slice(0, 200),
          patch: `Fix this render error without changing the design: ${String(e).slice(0, 300)}`,
        })),
        authored.model,
      );
      if (repaired) {
        code = repaired;
        await writeGeneratedFiles(genDir, { code, designCode: code, script });
        renderCheck = await verifyScenesRender(genDir, n, script);
        timeline.mark(`harness:gate:ssr-render:retry:${renderCheck.ok ? "passed" : "failed"}`);
      }
    }
    if (!renderCheck.ok) {
      await fsp.writeFile(path.join(genDir, "build-timeline.json"), JSON.stringify(timeline.toJSON(), null, 2)).catch(() => {});
      return { status: 500, body: { error: "one or more scenes failed to render", stage: "harness-render", render_errors: renderCheck.errors } };
    }
    for (let i = 0; i < n; i++) timeline.mark(`design:fill:scene:${i}:done`);
    timeline.mark("design:fills:done");

    // ── Loop: render → comparative critic → ONE revision, strict-improvement. ──
    if ((process.env.RB_HARNESS_LOOP ?? "on") !== "off") {
      try {
        code = await lookAndReviseOnce({ genDir, script, scenes, code, pack, model: authored.model, timeline, n });
      } catch (err) {
        timeline.mark(`harness:loop:skipped (${String(err).slice(0, 80)})`);
      }
    }

    // ── Decompose for the editor; durability is unconditional. ──
    try {
      const lego = await decomposeGenDir(genDir);
      timeline.mark(`harness:decompose:${lego.ok ? `${lego.pieces} pieces` : `skipped (${lego.reason})`}`);
      if (!lego.ok) console.error(`[preview/build:harness] decompose FAILED (${lego.reason}) — deck persisted whole; per-piece editing degraded for ${scriptId}`);
    } finally {
      await persistGenDir(scriptId);
    }

    // Final warnings write — later writeGeneratedFiles calls (repair/loop) would
    // otherwise clobber the flagged residuals recorded at the first write.
    if (violations.length) {
      await fsp
        .writeFile(path.join(genDir, "warnings.json"), JSON.stringify({ harness_truth_residual: violations }, null, 2))
        .catch(() => {});
    }
    await fsp.writeFile(path.join(genDir, "build-timeline.json"), JSON.stringify(timeline.toJSON(), null, 2)).catch(() => {});
    return {
      status: 200,
      body: {
        ok: true,
        scriptId,
        engine: "harness",
        model: authored.model,
        attempts: authored.attempts,
        truthResidual: violations.length,
        buildWallMs: Date.now() - buildT0,
      },
    };
  } catch (err) {
    await fsp.writeFile(path.join(genDir, "build-timeline.json"), JSON.stringify(timeline.toJSON(), null, 2)).catch(() => {});
    return { status: 500, body: { error: String(err).slice(0, 500), stage: "harness" } };
  }
};

/** Full-file targeted patch: name the exact defects, demand minimal edits. */
const surgicalPatch = async (code: string, violations: TruthViolation[], model: string): Promise<string | null> => {
  const r = await castCall({
    system: "",
    user: `Below is a complete React deck file, followed by specific defects. Apply the SMALLEST possible edits that fix every defect. Change nothing else — no restyling, no rewrites. Reply with ONLY the corrected complete file in one \`\`\`tsx block.\n\n\`\`\`tsx\n${code}\n\`\`\`\n\nDEFECTS:\n${violations.map((v, i) => `${i + 1}. ${v.patch}`).join("\n")}`,
    maxTokens: 30_000,
    model,
    timeoutMs: 300_000,
    effort: "high",
    thinkingBudget: 4000,
  });
  const m = [...(r.text ?? "").matchAll(/```(?:tsx|typescript|jsx|ts)?\s*\n([\s\S]*?)```/g)].map((x) => x[1]);
  const out = m.length ? m.reduce((a, b) => (b.length > a.length ? b : a)) : null;
  // Byte sanity: a patch that shrinks the file dramatically is a rewrite or a
  // truncation, not a patch — reject it (verify-by-bytes doctrine).
  return out && out.length > code.length * 0.6 ? out : null;
};

/** One critic pass + one revision, kept only if it beats the original pairwise. */
const lookAndReviseOnce = async (args: {
  genDir: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  script: any;
  scenes: PackInput["scenes"];
  code: string;
  pack: string;
  model: string;
  timeline: BuildTimeline;
  n: number;
}): Promise<string> => {
  const { genDir, script, scenes, pack, model, timeline, n } = args;
  let { code } = args;
  timeline.mark("harness:critic:start");
  const before = await measureScenes(genDir, script, measureOutDir(genDir));
  // All pages judged CONCURRENTLY — the A/B batch spent 161-242s here running
  // them one-at-a-time (timing autopsy, 2026-08-27). Parallelism changes the
  // plumbing around the judgments, never the judgments.
  const pageNotes = await Promise.all(
    Array.from({ length: n }, (_, i) => (async (): Promise<{ page: number; weakness: string } | null> => {
      const shot = await shotBase64(before[i]?.screenshotPath, genDir, i);
      if (!shot) return null;
      const r = await callZaiVision(
        shot,
        `This slide was authored for the intent: "${sceneIntent(scenes[i], i)}". Judge it against that intent for an executive audience. Reply ONLY JSON: {"ship": true|false, "weakness": "<the ONE decisive weakness, or empty if ship>"}`,
        { timeoutMs: 120_000, maxTokens: CRITIC_TOKENS, stage: "harness-critic" },
      );
      const raw = (r.text ?? "").match(/\{[\s\S]*\}/)?.[0] ?? extractJsonFromReasoning(r.text ?? "");
      try {
        const v = raw ? JSON.parse(raw) : null;
        if (v && v.ship === false && v.weakness) return { page: i, weakness: String(v.weakness).slice(0, 300) };
      } catch {
        /* an unparseable verdict never blocks — decks always ship */
      }
      return null;
    })().catch(() => null)),
  );
  const notes = pageNotes.filter((x): x is { page: number; weakness: string } => x !== null);
  timeline.mark(`harness:critic:done (${notes.length} page(s) flagged)`);
  if (!notes.length) return code;
  // Snapshot the flagged pages' pixels now — the revision re-measure
  // overwrites the same PNG paths (the stale-rects trap, 2026-08-24 edition).
  const beforeShots = new Map<number, string>();
  for (const f of notes) {
    const b64 = await shotBase64(before[f.page]?.screenshotPath, genDir, f.page);
    if (b64) beforeShots.set(f.page, b64);
  }

  const r = await castCall({
    system: "",
    user: `${pack}\n\nYou already authored the file below. A design review flagged specific pages. Revise ONLY the flagged pages' sections — a surgical pass (M1-measured: healthy revisions touch ≤15% of the file). Keep the identity, chrome, and all other pages byte-identical. Reply with ONLY the complete revised file in one \`\`\`tsx block.\n\n\`\`\`tsx\n${code}\n\`\`\`\n\nFLAGGED:\n${notes.map((f) => `Page ${f.page + 1}: ${f.weakness}`).join("\n")}`,
    maxTokens: 30_000,
    model,
    timeoutMs: 300_000,
    effort: "high",
    thinkingBudget: 6000,
  });
  const blocks = [...(r.text ?? "").matchAll(/```(?:tsx|typescript|jsx|ts)?\s*\n([\s\S]*?)```/g)].map((x) => x[1]);
  const revised = blocks.length ? blocks.reduce((a, b) => (b.length > a.length ? b : a)) : null;
  if (!revised || revised.length < code.length * 0.6) return code;

  // Strict improvement: render the revision and let the pairwise judge decide
  // per flagged page. Revision wins only on majority — else the original stays.
  await writeGeneratedFiles(genDir, { code: revised, designCode: revised, script });
  const check = await verifyScenesRender(genDir, n, script);
  if (!check.ok) {
    await writeGeneratedFiles(genDir, { code, designCode: code, script });
    timeline.mark("harness:revise:rejected (revision broke a render)");
    return code;
  }
  const after = await measureScenes(genDir, script, measureOutDir(genDir));
  const pairVerdicts = await Promise.all(
    notes.map((f) => (async (): Promise<boolean> => {
      const a = beforeShots.get(f.page) ?? null;
      const b = await shotBase64(after[f.page]?.screenshotPath, genDir, f.page);
      if (!a || !b) return false;
      const r2 = await callZaiVision(
        [a, b],
        `Two versions of one slide (FIRST then SECOND), intent: "${sceneIntent(scenes[f.page], f.page)}". Which better achieves the intent? Reply ONLY JSON: {"winner":"FIRST"|"SECOND"}`,
        { timeoutMs: 120_000, maxTokens: CRITIC_TOKENS, stage: "harness-pairwise" },
      );
      const raw = (r2.text ?? "").match(/\{[\s\S]*\}/)?.[0] ?? extractJsonFromReasoning(r2.text ?? "");
      try {
        return !!raw && JSON.parse(raw).winner === "SECOND";
      } catch {
        return false; /* undecided counts against the revision */
      }
    })().catch(() => false)),
  );
  const wins = pairVerdicts.filter(Boolean).length;
  if (wins * 2 > notes.length) {
    timeline.mark(`harness:revise:kept (${wins}/${notes.length} pages improved)`);
    return revised;
  }
  await writeGeneratedFiles(genDir, { code, designCode: code, script });
  timeline.mark(`harness:revise:rejected (${wins}/${notes.length} — original stays)`);
  return code;
};

const shotBase64 = async (shotPath: string | undefined, genDir: string, i: number): Promise<string | null> => {
  for (const p of [shotPath, path.join(measureOutDir(genDir), `measure-scene-${i}.png`)]) {
    if (!p) continue;
    try {
      return (await fsp.readFile(p)).toString("base64");
    } catch { /* fall through */ }
  }
  return null;
};
