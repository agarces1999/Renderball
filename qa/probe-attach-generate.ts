/**
 * PROBE: attach a document, then generate a deck from it.
 *
 * The two features shipped separately and were tested separately, which proves
 * nothing about the thing a user actually does: drop in the brief they already
 * have and press generate. This drives that whole journey signed in, on the
 * HARD shape — a long prose brief at the maximum page count, which pooled
 * across 98 matrix runs failed 9 times in 12 and is exactly the shape the
 * founder's own failing generation had.
 *
 * What it asserts, in order of how much it would matter if it broke:
 *   1. the outline is actually GROUNDED in the attached document — a deck that
 *      ignores the file you attached is worse than a refusal, because it looks
 *      like it worked;
 *   2. the user lands on the outline review, not back on a blank canvas;
 *   3. every page asked for exists;
 *   4. nothing on screen is wire vocabulary.
 *
 * SPENDS TOKENS: one outline call per format (~$0.05 each), no page building.
 * Deletes every document it creates, including on failure.
 *
 *   npx tsx qa/probe-attach-generate.ts            # docx + pdf
 *   FORMATS=docx npx tsx qa/probe-attach-generate.ts
 */
import { chromium, type Page } from "playwright";
import { deflateRawSync } from "zlib";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { authenticator } from "./auth";

const BASE = process.env.QA_BASE ?? "http://localhost:3000";
const PAGES = Number(process.env.PAGES ?? 12);

/**
 * The brief, as prose. Deliberately a TRANSCRIPT — long, discursive, few
 * nameable objects. That is the shape that starves a visual planner, and the
 * shape the matrix says is hardest.
 */
const BRIEF = [
  "Good morning everyone, and thank you for joining us today. We started from a simple observation: finance teams spend an enormous amount of time moving numbers between systems that were never designed to talk to each other.",
  "Reconciliation is manual. Approvals sit in inboxes. Month end is a fire drill that everybody dreads and nobody questions, because that is simply how it has always been done.",
  "Our customers told us the same thing in different words. They did not want another dashboard. They wanted the work to be smaller, and they wanted to stop hiring people whose entire job is to copy figures from one place to another.",
  "So we built something narrower than a platform and deeper than a tool. It connects to the ledgers you already use, learns the shape of your chart of accounts, and reconciles continuously rather than in a panic at the end of the month.",
  "The results have been better than we projected. Early customers are closing in four days rather than eleven. One redeployed two full time roles into analysis rather than data entry. Another told us their auditors asked what had changed.",
  "We are raising a Series A. The ask is twelve million dollars to expand into forecasting and treasury.",
];

/** Words that must survive the round trip from file to outline. */
const GROUNDING = ["reconcil", "four days", "eleven", "month end", "series a", "treasury", "ledger"];

// ── fixtures, built here so the repo carries no binaries ────────────────────
const makeDocx = (paragraphs: string[]): Buffer => {
  const xml =
    `<?xml version="1.0"?><w:document><w:body>` +
    paragraphs.map((p) => `<w:p><w:r><w:t>${p.replace(/&/g, "&amp;")}</w:t></w:r></w:p>`).join("") +
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

const makePdf = async (paragraphs: string[]): Promise<Buffer> => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  // Wrap by hand — pdf-lib does not, and a single 240-character drawText call
  // would run off the page and never be extracted.
  const wrap = (s: string, n = 82) => s.match(new RegExp(`.{1,${n}}(\\s|$)`, "g")) ?? [s];
  let page = doc.addPage([595, 842]);
  let y = 780;
  for (const para of paragraphs) {
    for (const line of wrap(para)) {
      if (y < 60) {
        page = doc.addPage([595, 842]);
        y = 780;
      }
      page.drawText(line.trim(), { x: 55, y, size: 11, font });
      y -= 16;
    }
    y -= 10;
  }
  return Buffer.from(await doc.save());
};

const JARGON = /\b(unauthorized|forbidden|undefined|NaN|\[object Object\]|TypeError|ECONN)\b/i;

const run = async () => {
  const auth = authenticator(BASE);
  if (!auth) {
    console.error("no QA credentials configured — skipping");
    process.exit(0);
  }
  const wanted = (process.env.FORMATS ?? "docx,pdf").split(",").map((s) => s.trim());
  const fixtures: { name: string; mimeType: string; buffer: Buffer }[] = [];
  if (wanted.includes("docx"))
    fixtures.push({
      name: "fuse-brief.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: makeDocx(BRIEF),
    });
  if (wanted.includes("pdf"))
    fixtures.push({ name: "fuse-brief.pdf", mimeType: "application/pdf", buffer: await makePdf(BRIEF) });

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await auth(context);

  const results: { name: string; ok: boolean; detail: string }[] = [];
  const record = (name: string, ok: boolean, detail = "") => {
    results.push({ name, ok, detail });
    console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  };

  /** Delete a document however the run ended — a failed probe must not litter. */
  const cleanup = async (page: Page, id: string) => {
    try {
      // A page navigation first: page.request cannot refresh an expired Clerk
      // token on its own (no client JS runs), so a cold fetch 404s and leaks
      // the document.
      await page.goto(`${BASE}/documents`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1200);
      const res = await page.request.delete(`${BASE}/api/documents/${id}`);
      console.log(`  · cleanup ${id} → ${res.status()}`);
    } catch (e) {
      console.log(`  · cleanup ${id} FAILED: ${e instanceof Error ? e.message : e}`);
    }
  };

  for (const fixture of fixtures) {
    console.log(`\n── ${fixture.name} × ${PAGES} pages`);
    const page = await context.newPage();
    let docId = "";
    try {
      await page.goto(`${BASE}/documents`, { waitUntil: "domcontentloaded" });
      await page.getByRole("link", { name: /new document/i }).first().click();
      await page.waitForURL(/preview|edit/, { timeout: 60_000 }).catch(() => {});
      await page.waitForTimeout(3500);
      docId = page.url().match(/\/(?:preview|edit)\/([^/?#]+)/)?.[1] ?? "";

      await page.getByText("Generate every page", { exact: false }).first().click();
      await page.waitForTimeout(700);

      const textarea = page.locator("textarea").first();
      await page.locator('input[type="file"]').first().setInputFiles(fixture);
      await page.waitForTimeout(8000);

      const brief = await textarea.inputValue();
      record(
        "the document's text reached the brief box",
        brief.length > 900 && /reconciliation is manual/i.test(brief),
        `${brief.length} chars`,
      );
      if (brief.length < 200) throw new Error("nothing was extracted; the rest of the journey is moot");

      // The page count the matrix says is hardest.
      const pageInput = page.locator('input[type="number"]').first();
      await pageInput.fill(String(PAGES));

      const started = Date.now();
      await page.getByRole("button", { name: /generate the document/i }).first().click();

      // The thinking steps should appear immediately — a silent wait is the bug
      // this replaced.
      const stepsUp = await page
        .getByText("Reading your brief", { exact: false })
        .isVisible({ timeout: 15_000 })
        .catch(() => false);
      record("thinking steps appear while it works", stepsUp);

      // Outline generation on a long brief at 12 pages measured ~75-115s; give
      // it room for a repair round or two on top.
      await page.waitForURL(/\/review\//, { timeout: 300_000 }).catch(() => {});
      const secs = Math.round((Date.now() - started) / 1000);

      const onReview = /\/review\//.test(page.url());
      record("lands on the outline review, not a blank canvas", onReview, `${secs}s`);

      if (!onReview) {
        const shown = (await page.locator("body").innerText().catch(() => "")).slice(0, 400);
        record("…failure was explained in plain English", !JARGON.test(shown), shown.replace(/\n+/g, " ").slice(0, 160));
      } else {
        await page.waitForTimeout(2500);
        const body = await page.locator("body").innerText().catch(() => "");

        // GROUNDING — the assertion that matters. An outline that ignores the
        // attached document is worse than a refusal: it looks like it worked.
        const hits = GROUNDING.filter((g) => body.toLowerCase().includes(g));
        record(
          "the outline is grounded in the attached document",
          hits.length >= 3,
          `${hits.length}/${GROUNDING.length} anchors: ${hits.join(", ") || "none"}`,
        );

        // Every page asked for exists. Count the per-scene index markers ("01",
        // "02", …) that StoryScene renders. NOT textareas: EditableHeadline is
        // a <button> until you click it, so counting textareas reported ZERO on
        // a perfectly good 12-page outline — the probe was wrong, not the app.
        const sceneCount = await page.evaluate(() =>
          [...document.querySelectorAll("div")].filter((d) =>
            /^\d{2}$/.test((d.textContent ?? "").trim()) && d.children.length === 0,
          ).length,
        );
        record(
          "the outline has a page for every page requested",
          sceneCount >= PAGES,
          `${sceneCount} pages listed, asked for ${PAGES}`,
        );

        record("a Build action is offered", /build the deck/i.test(body));
        const leaked = (body.match(JARGON) ?? [])[0];
        record("no wire vocabulary on the review", !leaked, leaked ? `found "${leaked}"` : "");
      }
    } catch (e) {
      record(`${fixture.name}: journey threw`, false, e instanceof Error ? e.message.slice(0, 160) : String(e));
    } finally {
      if (docId) await cleanup(page, docId);
      await page.close();
    }
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
