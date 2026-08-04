/** PROBE: click the gallery ×; what actually happens? */
import { chromium } from "playwright";
import { authenticator } from "./auth";
const BASE = process.env.QA_BASE ?? "http://localhost:3000";
const run = async () => {
  const auth = authenticator(BASE)!;
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await auth(context);
  const page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.log("CONSOLE:", m.text().slice(0, 200)); });
  page.on("pageerror", (e) => console.log("PAGEERROR:", String(e).slice(0, 300)));
  await page.goto(`${BASE}/documents`, { waitUntil: "domcontentloaded" });
  const x = page.locator("[data-rb-delete-document]").first();
  await x.waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
  console.log("x visible:", await x.isVisible().catch(() => false));
  await page.waitForLoadState("load");
  await page.waitForTimeout(2500); // hydration settle
  await x.click();
  await page.waitForTimeout(1500);
  console.log("url after click:", page.url());
  console.log("confirm visible:", await page.locator("[data-rb-confirm-delete]").first().isVisible().catch(() => false));
  console.log("confirm count:", await page.locator("[data-rb-confirm-delete]").count());
  const overlayText = await page.locator("text=Delete this document?").first().isVisible().catch(() => false);
  console.log("'Delete this document?' visible:", overlayText);
  await browser.close();
};
run().catch((e) => { console.error(e); process.exit(1); });
