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
  const fenceRe =
    /```(?:tsx|typescript|ts|jsx|javascript|js)?[ \t]*\r?\n([\s\S]*?)\r?\n```/g;
  let best = "";
  for (let m = fenceRe.exec(out); m; m = fenceRe.exec(out)) {
    if (m[1].length > best.length) best = m[1];
  }
  if (best) {
    out = best.trim();
  } else {
    // No closing fence — strip a dangling opening/closing fence if present.
    out = out
      .replace(/^```(?:tsx|typescript|ts|jsx|javascript|js)?[ \t]*\r?\n?/, "")
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
