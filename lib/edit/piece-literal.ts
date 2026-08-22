//
// Edit text that is a HARDCODED LITERAL in a piece body.
//
// Three kinds of text can appear in a generated scene, and until now only two of
// them were editable:
//
//   1. BOUND COPY      <h1 data-content-path="headline">{c.headline}</h1>
//                      → lives in script.scenes[K].content, edited via scene-content.ts
//   2. INSERTED BOX    <span data-rb-freetext="1">{"Your text"}</span>
//                      → a literal the USER added, edited via freetext.ts
//   3. LITERAL COPY    <div>Stay in the tool</div>          ← this module
//                      → text the MODEL wrote straight into the JSX, bound to nothing
//
// Measured 2026-08-22: 240 of 1,405 stored pieces (17%) contain visible text where
// NONE of it is editable — no data-content-path, no data-rb-freetext, no {c.*}. It is
// overwhelmingly diegetic copy: labels inside a mocked Linear window, a phone screen
// reading "Portfolio"/"Buy", card titles like "Instant search". Exactly the text a
// user wants to fix a typo or a brand name in. Clicking it produced "No editable text
// found in this piece", which was literally true and read as a bug.
//
// SAFETY. The DOM knows the rendered string; the source holds the literal. Mapping one
// to the other is the whole difficulty, and getting it wrong silently rewrites the
// wrong words. Three rules make it safe rather than clever:
//
//   * The caller only offers elements whose entire content is ONE text node, so the
//     clicked string is guaranteed to be one contiguous run in the source (see
//     collectEditableFields in ElementEditor.tsx). "Hello <b>world</b>" is never a
//     candidate — its textContent spans two source literals.
//   * The caller sends `occurrence` (which repeat of that exact string was clicked)
//     and `total` (how many the DOM shows). If the source does not contain exactly
//     `total` matches, the mapping is not trustworthy — a `.map()` over an array
//     renders N copies from ONE literal — so we refuse instead of guessing.
//   * Entities are decoded before comparing: the DOM reports "Stocks & Funds" where
//     the source says "Stocks &amp; Funds".
//
// Refusing is always safe here: the element simply stays uneditable, which is the
// behaviour that already shipped.
//

/**
 * Trim ASCII whitespace only, leaving U+00A0 (`&nbsp;`) in place.
 *
 * `String.trim()` strips the non-breaking space too, and that destroys information: a
 * mocked code pane indents its lines with `&nbsp;&nbsp;`, so trimming turns
 * "  screen: true," into "screen: true," and writing it back silently unindents the
 * sample. Found by the corpus sweep on a Loom deck's fake editor. The DOM reports the
 * same U+00A0 characters, so a caller trimming the same way still matches.
 */
export const asciiTrim = (s: string): string =>
  s.replace(/^[ \t\r\n\f\v]+/, "").replace(/[ \t\r\n\f\v]+$/, "");

/** JSX text-node entities we may meet in generated source, decoded for comparison. */
const decodeEntities = (s: string): string =>
  s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#12[35];/g, (m) => (m === "&#123;" ? "{" : "}"));

/**
 * Escape a plain string for use as JSX *text*. Only `<` and the braces are special
 * there — `&` renders literally and `>` is legal — but `&` is encoded anyway so a
 * round-trip through decodeEntities is stable.
 */
const encodeForJsxText = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/ /g, "&nbsp;") // preserve indentation in mocked code panes
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\{/g, "&#123;")
    .replace(/\}/g, "&#125;");

/** One candidate run of literal text between two JSX tags. */
interface LiteralSpan {
  /** Index into the body where the raw text run starts. */
  start: number;
  /** Index just past the raw text run. */
  end: number;
  /** The rendered form: entities decoded, outer whitespace trimmed. */
  text: string;
}

/**
 * Does the `>` at `i` close a tag, or is it an operator?
 *
 * `{c.bullets?.length > 0 && (` opens a run at a COMPARISON, and the fragment that
 * follows carries letters and no braces, so it survives every content-based filter —
 * it took the corpus sweep to surface it. The distinction is positional, not textual:
 * scan back from the `>` and see which delimiter comes first. A tag close always has
 * its own `<` behind it with no intervening `>`; an operator always has the previous
 * tag's `>` in the way.
 *
 * Errs toward saying no — `<div title="a>b">` reads as an operator and its text run is
 * skipped. That loses an edit on a vanishingly rare attribute; the opposite error
 * would let us rewrite code as if it were copy.
 */
const closesTag = (body: string, i: number): boolean => {
  for (let j = i - 1; j >= 0; j--) {
    const ch = body[j];
    if (ch === "<") return true;
    if (ch === ">") return false;
  }
  return false;
};

/**
 * Every run of static text between tags in a piece body, in source order.
 *
 * A run is what sits between a tag-closing `>` and the next `<`. Everything that is
 * not copy — expressions, code fragments sliced by a tag boundary, bare punctuation —
 * is filtered below, each rule earning its place from a real miss in the corpus.
 * Under-collecting costs an edit; over-collecting risks rewriting code as prose, so
 * every rule here is deliberately biased toward skipping.
 */
export const literalSpans = (body: string): LiteralSpan[] => {
  const out: LiteralSpan[] = [];
  const rx = />([^<>]*)</g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(body)) !== null) {
    if (!closesTag(body, m.index)) continue;
    const raw = m[1];
    // A BARE BRACE MEANS THIS IS NOT TEXT. JSX text cannot contain `{` or `}` — they
    // open an expression container — so a run holding one is a slice through code, not
    // copy. Whole expressions (`{c.headline}`) and fragments alike: a ternary spanning
    // tags leaves `{c.bullets?.length ? (` between one tag's `>` and the next tag's
    // `<`, which has letters and so survives every other filter. Caught by the corpus
    // sweep: patching those was stable in neither direction, because writing the text
    // back escapes the braces it sliced through. Tested on RAW, before decoding, so a
    // deliberately escaped brace in real copy (`&#123;`) is still editable.
    if (/[{}]/.test(raw)) continue;
    const text = asciiTrim(decodeEntities(raw));
    if (!text) continue;
    // Code punctuation swept up between an arrow function's `>` and the next tag —
    // `(`, `))}`, `=>`. Never user-visible copy, and leaving it in would inflate the
    // occurrence count that guards against ambiguous patches, turning a perfectly
    // editable literal into a refusal. Anything containing a letter or digit stays,
    // so "(beta)", "Q4 (est.)" and "Home > Docs" are unaffected.
    if (/^[()[\]{},;:=>|/\\\-+*.\s]+$/.test(text)) continue;
    // Where the trimmed text actually sits inside the raw run, so leading and
    // trailing whitespace (and the source's own indentation) survive the patch.
    const lead = raw.length - raw.replace(/^\s+/, "").length;
    const trail = raw.length - raw.replace(/\s+$/, "").length;
    const start = m.index + 1 + lead;
    out.push({ start, end: m.index + 1 + raw.length - trail, text });
    // The closing `<` of this run opens the next tag; step back so an adjacent
    // `</b><b>` pair does not swallow the following run.
    rx.lastIndex = m.index + 1 + raw.length;
  }
  return out;
};

/** How many static text runs in `body` render exactly as `text`. */
export const countLiteral = (body: string, text: string): number =>
  literalSpans(body).filter((s) => s.text === asciiTrim(text)).length;

export interface PatchLiteralInput {
  /** The rendered string the user clicked (DOM textContent, trimmed). */
  oldText: string;
  /** Replacement text, as the user typed it. */
  newText: string;
  /** 0-based index of the clicked element among same-text elements in the piece DOM. */
  occurrence: number;
  /** How many same-text elements the DOM shows. Guards loop-rendered repeats. */
  total: number;
}

export type PatchLiteralResult =
  | { ok: true; body: string }
  | { ok: false; reason: "not-found" | "ambiguous" | "empty" };

/**
 * Replace one literal in a piece body.
 *
 * `ambiguous` means the source and the DOM disagree about how many copies of this
 * string exist — the classic cause being `{items.map(...)}` rendering N elements from
 * a single literal, where patching would silently rewrite all of them. The caller
 * should leave the element uneditable and say so, never guess.
 */
export const patchLiteral = (body: string, input: PatchLiteralInput): PatchLiteralResult => {
  const oldText = asciiTrim(input.oldText);
  const newText = asciiTrim(input.newText);
  if (!oldText || !newText) return { ok: false, reason: "empty" };

  const hits = literalSpans(body).filter((s) => s.text === oldText);
  if (hits.length === 0) return { ok: false, reason: "not-found" };
  // The DOM's count is the authority on how many the user can see. A mismatch means
  // one literal is producing several elements (or vice versa) and no index is sound.
  if (hits.length !== input.total) return { ok: false, reason: "ambiguous" };
  const hit = hits[input.occurrence];
  if (!hit) return { ok: false, reason: "not-found" };

  return {
    ok: true,
    body: body.slice(0, hit.start) + encodeForJsxText(newText) + body.slice(hit.end),
  };
};
