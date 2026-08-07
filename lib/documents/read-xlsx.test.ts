/**
 * Spreadsheet attachment reading.
 *
 * Every workbook here is a REAL .xlsx assembled byte by byte — deflated
 * entries, a central directory, the parts a spreadsheet actually holds —
 * because a hand-rolled ZIP reader fed a hand-rolled fixture proves nothing
 * unless the fixture is shaped like what real writers emit. The shapes below
 * were taken from workbooks built with openpyxl, xlsxwriter and LibreOffice,
 * which disagree with one another about nearly everything: whether shared
 * strings exist at all, whether a formula caches its result, whether a
 * relationship target is absolute or relative, and what order the tabs are in.
 */
import { deflateRawSync } from "zlib";
import { readXlsx } from "./read-xlsx";
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
// A function declaration rather than the usual arrow: `asserts c` narrows the
// ok/reason union at the call site, so the checks below read straight through.
function assert(c: boolean, m: string): asserts c {
  if (!c) throw new Error(m);
}
/** The refusal, for a failure message written before the union has narrowed. */
const why = (r: ReturnType<typeof readXlsx>): string => (r.ok ? "(it succeeded)" : r.reason);

console.log("spreadsheet attachment reading");

// ── a real ZIP, assembled here ──────────────────────────────────────────────
/**
 * @param localExtra bytes of extra field written into the LOCAL header only.
 *   Real writers differ between the two headers; reading the central
 *   directory's length at the local offset lands mid-data.
 */
const makeZip = (
  entries: { name: string; data: Buffer; store?: boolean }[],
  localExtra = 0,
): Buffer => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const body = e.store ? e.data : deflateRawSync(e.data);
    const name = Buffer.from(e.name, "utf8");
    const extra = Buffer.alloc(localExtra);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(e.store ? 0 : 8, 8);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(extra.length, 28);
    locals.push(lh, name, extra, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(e.store ? 0 : 8, 10);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30); // deliberately NOT localExtra
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);

    offset += 30 + name.length + extra.length + body.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
};

// ── a real .xlsx on top of it ───────────────────────────────────────────────
const NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

interface SheetSpec {
  name: string;
  rows: string;
  /** Set where a test needs ids that do not run 1, 2, 3 in tab order. */
  rid?: string;
  file?: string;
  /** Set to exercise the absolute Target form openpyxl writes. */
  target?: string;
  state?: string;
}

const xlsx = (
  sheets: SheetSpec[],
  opts: { sharedStrings?: string[]; styles?: string; localExtra?: number } = {},
): Buffer => {
  const entries: { name: string; data: Buffer; store?: boolean }[] = [
    { name: "[Content_Types].xml", data: Buffer.from("<Types/>") },
  ];
  const rels: string[] = [];
  const tags: string[] = [];

  sheets.forEach((s, i) => {
    const rid = s.rid ?? `rId${i + 1}`;
    const file = s.file ?? `sheet${i + 1}.xml`;
    rels.push(
      `<Relationship Id="${rid}" Type="${NS}/worksheet" Target="${s.target ?? `worksheets/${file}`}"/>`,
    );
    tags.push(
      `<sheet name="${s.name}" sheetId="${i + 1}"${s.state ? ` state="${s.state}"` : ""} r:id="${rid}"/>`,
    );
    entries.push({
      name: `xl/worksheets/${file}`,
      data: Buffer.from(
        `<?xml version="1.0"?><worksheet><sheetData>${s.rows}</sheetData></worksheet>`,
        "utf8",
      ),
    });
  });

  // Styles and shared strings live in the SAME id space as the worksheets, and
  // LibreOffice really does hand them the low ids. A reader that maps r:id
  // without filtering on Type reads a stylesheet as a tab.
  rels.push(`<Relationship Id="rId1000" Type="${NS}/styles" Target="styles.xml"/>`);
  rels.push(`<Relationship Id="rId1001" Type="${NS}/sharedStrings" Target="sharedStrings.xml"/>`);

  entries.push({
    name: "xl/workbook.xml",
    data: Buffer.from(`<?xml version="1.0"?><workbook><sheets>${tags.join("")}</sheets></workbook>`, "utf8"),
  });
  entries.push({
    name: "xl/_rels/workbook.xml.rels",
    data: Buffer.from(`<?xml version="1.0"?><Relationships>${rels.join("")}</Relationships>`, "utf8"),
  });
  if (opts.sharedStrings) {
    entries.push({
      name: "xl/sharedStrings.xml",
      data: Buffer.from(`<sst count="${opts.sharedStrings.length}">${opts.sharedStrings.join("")}</sst>`, "utf8"),
    });
  }
  if (opts.styles) entries.push({ name: "xl/styles.xml", data: Buffer.from(opts.styles, "utf8") });
  return makeZip(entries, opts.localExtra ?? 0);
};

const si = (s: string) => `<si><t>${s}</t></si>`;
/** A cell holding inline text, the shape openpyxl and pandas write. */
const inline = (ref: string, text: string) => `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;

// ── shared strings ──────────────────────────────────────────────────────────
check("shared strings: cells resolve through their index, under their heading", () => {
  const book = xlsx(
    [
      {
        name: "Pipeline",
        rows:
          `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>` +
          `<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>12</v></c></row>`,
      },
    ],
    { sharedStrings: [si("Stage"), si("Deals"), si("Discovery")] },
  );
  const r = readXlsx(book);
  assert(r.ok, `expected ok, got: ${why(r)}`);
  assert(r.text.includes("Columns: Stage, Deals"), `headings missing: ${r.text}`);
  assert(r.text.includes("  Stage: Discovery"), `shared string not resolved: ${r.text}`);
  assert(r.text.includes("  Deals: 12"), `number lost its label: ${r.text}`);
});

check("shared strings: a rich-text entry is ONE index, not one per run", () => {
  // Measured on a real xlsxwriter workbook: scraping every <t> globally yields
  // 14 entries where there are 12 indices, and a cell whose contents were a
  // sentence then rendered as the single word "BOLD". Every index after the
  // rich one shifts.
  const rich =
    `<si><r><t xml:space="preserve">plain </t></r>` +
    `<r><rPr><b/></rPr><t>BOLD</t></r>` +
    `<r><t xml:space="preserve"> tail</t></r></si>`;
  const book = xlsx(
    [
      {
        name: "Notes",
        rows: `<row r="1"><c r="A1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c></row>`,
      },
    ],
    { sharedStrings: [si("Stage"), rich, si("the row after the rich one")] },
  );
  const r = readXlsx(book);
  assert(r.ok, `expected ok, got: ${why(r)}`);
  assert(r.text.includes("plain BOLD tail"), `runs must join into one value: ${r.text}`);
  assert(
    r.text.includes("the row after the rich one"),
    `index alignment broke — everything after a rich entry shifted: ${JSON.stringify(r.text)}`,
  );
});

check("shared strings: an index past the end leaves a gap, never the wrong word", () => {
  const book = xlsx([{ name: "S", rows: `<row r="1"><c r="A1" t="s"><v>9</v></c><c r="B1"><v>7</v></c></row>` }], {
    sharedStrings: [si("only one")],
  });
  const r = readXlsx(book);
  assert(r.ok, `expected ok, got: ${why(r)}`);
  assert(!r.text.includes("only one"), `a confidently wrong word is worse than a gap: ${r.text}`);
  assert(r.text.includes("7"), `the rest of the row must survive: ${r.text}`);
});

// ── inline strings ──────────────────────────────────────────────────────────
check("inline strings read when there is NO sharedStrings part at all", () => {
  // openpyxl — and so pandas.to_excel — never writes xl/sharedStrings.xml. A
  // shared-strings-only reader extracts zero characters from these files, which
  // are the likeliest kind to be attached.
  const book = xlsx([
    {
      name: "Q3 Revenue",
      rows:
        `<row r="1">${inline("A1", "Region")}${inline("B1", "Revenue")}</row>` +
        `<row r="2">${inline("A2", "EMEA")}<c r="B2" t="n"><v>148800.5</v></c></row>`,
    },
  ]);
  const r = readXlsx(book);
  assert(r.ok, `expected ok, got: ${why(r)}`);
  assert(r.text.includes("  Region: EMEA"), `inline text missing: ${JSON.stringify(r.text)}`);
  assert(r.text.includes("  Revenue: 148800.5"), `number missing: ${JSON.stringify(r.text)}`);
});

check("inline text that looks like an attribute is still read as text", () => {
  // Cell text is not quote-escaped, so a value mentioning t="b" would be taken
  // as that cell's type if attributes were matched across the whole element —
  // and the cell would render as the boolean TRUE.
  const book = xlsx([{ name: "S", rows: `<row r="1">${inline("A1", 'set t="b" on the cell')}</row>` }]);
  const r = readXlsx(book);
  assert(r.ok, `expected ok, got: ${why(r)}`);
  assert(r.text.includes(`set t="b" on the cell`), `attribute lookahead reached into the body: ${r.text}`);
});

check("a character reference beyond the last code point cannot throw", () => {
  // String.fromCodePoint raises a RangeError above U+10FFFF, and "&#1114112;"
  // is six keystrokes — an uncaught throw on the upload path from a file that
  // is merely malformed.
  const book = xlsx([{ name: "S", rows: `<row r="1">${inline("A1", "over &#1114112; the edge")}</row>` }]);
  const r = readXlsx(book);
  assert(r.ok, `a malformed reference must not take the reader down: ${why(r)}`);
  assert(r.text.includes("over"), `the rest of the cell must survive: ${r.text}`);
});

// ── numbers, formulas, booleans ─────────────────────────────────────────────
check("a formula's source never reaches the brief, cached or not", () => {
  const book = xlsx([
    {
      name: "Totals",
      rows:
        // openpyxl: no t, and an EMPTY cached value.
        `<row r="8">${inline("A8", "Total")}<c r="C8"><f>SUM(C2:C7)</f><v></v></c></row>` +
        // LibreOffice: the same formula WITH its cached result.
        `<row r="9">${inline("A9", "Sum")}<c r="C9" s="0" t="n"><f aca="false">SUM(C2:C7)</f><v>4457</v></c></row>`,
    },
  ]);
  const r = readXlsx(book);
  assert(r.ok, `expected ok, got: ${why(r)}`);
  assert(!/SUM\(/.test(r.text), `formula source leaked into the brief as prose: ${JSON.stringify(r.text)}`);
  assert(r.text.includes("4457"), `a cached result is real data and must survive: ${JSON.stringify(r.text)}`);
});

check("booleans and error cells read as themselves", () => {
  const book = xlsx([
    {
      name: "S",
      rows:
        `<row r="1"><c r="A1" t="b"><v>1</v></c><c r="B1" t="b"><v>0</v></c>` +
        `<c r="C1" t="e"><v>#DIV/0!</v></c><c r="D1" t="str"><f>CONCAT("a","b")</f><v>ab</v></c></row>`,
    },
  ]);
  const r = readXlsx(book);
  assert(r.ok, `expected ok, got: ${why(r)}`);
  assert(r.text.includes("TRUE, FALSE, #DIV/0!, ab"), `unexpected: ${JSON.stringify(r.text)}`);
});

check("float noise is trimmed but ordinary values are untouched", () => {
  const book = xlsx([
    { name: "S", rows: `<row r="1"><c r="A1"><v>255.0690257394217</v></c><c r="B1"><v>0.42</v></c><c r="C1"><v>240600</v></c></row>` },
  ]);
  const r = readXlsx(book);
  assert(r.ok, `expected ok, got: ${why(r)}`);
  assert(r.text.includes("255.069026, 0.42, 240600"), `unexpected: ${JSON.stringify(r.text)}`);
});

// ── dates ───────────────────────────────────────────────────────────────────
const STYLES =
  `<styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd h:mm:ss"/></numFmts>` +
  `<cellXfs count="4"><xf numFmtId="0" fontId="0"/><xf numFmtId="164" fontId="0"/>` +
  `<xf numFmtId="14" fontId="0"><alignment horizontal="left"/></xf><xf numFmtId="2" fontId="0"/></cellXfs></styleSheet>`;

check("a date serial becomes a date, via the three-hop style lookup", () => {
  const book = xlsx(
    [{ name: "S", rows: `<row r="1"><c r="A1" s="1" t="n"><v>46241</v></c><c r="B1" s="2"><v>45000</v></c></row>` }],
    { styles: STYLES },
  );
  const r = readXlsx(book);
  assert(r.ok, `expected ok, got: ${why(r)}`);
  // A bare 46241 is unreadable to the model. The custom formatCode carries the
  // first; the second rides built-in id 14 with no numFmts entry of its own.
  assert(r.text.includes("2026-08-07, 2023-03-15"), `serials not decoded: ${JSON.stringify(r.text)}`);
});

check("the same number under a non-date style stays a number", () => {
  const book = xlsx([{ name: "S", rows: `<row r="1"><c r="A1" s="3"><v>46241</v></c><c r="B1"><v>46241</v></c></row>` }], {
    styles: STYLES,
  });
  const r = readXlsx(book);
  assert(r.ok, `expected ok, got: ${why(r)}`);
  assert(r.text.includes("46241, 46241"), `a plain number was mangled into a date: ${JSON.stringify(r.text)}`);
});

check("the 1900 leap-year hole is handled at the boundary", () => {
  const book = xlsx(
    [
      {
        name: "S",
        rows: `<row r="1"><c r="A1" s="1"><v>1</v></c><c r="B1" s="1"><v>59</v></c><c r="C1" s="1"><v>61</v></c><c r="D1" s="1"><v>46241.5</v></c></row>`,
      },
    ],
    { styles: STYLES },
  );
  const r = readXlsx(book);
  assert(r.ok, `expected ok, got: ${why(r)}`);
  // Verified against openpyxl: Excel believes in 29 February 1900, so every
  // serial below 60 is one day out unless it is corrected.
  assert(
    r.text.includes("1900-01-01, 1900-02-28, 1900-03-01, 2026-08-07 12:00:00"),
    `serial conversion drifted: ${JSON.stringify(r.text)}`,
  );
});

// ── sheets ──────────────────────────────────────────────────────────────────
check("several sheets: each is named, in tab order, not filename or id order", () => {
  // Taken from a workbook built to break exactly this: tab one is sheetB.xml
  // via r:id="rId9", and openpyxl and LibreOffice both agree that it is first.
  const book = xlsx([
    { name: "Second &amp; &lt;odd&gt;", rid: "rId9", file: "sheetB.xml", rows: `<row r="1">${inline("A1", "Beta")}</row>` },
    {
      name: "First Tab",
      rid: "rId4",
      file: "sheetA.xml",
      target: "/xl/worksheets/sheetA.xml",
      rows: `<row r="1">${inline("A1", "Alpha")}</row>`,
    },
  ]);
  const r = readXlsx(book);
  assert(r.ok, `expected ok, got: ${why(r)}`);
  assert(r.text.includes("## Sheet: Second & <odd>"), `sheet name not decoded: ${JSON.stringify(r.text)}`);
  assert(r.text.includes("## Sheet: First Tab"), `second sheet missing: ${JSON.stringify(r.text)}`);
  assert(
    r.text.indexOf("## Sheet: Second") < r.text.indexOf("## Sheet: First"),
    `tab order must follow document order: ${JSON.stringify(r.text)}`,
  );
  // The absolute Target form openpyxl writes must resolve to the same part.
  assert(r.text.includes("Alpha"), `an absolute rels Target did not resolve: ${JSON.stringify(r.text)}`);
});

check("a sheet name cannot forge a heading of its own", () => {
  const book = xlsx([
    { name: "Real&#10;## Sheet: Forged", rows: `<row r="1">${inline("A1", "Alpha")}</row>` },
  ]);
  const r = readXlsx(book);
  assert(r.ok, `expected ok, got: ${why(r)}`);
  // The property that matters is line-level: a tab name must not be able to
  // open a heading of its own, because the numbers under it would then be
  // attributed to a sheet that does not exist.
  const headings = r.text.split("\n").filter((l) => l.startsWith("## Sheet:"));
  assert(headings.length === 1, `a tab name opened a second heading: ${JSON.stringify(r.text)}`);
});

check("an empty sheet leaves no heading standing over nothing", () => {
  const book = xlsx([
    { name: "Data", rows: `<row r="1">${inline("A1", "Alpha")}</row>` },
    { name: "Scratch", rows: `` },
    { name: "AlsoBlank", rows: `<row r="1"/><row r="2"><c r="A2"/></row>` },
  ]);
  const r = readXlsx(book);
  assert(r.ok, `expected ok, got: ${why(r)}`);
  assert(r.text.includes("## Sheet: Data"), `the real sheet is missing: ${r.text}`);
  assert(!r.text.includes("Scratch"), `an empty sheet must not be announced: ${JSON.stringify(r.text)}`);
  assert(!r.text.includes("AlsoBlank"), `a sheet of empty rows must not be announced: ${JSON.stringify(r.text)}`);
});

check("a hidden sheet is left out", () => {
  const book = xlsx([
    { name: "Story", rows: `<row r="1">${inline("A1", "Alpha")}</row>` },
    { name: "Working Notes", state: "hidden", rows: `<row r="1">${inline("A1", "scratch numbers")}</row>` },
  ]);
  const r = readXlsx(book);
  assert(r.ok, `expected ok, got: ${why(r)}`);
  assert(!r.text.includes("scratch numbers"), `hidden content reached the brief: ${JSON.stringify(r.text)}`);
});

check("a workbook whose every sheet is hidden is refused with a way through", () => {
  const book = xlsx([{ name: "Hidden", state: "hidden", rows: `<row r="1">${inline("A1", "x")}</row>` }]);
  const r = readXlsx(book);
  assert(!r.ok, "must not claim success");
  assert(/unhide|paste/i.test(r.reason), `must say what to do instead: ${r.reason}`);
});

// ── rows and columns ────────────────────────────────────────────────────────
check("a self-closing cell does not swallow the cell after it", () => {
  // The regex trap the whole reader turns on: with the greedy alternative
  // first, <c r="A2"/><c r="B2"><v>99</v></c> matches as ONE element and the 99
  // is silently lost. Both forms sit in real workbooks.
  const book = xlsx([
    {
      name: "S",
      rows:
        `<row r="1">${inline("A1", "Name")}${inline("B1", "Deals")}${inline("C1", "Value")}</row>` +
        `<row r="2"><c r="A2"/><c r="B2"><v>99</v></c><c r="C2"><v>7</v></c></row>`,
    },
  ]);
  const r = readXlsx(book);
  assert(r.ok, `expected ok, got: ${why(r)}`);
  assert(r.text.includes("  Deals: 99"), `an empty cell ate the cell after it: ${JSON.stringify(r.text)}`);
  assert(r.text.includes("  Value: 7"), `the third cell is missing: ${JSON.stringify(r.text)}`);
  assert(!r.text.includes("Name: 99"), `the empty column must still hold its place: ${JSON.stringify(r.text)}`);
});

check("a value keeps its own column when cells are out of order or start late", () => {
  const book = xlsx([
    {
      name: "S",
      rows:
        // Cells written out of order, exactly as one real file does it.
        `<row r="1">${inline("D1", "Beta")}${inline("A1", "Alpha")}</row>` +
        `<row r="2"><c r="C2"><v>3.5</v></c></row>`,
    },
  ]);
  const r = readXlsx(book);
  assert(r.ok, `expected ok, got: ${why(r)}`);
  assert(r.text.includes("Columns: Alpha, Column 2, Column 3, Beta"), `columns collapsed: ${JSON.stringify(r.text)}`);
  assert(r.text.includes("  Column 3: 3.5"), `a late-starting row lost its offset: ${JSON.stringify(r.text)}`);
  assert(!r.text.includes("Alpha: 3.5"), `the value slid under the wrong heading: ${JSON.stringify(r.text)}`);
});

check("blank rows leave no hollow records and do not fake a truncation", () => {
  const book = xlsx([
    {
      name: "S",
      rows:
        `<row r="1">${inline("A1", "Stage")}${inline("B1", "Deals")}</row>` +
        `<row r="2">${inline("A2", "Discovery")}<c r="B2"><v>12</v></c></row>` +
        `<row r="3"/><row r="4"><c r="A4"/></row>` +
        `<row r="5">${inline("A5", "Pilot")}<c r="B5"><v>5</v></c></row>` +
        `<row r="6"/>`,
    },
  ]);
  const r = readXlsx(book);
  assert(r.ok, `expected ok, got: ${why(r)}`);
  assert(r.text.includes("Row 1") && r.text.includes("Row 2"), `both data rows must be there: ${r.text}`);
  assert(!r.text.includes("Row 3"), `a blank row became a record: ${JSON.stringify(r.text)}`);
  // The whole sheet was rendered, so saying otherwise would be a plain untruth.
  assert(!/Showing the first/.test(r.text), `claimed a truncation that never happened: ${JSON.stringify(r.text)}`);
});

check("a sheet with no heading row says so instead of inventing one", () => {
  const book = xlsx([
    { name: "S", rows: `<row r="1"><c r="A1"><v>12</v></c><c r="B1"><v>240000</v></c></row><row r="2"><c r="A2"><v>5</v></c><c r="B2"><v>180000</v></c></row>` },
  ]);
  const r = readXlsx(book);
  assert(r.ok, `expected ok, got: ${why(r)}`);
  assert(/No heading row/.test(r.text), `the header call must be stated: ${JSON.stringify(r.text)}`);
  assert(!r.text.includes("  12: 5"), `a data row was promoted to headings: ${JSON.stringify(r.text)}`);
});

check("a one-column sheet reads as a list, not as labelled records", () => {
  const book = xlsx([
    { name: "People", rows: `<row r="1">${inline("A1", "Ana")}</row><row r="2">${inline("A2", "Bruno")}</row>` },
  ]);
  const r = readXlsx(book);
  assert(r.ok, `expected ok, got: ${why(r)}`);
  assert(r.text.includes("- Ana") && r.text.includes("- Bruno"), `expected a list: ${JSON.stringify(r.text)}`);
  assert(!r.text.includes("Column 1:"), `"Column 1: value" is the cost of records with none of the benefit: ${r.text}`);
});

// ── budget ──────────────────────────────────────────────────────────────────
check("a huge sheet stops early and says how much it did not read", () => {
  // On a real 50k-row workbook, reading to the end built 11.1M characters of
  // which 50k survive the clamp — 99.55% of the work discarded while a user
  // waits on the upload.
  const rows: string[] = [`<row r="1">${inline("A1", "Stage")}${inline("B1", "Note")}</row>`];
  for (let i = 2; i <= 30_000; i++) {
    rows.push(`<row r="${i}">${inline(`A${i}`, `Stage ${i}`)}${inline(`B${i}`, "a note about the close")}</row>`);
  }
  const r = readXlsx(xlsx([{ name: "Big", rows: rows.join("") }]));
  assert(r.ok, `expected ok, got: ${why(r)}`);
  assert(r.text.includes("  Stage: Stage 2"), "the start of the sheet must be there");
  assert(
    r.text.length < MAX_EXTRACTED_CHARS,
    `read ${r.text.length} chars for a ${MAX_EXTRACTED_CHARS} budget — the row loop ran on`,
  );
  // A model handed 200 rows and not told there were 30,000 summarises the
  // fragment as though it were the sheet.
  // 199, not 200: the row cap counts the heading row too, and the count is of
  // rows that would have been RENDERED — the sheet holds 30,000 rows, one of
  // which names the columns.
  assert(
    r.text.includes("Showing the first 199 of 29,999 rows."),
    `the truncation must be declared, with real numbers: ${JSON.stringify(r.text.slice(-120))}`,
  );
});

// ── refusals ────────────────────────────────────────────────────────────────
check("a zip that is not a spreadsheet is refused, in plain English", () => {
  const zip = makeZip([
    { name: "[Content_Types].xml", data: Buffer.from("<Types/>") },
    { name: "word/document.xml", data: Buffer.from("<w:document/>") },
  ]);
  const r = readXlsx(zip);
  assert(!r.ok, "must not claim success");
  assert(/paste|attach/i.test(r.reason), `must offer a route: ${r.reason}`);
  assert(!/undefined|null|xml|zip|parse/i.test(r.reason), `no wire vocabulary: ${r.reason}`);
});

check("a workbook with no readable sheets is refused, in plain English", () => {
  const zip = makeZip([
    { name: "xl/workbook.xml", data: Buffer.from(`<workbook><sheets></sheets></workbook>`) },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from("<Relationships/>") },
  ]);
  const r = readXlsx(zip);
  assert(!r.ok, "must not claim success");
  assert(/paste|re-sav/i.test(r.reason), `must offer a route: ${r.reason}`);
  assert(!/undefined|null|error/i.test(r.reason), `reason must be human: ${r.reason}`);
});

check("bytes that are not a zip at all are refused rather than thrown", () => {
  const r = readXlsx(Buffer.from("Stage,Owner,Deals\nDiscovery,Ana,12\n"));
  assert(!r.ok, "must not claim success");
  assert(r.reason.length > 20, `must be a sentence, not a code: ${r.reason}`);
});

// ── the ZIP reader itself, reached down this path ───────────────────────────
check("a local header with its own extra length still reads (offset trap)", () => {
  const book = xlsx([{ name: "S", rows: `<row r="1">${inline("A1", "Alpha")}</row>` }], { localExtra: 11 });
  const r = readXlsx(book);
  assert(r.ok, `the local extra field must be used, not the central one — got: ${why(r)}`);
  assert(r.text.includes("Alpha"), `text missing: ${r.text}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
