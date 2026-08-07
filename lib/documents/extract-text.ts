import { inflateRawSync } from "zlib";

/**
 * Pull the readable text out of a brief someone attached.
 *
 * WHY NO PARSER DEPENDENCY: the formats worth supporting on day one are plain
 * text and .docx, and neither needs one. A .docx is a ZIP holding an XML
 * document, and node ships the inflate. Reaching for a PDF text-extraction
 * library is a genuine supply-chain decision — sizeable, and it runs on
 * user-supplied bytes — so it stays a founder call rather than something that
 * arrives by accident. A PDF is REFUSED CLEARLY here instead of being silently
 * mangled into the mojibake that a naive byte-scrape produces.
 *
 * Everything here is deterministic and costs no tokens.
 */

/** How much of one attachment can reach the brief. Roughly 8-10k words. */
export const MAX_EXTRACTED_CHARS = 50_000;

export interface ExtractResult {
  ok: boolean;
  text: string;
  /** Shown to the user verbatim when ok is false. Never a raw error. */
  reason?: string;
  truncated?: boolean;
}

const PLAIN_EXTENSIONS = new Set([
  "txt", "md", "markdown", "mdx", "csv", "tsv", "json", "yaml", "yml", "log", "text",
]);

const extensionOf = (filename: string): string =>
  (filename.split(".").pop() ?? "").toLowerCase();

/** Collapse the runaway whitespace that survives every extraction path. */
const tidy = (raw: string): string =>
  raw
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const clamp = (text: string): ExtractResult => {
  if (text.length <= MAX_EXTRACTED_CHARS) return { ok: true, text };
  // Cut at a paragraph if one is near the limit, so the brief does not end
  // mid-sentence — the model reads this as prose.
  const cut = text.slice(0, MAX_EXTRACTED_CHARS);
  const at = cut.lastIndexOf("\n\n");
  return { ok: true, text: at > MAX_EXTRACTED_CHARS * 0.6 ? cut.slice(0, at) : cut, truncated: true };
};

// ── .docx ───────────────────────────────────────────────────────────────────
// A .docx is a ZIP. Find word/document.xml in the central directory, inflate
// it, and strip the markup. Paragraph and line-break tags become newlines
// FIRST, or every paragraph runs together into one wall of text.

/** Locate a file in a ZIP central directory and return its raw bytes. */
const readZipEntry = (buf: Buffer, wanted: string): Buffer | null => {
  // End of central directory: signature 0x06054b50, scanned from the back
  // because it is followed by a variable-length comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66_000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16); // offset of central directory

  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");

    if (name === wanted) {
      // The local header repeats the name and extra field with its OWN
      // lengths — the central directory's extra length is frequently
      // different, and using it here reads from the wrong offset.
      if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) return null;
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      const body = buf.subarray(start, start + compSize);
      if (method === 0) return Buffer.from(body); // stored
      if (method === 8) {
        try {
          return inflateRawSync(body);
        } catch {
          return null;
        }
      }
      return null;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
};

const decodeXmlEntities = (s: string): string =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&"); // last, or the others double-decode

const docxToText = (buf: Buffer): string | null => {
  const xml = readZipEntry(buf, "word/document.xml");
  if (!xml) return null;
  const text = xml
    .toString("utf8")
    // Structure first, while the tags still exist.
    .replace(/<w:p\b[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<w:br\b[^>]*\/?>/g, "\n")
    .replace(/<w:tab\b[^>]*\/?>/g, " ")
    .replace(/<[^>]+>/g, "");
  return tidy(decodeXmlEntities(text));
};

/**
 * @param filename used only to pick a strategy; never trusted as a path.
 */
export const extractText = (buf: Buffer, filename: string): ExtractResult => {
  const ext = extensionOf(filename);

  // Sniff the real bytes rather than trusting the extension: a renamed PDF
  // should get the PDF message, not a screenful of binary.
  const isPdf = buf.length > 4 && buf.subarray(0, 5).toString("latin1") === "%PDF-";
  const isZip = buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;

  if (isPdf || ext === "pdf") {
    return {
      ok: false,
      text: "",
      reason:
        "PDFs aren't supported yet — open it, copy the text and paste it into the brief. Word documents and plain text files work.",
    };
  }

  if (ext === "docx" || (isZip && ext !== "zip")) {
    const text = docxToText(buf);
    if (text === null) {
      return {
        ok: false,
        text: "",
        reason: "That Word file couldn't be read. Copying the text straight into the brief always works.",
      };
    }
    if (!text) {
      return { ok: false, text: "", reason: "That document looks empty — there was no text to read." };
    }
    return clamp(text);
  }

  if (ext === "doc") {
    return {
      ok: false,
      text: "",
      reason:
        "That's the older .doc format. Re-save it as .docx, or paste the text into the brief.",
    };
  }

  if (PLAIN_EXTENSIONS.has(ext) || ext === "") {
    const text = buf.toString("utf8");
    // A binary file read as utf8 is mostly replacement characters. Catching it
    // here is what stops a stray upload from poisoning the brief.
    const replacements = (text.match(/�/g) ?? []).length;
    if (replacements > Math.max(8, text.length * 0.01)) {
      return {
        ok: false,
        text: "",
        reason: "That file doesn't look like text. Try a .txt, .md or .docx file.",
      };
    }
    const tidied = tidy(text);
    if (!tidied) return { ok: false, text: "", reason: "That file is empty." };
    return clamp(tidied);
  }

  return {
    ok: false,
    text: "",
    reason: `.${ext} files aren't supported. Attach a .txt, .md or .docx — or paste the text into the brief.`,
  };
};
