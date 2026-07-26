/**
 * Deterministic re-skin — apply a document's brand WITHOUT regenerating.
 *
 * The product promise is "editing is free, generation is metered". Changing a
 * deck's accent colour or brand font is an edit, not a creative act, so it
 * must cost zero tokens and land instantly. That is possible because the
 * design agents centralise brand into literal values (a `PALETTE` object,
 * `FONT_DISPLAY/BODY/MONO`, a `BRAND_FONTS_CSS` block) — regeneration is even
 * instructed to reuse them rather than invent new ones.
 *
 * The shape is NOT universal, though: across 120 stored builds only 91 carry
 * the canonical `const PALETTE = {` block and 113 carry `FONT_DISPLAY`. A
 * rewriter keyed to that structure would silently fail on a quarter of real
 * documents. So this works on VALUES rather than structure:
 *
 *   1. Read what the document actually uses (parse the canonical consts when
 *      present; otherwise rank the hex literals by frequency).
 *   2. Substitute those exact literals for the new ones.
 *
 * Value substitution is structure-agnostic, so it behaves identically on a
 * canonical composition, a hand-edited one, and anything the agents emit next
 * month. Every replacement is reported so the caller can show the user what
 * changed, and the existing 25-deep undo ring makes it reversible.
 */
import type { DocumentBrand, PaletteRole } from "./document-brand";
import { isHex } from "./document-brand";

/** Colours that are structural rather than brand — never re-skinned.
 *  Pure black/white and fully transparent are used for shadows, scrims and
 *  overlays; recolouring them turns a drop shadow into a coloured smear. */
const STRUCTURAL = new Set(["#000", "#000000", "#fff", "#ffffff"]);

const HEX_RE = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g;

export interface ColorUsage {
  hex: string;
  count: number;
  /** 0-1 chroma — how far from grey this colour is. */
  saturation: number;
}

/** Expand #abc → #aabbcc so parsing is uniform. */
const expand = (hex: string): string =>
  hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;

/** HSL saturation, the standard way brand palettes separate hue from chrome. */
export const saturationOf = (hex: string): number => {
  const h = expand(hex.toLowerCase());
  const r = parseInt(h.slice(1, 3), 16) / 255;
  const g = parseInt(h.slice(3, 5), 16) / 255;
  const b = parseInt(h.slice(5, 7), 16) / 255;
  if (![r, g, b].every((n) => Number.isFinite(n))) return 0;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const l = (max + min) / 2;
  return l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);
};

/** Every brand-candidate colour in the composition, most-used first. */
export const colorsInUse = (source: string): ColorUsage[] => {
  const freq = new Map<string, number>();
  for (const m of source.matchAll(HEX_RE)) {
    const hex = m[0].toLowerCase();
    if (STRUCTURAL.has(hex)) continue;
    freq.set(hex, (freq.get(hex) ?? 0) + 1);
  }
  return [...freq.entries()]
    .map(([hex, count]) => ({ hex, count, saturation: saturationOf(hex) }))
    .sort((a, b) => b.count - a.count || a.hex.localeCompare(b.hex));
};

/**
 * Minimum chroma for a colour to be a plausible ACCENT.
 *
 * The most-used colour in a composition is almost always the canvas or a
 * near-neutral surface tint — an early cut of this resolved one deck's
 * "accent" to #f9f0ff, a pale lavender background, so re-skinning would have
 * painted the page instead of the brand. Accents are saturated by
 * construction; the palette extractor upstream already works this way
 * ("near-grays filtered out"). Below this, treat it as chrome and leave it.
 */
const ACCENT_MIN_SATURATION = 0.25;
/** Very light or very dark colours are backgrounds/ink, not accents. */
const ACCENT_LIGHTNESS_BAND: [number, number] = [0.12, 0.88];

const lightnessOf = (hex: string): number => {
  const h = expand(hex.toLowerCase());
  const r = parseInt(h.slice(1, 3), 16) / 255;
  const g = parseInt(h.slice(3, 5), 16) / 255;
  const b = parseInt(h.slice(5, 7), 16) / 255;
  return (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
};

/** The document's de-facto accent when there is no named palette: the
 *  most-used colour that actually looks like an accent. */
export const inferAccent = (source: string): string | undefined =>
  colorsInUse(source).find((c) => {
    const l = lightnessOf(c.hex);
    return (
      c.saturation >= ACCENT_MIN_SATURATION &&
      l >= ACCENT_LIGHTNESS_BAND[0] &&
      l <= ACCENT_LIGHTNESS_BAND[1]
    );
  })?.hex;

/** Read the canonical `const PALETTE = { role: "#hex", … }` block if present. */
export const parsePaletteConst = (source: string): Record<string, string> => {
  const start = source.search(/^const PALETTE\s*=\s*\{/m);
  if (start === -1) return {};
  const end = source.indexOf("};", start);
  if (end === -1) return {};
  const block = source.slice(start, end);
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/(\w+)\s*:\s*"(#[0-9a-fA-F]{3,6})"/g)) {
    out[m[1]] = m[2].toLowerCase();
  }
  return out;
};

/** Read the current font stacks. */
export const parseFontConsts = (
  source: string,
): { display?: string; body?: string; mono?: string } => {
  const one = (name: string): string | undefined => {
    // Must tolerate ESCAPED quotes: real builds emit
    // `const FONT_DISPLAY = "\"Inter\", sans-serif";`. A lazy [\s\S]*? stops
    // at the first \" and returns a truncated stack, which then corrupted the
    // file when written back.
    const m = new RegExp(
      `^const ${name}\\s*=\\s*(['"\`])((?:\\\\.|(?!\\1)[\\s\\S])*)\\1`,
      "m",
    ).exec(source);
    return m?.[2]?.replace(/\\(["'`\\])/g, "$1");
  };
  return {
    display: one("FONT_DISPLAY"),
    body: one("FONT_BODY"),
    mono: one("FONT_MONO"),
  };
};

/**
 * Which literal colours a role currently maps to.
 *
 * Canonical compositions name their roles, so the mapping is exact. Otherwise
 * fall back to frequency: the single most-used non-structural colour is the
 * document's de-facto accent, and the page background is whatever the canvas
 * const says. Anything we cannot identify is left alone — a wrong guess here
 * recolours something the user did not ask to change.
 */
export const resolveRoleColors = (
  source: string,
): Partial<Record<PaletteRole, string[]>> => {
  const palette = parsePaletteConst(source);
  const out: Partial<Record<PaletteRole, string[]>> = {};

  const add = (role: PaletteRole, hex?: string) => {
    if (!hex || !isHex(hex) || STRUCTURAL.has(hex.toLowerCase())) return;
    const list = out[role] ?? [];
    if (!list.includes(hex.toLowerCase())) list.push(hex.toLowerCase());
    out[role] = list;
  };

  if (Object.keys(palette).length > 0) {
    // Canonical: accent has several tonal siblings (accentBright, accentSoft…)
    // but only the solid hex ones can be substituted safely — the rgba()
    // variants carry their own alpha and are regenerated from the base.
    add("accent", palette.accent);
    add("accent", palette.accentBright);
    add("canvas", palette.canvas);
    add("canvas", palette.canvasAlt);
    add("ink", palette.ink ?? palette.text ?? palette.fg);
    add("muted", palette.muted ?? palette.textMuted);
    add("surface", palette.surface ?? palette.card);
    add("line", palette.line ?? palette.border ?? palette.hairline);
    return out;
  }

  // Non-canonical: infer only the accent, which is the change users actually
  // ask for. Leaving the rest unmapped is deliberate — better to change less
  // than to recolour something arbitrary.
  add("accent", inferAccent(source));
  return out;
};

export interface ReskinChange {
  kind: "color" | "font" | "logo" | "fontface";
  role?: string;
  from: string;
  to: string;
  occurrences: number;
}

export interface ReskinResult {
  code: string;
  changes: ReskinChange[];
}

/** Replace every occurrence of a literal, counting hits. Case-insensitive for
 *  hex (compositions mix `#0891B2` and `#0891b2` freely). */
const replaceLiteral = (
  source: string,
  from: string,
  to: string,
  caseInsensitive: boolean,
): { code: string; count: number } => {
  const esc = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(esc, caseInsensitive ? "gi" : "g");
  let count = 0;
  const code = source.replace(re, () => {
    count++;
    return to;
  });
  return { code, count };
};

/**
 * Apply `brand` to composition source. Pure — returns new source plus a
 * report of exactly what changed, so nothing is silently restyled.
 */
export const reskinComposition = (
  source: string,
  brand: DocumentBrand,
  /**
   * Role→literal mapping resolved ONCE for the whole document.
   *
   * Without this, each fragment resolves its own roles, and a piece body with
   * no PALETTE const falls back to inferring an accent from ITS OWN colours —
   * so three different brand colours across three pieces all collapse into the
   * single new accent, flattening a multi-colour design. Observed on a real
   * deck: #0891b2, #06b6d4 and #059669 all became one hue. Callers that touch
   * more than one fragment MUST resolve against the full composition and pass
   * the result here.
   */
  roleMap?: Partial<Record<PaletteRole, string[]>>,
): ReskinResult => {
  let code = source;
  const changes: ReskinChange[] = [];

  // ── colours ───────────────────────────────────────────────────────────
  const roles = roleMap ?? resolveRoleColors(source);
  for (const [role, target] of Object.entries(brand.palette ?? {})) {
    if (!isHex(target)) continue;
    const current = roles[role as PaletteRole] ?? [];
    for (const from of current) {
      if (from === target.toLowerCase()) continue;
      const r = replaceLiteral(code, from, target, true);
      if (r.count > 0) {
        code = r.code;
        changes.push({ kind: "color", role, from, to: target, occurrences: r.count });
      }
    }
  }

  // ── fonts ─────────────────────────────────────────────────────────────
  // Rewrite the whole DECLARATION rather than substituting the inner text.
  //
  // Substituting the text corrupted 25 of 120 stored compositions: a stack is
  // commonly declared as `const FONT_DISPLAY = "Inter, sans-serif"`, and font
  // stacks contain double quotes ('"Georgia", serif'), so splicing one into a
  // double-quoted literal produced `""Georgia", serif"` — a parse error, i.e.
  // a document that no longer renders at all. Emitting the declaration with
  // backticks sidesteps quoting entirely; validateBrandInput already rejects
  // backticks and `$` in a stack, so the literal cannot be broken out of.
  const fonts = parseFontConsts(source);
  const CONST_FOR = { display: "FONT_DISPLAY", body: "FONT_BODY", mono: "FONT_MONO" } as const;
  for (const slot of ["display", "body", "mono"] as const) {
    const target = brand.fonts?.[slot];
    const from = fonts[slot];
    if (!target || !from || from === target) continue;
    const name = CONST_FOR[slot];
    const declRe = new RegExp(
      `^(const ${name}\\s*=\\s*)(['"\`])(?:\\\\.|(?!\\2)[\\s\\S])*\\2`,
      "m",
    );
    if (!declRe.test(code)) continue;
    code = code.replace(declRe, (_m, head: string) => `${head}\`${target}\``);
    changes.push({ kind: "font", role: slot, from, to: target, occurrences: 1 });
  }

  // ── @font-face ────────────────────────────────────────────────────────
  // Replacing the family name alone would reference a face that never loads,
  // so custom faces are appended to the existing BRAND_FONTS_CSS block.
  const faces = brand.fonts?.faces ?? [];
  if (faces.length > 0) {
    const css = faces
      .map(
        (f) =>
          `@font-face{font-family:"${f.family}";src:url("${f.src}");` +
          `font-weight:${f.weight ?? "400"};font-style:${f.style ?? "normal"};font-display:swap;}`,
      )
      .join("\n");
    const m = /^const BRAND_FONTS_CSS\s*=\s*`/m.exec(code);
    if (m) {
      const at = m.index + m[0].length;
      code = `${code.slice(0, at)}\n${css}\n${code.slice(at)}`;
      changes.push({
        kind: "fontface",
        from: "(none)",
        to: faces.map((f) => f.family).join(", "),
        occurrences: faces.length,
      });
    }
  }

  // ── logo ──────────────────────────────────────────────────────────────
  // The mark reaches the canvas as a src on the brand lockup; swap whatever
  // src the chrome currently points at.
  if (brand.logo) {
    const cur =
      /logoSrc\s*=\s*["']([^"']+)["']/.exec(code)?.[1] ??
      /LOGO_SRC\s*=\s*["']([^"']+)["']/.exec(code)?.[1] ??
      /data-rb-brand-logo[^>]*src=["']([^"']+)["']/.exec(code)?.[1];
    if (cur && cur !== brand.logo) {
      const r = replaceLiteral(code, cur, brand.logo, false);
      if (r.count > 0) {
        code = r.code;
        changes.push({
          kind: "logo",
          from: cur,
          to: brand.logo,
          occurrences: r.count,
        });
      }
    }
  }

  return { code, changes };
};
