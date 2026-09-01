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

/**
 * Where the PAGE background actually lives.
 *
 * A founder test found Background permanently dead ("not in this deck"): the
 * role only resolved from PALETTE keys literally named `canvas`/`canvasAlt`,
 * and even those were dropped when their value was white — STRUCTURAL treats
 * pure white as untouchable because a GLOBAL swap of #ffffff would recolour
 * every white headline in the deck. Both restrictions are artefacts of
 * substitution-by-value; the page background is a POSITION, not a value. So
 * the canvas role resolves from where backgrounds are painted, and is applied
 * (see reskinComposition) only at those positions — which makes white safe.
 *
 *   keyed — PALETTE keys whose NAME declares background semantics. Rewriting
 *           the const's value is safe and keeps every reader coherent,
 *           including knockout text that deliberately matches the page.
 *   paint — values found at SECTION_FRAME paint sites: the frame const's own
 *           `background:` and per-section `...SECTION_FRAME, background:`
 *           overrides (117 of 132 stored decks carry the frame). These may be
 *           `PALETTE.someKey` refs (a deck that paints with PALETTE.white
 *           must NOT have `white` itself rewritten — text uses it too) or
 *           quoted hex literals; both are only ever touched in background
 *           position.
 */
const CANVAS_KEY_RE = /^(canvas|canvasAlt|bg|background|paper|page)$/;
export interface CanvasPaint {
  /** PALETTE key names with background semantics, e.g. ["canvas"]. */
  keyed: string[];
  /** Paint-site values, verbatim: a "PALETTE.key" ref, a "#hex" literal, or —
   *  for gradient pages — the whole quoted/template value as it appears in the
   *  source, so application can replace exactly that expression. */
  paint: string[];
  /** Current page colours, best guess first — for display and enablement. */
  hexes: string[];
}
export const findCanvasPaint = (source: string): CanvasPaint => {
  const palette = parsePaletteConst(source);
  const keyed: string[] = [];
  const paint: string[] = [];
  const hexes: string[] = [];
  const seenHex = (h?: string) => {
    const x = h && expand(h.toLowerCase());
    if (x && isHex(x) && !hexes.includes(x)) hexes.push(x);
  };

  for (const [key, hex] of Object.entries(palette)) {
    if (!CANVAS_KEY_RE.test(key)) continue;
    keyed.push(key);
    seenHex(hex);
  }

  // Paint sites. `[^{}]` keeps each match inside ONE object literal, so a
  // frame const with no background cannot swallow the file up to someone
  // else's declaration.
  const VALUE =
    `(?:PALETTE\\.(\\w+)` +
    `|["'](#[0-9a-fA-F]{3,8})["']` +
    // Gradient pages: capture the WHOLE value expression verbatim (template
    // literal or quoted gradient) — flattening it to the user's flat colour is
    // exactly what picking a colour means on a gradient page.
    `|(\`[^\`\n]{0,600}\`)` +
    `|(["'][^"'\n]{0,60}?gradient[^"'\n]{0,500}?["']))`;
  const sites = [
    new RegExp(`\\bSECTION_FRAME[^=\\n]{0,40}=\\s*\\{[^{}]{0,800}?background(?:Color)?:\\s*${VALUE}`, "g"),
    new RegExp(`\\.\\.\\.\\s*SECTION_FRAME\\s*,[^{}]{0,240}?background(?:Color)?:\\s*${VALUE}`, "g"),
  ];
  for (const re of sites) {
    for (const m of source.matchAll(re)) {
      const [, key, hex, tmpl, grad] = m;
      if (key) {
        if (!CANVAS_KEY_RE.test(key)) {
          const ref = `PALETTE.${key}`;
          if (!paint.includes(ref)) paint.push(ref);
        }
        seenHex(palette[key]);
      } else if (hex && hex.length >= 4) {
        const lit = expand(hex.toLowerCase());
        if (!paint.includes(lit)) paint.push(lit);
        seenHex(lit);
      } else if (tmpl || grad) {
        const verbatim = (tmpl ?? grad)!;
        if (!paint.includes(verbatim)) paint.push(verbatim);
        // Swatch shows the gradient's first stop — close enough to identify it.
        seenHex(verbatim.match(/#[0-9a-fA-F]{6}\b/)?.[0]);
        for (const k of verbatim.matchAll(/PALETTE\.(\w+)/g)) seenHex(palette[k[1]]);
      }
    }
  }
  return { keyed, paint, hexes };
};

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
export interface ResolvedRoles extends Partial<Record<PaletteRole, string[]>> {
  /** The page background, resolved by POSITION — see findCanvasPaint. Kept off
   *  the plain role map so it can never reach the global literal swap. */
  canvasPaint?: CanvasPaint;
}

export const resolveRoleColors = (source: string): ResolvedRoles => {
  const palette = parsePaletteConst(source);
  const out: ResolvedRoles = {};

  const add = (role: PaletteRole, hex?: string) => {
    if (!hex || !isHex(hex) || STRUCTURAL.has(hex.toLowerCase())) return;
    const list = out[role] ?? [];
    if (!list.includes(hex.toLowerCase())) list.push(hex.toLowerCase());
    out[role] = list;
  };

  // The page background resolves by POSITION in both branches, and stays out
  // of the value-substitution map entirely — a white page must be editable
  // without turning every white headline beige. `canvas` itself carries the
  // current hexes purely so callers (the brand panel) can show and enable it.
  const paint = findCanvasPaint(source);
  if (paint.keyed.length + paint.paint.length > 0) {
    out.canvasPaint = paint;
    if (paint.hexes.length > 0) out.canvas = [...paint.hexes];
  }

  if (Object.keys(palette).length > 0) {
    // Canonical: accent has several tonal siblings (accentBright, accentSoft…)
    // but only the solid hex ones can be substituted safely — the rgba()
    // variants carry their own alpha and are regenerated from the base.
    add("accent", palette.accent);
    add("accent", palette.accentBright);
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
  roleMap?: ResolvedRoles,
): ReskinResult => {
  let code = source;
  const changes: ReskinChange[] = [];

  // ── colours ───────────────────────────────────────────────────────────
  const roles = roleMap ?? resolveRoleColors(source);

  // The page background first, and by POSITION, never by value — swapping a
  // white page's #ffffff globally would recolour every white headline. Two
  // moves, matched to how the deck paints (see findCanvasPaint):
  //   1. background-semantic PALETTE keys get their const VALUE rewritten, so
  //      every reader — including knockout text that matches the page — stays
  //      coherent;
  //   2. paint-site values (a PALETTE.someKey ref or a quoted hex after
  //      `background:`) are rewritten IN PLACE, leaving the key's other uses
  //      alone.
  const canvasTarget = brand.palette?.canvas;
  const paint = roles.canvasPaint;
  if (canvasTarget && isHex(canvasTarget) && paint) {
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let occurrences = 0;

    for (const key of paint.keyed) {
      const declRe = new RegExp(`(\\b${esc(key)}\\s*:\\s*")#[0-9a-fA-F]{3,8}(")`, "g");
      code = code.replace(declRe, (_m, head: string, tail: string) => {
        occurrences++;
        return `${head}${canvasTarget}${tail}`;
      });
    }

    const alts = paint.paint.map((p) =>
      p.startsWith("#") ? `["']${esc(p)}["']` : p.startsWith("PALETTE.") ? `${esc(p)}\\b` : esc(p),
    );
    if (alts.length > 0) {
      const siteRe = new RegExp(`(background(?:Color)?:\\s*)(?:${alts.join("|")})`, "gi");
      code = code.replace(siteRe, (_m, head: string) => {
        occurrences++;
        return `${head}"${canvasTarget}"`;
      });
    }

    if (occurrences > 0) {
      changes.push({
        kind: "color",
        role: "canvas",
        from: paint.hexes.join(" "),
        to: canvasTarget,
        occurrences,
      });
    }
  }

  for (const [role, target] of Object.entries(brand.palette ?? {})) {
    if (!isHex(target)) continue;
    if (role === "canvas") continue; // handled positionally above
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

  // ── INLINE STACKS — the const-less fallback ───────────────────────────
  // Root cause of the founder's "no changes in the deck fonts" (Zoom deck,
  // 2026-08-31): decks authored before the font-const contract inline every
  // stack, so the const rewrite above finds nothing and a font apply was a
  // silent no-op. Two substitutions are mechanical enough to be edits, not
  // judgment:
  //   - every MONO inline stack (monospace/Menlo/Consolas/Courier marker)
  //     becomes the brand mono;
  //   - when the document has exactly ONE distinct non-mono inline stack it
  //     is playing display and body both, and becomes the brand body (or
  //     display when no body is set). Two or more distinct sans stacks mean
  //     roles we cannot tell apart — substitute nothing rather than guess.
  // Replacements are emitted as backtick literals for the same quoting
  // reason as the const path above.
  {
    const monoTarget = brand.fonts?.mono;
    const sansTarget = brand.fonts?.body ?? brand.fonts?.display;
    const wantMonoInline = !!monoTarget && !fonts.mono;
    const wantSansInline = !!sansTarget && !fonts.display && !fonts.body;
    if (wantMonoInline || wantSansInline) {
      const litRe = /fontFamily:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g;
      const distinct = new Map<string, string>(); // literal (with quotes) → bare stack
      for (const m of code.matchAll(litRe)) {
        const lit = m[1];
        distinct.set(lit, lit.slice(1, -1));
      }
      const isMono = (stack: string) => /mono|menlo|consolas|courier/i.test(stack);
      const sansLits = [...distinct.entries()].filter(([, s]) => !isMono(s));
      const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const swapAll = (lit: string, bare: string, target: string, role: string) => {
        if (bare === target) return;
        const re = new RegExp(`fontFamily:\\s*${escapeRe(lit)}`, "g");
        const occurrences = (code.match(re) ?? []).length;
        if (occurrences === 0) return;
        code = code.replace(re, `fontFamily: \`${target}\``);
        changes.push({ kind: "font", role, from: bare, to: target, occurrences });
      };
      if (wantMonoInline) {
        for (const [lit, bare] of distinct) {
          if (isMono(bare)) swapAll(lit, bare, monoTarget!, "mono");
        }
      }
      if (wantSansInline && sansLits.length === 1) {
        const [lit, bare] = sansLits[0];
        swapAll(lit, bare, sansTarget!, brand.fonts?.body ? "body" : "display");
      }
    }
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
