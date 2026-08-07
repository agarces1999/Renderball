/**
 * Read the text out of an attached PDF.
 *
 * WHY A DEPENDENCY HERE AND NOWHERE ELSE: .docx, .xlsx and .svg are XML in a
 * zip, so those readers are ~60 lines of code that already existed. A PDF
 * stores text as positioned glyph runs with embedded font tables — there are no
 * paragraphs, no reading order, and often no spaces. Reconstructing sentences
 * from that is a real library's job and hand-rolling it produces exactly the
 * mojibake this file exists to prevent.
 *
 * WHY pdfjs-dist@5 SPECIFICALLY (measured, not chosen by reputation):
 *   - 5.x declares `node: >=20`; 6.x declares `>=22.13`. We run node:20-bookworm
 *     in Docker and node 20 in CI, so 6.x would have meant bumping the base
 *     image and CI on a working deploy to add an attachment format. Not a trade
 *     worth making.
 *   - Text extraction needs NO canvas: the legacy build extracts fine with no
 *     @napi-rs/canvas and no DOM shim. Canvas is only required for RENDERING
 *     pages to images, which we never do.
 *
 * SAFETY POSTURE: this parses bytes from strangers. `isEvalSupported: false`
 * disables pdf.js's expression compiler, and the whole thing is bounded — page
 * count, characters, and a wall-clock deadline — so a crafted file cannot pin a
 * request open. Nothing is written to disk and no network fetch is made
 * (`disableFontFace`, no external font URLs).
 */
import { MAX_EXTRACTED_CHARS } from "./extract-text";

export interface PdfResult {
  ok: boolean;
  text: string;
  /** Shown to the user verbatim when ok is false. Never a raw error. */
  reason?: string;
  pages?: number;
}

/** Past this, a "brief" is a book and we are only wasting the user's tokens. */
const MAX_PAGES = 100;
/** A crafted PDF can be slow to parse; a request must not hang on one. */
const DEADLINE_MS = 25_000;

/** One text run as pdf.js reports it, reduced to what reading order needs. */
interface Run {
  str: string;
  x: number;
  y: number;
  /** Rendered width, used to tell a real gap from a kerning nudge. */
  w: number;
  /**
   * Glyph height. Load-bearing: the first version of this derived a VERTICAL
   * tolerance from average character WIDTH, which is a different quantity
   * entirely — on the probe PDF it made every single line its own paragraph.
   * Vertical questions get answered with vertical measurements.
   */
  h: number;
}

/**
 * Rebuild reading order from geometry.
 *
 * MEASURED FAILURE THIS FIXES: pdf.js emits runs in the order the PDF's content
 * stream draws them, which for a two-column page means it can alternate columns.
 * A probe PDF with "Left column line one / RIGHT column line one" on one visual
 * row came back as "Left column line one   RIGHT column line one Left column
 * line two   RIGHT column line two" — the columns shredded together into
 * nonsense. Joining raw items is the naive implementation and it is wrong on
 * exactly the documents people attach: papers, reports, one-pagers.
 *
 * So: group runs into visual lines by y, detect whether the page splits into
 * columns by looking for a vertical corridor no run crosses, and read each
 * column top-to-bottom before moving right.
 */
const layoutPage = (runs: Run[], pageWidth: number): string => {
  const meaningful = runs.filter((r) => r.str.trim().length > 0);
  if (meaningful.length === 0) return "";

  const quantileOf = (xs: number[], q: number, fallback: number): number => {
    const sorted = xs.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
    if (!sorted.length) return fallback;
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  };
  const medianOf = (xs: number[], fallback: number): number => quantileOf(xs, 0.5, fallback);
  /** Typical glyph height on this page — the unit for every vertical decision. */
  const lineSize = medianOf(meaningful.map((r) => r.h), 10);

  // A column boundary is a vertical corridor that NO run crosses. Only look
  // near the middle: gutters at the page edges are margins, not columns.
  const split = (() => {
    const from = pageWidth * 0.3;
    const to = pageWidth * 0.7;
    const STEP = Math.max(2, pageWidth / 200);
    let best: { at: number; width: number } | null = null;
    let corridorStart: number | null = null;
    for (let x = from; x <= to; x += STEP) {
      const crossed = meaningful.some((r) => r.x < x && r.x + r.w > x);
      if (!crossed) {
        if (corridorStart === null) corridorStart = x;
        continue;
      }
      if (corridorStart !== null) {
        const width = x - corridorStart;
        if (!best || width > best.width) best = { at: corridorStart + width / 2, width };
        corridorStart = null;
      }
    }
    if (corridorStart !== null) {
      const width = to - corridorStart;
      if (!best || width > best.width) best = { at: corridorStart + width / 2, width };
    }
    if (!best || best.width < pageWidth * 0.04) return null;
    // A corridor is only a COLUMN BREAK if both sides carry real text. A
    // centred title page has a wide empty middle and must never be split —
    // though in practice centred text also crosses the middle, so this is the
    // second line of defence rather than the first.
    const at = best.at;
    const left = meaningful.filter((r) => r.x + r.w <= at).length;
    const right = meaningful.filter((r) => r.x >= at).length;
    const minSide = Math.max(2, meaningful.length * 0.2);
    return left >= minSide && right >= minSide ? at : null;
  })();

  const columns: Run[][] = split === null
    ? [meaningful]
    : [meaningful.filter((r) => r.x < split), meaningful.filter((r) => r.x >= split)];

  const out: string[] = [];
  for (const col of columns) {
    if (col.length === 0) continue;

    // Group into visual lines: same baseline within half a glyph height.
    const byY = col.slice().sort((a, b) => b.y - a.y || a.x - b.x);
    const lines: Run[][] = [];
    for (const run of byY) {
      const line = lines[lines.length - 1];
      if (line && Math.abs(line[0].y - run.y) <= lineSize * 0.5) line.push(run);
      else lines.push([run]);
    }

    // A paragraph break is a gap noticeably larger than this page's OWN line
    // spacing, so measure the spacing rather than guessing it. Deriving it from
    // font size alone breaks on double-spaced documents.
    // A LOW quantile, not the median. Paragraph gaps are the outliers we are
    // trying to find, so they must not set the baseline they are measured
    // against — with only two gaps the median simply IS the paragraph gap, and
    // the break then never fires. The 40th percentile stays on ordinary line
    // spacing whether the page has three lines or three hundred.
    const gaps: number[] = [];
    for (let i = 1; i < lines.length; i++) gaps.push(lines[i - 1][0].y - lines[i][0].y);
    const lineGap = quantileOf(gaps, 0.4, lineSize * 1.2);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      line.sort((a, b) => a.x - b.x);
      const charWidth = medianOf(
        line.map((r) => (r.str.length ? r.w / r.str.length : 0)),
        lineSize * 0.5,
      );
      let text = "";
      for (let k = 0; k < line.length; k++) {
        const run = line[k];
        if (k > 0) {
          const prev = line[k - 1];
          const gap = run.x - (prev.x + prev.w);
          // pdf.js splits a word at every kerning change, so most gaps are
          // ~zero and must NOT become spaces, or "Finance" arrives as
          // "F i n a n c e". Only a gap wide enough to be a real space counts.
          if (gap > charWidth * 0.5 && !/\s$/.test(text)) text += " ";
        }
        text += run.str;
      }
      const trimmed = text.replace(/\s+/g, " ").trim();
      if (!trimmed) continue;
      const gapAbove = i > 0 ? lines[i - 1][0].y - line[0].y : 0;
      out.push(i > 0 && gapAbove > lineGap * 1.6 ? `\n${trimmed}` : trimmed);
    }
    // Columns are separate reading flows; do not run them together.
    out.push("");
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
};

/**
 * @param filename used only for the failure message; never trusted as a path.
 */
export const readPdf = async (buf: Buffer, _filename = "document.pdf"): Promise<PdfResult> => {
  if (!(buf.length > 4 && buf.subarray(0, 5).toString("latin1") === "%PDF-")) {
    return { ok: false, text: "", reason: "That file isn't a PDF, whatever it's named." };
  }

  const started = Date.now();
  // Imported lazily so the 35MB library is not loaded by every route that
  // happens to touch this module.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(buf),
      // isEvalSupported is honoured at runtime but missing from pdfjs 5's
      // DocumentInitParameters type. It is the single most important flag here
      // — it disables the expression compiler on bytes from strangers — so it
      // stays, with the cast narrowed to this object.
      isEvalSupported: false,
      disableFontFace: true, // never fetch a font over the network
      useSystemFonts: false,
      // pdf.js logs a warning per document otherwise; those are for us.
      verbosity: 0,
    } as unknown as Parameters<typeof pdfjs.getDocument>[0]).promise;
  } catch (err) {
    const name = (err as { name?: string })?.name ?? "";
    if (name === "PasswordException") {
      return {
        ok: false,
        text: "",
        reason: "That PDF is password-protected. Open it, remove the password or copy the text out, and try again.",
      };
    }
    return {
      ok: false,
      text: "",
      reason: "That PDF couldn't be opened — it may be damaged. Copying the text into the brief always works.",
    };
  }

  const pages = Math.min(doc.numPages, MAX_PAGES);
  const chunks: string[] = [];
  let chars = 0;

  try {
    for (let n = 1; n <= pages; n++) {
      if (Date.now() - started > DEADLINE_MS) break;
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const runs: Run[] = [];
      for (const item of content.items as {
        str?: string;
        transform?: number[];
        width?: number;
        height?: number;
      }[]) {
        if (typeof item.str !== "string" || !item.transform) continue;
        runs.push({
          str: item.str,
          x: item.transform[4],
          y: item.transform[5],
          w: typeof item.width === "number" ? item.width : 0,
          // transform[3] is the vertical scale — the reliable fallback when
          // pdf.js reports height 0, which it does for some embedded fonts.
          h: item.height && item.height > 0 ? item.height : Math.abs(item.transform[3]) || 10,
        });
      }
      const width = page.view?.[2] ?? 612;
      const text = layoutPage(runs, width);
      // Clean up eagerly: a 100-page document otherwise holds every page's
      // operator list alive at once.
      page.cleanup();
      if (!text) continue;
      chunks.push(text);
      chars += text.length;
      if (chars > MAX_EXTRACTED_CHARS) break;
    }
  } finally {
    await doc.destroy().catch(() => {});
  }

  const joined = chunks.join("\n\n").trim();
  if (!joined) {
    return {
      ok: false,
      text: "",
      // The overwhelmingly common cause, and the one with a real way forward:
      // a scan is an image of a page, so it has no text layer to read.
      reason:
        "There's no readable text in that PDF — it's most likely a scan. Attach a PNG or JPEG of it instead and we'll read the image, or paste the text into the brief.",
    };
  }

  return { ok: true, text: joined, pages: doc.numPages };
};
