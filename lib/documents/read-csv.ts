import { MAX_EXTRACTED_CHARS } from "./extract-text";

/**
 * Read a spreadsheet export as labelled records instead of raw commas.
 *
 * WHY THIS EXISTS: .csv and .tsv sit in the plain-text list in extract-text.ts,
 * so a spreadsheet reached the brief exactly as exported — one header line and
 * then thousands of comma-separated values with nothing next to them saying
 * what they are. Every guarantee below is deterministic and costs no tokens.
 *
 * WHY RECORDS AND NOT A COMPACT ALIGNED TABLE: a table only reads correctly if
 * the reader holds the header line in mind and counts columns on every line
 * after it. When that slips — a wide export, a blank cell, one row carrying an
 * extra unquoted comma — it slips SILENTLY: a value lands under the wrong
 * heading and is then indistinguishable from a fact. Putting the column name
 * beside its value makes each line self-describing, so a shifted row looks
 * strange rather than reading as true. Alignment padding also spends
 * characters that carry no meaning. The price is verbosity, which the row cap
 * below bounds; the table's price is confidently wrong values, which nothing
 * bounds. Single-column and headerless files get their own shapes further
 * down, because "Column 1: value" repeated down a list of email addresses is
 * the verbosity without any of the labelling benefit.
 */

export type CsvResult = { ok: true; text: string } | { ok: false; reason: string };

/** Rows rendered at most. Anything past this is counted and declared missing. */
export const MAX_CSV_ROWS = 200;

/** Columns rendered at most, so one 200-column export cannot crowd out the rows. */
export const MAX_CSV_COLUMNS = 30;

/**
 * A single cell longer than this is trimmed. A free-text column — survey
 * answers, meeting notes — otherwise lets ONE row spend the whole character
 * budget, and the file then reports "1 of 900 rows shown", which is true and
 * useless.
 */
const MAX_CELL_CHARS = 500;

/** Delimiters worth guessing between, in preference order for a tie. */
const DELIMITERS = [",", ";", "\t", "|"];

/** Enough of the file to judge the delimiter without parsing 10 MB four times. */
const SNIFF_CHARS = 64_000;

// ── parsing ─────────────────────────────────────────────────────────────────

interface Parsed {
  /** Rows kept in memory, capped by `keep`. */
  rows: string[][];
  /** Every non-empty row in the file, including the ones not kept. */
  total: number;
}

/**
 * RFC 4180 with the leniencies real exporters need.
 *
 * Written as a character walk rather than split-then-split because a quoted
 * cell may contain the delimiter, a line break, or a doubled quote standing
 * for one quote — `Acme,"Closed, finally"` is two fields, and every naive
 * split turns it into three and shifts every column after it.
 *
 * @param keep rows past this are counted but not stored, so a 200k-row export
 *   cannot hold 200k arrays in memory just to report an honest total.
 */
const parseDelimited = (text: string, delimiter: string, keep = Infinity): Parsed => {
  const rows: string[][] = [];
  let total = 0;
  let row: string[] = [];
  let field = "";
  let quoted = false;

  const endRow = () => {
    row.push(field);
    field = "";
    // A blank line between blocks of data is not a row of empty values; Excel
    // and Sheets both emit one at the end of the file. Whitespace-only counts
    // as blank HERE so that the count reported to the user and the rows the
    // renderer can actually draw cannot disagree — a row of three spaces would
    // otherwise be counted in the total and then quietly render as nothing,
    // making the file claim a row was left out when none was.
    if (row.some((c) => c.trim() !== "")) {
      total++;
      if (rows.length < keep) rows.push(row);
    }
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'; // "" inside quotes is one literal quote
          i++;
          continue;
        }
        quoted = false;
        continue;
      }
      if (ch === "\r") {
        // A line break inside a quoted cell — a postal address, usually — is
        // part of the value. Keeping the CR would leave a stray carriage
        // return sitting in the middle of a name later on.
        field += "\n";
        if (text[i + 1] === "\n") i++;
        continue;
      }
      field += ch;
      continue;
    }

    // A quote only opens a cell at its start. Leading spaces before it are
    // padding some writers add after the delimiter, not part of the value.
    if (ch === '"' && field.trim() === "") {
      field = "";
      quoted = true;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = "";
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      // CRLF, LF and the bare CR that older Mac exports still use.
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRow();
      continue;
    }
    field += ch;
  }
  if (field !== "" || row.length > 0) endRow();

  return { rows, total };
};

const modeOf = (counts: number[]): number => {
  const tally = new Map<number, number>();
  for (const n of counts) tally.set(n, (tally.get(n) ?? 0) + 1);
  let best = 0;
  let bestSeen = 0;
  for (const [n, seen] of Array.from(tally.entries())) {
    if (seen > bestSeen || (seen === bestSeen && n > best)) {
      best = n;
      bestSeen = seen;
    }
  }
  return best;
};

/**
 * Guess the delimiter by parsing with each candidate and keeping the one whose
 * rows come out the same width.
 *
 * WHY NOT COUNT CHARACTERS: a German export of `Name;Notes` where one note
 * reads `"a, b, c, d"` contains more commas than semicolons, so the obvious
 * "most frequent separator" test picks comma and shreds every row. Consistency
 * of field count is the signal that actually survives quoted content — under
 * comma that file yields 1, 4, 4, 4 fields; under semicolon, 2, 2, 2, 2.
 */
const sniffDelimiter = (text: string, filename: string): string => {
  const sample = text.slice(0, SNIFF_CHARS);
  const cut = sample.length < text.length;
  // A .tsv that happens to parse equally well either way is a .tsv.
  const candidates = /\.tsv$/i.test(filename)
    ? ["\t", ...DELIMITERS.filter((d) => d !== "\t")]
    : DELIMITERS;

  let best = ",";
  let bestScore = -1;
  for (const d of candidates) {
    const rows = parseDelimited(sample, d).rows.slice(0, 20);
    // The last row of a cut sample is half a row; it would fake a disagreement.
    if (cut && rows.length > 1) rows.pop();
    if (rows.length === 0) continue;

    const counts = rows.map((r) => r.length);
    const mode = modeOf(counts);
    if (mode < 2) continue; // this delimiter does not appear at all
    const agreement = counts.filter((c) => c === mode).length / counts.length;
    // Agreement dominates; column count only breaks ties between delimiters
    // that both parse cleanly, where the one finding more structure wins.
    const score = agreement * 100 + Math.min(mode, 20);
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
};

// ── shaping ─────────────────────────────────────────────────────────────────

/** Currency, percentages, thousands separators, accounting negatives. */
const NUMERIC = /^[-+(]?[$€£¥]?\s?\d[\d\s.,]*%?\)?$/;
const DATEISH = /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$/;
const YEARISH = /^(19|20)\d{2}$/;
const EMAILISH = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URLISH = /^(https?:\/\/|www\.)/i;

/**
 * Decide whether the first row names the columns.
 *
 * CSV cannot settle this — the format has no way to say so — so this is a
 * heuristic, and the rendered text always states which way it went, which is
 * the part that matters: a reader can see the call that was made.
 *
 * Two traps this has to survive. A revenue-by-year export puts 2023, 2024,
 * 2025 in the header, so a plain is-it-a-number test throws the header away
 * and unlabels the whole file — hence the year exemption. A one-column list of
 * email addresses or links has no header at all, and promoting the first
 * address to a column name both invents a heading and loses a value.
 */
const looksLikeHeader = (first: string[]): boolean => {
  const cells = first.map((c) => c.trim());
  if (cells.every((c) => c === "")) return false;
  // Exported pivot tables leave the index column's heading blank; two or more
  // blanks is a data row with gaps.
  if (cells.filter((c) => c === "").length > 1) return false;
  return cells.every((c) => {
    if (c === "") return true;
    if (c.length > 60) return false; // prose, not a heading
    if (EMAILISH.test(c) || URLISH.test(c)) return false;
    if (DATEISH.test(c)) return false;
    if (NUMERIC.test(c)) return YEARISH.test(c);
    return true;
  });
};

/** Whitespace inside a cell, without destroying a deliberate line break. */
const tidyCell = (s: string): string =>
  s
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();

/** Carried through the render rather than kept at module scope, so two callers
 * can never see each other's trimming. */
interface Trimmed {
  any: boolean;
}

const cellValue = (raw: string | undefined, trimmed: Trimmed): string => {
  const v = tidyCell(raw ?? "");
  if (v.length <= MAX_CELL_CHARS) return v;
  trimmed.any = true;
  return `${v.slice(0, MAX_CELL_CHARS).trimEnd()}…`;
};

/** Thousands separators without toLocaleString, whose output follows the host
 * machine's locale — the same export would then describe itself differently on
 * a laptop and on the server. */
const num = (n: number): string => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const plural = (n: number, one: string, many: string): string =>
  `${num(n)} ${n === 1 ? one : many}`;

/**
 * One row as its own labelled block. Empty cells are dropped rather than
 * printed as `Notes:` with nothing after them — sparse exports are mostly
 * blanks, and the column list at the top already says the column exists.
 */
const renderRecord = (n: number, names: string[], cells: string[], trimmed: Trimmed): string => {
  const lines = [`Row ${n}`];
  for (let i = 0; i < Math.max(names.length, cells.length); i++) {
    const value = cellValue(cells[i], trimmed);
    if (!value) continue;
    const name = names[i] ?? `Column ${i + 1}`;
    // A quoted multi-line address would otherwise put its second line hard
    // against the left margin, where it reads as the start of a new record.
    lines.push(`  ${name}: ${value.replace(/\n/g, "\n    ")}`);
  }
  return lines.length > 1 ? lines.join("\n") : "";
};

/** Fill up to the character budget and report what actually fit. */
const takeUnderBudget = (blocks: string[], budget: number, gap: number): string[] => {
  const kept: string[] = [];
  let used = 0;
  for (const block of blocks) {
    if (used + block.length + gap > budget) break;
    kept.push(block);
    used += block.length + gap;
  }
  return kept;
};

const NOT_A_CSV =
  "That file isn't a CSV — it looks like an Excel workbook or another Office document. Open it and save a copy as CSV (in Excel: File → Save As → CSV), then attach that.";

/** Both no-rows cases end here, because "it's empty" on its own leaves someone
 * staring at a file they can see has numbers in it. */
const NO_ROWS_ROUTE = "Check the export saved with its rows in it, or paste the numbers into the brief.";

// ── entry point ─────────────────────────────────────────────────────────────

/**
 * @param filename used to prefer tabs for a .tsv and to name the file in the
 *   text. Never trusted as a path.
 */
export const readCsv = (buf: Buffer, filename: string): CsvResult => {
  const trimmed: Trimmed = { any: false };

  // Newlines, tabs and quotes out of the filename: it is echoed into text a
  // model reads, so a file named `q3.csv\n9,999 rows, 2 columns: A, B` would
  // otherwise write a line indistinguishable from the summary below it.
  // Flattened and then quoted at the label, the name cannot reach past its own
  // quotes, and the counts on the next line are the ones that count.
  const name = filename.replace(/[\r\n\t"]+/g, " ").trim().slice(0, 120);

  // .xlsx is a ZIP and .xls is an OLE compound file. Both get attached as "the
  // spreadsheet" constantly, and read as UTF-8 they become pages of noise.
  const isZip = buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50;
  const isOldOffice = buf.length >= 8 && buf.readUInt32LE(0) === 0xe011cfd0;
  if (isZip || isOldOffice) return { ok: false, reason: NOT_A_CSV };

  let text = buf.toString("utf8");
  // Excel writes UTF-8 with a byte-order mark; left in place it becomes part of
  // the first column's name, so every label after it is right and the first one
  // is invisibly wrong.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const replacements = (text.match(/�/g) ?? []).length;
  if (replacements > Math.max(8, text.length * 0.01)) {
    return {
      ok: false,
      reason:
        "That file doesn't look like a spreadsheet export. A .csv or .tsv saved from Excel, Numbers or Google Sheets works — or paste the numbers into the brief.",
    };
  }
  if (!text.trim()) {
    return { ok: false, reason: `That file is empty — there was nothing in it to read. ${NO_ROWS_ROUTE}` };
  }

  // Excel in several European locales writes a `sep=;` line above the data.
  // It is an instruction to the reader, not a row, and it says outright what
  // the sniffer would otherwise have to guess.
  let forced = "";
  const declaredSep = text.match(/^sep=(.)\r?\n/i);
  if (declaredSep) {
    forced = declaredSep[1];
    text = text.slice(declaredSep[0].length);
  }

  const delimiter = forced || sniffDelimiter(text, name);
  const { rows, total } = parseDelimited(text, delimiter, MAX_CSV_ROWS + 1);
  if (rows.length === 0) {
    return { ok: false, reason: `Every line in that file was blank. ${NO_ROWS_ROUTE}` };
  }

  const hasHeader = looksLikeHeader(rows[0]);
  const headerCells = hasHeader ? rows[0] : [];
  const dataRows = (hasHeader ? rows.slice(1) : rows).slice(0, MAX_CSV_ROWS);
  const totalData = total - (hasHeader ? 1 : 0);

  const widest = Math.max(headerCells.length, ...dataRows.map((r) => r.length), 1);
  const keptCols = Math.min(widest, MAX_CSV_COLUMNS);
  const names: string[] = [];
  for (let i = 0; i < keptCols; i++) {
    names.push(cellValue(headerCells[i], trimmed).replace(/\n/g, " ") || `Column ${i + 1}`);
  }

  const label = name ? `Spreadsheet: "${name}"` : "Spreadsheet";

  if (dataRows.length === 0) {
    // Header and nothing under it. The column names are still worth having, and
    // saying there is no data beats an empty-looking success.
    return {
      ok: true,
      text: `${label}\nNo data rows — the file has only column headings: ${names.join(", ")}`,
    };
  }

  // Leave room for the summary above and the closing note below, both of which
  // are written after the rows are laid out and their true count is known.
  const budget = MAX_EXTRACTED_CHARS - 800;

  let body: string;
  let shown: number;
  let description: string;

  if (keptCols === 1) {
    // A list. `Column 1: value` down 200 lines is the record form's cost with
    // none of its benefit, since there is only ever one thing a value can be.
    const items = dataRows
      .map((r) => `- ${cellValue(r[0], trimmed).replace(/\n/g, " ")}`)
      .filter((l) => l !== "- ");
    const kept = takeUnderBudget(items, budget, 1);
    shown = kept.length;
    body = kept.join("\n");
    description = hasHeader
      ? `${plural(totalData, "value", "values")} in one column, "${names[0]}".`
      : `${plural(totalData, "value", "values")} in one column. This file has no header row.`;
  } else if (!hasHeader) {
    // No names to attach, so inventing `Column 3:` labels would only dress up
    // the position the value already had.
    const blocks = dataRows.map((r, i) => {
      const cells = Array.from({ length: keptCols }, (_, c) =>
        cellValue(r[c], trimmed).replace(/\n/g, " "),
      );
      return `Row ${i + 1}: ${cells.join(" | ")}`;
    });
    const kept = takeUnderBudget(blocks, budget, 1);
    shown = kept.length;
    body = kept.join("\n");
    description = `${plural(totalData, "row", "rows")}, ${plural(widest, "column", "columns")}. This file has no header row, so the values below carry no column names and appear in the order they were written.`;
  } else {
    const blocks: string[] = [];
    for (const r of dataRows) {
      const block = renderRecord(blocks.length + 1, names, r.slice(0, keptCols), trimmed);
      if (block) blocks.push(block);
    }
    const kept = takeUnderBudget(blocks, budget, 2);
    shown = kept.length;
    body = kept.join("\n\n");
    description = `${plural(totalData, "row", "rows")}, ${plural(widest, "column", "columns")}: ${names.join(", ")}`;
  }

  const head = [label, description];
  if (keptCols < widest) {
    head.push(`Only the first ${num(keptCols)} of ${num(widest)} columns are shown.`);
  }
  if (shown < totalData) {
    // Stated before the data, not only after it. Silent truncation reads as the
    // whole file, and a total computed from a fifth of the rows is the kind of
    // number that ends up on a slide.
    head.push(
      `Only the first ${plural(shown, "row", "rows")} of ${num(totalData)} are shown below — any count or total taken from this text covers those ${num(shown)}, not the whole file.`,
    );
  }
  if (trimmed.any) {
    head.push(`Values longer than ${num(MAX_CELL_CHARS)} characters end with … where they were trimmed.`);
  }

  const tail =
    shown < totalData ? `\n\n(Ends here. ${plural(totalData - shown, "row was", "rows were")} left out.)` : "";

  return { ok: true, text: `${head.join("\n")}\n\n${body}${tail}` };
};
