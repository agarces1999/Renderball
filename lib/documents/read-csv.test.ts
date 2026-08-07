/**
 * Spreadsheet export reading.
 *
 * The parser is hand-rolled, so the tests are built from the byte sequences
 * real exporters actually emit — CRLF from Excel on Windows, a bare CR from
 * older Mac exports, a UTF-8 byte-order mark, a `sep=;` preamble, quoted cells
 * carrying the delimiter and line breaks — rather than from strings that only
 * this parser would ever produce.
 *
 * The first test is the one that matters most: a naive `split(",")` passes
 * nothing else in this file and fails that one, because a quoted cell holding
 * a comma is the defect this module exists to prevent.
 */
import { readCsv, MAX_CSV_ROWS, MAX_CSV_COLUMNS, type CsvResult } from "./read-csv";
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

/** Assert a read succeeded AND narrow the union — a plain `r.text` would not
 * compile, which is the point of the result being a union at all. */
const textOf = (r: CsvResult): string => {
  if (!r.ok) throw new Error(`expected a read, got a refusal: ${r.reason}`);
  return r.text;
};
const reasonOf = (r: CsvResult): string => {
  if (r.ok) throw new Error(`expected a refusal, got text: ${r.text.slice(0, 80)}`);
  return r.reason;
};

const read = (body: string, filename = "export.csv") => readCsv(Buffer.from(body, "utf8"), filename);

console.log("spreadsheet export reading");

// ── the split(",") trap ─────────────────────────────────────────────────────

check("a comma inside a quoted cell stays one value (the split trap)", () => {
  const t = textOf(read('Account,Note\nAcme,"Closed, finally"'));
  assert(t.includes("Note: Closed, finally"), `the quoted cell was cut: ${JSON.stringify(t)}`);
  // A naive split invents a third field and shifts everything after it.
  assert(!/Column 3/.test(t), `an extra column appeared: ${t}`);
});

check("a doubled quote inside a quoted cell is one quote", () => {
  const t = textOf(read('Product,Name\n1,"The ""Big"" One"'));
  assert(t.includes('Name: The "Big" One'), `escape not unwrapped: ${JSON.stringify(t)}`);
});

check("a line break inside a quoted cell survives without breaking the record", () => {
  const t = textOf(read('Name,Address,City\nAda,"12 King St\nCamden",London'));
  assert(t.includes("12 King St"), `first line missing: ${t}`);
  // Indented, or the second line of an address reads as the start of a record.
  assert(/\n {4}Camden/.test(t), `continuation not indented: ${JSON.stringify(t)}`);
  assert(t.includes("\n  City: London"), `the next column lost its own line: ${JSON.stringify(t)}`);
});

check("CRLF leaves no carriage returns inside values", () => {
  const t = textOf(read("Name,City\r\nAda,London\r\nGrace,Paris\r\n"));
  assert(!t.includes("\r"), `stray CR in output: ${JSON.stringify(t)}`);
  assert(t.includes("City: London") && t.includes("Name: Grace"), `rows misread: ${t}`);
});

check("a bare CR — old Mac exports — still separates rows", () => {
  const t = textOf(read("Name,City\rAda,London\rGrace,Paris\r"));
  assert(t.includes("Name: Ada") && t.includes("Name: Grace"), `CR-only rows not split: ${t}`);
});

// ── delimiters ──────────────────────────────────────────────────────────────

check("semicolons win over commas even when commas are more numerous", () => {
  // Counting characters picks comma here (9 commas, 4 semicolons) and shreds
  // every row. Field-count consistency picks semicolon.
  const t = textOf(read('Name;Notes\nAda;"a, b, c, d"\nGrace;"e, f, g, h"\nLinus;"i, j, k, l"'));
  assert(t.includes("Name: Ada"), `semicolon not detected: ${t}`);
  assert(t.includes("Notes: a, b, c, d"), `the note was split on its commas: ${t}`);
});

check("a European decimal comma does not become a delimiter", () => {
  const t = textOf(read("Stadt;Umsatz;Marge\nBerlin;1,5;0,32\nHamburg;2,75;0,41"));
  assert(t.includes("Umsatz: 1,5"), `decimal comma split: ${t}`);
  assert(t.includes("Marge: 0,41"), `columns shifted: ${t}`);
});

check("a .tsv is read on tabs, and commas in its values are left alone", () => {
  const t = textOf(read("Name\tRole\nAda\tEngineer, London", "team.tsv"));
  assert(t.includes("Role: Engineer, London"), `tab delimiter missed: ${JSON.stringify(t)}`);
});

check("Excel's `sep=;` preamble is obeyed and not shown as data", () => {
  const t = textOf(read("sep=;\nName;City\nAda;London"));
  assert(t.includes("City: London"), `declared separator ignored: ${t}`);
  assert(!/sep=/.test(t), `the preamble leaked into the text: ${t}`);
});

check("a UTF-8 byte-order mark does not end up inside the first column name", () => {
  const t = textOf(read("﻿Name,City\nAda,London"));
  assert(!t.includes("﻿"), `BOM survived: ${JSON.stringify(t.slice(0, 40))}`);
  assert(t.includes("Name: Ada"), `first column name corrupted: ${t}`);
});

check("a BOM in front of Excel's `sep=;` preamble does not hide it", () => {
  // Excel writes both together, and this is where dropping the BOM actually
  // costs something: the preamble is matched at the start of the file, so an
  // unstripped mark pushes it out of reach and `sep=` is then read as the
  // header row — every column ends up named after it. Trimming a cell hides a
  // stray BOM by itself, so this is the case that holds the strip in place.
  const t = textOf(read("﻿sep=;\nName;City\nAda;London"));
  assert(t.includes("City: London"), `the preamble was parsed as data: ${JSON.stringify(t)}`);
  assert(!/sep=/.test(t), `the preamble leaked into the text: ${t}`);
});

// ── shape ───────────────────────────────────────────────────────────────────

check("every value is named on its own row, not left to column position", () => {
  const t = textOf(read("Account,Stage,Amount\nAcme,Won,100\nBeta,Open,200\nGamma,Lost,300"));
  assert((t.match(/^ {2}Stage: /gm) ?? []).length === 3, `each row must name its columns: ${t}`);
  assert(/^ {2}Amount: 200$/m.test(t), `value not attached to its heading: ${t}`);
  assert(t.includes("3 rows, 3 columns: Account, Stage, Amount"), `header not named up front: ${t}`);
});

check("a header of years is still a header", () => {
  // Revenue-by-year exports are the case a plain is-it-a-number test destroys:
  // it calls the header a data row and unlabels every row under it.
  const t = textOf(read("Region,2023,2024\nNorth,120,140\nSouth,90,110"));
  assert(t.includes("2024: 140"), `year headings were thrown away: ${t}`);
  assert(t.includes("Region: North"), `columns lost their names: ${t}`);
});

check("a file with no header keeps its first row and says the names are missing", () => {
  const t = textOf(read("North,120,140\nSouth,90,110\nEast,70,80"));
  assert(/no header row/i.test(t), `the missing header must be stated: ${t}`);
  assert(t.includes("North | 120 | 140"), `the first row was eaten as a header: ${t}`);
  assert(!/North:/.test(t), `a data value was promoted to a column name: ${t}`);
  assert(t.includes("3 rows"), `row count wrong: ${t}`);
});

check("a single column with a heading reads as a list, not as records", () => {
  const t = textOf(read("Email\nalice@example.com\nbob@example.com"));
  assert(t.includes('one column, "Email"'), `the column was not named: ${t}`);
  assert(t.includes("- alice@example.com"), `values missing: ${t}`);
  assert(!/Row 1/.test(t), `a one-column list does not need record blocks: ${t}`);
});

check("a single column with no heading keeps its first value", () => {
  const t = textOf(read("alice@example.com\nbob@example.com\ncarol@example.com"));
  assert(t.includes("- alice@example.com"), `the first address was consumed as a heading: ${t}`);
  assert(/no header row/i.test(t), `must say the heading is missing: ${t}`);
  assert(t.includes("3 values"), `count wrong: ${t}`);
});

check("an extra unquoted comma surfaces its value instead of dropping it", () => {
  const t = textOf(read("Account,Note\nAcme,Closed, finally"));
  assert(t.includes("Account: Acme"), `the named columns shifted: ${t}`);
  assert(t.includes("finally"), `the extra value vanished silently: ${t}`);
});

check("a trailing newline does not invent an empty last row", () => {
  const t = textOf(read("A,B\nx,y\n"));
  assert(!/Row 2/.test(t), `phantom row: ${t}`);
  assert(t.includes("1 row, 2 columns"), `count wrong: ${t}`);
});

check("a blank line between blocks is skipped, not counted", () => {
  const t = textOf(read("A,B\nx,y\n\np,q\n"));
  assert(t.includes("2 rows"), `blank line counted as a row: ${t}`);
  assert(t.includes("A: p"), `the row after the gap was lost: ${t}`);
});

check("a header with no rows under it still hands over the column names", () => {
  const t = textOf(read("Account,Stage,Amount\n"));
  assert(/no data rows/i.test(t), `must say there is no data: ${t}`);
  assert(t.includes("Account, Stage, Amount"), `headings missing: ${t}`);
});

// ── caps ────────────────────────────────────────────────────────────────────

check("a huge export is capped and says so with real numbers", () => {
  const rows = Array.from({ length: 5000 }, (_, i) => `Acct ${i + 1},Open,${100 + i}`);
  const t = textOf(read(`Account,Stage,Amount\n${rows.join("\n")}`));
  assert(t.length <= MAX_EXTRACTED_CHARS, `budget blown: ${t.length}`);
  assert(t.includes("5,000"), `the true total must appear: ${t.slice(0, 300)}`);
  assert(
    /first 200 rows of 5,000 are shown/.test(t),
    `truncation must be stated before the data: ${t.slice(0, 400)}`,
  );
  assert(/not the whole file/.test(t), `must warn that totals here are partial: ${t.slice(0, 400)}`);
  assert(/4,800 rows were left out/.test(t), `the closing note must name the gap: ${t.slice(-200)}`);
  assert(!/\bRow 201\b/.test(t), `rendered past the cap: ${t.slice(-200)}`);
  assert((t.match(/^Row \d+$/gm) ?? []).length === MAX_CSV_ROWS, `wrong row count rendered`);
});

check("a very wide export caps its columns and says how many it dropped", () => {
  const names = Array.from({ length: 54 }, (_, i) => `Col${i + 1}`).join(",");
  const values = Array.from({ length: 54 }, (_, i) => `v${i + 1}`).join(",");
  const t = textOf(read(`${names}\n${values}`));
  assert(/first 30 of 54 columns/.test(t), `column cap not declared: ${t.slice(0, 400)}`);
  assert(t.includes(`Col${MAX_CSV_COLUMNS}: v${MAX_CSV_COLUMNS}`), `last kept column missing: ${t}`);
  assert(!/Col31:/.test(t), `rendered past the column cap: ${t}`);
});

check("one enormous cell is trimmed and the trimming is declared", () => {
  const long = "n".repeat(900);
  const t = textOf(read(`Account,Notes\nAcme,${long}`));
  assert(!t.includes(long), `the whole cell was kept: ${t.length}`);
  assert(t.includes("…"), `no marker where the value was cut: ${t.slice(0, 200)}`);
  assert(/trimmed/.test(t), `silent trimming reads as the full value: ${t.slice(0, 300)}`);
});

// ── refusals ────────────────────────────────────────────────────────────────

check("an empty file is refused in plain English with a way forward", () => {
  const r = read("   \n  \n");
  const reason = reasonOf(r);
  assert(/paste|check/i.test(reason), `no route forward: ${reason}`);
  assert(!/undefined|null|EOF|parse|delimiter/i.test(reason), `wire vocabulary leaked: ${reason}`);
});

check("an .xlsx workbook is named for what it is, with the fix", () => {
  // A real .xlsx starts with the ZIP local file header.
  const xlsx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)]);
  const reason = reasonOf(readCsv(xlsx, "q3.xlsx"));
  assert(/CSV/.test(reason), `must say what is wanted instead: ${reason}`);
  assert(/save/i.test(reason), `must say how to get one: ${reason}`);
});

check("an older .xls workbook is caught too", () => {
  const xls = Buffer.concat([
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    Buffer.alloc(64),
  ]);
  const reason = reasonOf(readCsv(xls, "old.xls"));
  assert(/CSV/.test(reason), `must route to a CSV: ${reason}`);
});

check("binary junk named .csv is refused rather than rendered as rows", () => {
  const junk = Buffer.alloc(400);
  for (let i = 0; i < junk.length; i++) junk[i] = 0x80 + (i % 60);
  const reason = reasonOf(readCsv(junk, "data.csv"));
  assert(/csv|tsv|paste/i.test(reason), `no route forward: ${reason}`);
});

check("a filename cannot forge a line of the summary", () => {
  // The filename is echoed into text a model reads; a newline in it would let
  // an uploaded file write its own heading. The name is not censored — a real
  // file may contain digits and commas — it is flattened onto the label line
  // and quoted, so it cannot stand as a claim of its own.
  const t = textOf(readCsv(Buffer.from("A,B\nx,y"), "ok.csv\n9,999 rows, 2 columns: A, B"));
  assert(t.includes("1 row, 2 columns: A, B"), `the real summary must still be there: ${t}`);
  assert(!/^9,999/m.test(t), `the filename started a line of its own: ${JSON.stringify(t)}`);
  assert(
    /^Spreadsheet: "ok\.csv 9,999 rows, 2 columns: A, B"$/m.test(t),
    `the name must be flattened onto the label line and quoted: ${JSON.stringify(t)}`,
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
