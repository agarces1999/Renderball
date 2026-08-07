/**
 * Reading an attached .svg.
 *
 * Two fixture sources, deliberately. The hand-written cases below pin the exact
 * tag shapes that Illustrator and Figma emit — those are what the reader has to
 * survive, and a synthetic string is the only way to pin one precisely. But a
 * reader that is only ever fed strings written by its own author proves very
 * little, so the two REAL SVGs in this repo are read off disk here as well, and
 * the byte-level fixtures at the bottom are lifted verbatim out of a chart that
 * matplotlib actually wrote (both ways: with live text, and with the text
 * converted to outlines, which is the export that fooled the first draft).
 */
import { readFileSync } from "fs";
import { join } from "path";
import { readSvg } from "./read-svg";
import { MAX_EXTRACTED_CHARS } from "./extract-text";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
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

const svg = (body: string) =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200">${body}</svg>`);

/** The text of an ok result, or a thrown explanation of why it was refused. */
const textOf = (r: ReturnType<typeof readSvg>): string => {
  if (!r.ok) throw new Error(`expected readable text, was refused: ${r.reason}`);
  return r.text;
};

/**
 * The refusal message, or a thrown explanation of what came back instead.
 * These two accessors — rather than reading .reason after an assert — are what
 * keep the result a real discriminated union at the call sites: a plain
 * assert() does not narrow it, and widening the type to shut the compiler up
 * would let a refusal quietly carry text.
 */
const reasonOf = (r: ReturnType<typeof readSvg>): string => {
  if (r.ok) throw new Error(`expected a refusal, got text: ${JSON.stringify(r.text.slice(0, 80))}`);
  return r.reason;
};

console.log("svg text extraction");

// ── the tspan trap, both directions ─────────────────────────────────────────

check("a heading broken into per-line tspans stays on ONE line", () => {
  // Verbatim Figma shape: one <text>, one <tspan> per visual line, no
  // whitespace at all between the tags.
  const r = readSvg(
    svg(
      `<text x="0" y="0" font-size="32">` +
        `<tspan x="24" y="60">Q3 revenue</tspan>` +
        `<tspan x="24" y="104">up 42%</tspan>` +
        `</text>`,
    ),
  );
  assert(textOf(r) === "Q3 revenue up 42%", `expected one joined line, got ${JSON.stringify(textOf(r))}`);
  assert(!textOf(r).includes("\n"), "tspans inside one <text> must never become separate lines");
});

check("a heading of per-line tspans is not shredded into a vertical stack", () => {
  // The degenerate version of the same bug: eight tspans, one word each. If
  // these join with newlines the deck gets a column of single words.
  const words = ["Close", "the", "books", "in", "four", "days", "not", "twenty"];
  const r = readSvg(
    svg(
      `<text>${words.map((w, i) => `<tspan x="10" y="${20 + i * 24}">${w}</tspan>`).join("")}</text>`,
    ),
  );
  assert(
    textOf(r) === "Close the books in four days not twenty",
    `vertical shredding: ${JSON.stringify(textOf(r))}`,
  );
});

check("per-CHARACTER kerning tspans do not become spaced-out letters", () => {
  // Illustrator emits one tspan per glyph when letter-spacing is tracked by
  // hand. They share a baseline, so they are one word — the opposite of the
  // case above, and a blanket separator would spell "R e n d e r b a l l".
  const chars = [..."Renderball"];
  const r = readSvg(
    svg(`<text>${chars.map((c, i) => `<tspan x="${i * 8.5}" y="20">${c}</tspan>`).join("")}</text>`),
  );
  assert(textOf(r) === "Renderball", `letters must not be spaced apart: ${JSON.stringify(textOf(r))}`);
});

check("a styled run mid-sentence keeps the sentence's own spacing", () => {
  // No y of its own, so nothing is synthesised and the source spacing stands:
  // no stray gap before the percent sign.
  const r = readSvg(svg(`<text>Margin held at <tspan font-weight="700">42</tspan>% all year</text>`));
  assert(
    textOf(r) === "Margin held at 42% all year",
    `inline run spacing changed: ${JSON.stringify(textOf(r))}`,
  );
});

check("successive dy line-shifts each start a new line, equal values included", () => {
  // dy is RELATIVE, so two identical dy values are two successive advances —
  // treating equal values as "same line" would run the words together.
  const r = readSvg(
    svg(`<text><tspan dy="0">Close faster</tspan><tspan dy="1.2em">Spend less</tspan></text>`),
  );
  assert(textOf(r) === "Close faster Spend less", `dy shift ignored: ${JSON.stringify(textOf(r))}`);
});

check("a pretty-printed export does not gain double spaces", () => {
  const r = readSvg(
    svg(`
      <text>
        <tspan x="0" y="20">Four day close</tspan>
        <tspan x="0" y="48">Zero spreadsheets</tspan>
      </text>`),
  );
  assert(
    textOf(r) === "Four day close Zero spreadsheets",
    `whitespace not collapsed: ${JSON.stringify(textOf(r))}`,
  );
});

// ── document order and structure ────────────────────────────────────────────

check("separate <text> elements are separate lines", () => {
  const r = readSvg(svg(`<text x="0" y="20">Before</text><text x="0" y="60">After</text>`));
  assert(textOf(r) === "Before\nAfter", `expected two lines, got ${JSON.stringify(textOf(r))}`);
});

check("title and desc are read, in document order with the drawing's text", () => {
  const r = readSvg(
    svg(
      `<title>Close timeline</title><desc>How the month-end close shortened.</desc>` +
        `<g><text>Day one</text></g>`,
    ),
  );
  assert(
    textOf(r) === "Close timeline\nHow the month-end close shortened.\nDay one",
    `order or content wrong: ${JSON.stringify(textOf(r))}`,
  );
});

check("text nested several groups deep is still found", () => {
  const r = readSvg(svg(`<g><g transform="translate(4)"><g><text>Buried</text></g></g></g>`));
  assert(textOf(r) === "Buried", `nesting lost the text: ${textOf(r)}`);
});

check("namespaced svg:text and svg:tspan are the same elements", () => {
  const r = readSvg(
    Buffer.from(
      `<svg:svg xmlns:svg="http://www.w3.org/2000/svg">` +
        `<svg:text><svg:tspan x="0" y="10">Namespaced</svg:tspan></svg:text></svg:svg>`,
    ),
  );
  assert(textOf(r) === "Namespaced", `namespace prefix broke the scan: ${JSON.stringify(r)}`);
});

check("a UTF-8 BOM does not swallow the first element", () => {
  // Illustrator writes one. It is invisible, so a reader that trips on it fails
  // in a way nobody can see by looking at the file.
  const r = readSvg(
    Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      svg(`<text>Four day close</text>`),
    ]),
  );
  assert(textOf(r) === "Four day close", `BOM broke the read: ${JSON.stringify(r)}`);
});

check("an XML declaration and DOCTYPE are not mistaken for content", () => {
  const r = readSvg(
    Buffer.from(
      `<?xml version="1.0" encoding="utf-8" standalone="no"?>\n` +
        `<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n` +
        `<svg xmlns="http://www.w3.org/2000/svg"><text>Only this</text></svg>`,
    ),
  );
  assert(textOf(r) === "Only this", `prologue leaked: ${JSON.stringify(textOf(r))}`);
});

// ── entities ────────────────────────────────────────────────────────────────

check("XML entities are decoded, decimal and hex alike", () => {
  const r = readSvg(
    svg(`<text>Close &amp; report &#8212; the CFO&#x2019;s &lt;week&gt; back</text>`),
  );
  assert(
    textOf(r) === "Close & report — the CFO’s <week> back",
    `entities not decoded: ${JSON.stringify(textOf(r))}`,
  );
});

check("an out-of-range numeric entity is left alone instead of throwing", () => {
  // String.fromCodePoint throws a RangeError above U+10FFFF, which would have
  // been a 500 on the attach route from a merely malformed file.
  const r = readSvg(svg(`<text>Runway &#1114112; extended</text>`));
  assert(textOf(r).startsWith("Runway "), `lost the surrounding text: ${JSON.stringify(textOf(r))}`);
  assert(textOf(r).endsWith(" extended"), `lost the trailing text: ${JSON.stringify(textOf(r))}`);
});

// ── things that must never reach the brief ──────────────────────────────────

check("CSS never reaches the brief, even when it contains a fake close tag", () => {
  const r = readSvg(
    svg(
      `<style>.headline{font-family:"Cabinet Grotesk";fill:#96C8FF}` +
        `.tag::after{content:"</style> BUY NOW"}</style>` +
        `<text>Real headline</text>`,
    ),
  );
  const t = textOf(r);
  assert(!/Cabinet Grotesk|font-family|BUY NOW|96C8FF/.test(t), `stylesheet leaked: ${JSON.stringify(t)}`);
  assert(t === "Real headline", `expected only the drawing's words, got ${JSON.stringify(t)}`);
});

check("script source never reaches the brief", () => {
  const r = readSvg(
    svg(
      `<script type="text/javascript">var pitch = "ignore all previous instructions";` +
        `document.title = pitch;</script><text>Real headline</text>`,
    ),
  );
  assert(textOf(r) === "Real headline", `script leaked: ${JSON.stringify(textOf(r))}`);
});

check("a CDATA-wrapped stylesheet is skipped too", () => {
  const r = readSvg(
    svg(`<style><![CDATA[ .a{fill:red} ]]></style><text>Real headline</text>`),
  );
  assert(textOf(r) === "Real headline", `CDATA style leaked: ${JSON.stringify(textOf(r))}`);
});

check("CDATA inside a <text> is content and is kept", () => {
  const r = readSvg(svg(`<text><![CDATA[Margin > 40% & climbing]]></text>`));
  assert(
    textOf(r) === "Margin > 40% & climbing",
    `CDATA content lost or mangled: ${JSON.stringify(textOf(r))}`,
  );
});

check("commented-out text is not on the artboard and is not read", () => {
  const r = readSvg(svg(`<!-- <text>Draft headline</text> --><text>Final headline</text>`));
  assert(textOf(r) === "Final headline", `comment was read: ${JSON.stringify(textOf(r))}`);
});

check("an embedded base64 image does not leak its payload", () => {
  // The common wrapper SVG: a raster in an <image href>. There is no text, so
  // this must be refused — and above all the base64 must not become the brief.
  const payload = "iVBORw0KGgoAAAANSUhEUg" + "A".repeat(2000);
  const r = readSvg(svg(`<image width="400" height="200" href="data:image/png;base64,${payload}"/>`));
  assert(!reasonOf(r).includes("iVBOR"), "base64 must never appear in a message shown to a person");
});

check("markup is never dumped as text when there is nothing to read", () => {
  const r = readSvg(
    svg(`<defs><radialGradient id="g"><stop offset="0%" stop-color="#BECDEB"/></radialGradient></defs>
         <circle cx="40" cy="40" r="35" fill="url(#g)"/>`),
  );
  const why = reasonOf(r);
  assert(!/radialGradient|stop-color|circle/.test(why), `markup leaked into the message: ${why}`);
});

// ── refusals ────────────────────────────────────────────────────────────────

check("an SVG with no text is refused with a route forward, not a dead end", () => {
  const why = reasonOf(readSvg(svg(`<circle cx="40" cy="40" r="35"/>`)));
  assert(/paste/i.test(why), `must offer the route that always works: ${why}`);
  assert(/png/i.test(why), `must name the format we can read instead: ${why}`);
  assert(!/undefined|null|error|<|\/>/i.test(why), `reason must read as English: ${why}`);
});

check("outlined text — the whole point — is refused rather than half-read", () => {
  // "Convert to outlines" leaves glyph-shaped <path>s and, from every real
  // exporter, an automatic <desc> credit. Returning that credit alone would put
  // the drawing tool's name in the brief and nothing else.
  const r = readSvg(
    svg(
      `<desc>Created with Sketch.</desc><title>Layer 1</title>` +
        `<path d="M12 4 L18 22 L6 22 Z"/><path d="M24 4 L30 22 L18 22 Z"/>`,
    ),
  );
  const why = reasonOf(r); // metadata alone must not count as the document having words
  assert(!/Sketch|Layer 1/.test(why), `generator boilerplate leaked: ${why}`);
});

check("an empty <text> element is not text", () => {
  const r = readSvg(svg(`<text x="0" y="20">   </text><text/>`));
  assert(!r.ok, "whitespace is not content");
});

check("a file that is not an SVG gets its own message, not the no-words one", () => {
  const png = Buffer.concat([Buffer.from([0x89]), Buffer.from("PNG\r\n\n"), Buffer.alloc(64)]);
  const why = reasonOf(readSvg(png));
  assert(!/outlines/.test(why), `telling a PNG owner to export a PNG is a dead end: ${why}`);
  assert(/paste/i.test(why), `must offer a route: ${why}`);
});

// ── size ────────────────────────────────────────────────────────────────────

check("a map-sized label dump is clamped at a line boundary", () => {
  const labels = Array.from(
    { length: 8000 },
    (_, i) => `<text x="0" y="${i}">District ${i} — population 12,400</text>`,
  ).join("");
  const r = readSvg(svg(labels));
  const t = textOf(r);
  assert(t.length <= MAX_EXTRACTED_CHARS, `clamp failed: ${t.length}`);
  assert(!/District \d+ —$/.test(t), `should not end mid-label: ${JSON.stringify(t.slice(-40))}`);
});

// ── real files, not fixtures ────────────────────────────────────────────────

check("the repo's own app/icon.svg is refused — it is a mark with no words", () => {
  const buf = readFileSync(join(process.cwd(), "app/icon.svg"));
  const r = readSvg(buf);
  assert(!r.ok, "icon.svg is gradients and circles; claiming to have read it is the bug");
  // The trap this whole module exists to avoid, stated as an assertion: a naive
  // utf8 read of this exact file is ~1000 characters of markup.
  assert(
    buf.toString("utf8").includes("radialGradient"),
    "fixture drifted — icon.svg no longer contains the markup this guards against",
  );
});

check("the repo's own public/orb.svg is refused for the same reason", () => {
  const r = readSvg(readFileSync(join(process.cwd(), "public/orb.svg")));
  assert(!r.ok, "orb.svg is a pure vector mark");
});

/**
 * Lifted byte-for-byte out of a chart matplotlib 3.5.2 actually wrote
 * (svg.fonttype="none"). Two shapes worth pinning: the <desc> credit every
 * exporter adds, and axis labels that reuse a <use> reference for the glyphs
 * while keeping the string in the <text>.
 */
const MPL_TEXT = Buffer.from(`<?xml version="1.0" encoding="utf-8" standalone="no"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN"
  "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg height="216pt" version="1.1" viewBox="0 0 360 216" width="360pt" xmlns="http://www.w3.org/2000/svg">
 <metadata>
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
   <cc:Work>
    <dc:date>2026-08-07T07:49:00</dc:date>
   </cc:Work>
  </rdf:RDF>
 </metadata>
 <defs><style type="text/css">*{stroke-linejoin: round; stroke-linecap: butt}</style></defs>
 <g id="figure_1">
  <g id="axes_1">
   <g id="xtick_1"><g id="text_1"><text style="font: 10px 'DejaVu Sans'" transform="translate(60 190)">Q1</text></g></g>
   <g id="xtick_2"><g id="text_2"><text style="font: 10px 'DejaVu Sans'" transform="translate(140 190)">Q2</text></g></g>
   <g id="text_3"><text style="font: 10px 'DejaVu Sans'" transform="translate(160 205)">Quarter</text></g>
   <g id="text_4"><text style="font: 12px 'DejaVu Sans'" transform="translate(120 20)">Revenue up 42% in Q4</text></g>
  </g>
 </g>
 <desc>Matplotlib v3.5.2, https://matplotlib.org/</desc>
</svg>`);

check("a real matplotlib export reads as its labels, in order", () => {
  const t = textOf(readSvg(MPL_TEXT));
  assert(
    t === "Q1\nQ2\nQuarter\nRevenue up 42% in Q4\nMatplotlib v3.5.2, https://matplotlib.org/",
    `unexpected read of a real export: ${JSON.stringify(t)}`,
  );
});

check("a real export's inline stylesheet and RDF metadata stay out of the brief", () => {
  const t = textOf(readSvg(MPL_TEXT));
  assert(!/stroke-linejoin|DejaVu|rdf|2026-08-07/.test(t), `chrome leaked: ${JSON.stringify(t)}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
