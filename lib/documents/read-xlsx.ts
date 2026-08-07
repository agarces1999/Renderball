import { MAX_EXTRACTED_CHARS, decodeXmlEntities, readZipEntry } from "./extract-text";

/**
 * Read an attached .xlsx workbook into text a model can use as brief context.
 *
 * WHY NO PARSER DEPENDENCY: an .xlsx is a ZIP of XML, the same shape as the
 * .docx path, so this reuses extract-text's readZipEntry rather than putting a
 * spreadsheet library on the path of user-supplied bytes.
 *
 * THE TRAP THIS FILE EXISTS FOR: cell text lives in TWO places and the famous
 * one is the rarer one. openpyxl — and so pandas.to_excel, the likeliest
 * producer of a spreadsheet someone attaches — writes NO xl/sharedStrings.xml
 * at all and puts its text inline under t="inlineStr". Measured against a real
 * openpyxl workbook: a shared-strings-only reader extracts zero characters from
 * it. Both paths are mandatory, not one plus a fallback.
 *
 * WHY RECORDS AND NOT A GRID OF PIPES: see the long argument at the head of
 * ./read-csv.ts. A table only reads correctly if the reader holds the header
 * line in mind and counts columns on every line after it, and when that slips
 * it slips silently — a value lands under the wrong heading and is then
 * indistinguishable from a fact. Spreadsheets make that worse than CSV does,
 * because rows really do start at column C. Naming the column beside its value
 * is what makes a shifted row look strange rather than read as true. This file
 * deliberately produces the same shape as the CSV reader; a brief should not be
 * able to tell which of the two read it.
 *
 * Deterministic, costs no tokens.
 */

export type XlsxResult = { ok: true; text: string } | { ok: false; reason: string };

/** Rows rendered per sheet. Matches read-csv's cap; past it rows are counted
 *  and declared missing rather than silently dropped. */
const MAX_ROWS_PER_SHEET = 200;

/** Columns rendered, so one 200-column sheet cannot crowd out the rows. */
const MAX_COLS = 30;

/** Long enough for a sentence in a cell, short enough to bound a runaway one. */
const MAX_CELL_CHARS = 300;

// ── XML, at the level this needs it ─────────────────────────────────────────

interface XmlElement {
  /** The element including its tags, for reading attributes. */
  raw: string;
  /** What sits between the tags; "" when the element is self-closing. */
  inner: string;
}

/**
 * Every `<tag>` in document order, in both the closed and self-closing forms.
 *
 * THE SELF-CLOSING ALTERNATIVE MUST BE TRIED FIRST. With the greedy form
 * leading, `<c r="A2"/><c r="B2"><v>99</v></c>` matches as ONE element — the
 * empty cell's `[^>]*>` happily eats the trailing slash and then hunts for the
 * next `</c>` — and the 99 disappears. The same failure folds a `<row/>` into
 * the row beneath it. Both forms sit in real workbooks, so this ordering is
 * load-bearing rather than defensive.
 */
const elementsOf = (xml: string, tag: string): XmlElement[] => {
  const re = new RegExp(`<${tag}\\b[^>]*/>|<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "g");
  const out: XmlElement[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push({ raw: m[0], inner: m[1] ?? "" });
  return out;
};

/**
 * The opening tag alone. Cell TEXT is not quote-escaped, so a cell reading
 * `set t="b" here` would otherwise be read as a cell of type "b".
 */
const openTagOf = (raw: string): string => /^<[^>]*>/.exec(raw)?.[0] ?? raw;

const attr = (openTag: string, name: string): string | undefined =>
  new RegExp(`\\b${name}="([^"]*)"`).exec(openTag)?.[1];

/** Furigana: a second reading of the same characters, doubling the text. */
const stripPhonetics = (xml: string): string =>
  xml
    .replace(/<rPh\b[^>]*\/>/g, "")
    .replace(/<rPh\b[^>]*>[\s\S]*?<\/rPh>/g, "")
    .replace(/<phoneticPr\b[^>]*\/?>/g, "");

// ── shared strings ──────────────────────────────────────────────────────────

/**
 * One `<si>` is one index, however many `<t>` runs it holds.
 *
 * Slicing on `<si>` before touching `<t>` is the entire point. Scraping every
 * `<t>` out of a real xlsxwriter workbook returned 14 entries where there were
 * 12 indices, because one rich-text `<si>` ("plain **BOLD** tail") holds three
 * runs — and every index after it was then off by two, so a cell whose contents
 * were a sentence rendered as the single word "BOLD".
 *
 * A missing part is normal, not a failure: openpyxl never writes one.
 */
const parseSharedStrings = (buf: Buffer): string[] => {
  const xml = readZipEntry(buf, "xl/sharedStrings.xml")?.toString("utf8");
  if (!xml) return [];
  return elementsOf(xml, "si").map((si) =>
    decodeXmlEntities(
      elementsOf(stripPhonetics(si.inner), "t")
        .map((t) => t.inner)
        .join(""),
    ),
  );
};

// ── sheets ──────────────────────────────────────────────────────────────────

interface SheetRef {
  name: string;
  path: string;
  hidden: boolean;
}

/**
 * Tab order is the DOCUMENT ORDER of `<sheet>` — never the filename, never the
 * sheetId, never the relationship id. In a workbook built to test exactly this,
 * tab one is sheetB.xml via r:id="rId9", and openpyxl and LibreOffice both
 * agree. LibreOffice starts worksheets at rId3 because theme and styles take
 * rId1 and rId2, so the ids carry no ordering information whatsoever.
 *
 * @returns null when there is no workbook part at all, which is what separates
 *   "this is not a spreadsheet" from "this spreadsheet is empty".
 */
const parseWorkbook = (buf: Buffer): SheetRef[] | null => {
  const wb = readZipEntry(buf, "xl/workbook.xml")?.toString("utf8");
  if (!wb) return null;
  const relsXml = readZipEntry(buf, "xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "";

  const rels = new Map<string, string>();
  for (const rel of elementsOf(relsXml, "Relationship")) {
    const tag = openTagOf(rel.raw);
    const id = attr(tag, "Id");
    const target = attr(tag, "Target");
    // Filter on Type: styles, theme and sharedStrings share this id space, and
    // a chartsheet is a sheet with no sheetData in it.
    if (!id || !target || !/\/worksheet$/.test(attr(tag, "Type") ?? "")) continue;
    const decoded = decodeXmlEntities(target).replace(/^\.\//, "");
    // openpyxl writes "/xl/worksheets/sheet1.xml"; xlsxwriter and LibreOffice
    // write "worksheets/sheet1.xml", relative to xl/. Both are correct.
    const path = decoded.startsWith("/")
      ? decoded.slice(1)
      : decoded.startsWith("xl/")
        ? decoded
        : `xl/${decoded}`;
    rels.set(id, path);
  }

  const sheets: SheetRef[] = [];
  for (const sheet of elementsOf(wb, "sheet")) {
    const tag = openTagOf(sheet.raw);
    const rid = attr(tag, "r:id");
    const path = rid ? rels.get(rid) : undefined;
    if (!path) continue;
    sheets.push({
      name: decodeXmlEntities(attr(tag, "name") ?? ""),
      path,
      hidden: (attr(tag, "state") ?? "visible") !== "visible",
    });
  }
  return sheets;
};

// ── dates ───────────────────────────────────────────────────────────────────

/** Date and time formats that need no numFmts entry of their own. */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** A format is a date if a date/time letter survives once colour conditions,
 *  quoted literals and escapes are gone: "#,##0.00" keeps none, "yyyy-mm-dd" does. */
const isDateFormat = (code: string): boolean =>
  /[dmyhs]/i.test(
    code
      .replace(/\[[^\]]*\]/g, "")
      .replace(/"[^"]*"/g, "")
      .replace(/\\./g, ""),
  );

/**
 * Which cell style indices render as dates.
 *
 * WHY TOUCH styles.xml AT ALL: a date is stored as a bare serial, so without
 * this three-hop lookup (cell @s -> the nth <xf> of cellXfs -> numFmtId ->
 * formatCode) a brief receives "46241" where the spreadsheet plainly shows
 * 2026-08-07 — unreadable to the model, and the one thing number formatting is
 * worth decoding for. Currency symbols and percent scaling are deliberately NOT
 * decoded: a brief wants the value, not the presentation.
 */
const parseDateStyles = (buf: Buffer): Set<number> => {
  const dateStyles = new Set<number>();
  const xml = readZipEntry(buf, "xl/styles.xml")?.toString("utf8");
  if (!xml) return dateStyles;

  const custom = new Map<number, string>();
  for (const fmt of elementsOf(xml, "numFmt")) {
    const tag = openTagOf(fmt.raw);
    const id = Number(attr(tag, "numFmtId"));
    if (Number.isInteger(id)) custom.set(id, decodeXmlEntities(attr(tag, "formatCode") ?? ""));
  }

  // A cell's @s is a 0-based index into cellXfs in document order, not an id.
  const block = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? "";
  elementsOf(block, "xf").forEach((xf, i) => {
    const id = Number(attr(openTagOf(xf.raw), "numFmtId") ?? "0");
    const code = custom.get(id);
    if (BUILTIN_DATE_FORMATS.has(id) || (code !== undefined && isDateFormat(code))) dateStyles.add(i);
  });
  return dateStyles;
};

/** 1899-12-30: Excel's day 1 is 1900-01-01 and it believes in 1900-02-29. */
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
/** Serial for 9999-12-31. Past this the number is data that happens to be big. */
const MAX_SERIAL = 2_958_465;

const serialToDate = (serial: number): string | null => {
  if (!Number.isFinite(serial) || serial < 1 || serial > MAX_SERIAL) return null;
  // The phantom 29 February 1900 puts everything below serial 60 one day out.
  // Verified against openpyxl: 1 -> 1900-01-01, 59 -> 1900-02-28,
  // 61 -> 1900-03-01, 46241 -> 2026-08-07.
  const days = serial < 60 ? serial + 1 : serial;
  const iso = new Date(EXCEL_EPOCH + Math.round(days * 86_400_000)).toISOString();
  const time = iso.slice(11, 19);
  return time === "00:00:00" ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${time}`;
};

/**
 * Binary-float noise: a stored 255.0690257394217 that the sheet shows as
 * 255.07. Only touched when the tail is long enough to be noise, so ordinary
 * values reach the brief as the exact characters the file holds.
 */
const trimFloat = (v: string): string => {
  if (!/\.\d{7,}$/.test(v)) return v;
  const n = Number(v);
  return Number.isFinite(n) ? String(Number(n.toFixed(6))) : v;
};

// ── cells ───────────────────────────────────────────────────────────────────

/** "C" -> 2. Column letters are base-26 with A as 1. */
const colIndex = (ref: string): number => {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] ?? "";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

const cellText = (raw: string, sst: string[], dateStyles: Set<number>): string => {
  const tag = openTagOf(raw);
  // xlsxwriter omits t entirely on numbers, so absent means numeric.
  const type = attr(tag, "t") ?? "n";

  // THERE IS DELIBERATELY NO <f> STRIP HERE. openpyxl writes <f>SUM(C2:C7)</f>
  // beside an EMPTY cached <v>, and the classic failure is a reader that strips
  // tags and drops the literal text "SUM(C2:C7)" into the brief as though it
  // were prose. Reading the NAMED elements is what makes that unreachable: a
  // formula is characters, and across every real workbook checked no <f> ever
  // contains a <v> or a <t>. A strip WAS written here first and measured to
  // change nothing. It matters if this is ever rewritten as a tag-strip, since
  // the formula source would come back with it.

  if (type === "inlineStr") {
    // Inline text splits into rich-text runs too, so join every one of them.
    return decodeXmlEntities(
      elementsOf(stripPhonetics(raw), "t")
        .map((t) => t.inner)
        .join(""),
    );
  }

  const v = elementsOf(raw, "v")[0]?.inner ?? "";
  if (v === "") return "";

  if (type === "s") {
    const i = Number(v);
    // Out of range means the sheet and the string table disagree. A gap in a
    // brief is recoverable; a confidently wrong word is not.
    return Number.isInteger(i) && i >= 0 && i < sst.length ? sst[i] : "";
  }
  if (type === "b") return v === "0" ? "FALSE" : "TRUE";
  if (type === "str" || type === "e") return decodeXmlEntities(v); // formula result, #REF!

  if (dateStyles.has(Number(attr(tag, "s") ?? NaN))) {
    const asDate = serialToDate(Number(v));
    if (asDate) return asDate;
  }
  return trimFloat(decodeXmlEntities(v));
};

/** One cell as it will be read, bounded so a pasted essay in A1 cannot take the
 *  whole budget on its own. */
const cellValue = (raw: string): string => {
  const v = raw.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
  return v.length <= MAX_CELL_CHARS ? v : `${v.slice(0, MAX_CELL_CHARS).trimEnd()}…`;
};

// ── one sheet ───────────────────────────────────────────────────────────────

interface Grid {
  rows: string[][];
  /** Rows worth rendering that the sheet holds — not rows.length once the cap
   *  bites, and NOT the count of `<row>` elements either. */
  total: number;
}

/** Whether a row holds any value at all, without paying to parse its cells. */
const HAS_CONTENT = /<v[\s>]|<t[\s>]/;

const sheetGrid = (buf: Buffer, path: string, sst: string[], dateStyles: Set<number>): Grid => {
  const xml = readZipEntry(buf, path)?.toString("utf8");
  if (!xml) return { rows: [], total: 0 };

  const rows: string[][] = [];
  let total = 0;
  for (const row of elementsOf(xml, "row")) {
    // STOP READING AT THE CAP. Measured on a real 50k-row workbook: rendering
    // it whole produced 11.1M characters of which 50k survive the clamp —
    // 99.55% of the work discarded while a user waits on an upload. Counting
    // continues, because a model given 200 rows and not told there were 50,000
    // will summarise the fragment as though it were the sheet.
    //
    // Counted by the cheap test rather than by `<row>` elements: an all-empty
    // row is dropped below, so counting those would report a truncation that
    // never happened — "the first 3 of 4 rows" on a sheet that was rendered
    // whole, which is a plain untruth to the model.
    if (rows.length >= MAX_ROWS_PER_SHEET) {
      if (HAS_CONTENT.test(row.inner)) total++;
      continue;
    }

    const cells: string[] = [];
    for (const cell of elementsOf(row.inner, "c")) {
      const ref = attr(openTagOf(cell.raw), "r");
      // Cells get written out of order — D1 before A1 in a real file — and a row
      // can start anywhere: row 11 of a real sheet begins at B11. Placing by
      // reference is what keeps a value under its own column name.
      const at = ref ? colIndex(ref) : cells.length;
      if (at < 0 || at >= MAX_COLS) continue;
      while (cells.length < at) cells.push("");
      cells[at] = cellValue(cellText(cell.raw, sst, dateStyles));
    }
    while (cells.length && cells[cells.length - 1] === "") cells.pop();

    // Blank rows carry no meaning once each value is labelled, and producers
    // already OMIT empty rows anyway — r jumps from 3 to 5 — so a gap was never
    // recoverable in the first place. Dropping beats emitting hollow records.
    if (cells.some((c) => c !== "")) {
      rows.push(cells);
      total++;
    }
  }
  return { rows, total };
};

// ── shaping ─────────────────────────────────────────────────────────────────

const NUMERIC = /^[-+(]?[$€£¥]?\s?\d[\d\s.,]*%?\)?$/;
const YEARISH = /^(19|20)\d{2}$/;
const DATEISH = /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}/;

/**
 * Decide whether the first row names the columns.
 *
 * A worksheet cannot say so any more than a CSV can, so this is a heuristic and
 * the rendered text always states which way it went — a reader can then see the
 * call that was made. The traps are read-csv's, and they are the same here: a
 * revenue-by-year sheet puts 2023, 2024, 2025 across the top, so a plain
 * is-it-a-number test unlabels the whole sheet, and a sheet whose first row is
 * one long sentence has a title, not headings.
 */
const looksLikeHeader = (first: string[], rest: string[][]): boolean => {
  if (rest.length === 0) return false;
  const filled = first.filter((c) => c !== "");
  if (filled.length < 2) return false;
  // A title row spanning the sheet leaves the rest of the row empty.
  if (filled.length * 2 < first.length) return false;
  return filled.every((c) => {
    if (c.length > 60) return false;
    if (DATEISH.test(c)) return false;
    if (NUMERIC.test(c)) return YEARISH.test(c);
    return true;
  });
};

/** Thousands separators without toLocaleString, whose output follows the host
 *  machine's locale — the same workbook would describe itself differently on a
 *  laptop and on the server. */
const num = (n: number): string => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/**
 * One row as its own labelled block. Empty cells are dropped rather than
 * printed as `Notes:` with nothing after them: sparse sheets are mostly blanks,
 * and the column list above already says the column exists.
 */
const renderRecord = (n: number, names: string[], cells: string[]): string => {
  const lines = [`Row ${n}`];
  for (let i = 0; i < Math.min(Math.max(names.length, cells.length), MAX_COLS); i++) {
    const value = cells[i] ?? "";
    if (!value) continue;
    lines.push(`  ${names[i] ?? `Column ${i + 1}`}: ${value}`);
  }
  return lines.length > 1 ? lines.join("\n") : "";
};

/**
 * A sheet name is echoed into text a model reads, and tab names are author
 * -supplied. A name carrying a line break could otherwise forge one of the
 * headings below and describe its own numbers as another sheet's.
 */
const sheetHeading = (name: string): string =>
  `## Sheet: ${name.replace(/[\r\n\t]+/g, " ").trim().slice(0, 120) || "Untitled"}`;

const renderSheet = (name: string, grid: Grid): string => {
  const head = sheetHeading(name);
  const [first, ...rest] = grid.rows;
  const hasHeader = looksLikeHeader(first, rest);
  const dataRows = hasHeader ? rest : grid.rows;
  if (dataRows.length === 0 && !hasHeader) return "";

  const widest = Math.min(Math.max(...grid.rows.map((r) => r.length), 1), MAX_COLS);
  const names: string[] = [];
  for (let i = 0; i < widest; i++) names.push((hasHeader ? first[i] : "") || `Column ${i + 1}`);

  // Counted against rows the sheet HOLDS, not rows that were read, so the note
  // below is true even though the reader stopped early.
  const shownTotal = grid.total - (hasHeader ? 1 : 0);
  const cut = dataRows.length < shownTotal;
  const note = cut ? `\n\nShowing the first ${num(dataRows.length)} of ${num(shownTotal)} rows.` : "";

  // A single column is a list. "Column 1: value" down 200 lines is the record
  // form's cost with none of its benefit — there is only one thing a value can
  // be — so it gets the shape a list should have.
  if (widest === 1) {
    const items = dataRows.map((r) => `- ${r[0] ?? ""}`).filter((l) => l !== "- ");
    if (!items.length) return "";
    const lead = hasHeader ? `${head}\nA list of "${names[0]}".` : `${head}\nA list, with no heading over it.`;
    return `${lead}\n\n${items.join("\n")}${note}`;
  }

  if (!hasHeader) {
    // Nothing to label the values with, so labelling them "Column 3" would
    // dress a guess up as structure. The values go down as they read.
    const lines = dataRows.map((r) => r.filter((c) => c !== "").join(", ")).filter(Boolean);
    if (!lines.length) return "";
    return `${head}\nNo heading row — these are the values as they appear.\n\n${lines.join("\n")}${note}`;
  }

  const records = dataRows.map((r, i) => renderRecord(i + 1, names, r)).filter(Boolean);
  if (!records.length) return "";
  return `${head}\nColumns: ${names.join(", ")}\n\n${records.join("\n")}${note}`;
};

// ── entry point ─────────────────────────────────────────────────────────────

const NOT_A_WORKBOOK =
  "That doesn't look like an Excel spreadsheet. Attach the .xlsx file itself, or paste the numbers into the brief.";

const NO_SHEETS =
  "That spreadsheet's sheets couldn't be read. Re-saving it from Excel as .xlsx usually fixes it — or paste the numbers into the brief.";

const NOTHING_IN_IT =
  "That spreadsheet looks empty — every sheet was blank or hidden. Unhide the sheet you want read, or paste the numbers into the brief.";

/**
 * @returns the workbook as labelled records, or a sentence to show the user
 *   verbatim. Never throws: everything here is reachable from an upload.
 */
export const readXlsx = (buf: Buffer): XlsxResult => {
  const sheets = parseWorkbook(buf);
  if (!sheets) return { ok: false, reason: NOT_A_WORKBOOK };
  if (!sheets.length) return { ok: false, reason: NO_SHEETS };

  const sst = parseSharedStrings(buf);
  const dateStyles = parseDateStyles(buf);

  const blocks: string[] = [];
  let used = 0;
  sheets.forEach((sheet, i) => {
    // Hidden almost always means working notes rather than the story, and it is
    // the one signal in the file about what the author meant to show.
    if (sheet.hidden) return;
    if (used >= MAX_EXTRACTED_CHARS) return;
    const grid = sheetGrid(buf, sheet.path, sst, dateStyles);
    if (!grid.rows.length) return; // no heading left standing over nothing
    // Named, and headed, because several tabs read as one document otherwise and
    // the model attributes the wrong numbers to the wrong sheet.
    const block = renderSheet(sheet.name || `Sheet ${i + 1}`, grid);
    if (!block) return;
    blocks.push(block);
    used += block.length + 2;
  });

  if (!blocks.length) return { ok: false, reason: NOTHING_IN_IT };
  // Deliberately NOT run through extract-text's tidy: it strips the space at the
  // start of every line, and the indent under each `Row N` is what holds a
  // record together on the page.
  return { ok: true, text: blocks.join("\n\n") };
};
