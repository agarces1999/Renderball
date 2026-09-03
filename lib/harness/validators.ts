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
  kind: "invented-numeral" | "foreign-image" | "missing-logo" | "unstable-piece-id" | "style-not-on-every-page";
  detail: string;
  /** One-line patch instruction for the surgical fix call. */
  patch: string;
}

/**
 * Remove entire CLASSES of never-viewer-visible bytes before any numeral
 * scanning: data-URIs, URLs, asset filenames, and hex colors. This is the
 * generalization the four false-positive floods pointed at (136 attr-string
 * coords → 55 hex → 40 apostrophe → 26 generics → 2026-09-02: 11 phantoms
 * from ONE base64 logo const, which pushed a Stripe deck over the patch
 * ceiling while its twin's patch obeyed the phantom orders and EMPTIED the
 * logo). Encoded bytes are not claims; strip the class, not the token.
 */
const stripNonVisible = (code: string): string =>
  code
    // <style> blocks (@font-face, and since motion shipped, @keyframes): the
    // percentages and pixel offsets in "0% { transform: translateY(24px) }"
    // are never read by a viewer, but the JSX-text extractor below would see
    // them as prose between ">" and "<".
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, " ")
    .replace(/data:[a-zA-Z0-9/+.-]+;base64,[A-Za-z0-9+/=]+/g, " ")
    .replace(/https?:\/\/[^\s"'`)>]+/g, " ")
    .replace(/[\w./-]+\.(?:woff2?|ttf|otf|eot|png|jpe?g|gif|svg|webp|avif|mp4|css|js|json)\b[^\s"'`)>]*/g, " ")
    .replace(/#[0-9a-fA-F]{3,8}\b/g, " ");

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

/** A string literal that is a style/geometry VALUE, not viewer-readable text:
 *  hex colors ("#050D1F" → "050" flooded the Disney batch build with 55 false
 *  violations), rgba()/hsl() strings, pure point/coordinate data ("1150 780"),
 *  and SVG path constants ("M0,395 L80…"). A claim-bearing string contains a
 *  real word; these never do. */
const isStyleValueChunk = (chunk: string): boolean => {
  const t = chunk.trim();
  if (t.startsWith("#")) return true;
  if (/^(rgba?|hsla?|calc|url|linear-gradient|radial-gradient)\(/i.test(t)) return true;
  if (/^[Mm]\s*-?\d/.test(t)) return true; // SVG path data
  // A CSS at-rule block held in a template const (`const KEYFRAMES = \`@keyframes
  // rb-rise { from { opacity: 0 } … }\``) and rendered into a <style> later.
  if (/@(?:keyframes|font-face|media)\b/.test(t)) return true;
  const words = t.match(/[A-Za-z]{3,}/g) ?? [];
  // CSS vocabulary counts as unit-speak: a template-literal @font-face block
  // or "max-width: 640px" string is style plumbing, not a viewer claim (the
  // font-asset hash "178166" was flagged as an invented statistic without
  // these words on the list).
  const nonUnit = words.filter(
    (w) =>
      !/^(px|rem|em|deg|rgba?|hsla?|solid|dashed|dotted|calc|var|auto|none|vh|vw|width|height|font|face|family|src|url|format|local|swap|weight|style|normal|italic|bold|serif|sans|mono|monospace|letter|spacing|line|margin|padding|border|radius|left|right|top|bottom|block|inline|flex|grid|absolute|relative|woff)$/i.test(
        w,
      ),
  );
  return nonUnit.length === 0; // pure numbers/coords/units → geometry
};

/** Numerals a viewer would read in the given source region. */
const readableNumerals = (text: string): string[] => {
  // Double-quote + backtick literals only. Single quotes are NOT scanned: an
  // apostrophe in prose ("the quarter's growth") pairs with the next one and
  // swallows real code between them — the Atlas batch build flooded 40 false
  // numerals from exactly that phantom. Template chunks with ${} are code.
  const literals = [...text.matchAll(/(["`])((?:(?!\1)[\s\S])*)\1/g)]
    .map((m) => m[2])
    .filter((c) => !c.includes("${"))
    .filter((c) => !isStyleValueChunk(c));
  // A ">…<" span is only PROSE if it doesn't read as code: TypeScript generics
  // (Array<[string, number]> = [ ["Retention", 600], … ) end with ">" and turn
  // the data array AFTER them into phantom "JSX text" — the Disney batch
  // build's last 26 false numerals were exactly this.
  const jsxText = [...text.matchAll(/>([^<>{}]+)</g)]
    .map((m) => m[1])
    .filter((c) => !/(=>|=\s*\[|\];|\bconst\b|\breturn\b|\],)/.test(c));
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
  ok.add("0"); // a bare zero is never a fabricated statistic
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
  return readableNumerals(stripNonVisible(stripLayout(code)))
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

/**
 * Piece ids the LEGO store can hold one-to-one: literal and unique. A
 * computed id (a <Piece> rendered inside a .map) decomposes under a counter
 * name that can collide with a real one — the corruption that killed pages
 * 2/4 of the founder's Deel deck (2026-08-31). Caught HERE, the surgical
 * patch fixes it before the deck ships, so decks arrive fully editable
 * instead of degrading at decompose time.
 */
export const findUnstablePieceIds = (code: string): TruthViolation[] => {
  const out: TruthViolation[] = [];
  const seen = new Set<string>();
  for (const m of code.matchAll(/<Piece\b[^>]*>/g)) {
    const tag = m[0];
    const lit = /\bid="([^"]+)"/.exec(tag);
    if (!lit) {
      if (/\bid=\{/.test(tag)) {
        out.push({
          kind: "unstable-piece-id",
          detail: tag.slice(0, 80),
          patch:
            `A <Piece> has a computed id (${tag.slice(0, 60)}…). Piece ids must be LITERAL strings — ` +
            `never render <Piece> inside a loop: move the .map INSIDE one Piece wrapper with a literal id, keeping the output identical.`,
        });
      }
      continue;
    }
    if (seen.has(lit[1])) {
      out.push({
        kind: "unstable-piece-id",
        detail: lit[1],
        patch: `Two <Piece> tags share id "${lit[1]}". Rename one so every piece id is unique in the file, changing nothing else.`,
      });
    }
    seen.add(lit[1]);
  }
  return out;
};

/**
 * The deck's <style> (@font-face, and since motion, @keyframes) must reach
 * EVERY page: each page is served as its own document. The first motion build
 * (2026-09-03) rendered `<DeckStyle />` inside Section0 only — "a single
 * <style> rendered once" read as once per DECK — and pages 2-5 shipped with
 * animation properties pointing at keyframes that did not exist: static, with
 * no error anywhere. Same failure shape leaves pages 2+ without brand fonts.
 *
 * Static reachability, one level of indirection: a <style> is fine when it
 * sits inside a component rendered at least sceneCount times (the chrome), or
 * inside a component rendered by such a component, or directly inside every
 * Section. Anything else — a Section-owned style, a component used once — is
 * a page-1-only style and gets a targeted patch.
 */
export const findStyleNotOnEveryPage = (code: string, sceneCount: number): TruthViolation[] => {
  if (sceneCount <= 1 || !/<style\b/.test(code)) return [];
  // Top-level declarations, in order — each <style> belongs to the nearest one above it.
  const decls = [...code.matchAll(/^(?:export\s+)?(?:const|function)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => ({
    name: m[1],
    at: m.index ?? 0,
  }));
  const ownerAt = (idx: number): string | null => {
    let owner: string | null = null;
    for (const d of decls) {
      if (d.at <= idx) owner = d.name;
      else break;
    }
    return owner;
  };
  const uses = (name: string): number => (code.match(new RegExp(`<${name}\\b`, "g")) ?? []).length;
  const isSection = (name: string | null): boolean => !!name && /^Section\d+$/.test(name);
  const reachesEveryPage = (name: string | null, depth = 0): boolean => {
    if (!name) return false;
    if (isSection(name)) return false;
    if (uses(name) >= sceneCount) return true;
    if (depth >= 2) return false;
    // Rendered by a component that itself reaches every page?
    for (const m of code.matchAll(new RegExp(`<${name}\\b`, "g"))) {
      const parent = ownerAt(m.index ?? 0);
      if (parent && parent !== name && reachesEveryPage(parent, depth + 1)) return true;
    }
    return false;
  };
  const styles = [...code.matchAll(/<style\b/g)].map((m) => ownerAt(m.index ?? 0));
  const inSections = styles.filter((o) => isSection(o)).length;
  if (inSections >= sceneCount) return [];
  if (styles.some((o) => reachesEveryPage(o))) return [];
  const owner = styles[0] ?? "unknown";
  return [
    {
      kind: "style-not-on-every-page" as const,
      detail: String(owner),
      patch:
        `The deck's <style> (its @font-face / @keyframes rules) lives in "${owner}", which is not rendered by every page — ` +
        `each page is served as its own document, so the other pages lose their fonts and their motion. ` +
        `Render that <style> unconditionally inside the chrome component every Section renders (or directly in every Section), changing nothing else.`,
    },
  ];
};

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
  ...findUnstablePieceIds(args.code),
  ...findStyleNotOnEveryPage(args.code, args.sceneCount),
];
