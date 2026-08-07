/**
 * Attachment text extraction.
 *
 * The .docx path is hand-rolled ZIP reading, so it is tested against a REAL
 * zip built here byte by byte (deflated, with a central directory) rather than
 * a fixture someone has to trust. A hand-rolled reader that is only ever fed
 * hand-rolled input proves nothing, so the awkward cases are covered too: a
 * local header whose extra-field length differs from the central directory's
 * (the single easiest offset bug to write), a stored — uncompressed — entry,
 * and bytes that are not a zip at all.
 */
import { deflateRawSync } from "zlib";
import { extractText, MAX_EXTRACTED_CHARS } from "./extract-text";

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

console.log("attachment text extraction");

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

const docx = (bodyXml: string, localExtra = 0) =>
  makeZip(
    [
      { name: "[Content_Types].xml", data: Buffer.from("<Types/>") },
      { name: "word/document.xml", data: Buffer.from(bodyXml, "utf8") },
    ],
    localExtra,
  );

const PARAS = `<?xml version="1.0"?><w:document><w:body>
<w:p><w:r><w:t>Fuse Finance closes the books in four days.</w:t></w:r></w:p>
<w:p><w:r><w:t>Reconciliation is manual &amp; approvals sit in inboxes.</w:t></w:r></w:p>
</w:body></w:document>`;

await check("docx: paragraphs come out as separate lines, entities decoded", async () => {
  const r = await extractText(docx(PARAS), "brief.docx");
  assert(r.ok, `expected ok, got: ${r.reason}`);
  assert(r.text.includes("Fuse Finance closes the books in four days."), `first paragraph missing: ${r.text}`);
  assert(r.text.includes("manual & approvals"), `entity not decoded: ${r.text}`);
  assert(
    r.text.indexOf("Reconciliation") > r.text.indexOf("four days.\n") - 1 && r.text.includes("\n"),
    `paragraphs must not run together: ${JSON.stringify(r.text)}`,
  );
});

await check("docx: a local header with its own extra length still reads (offset trap)", async () => {
  const r = await extractText(docx(PARAS, 11), "brief.docx");
  assert(r.ok, `the local extra field must be used, not the central one — got: ${r.reason}`);
  assert(r.text.includes("Fuse Finance"), `text missing: ${r.text}`);
});

await check("docx: a STORED (uncompressed) entry reads", async () => {
  const zip = makeZip([{ name: "word/document.xml", data: Buffer.from(PARAS), store: true }]);
  const r = await extractText(zip, "brief.docx");
  assert(r.ok, `stored entries must work, got: ${r.reason}`);
  assert(r.text.includes("Fuse Finance"), "stored text missing");
});

await check("docx: a zip with no word/document.xml is refused kindly", async () => {
  const zip = makeZip([{ name: "notes.txt", data: Buffer.from("hi") }]);
  const r = await extractText(zip, "brief.docx");
  assert(!r.ok, "must not claim success");
  assert(!!r.reason && !/undefined|error|null/i.test(r.reason), `reason must be human: ${r.reason}`);
});

await check("docx detected by BYTES even when the extension lies", async () => {
  const r = await extractText(docx(PARAS), "brief.txt");
  assert(r.ok && r.text.includes("Fuse Finance"), `sniffing failed: ${r.reason ?? r.text.slice(0, 60)}`);
});

// ── pdf ─────────────────────────────────────────────────────────────────────
// Real PDF extraction is covered in read-pdf.test.ts against PDFs built with
// pdf-lib. What belongs HERE is only the routing and the failure wording.
await check("a DAMAGED pdf fails as a sentence, never as a library error", async () => {
  const r = await extractText(Buffer.from("%PDF-1.7\n%����\n1 0 obj"), "brief.pdf");
  assert(!r.ok, "a truncated PDF has nothing to read");
  assert(!!r.reason && /\s/.test(r.reason), `must be a sentence: ${r.reason}`);
  assert(
    !/undefined|Exception|TypeError|stack/i.test(r.reason ?? ""),
    `no library vocabulary: ${r.reason}`,
  );
});

await check("a PDF renamed .txt is still ROUTED by its bytes", async () => {
  const r = await extractText(Buffer.from("%PDF-1.4\nbinary"), "brief.txt");
  // It reaches the PDF reader (rather than the plain-text path) — which is the
  // routing claim. This particular one is unreadable, so it refuses.
  assert(!r.ok && /PDF/i.test(r.reason ?? ""), `expected the PDF path, got: ${r.reason}`);
});

// ── plain text ──────────────────────────────────────────────────────────────
await check("plain text passes through, whitespace tidied", async () => {
  const r = await extractText(Buffer.from("Line one.   \r\n\r\n\r\n\r\nLine two.\t\tTabbed."), "notes.md");
  assert(r.ok, `expected ok: ${r.reason}`);
  assert(r.text === "Line one.\n\nLine two. Tabbed.", `unexpected tidy: ${JSON.stringify(r.text)}`);
});

await check("binary junk named .txt is refused rather than poisoning the brief", async () => {
  const junk = Buffer.alloc(400);
  for (let i = 0; i < junk.length; i++) junk[i] = 0x80 + (i % 60);
  const r = await extractText(junk, "brief.txt");
  assert(!r.ok, "binary must not become brief text");
});

await check("an unsupported extension names itself and offers the way through", async () => {
  const r = await extractText(Buffer.from("x"), "deck.pptx");
  assert(!r.ok && /pptx/.test(r.reason ?? ""), `must name the format: ${r.reason}`);
  assert(/paste|txt|docx/i.test(r.reason ?? ""), `must offer a route: ${r.reason}`);
});

await check("an empty file is refused", async () => {
  const r = await extractText(Buffer.from("   \n  "), "empty.txt");
  assert(!r.ok, "empty must not count as attached");
});

// ── size ────────────────────────────────────────────────────────────────────
await check("oversized input is clamped and flagged, not rejected", async () => {
  const big = Buffer.from(("Paragraph about the close.\n\n".repeat(4000)));
  const r = await extractText(big, "long.txt");
  assert(r.ok, "a long brief is still usable");
  assert(r.text.length <= MAX_EXTRACTED_CHARS, `clamp failed: ${r.text.length}`);
  assert(r.truncated === true, "truncation must be reported so the UI can say so");
  assert(!/Paragraph about the clos$/.test(r.text), "should not end mid-word");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
