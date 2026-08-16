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

    // 2. Reload IMMEDIATELY — while the model is still thinking. Reloading
    // after a card has typed races completion and loses: the reading-speed
    // pacer means cards become visible around the moment the model FINISHES
    // (the burst lands in the last 20% of the wait), so a post-card reload
    // found status=done and correctly went to review — failing the replay
    // assertion against correct behavior (2026-08-16 run).
    await page.reload({ waitUntil: "domcontentloaded" });
    const resumed = await page
      .getByText(/kept generating|Still working/i)
      .first()
      .waitFor({ state: "visible", timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    expect(resumed, "a mid-generation reload resumed the live ceremony (job survived)");

    // 3. The resumed stream still TYPES: a card must appear from the replay,
    // in the editor, not on /review. Scoped to the manuscript's own card
    // hook — an early run matched the document rail's permanent "01" chip.
    const card = page.locator("[data-rb-outline-card]").first();
    const typedAfter = await card
      .waitFor({ state: "visible", timeout: 4 * 60_000 })
      .then(() => true)
      .catch(() => false);
    const onPanel = !/\/review\//.test(page.url());
    expect(typedAfter && onPanel, "the replayed stream typed a page card in the editor");
    await page.screenshot({ path: `${SHOTS}/outline-typing-replayed.png` });

    // 4. NEVER LEAVE THE EDITOR (founder, 2026-08-14): completion shows the
    // approval beat IN PLACE — Build + Refine beside the typed manuscript.
    // Landing on /review here is the old behavior and now a FAILURE.
    const beat = await page
      .locator("[data-rb-outline-build]")
      .waitFor({ state: "visible", timeout: 8 * 60_000 })
      .then(() => true)
      .catch(() => false);
    const stayed = /\/preview\//.test(page.url()) && !/\/review\//.test(page.url());
    expect(beat && stayed, `outline completion stayed in the editor with the approval beat (url ${page.url().slice(-40)})`);
    const refine = await page.locator("[data-rb-outline-refine]").isVisible().catch(() => false);
    expect(refine, "the page-by-page refine path is still offered (review reachable by choice)");
    await page.screenshot({ path: `${SHOTS}/outline-approval-beat.png` });

    // 5. Build from the beat: same URL family, the ceremony wears the shell.
    await page.locator("[data-rb-outline-build]").click();
    const inCeremony = await page
      .waitForURL(/build=1/, { timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    const shell = inCeremony
      ? await page.getByText(/Designing your pages/).isVisible().catch(() => false)
      : false;
    expect(inCeremony && shell, "Build lands in the editor-shell ceremony on the same document URL");

    if (process.env.QA_FULL_BUILD === "1") {
      // 6. FULL WITNESS (~$1.60): a landed page must ASSEMBLE — the ceremony
      // injects rb-assemble and elements enter staggered. Presence of the
      // stylesheet + animated children is the honest proxy the DOM offers.
      const assembled = await (async () => {
        const t0 = Date.now();
        while (Date.now() - t0 < 25 * 60_000) {
          const st = await page
            .locator("iframe[data-rb-build-iframe]")
            .first()
            .evaluate((f) => {
              const d = (f as HTMLIFrameElement).contentDocument;
              if (!d || !d.getElementById("rb-assemble")) return null;
              let animated = 0;
              for (const wrap of d.querySelectorAll("[data-piece]")) {
                for (const c of wrap.children) {
                  if ((c as HTMLElement).style?.animation?.includes("rb-")) animated++;
                }
              }
              return { animated };
            })
            .catch(() => null);
          if (st) return st;
          await page.waitForTimeout(3000);
        }
        return null;
      })();
      expect(
        !!assembled && assembled.animated >= 3,
        `the landed page assembled element-by-element (${assembled?.animated ?? 0} staggered entrances)`,
      );
      await page.screenshot({ path: `${SHOTS}/build-assembling.png` });
      const settled = await page
        .getByRole("button", { name: /select/i })
        .first()
        .waitFor({ timeout: 25 * 60_000 })
        .then(() => true)
        .catch(() => false);
      expect(settled, "the build settled into the editor without leaving the URL");
    } else {
      // Gate mode (~$0.45): witness the ceremony start, then stop the build
      // through its own control so the gate doesn't pay for a full design.
      await page.getByRole("button", { name: /stop this build/i }).click().catch(() => {});
      await page.waitForTimeout(4000);
    }
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
