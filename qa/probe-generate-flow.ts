/**
 * PROBE, paid (one outline call, cents): the product's headline path.
 *
 * New document → "Generate every page for me" → brief → Generate → must land
 * on the OUTLINE REVIEW (/review/<briefId>) with a Build action — the
 * approval step the panel promises. Before 2026-08-03 this reloaded into the
 * same blank editor: three independent hunt agents converged on it.
 *
 * Also proves the 409 guard: full generation against a document WITH content
 * must refuse rather than replace it.
 *
 * Does NOT click Build (that is the ~$1 spend).
 *
 *   npx tsx qa/probe-generate-flow.ts
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

  // 1. The guard: a deck with content must be refused.
  const fixture = process.env.QA_DEV_SCRIPT_ID ?? "01KY7ZGC4MVDD5J1DSB35GAW5T";
  const guarded = await page.request.post(`${BASE}/api/documents/generate`, {
    data: { scriptId: fixture, prompt: "overwrite attempt" },
    failOnStatusCode: false,
  });
  console.log(`guard on non-blank doc: ${guarded.status()} (${guarded.status() === 409 ? "REFUSED, correct" : guarded.status() === 404 ? "fixture not owned by test user — guard untested here" : "WRONG"})`);

  // 2. The headline path, through the real UI.
  await page.goto(`${BASE}/documents`, { waitUntil: "domcontentloaded" });
  await page.getByRole("link", { name: /new document/i }).first().click();
  await page.getByText("Generate every page for me").waitFor({ state: "visible", timeout: 30_000 });
  const id = /\/preview\/([A-Z0-9]+)/i.exec(page.url())?.[1] ?? null;
  console.log(`blank document: ${id}`);
  await page.getByText("Generate every page for me").click();
  await page.waitForTimeout(1200);
  console.log("form heading visible:", await page.getByText("What is this document about?").isVisible().catch(() => false));
  await page.screenshot({ path: "/private/tmp/claude-501/-Users-alfonsogarces-VIDEO-GEN/66a0320e-ab42-4115-8600-78bdda8062ed/scratchpad/gen-form.png" });
  await page.getByPlaceholder(/pitch deck for Northwind/i).fill(
    "A three-page pitch for Renderball — AI decks you can edit. The problem with AI design tools, the editing moat, the ask.",
  );
  await page.locator('input[type="number"]').fill("3");
  await page.getByRole("button", { name: "Generate the document" }).click();
  console.log("outline generating (this is the paid call, ~60s)…");

  await page.waitForURL(/\/review\//, { timeout: 240_000 });
  console.log(`landed on: ${page.url()} (REVIEW — correct)`);
  const body = await page.locator("body").innerText();
  const hasBuild = /build/i.test(body);
  const hasOutline = (body.match(/\n/g) ?? []).length > 10;
  console.log(`outline present: ${hasOutline} · Build action present: ${hasBuild}`);

  if (id) {
    await page.request.fetch(`${BASE}/api/documents/${id}`, { method: "DELETE", failOnStatusCode: false });
    console.log("probe document deleted");
  }
  await browser.close();
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
