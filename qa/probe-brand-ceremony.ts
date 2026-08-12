/**
 * PROBE: the brand ceremony, driven end to end on the real signed-in path.
 *
 * Founder call 2026-08-11: every new document opens on a dedicated brand flow
 * — crawl performed, logo upload always offered, colours confirmed (with the
 * black-&-white question), the brand NAMED and saved to the account.
 *
 * Three journeys, in one run because the second depends on the first:
 *   1. name a brand: new doc → type a site → confirm → "Wearing {name}"
 *   2. reuse it:     new doc → the saved chip is offered → one click → wearing
 *   3. skip:         new doc → "start without a brand" → the original choice,
 *                    with the quiet site field still present (never a gate)
 *
 *   npx tsx qa/probe-brand-ceremony.ts
 */
import { chromium, type Page } from "playwright";
import { authenticator } from "./auth";

const BASE = process.env.QA_BASE ?? "http://localhost:3000";
// A site the truth set knows and we control the fate of: our own.
const SITE = process.env.QA_CEREMONY_SITE ?? "renderball.com";
const KIT_NAME = `Probe ${Date.now().toString(36)}`;

const SHOTS = "/private/tmp/claude-501/-Users-alfonsogarces-VIDEO-GEN/66a0320e-ab42-4115-8600-78bdda8062ed/scratchpad";

let failures = 0;
const expect = (ok: boolean, what: string) => {
  console.log(`  ${ok ? "✓" : "✗"} ${what}`);
  if (!ok) failures++;
};

const newDocument = async (page: Page): Promise<string | null> => {
  await page.goto(`${BASE}/documents`, { waitUntil: "domcontentloaded" });
  await page.getByRole("link", { name: /new document/i }).first().click();
  await page.waitForURL(/preview|edit/, { timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(2500);
  return /\/(?:preview|edit)\/([A-Z0-9]+)/i.exec(page.url())?.[1] ?? null;
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
    // ── 1. name a brand ─────────────────────────────────────────────────────
    console.log("journey 1 — read a site, confirm, name it");
    const id1 = await newDocument(page);
    if (id1) created.push(id1);

    expect(
      await page.getByText("Whose document is this?").isVisible().catch(() => false),
      "a new document opens on the ceremony",
    );

    await page.getByPlaceholder("yoursite.com").fill(SITE);
    await page.keyboard.press("Enter");

    // Beat 3 — the free read measures ~1.4s; the generous wait absorbs a slow
    // origin, not our own code.
    const confirmShown = await page
      .getByText("Here is what your site says about you")
      .waitFor({ state: "visible", timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    expect(confirmShown, "the crawl lands on the confirmation beat");
    await page.screenshot({ path: `${SHOTS}/ceremony-confirm.png` });

    if (confirmShown) {
      // The hidden file input ALSO carries role "button", so a loose
      // /upload/i resolves to two elements and strict mode throws — match the
      // visible button's actual copy in both of its states.
      expect(
        await page
          .getByRole("button", { name: /upload (a logo|a different one)/i })
          .isVisible()
          .catch(() => false),
        "the logo upload is ALWAYS offered (founder call)",
      );
      const nameField = page.locator('input[maxlength="60"]');
      const suggested = await nameField.inputValue().catch(() => "");
      expect(suggested.length > 0, `the name field arrives pre-filled ("${suggested}")`);
      await nameField.fill(KIT_NAME);
      await page.getByRole("button", { name: "This is my brand" }).click();

      const wearing = await page
        .getByText(new RegExp(`Wearing\\s+${KIT_NAME}`, "i"))
        .waitFor({ state: "visible", timeout: 20_000 })
        .then(() => true)
        .catch(() => false);
      expect(wearing, `confirming lands on the choice card wearing "${KIT_NAME}"`);
      await page.screenshot({ path: `${SHOTS}/ceremony-wearing.png` });
    }

    // ── 2. reuse the saved brand ────────────────────────────────────────────
    console.log("journey 2 — the saved brand is one click on the next document");
    const id2 = await newDocument(page);
    if (id2) created.push(id2);

    const chip = page.getByRole("button", { name: new RegExp(KIT_NAME, "i") });
    const chipShown = await chip
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    expect(chipShown, `the ceremony offers the saved brand "${KIT_NAME}"`);
    if (chipShown) {
      await chip.click();
      expect(
        await page
          .getByText(new RegExp(`Wearing\\s+${KIT_NAME}`, "i"))
          .waitFor({ state: "visible", timeout: 20_000 })
          .then(() => true)
          .catch(() => false),
        "one click dresses the new document in the saved brand",
      );
      await page.screenshot({ path: `${SHOTS}/ceremony-kit-reuse.png` });
    }

    // ── 3. skip stays one quiet click ───────────────────────────────────────
    console.log("journey 3 — no brand, no friction");
    const id3 = await newDocument(page);
    if (id3) created.push(id3);

    const skip = page.getByRole("button", { name: /start without a brand/i });
    expect(
      await skip.isVisible().catch(() => false),
      "the escape is visible on the first beat",
    );
    await skip.click();
    expect(
      await page
        .getByText("How do you want to start?")
        .waitFor({ state: "visible", timeout: 10_000 })
        .then(() => true)
        .catch(() => false),
      "skipping lands on the original start choice",
    );
    expect(
      await page.getByPlaceholder("yoursite.com").isVisible().catch(() => false),
      "the quiet site field is still there for a skipper who changes their mind",
    );
  } finally {
    for (const id of created) {
      await page.request.fetch(`${BASE}/api/documents/${id}`, {
        method: "DELETE",
        failOnStatusCode: false,
      });
    }
    // The kit this run named, too — otherwise every probe run leaves another
    // "Probe xxxx" chip in the account's real picker.
    try {
      const list = await page.request.fetch(`${BASE}/api/brand-kits`);
      const data = (await list.json().catch(() => null)) as
        | { kits?: { id: string; name?: string }[] }
        | null;
      for (const kit of data?.kits ?? []) {
        if (kit.name?.startsWith("Probe ")) {
          await page.request.fetch(`${BASE}/api/brand-kits`, {
            method: "DELETE",
            data: { kitId: kit.id },
            failOnStatusCode: false,
          });
        }
      }
    } catch {
      /* cleanup is best-effort */
    }
    await browser.close();
  }

  console.log(failures === 0 ? "\nceremony probe: all green" : `\nceremony probe: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
};

void run();
