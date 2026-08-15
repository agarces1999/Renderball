/**
 * Drag quality, measured the way the founder feels it (zero tokens, dev lane):
 *   1. a FAST flick registers at all (the gesture used to die silently)
 *   2. the REAL element tracks the cursor mid-drag (not just an outline)
 *   3. no snap-back: the element never returns to the origin after mouseup
 *   4. the selection outline lands ON the element afterwards
 *
 *   npx tsx qa/probe-drag-quality.ts
 */
import { chromium, type Page } from "playwright";

const BASE = process.env.QA_BASE ?? "http://localhost:3000";
const DOC = process.env.DOC ?? "01KZWJKGF8G7T5SFRNXZRP1HPQ";

let failures = 0;
const expect = (ok: boolean, what: string) => {
  console.log(`  ${ok ? "✓" : "✗"} ${what}`);
  if (!ok) failures++;
};

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
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1100 } })).newPage();
  await page.goto(`${BASE}/dev/edit/${DOC}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(7000);

  // Pick a hittable piece and select it.
  const target = await page.locator("iframe").last().evaluate((f) => {
    const iframe = f as HTMLIFrameElement;
    const d = iframe.contentDocument!;
    const host = iframe.getBoundingClientRect();
    for (const p of d.querySelectorAll("[data-piece]")) {
      let l = Infinity, t = Infinity, r = -Infinity, b2 = -Infinity;
      for (const c of p.children) {
        const b = c.getBoundingClientRect();
        if (b.width === 0 && b.height === 0) continue;
        l = Math.min(l, b.left); t = Math.min(t, b.top);
        r = Math.max(r, b.right); b2 = Math.max(b2, b.bottom);
      }
      if (!(r - l > 60 && b2 - t > 14)) continue;
      const cx = (l + r) / 2, cy = (t + b2) / 2;
      if (d.elementFromPoint(cx, cy)?.closest?.("[data-piece]") !== p) continue;
      return { id: p.getAttribute("data-piece")!, x: host.left + cx, y: host.top + cy, h: Math.round(b2 - t) };
    }
    return null;
  });
  if (!target) throw new Error("no hittable piece");
  console.log(`  target ${target.id} (height ${target.h}px)`);
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

  await browser.close();
  console.log(failures === 0 ? "\ndrag quality: all green" : `\ndrag quality: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
};
void run();
