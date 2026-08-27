/**
 * Truth validators — mechanical, instant, zero tokens (docs/HARNESS.md §4).
 *
 * Code checks facts; it never votes on taste. M4 (2026-08-27) is the proof
 * this cannot live in the prompt: the prod engine invented "190M subscribers"
 * straight through an explicit ban. A violation produces a TARGETED patch
 * instruction naming the exact lie — never a re-roll.
 *
 * Numeral scope: only numerals a VIEWER READS — string literals and JSX text —
 * are checked. Style objects, numeric props, SVG geometry are layout, not
 * claims, and are stripped before scanning.
 */
import { findForeignImageSrcs } from "../agents/emission-guards";

export interface TruthViolation {
  kind: "invented-numeral" | "foreign-image" | "missing-logo";
  detail: string;
  /** One-line patch instruction for the surgical fix call. */
  patch: string;
}

/** Remove style={{...}} objects (brace-balanced) and numeric JSX props. */
const stripLayout = (code: string): string => {
  let out = "";
  let i = 0;
  while (i < code.length) {
    const at = code.indexOf("style={{", i);
    if (at === -1) {
      out += code.slice(i);
      break;
    }
    out += code.slice(i, at);
    let depth = 0;
    let j = at + "style={".length;
    for (; j < code.length; j++) {
      if (code[j] === "{") depth++;
      else if (code[j] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    i = j + 2; // past "}}" and the prop's closing brace
  }
  // numeric/expression props: width={960}, cx={330}, r={i % 3 ? 2 : 1} …
  // AND string-valued attributes: d="M0,395 L80…", viewBox="0 0 1920 1080",
  // stroke-dasharray="4 4" — attribute strings are geometry, not claims. The
  // first witness build (2026-08-27) flooded 136 false violations from these.
  return out
    .replace(/\s[a-zA-Z-]+=\{[^{}]*\}/g, " ")
    .replace(/\s[a-zA-Z-]+="[^"]*"/g, " ");
};

/** Numerals a viewer would read in the given source region. */
const readableNumerals = (text: string): string[] => {
  const literals = [...text.matchAll(/(["'`])((?:(?!\1)[\s\S])*)\1/g)].map((m) => m[2]);
  const jsxText = [...text.matchAll(/>([^<>{}]+)</g)].map((m) => m[1]);
  const tokens = new Set<string>();
  for (const chunk of [...literals, ...jsxText]) {
    for (const m of chunk.matchAll(/\d[\d,.]*/g)) {
      const tok = m[0].replace(/[.,]$/, "");
      if (tok) tokens.add(tok);
    }
  }
  return [...tokens];
};

/** Page indices are always allowed: 1..n, zero-padded or plain. */
const pageIndexAllowance = (sceneCount: number): Set<string> => {
  const ok = new Set<string>();
  for (let i = 1; i <= Math.max(sceneCount, 9); i++) {
    ok.add(String(i));
    ok.add(String(i).padStart(2, "0"));
  }
  ok.add(String(sceneCount));
  return ok;
};

export const findInventedNumerals = (
  code: string,
  approvedText: string,
  sceneCount: number,
): TruthViolation[] => {
  const allowed = new Set([
    ...readableNumerals(approvedText),
    // Every numeric token in the approved copy, however punctuated.
    ...[...approvedText.matchAll(/\d[\d,.]*/g)].map((m) => m[0].replace(/[.,]$/, "")),
    ...pageIndexAllowance(sceneCount),
  ]);
  return readableNumerals(stripLayout(code))
    .filter((tok) => !allowed.has(tok))
    .map((tok) => ({
      kind: "invented-numeral" as const,
      detail: tok,
      patch: `The numeral "${tok}" appears in visible text but is not in the approved copy. Remove it or replace it with wording from the outline — do not substitute a different number.`,
    }));
};

export const findImageViolations = (code: string, allowedUrls: string[]): TruthViolation[] =>
  findForeignImageSrcs(code, new Set(allowedUrls)).map((src) => ({
    kind: "foreign-image" as const,
    detail: src,
    patch: `The image URL "${src}" is not in the allowed asset list. Remove it; draw the idea as SVG or use an allowed asset.`,
  }));

export const findLogoViolation = (code: string, logoSrc: string | null): TruthViolation[] =>
  logoSrc && !code.includes(logoSrc)
    ? [
        {
          kind: "missing-logo" as const,
          detail: logoSrc,
          patch: `The real brand logo (${logoSrc}) is never used. Add it as the chrome lockup on every page (img, height 24-36px, natural aspect).`,
        },
      ]
    : [];

export const validateDeck = (args: {
  code: string;
  approvedText: string;
  sceneCount: number;
  allowedUrls: string[];
  logoSrc: string | null;
}): TruthViolation[] => [
  ...findInventedNumerals(args.code, args.approvedText, args.sceneCount),
  ...findImageViolations(args.code, args.allowedUrls),
  ...findLogoViolation(args.code, args.logoSrc),
];
