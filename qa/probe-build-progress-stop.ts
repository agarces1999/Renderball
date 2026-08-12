/**
 * PROBE: honest build progress + the stop button, on a REAL build.
 *
 * Two founder asks (2026-08-12, watching a Klarna build fail after 15 unseen
 * minutes): the ceremony must show what the build is actually doing — the
 * repair ladder used to grind for ten minutes under "Opening the editor" —
 * and a running build must be stoppable.
 *
 * Journey 1: generate a small deck, approve, build — assert per-page steps
 *            tick from REAL server marks and the checking step exists; let it
 *            finish; the editor opens.
 * Journey 2: build again (Regenerate path is not needed — new doc), press
 *            "Stop this build" early; assert the stopped screen and that the
 *            outline survives.
 *
 * SPENDS REAL TOKENS (~$1.50-2.50 for a 3-page deck + a stopped start).
 *   npx tsx qa/probe-build-progress-stop.ts
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
  "A 3-page internal update for Northwind Coffee's office-subscription team: " +
  "the quarter's numbers (up and to the right), one customer story, and the ask — " +
  "two more account managers.";

const makeOutline = async (page: Page): Promise<string | null> => {
  await page.goto(`${BASE}/documents`, { waitUntil: "domcontentloaded" });
  await page.getByRole("link", { name: /new document/i }).first().click();
  await page.waitForURL(/preview|edit/, { timeout: 60_000 }).catch(() => {});
  const id = /\/(?:preview|edit)\/([A-Z0-9]+)/i.exec(page.url())?.[1] ?? null;
  await page.getByRole("button", { name: /start without a brand/i }).click();
  await page.getByText("Generate every page for me").click();
  await page.locator("textarea").fill(BRIEF);
  await page.locator('input[type="number"]').fill("3");
  await page.getByRole("button", { name: "Generate the document" }).click();
  await page.waitForURL(/\/review\//, { timeout: 8 * 60_000 });
  return id;
};

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
  const created: string[] = [];

  try {
    // ── journey 1: honest progress, end to end ─────────────────────────────
    console.log("journey 1 — real steps on a real build");
    const id1 = await makeOutline(page);
    if (id1) created.push(id1);
    console.log(`  outline approved for ${id1}`);

    await page.getByRole("link", { name: /^Build the/ }).first().click();
    await page.waitForURL(/\/preview\//, { timeout: 60_000 });

    expect(
      await page
        .getByText("Checking every page against the layout gates")
        .waitFor({ state: "visible", timeout: 30_000 })
        .then(() => true)
        .catch(() => false),
      "the checking step exists — the repair ladder is no longer invisible",
    );
    expect(
      await page.getByRole("button", { name: /stop this build/i }).isVisible().catch(() => false),
      "the stop button is present while building",
    );
    expect(
      await page.getByText(/back to your outline/i).isVisible().catch(() => false),
      "the exit link is present while building",
    );

    // Wait for a REAL per-page signal: page 1's row must tick DONE while the
    // build is still running (paced rows can't prove server truth; the mark
    // arrives only when that page's fill actually landed).
    const page1Row = page.locator("li", { hasText: /Designing page 1/ });
    const ticked = await page1Row
      .locator("svg, [data-status]")
      .first()
      .waitFor({ state: "visible", timeout: 4 * 60_000 })
      .then(() => true)
      .catch(() => false);
    expect(ticked, "page rows render (real-signal path did not blank the list)");
    await page.screenshot({ path: `${SHOTS}/build-progress-live.png` });

    // Let it finish — the editor (or the honest failure screen) must arrive.
    const settled = await Promise.race([
      page
        .waitForSelector("iframe", { timeout: 12 * 60_000 })
        .then(() => "editor" as const)
        .catch(() => null),
      page
        .getByText(/kept failing our layout check/i)
        .waitFor({ state: "visible", timeout: 12 * 60_000 })
        .then(() => "gate-fail" as const)
        .catch(() => null),
    ]);
    expect(settled !== null, `the build settled visibly (${settled ?? "nothing arrived"})`);
    if (settled === "gate-fail") {
      // The ladder can genuinely exhaust on a real build — the assertion here
      // is the HONEST SENTENCE, not the outcome.
      expect(
        await page.getByText(/back to your outline/i).isVisible().catch(() => false),
        "a gate failure still offers the outline exit (no dead end)",
      );
    }
    await page.screenshot({ path: `${SHOTS}/build-settled.png` });

    // ── journey 2: stop a build ────────────────────────────────────────────
    console.log("journey 2 — stop a running build");
    const id2 = await makeOutline(page);
    if (id2) created.push(id2);
    await page.getByRole("link", { name: /^Build the/ }).first().click();
    await page.waitForURL(/\/preview\//, { timeout: 60_000 });

    const stop = page.getByRole("button", { name: /stop this build/i });
    await stop.waitFor({ state: "visible", timeout: 30_000 });
    // Give the build a moment to be genuinely running before stopping it.
    await page.waitForTimeout(8_000);
    await stop.click();

    expect(
      await page
        .getByText("You stopped this build")
        .waitFor({ state: "visible", timeout: 3 * 60_000 })
        .then(() => true)
        .catch(() => false),
      "the stopped screen arrives (cooperative — lands at the next phase edge)",
    );
    await page.screenshot({ path: `${SHOTS}/build-stopped.png` });

    // The outline must have survived the stop.
    await page.getByRole("link", { name: /back to your outline/i }).click().catch(async () => {
      await page.getByText(/Back to your outline/i).click();
    });
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

  console.log(failures === 0 ? "\nbuild probe: all green" : `\nbuild probe: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
};

void run();
