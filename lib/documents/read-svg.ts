import { MAX_EXTRACTED_CHARS, decodeXmlEntities, tidy } from "./extract-text";

/**
 * Pull the readable words out of an attached .svg.
 *
 * WHY NO VISION CALL: an SVG is XML and its words are already in the file, in
 * <text>, <tspan>, <title> and <desc>. Rasterising it and paying a model to
 * read back characters that are sitting in the bytes would be a strange trade.
 * This costs no tokens and cannot fail slowly.
 *
 * WHY THIS IS NOT "strip the tags and keep whatever is left": both real SVGs in
 * this repo — app/icon.svg and public/orb.svg — contain ZERO text nodes. They
 * are pure vector marks. A naive utf8 read of either yields ~1000 characters of
 * <radialGradient>, <stop> and <circle>, and that is what would have landed in
 * the user's brief, with the model dutifully writing a deck about gradient
 * stops. The two commonest real-world SVGs behave the same way: an Illustrator
 * or Figma "convert to outlines" export has turned every letter into a <path>,
 * and a wrapper SVG whose only content is <image href="data:image/png;base64,…">
 * carries a megabyte of base64. So this reads ONLY the text-bearing elements,
 * and when there are none it says so instead of inventing something.
 */

export type SvgReadResult = { ok: true; text: string } | { ok: false; reason: string };

/**
 * Both refusals name the route that always works — pasting — before the one
 * that depends on another reader being wired up.
 */
const NOT_SVG =
  "That file doesn't look like an SVG. Paste the text into the brief, or attach a .txt, .md or .docx.";

const NO_TEXT =
  "There are no readable words in that SVG — the text was saved as outlines, or it's a mark with no words in it. Paste the text into the brief, or export it as a PNG and attach that instead.";

/** Elements whose character data is the document's actual words. */
const CAPTURE_ROOTS = new Set(["text", "title", "desc"]);

/** Elements whose character data is code, never prose. */
const SKIP_ELEMENTS = new Set(["style", "script"]);

/** `<svg:tspan>` and `<tspan>` are the same element. */
const localName = (raw: string): string => raw.replace(/^[^:]*:/, "").toLowerCase();

/**
 * The self-closing slash cannot be its own capture group: the attribute scan is
 * greedy and swallows it. Reading it back off the end of the attribute string
 * is also what keeps path data honest — `d="M0 0/"` ends in a slash INSIDE the
 * quotes and is not a self-closing tag.
 */
const TAG = /<(\/?)((?:[A-Za-z_][\w.\-]*:)?[A-Za-z_][\w.\-]*)((?:"[^"]*"|'[^']*'|[^"'>])*)>/g;

const attrOf = (attrs: string, name: string): string | null => {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(attrs);
  return m ? (m[1] ?? m[2]) : null;
};

/**
 * Does this <tspan> start a new visual line?
 *
 * THIS IS THE WHOLE TSPAN PROBLEM, and it cuts both ways.
 *
 * Figma and Illustrator break a heading across lines by emitting one <tspan>
 * per line inside a SINGLE <text>, with no whitespace between the tags:
 *   <text><tspan x="0" y="14">Q3 revenue</tspan><tspan x="0" y="34">up 42%</tspan></text>
 * Joining those with "\n" shreds one heading into a vertical stack — the
 * classic bug in every hand-rolled SVG reader — so they must land on one line.
 * But plain concatenation gives "Q3 revenueup 42%", a mangled word, so the line
 * break has to become a space.
 *
 * The same tools ALSO emit one <tspan> per CHARACTER when letter-spacing is
 * tracked by hand:
 *   <tspan x="0" y="20">R</tspan><tspan x="8.5" y="20">e</tspan>…
 * Putting a space at every tspan boundary turns "Renderball" into
 * "R e n d e r b a l l". So a blanket separator is just as wrong as a blanket
 * newline.
 *
 * The distinction is not a heuristic, it is how SVG works. Runs that share a
 * baseline are contiguous character data — splitting a string into runs never
 * deletes the spaces inside it, so the source whitespace is already correct and
 * nothing should be added. A run on a NEW baseline is a break with no character
 * representation at all; it exists only as geometry, so a separator has to be
 * synthesised. Hence: new y, or any non-zero dy, means a new line.
 */
const startsNewLine = (attrs: string, lastY: string | null): { brk: boolean; y: string | null } => {
  const dy = attrOf(attrs, "dy");
  const y = attrOf(attrs, "y");
  // dy is a RELATIVE shift, so two identical dy values are two successive line
  // advances — equality proves nothing here, only zero does.
  const shifted = dy !== null && parseFloat(dy) !== 0;
  return { brk: shifted || (y !== null && y !== lastY), y: y ?? lastY };
};

export const readSvg = (buf: Buffer): SvgReadResult => {
  // Illustrator writes a UTF-8 BOM. Escaped rather than pasted literally: a
  // zero-width character sitting inside a regex is invisible in every diff and
  // survives exactly until someone tidies the line.
  const xml = buf.toString("utf8").replace(/^\uFEFF/, "");

  // Sniff for a real root element. Without this a renamed PNG gets the "no
  // readable words" message, which sends the user off to make a PNG they are
  // already holding.
  if (!/<(?:[A-Za-z_][\w.\-]*:)?svg[\s/>]/i.test(xml)) return { ok: false, reason: NOT_SVG };

  const prepared = xml
    // Comments first: a commented-out <text> is not on the artboard, and a
    // comment may legally contain anything, including a stray "</style>".
    .replace(/<!--[\s\S]*?-->/g, " ")
    // A DOCTYPE's internal subset contains ">" characters that would otherwise
    // read as the end of a tag.
    .replace(/<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?[^>]*>/gi, " ")
    // CDATA is literal text. Re-escaping it lets the scan below walk over it as
    // content instead of mistaking "]]>" for the end of a tag.
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, inner: string) =>
      inner.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));

  const lines: string[] = [];
  let current = "";
  let depth = 0; // element depth inside the current capture root; 0 means outside
  let lastY: string | null = null;
  let skipping: string | null = null;
  let cursor = 0;
  let rootIsText = false;
  let drawnWords = false;

  const flush = () => {
    // Collapsing every whitespace run — newlines included — is what puts all the
    // descendants of one <text> onto one line, whether the file was minified or
    // pretty-printed with each tspan indented on its own source line.
    const line = decodeXmlEntities(current).replace(/\s+/g, " ").trim();
    if (line) {
      lines.push(line);
      // <title> and <desc> are metadata, and every export tool writes them
      // whether or not the artwork has words: "Created with Sketch.",
      // "Matplotlib v3.5.2, https://matplotlib.org/", "Layer 1". Measured here:
      // a real matplotlib chart exported with text converted to outlines is 18KB
      // of glyph paths with ZERO <text> nodes, and its only readable string is
      // that generator credit — which would have gone into the brief on its own
      // and had a deck written about matplotlib. So metadata counts as context
      // when the drawing genuinely has words, and never as proof that it does.
      // The alternative, a blocklist of known generator strings, is a closed
      // list that goes stale the day a tool changes its credit line.
      if (rootIsText) drawnWords = true;
    }
    current = "";
    lastY = null;
  };

  TAG.lastIndex = 0;
  for (let m = TAG.exec(prepared); m; m = TAG.exec(prepared)) {
    if (depth > 0 && !skipping) current += prepared.slice(cursor, m.index);
    cursor = TAG.lastIndex;

    const closing = m[1] === "/";
    const name = localName(m[2]);
    const attrs = m[3];
    const selfClosing = /\/\s*$/.test(attrs);

    if (skipping) {
      if (closing && name === skipping) skipping = null;
      continue;
    }

    // Skipping style and script BY ELEMENT, rather than deleting the blocks with
    // a regex beforehand, survives both an unclosed <style> and CSS that carries
    // a literal "</style>" inside a content: string.
    if (!closing && !selfClosing && SKIP_ELEMENTS.has(name)) {
      skipping = name;
      continue;
    }

    if (depth > 0) {
      if (closing) {
        depth--;
        if (depth === 0) flush();
      } else if (!selfClosing) {
        depth++;
        if (name === "tspan" || name === "textpath") {
          const { brk, y } = startsNewLine(attrs, lastY);
          if (brk && current && !/\s$/.test(current)) current += " ";
          lastY = y;
        }
      }
      continue;
    }

    if (!closing && !selfClosing && CAPTURE_ROOTS.has(name)) {
      depth = 1;
      rootIsText = name === "text";
    }
  }

  // An unclosed <text> at end of file still has words in it worth keeping.
  if (depth > 0 && !skipping) {
    current += prepared.slice(cursor);
    flush();
  }

  const text = tidy(lines.join("\n"));
  if (!drawnWords || !text) return { ok: false, reason: NO_TEXT };

  // WHY a cap: a labelled map or a CAD export carries tens of thousands of tiny
  // labels, and one attachment must not be able to fill the whole brief. The
  // .docx clamp cuts at a blank line because it is reading paragraphs; SVG text
  // is a list of labels, so the last line break is the honest boundary here.
  if (text.length > MAX_EXTRACTED_CHARS) {
    const cut = text.slice(0, MAX_EXTRACTED_CHARS);
    const at = cut.lastIndexOf("\n");
    return { ok: true, text: at > MAX_EXTRACTED_CHARS * 0.6 ? cut.slice(0, at) : cut };
  }
  return { ok: true, text };
};
