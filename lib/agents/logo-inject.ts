/**
 * LOGO_SRC injection — the pipeline OWNS the brand logo URL.
 *
 * The design agent references the brand logo as the constant `LOGO_SRC` and
 * never reproduces the (possibly 3KB data:) URL itself — an LLM mangles long
 * base64, and a literal sentinel string gets altered across the design→animation
 * passes. The pipeline strips any LOGO_SRC the agent declared (and any leftover
 * sentinel), then injects the real const AFTER the import block. Both agents only
 * carry the short identifier through, which they preserve reliably.
 *
 * Extracted from pipeline.ts so the injection is unit-testable in isolation
 * (QA: the multi-line-import bug below shipped intermittent build failures).
 */
export const LOGO_SENTINEL = "__BRAND_LOGO_SRC__";

export const injectLogoSrc = (
  code: string,
  logoSrc: string | undefined,
): string => {
  // Drop anything the agent authored for LOGO_SRC so our injected const is the
  // single source of truth: a `declare const LOGO_SRC` type stub, a real
  // `const LOGO_SRC = "...";` (may hold the sentinel or a corrupted value), and
  // collapse any bare sentinel literal. The agent sometimes also writes a
  // defensive `RESOLVED_LOGO = typeof LOGO_SRC !== "undefined" ? LOGO_SRC : "<inlined>"`
  // — that's left intact and simply resolves to our real LOGO_SRC at runtime.
  //
  // NO-LOGO brands (v13 hotfix, dogfood cycle 5 — Patagonia): a crawl with no
  // discoverable logo (logo_hd/apple_touch_icon/favicon all absent) used to
  // EARLY-RETURN here, leaving the emitted `logoSrc={LOGO_SRC}` chrome binding
  // dangling — a ReferenceError at render time that killed EVERY scene (the
  // chrome mounts on all of them) and burned the full retry ladder on a defect
  // no piece regen could fix. The const is now ALWAYS defined when referenced:
  // `undefined` when there is no logo, which lands on BrandChrome's
  // `{logoSrc ? <img> : <text-wordmark/>}` fallback — the same posture as the
  // v12 broken-image swap (absent art → deterministic text wordmark).
  const out = code
    .replace(/^[ \t]*declare\s+const\s+LOGO_SRC\b[^\n]*\r?\n/gm, "")
    .replace(
      /^[ \t]*const\s+LOGO_SRC\s*=\s*["'`][^"'`]*["'`]\s*;?[ \t]*\r?\n?/gm,
      "",
    )
    .split(LOGO_SENTINEL)
    .join(logoSrc ?? "");
  if (!/\bLOGO_SRC\b/.test(out)) return out; // agent didn't reference it
  const decl = `const LOGO_SRC = ${logoSrc ? JSON.stringify(logoSrc) : "undefined"};\n`;

  // Inject AFTER the import block. Imports can be MULTI-LINE
  // (`import {\n  A,\n} from "x";`). The old anchor — every line that *starts*
  // with `import` — matched only the `import {` opener of a multi-line import,
  // so the const landed BETWEEN `import {` and its members:
  //   import {
  //   const LOGO_SRC = "...";   ← parser reads `const` as a specifier, then
  //     AbsoluteFill,              hits LOGO_SRC → "Expected 'as' but found
  //   } from "remotion";          'LOGO_SRC'" — the whole file fails to compile.
  // Anchor instead on the line that COMPLETES an import: a `from "...";` line
  // (the closer of single- AND multi-line imports) or a side-effect
  // `import "...";`. Inject after the LAST such line.
  const importEndRx =
    /^[^\n]*\bfrom\s*["'][^"']*["'][ \t]*;?[ \t]*$|^[ \t]*import\s*["'][^"']*["'][ \t]*;?[ \t]*$/gm;
  let lineEnd = -1;
  for (const m of out.matchAll(importEndRx)) {
    lineEnd = (m.index ?? 0) + m[0].length;
  }
  if (lineEnd >= 0) {
    // Inject on the line AFTER the import closer (skip its trailing newline).
    const nl = out.indexOf("\n", lineEnd);
    const at = nl >= 0 ? nl + 1 : out.length;
    const sep = nl >= 0 ? "" : "\n";
    return out.slice(0, at) + sep + decl + out.slice(at);
  }
  // No import statement at all → put the const at the very top.
  return decl + out;
};
