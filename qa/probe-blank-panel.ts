/**
 * PROBE: does a brand-new document actually show the BlankDocumentPanel?
 *
 * Founder (2026-08-03): "i just pressed new document and it take me to the
 * editor and there is no clear way to get it generated end to end." The panel
 * exists in code and isBlankScript should be true at birth — so drive the
 * REAL signed-in path and look.
 *
 *   npx tsx qa/probe-blank-panel.ts
 */
import { chromium } from "playwright";
import { authenticator } from "./auth";

const BASE = process.env.QA_BASE ?? "http://localhost:3000";

const run = async () => {
  const auth = authenticator(BASE);
  if (!auth) {
    console.error("no QA credentials configured");
    process.exit(1);
  }
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await auth(context);
  const page = await context.newPage();

  await page.goto(`${BASE}/documents`, { waitUntil: "domcontentloaded" });
  await page.getByRole("link", { name: /new document/i }).first().click();
  await page.waitForURL(/preview|new|edit/, { timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(4000);

  const url = page.url();
  const ceremony = await page.getByText("Whose document is this?").isVisible().catch(() => false);
  console.log(`ceremony beat 1 ("Whose document is this?") visible: ${ceremony}`);
  if (ceremony) {
    await page.getByRole("button", { name: /start without a brand/i }).click();
    await page.waitForTimeout(800);
  }
  const panel = await page.getByText("How do you want to start?").isVisible().catch(() => false);
  const generateEvery = await page.getByText("Generate every page", { exact: false }).isVisible().catch(() => false);
  const bodyText = (await page.locator("body").innerText().catch(() => "")).slice(0, 400);

  console.log(`url: ${url}`);
  console.log(`"How do you want to start?" visible: ${panel}`);
  console.log(`"Generate every page" visible: ${generateEvery}`);

  if (panel) {
    // Dismiss, then the full-deck path must STILL be one click away.
    await page.getByText("Build it yourself").click();
    await page.waitForTimeout(600);
    const reopen = page.getByRole("button", { name: "Generate every page" });
    const reopenVisible = await reopen.isVisible().catch(() => false);
    console.log(`after dismissal, "Generate every page" in the chrome: ${reopenVisible}`);
    if (reopenVisible) {
      await reopen.click();
      await page.waitForTimeout(600);
      console.log(`clicking it reopens the panel: ${await page.getByText("How do you want to start?").isVisible().catch(() => false)}`);
    }
  }
  await page.screenshot({ path: "/private/tmp/claude-501/-Users-alfonsogarces-VIDEO-GEN/66a0320e-ab42-4115-8600-78bdda8062ed/scratchpad/blank-doc.png", fullPage: false });
  if (!panel) console.log(`\nwhat the page shows instead:\n${bodyText}`);

  // Clean up the probe document.
  const id = /\/(?:preview|edit)\/([A-Z0-9]+)/i.exec(url)?.[1];
  if (id) await page.request.fetch(`${BASE}/api/documents/${id}`, { method: "DELETE", failOnStatusCode: false });

  await browser.close();
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
