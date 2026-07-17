/**
 * text-integrity — the cycle-9 P1 gate: catch copy that renders as fragments.
 *
 * Two independent arms, both blocking, both shared by the spike + production
 * quality loop:
 *
 *   1. ICON-FONT-IN-A-TEXT-ROLE (static, on the assembled Composition). The
 *      cycle-8 defect the whole gate battery missed: an icon/symbol webfont
 *      (Tony's crawl put "swiper-icons" in the display AND body font_roles) led
 *      the FONT_DISPLAY / FONT_BODY stacks. It has no letterforms, so every
 *      headline/lede/bullet/caption collapsed to its leading capital + punct
 *      ("Decades of looking away" → "D", "Supply reports:…" → "S:"). The DOM
 *      text stayed FULL, so every text-node gate (density, contrast, overflow)
 *      passed it — the truncation lived purely in the glyph layer. This arm
 *      reads it straight off the source consts and DETERMINISTICALLY strips the
 *      icon font out of the text stacks (a zero-token repair, like the edge-crop
 *      clamp / stray-fragment excise).
 *
 *   2. ORPHANED CONTENT FRAGMENT (measured text nodes). Defense-in-depth for the
 *      OTHER truncation class the task hypothesised — a bind/emit bug that
 *      renders a copy field as a lone char, a label-colon with no value, or
 *      dotted initials ("D", "S:", "T.R.A.T."). Scoped to the editorial copy
 *      column (text pieces at reading size) so short diegetic mock labels and
 *      numeric stats never false-fire.
 */
import type { SceneMeasurement } from "./measure-scene";
import { isIconFont } from "./crawl-theme";

// ─── arm 1: icon font in a text role ─────────────────────────────────────────

export interface IconFontStackFinding {
  /** The const or inline site: "FONT_DISPLAY" | "FONT_BODY" | "FONT_MONO" | "inline". */
  site: string;
  /** The offending icon-font family (the primary/leading family of the stack). */
  family: string;
  detail: string;
}

/** Split a css font-family list value into trimmed, unquoted family names. */
const splitFamilies = (value: string): string[] =>
  value
    .split(",")
    .map((f) => f.trim().replace(/^['"]|['"]$/g, "").trim())
    .filter(Boolean);

const TEXT_FONT_CONST_RX = /const\s+(FONT_DISPLAY|FONT_BODY|FONT_MONO)\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*;/g;
const INLINE_FONT_FAMILY_RX = /fontFamily\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;

/** Find every TEXT font stack whose PRIMARY (leading) family is an icon/symbol
 *  font — the render-breaking case. FONT_MONO counts (mono microcopy is text);
 *  inline literal fontFamily strings count too. Bindings to the consts
 *  (`fontFamily: FONT_BODY`) are covered by the const check. */
export const findIconFontTextStacks = (code: string): IconFontStackFinding[] => {
  const out: IconFontStackFinding[] = [];
  let m: RegExpExecArray | null;
  TEXT_FONT_CONST_RX.lastIndex = 0;
  while ((m = TEXT_FONT_CONST_RX.exec(code))) {
    const site = m[1];
    const fams = splitFamilies(m[2].slice(1, -1));
    if (fams.length > 0 && isIconFont(fams[0])) {
      out.push({
        site,
        family: fams[0],
        detail: `${site} leads with the icon/symbol font "${fams[0]}" — it has no letterforms, so real copy renders as fragments (lowercase glyphs vanish). A text role must lead with a real text family.`,
      });
    }
  }
  INLINE_FONT_FAMILY_RX.lastIndex = 0;
  while ((m = INLINE_FONT_FAMILY_RX.exec(code))) {
    const fams = splitFamilies(m[1].slice(1, -1));
    if (fams.length > 0 && isIconFont(fams[0])) {
      out.push({
        site: "inline",
        family: fams[0],
        detail: `an inline fontFamily leads with the icon/symbol font "${fams[0]}" — real copy set in it renders as fragments.`,
      });
    }
  }
  return out;
};

export interface IconFontStripResult {
  code: string;
  /** Sites rewritten, with the icon family that was dropped. */
  stripped: { site: string; family: string }[];
}

const DISPLAY_BODY_FALLBACK = "Inter, system-ui, sans-serif";
const MONO_FALLBACK = 'ui-monospace, "SF Mono", Menlo, monospace';

/** Deterministically drop icon/symbol families from every TEXT font stack. If a
 *  stack has NO real family left, substitute the role's safe fallback so copy is
 *  always set in a letterform font. Zero tokens. */
export const stripIconFontsFromTextStacks = (code: string): IconFontStripResult => {
  const stripped: { site: string; family: string }[] = [];
  const rewriteList = (value: string, fallback: string): string | null => {
    const fams = splitFamilies(value);
    const icons = fams.filter((f) => isIconFont(f));
    if (icons.length === 0) return null;
    const kept = fams.filter((f) => !isIconFont(f));
    const finalFams = kept.length > 0 ? kept : splitFamilies(fallback);
    return finalFams.map((f) => (/[^a-zA-Z0-9-]/.test(f) ? JSON.stringify(f) : f)).join(", ");
  };
  let out = code.replace(TEXT_FONT_CONST_RX, (whole, site: string, quoted: string) => {
    const fallback = site === "FONT_MONO" ? MONO_FALLBACK : DISPLAY_BODY_FALLBACK;
    const rewritten = rewriteList(quoted.slice(1, -1), fallback);
    if (rewritten == null) return whole;
    const icon = splitFamilies(quoted.slice(1, -1)).find((f) => isIconFont(f))!;
    stripped.push({ site, family: icon });
    return `const ${site} = ${JSON.stringify(rewritten)};`;
  });
  out = out.replace(INLINE_FONT_FAMILY_RX, (whole, quoted: string) => {
    const rewritten = rewriteList(quoted.slice(1, -1), DISPLAY_BODY_FALLBACK);
    if (rewritten == null) return whole;
    const icon = splitFamilies(quoted.slice(1, -1)).find((f) => isIconFont(f))!;
    stripped.push({ site: "inline", family: icon });
    return `fontFamily: ${JSON.stringify(rewritten)}`;
  });
  return { code: out, stripped };
};

// ─── arm 2: orphaned content fragment (measured) ─────────────────────────────

export interface OrphanedFragmentFinding {
  scene: number;
  pieceId: string;
  text: string;
  fontSize: number;
  form: "lone-char" | "label-colon" | "dotted-initials";
  detail: string;
  repairInstruction: string;
}

/** A lone alphabetic character ("D"). */
const LONE_CHAR_RX = /^[A-Za-z]$/;
/** A single-letter label with an empty value ("S:", "P :"). */
const LABEL_COLON_RX = /^[A-Za-z]\s*:$/;
/** First-letters joined by dots, the collapse of a multi-word/multi-sentence
 *  string ("T.R.A.T.", "S.E."). */
const DOTTED_INITIALS_RX = /^(?:[A-Za-z]\s*\.\s*){2,}$/;

const MIN_COPY_FONT_SIZE = 12;

/** True when a measured element sits in the EDITORIAL copy column — the only
 *  place a short string signals truncation. Diegetic mock labels, chrome, and
 *  numeric stats are legitimately terse and excluded. */
const isCopyContext = (pieceKind: string | undefined, pieceId: string): boolean =>
  pieceKind === "text" || /\.copy$/.test(pieceId);

/** Orphaned-fragment text nodes in a scene's copy column — a rendered copy node
 *  that is a lone char, a value-less label-colon, or dotted initials. */
export const findOrphanedFragments = (m: SceneMeasurement): OrphanedFragmentFinding[] => {
  const out: OrphanedFragmentFinding[] = [];
  for (const e of m.elements ?? []) {
    const text = (e.text ?? "").trim();
    if (!text) continue;
    if (e.fontSize < MIN_COPY_FONT_SIZE) continue;
    if (!isCopyContext(e.pieceKind, e.piece)) continue;
    let form: OrphanedFragmentFinding["form"] | null = null;
    if (LONE_CHAR_RX.test(text)) form = "lone-char";
    else if (LABEL_COLON_RX.test(text)) form = "label-colon";
    else if (DOTTED_INITIALS_RX.test(text)) form = "dotted-initials";
    if (!form) continue;
    out.push({
      scene: m.scene,
      pieceId: e.piece || `s${m.scene}.copy`,
      text,
      fontSize: e.fontSize,
      form,
      detail: `Orphaned copy fragment "${text}" (${form}) at ${e.fontSize}px in ${e.piece || "the copy column"} — a copy field rendered as a stray fragment instead of its full text.`,
      repairInstruction:
        "Render the FULL copy string for this field (bind it via c.<field>); never emit a single character, an empty label-colon, or dotted initials where a headline / lede / bullet / caption belongs.",
    });
  }
  return out;
};
