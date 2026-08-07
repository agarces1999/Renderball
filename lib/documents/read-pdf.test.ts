/**
 * PDF text extraction.
 *
 * Every fixture here is a REAL PDF, built with pdf-lib (already a dependency)
 * and parsed by the real pdfjs — no mocks. A PDF reader tested against a
 * hand-written fake proves nothing, because every bug in this file comes from
 * the gap between what a PDF *looks* like and how its bytes are actually
 * ordered.
 *
 * The two regressions that motivated the tests, both observed on a probe
 * document before they were fixed:
 *   1. A two-column page came out INTERLEAVED — "Left column line one RIGHT
 *      column line one Left column line two…" — because pdf.js emits runs in
 *      draw order, not reading order.
 *   2. Every single line became its own paragraph, because the first version
 *      derived a VERTICAL tolerance from average character WIDTH.
 */
import { PDFDocument, StandardFonts } from "pdf-lib";
import { readPdf } from "./read-pdf";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`);
  }
};
const assert = (c: boolean, m: string) => {
  if (!c) throw new Error(m);
};

console.log("pdf text extraction");

/** Build a real PDF from lines placed at explicit coordinates. */
const makePdf = async (
  pages: { text: string; x: number; y: number; size?: number }[][],
): Promise<Buffer> => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const items of pages) {
    const page = doc.addPage([595, 842]);
    for (const it of items) {
      page.drawText(it.text, { x: it.x, y: it.y, size: it.size ?? 12, font });
    }
  }
  return Buffer.from(await doc.save());
};

/** A single column of body text at a normal 18pt leading. */
const column = (lines: string[], x: number, top = 700) =>
  lines.map((text, i) => ({ text, x, y: top - i * 18 }));

await check("plain prose comes back readable, with words intact", async () => {
  const buf = await makePdf([
    column(["Finance teams spend enormous time", "moving numbers between systems."], 60),
  ]);
  const r = await readPdf(buf, "brief.pdf");
  assert(r.ok, `expected ok, got: ${r.reason}`);
  assert(r.text.includes("Finance teams spend enormous time"), `text missing: ${JSON.stringify(r.text)}`);
  // The kerning trap: pdf.js splits words at every kerning change, so a naive
  // space-on-any-gap turns "Finance" into "F i n a n c e".
  assert(!/\bF\s+i\s+n\s+a\s+n\s+c\s+e\b/.test(r.text), `word was shredded: ${JSON.stringify(r.text)}`);
});

await check("lines of one paragraph stay together; a real gap breaks it", async () => {
  const buf = await makePdf([
    [
      ...column(["First paragraph line one", "first paragraph line two"], 60, 700),
      // A clearly larger jump — a new paragraph.
      ...column(["Second paragraph begins here"], 60, 620),
    ],
  ]);
  const r = await readPdf(buf, "b.pdf");
  assert(r.ok, `expected ok: ${r.reason}`);
  assert(
    /line one\nfirst paragraph line two/.test(r.text),
    `a paragraph's own lines must not be split apart: ${JSON.stringify(r.text)}`,
  );
  assert(
    /\n\nSecond paragraph begins here/.test(r.text),
    `a real gap must become a paragraph break: ${JSON.stringify(r.text)}`,
  );
});

await check("a TWO-COLUMN page reads one column at a time, never interleaved", async () => {
  // This is the regression. Draw order alternates the columns on purpose,
  // exactly as a real two-column PDF's content stream does.
  const buf = await makePdf([
    [
      { text: "Left one", x: 60, y: 700 },
      { text: "Right one", x: 340, y: 700 },
      { text: "Left two", x: 60, y: 682 },
      { text: "Right two", x: 340, y: 682 },
      { text: "Left three", x: 60, y: 664 },
      { text: "Right three", x: 340, y: 664 },
    ],
  ]);
  const r = await readPdf(buf, "paper.pdf");
  assert(r.ok, `expected ok: ${r.reason}`);
  const t = r.text;
  assert(
    t.indexOf("Left three") < t.indexOf("Right one"),
    `the whole left column must precede the right: ${JSON.stringify(t)}`,
  );
  assert(
    !/Left one\s+Right one/.test(t),
    `columns were interleaved on one line: ${JSON.stringify(t)}`,
  );
});

await check("a CENTRED page is not mistaken for two columns", async () => {
  // A title page has a wide empty middle. Splitting it would reorder a title
  // above its own subtitle.
  const buf = await makePdf([
    [
      { text: "Fuse Finance", x: 210, y: 500, size: 28 },
      { text: "The close in four days", x: 200, y: 460, size: 14 },
    ],
  ]);
  const r = await readPdf(buf, "title.pdf");
  assert(r.ok, `expected ok: ${r.reason}`);
  assert(
    r.text.indexOf("Fuse Finance") < r.text.indexOf("The close in four days"),
    `reading order broke on a centred page: ${JSON.stringify(r.text)}`,
  );
});

await check("multiple pages are all read, in order", async () => {
  const buf = await makePdf([
    column(["Page one content"], 60),
    column(["Page two content"], 60),
    column(["Page three content"], 60),
  ]);
  const r = await readPdf(buf, "multi.pdf");
  assert(r.ok, `expected ok: ${r.reason}`);
  assert(r.pages === 3, `pages should be reported, got ${r.pages}`);
  assert(
    r.text.indexOf("Page one") < r.text.indexOf("Page two") &&
      r.text.indexOf("Page two") < r.text.indexOf("Page three"),
    `page order broke: ${JSON.stringify(r.text)}`,
  );
});

await check("a PDF with NO text layer is refused, and says it is probably a scan", async () => {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]); // drawn nothing
  const r = await readPdf(Buffer.from(await doc.save()), "scan.pdf");
  assert(!r.ok, "an empty PDF must not report success");
  assert(/scan/i.test(r.reason ?? ""), `name the likely cause: ${r.reason}`);
  assert(/PNG|JPEG|paste/i.test(r.reason ?? ""), `offer a route forward: ${r.reason}`);
});

await check("bytes that are not a PDF are refused", async () => {
  const r = await readPdf(Buffer.from("this is just text"), "notreally.pdf");
  assert(!r.ok, "must not claim success");
  assert(!!r.reason && !/undefined|null|Error/i.test(r.reason), `human reason required: ${r.reason}`);
});

await check("a TRUNCATED PDF fails cleanly instead of throwing", async () => {
  const full = await makePdf([column(["Some content here"], 60)]);
  const r = await readPdf(full.subarray(0, Math.floor(full.length / 3)), "cut.pdf");
  // Either it salvages text or it refuses — but it must never throw, and must
  // never surface a library error to a person.
  if (!r.ok) {
    assert(!!r.reason && !/undefined|Exception|stack/i.test(r.reason), `human reason: ${r.reason}`);
  }
});

await check("an empty buffer is refused", async () => {
  const r = await readPdf(Buffer.alloc(0), "empty.pdf");
  assert(!r.ok, "empty must not count as read");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
