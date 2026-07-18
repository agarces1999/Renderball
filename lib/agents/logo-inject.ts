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
import { brandNameFromTitle } from "../crawl/brand-identity";

export const LOGO_SENTINEL = "__BRAND_LOGO_SRC__";

/**
 * A short brand WORDMARK from a (possibly messy) crawl title. Audit-1 P0 #1:
 * this now DELEGATES to the single brand-name source of truth
 * (brand-identity.brandNameFromTitle) so the corner wordmark, the CTA template,
 * and the crawl-saved name can never disagree. The SSOT is tagline-aware:
 * "Klarna US - A secure, flexible way to manage your money" → "Klarna US";
 * "Linear – Plan and build" → "Linear"; "Liquid Death" → "Liquid Death";
 * "Brex: The Modern Finance Software Platform | Spend Smarter" → "Brex";
 * "Your one-stop shop for wholesale - Faire" → "Faire" (the leak this kills).
 * Empty in → undefined.
 */
export const brandWordmarkText = (name: string | undefined): string | undefined => {
  const clean = brandNameFromTitle(name);
  return clean || undefined;
};

export interface CornerBrandMark {
  /** Bind to LOGO_SRC. undefined ⇒ no image mark → the wordmark renders. */
  logoSrc: string | undefined;
  /** Fallback wordmark text (present when logoSrc is undefined). */
  wordmark: string | undefined;
}

/**
 * Resolve the CORNER-chrome brand mark. A user-uploaded logo or a crawled
 * `logo_hd` is a real, transparent-friendly lockup → render it as the corner
 * IMAGE. But an apple-touch-icon / favicon is an APP ICON: a solid, rounded
 * square built for a home screen, not a corner lockup. On a dark video canvas
 * the chrome silhouettes the mark white (`brightness(0) invert(1)`), and a
 * solid-background app icon silhouettes to a FEATURELESS WHITE SQUARE — the
 * Klarna appIcon.png bug (a blank square top-left on every scene). So when the
 * only mark is an app icon (or nothing), drop the image and render the brand
 * WORDMARK as text — a clean lockup that never blobs. The app icon is still
 * available to the hero as a preallocated asset (it belongs INSIDE an app
 * mock's own header, not silhouetted in the corner).
 */
export const resolveCornerBrandMark = (args: {
  userLogoUrl?: string;
  logoHd?: string;
  brandName?: string;
}): CornerBrandMark => {
  const realLogo = args.userLogoUrl || args.logoHd;
  if (realLogo) return { logoSrc: realLogo, wordmark: undefined };
  return { logoSrc: undefined, wordmark: brandWordmarkText(args.brandName) };
};

export const injectLogoSrc = (
  code: string,
  logoSrc: string | undefined,
  wordmark?: string | undefined,
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
  // BRAND_WORDMARK rides alongside LOGO_SRC (same single-source-of-truth
  // posture): the Chrome helper passes `wordmark={BRAND_WORDMARK}`, so when
  // LOGO_SRC is undefined (no clean logo — an app-icon-only brand like Klarna)
  // BrandChrome's `{logoSrc ? <img> : <wordmark/>}` fallback prints the text
  // wordmark instead of a blank silhouetted square. undefined when a real logo
  // renders (the corner stays image-only, unchanged for logo brands).
  const decl =
    `const LOGO_SRC = ${logoSrc ? JSON.stringify(logoSrc) : "undefined"};\n` +
    `const BRAND_WORDMARK = ${wordmark ? JSON.stringify(wordmark) : "undefined"};\n`;

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
