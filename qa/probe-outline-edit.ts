/**
 * PROBE: the outline is editable — the founder's original ask (2026-08-13),
 * delivered the second time: not the brief, the OUTLINE. Visible controls,
 * page CRUD, and a paid single-page AI rewrite that leaves the rest alone.
 *
 * SPENDS REAL TOKENS (~$0.50: one outline + one single-page rewrite).
 *   npx tsx qa/probe-outline-edit.ts
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
    // ── an outline to edit ──────────────────────────────────────────────────
    await page.goto(`${BASE}/documents`, { waitUntil: "domcontentloaded" });
    await page.getByRole("link", { name: /new document/i }).first().click();
    await page.waitForURL(/preview|edit/, { timeout: 60_000 }).catch(() => {});
    const id = /\/(?:preview|edit)\/([A-Z0-9]+)/i.exec(page.url())?.[1];
    if (id) created.push(id);
    await page.getByRole("button", { name: /start without a brand/i }).click();
    await page.getByText("Generate every page for me").click();
    await page
      .locator("textarea")
      .fill("A 3-page team update for Northwind Coffee: the quarter's numbers, one customer story, a hiring ask.");
    await page.locator('input[type="number"]').fill("3");
    await page.getByRole("button", { name: "Generate the document" }).click();
    await page.waitForURL(/\/review\//, { timeout: 8 * 60_000 });
    console.log(`  outline ready for ${id}`);

    const cards = page.locator("div.group");
    const headlines = () =>
      page.locator("div.group").evaluateAll((els) =>
        els.map((el) => el.querySelector("button.font-display")?.textContent?.trim() ?? ""),
      );

    // ── visible controls ────────────────────────────────────────────────────
    await cards.first().hover();
    expect(
      await cards.first().getByRole("button", { name: "↓" }).isVisible().catch(() => false),
      "move controls are visible on the card",
    );
    expect(
      await cards.first().getByRole("button", { name: "Rewrite…" }).isVisible().catch(() => false),
      "the AI rewrite control is visible on the card",
    );

    // ── reorder ─────────────────────────────────────────────────────────────
    const before = await headlines();
    await cards.first().getByRole("button", { name: "↓" }).click();
    await page.waitForTimeout(800);
    const after = await headlines();
    expect(
      before.length === after.length && after[1] === before[0] && after[0] === before[1],
      `page 1 moved down (was [${before.join(" | ")}], now [${after.join(" | ")}])`,
    );

    // ── add a page ──────────────────────────────────────────────────────────
    await page.getByRole("button", { name: /add a page after 1/i }).click();
    await page.waitForTimeout(800);
    expect(
      (await headlines()).length === before.length + 1,
      "a page was added in place",
    );
    expect(
      await page.getByText("New page — click to write its headline").isVisible().catch(() => false),
      "the new page announces itself as editable",
    );

    // ── edit the supporting line — ON A PAGE THAT STAYS. The first run of
    // this probe typed into the first empty lede slot, which was the freshly
    // added page, then deleted that page and reported its line "lost". The
    // target is now the FIRST card's lede, kept for the reload assertion. ──
    await page.locator("div.group").first().locator("[data-rb-lede]").click();
    await page.keyboard.press("Meta+A");
    await page.keyboard.type("A supporting line typed by the probe.");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(800);
    expect(
      await page.getByText("A supporting line typed by the probe.").isVisible().catch(() => false),
      "the supporting line is editable and persists optimistically",
    );

    // ── delete the added page ───────────────────────────────────────────────
    const count = (await headlines()).length;
    const newCard = page.locator("div.group", { hasText: "New page — click" }).first();
    await newCard.hover();
    await newCard.getByRole("button", { name: "✕" }).click();
    await page.waitForTimeout(800);
    expect((await headlines()).length === count - 1, "the added page deletes cleanly");

    // ── reload: every op actually persisted ─────────────────────────────────
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    const persisted = await headlines();
    expect(
      persisted[0] === before[1] && persisted.length === before.length,
      "reorder + add + delete all survived a reload (server truth)",
    );
    expect(
      await page.getByText("A supporting line typed by the probe.").isVisible().catch(() => false),
      "the edited supporting line survived a reload",
    );

    // ── the paid single-page rewrite ────────────────────────────────────────
    const target = page.locator("div.group").first();
    await target.hover();
    await target.getByRole("button", { name: "Rewrite…" }).click();
    await page
      .locator("textarea")
      .last()
      .fill("Make this page about espresso machines specifically — the headline must contain the word espresso.");
    const others = (await headlines()).slice(1);
    await page.getByRole("button", { name: "Rewrite this page" }).click();
    const landed = await page
      .waitForFunction(
        () => /espresso/i.test(document.querySelector("div.group button.font-display")?.textContent ?? ""),
        undefined,
        { timeout: 6 * 60_000 },
      )
      .then(() => true)
      .catch(() => false);
    expect(landed, "the AI rewrite landed on the one page it was asked about");
    const afterRewrite = await headlines();
    expect(
      JSON.stringify(afterRewrite.slice(1)) === JSON.stringify(others),
      "every other page is untouched by the rewrite",
    );
    await page.screenshot({ path: `${SHOTS}/outline-edit.png`, fullPage: true });
  } finally {
    for (const id of created) {
      await page.request.fetch(`${BASE}/api/documents/${id}`, {
        method: "DELETE",
        failOnStatusCode: false,
      });
    }
    await browser.close();
  }

  console.log(failures === 0 ? "\noutline-edit probe: all green" : `\noutline-edit probe: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
};

void run();
