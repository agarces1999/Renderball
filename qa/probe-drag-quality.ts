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
import { harness, probePage, hittablePiece, inkRect } from "./kit";

const BASE = process.env.QA_BASE ?? "http://localhost:3000";
const DOC = process.env.DOC ?? "01KZWJKGF8G7T5SFRNXZRP1HPQ";

const h = harness();
const expect = h.expect;


const run = async () => {
  const { browser, page } = await probePage(BASE, false);
  await page.goto(`${BASE}/dev/edit/${DOC}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(7000);
  // Count iframe navigations from the parent: each load event bumps it.
  await page.evaluate(() => {
    const w = window as unknown as { __rbLoads?: number };
    w.__rbLoads = 0;
    document.querySelectorAll("iframe").forEach((f) => f.addEventListener("load", () => { w.__rbLoads = (w.__rbLoads ?? 0) + 1; }));
  });

  // Pick a hittable piece and select it (kit: union + hit-test verified).
  const target = await hittablePiece(page);
  if (!target) throw new Error("no hittable piece");
  console.log(`  target ${target.id} (height ${Math.round(target.h)}px)`);
  await page.mouse.click(target.x, target.y);
  await page.waitForTimeout(700);

  const before = await inkRect(page, target.id);
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
  const during = await inkRect(page, target.id);
  const movedDuring = during ? during.x - before.x : 0;
  expect(movedDuring > 150, `the element itself tracks a FAST flick mid-drag (moved ${movedDuring}px of ~240)`);
  await page.mouse.up();

  // OPTIMISTIC-COMMIT ASSERTIONS (speed playbook): the old flow re-rendered
  // the iframe after every move (measured 1449-1564ms) and blanked the
  // selection ~2.5s. The new flow must do NEITHER.
  const loadsBefore = await page.evaluate(() => (window as unknown as { __rbLoads?: number }).__rbLoads ?? -1);

  // 3. no snap-back while the server round-trips + reloads
  let snapped = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 6000) {
    const now = await inkRect(page, target.id);
    if (now && Math.abs(now.x - before.x) < 30) snapped = true;
    await page.waitForTimeout(150);
  }
  expect(!snapped, "the element never snaps back to its old position");

  await page.waitForTimeout(2500);
  const after = await inkRect(page, target.id);
  expect(!!after && after.x - before.x > 150, `it landed at the dragged position (${after ? after.x - before.x : "?"}px)`);

  // 5. THE RELOAD IS GONE: the iframe must not have re-navigated, and the
  // selection must have survived the whole commit.
  const loadsAfter = await page.evaluate(() => (window as unknown as { __rbLoads?: number }).__rbLoads ?? -1);
  expect(
    loadsBefore >= 0 && loadsAfter === loadsBefore,
    `no iframe reload on a committed move (loads ${loadsBefore} → ${loadsAfter})`,
  );
  const stillSelected = await page.locator("[data-rb-selection]").isVisible().catch(() => false);
  expect(stillSelected, "selection survived the commit (no blank gap)");

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
