/**
 * PROBE: feature 1 of the Gamma batch (2026-08-14) — the outline TYPES
 * itself from real model tokens.
 *
 * Asserts, in one paid generation (~$0.40):
 *   1. the live manuscript replaces the paced steps (thinking phase shows)
 *   2. a page card with real text appears while the job is still running
 *   3. a mid-generation reload REPLAYS the typed text (sink replay-from-0)
 *   4. the flow still lands on /review — the poll stays the authority
 *
 *   npx tsx qa/probe-outline-stream.ts
 */
import { chromium, type Page } from "playwright";
import { authenticator } from "./auth";

const BASE = process.env.QA_BASE ?? "http://localhost:3000";
const SHOTS = "/private/tmp/claude-501/-Users-alfonsogarces-VIDEO-GEN/66a0320e-ab42-4115-8600-78bdda8062ed/scratchpad";

let failures = 0;
const expect = (ok: boolean, what: string) => {
  console.log(`  ${ok ? "✓" : "✗"} ${what}`);
  if (!ok) failures++;
};

const run = async () => {
  const auth = authenticator(BASE);
  if (!auth) {
    console.error("no QA credentials configured");
    process.exit(1);
  }
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  await auth(context);
  const page: Page = await context.newPage();
  const created: string[] = [];

  try {
    await page.goto(`${BASE}/documents`, { waitUntil: "domcontentloaded" });
    await page.getByRole("link", { name: /new document/i }).first().click();
    await page.waitForURL(/preview|edit/, { timeout: 60_000 }).catch(() => {});
    const id = /\/(?:preview|edit)\/([A-Z0-9]+)/i.exec(page.url())?.[1];
    if (id) created.push(id);
    await page.getByRole("button", { name: /start without a brand/i }).click();
    await page.getByText("Generate every page for me").click();
    await page
      .locator("textarea")
      .fill(
        "A 4-page fundraising update for Meridian Robotics: the quarter in numbers, the pilot with a national grocer, what broke and how we fixed it, the ask for intros to series-A investors.",
      );
    await page.locator('input[type="number"]').fill("4");
    await page.getByRole("button", { name: "Generate the document" }).click();

    // 1. The live manuscript's thinking phase, not the paced step list.
    const thinking = await page
      .getByText(/Reading your brief — deciding what each page must earn/)
      .waitFor({ state: "visible", timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    expect(thinking, "the live manuscript appeared (thinking phase)");

    // 2. A real typed card, while the generation is still running (we are
    // still on the panel, not on /review). Scoped to the manuscript's own
    // card hook — the first run of this probe matched the document rail's
    // permanent "01" chip and called it typing.
    const card = page.locator("[data-rb-outline-card]").first();
    const typed = await card
      .waitFor({ state: "visible", timeout: 4 * 60_000 })
      .then(() => true)
      .catch(() => false);
    const onPanel = !/\/review\//.test(page.url());
    expect(typed && onPanel, "a page card typed itself while the job was still running");
    await page.screenshot({ path: `${SHOTS}/outline-typing.png` });
    const labelText = typed ? await card.textContent().catch(() => "") : "";
    console.log(`    first card so far: ${JSON.stringify(labelText?.slice(0, 70))}`);

    // 3. Reload mid-generation: the resume card must REPLAY the typed cards.
    await page.reload({ waitUntil: "domcontentloaded" });
    const replayed = await page
      .locator("[data-rb-outline-card]")
      .first()
      .waitFor({ state: "visible", timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    expect(replayed, "a mid-generation reload replayed the typed outline (sink replay)");
    await page.screenshot({ path: `${SHOTS}/outline-typing-replayed.png` });

    // 4. The poll remains the authority: we land on review.
    const landed = await page
      .waitForURL(/\/review\//, { timeout: 8 * 60_000 })
      .then(() => true)
      .catch(() => false);
    expect(landed, "the flow still landed on the outline review");
    await page.screenshot({ path: `${SHOTS}/outline-review-after-stream.png` });
  } finally {
    for (const id of created) {
      await page.request.fetch(`${BASE}/api/documents/${id}`, {
        method: "DELETE",
        failOnStatusCode: false,
      });
    }
    await browser.close();
  }

  console.log(failures === 0 ? "\noutline-stream probe: all green" : `\noutline-stream probe: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
};

void run();
