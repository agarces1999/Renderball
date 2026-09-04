/**
 * Parallel page authoring (RB_AUTHOR_PARALLEL; 10x program, 2026-09-04;
 * default OFF).
 *
 * The one-call author is bounded by serial token generation: ~18-25k output
 * tokens for a 5-page deck at 80-200 tok/s is 90-250s before anything else
 * runs. Two passes break the serial chain without breaking the "one mind"
 * that the blind galleries rewarded: a DESIGN pass (one call) writes the
 * whole identity — module preamble, chrome, helpers, keyframes — and a plan
 * for every page; then N PAGE passes run concurrently, each writing one
 * Section against the fixed preamble and its own plan (the other plans are
 * in view so devices stay distinct). Code only assembles; every judgment is
 * the model's. Any failure throws and the caller falls back to today's call.
 *
 * The founder's open question (2026-08-31): "I feel the context of previous
 * pages helps the new pages" — this is the flag that lets a blind A/B answer
 * it instead of an argument.
 */
import { castCall } from "../llm/cast-provider";
import { assemblePack, type PackInput } from "./pack";
import { missingSections, socketOrder, type AuthorAttempt } from "./author";
import { sectionSpans } from "./splice-sections";
import { pageDraws, rankPageDraws } from "./draws";
import { loadBrandSystem, saveBrandSystem, touchBrandSystem } from "./brand-system";

export const authorParallelEnabled = (): boolean => (process.env.RB_AUTHOR_PARALLEL ?? "off") === "on";

const DESIGN_MAX_TOKENS = 20_000;
const PAGE_MAX_TOKENS = 12_000;
const DESIGN_TIMEOUT_MS = 300_000;
const PAGE_TIMEOUT_MS = 240_000;

const fences = (raw: string): { lang: string; body: string }[] =>
  [...raw.replace(/<think>[\s\S]*?<\/think>/g, "").matchAll(/```([a-zA-Z]*)[ \t]*\n([\s\S]*?)```/g)].map((m) => ({
    lang: m[1].toLowerCase(),
    body: m[2],
  }));

const CODE_LANGS = new Set(["tsx", "ts", "typescript", "jsx", ""]);

/** The design reply: the largest code fence is the preamble (cut at the first
 *  Section export if the model wrote pages anyway); the plans are the largest
 *  non-code fence, else whatever prose follows the code. */
export const parseDesign = (raw: string): { preamble: string; plans: string } | null => {
  const fs = fences(raw);
  const code = fs.filter((f) => CODE_LANGS.has(f.lang)).map((f) => f.body);
  if (!code.length) return null;
  let preamble = code.reduce((a, b) => (b.length > a.length ? b : a));
  const firstSection = preamble.search(/^export const Section\d+\b/m);
  if (firstSection >= 0) preamble = preamble.slice(0, firstSection);
  if (!/import React/.test(preamble) || preamble.trim().length < 300) return null;
  const text = fs.filter((f) => !CODE_LANGS.has(f.lang)).map((f) => f.body);
  let plans = text.length ? text.reduce((a, b) => (b.length > a.length ? b : a)) : "";
  if (!plans.trim()) {
    const after = raw.slice(raw.lastIndexOf("```") + 3);
    plans = after.trim();
  }
  if (!/Page\s*1\b/i.test(plans)) return null;
  return { preamble: preamble.trimEnd() + "\n", plans: plans.trim() };
};

/** One page's Section from a page reply: the fence holding `export const
 *  SectionK`, sliced to exactly that component. Imports are refused (a page
 *  that re-declares the module is a page that will not assemble). */
export const extractSection = (raw: string, k: number): { code: string; leaked: boolean } | null => {
  const fs = fences(raw).filter((f) => CODE_LANGS.has(f.lang));
  const candidates = fs.length ? fs.map((f) => f.body) : [raw];
  for (const body of candidates) {
    const spans = sectionSpans(body);
    let mine = spans.find((s) => s.index === k);
    let renamed = false;
    // Off-by-one is the model's most common miss here (the first parallel
    // build: "page 2 reply lacked Section1" — it wrote Section2). A reply
    // holding exactly ONE section is unambiguous: take it as page k's.
    if (!mine && spans.length === 1) {
      mine = spans[0];
      renamed = true;
    }
    if (!mine) continue;
    let code = body.slice(mine.start, mine.end).trimEnd();
    if (renamed) code = code.replace(/^export const Section\d+\b/, `export const Section${k}`);
    if (code.length < 300) continue;
    const before = body.slice(0, mine.start);
    if (/^\s*import\s/m.test(before)) return null;
    // Module-level declarations before the export (the model was told not to):
    // noted, not fatal — the compile/SSR gate and repair path own that risk.
    const leaked = /^(?:const|let|function|type|interface)\s/m.test(before.replace(/^\s*\/\/.*$/gm, ""));
    return { code: (leaked ? before.trim() + "\n\n" : "") + code + "\n", leaked };
  }
  return null;
};

export const assembleParallel = (preamble: string, sections: { index: number; code: string }[]): string =>
  `${preamble.trimEnd()}\n\n${[...sections].sort((a, b) => a.index - b.index).map((s) => s.code.trim()).join("\n\n")}\n`;

export const authorParallel = async (
  packInput: PackInput,
  n: number,
  opts?: {
    onAttempt?: (a: AuthorAttempt) => void;
    signal?: AbortSignal;
    mark?: (line: string) => void;
    /** For RB_PAGE_DRAWS>1: where and what to render candidates against. */
    rank?: { genDir: string; script: unknown; scenes: { label?: string; description?: string }[] };
    /** RB_BRAND_SYSTEM: reuse this brand's stored deck system when its
     *  fingerprint matches; store a freshly designed one. */
    brandSystem?: { key: string; fingerprint: string; scriptId: string };
  },
): Promise<{ code: string; model: string; attempts: AuthorAttempt[]; thinking: string }> => {
  const author = socketOrder()[0];
  const attempts: AuthorAttempt[] = [];
  const thinking: string[] = [];
  const record = (label: string, t0: number, outputTokens: number, failure?: string) => {
    const a: AuthorAttempt = { model: `${author.model}#${label}`, seconds: Math.round((Date.now() - t0) / 100) / 10, outputTokens, ok: !failure, failure };
    attempts.push(a);
    opts?.onAttempt?.(a);
  };
  const dial = author.thinkingBudget ? { effort: "high" as const, thinkingBudget: author.thinkingBudget } : {};

  // ── stored deck system → plan-only pass (the thesis's second deck) ──
  let design: { preamble: string; plans: string } | null = null;
  let reused = false;
  if (opts?.brandSystem) {
    const stored = await loadBrandSystem(opts.brandSystem.key, opts.brandSystem.fingerprint);
    if (stored) {
      for (let tryN = 0; tryN < 2 && !design; tryN++) {
        const t0 = Date.now();
        try {
          const r = await castCall({
            system: "",
            user: assemblePack({ ...packInput, parallel: { pass: "plan", preamble: stored.preamble } }),
            maxTokens: 8000,
            signal: opts?.signal,
            model: author.model,
            timeoutMs: 180_000,
            ...dial,
          });
          const text = fences(r.text ?? "").filter((f) => !CODE_LANGS.has(f.lang)).map((f) => f.body).reduce((a, b) => (b.length > a.length ? b : a), "") || (r.text ?? "");
          const plans = text.trim();
          if (r.thinking) thinking.push(`─── plan (system reused) ───\n${r.thinking}`);
          const ok = /Page\s*1\b/i.test(plans) && plans.length > 200;
          record("plan", t0, r.outputTokens, ok ? undefined : "plan reply lacked page plans");
          if (ok) design = { preamble: stored.preamble, plans };
        } catch (err) {
          if (opts?.signal?.aborted) throw err;
          record("plan", t0, 0, String(err).slice(0, 200));
        }
      }
      if (design) {
        reused = true;
        await touchBrandSystem(opts.brandSystem.key);
        opts?.mark?.(`harness:brand-system:reused (saved ${stored.savedAt.slice(0, 10)}, ${stored.uses + 1} decks) — plan-only pass`);
      } else {
        opts?.mark?.("harness:brand-system:stored system present but the plan pass failed — designing fresh");
      }
    } else {
      opts?.mark?.("harness:brand-system:none stored for this brand (or brand facts changed) — designing");
    }
  }

  // ── design pass (one retry) ──
  for (let tryN = 0; tryN < 2 && !design; tryN++) {
    const t0 = Date.now();
    try {
      const r = await castCall({
        system: "",
        user: assemblePack({ ...packInput, parallel: { pass: "design" } }),
        maxTokens: DESIGN_MAX_TOKENS,
        signal: opts?.signal,
        model: author.model,
        timeoutMs: DESIGN_TIMEOUT_MS,
        ...dial,
      });
      design = parseDesign(r.text ?? "");
      if (r.thinking) thinking.push(`─── design ───\n${r.thinking}`);
      record("design", t0, r.outputTokens, design ? undefined : "design reply lacked a preamble or page plans");
    } catch (err) {
      if (opts?.signal?.aborted) throw err;
      record("design", t0, 0, String(err).slice(0, 200));
    }
  }
  if (!design) throw new Error("parallel author: design pass failed twice");
  if (!reused) {
    opts?.mark?.(`harness:author:parallel:design ok (${design.preamble.length} bytes, ${design.plans.split("\n").length} plan lines)`);
    if (opts?.brandSystem) {
      await saveBrandSystem({ key: opts.brandSystem.key, fingerprint: opts.brandSystem.fingerprint, preamble: design.preamble, scriptId: opts.brandSystem.scriptId });
      opts?.mark?.("harness:brand-system:stored for this brand's next deck");
    }
  }

  // ── page passes (concurrent; one retry each) ──
  // Page passes think less than the design pass: the plan is already written.
  // RB_PAGE_THINKING tunes it (first parallel build: 5 pages × ~4k thinking
  // tokens was most of the extra cost); 0 = provider default (no dial).
  const pageBudget = Number(process.env.RB_PAGE_THINKING ?? "4000");
  const pageDial = author.thinkingBudget && pageBudget > 0 ? { effort: "high" as const, thinkingBudget: Math.min(author.thinkingBudget, Math.max(1024, pageBudget)) } : {};
  const draws = opts?.rank ? pageDraws() : 1;
  const onePage = async (k: number, draw: number): Promise<{ index: number; code: string } | null> => {
      for (let tryN = 0; tryN < 2; tryN++) {
        const t0 = Date.now();
        try {
          const r = await castCall({
            system: "",
            user: assemblePack({ ...packInput, parallel: { pass: "page", page: k, preamble: design!.preamble, plans: design!.plans } }),
            maxTokens: PAGE_MAX_TOKENS,
            signal: opts?.signal,
            model: author.model,
            timeoutMs: PAGE_TIMEOUT_MS,
            ...pageDial,
          });
          const got = extractSection(r.text ?? "", k);
          if (r.thinking) thinking.push(`─── page ${k + 1}${draw ? ` draw ${draw + 1}` : ""} ───\n${r.thinking}`);
          record(`page${k + 1}${draw ? `d${draw + 1}` : ""}`, t0, r.outputTokens, got ? undefined : `page ${k + 1} reply lacked Section${k}`);
          if (got) {
            if (draw === 0) opts?.mark?.(`harness:author:page:${k + 1}:written${got.leaked ? " (module-level leak kept)" : ""}`);
            return { index: k, code: got.code };
          }
        } catch (err) {
          if (opts?.signal?.aborted) throw err;
          record(`page${k + 1}`, t0, 0, String(err).slice(0, 200));
        }
      }
      return null;
  };
  // All pages × all draws concurrently; draw 0 of every page must land, extra
  // draws are optional (a dead spare is just absent from the ranking).
  const grid = await Promise.all(
    Array.from({ length: n }, (_, k) => Promise.all(Array.from({ length: draws }, (_, d) => onePage(k, d)))),
  );
  const missing = grid.map((row, k) => (row[0] ? null : k + 1)).filter((x): x is number => x !== null);
  if (missing.length) throw new Error(`parallel author: pages ${missing.join(", ")} failed twice`);
  let pages: { index: number; code: string }[] = grid.map((row) => row[0]!);
  if (draws > 1 && opts?.rank) {
    const candidates = grid.map((row) => row.filter((p): p is { index: number; code: string } => !!p).map((p) => p.code));
    if (candidates.some((c) => c.length > 1)) {
      const ranked = await rankPageDraws({
        genDir: opts.rank.genDir,
        script: opts.rank.script,
        scenes: opts.rank.scenes,
        n,
        preamble: design.preamble,
        candidates,
        assemble: assembleParallel,
        log: opts.mark,
      });
      pages = candidates.map((c, k) => ({ index: k, code: c[ranked.winners[k]] ?? c[0] }));
      opts?.mark?.(`harness:page-draws:winners ${ranked.winners.map((w) => w + 1).join(",")} of ${draws}`);
    }
  }
  const code = assembleParallel(design.preamble, pages);
  const gaps = missingSections(code, n);
  if (gaps.length) throw new Error(`parallel author: assembly missing ${gaps.join(", ")}`);
  return { code, model: author.model, attempts, thinking: thinking.join("\n\n") };
};
