/**
 * Code-extraction helpers shared by the build pipeline.
 *
 * These live in their own module (no Anthropic SDK / store / heavy imports) so
 * they can be unit-tested in isolation — the pipeline that consumes them pulls
 * in the whole world, which makes it untestable without a live API key.
 */

/**
 * Normalise an agent's response down to clean TS/TSX module text.
 *
 * Agents emit code three ways, and all three must yield a file that starts at
 * the first real module line:
 *   1. wrapped in a ```tsx … ``` fence (sometimes with prose before AND after),
 *   2. raw code with no fence,
 *   3. an explanatory preamble ("The dead-air checker reads the actual JSX
 *      delays…") followed by raw, UNFENCED code.
 *
 * Case 3 is the one that bit us: the old stripper only removed a fence when it
 * was the very first token, so the preamble landed on line 1 above the imports.
 * esbuild then died with `Expected ";" but found "dead"` — yet the build
 * endpoint still returned ok:true (it never compiles the result) and the
 * text-based verifier passed (the real code is all there, just below prose).
 * This normaliser is deterministic: prefer a fenced block; otherwise drop any
 * leading prose before the first module line (an import or a "use" directive).
 */
export const stripCodeFence = (s: string): string => {
  let out = s.trim();

  // 1. If a fenced code block exists anywhere, take the largest one's body.
  //    This transparently discards prose BEFORE and AFTER the fence.
  // Alternation order is load-bearing: "json" must precede "js" — the
  // dangling-fence replace below has a fully-optional tail, so a "js" prefix
  // match on a ```json fence would win outright and leave "on" glued to the
  // body (exactly how acceptance6 lost a valid 220s script attempt).
  const fenceRe =
    /```(?:tsx|typescript|ts|jsx|javascript|json|js)?[ \t]*\r?\n([\s\S]*?)\r?\n```/g;
  let best = "";
  for (let m = fenceRe.exec(out); m; m = fenceRe.exec(out)) {
    if (m[1].length > best.length) best = m[1];
  }
  if (best) {
    out = best.trim();
  } else {
    // No closing fence — strip a dangling opening/closing fence if present.
    out = out
      .replace(/^```(?:tsx|typescript|ts|jsx|javascript|json|js)?[ \t]*\r?\n?/, "")
      .replace(/\r?\n?[ \t]*```[ \t]*$/, "");
  }

  // 2. Drop any leading prose before the first real module line. Generated
  //    comps always begin with an import (or a "use client"/"use strict"
  //    directive). Anchoring here is safe — prose never starts a line with
  //    `import `, and a legitimate leading directive is preserved.
  const lines = out.split("\n");
  const moduleStart =
    /^\s*(?:import[\s{*"']|export\s|['"]use (?:client|strict)['"])/;
  for (let i = 0; i < lines.length; i++) {
    if (moduleStart.test(lines[i])) {
      if (i > 0) out = lines.slice(i).join("\n");
      break;
    }
  }

  return out.trim();
};

/**
 * Fast, dependency-free syntax gate. Runs esbuild's transform (NOT bundle) on
 * the emitted component so a file that can't even parse never ships as a
 * "successful" build. Returns null when it parses, or the error message when
 * it doesn't. transform resolves no imports, so it's pure syntax validation
 * (catches the leaked-prose / truncation class) and costs ~1ms.
 *
 * This is the deterministic backstop behind stripCodeFence: even if some
 * future agent finds a new way to emit unparseable text, ok:true can no
 * longer be a false positive — the preview/MP4 path will surface ok:false
 * with the exact compiler error instead of writing a broken Composition.tsx.
 */
export const verifyCompilable = async (
  code: string,
): Promise<string | null> => {
  try {
    const esbuild = await import("esbuild");
    await esbuild.transform(code, {
      loader: "tsx",
      jsx: "automatic",
      logLevel: "silent",
    });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
};

/**
 * Surgical compile-repair loop. A compile error (a stray char, a truncated
 * tag, leaked prose) is a MECHANICAL defect, not a design problem — so instead
 * of failing the build (or paying a full creative regeneration), feed the exact
 * compiler error to a targeted `fix` and re-`verify`, up to `maxAttempts` times.
 *
 * Pure + fully injected (`verify` + `fix` are passed in), so the loop logic is
 * unit-tested with mocks — no model spend. The pipeline wires `verify =
 * verifyCompilable` and `fix = a thinking-off "fix only this syntax error" call`.
 * Returns the best code reached, the residual error (null = compiles), and the
 * attempt count for logging/cost. `fix` returning null (call failed / no text)
 * stops the loop immediately rather than spinning.
 */
export const repairCompile = async (
  code: string,
  verify: (c: string) => Promise<string | null>,
  fix: (code: string, error: string) => Promise<string | null>,
  maxAttempts = 2,
): Promise<{ code: string; error: string | null; attempts: number }> => {
  let current = code;
  let error = await verify(current);
  let attempts = 0;
  while (error && attempts < maxAttempts) {
    attempts++;
    const fixed = await fix(current, error);
    if (!fixed) break; // fixer gave up — don't loop on the same input
    current = fixed;
    error = await verify(current);
  }
  return { code: current, error, attempts };
};

/**
 * Elide long inlined base64 data-URIs from READ-ONLY prompt context.
 *
 * Generated compositions inline logos/images as module-const data-URIs, and a
 * preamble/composition can be dominated by them (measured: Arc's regen preamble
 * was 505KB, 97% base64 ≈ ~130k junk tokens per call). The model must reference
 * those consts BY NAME and never re-emit the literal, so in read-only context
 * the payload is pure token waste — slower TTFT, higher cost, context-limit risk.
 *
 * ONLY safe on context the model will NOT re-emit. Never elide code the model is
 * asked to reproduce (a piece body, the target section) — an elided URI there
 * would ship a broken image.
 */
const DATA_URI_RX = /(data:[a-z][\w/+.-]*;base64,)[A-Za-z0-9+/=]{120,}/g;
export const elideDataUris = (code: string): string =>
  code.replace(DATA_URI_RX, "$1<base64 elided — reference this const by name>");

/**
 * Elide data-URIs everywhere EXCEPT inside the target `Section{index}` block —
 * for prompts where the full composition is read-only context but the model
 * re-emits that one section (scene regen / scoped retries). The section region
 * is preserved verbatim so any in-section inline image survives re-emission.
 * `sectionRangeFn` is injected (section-splice) to keep this module dependency-free.
 */
export const elideDataUrisOutsideSection = (
  code: string,
  sectionRangeFn: (code: string, index: number) => { start: number; end: number } | null,
  index: number,
): string => {
  const r = sectionRangeFn(code, index);
  if (!r) return elideDataUris(code);
  return (
    elideDataUris(code.slice(0, r.start)) +
    code.slice(r.start, r.end) +
    elideDataUris(code.slice(r.end))
  );
};
