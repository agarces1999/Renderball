/**
 * PROBE: attaching a document to the brief box.
 *
 * Founder: "i should also be able to attach docs in that box." This drives the
 * REAL signed-in path — new document → Generate every page → attach — and
 * checks the things that would make the feature a lie:
 *
 *   - the text actually LANDS in the brief box (not just a filename chip);
 *   - attaching does not destroy what the user already typed;
 *   - a .docx is read, not just plain text;
 *   - a PDF is refused with a route forward rather than silently mangled;
 *   - no failure path shows wire vocabulary. A signed-out attach used to say,
 *     in full, "unauthorized" — that is the bug this probe exists to catch
 *     coming back.
 *
 * It STOPS before generating: no tokens are spent.
 *
 *   npx tsx qa/probe-attach-doc.ts
 */
import { chromium } from "playwright";
import { deflateRawSync } from "zlib";
import { authenticator } from "./auth";

const BASE = process.env.QA_BASE ?? "http://localhost:3000";

/** A real .docx, built here so the probe carries no binary fixture. */
const makeDocx = (paragraphs: string[]): Buffer => {
  const xml =
    `<?xml version="1.0"?><w:document><w:body>` +
    paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("") +
    `</w:body></w:document>`;
  const entries = [
    { name: "[Content_Types].xml", data: Buffer.from("<Types/>") },
    { name: "word/document.xml", data: Buffer.from(xml, "utf8") },
  ];
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const body = deflateRawSync(e.data);
    const name = Buffer.from(e.name, "utf8");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + body.length;
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

/** Wire vocabulary that must never reach a person. */
const JARGON = /\b(unauthorized|forbidden|null|undefined|NaN|\[object Object\]|500|502|ECONN|TypeError)\b/i;

const run = async () => {
  const auth = authenticator(BASE);
  if (!auth) {
    console.error("no QA credentials configured (QA_TEST_EMAIL / QA_TEST_PASSWORD) — skipping");
    process.exit(0);
  }
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await auth(context);
  const page = await context.newPage();
  const results: { name: string; ok: boolean; detail: string }[] = [];
  const record = (name: string, ok: boolean, detail = "") => {
    results.push({ name, ok, detail });
    console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  };

  await page.goto(`${BASE}/documents`, { waitUntil: "domcontentloaded" });
  await page.getByRole("link", { name: /new document/i }).first().click();
  await page.waitForURL(/preview|edit/, { timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(3500);

  await page.getByText("Generate every page", { exact: false }).first().click();
  await page.waitForTimeout(600);

  const textarea = page.locator("textarea").first();
  const input = page.locator('input[type="file"]').first();

  // Type first, so the append-not-replace promise is under test.
  const typed = "A pitch deck for Fuse Finance.";
  await textarea.fill(typed);

  // ── .docx ────────────────────────────────────────────────────────────────
  await input.setInputFiles({
    name: "brief.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer: makeDocx([
      "Reconciliation is manual and approvals sit in inboxes.",
      "Early customers close in four days rather than eleven.",
    ]),
  });
  await page.waitForTimeout(3000);

  const afterDocx = await textarea.inputValue();
  record(
    "docx text lands in the brief box",
    afterDocx.includes("Early customers close in four days"),
    `${afterDocx.length} chars`,
  );
  record("what the user typed survives the attach", afterDocx.startsWith(typed));
  record(
    "the filename is acknowledged on screen",
    await page.getByText("brief.docx", { exact: false }).isVisible({ timeout: 5000 }).catch(() => false),
  );

  // ── pdf ──────────────────────────────────────────────────────────────────
  const beforePdf = await textarea.inputValue();
  await input.setInputFiles({
    name: "deck.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.7\nbinary junk\n"),
  });
  await page.waitForTimeout(3000);

  const body = await page.locator("body").innerText().catch(() => "");
  // Every line mentioning PDF, not the FIRST — the page also carries an
  // "Export PDF" button, which the first version of this probe matched and
  // then reported the feature broken. A probe that can fail on the wrong
  // string is worse than no probe.
  const pdfLines = (body.match(/[^\n]*PDF[^\n]*/gi) ?? []).filter((l) => !/export/i.test(l));
  const pdfMessage = pdfLines.find((l) => /paste|copy/i.test(l)) ?? pdfLines[0] ?? "";
  record("a PDF is refused, with a way forward", /paste|copy/i.test(pdfMessage), pdfMessage.slice(0, 100));
  record("a refused PDF does not touch the brief", (await textarea.inputValue()) === beforePdf);

  // ── no wire vocabulary anywhere on screen ────────────────────────────────
  const leaked = (body.match(JARGON) ?? [])[0];
  record("no wire vocabulary shown to the user", !leaked, leaked ? `found "${leaked}"` : "");

  // Leave nothing behind: the document was never generated, so delete it.
  const docUrl = page.url();
  const id = docUrl.match(/\/(?:preview|edit)\/([^/?#]+)/)?.[1];
  if (id) {
    await page.goto(`${BASE}/documents`, { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForTimeout(1500);
    const res = await page
      .request.delete(`${BASE}/api/documents/${id}`)
      .catch(() => null);
    console.log(`\ncleanup: ${id} → ${res ? res.status() : "failed"}`);
  }

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
