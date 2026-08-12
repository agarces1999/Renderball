/**
 * PROBE: stop a running build (journey 2 of probe-build-progress-stop,
 * standalone — the combined probe's second outline hit the outline-stall bug,
 * not a stop-path defect, so the stop verification reruns alone).
 *
 * SPENDS REAL TOKENS (~$0.50: one outline + a stopped build start).
 *   npx tsx qa/probe-build-stop.ts
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

const BRIEF =
  "A 3-page team update for Northwind Coffee: quarterly numbers, one customer story, and a hiring ask.";

const run = async () => {
  const auth = authenticator(BASE);
  if (!auth) {
    console.error("no QA credentials configured");
    process.exit(1);
  }
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await auth(context);
  const page: Page = await context.newPage();
  const created: string[] = [];

  try {
    await page.goto(`${BASE}/documents`, { waitUntil: "domcontentloaded" });
    await page.getByRole("link", { name: /new document/i }).first().click();
    await page.waitForURL(/preview|edit/, { timeout: 60_000 }).catch(() => {});
    const id = /\/(?:preview|edit)\/([A-Z0-9]+)/i.exec(page.url())?.[1] ?? null;
    if (id) created.push(id);
    await page.getByRole("button", { name: /start without a brand/i }).click();
    await page.getByText("Generate every page for me").click();
    await page.locator("textarea").fill(BRIEF);
    await page.locator('input[type="number"]').fill("3");
    await page.getByRole("button", { name: "Generate the document" }).click();
    await page.waitForURL(/\/review\//, { timeout: 8 * 60_000 });
    console.log(`  outline approved for ${id}`);

    await page.getByRole("link", { name: /^Build the/ }).first().click();
    await page.waitForURL(/\/preview\//, { timeout: 60_000 });

    const stop = page.getByRole("button", { name: /stop this build/i });
    await stop.waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForTimeout(8_000); // let it be genuinely mid-flight
    await stop.click();

    expect(
      await page
        .getByText("You stopped this build")
        .waitFor({ state: "visible", timeout: 3 * 60_000 })
        .then(() => true)
        .catch(() => false),
      "the stopped screen arrives (cooperative — next phase edge)",
    );
    await page.screenshot({ path: `${SHOTS}/build-stopped.png` });

    await page.getByRole("link", { name: /back to your outline/i }).first().click();
    expect(
      await page
        .waitForURL(/\/review\//, { timeout: 30_000 })
        .then(() => true)
        .catch(() => false),
      "the exit lands on the approved outline, intact",
    );
  } finally {
    for (const id of created) {
      await page.request.fetch(`${BASE}/api/documents/${id}`, {
        method: "DELETE",
        failOnStatusCode: false,
      });
    }
    await browser.close();
  }

  console.log(failures === 0 ? "\nstop probe: all green" : `\nstop probe: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
};

void run();
