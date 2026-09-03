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
import { resolveCanvasPlan, signatureWithLogoFallback, brandShortName, luminanceOf } from "../crawl/brand-identity";
import { deriveCrawlTheme } from "../render/crawl-theme";
import { persistGenDir } from "../render/gen-store";
import { BuildCancelledError, buildCancelRequested, buildAbortSignal, reportBuildThinking } from "../render/build-jobs";
import { warmSceneThumbs } from "../render/thumbnail";
import { readDocumentBrand } from "../brand/document-brand";
import { documentBrandFromExtract } from "../documents/brand-crawl";
import { measureScenes } from "../render/measure-scene";
import { measureOutDir } from "../render/render-truth-gates";
import { verifyScenesRender } from "../render/ssr-render";
import { writeGeneratedFiles } from "../render/build-wrapper";
import { callZaiVision, extractJsonFromReasoning } from "../render/zai-vision";
import { castCall } from "../llm/cast-provider";

import { assemblePack, packAssetAllowlist, type PackInput } from "./pack";
import { authorDeck, authorContinuation, mergeChapters, missingSections, authorStreamEnabled, type AuthorAttempt, type AuthorStreamHooks } from "./author";
import { validateDeck, findLogoViolation, type TruthViolation } from "./validators";
import { EarlyCriticRunner, streamCriticsEnabled, critiquePageShot, sceneIntent, type EarlyVerdict } from "./stream-critics";
import { SectionWatcher } from "./stream-sections";
import { EDIT_BLOCKS_INSTRUCTION, applyEditBlocks, editBlocksEnabled, parseEditBlocks } from "./edit-blocks";
import { spliceSections } from "./splice-sections";
import { authorDraws, rankDraws } from "./draws";
import { authorParallel, authorParallelEnabled } from "./parallel-author";

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
// sceneIntent moved to stream-critics.ts (2026-09-01) so the early path and
// the join path share ONE prompt definition — imported above.

export const runHarnessPreviewBuild = async (args: HarnessBuildArgs): Promise<RouteResult> => {
  const { script, brief, scriptId, genDir, timeline, buildT0 } = args;
  const abortSignal = buildAbortSignal(scriptId);
  let earlyRunner: EarlyCriticRunner | null = null;
  const scenes: PackInput["scenes"] = (script.scenes ?? []).map(
    (s: { label?: string; description?: string; content?: unknown; visual_concept?: string }) => ({
      label: s.label ?? "",
      description: s.description ?? "",
      content: typeof s.content === "string" ? s.content : JSON.stringify(s.content ?? {}),
      ...(s.visual_concept?.trim() ? { visual: s.visual_concept } : {}),
    }),
  );
  const n = scenes.length;
  if (!n) return { status: 400, body: { error: "script has no scenes", stage: "harness" } };

  try {
    // ── Brand facts: the crawl's retrieved reality, same helpers as cast. ──
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const be: any = brief?.brand_extract?.ok ? brief.brand_extract : undefined;
    const canvasPlan = resolveCanvasPlan(be);
    // User-locked roles from the ceremony (brief.palette_roles) — decisions,
    // not crawl guesses. A locked background overrides the crawl's canvas
    // plan wholesale, mode included; a locked accent is handed to the author
    // labeled as THE accent (pack.ts renders the wording).
    const HEX6 = /^#[0-9a-fA-F]{6}$/;
    const rawRoles = (brief?.palette_roles ?? {}) as {
      accent?: string;
      background?: string;
      monochrome?: boolean;
    };
    const lockedAccent = HEX6.test(rawRoles.accent ?? "") ? rawRoles.accent : undefined;
    const lockedBackground = HEX6.test(rawRoles.background ?? "") ? rawRoles.background : undefined;
    if (lockedBackground) {
      canvasPlan.background = lockedBackground;
      canvasPlan.mode = (luminanceOf(lockedBackground) ?? 1) < 0.5 ? "dark" : "light";
    }

    // ── Brand type reaches the author (root-cause fix, 2026-08-31: fonts
    // were crawled and stored but never fed forward — every harness deck was
    // typeset in Helvetica regardless of brand). The user's panel picks
    // (document brand) beat the crawl's identity; a face URL rides along
    // only when its family actually appears in the chosen stack, so the
    // author never @font-faces a file the stack won't use.
    const docBrand = await readDocumentBrand(genDir).catch(() => null);
    const crawlBrand = be ? documentBrandFromExtract(be) : null;
    const faces = [...(docBrand?.fonts?.faces ?? []), ...(crawlBrand?.fonts?.faces ?? [])];
    const faceFor = (stack?: string): string | undefined => {
      if (!stack) return undefined;
      const hit = faces.find((f) => f.family && stack.includes(f.family) && f.src?.startsWith("https://"));
      return hit?.src;
    };
    const fontSlot = (slot: "display" | "body"): { stack: string; faceSrc?: string } | undefined => {
      const stack = docBrand?.fonts?.[slot] ?? crawlBrand?.fonts?.[slot];
      if (!stack) return undefined;
      const faceSrc = faceFor(stack);
      return { stack, ...(faceSrc ? { faceSrc } : {}) };
    };
    const monoStack = docBrand?.fonts?.mono;
    const brandFonts = {
      ...(fontSlot("display") ? { display: fontSlot("display")! } : {}),
      ...(fontSlot("body") ? { body: fontSlot("body")! } : {}),
      ...(monoStack ? { mono: { stack: monoStack } } : {}),
    };
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
        roles: {
          ...(lockedAccent ? { accent: lockedAccent } : {}),
          ...(lockedBackground ? { background: lockedBackground } : {}),
          ...(rawRoles.monochrome === true ? { monochrome: true } : {}),
        },
        ...(Object.keys(brandFonts).length ? { fonts: brandFonts } : {}),
      },
      assetUrls: (brief?.brand_files ?? [])
        .map((f: { url?: string }) => f.url)
        .filter((u: unknown): u is string => typeof u === "string"),
    };
    const pack = assemblePack(packInput);
    const approvedText = [packInput.briefPrompt, ...scenes.map((s) => `${s.label} ${s.description} ${s.content}`)].join("\n");
    const allowedUrls = packAssetAllowlist(packInput);

    // ── Author: one mind, one file — in ONE breath up to 8 pages, in
    // continuing chapters beyond (founder directive 2026-08-28: every deck
    // length runs the harness; longer decks honestly take longer). ──
    timeline.mark("harness:author:start");
    const CHAPTER = 6;
    const onAttempt = (a: AuthorAttempt) => timeline.mark(`harness:author:${a.model.split("/").pop()}:${a.ok ? "ok" : "failed"} (${a.seconds}s, ${a.outputTokens}tok)`);
    // Parallel authoring writes every page at once — no chapters to continue.
    const firstEnd = authorParallelEnabled() ? n : n <= 8 ? n : CHAPTER;
    const basePack = n <= 8 ? pack : assemblePack({ ...packInput, chapterEmitEnd: firstEnd });
    // ── Early critics (RB_STREAM_CRITICS, flag-gated OFF): critique each page
    // the moment its section closes in the author stream. Single-breath decks
    // only (n ≤ 8 = no chapters) and only when the look-and-revise loop that
    // consumes the verdicts is on. Off = this block is inert and the author
    // call below is byte-identical to before.
    if (streamCriticsEnabled() && n <= 8 && (process.env.RB_HARNESS_LOOP ?? "on") !== "off") {
      earlyRunner = new EarlyCriticRunner({ genDir, script, scenes, n, log: (l) => timeline.mark(l) });
      timeline.mark("harness:stream-critics:armed");
    }
    // ── Live ceremony feed (founder #3, 2026-09-01): whenever the author is
    // streamed — critics armed OR RB_AUTHOR_STREAM=on — surface (a) a curated
    // line of its reasoning (voice-over) and (b) a mark the moment each page's
    // section closes, so the per-page rows tick while the file is being
    // written. Sinks are FEATHER-LIGHT and throttled: the 2026-09-01 probe
    // measured heavy per-delta work correlating with longer completions.
    const runnerHooks = earlyRunner?.authorHooks();
    const displayWatcher = new SectionWatcher();
    let lastThinkAt = 0;
    let lastScanLen = 0;
    const curate = (acc: string): string => {
      const tail = acc.slice(-400).replace(/\s+/g, " ").trim();
      const end = Math.max(tail.lastIndexOf(". "), tail.lastIndexOf("! "), tail.lastIndexOf("? "));
      const cut = end > 120 ? tail.slice(0, end + 1) : tail;
      return cut.length > 180 ? `…${cut.slice(-180)}` : cut;
    };
    const streamHooks: AuthorStreamHooks | undefined =
      runnerHooks || authorStreamEnabled()
        ? {
            onAttemptStart: () => {
              runnerHooks?.onAttemptStart();
              displayWatcher.reset();
              lastScanLen = 0;
            },
            onText: (acc) => {
              runnerHooks?.onText(acc);
              if (acc.length - lastScanLen < 800) return; // throttle the scan
              lastScanLen = acc.length;
              for (const s of displayWatcher.feed(acc)) {
                if (s.index < n) timeline.mark(`harness:author:page:${s.index + 1}:written`);
              }
            },
            onThinking: (acc) => {
              const now = Date.now();
              if (now - lastThinkAt < 2000) return;
              lastThinkAt = now;
              reportBuildThinking(scriptId, curate(acc));
            },
          }
        : undefined;
    // RB_AUTHOR_DRAWS=2 (10x program, flagged, default 1): sample the deck
    // twice concurrently and let the per-page critics rank the draws
    // (lib/harness/draws.ts). The extra draw carries no stream hooks — the
    // ceremony narrates draw 1 — and the ranking verdicts ride into the loop
    // so the winner's critic pass is not paid twice.
    // RB_AUTHOR_PARALLEL=on (10x program, flagged, default off): design pass +
    // concurrent page passes (lib/harness/parallel-author.ts). Any failure
    // falls back to today's one-call author, so the worst case is today plus
    // the failed attempt's time.
    const parallel = authorParallelEnabled();
    const draws = parallel ? 1 : authorDraws();
    const drawErrors: unknown[] = [];
    const authoredAll = parallel
      ? [
          await authorParallel(packInput, n, { onAttempt, signal: abortSignal, mark: (l) => timeline.mark(l) }).catch(async (err: unknown) => {
            if (abortSignal?.aborted) throw err;
            timeline.mark(`harness:author:parallel:fallback (${String(err).slice(0, 100)})`);
            return authorDeck(basePack, firstEnd, { onAttempt, signal: abortSignal, ...(streamHooks ? { stream: streamHooks } : {}) });
          }),
        ]
      : await Promise.all(
      Array.from({ length: draws }, (_, k) =>
        authorDeck(basePack, firstEnd, {
          onAttempt: k === 0 ? onAttempt : (a) => timeline.mark(`harness:author:draw ${k + 1}:${a.ok ? "ok" : "failed"} (${a.seconds}s, ${a.outputTokens}tok)`),
          signal: abortSignal,
          ...(k === 0 && streamHooks ? { stream: streamHooks } : {}),
        }).catch((err: unknown) => {
          // Any draw may die (the first verification build lost draw 1 to a
          // transport "fetch failed" while draw 2 finished): the deck proceeds
          // with whichever draws survived; only NO survivor is today's failure.
          if (draws === 1 || abortSignal?.aborted) throw err;
          drawErrors.push(err);
          timeline.mark(`harness:author:draw ${k + 1}:absent (${String(err).slice(0, 80)})`);
          return null;
        }),
      ),
    );
    if (!authoredAll.some((a) => a)) throw drawErrors[0] ?? new Error("harness author: every draw failed");
    const authored = authoredAll.find((a): a is NonNullable<typeof a> => !!a)!;
    let drawVerdicts: { code: string; verdicts: Map<number, EarlyVerdict> } | null = null;
    if (draws > 1 && n <= 8) {
      const live = authoredAll.filter((a): a is NonNullable<typeof a> => !!a);
      if (live.length > 1) {
        const ranking = await rankDraws({
          genDir,
          script,
          scenes,
          n,
          draws: live.map((a) => ({
            code: a.code,
            violations: validateDeck({ code: a.code, approvedText, sceneCount: n, allowedUrls, logoSrc: packInput.brand.logoSrc }).length,
          })),
          log: (line) => timeline.mark(line),
        });
        const win = live[ranking.winner];
        timeline.mark(`harness:draws:winner draw ${ranking.winner + 1} (flagged ${ranking.flagged.map((f) => (f === null ? "?" : f)).join(" vs ")})`);
        authored.code = win.code;
        authored.thinking = win.thinking;
        authored.attempts = live.flatMap((a) => a.attempts);
        drawVerdicts = { code: win.code, verdicts: ranking.verdicts };
      }
    }
    let code = authored.code;
    const chapterThinking: string[] = [authored.thinking];
    for (let start = firstEnd; start < n; start += CHAPTER) {
      const end = Math.min(start + CHAPTER, n);
      timeline.mark(`harness:chapter:${start + 1}-${end}:start`);
      const cont = await authorContinuation(pack, code, start, end, authored.model, { onAttempt, signal: abortSignal });
      code = mergeChapters(code, [cont.code]);
      chapterThinking.push(cont.thinking);
      timeline.mark(`harness:chapter:${start + 1}-${end}:done`);
    }
    const missingAfterMerge = n > 8 ? missingSections(code, n) : [];
    if (missingAfterMerge.length) throw new Error(`chapter merge left gaps: ${missingAfterMerge.join(", ")}`);
    timeline.mark("design:scaffold:done");
    // Trace review is protocol: persist the author's reasoning next to the deck.
    // mkdir first — this runs BEFORE writeGeneratedFiles creates the genDir, and
    // the verification build proved the silent .catch was eating the ENOENT.
    await fsp.mkdir(genDir, { recursive: true }).catch(() => {});
    await fsp
      .writeFile(
        path.join(genDir, "harness-trace.json"),
        JSON.stringify({ model: authored.model, attempts: authored.attempts, thinking: chapterThinking.join("\n\n─── next chapter ───\n\n") }, null, 2),
      )
      .catch(() => {});

    // ── Truth validators → one targeted patch, then ship FLAGGED if needed. ──
    let violations = validateDeck({ code, approvedText, sceneCount: n, allowedUrls, logoSrc: packInput.brand.logoSrc });
    // Instrument distrust is PER KIND, not per deck (ab7 autopsy, 2026-09-02:
    // the total-count cliff shipped a real fabrication on one twin — 12
    // phantoms drowned it past the ceiling — while the other twin's patch
    // obeyed phantom numeral orders and emptied the logo const). Only the
    // numeral detector has ever flooded; when it floods, ONLY its findings
    // are withheld. Structural kinds (missing-logo, foreign-image,
    // unstable-piece-id) are always patched.
    const NUMERAL_SANITY_CEILING = 12;
    const numeralFindings = violations.filter((v) => v.kind === "invented-numeral");
    const structuralFindings = violations.filter((v) => v.kind !== "invented-numeral");
    const numeralsTrusted = numeralFindings.length <= NUMERAL_SANITY_CEILING;
    if (!numeralsTrusted) {
      timeline.mark(`harness:validate:NUMERAL-INSTRUMENT-SUSPECT (${numeralFindings.length} > ${NUMERAL_SANITY_CEILING}) — numeral patches withheld, structural patches still run`);
    }
    const toPatch = [...structuralFindings, ...(numeralsTrusted ? numeralFindings : [])];
    if (toPatch.length) {
      timeline.mark(`harness:validate:${toPatch.length} violation(s) — patching`);
      const patched = await surgicalPatch(code, toPatch, authored.model, abortSignal, (m) => timeline.mark(`harness:patch:${m}`));
      // A patch may never DESTROY a brand asset (ab7: the phantom-numeral
      // instruction "remove it" was obeyed by emptying the logo const — a
      // deck the logo validator requires to contain those exact bytes).
      // A patch that introduces a violation kind the input didn't have is
      // rejected outright; the pre-patch code ships flagged instead.
      if (patched) {
        const before = new Set(violations.map((v) => v.kind));
        const after = validateDeck({ code: patched, approvedText, sceneCount: n, allowedUrls, logoSrc: packInput.brand.logoSrc });
        const introduced = after.filter((v) => !before.has(v.kind));
        if (introduced.length) {
          timeline.mark(`harness:patch:REJECTED (introduced ${introduced.map((v) => v.kind).join(",")}) — pre-patch code ships`);
        } else {
          code = patched;
          violations = after;
        }
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
        abortSignal,
        (m) => timeline.mark(`harness:repair:${m}`),
      );
      const repairLostLogo =
        repaired !== null &&
        findLogoViolation(repaired, packInput.brand.logoSrc).length > 0 &&
        findLogoViolation(code, packInput.brand.logoSrc).length === 0;
      if (repaired && !repairLostLogo) {
        code = repaired;
        await writeGeneratedFiles(genDir, { code, designCode: code, script });
        renderCheck = await verifyScenesRender(genDir, n, script);
        timeline.mark(`harness:gate:ssr-render:retry:${renderCheck.ok ? "passed" : "failed"}`);
      } else if (repairLostLogo) {
        timeline.mark("harness:repair:REJECTED (repair removed the brand logo)");
      }
    }
    if (!renderCheck.ok) {
      await fsp.writeFile(path.join(genDir, "build-timeline.json"), JSON.stringify(timeline.toJSON(), null, 2)).catch(() => {});
      return { status: 500, body: { error: "one or more scenes failed to render", stage: "harness-render", render_errors: renderCheck.errors } };
    }

    // RENDER TRUTH for the deck-level <style> (motion, 2026-09-03): the first
    // motion build rendered its @keyframes on page 1 only and pages 2-5
    // shipped static; the same shape strands brand fonts on pages 2+. The
    // static check ran before the patch; this is the rendered fact, and it is
    // the only thing that sees a `page === 1 && <style>` guard. One targeted
    // patch, then re-verify; a gap that survives ships flagged, never blocks.
    {
      const facts = renderCheck.facts ?? [];
      const wantsKeyframes = /@keyframes/.test(code);
      const wantsFontFace = /@font-face/.test(code);
      const gaps = facts.filter((f) => (wantsKeyframes && !f.keyframes) || (wantsFontFace && !f.fontFace));
      if (gaps.length && facts.length) {
        const pages = gaps.map((g) => g.scene + 1).join(", ");
        timeline.mark(`harness:gate:style-every-page:FAILED (pages ${pages} render without the deck <style>) — patching`);
        const repaired = await surgicalPatch(
          code,
          [
            {
              kind: "style-not-on-every-page" as const,
              detail: pages,
              patch:
                `Pages ${pages} render WITHOUT the deck's <style> (its @font-face / @keyframes rules), so they lose their fonts and motion — ` +
                `each page is served as its own document. Render that <style> unconditionally on every page (inside the chrome component every Section renders, ` +
                `with no page-index guard), changing nothing else.`,
            },
          ],
          authored.model,
          abortSignal,
          (m) => timeline.mark(`harness:style-repair:${m}`),
        );
        const lostLogo =
          repaired !== null &&
          findLogoViolation(repaired, packInput.brand.logoSrc).length > 0 &&
          findLogoViolation(code, packInput.brand.logoSrc).length === 0;
        if (repaired && !lostLogo) {
          await writeGeneratedFiles(genDir, { code: repaired, designCode: repaired, script });
          const again = await verifyScenesRender(genDir, n, script);
          const stillGapped = (again.facts ?? []).filter((f) => (wantsKeyframes && !f.keyframes) || (wantsFontFace && !f.fontFace));
          if (again.ok && stillGapped.length === 0) {
            code = repaired;
            timeline.mark("harness:gate:style-every-page:repaired");
          } else {
            // Put the pre-patch bytes back: a patch that broke a render or did
            // not close the gap must not ship over code that rendered.
            await writeGeneratedFiles(genDir, { code, designCode: code, script });
            timeline.mark(
              `harness:gate:style-every-page:${again.ok ? `still gapped (pages ${stillGapped.map((g) => g.scene + 1).join(", ")})` : "repair broke a render"} — pre-patch code ships, flagged`,
            );
          }
        } else {
          timeline.mark(`harness:gate:style-every-page:${lostLogo ? "repair REJECTED (removed the logo)" : "no repair"} — ships flagged`);
        }
      }
    }
    for (let i = 0; i < n; i++) timeline.mark(`design:fill:scene:${i}:done`);
    timeline.mark("design:fills:done");

    // ── Loop: render → comparative critic → ONE revision, strict-improvement. ──
    if ((process.env.RB_HARNESS_LOOP ?? "on") !== "off") {
      try {
        // The join: collect verdicts that arrived during authoring. Only pages
        // whose FINAL render inputs hash-match what was critiqued are reused —
        // an author retry or surgical patch silently demotes its pages to the
        // ordinary critic path below. Never worse than today by construction.
        let early = earlyRunner ? await earlyRunner.finish(code) : undefined;
        if (early?.size) timeline.mark(`harness:stream-critics:${early.size}/${n} verdicts arrived during authoring`);
        // Draw-ranking verdicts judged exactly these bytes → reuse them (a
        // patch or repair that changed the code demotes them, like the
        // stream verdicts' sig check does).
        if (drawVerdicts && drawVerdicts.code === code && drawVerdicts.verdicts.size) {
          early = new Map([...(early ?? new Map<number, EarlyVerdict>()), ...drawVerdicts.verdicts]);
          timeline.mark(`harness:draws:${drawVerdicts.verdicts.size}/${n} ranking verdicts reused`);
        }
        code = await lookAndReviseOnce({ genDir, script, scenes, code, pack, model: authored.model, timeline, n, signal: abortSignal, early });
      } catch (err) {
        timeline.mark(`harness:loop:skipped (${String(err).slice(0, 80)})`);
      }
    }

    // ── Decompose for the editor; durability is unconditional. ──
    try {
      const lego = await decomposeGenDir(genDir);
      timeline.mark(
        `harness:decompose:${
          lego.ok
            ? `${lego.pieces} pieces${lego.degraded?.length ? ` (pages ${lego.degraded.map((s) => s + 1).join(",")} collapsed — unstable piece ids survived the patch)` : ""}`
            : `skipped (${lego.reason})`
        }`,
      );
      if (!lego.ok) console.error(`[preview/build:harness] decompose FAILED (${lego.reason}) — deck persisted whole; per-piece editing degraded for ${scriptId}`);
    } finally {
      await persistGenDir(scriptId);
    }

    // Warm every page's rail mini in the background (founder, 2026-08-29:
    // fresh decks must never show the capture wait). Fire-and-forget — the
    // build's response does not wait on Playwright.
    warmSceneThumbs(scriptId, script);

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
    // A user stop must SURFACE as a stop (founder, 2026-09-01: the swallowed
    // cancel shipped a 500 to the client and the ceremony crashed instead of
    // showing "You stopped this build"). Rethrown, the job runner's sentinel
    // maps it to the cancelled state the client renders gracefully.
    if (err instanceof BuildCancelledError || buildCancelRequested(scriptId)) {
      throw new BuildCancelledError();
    }
    return { status: 500, body: { error: String(err).slice(0, 500), stage: "harness" } };
  } finally {
    await earlyRunner?.cleanup();
  }
};

/** Full-file targeted patch: name the exact defects, demand minimal edits.
 *
 *  RB_EDIT_BLOCKS=on (10x program, 2026-09-04; default OFF — flip only on the
 *  founder's word after the flagged A/B): conflict-marker edits FIRST, for the
 *  PATCH site only. The receipt: the same 2-defect fix on the real 31KB heist
 *  deck cost 130 tokens / 2s as SEARCH/REPLACE blocks vs 13,813 tokens / 62s
 *  as a full-file re-emission (probe 2026-09-02); in the baseline table the
 *  edit-block patch took 6s where full-file patches take 35-170s. Blocks
 *  cannot drift pages they do not name. The REVISION stays full-file by the
 *  founder's blind verdict (ab6: block-scale edits are structurally wrong for
 *  composition-scale weaknesses). Any parse/apply failure falls through to the
 *  full-file path, so the worst case is exactly today; the truth validators
 *  re-run after either path. */
const surgicalPatch = async (
  code: string,
  violations: TruthViolation[],
  model: string,
  signal?: AbortSignal,
  onMode?: (mode: string) => void,
): Promise<string | null> => {
  if (editBlocksEnabled()) {
    try {
      const r = await castCall({
        system: "",
        user: `Below is a complete React deck file, followed by specific defects. Fix every defect with the smallest possible edits. Change nothing else — no restyling, no rewrites.\n\n\`\`\`tsx\n${code}\n\`\`\`\n\nDEFECTS:\n${violations.map((v, i) => `${i + 1}. ${v.patch}`).join("\n")}\n\n${EDIT_BLOCKS_INSTRUCTION}`,
        maxTokens: 4000,
        signal,
        model,
        timeoutMs: 180_000,
        effort: "high",
        thinkingBudget: 4000,
      });
      const blocks = parseEditBlocks(r.text ?? "");
      const applied = blocks ? applyEditBlocks(code, blocks) : null;
      if (applied?.ok) {
        onMode?.(`edit-blocks (${applied.applied} block(s))`);
        return applied.code;
      }
      onMode?.(`edit-blocks fallback (${!blocks ? "unparseable" : applied && !applied.ok ? applied.reason : "?"}) — full file`);
    } catch (err) {
      if (signal?.aborted) throw err; // a user stop must not burn a fallback call
      onMode?.(`edit-blocks fallback (${String(err).slice(0, 60)}) — full file`);
    }
  }
  const r = await castCall({
    system: "",
    user: `Below is a complete React deck file, followed by specific defects. Apply the SMALLEST possible edits that fix every defect. Change nothing else — no restyling, no rewrites. Reply with ONLY the corrected complete file in one \`\`\`tsx block.\n\n\`\`\`tsx\n${code}\n\`\`\`\n\nDEFECTS:\n${violations.map((v, i) => `${i + 1}. ${v.patch}`).join("\n")}`,
    maxTokens: 30_000,
    signal,
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
  signal?: AbortSignal;
  /** Verdicts critiqued DURING authoring (stream critics), sig-verified
   *  against this exact code by the caller. A present page skips its critic
   *  call — the verdict already judged pixel-identical render inputs. */
  early?: Map<number, EarlyVerdict>;
}): Promise<string> => {
  const { genDir, script, scenes, pack, model, timeline, n, signal, early } = args;
  let { code } = args;
  timeline.mark("harness:critic:start");
  const before = await measureScenes(genDir, script, measureOutDir(genDir));
  // All pages judged CONCURRENTLY — the A/B batch spent 161-242s here running
  // them one-at-a-time (timing autopsy, 2026-08-27). Parallelism changes the
  // plumbing around the judgments, never the judgments.
  const pageNotes = await Promise.all(
    Array.from({ length: n }, (_, i) => (async (): Promise<{ page: number; weakness: string } | null> => {
      const reused = early?.get(i);
      if (reused) {
        timeline.mark(`harness:critic:page ${i + 1} reused early verdict (${reused.weakness ? "flagged" : "ship"})`);
        return reused.weakness ? { page: i, weakness: reused.weakness } : null;
      }
      const shot = await shotBase64(before[i]?.screenshotPath, genDir, i);
      if (!shot) return null;
      const v = await critiquePageShot(shot, sceneIntent(scenes[i], i));
      // A real per-page mark the moment THIS verdict lands (critics run in
      // parallel, so these tick in one by one) — the ceremony's checking
      // step shows them as they arrive. No streaming involved.
      timeline.mark(`harness:critic:page ${i + 1} ${v.weakness ? "flagged" : "clean"}`);
      return v.weakness ? { page: i, weakness: v.weakness } : null;
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

  const flaggedList = notes.map((f) => `Page ${f.page + 1}: ${f.weakness}`).join("\n");
  let revised: string | null = null;
  let replyText = "";
  // SECTION-SCOPED revision (RB_REVISE_SCOPE=section; 10x program 2026-09-04,
  // default OFF until the flagged A/B): the model re-emits ONLY the flagged
  // Section components — complete pages, full compositional freedom inside
  // each — and they are spliced over the originals. Different from the
  // block-scale edit-block revision the founder rejected (ab6, "a bunch of
  // blank spaces"): a whole page is the unit, not a line. Why: the full-file
  // revision re-emits ~17k tokens (160-190s, ≈ the author call) to change one
  // or two pages; a page is ~3-4k tokens (~35s). Anything unusable falls
  // through to the full-file path, so the worst case is exactly today.
  if (reviseScopeSection()) {
    const rs = await castCall({
      system: "",
      user: `${pack}\n\nYou already authored the file below. A design review flagged specific pages. Re-emit ONLY the flagged pages — each as its COMPLETE \`export const SectionN\` component, recomposed with full freedom to fix the weakness (occupy the canvas, strengthen the device), using the file's existing design system, constants, helpers and chrome exactly as the other pages do. Do not emit the other pages or the module preamble. Reply with ONLY the flagged Section components in one \`\`\`tsx block.\n\n\`\`\`tsx\n${code}\n\`\`\`\n\nFLAGGED:\n${flaggedList}`,
      maxTokens: 12_000,
      signal,
      model,
      timeoutMs: 240_000,
      effort: "high",
      thinkingBudget: 6000,
    });
    replyText = rs.text ?? "";
    const spliced = spliceSections(code, replyText, notes.map((f) => f.page));
    if (spliced.ok) {
      revised = spliced.code;
      timeline.mark(`harness:revise:section-scoped (${spliced.replaced.map((p) => p + 1).join(",")} re-emitted)`);
    } else {
      timeline.mark(`harness:revise:section-scoped fallback (${spliced.reason}) — full file`);
    }
  }
  if (!revised) {
    const r = await castCall({
      system: "",
      user: `${pack}\n\nYou already authored the file below. A design review flagged specific pages. Revise ONLY the flagged pages' sections — a surgical pass (M1-measured: healthy revisions touch ≤15% of the file). Keep the identity, chrome, and all other pages byte-identical. Reply with ONLY the complete revised file in one \`\`\`tsx block.\n\n\`\`\`tsx\n${code}\n\`\`\`\n\nFLAGGED:\n${flaggedList}`,
      maxTokens: 30_000,
      signal,
      model,
      timeoutMs: 300_000,
      effort: "high",
      thinkingBudget: 6000,
    });
    replyText = r.text ?? "";
    const blocks = [...replyText.matchAll(/```(?:tsx|typescript|jsx|ts)?\s*\n([\s\S]*?)```/g)].map((x) => x[1]);
    const full = blocks.length ? blocks.reduce((a, b) => (b.length > a.length ? b : a)) : null;
    revised = full && full.length >= code.length * 0.6 ? full : null;
  }
  // Revision forensics (ab6/ab7 lesson, 2026-09-02: twice the question "what
  // did the revision actually change?" was unanswerable because only
  // post-everything code survives). Persist the input file and the raw reply
  // next to the trace — every future quality dispute resolves from bytes.
  await fsp.writeFile(path.join(genDir, "revision-before.tsx"), code).catch(() => {});
  await fsp.writeFile(path.join(genDir, "revision-reply.txt"), replyText).catch(() => {});
  if (!revised) return code;

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

const reviseScopeSection = (): boolean => (process.env.RB_REVISE_SCOPE ?? "file") === "section";

const shotBase64 = async (shotPath: string | undefined, genDir: string, i: number): Promise<string | null> => {
  for (const p of [shotPath, path.join(measureOutDir(genDir), `measure-scene-${i}.png`)]) {
    if (!p) continue;
    try {
      return (await fsp.readFile(p)).toString("base64");
    } catch { /* fall through */ }
  }
  return null;
};
