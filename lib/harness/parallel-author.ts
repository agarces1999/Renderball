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
    const mine = spans.find((s) => s.index === k);
    if (!mine) continue;
    const code = body.slice(mine.start, mine.end).trimEnd();
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
  opts?: { onAttempt?: (a: AuthorAttempt) => void; signal?: AbortSignal; mark?: (line: string) => void },
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

  // ── design pass (one retry) ──
  let design: { preamble: string; plans: string } | null = null;
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
  opts?.mark?.(`harness:author:parallel:design ok (${design.preamble.length} bytes, ${design.plans.split("\n").length} plan lines)`);

  // ── page passes (concurrent; one retry each) ──
  const pageDial = author.thinkingBudget ? { effort: "high" as const, thinkingBudget: Math.min(author.thinkingBudget, 4000) } : {};
  const pages = await Promise.all(
    Array.from({ length: n }, (_, k) => (async () => {
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
          if (r.thinking) thinking.push(`─── page ${k + 1} ───\n${r.thinking}`);
          record(`page${k + 1}`, t0, r.outputTokens, got ? undefined : `page ${k + 1} reply lacked Section${k}`);
          if (got) {
            opts?.mark?.(`harness:author:page:${k + 1}:written${got.leaked ? " (module-level leak kept)" : ""}`);
            return { index: k, code: got.code };
          }
        } catch (err) {
          if (opts?.signal?.aborted) throw err;
          record(`page${k + 1}`, t0, 0, String(err).slice(0, 200));
        }
      }
      return null;
    })()),
  );
  const missing = pages.map((p, k) => (p ? null : k + 1)).filter((x): x is number => x !== null);
  if (missing.length) throw new Error(`parallel author: pages ${missing.join(", ")} failed twice`);
  const code = assembleParallel(design.preamble, pages.filter((p): p is { index: number; code: string } => !!p));
  const gaps = missingSections(code, n);
  if (gaps.length) throw new Error(`parallel author: assembly missing ${gaps.join(", ")}`);
  return { code, model: author.model, attempts, thinking: thinking.join("\n\n") };
};
