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

// ─── shared: <Piece> spans on the assembled composition ──────────────────────
//
// The cycle-9 P2 assemble shim wraps every cast piece in `<Piece id="…" kind="…">
// …</Piece>` (display:contents), giving clean, non-nested per-piece source spans.
// arm 3/4 read stats + brand marks straight off these spans (the s4 defects — a
// CSS-counter hero stat and an SVG-path wordmark — never reach the DOM text layer
// so no MEASURED gate can see them; only the source can).

export interface PieceSpan {
  id: string;
  kind: string;
  scene: number;
  body: string;
}

const PIECE_OPEN_RX = /<Piece\s+id="([^"]+)"\s+kind="([^"]+)"[^>]*>/g;

/** Enumerate every `<Piece>`'s source body. Pieces are flat siblings (never
 *  nested), so each body runs to the next `</Piece>`. */
export const enumeratePieceSpans = (code: string): PieceSpan[] => {
  const out: PieceSpan[] = [];
  PIECE_OPEN_RX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PIECE_OPEN_RX.exec(code))) {
    const id = m[1];
    const bodyStart = m.index + m[0].length;
    const close = code.indexOf("</Piece>", bodyStart);
    out.push({
      id,
      kind: m[2],
      scene: Number(/^s(\d+)\./.exec(id)?.[1] ?? -1),
      body: close === -1 ? code.slice(bodyStart) : code.slice(bodyStart, close),
    });
  }
  return out;
};

/** Resolve a content path ("meta.0.value", "meta[0].value", "headline") against a
 *  scene's content bag → its string value, or undefined. */
export const resolveContentPath = (
  content: Record<string, unknown> | undefined,
  contentPath: string,
): string | undefined => {
  if (!content) return undefined;
  const parts = contentPath.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let cur: unknown = content;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return typeof cur === "string" ? cur : typeof cur === "number" ? String(cur) : undefined;
};

// ─── arm 3: cross-piece stat dedup + numeric-format consistency ───────────────
//
// cycle-9 Falabella-predecessor defect (Tailscale s4, no gate caught it): the
// hero painted the headline stat as an animated CSS counter (→ "30000") while the
// copy column ALSO painted it (c.meta[0].value → "30,000"). Same stat, two pieces,
// with a thousands-separator format drift. The counter is a `::after` pseudo-
// element and the copy value is a binding — neither is a stable DOM text node the
// measured gates read. So this reads it off the assembled source instead.

export interface StatDupFinding {
  scene: number;
  /** Normalized digit sequence shared across the occurrences ("30000"). */
  digits: string;
  /** Distinct display forms seen for it ("30,000", "30000"). */
  forms: string[];
  /** Distinct non-chrome pieces painting it (may be 1 for a within-piece drift). */
  pieces: string[];
  /** True when ≥2 distinct pieces paint the same stat (restated across pieces). */
  duplicated: boolean;
  /** True when the same digits render in ≥2 formats ("30,000" vs "30000"). */
  formatDrift: boolean;
  /** The piece to KEEP (a `.hero` owns a hero stat; else the first). */
  primaryPiece: string;
  /** The pieces whose restatement should be removed / regenerated. */
  redundantPieces: string[];
  pieceId: string;
  detail: string;
  repairInstruction: string;
}

const STAT_MIN_PX = 48;
const digitsOf = (s: string): string => (s.match(/\d/g) ?? []).join("");
/** The largest digit-bearing run in a string ("30,000 businesses" → "30,000"). */
const numericCore = (s: string): string | null => {
  const runs = s.match(/\d[\d.,  ]*\d|\d/g);
  if (!runs) return null;
  return runs.sort((a, b) => digitsOf(b).length - digitsOf(a).length)[0].trim();
};

interface StatToken { form: string; digits: string; via: "aria" | "counter" | "text"; }

const extractPieceStats = (
  body: string,
  content: Record<string, unknown> | undefined,
): StatToken[] => {
  const out: StatToken[] = [];
  const seen = new Set<string>();
  const push = (raw: string | undefined | null, via: StatToken["via"]): void => {
    if (!raw) return;
    const core = numericCore(raw);
    if (!core) return;
    const d = digitsOf(core);
    if (d.length < 3) return; // a real stat, not a tier/page count/"1 of 3"
    const key = `${via}:${core}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ form: core, digits: d, via });
  };
  // aria-label carries the ACCESSIBLE stat value even when the visible glyphs are
  // a pseudo-element counter (the hero's `aria-label="30,000 businesses"`).
  for (const m of body.matchAll(/aria-label="([^"]*\d[^"]*)"/g)) push(m[1], "aria");
  // CSS counter targets + the final content keyframe (the raw, un-formatted render).
  for (const m of body.matchAll(/--[a-zA-Z][\w-]*:\s*(\d[\d,]*)\b/g)) push(m[1], "counter");
  for (const m of body.matchAll(/content:\s*"([\d][\d,.]*)"/g)) push(m[1], "counter");
  // Big display text (fontSize ≥ 48px): resolve the element's data-content-path
  // (cast always emits it), else an inline {c.…} binding, else a literal.
  for (const m of body.matchAll(/fontSize:\s*["'`]?(\d+)(?:\.\d+)?px/g)) {
    if (Number(m[1]) < STAT_MIN_PX) continue;
    const tagStart = body.lastIndexOf("<", m.index);
    const tagHead = tagStart === -1 ? "" : body.slice(tagStart, m.index);
    const dcp = /data-content-path="([^"]+)"/.exec(tagHead)?.[1];
    let resolved: string | undefined = dcp ? resolveContentPath(content, dcp) : undefined;
    if (!resolved) {
      const after = body.slice(m.index, m.index + 600);
      const bind = /\{c\.([\w.[\]'"]+?)\}/.exec(after)?.[1];
      if (bind) resolved = resolveContentPath(content, bind.replace(/['"]/g, ""));
    }
    if (!resolved) {
      const after = body.slice(m.index, m.index + 600);
      const gt = after.indexOf(">");
      if (gt !== -1) {
        const lit = /^\s*([$€£]?\s*[\d][\d.,  ]*[\d%+]?)\s*</.exec(after.slice(gt + 1));
        if (lit) resolved = lit[1];
      }
    }
    push(resolved, "text");
  }
  return out;
};

/** Cross-piece duplicate stat + numeric-format drift, per scene, off the
 *  assembled source. `scenes` supplies each scene's content bag for binding
 *  resolution. */
export const findCrossPieceStatDup = (
  code: string,
  scenes: { content?: Record<string, unknown> }[] | undefined,
): StatDupFinding[] => {
  const out: StatDupFinding[] = [];
  const spans = enumeratePieceSpans(code).filter((s) => s.kind !== "chrome" && s.scene >= 0);
  // (scene → digits → { pieces: Map<pieceId, forms Set>, forms Set })
  const byScene = new Map<number, Map<string, { pieces: Map<string, Set<string>>; forms: Set<string> }>>();
  for (const span of spans) {
    const content = scenes?.[span.scene]?.content;
    for (const t of extractPieceStats(span.body, content)) {
      let m = byScene.get(span.scene);
      if (!m) { m = new Map(); byScene.set(span.scene, m); }
      let g = m.get(t.digits);
      if (!g) { g = { pieces: new Map(), forms: new Set() }; m.set(t.digits, g); }
      g.forms.add(t.form);
      const fs = g.pieces.get(span.id) ?? new Set<string>();
      fs.add(t.form);
      g.pieces.set(span.id, fs);
    }
  }
  for (const [scene, groups] of byScene) {
    for (const [digits, g] of groups) {
      const pieces = [...g.pieces.keys()];
      const forms = [...g.forms];
      const duplicated = pieces.length >= 2;
      const formatDrift = forms.length >= 2;
      if (!duplicated && !formatDrift) continue;
      const primaryPiece = pieces.find((p) => /\.hero$/.test(p)) ?? pieces[0];
      const redundantPieces = pieces.filter((p) => p !== primaryPiece);
      const reasons: string[] = [];
      if (duplicated) reasons.push(`the same headline stat (${digits.length}-digit "${forms[0]}") is painted by ${pieces.length} different pieces [${pieces.join(", ")}]`);
      if (formatDrift) reasons.push(`it renders in ${forms.length} inconsistent formats [${forms.map((f) => `"${f}"`).join(", ")}] (thousands separators drift)`);
      out.push({
        scene,
        digits,
        forms,
        pieces,
        duplicated,
        formatDrift,
        primaryPiece,
        redundantPieces,
        pieceId: redundantPieces[0] ?? primaryPiece,
        detail: `scene ${scene}: ${reasons.join("; ")}. A hero stat belongs to ONE piece in ONE format.`,
        repairInstruction: duplicated
          ? `The stat "${forms[0]}" is the hero's (${primaryPiece}). In the redundant piece(s) [${redundantPieces.join(", ")}] REMOVE the restated big number and lead with different copy (a claim, benefit, or supporting line) — do NOT repaint the same figure. Wherever the figure legitimately appears, write it in ONE canonical format (choose the thousands-separated form "${forms.find((f) => /[.,  ]/.test(f)) ?? forms[0]}").`
          : `Render the stat in ONE canonical format everywhere (use "${forms.find((f) => /[.,  ]/.test(f)) ?? forms[0]}") — an animated counter and a static label of the SAME figure must agree on thousands separators.`,
      });
    }
  }
  return out.sort((a, b) => a.scene - b.scene);
};

// ─── arm 3b: garbled / duplicate brand-mark ──────────────────────────────────
//
// cycle-9 Tailscale s4 painted the brand wordmark TWICE off-chrome — a correct
// "tailscale" lockup in the hero AND a GARBLED hand-drawn SVG wordmark ("IY
// INELLIN") in the copy column — while BrandChrome already carries the sanctioned
// corner mark. The garble is SVG-path geometry (no text node), so the reliable
// signal is: >1 brand mark across a scene's non-chrome pieces (route the
// redundant one to removal). A text-node wordmark that is a NEAR-MISS of the
// brand name (a scrambled spelling) fires the garble arm directly.

export interface BrandMarkFinding {
  scene: number;
  kind: "duplicate-brand-mark" | "garbled-brand-mark";
  pieces: string[];
  pieceId: string;
  garbledText?: string;
  detail: string;
  repairInstruction: string;
}

const LOGO_MARK_RX = /data-content-path="[^"]*\blogo\b[^"]*"/gi;
const normWord = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
/** Common app/spreadsheet CHROME menu words. A diegetic mock (a spreadsheet, a
 *  dashboard) legitimately paints its menu bar — "File Edit View Data Insert
 *  Format" — and a short chrome word can land within an edit-distance hop of a
 *  5-letter brand ("Data" vs "Vanta", the Vanta s1 false positive). These are
 *  UI furniture, never a scrambled wordmark, so they can never be garble
 *  candidates. (The correct-brand and duplicate-mark arms are unaffected —
 *  those key off the logo mount, not text nodes.) */
const UI_CHROME_WORDS: ReadonlySet<string> = new Set([
  "file", "edit", "view", "data", "insert", "format", "help", "tools",
  "window", "sheet", "cell", "table", "select", "home", "share", "options",
  "settings", "menu", "print", "export", "import", "search",
]);
const editDistance = (a: string, b: string): number => {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
};

/** Brand-mark defects off the assembled source: >1 mark across a scene's
 *  non-chrome pieces (duplicate) and text-node wordmarks scrambled vs the known
 *  brand name (garbled). */
export const findBrandMarkDefects = (code: string, brandName: string): BrandMarkFinding[] => {
  const out: BrandMarkFinding[] = [];
  // The crawl title can be messy ("falabella.com⚡El Cyber de las Mejores Marcas"):
  // take the LEADING ALPHABETIC RUN of the first token so a domain suffix (.com),
  // emoji, or tagline never pollutes the brand word — otherwise the CORRECT
  // wordmark ("Falabella") reads as a near-miss of "falabellacom" and false-fires.
  const rawFirst = (brandName ?? "").trim().split(/\s+/)[0] ?? "";
  const cleanFirst = rawFirst.match(/[A-Za-z][A-Za-z'&-]*/)?.[0] ?? rawFirst;
  const brandWord = normWord(cleanFirst);
  const spans = enumeratePieceSpans(code).filter((s) => s.kind !== "chrome" && s.scene >= 0);
  const marksByScene = new Map<number, { pieceId: string }[]>();
  for (const span of spans) {
    // A brand MARK = an intended logo mount/lockup, keyed on the data-content-path
    // "logo" marker the cast assembler emits (the reliable signal; the s4 garbled
    // SVG wordmark AND the correct Img lockup both carry it). Diegetic brand
    // MENTIONS in a mock ("AVAILABLE AT Falabella" on a retail card) are NOT marks —
    // counting exact wordmark text nodes here would false-fire on retailers that
    // legitimately name themselves in-frame (Falabella build finding).
    const count = (span.body.match(LOGO_MARK_RX) || []).length;
    for (let i = 0; i < count; i++) {
      const arr = marksByScene.get(span.scene) ?? [];
      arr.push({ pieceId: span.id });
      marksByScene.set(span.scene, arr);
    }
    // garble: a short standalone text node that is a near-miss of the brand.
    if (brandWord.length >= 4) {
      for (const m of span.body.matchAll(/>\s*([^<>{}\n]{2,40})\s*</g)) {
        const cand = normWord(m[1]);
        if (cand.length < brandWord.length * 0.6 || cand.length > brandWord.length * 1.6) continue;
        if (UI_CHROME_WORDS.has(cand)) continue; // a mock's menu word, never a scrambled mark
        // A substring relationship is truncation/domain, not a scramble
        // ("falabella" vs "falabellacom"): never a garble.
        if (cand === brandWord || cand.includes(brandWord) || brandWord.includes(cand)) continue;
        const d = editDistance(cand, brandWord);
        if (d > 0 && d <= Math.max(1, Math.ceil(brandWord.length * 0.34))) {
          out.push({
            scene: span.scene,
            kind: "garbled-brand-mark",
            pieces: [span.id],
            pieceId: span.id,
            garbledText: m[1].trim(),
            detail: `scene ${span.scene}: piece ${span.id} paints a GARBLED brand mark "${m[1].trim()}" — a scrambled spelling of "${brandName}" (edit distance ${d}).`,
            repairInstruction: `Spell the brand name EXACTLY ("${brandName}") or drop the mark — the chrome already carries the sanctioned wordmark. Never emit a mis-spelled/scrambled wordmark.`,
          });
        }
      }
    }
  }
  for (const [scene, marks] of marksByScene) {
    if (marks.length < 2) continue;
    const pieces = [...new Set(marks.map((m) => m.pieceId))];
    const primary = pieces.find((p) => /\.hero$/.test(p)) ?? pieces[0];
    const redundant = pieces.filter((p) => p !== primary);
    const routed = redundant[0] ?? primary;
    out.push({
      scene,
      kind: "duplicate-brand-mark",
      pieces,
      pieceId: routed,
      detail: `scene ${scene}: ${marks.length} brand marks (logo lockups/wordmarks) across non-chrome pieces [${pieces.join(", ")}] — BrandChrome already carries the corner mark, so a scene shows its own lockup at most once (a second is redundant, and often the garbled one).`,
      repairInstruction: `Keep the single brand lockup on ${primary}; in ${redundant.join(", ")} REMOVE the extra logo/wordmark (a stat, headline, or supporting motif belongs there instead). If either mark is a hand-drawn SVG wordmark, prefer the real <Img> logo and delete the drawn one.`,
    });
  }
  return out.sort((a, b) => a.scene - b.scene || a.kind.localeCompare(b.kind));
};

// ─── arm 4 (cycle-10 P2): Spanish / accented-glyph coverage ──────────────────
//
// The accented analogue of the icon-font P0: when copy carries á/é/í/ó/ú/ñ/ü/¿/¡
// (a LATAM/Spanish brand like Falabella WILL) the resolved text stack must have a
// family that can render each diacritic, or the glyph silently drops to tofu.
// Browsers fall back PER GLYPH, so a stack is safe as long as SOME family covers
// the codepoint — a generic (system-ui/sans-serif) or a webface whose declared
// @font-face unicode-range includes it. A stack that terminates in only
// ASCII-range faces (or an icon font) with no covering family drops the glyph.
// The deterministic repair appends a Latin-1-safe generic (zero tokens), the
// analogue of stripIconFontsFromTextStacks.

export interface AccentedGlyphFinding {
  stack: string;
  primaryFamily: string;
  missingChars: string[];
  detail: string;
  repairInstruction: string;
}

const ACCENTED_RX =
  /[À-ÿĀ-ſ¿¡]/; // Latin-1 supplement + Latin Extended-A + ¿ ¡
const collectAccents = (text: string): string[] => {
  const set = new Set<string>();
  for (const ch of text) if (ACCENTED_RX.test(ch)) set.add(ch);
  return [...set];
};

/** Families that always cover Latin-1 supplement (accents). Generics + the
 *  common system/web text faces our stacks fall back to. */
const LATIN1_SAFE = new Set(
  [
    "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "sans-serif", "serif", "monospace",
    "inter", "roboto", "arial", "helvetica", "helvetica neue", "georgia", "times", "times new roman",
    "verdana", "tahoma", "segoe ui", "open sans", "lato", "montserrat", "noto sans", "noto serif",
    "geist", "geist mono", "sf mono", "sf pro", "menlo", "monaco", "courier", "courier new",
    "cabinet grotesk", "-apple-system", "blinkmacsystemfont",
  ].map((f) => f.toLowerCase()),
);

/** family → declared @font-face unicode-range (raw), for the faces in the code. */
const parseFontFaceRanges = (css: string): Map<string, string> => {
  const out = new Map<string, string>();
  for (const m of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const block = m[1];
    const fam = /font-family:\s*(['"]?)([^;'"]+)\1/.exec(block)?.[2]?.trim().toLowerCase();
    const range = /unicode-range:\s*([^;]+)/i.exec(block)?.[1]?.trim();
    if (fam) out.set(fam, range ?? "*");
  }
  return out;
};

/** True when a raw unicode-range value covers codepoint cp. "*" (undeclared) →
 *  assume covered (a full font; avoid false positives). */
const rangeCovers = (range: string, cp: number): boolean => {
  if (!range || range === "*") return true;
  for (const part of range.split(",")) {
    const t = part.trim().replace(/^u\+/i, "");
    if (!t) continue;
    if (t.includes("-")) {
      const [lo, hi] = t.split("-");
      const wildcard = hi.includes("?") || lo.includes("?");
      const loN = parseInt(lo.replace(/\?/g, "0"), 16);
      const hiN = parseInt(hi.replace(/\?/g, "f"), 16);
      if (!Number.isNaN(loN) && !Number.isNaN(hiN) && cp >= loN && cp <= hiN) return true;
      if (wildcard) { /* handled via ? replacement above */ }
    } else if (t.includes("?")) {
      const loN = parseInt(t.replace(/\?/g, "0"), 16);
      const hiN = parseInt(t.replace(/\?/g, "f"), 16);
      if (!Number.isNaN(loN) && cp >= loN && cp <= hiN) return true;
    } else {
      if (parseInt(t, 16) === cp) return true;
    }
  }
  return false;
};

const familyCovers = (family: string, cp: number, ranges: Map<string, string>): boolean => {
  const f = family.trim().toLowerCase();
  if (isIconFont(family)) return false; // no letterforms at all
  if (LATIN1_SAFE.has(f)) return true;
  if (ranges.has(f)) return rangeCovers(ranges.get(f)!, cp);
  return true; // an unknown full webface — assume covered (avoid FP)
};

/** Assess whether every TEXT stack can render the accented copy that will be
 *  painted. Returns a blocking finding per stack that drops a diacritic. */
export const assessAccentedGlyphCoverage = (args: {
  code: string;
  /** All copy that will render (join of the scene content bags). */
  copyText: string;
  /** Extra @font-face CSS not present in `code` (theme.fonts.fontFaceCss). */
  fontFaceCss?: string;
}): AccentedGlyphFinding[] => {
  const accents = collectAccents(args.copyText);
  if (accents.length === 0) return [];
  const ranges = parseFontFaceRanges(`${args.code}\n${args.fontFaceCss ?? ""}`);
  const out: AccentedGlyphFinding[] = [];
  TEXT_FONT_CONST_RX.lastIndex = 0;
  let m: RegExpExecArray | null;
  const seenStacks = new Set<string>();
  while ((m = TEXT_FONT_CONST_RX.exec(args.code))) {
    const stackValue = m[2].slice(1, -1);
    if (seenStacks.has(stackValue)) continue;
    seenStacks.add(stackValue);
    const fams = splitFamilies(stackValue);
    if (fams.length === 0) continue;
    const missing = accents.filter((ch) => {
      const cp = ch.codePointAt(0)!;
      return !fams.some((f) => familyCovers(f, cp, ranges));
    });
    if (missing.length > 0) {
      out.push({
        stack: m[1],
        primaryFamily: fams[0],
        missingChars: missing,
        detail: `${m[1]} ("${stackValue}") has NO family that covers the accented character(s) ${missing.map((c) => `"${c}"`).join(", ")} present in the copy — they render as tofu/blank, silently dropping diacritics.`,
        repairInstruction: `Append a Latin-1-safe generic (system-ui, sans-serif) to ${m[1]} so per-glyph fallback can render á/é/í/ó/ú/ñ/ü/¿/¡.`,
      });
    }
  }
  return out;
};

export interface Latin1FallbackResult {
  code: string;
  appended: { stack: string; added: string }[];
}

/** Deterministic repair: append a Latin-1-safe generic to any TEXT const stack
 *  that carries no covering family, so accented copy can never silently drop.
 *  Zero tokens (like stripIconFontsFromTextStacks). */
export const ensureLatin1Fallback = (code: string): Latin1FallbackResult => {
  const appended: { stack: string; added: string }[] = [];
  const out = code.replace(TEXT_FONT_CONST_RX, (whole, site: string, quoted: string) => {
    const value = quoted.slice(1, -1);
    const fams = splitFamilies(value);
    const hasSafe = fams.some((f) => LATIN1_SAFE.has(f.trim().toLowerCase()) && !isIconFont(f));
    if (hasSafe) return whole;
    const add = site === "FONT_MONO" ? "system-ui, monospace" : "system-ui, sans-serif";
    appended.push({ stack: site, added: add });
    return `const ${site} = ${JSON.stringify(`${value}, ${add}`)};`;
  });
  return { code: out, appended };
};
