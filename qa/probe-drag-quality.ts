/**
 * Drag quality, measured the way the founder feels it (zero tokens, dev lane):
 *   1. a FAST flick registers at all (the gesture used to die silently)
 *   2. the REAL element tracks the cursor mid-drag (not just an outline)
 *   3. no snap-back: the element never returns to the origin after mouseup
 *   4. the selection outline lands ON the element afterwards
 *
 *   npx tsx qa/probe-drag-quality.ts
 */
import { type Page } from "playwright";
import { harness, probePage, hittablePiece } from "./kit";

const BASE = process.env.QA_BASE ?? "http://localhost:3000";
const DOC = process.env.DOC ?? "01KZWJKGF8G7T5SFRNXZRP1HPQ";

const h = harness();
const expect = h.expect;

/** Where a piece's visible ink actually is, in page coords. */
const inkAt = (page: Page, id: string) =>
  page.locator("iframe").last().evaluate((f, pid) => {
    const d = (f as HTMLIFrameElement).contentDocument;
    const host = (f as HTMLIFrameElement).getBoundingClientRect();
    const p = d?.querySelector(`[data-piece="${pid}"]`);
    if (!p) return null;
    let l = Infinity, t = Infinity;
    for (const c of p.children) {
      const b = c.getBoundingClientRect();
      if (b.width === 0 && b.height === 0) continue;
      l = Math.min(l, b.left); t = Math.min(t, b.top);
    }
    return Number.isFinite(l) ? { x: Math.round(host.left + l), y: Math.round(host.top + t) } : null;
  }, id);

const run = async () => {
  const { browser, page } = await probePage(BASE, false);
  await page.goto(`${BASE}/dev/edit/${DOC}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(7000);

  // Pick a hittable piece and select it (kit: union + hit-test verified).
  const target = await hittablePiece(page);
  if (!target) throw new Error("no hittable piece");
  console.log(`  target ${target.id} (height ${Math.round(target.h)}px)`);
  await page.mouse.click(target.x, target.y);
  await page.waitForTimeout(700);

  const before = await inkAt(page, target.id);
  if (!before) throw new Error("no ink measurement");

  // Drag from the SELECTION FRAME, which is where the drag surface lives and
  // where a user actually grabs. (Grabbing at my own computed ink centre put
  // the press 140px outside the surface — it landed on the iframe and no
  // gesture started at all, which made an earlier run of this probe report a
  // pass it had not earned.)
  const fb = await page.locator("[data-rb-selection]").boundingBox();
  if (!fb) throw new Error("no selection frame");
  const gx = fb.x + fb.width / 2;
  const gy = fb.y + fb.height / 2;

  // 1. FAST FLICK — three big jumps, the gesture that used to vanish.
  await page.mouse.move(gx, gy);
  await page.mouse.down();
  await page.mouse.move(gx + 120, gy + 40);
  await page.mouse.move(gx + 200, gy + 60);
  await page.mouse.move(gx + 240, gy + 70);
  await page.waitForTimeout(120);
  const during = await inkAt(page, target.id);
  const movedDuring = during ? during.x - before.x : 0;
  expect(movedDuring > 150, `the element itself tracks a FAST flick mid-drag (moved ${movedDuring}px of ~240)`);
  await page.mouse.up();

  // 3. no snap-back while the server round-trips + reloads
  let snapped = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 6000) {
    const now = await inkAt(page, target.id);
    if (now && Math.abs(now.x - before.x) < 30) snapped = true;
    await page.waitForTimeout(150);
  }
  expect(!snapped, "the element never snaps back to its old position");

  await page.waitForTimeout(2500);
  const after = await inkAt(page, target.id);
  expect(!!after && after.x - before.x > 150, `it landed at the dragged position (${after ? after.x - before.x : "?"}px)`);

  // 4. the outline lands ON the element
  const frame = await page.locator("[data-rb-selection]").boundingBox().catch(() => null);
  const onIt = !!(frame && after && Math.abs(frame.x - after.x) < 60);
  expect(onIt, `the selection outline followed the element (frame ${frame ? Math.round(frame.x) : "none"} vs ink ${after?.x})`);

  // SELF-RESTORING: the drag above COMMITTED a move to the fixture deck.
  // Four unrestored runs accumulated dx=1134 and hit the server's clamp —
  // the landing assertion then failed against pollution, not code. Undo puts
  // the fixture back for the next run.
  await page.request
    .post(`${BASE}/api/dev/undo`, { data: { scriptId: DOC } })
    .catch(() => null);
  await browser.close();
  process.exit(h.finish("drag quality"));
};
void run();
