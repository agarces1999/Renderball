/**
 * PROBE: features 2+3 of the Gamma batch (2026-08-14), one real deck.
 *
 *   2 — the build ceremony shows REAL page thumbnails materializing as each
 *       fill lands (not bars, not theater: the iframe renders the section
 *       code that just reached disk).
 *   3 — clicking an element opens the Element tab: what made it (page brief
 *       for build-born elements), an editable prompt, regenerate — and the
 *       panel remembers the instruction afterwards ("Last regenerated with").
 *
 * SPENDS REAL TOKENS (~$1.60: outline + build + one element regen).
 *   npx tsx qa/probe-thumbs-element-panel.ts
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
    // ── outline → explicit build ────────────────────────────────────────────
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
    await page.getByRole("link", { name: /^Build the/ }).first().click();
    await page.waitForURL(/\/preview\//, { timeout: 60_000 });

    // ── feature 2: a REAL page thumbnail appears while the build runs ──────
    const thumb = page.locator('iframe[title^="Page "]').first();
    const thumbMidBuild = await thumb
      .waitFor({ state: "visible", timeout: 6 * 60_000 })
      .then(async () => {
        // Mid-build = the stop button still exists when the thumbnail shows.
        return page.getByRole("button", { name: /stop this build/i }).isVisible().catch(() => false);
      })
      .catch(() => false);
    expect(thumbMidBuild, "a real page thumbnail rendered while the build was still running");
    await page.screenshot({ path: `${SHOTS}/build-thumbs.png` });

    // ── the build settles into the editor ──────────────────────────────────
    const editorArrived = await page
      .waitForSelector("iframe[title^='Page '][style*='inset']", { timeout: 12 * 60_000 })
      .then(() => true)
      .catch(async () => {
        // The editor's canvas iframe has a different signature than thumbs —
        // fall back to waiting for the toolbar.
        return page
          .getByRole("button", { name: /select/i })
          .waitFor({ state: "visible", timeout: 12 * 60_000 })
          .then(() => true)
          .catch(() => false);
      });
    expect(editorArrived, "the build settled into the editor");

    // ── feature 3: click an element → the Element tab ──────────────────────
    // Pieces are display:contents (no own box). Readiness = a piece's CHILD
    // union has real area; the click target must hit-test back to the piece
    // (decorative children can be pointer-events:none; blind coordinates were
    // exactly how the first run of this probe produced a false failure).
    const canvas = page.locator("iframe").last();
    let target: { id: string | null; x: number; y: number } | null = null;
    const tPaint = Date.now();
    while (Date.now() - tPaint < 90_000 && !target) {
      target = await canvas
        .evaluate((f) => {
          const iframe = f as HTMLIFrameElement;
          const d = iframe.contentDocument;
          if (!d) return null;
          const host = iframe.getBoundingClientRect();
          for (const p of d.querySelectorAll("[data-piece]")) {
            let l = Infinity, t = Infinity, r = -Infinity, b2 = -Infinity;
            for (const c of p.children) {
              const b = c.getBoundingClientRect();
              if (b.width === 0 && b.height === 0) continue;
              l = Math.min(l, b.left); t = Math.min(t, b.top);
              r = Math.max(r, b.right); b2 = Math.max(b2, b.bottom);
            }
            if (!(r - l > 40 && b2 - t > 20)) continue;
            const cx = (l + r) / 2;
            const cy = (t + b2) / 2;
            const hit = d.elementFromPoint(cx, cy)?.closest?.("[data-piece]");
            if (hit !== p) continue;
            return { id: p.getAttribute("data-piece"), x: host.left + cx, y: host.top + cy };
          }
          return null;
        })
        .catch(() => null);
      if (!target) await page.waitForTimeout(1000);
    }
    expect(!!target, `a painted, hittable piece appeared (${target?.id ?? "none"})`);
    if (!target) throw new Error("no piece to click");
    await page.mouse.click(target.x, target.y);
    await page.waitForTimeout(1200);
    const selAttr = await page
      .locator("[data-rb-selected]")
      .first()
      .getAttribute("data-rb-selected")
      .catch(() => null);
    expect(!!selAttr, `the click selected the piece (data-rb-selected=${JSON.stringify(selAttr)})`);
    const panelShown = await page
      .getByText(/Born with this page|You asked for|Added by hand/i)
      .first()
      .waitFor({ state: "visible", timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    expect(panelShown, "selecting an element opened its panel with honest provenance");
    await page.screenshot({ path: `${SHOTS}/element-panel.png` });

    if (panelShown) {
      // ── regenerate through the panel ─────────────────────────────────────
      await page
        .locator("textarea")
        .last()
        .fill("Make this element's text mention espresso — keep everything else the same.");
      await page.getByRole("button", { name: "Regenerate this element" }).click();
      // The tab must SURVIVE the regen (the fetch-based panel vanished here:
      // the editor clears selection for the reload; panelPiece now bridges it).
      let tabHeld = true;
      const tRegen = Date.now();
      let regenLanded = false;
      while (Date.now() - tRegen < 4 * 60_000) {
        regenLanded = await page
          .getByText("Last regenerated with:")
          .isVisible()
          .catch(() => false);
        if (regenLanded) break;
        const tabThere = await page
          .getByRole("button", { name: /^element$/i })
          .isVisible()
          .catch(() => false);
        if (!tabThere) tabHeld = false;
        await page.waitForTimeout(1000);
      }
      expect(tabHeld, "the Element tab stayed open across the regen reload");
      expect(regenLanded, "the panel regenerated the element and now remembers the instruction");
      await page.screenshot({ path: `${SHOTS}/element-panel-after.png` });
    }
  } finally {
    if (failures === 0) {
      // Keep the built deck: it is the only QA-owned REAL deck on this
      // machine, and every future panel probe can reuse it for free.
      console.log(`  fixture kept: ${created.join(", ")}`);
    } else {
      for (const id of created) {
        await page.request.fetch(`${BASE}/api/documents/${id}`, {
          method: "DELETE",
          failOnStatusCode: false,
        });
      }
    }
    await browser.close();
  }

  console.log(failures === 0 ? "\nthumbs+panel probe: all green" : `\nthumbs+panel probe: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
};

void run();
