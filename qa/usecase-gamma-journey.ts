/**
 * REAL USE CASE (founder pre-test, 2026-08-14): one deck, start to finish,
 * the way a person would do it — brand URL on the form, watch the outline
 * type, reload mid-way like an impatient human, approve, build, watch real
 * pages appear, then click an element and change it through its panel.
 *
 * One paid deck (~$2 total). The deck is KEPT for inspection.
 *   npx tsx qa/usecase-gamma-journey.ts
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
  const auth = authenticator(BASE)!;
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  await auth(context);
  const page: Page = await context.newPage();

  // ── start a document the way the founder would ─────────────────────────
  await page.goto(`${BASE}/documents`, { waitUntil: "domcontentloaded" });
  await page.getByRole("link", { name: /new document/i }).first().click();
  await page.waitForURL(/preview|edit/, { timeout: 60_000 }).catch(() => {});
  const id = /\/(?:preview|edit)\/([A-Z0-9]+)/i.exec(page.url())?.[1] ?? "?";
  console.log(`document: ${BASE}/preview/${id}`);
  await page.getByRole("button", { name: /start without a brand/i }).click();
  await page.getByText("Generate every page for me").click();

  // The brand touch a real user makes: their site on the form. Renderball's
  // own site — genuinely ours to crawl. (2026-08-14: an earlier version used
  // flarebit.ai off the founder's email domain; the site is an unrelated
  // Spanish-language business, not his — that run DID expose the
  // brief-language-vs-site-language bug, now pinned in the outline prompt.)
  await page.getByPlaceholder("yoursite.com").fill("renderball.com").catch(() => {
    console.log("  (no yoursite.com field — skipping brand URL)");
  });
  await page
    .locator("textarea")
    .fill(
      "A 4-page investor update for Meridian Robotics (fictional): the quarter in numbers (12 pilot customers, $48k MRR), the enterprise pilot that converted, the hard lesson from our August outage, and the ask — intros to infra-focused seed funds.",
    );
  await page.locator('input[type="number"]').fill("4");
  await page.getByRole("button", { name: "Generate the document" }).click();

  // ── feature 1: the outline types itself ────────────────────────────────
  const thinking = await page
    .getByText(/Reading your brief — deciding what each page must earn/)
    .waitFor({ state: "visible", timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  expect(thinking, "thinking phase named while the model reads the brief");

  const typed = await page
    .locator("[data-rb-outline-card]")
    .first()
    .waitFor({ state: "visible", timeout: 4 * 60_000 })
    .then(() => true)
    .catch(() => false);
  expect(typed && !/\/review\//.test(page.url()), "outline cards typing mid-generation");
  await page.screenshot({ path: `${SHOTS}/uc-typing.png` });

  // Impatient-human reload while it writes.
  await page.reload({ waitUntil: "domcontentloaded" });
  const replayed = await page
    .locator("[data-rb-outline-card]")
    .first()
    .waitFor({ state: "visible", timeout: 25_000 })
    .then(() => true)
    .catch(() => false);
  expect(replayed, "reload mid-generation replays the typed outline");

  // Segmented parser, live: exactly the asked-for page count, real labels.
  // Keep the RICHEST sample, not the last: the redirect to review can land
  // between samples and wipe the panel, and a last-sample read then reports
  // zero cards for a manuscript that typed fine (first run of this journey).
  let cardCount = 0;
  let labels: string[] = [];
  const tCards = Date.now();
  while (Date.now() - tCards < 4 * 60_000) {
    if (/\/review\//.test(page.url())) break;
    const now = await page
      .locator("[data-rb-outline-card]")
      .allTextContents()
      .catch(() => [] as string[]);
    if (now.length >= cardCount && now.some((l) => l.trim().length > 2)) {
      labels = now;
      cardCount = now.length;
    }
    await page.waitForTimeout(1500);
  }
  console.log(`    final manuscript: ${cardCount} cards — ${JSON.stringify(labels.map((l) => l.slice(0, 34)))}`);
  expect(cardCount === 4, `manuscript settled at exactly 4 page cards (got ${cardCount})`);
  await page.screenshot({ path: `${SHOTS}/uc-typing-full.png` });

  // ── review: the promised approval gate ─────────────────────────────────
  const onReview = await page
    .waitForURL(/\/review\//, { timeout: 6 * 60_000 })
    .then(() => true)
    .catch(() => false);
  expect(onReview, "landed on the outline review");
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${SHOTS}/uc-review.png` });

  // ── build: feature 2, real pages materialize ───────────────────────────
  await page.getByRole("link", { name: /^Build the/ }).first().click();
  await page.waitForURL(/\/preview\//, { timeout: 60_000 });
  const thumbEarly = await page
    .locator('iframe[title^="Page "]')
    .first()
    .waitFor({ state: "visible", timeout: 6 * 60_000 })
    .then(async () => page.getByRole("button", { name: /stop this build/i }).isVisible().catch(() => false))
    .catch(() => false);
  expect(thumbEarly, "a real page thumbnail appeared while the build was still running");
  await page.screenshot({ path: `${SHOTS}/uc-thumbs-early.png` });
  // Let more pages land, then capture the fuller grid if still building.
  await page.waitForTimeout(90_000);
  if (await page.getByRole("button", { name: /stop this build/i }).isVisible().catch(() => false)) {
    await page.screenshot({ path: `${SHOTS}/uc-thumbs-later.png` });
  }

  // ── editor arrives ─────────────────────────────────────────────────────
  const editorArrived = await page
    .getByRole("button", { name: /select/i })
    .first()
    .waitFor({ state: "visible", timeout: 12 * 60_000 })
    .then(() => true)
    .catch(() => false);
  expect(editorArrived, "the build settled into the editor");

  // ── feature 3: element panel, then a real edit through it ──────────────
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
  if (!target) throw new Error("no clickable piece");
  await page.mouse.click(target.x, target.y);
  const panelShown = await page
    .getByText(/Born with this page|You asked for|Added by hand/i)
    .first()
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  expect(panelShown, `clicking ${target.id} opened the Element panel with provenance`);
  await page.screenshot({ path: `${SHOTS}/uc-panel.png` });

  if (panelShown) {
    await page
      .locator("textarea")
      .last()
      .fill("Make the headline warmer — mention the team by name: 'the Meridian crew'.");
    await page.getByRole("button", { name: "Regenerate this element" }).click();
    let tabHeld = true;
    let regenLanded = false;
    const tRegen = Date.now();
    while (Date.now() - tRegen < 4 * 60_000) {
      regenLanded = await page.getByText("Last regenerated with:").isVisible().catch(() => false);
      if (regenLanded) break;
      if (!(await page.getByRole("button", { name: /^element$/i }).isVisible().catch(() => false))) tabHeld = false;
      await page.waitForTimeout(1000);
    }
    expect(tabHeld, "Element tab stayed open through the regen");
    expect(regenLanded, "panel remembers the instruction (Last regenerated with:)");
    await page.screenshot({ path: `${SHOTS}/uc-panel-after.png` });
  }

  console.log(`\ndeck kept for inspection: ${BASE}/preview/${id}`);
  await browser.close();
  console.log(failures === 0 ? "use-case journey: all green" : `use-case journey: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
};
void run();
