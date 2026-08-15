//
// The inserted free-text box: ONE place that defines its markup shape.
//
// A text box the user adds is a single <span data-rb-freetext="1"> whose copy is a
// JS-string literal and whose formatting is carried in a compact `data-rb-fmt` spec
// attribute. Both the INSERT path (insert-element.ts) and the FORMAT/TEXT edit path
// (edit-piece-text.ts) go through `emitFreetextSpan` here, so the two can never drift
// — an edit re-emits the whole span from (text, format) rather than regex-patching
// individual style properties, which would be fragile.
//
// The spec is a compact `k:v;k:v` string (not JSON) so it embeds in a JSX string
// attribute with no escaping games and stays readable in the generated source:
//   data-rb-fmt="f:FONT_BODY;s:32;w:500;i:0;u:0;c:inherit;a:left"
//

export type FreetextAlign = "left" | "center" | "right";

export interface FreetextFormat {
  /** Font const IDENTIFIER from the frozen design system (e.g. "FONT_BODY"), or ""
   *  when the preamble defines none — then fontFamily is omitted and inherits. */
  font: string;
  size: number;
  weight: number;
  italic: boolean;
  underline: boolean;
  /** "inherit" or a literal color value. Never a const name — const names vary by
   *  build path and an undefined one crashes the render. */
  color: string;
  align: FreetextAlign;
}

export const DEFAULT_FORMAT: FreetextFormat = {
  font: "",
  size: 32,
  weight: 500,
  italic: false,
  underline: false,
  color: "inherit",
  align: "left",
};

/** Font/const identifiers only — guards the raw (unquoted) emission of `fontFamily: X`. */
const IDENT_RX = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Colors we are willing to emit: "inherit", #hex, rgb()/rgba(), or a plain css name. */
const COLOR_RX = /^(inherit|currentColor|#[0-9a-fA-F]{3,8}|rgba?\([0-9.,\s%]+\)|[a-zA-Z]{3,20})$/;

export const isSafeColor = (c: string): boolean => COLOR_RX.test(c.trim());

const ALIGNS: FreetextAlign[] = ["left", "center", "right"];

export const serializeFmt = (f: FreetextFormat): string =>
  [
    `f:${IDENT_RX.test(f.font) ? f.font : ""}`,
    `s:${Math.round(f.size)}`,
    `w:${Math.round(f.weight)}`,
    `i:${f.italic ? 1 : 0}`,
    `u:${f.underline ? 1 : 0}`,
    `a:${f.align}`,
    // color last: it's the only value that may contain punctuation (rgb(...)).
    `c:${f.color}`,
  ].join(";");

export const parseFmt = (spec: string | undefined): FreetextFormat => {
  const out: FreetextFormat = { ...DEFAULT_FORMAT };
  if (!spec) return out;
  // Split on the first ";c:" so a color value containing ';' can never break parsing.
  const cIdx = spec.indexOf(";c:");
  const head = cIdx >= 0 ? spec.slice(0, cIdx) : spec;
  const color = cIdx >= 0 ? spec.slice(cIdx + 3) : "";
  for (const part of head.split(";")) {
    const [k, ...rest] = part.split(":");
    const v = rest.join(":");
    if (k === "f" && (v === "" || IDENT_RX.test(v))) out.font = v;
    else if (k === "s" && Number.isFinite(Number(v))) out.size = Number(v);
    else if (k === "w" && Number.isFinite(Number(v))) out.weight = Number(v);
    else if (k === "i") out.italic = v === "1";
    else if (k === "u") out.underline = v === "1";
    else if (k === "a" && (ALIGNS as string[]).includes(v)) out.align = v as FreetextAlign;
  }
  if (color && isSafeColor(color)) out.color = color.trim();
  return out;
};

/** Clamp/sanitize a format so nothing unsafe or absurd reaches the emitted source. */
export const normalizeFormat = (f: Partial<FreetextFormat>, base: FreetextFormat = DEFAULT_FORMAT): FreetextFormat => {
  const merged = { ...base, ...f };
  return {
    font: IDENT_RX.test(merged.font ?? "") ? merged.font : "",
    size: Math.min(400, Math.max(8, Math.round(Number(merged.size) || base.size))),
    weight: Math.min(900, Math.max(100, Math.round(Number(merged.weight) || base.weight))),
    italic: !!merged.italic,
    underline: !!merged.underline,
    color: typeof merged.color === "string" && isSafeColor(merged.color) ? merged.color.trim() : "inherit",
    align: (ALIGNS as string[]).includes(merged.align as string) ? (merged.align as FreetextAlign) : base.align,
  };
};

/**
 * Emit the complete free-text span. `display:block` + the wrapper's width is what
 * makes textAlign meaningful (a plain inline span would ignore it). The copy is a
 * JS-string child `{"…"}` — always valid TSX regardless of quotes/braces in the text.
 */
export const emitFreetextSpan = (text: string, format: FreetextFormat): string => {
  const f = normalizeFormat(format);
  const style = [
    f.font ? `fontFamily: ${f.font}` : null, // raw identifier — validated above
    `fontSize: ${f.size}`,
    `fontWeight: ${f.weight}`,
    f.italic ? `fontStyle: "italic"` : null,
    f.underline ? `textDecoration: "underline"` : null,
    `color: ${JSON.stringify(f.color)}`,
    `lineHeight: 1.3`,
    `whiteSpace: "pre-wrap"`,
    `display: "block"`,
    `textAlign: ${JSON.stringify(f.align)}`,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    `<span data-rb-freetext="1" data-rb-fmt=${JSON.stringify(serializeFmt(f))} ` +
    `style={{ ${style} }}>{${JSON.stringify(text)}}</span>`
  );
};

/** The whole emitted span: open tag attrs (1) + the JS-string copy child (2). */
const SPAN_RX = /<span\s+data-rb-freetext="1"([^>]*)>\s*\{("(?:[^"\\]|\\.)*")\}\s*<\/span>/;


/** Read the current (text, format) out of a piece body. Null when it has no free-text. */
export const readFreetext = (body: string): { text: string; format: FreetextFormat } | null => {
  const m = body.match(SPAN_RX);
  if (!m) return null;
  const attrs = m[1] ?? "";
  const fmtAttr = attrs.match(/data-rb-fmt="([^"]*)"/)?.[1];
  let text = "";
  try {
    text = JSON.parse(m[2]) as string;
  } catch {
    text = "";
  }
  return { text, format: parseFmt(fmtAttr) };
};

/**
 * Re-emit the free-text span with a new copy and/or a format patch, leaving the rest
 * of the piece body byte-identical. Returns null when the body has no free-text span.
 */
export const patchFreetextSpan = (
  body: string,
  patch: { text?: string; format?: Partial<FreetextFormat> },
): string | null => {
  const current = readFreetext(body);
  if (!current) return null;
  const text = typeof patch.text === "string" ? patch.text : current.text;
  const format = patch.format ? normalizeFormat(patch.format, current.format) : current.format;
  // Function replacer: the emitted span is inserted VERBATIM (a `$&`/`$'` in the copy
  // must never inject surrounding bytes).
  return body.replace(SPAN_RX, () => emitFreetextSpan(text, format));
};

/**
 * The video's own colors, for the toolbar's swatches — extracted from the frozen
 * design system (manifest.preamble) so every choice is on-brand by construction.
 * Const NAMES vary by build path and can't be referenced safely, so we surface the
 * literal values the preamble already declares and emit those.
 */
export const themeSwatches = (preamble: string, limit = 12): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const c = raw.trim();
    if (!isSafeColor(c) || seen.has(c.toLowerCase())) return;
    seen.add(c.toLowerCase());
    out.push(c);
  };
  // Hex first (the palette consts), then rgb()/rgba() — skipping fully transparent.
  for (const m of preamble.matchAll(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g)) push(m[0]);
  for (const m of preamble.matchAll(/rgba?\([0-9.,\s%]+\)/g)) {
    const a = m[0].match(/,\s*([0-9.]+)\s*\)$/);
    if (a && Number(a[1]) < 0.5) continue; // near-invisible tints aren't useful as text colors
    push(m[0]);
  }
  return out.slice(0, limit);
};
