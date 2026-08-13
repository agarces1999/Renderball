/**
 * Selection mechanics on /dev/edit (no auth, fixture deck, zero tokens):
 * wait for a real painted piece, click its center, assert data-rb-selected.
 * This is the corrected click discipline for the joint probe — proven here
 * before re-spending on a live build.
 */
import { chromium } from "playwright";

const BASE = process.env.QA_BASE ?? "http://localhost:3000";

const run = async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1100 } })).newPage();
  const DOC = process.env.DOC ?? "01KZWJKGF8G7T5SFRNXZRP1HPQ";
  await page.goto(`${BASE}/dev/edit/${DOC}`, { waitUntil: "domcontentloaded" });

  const canvas = page.locator("iframe").last();
  // Readiness = a piece with real area is PAINTED inside the canvas doc.
  // (An explicit evaluate poll — waitForFunction's RAF polling proved flaky
  // against the iframe doc here.)
  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 30_000 && !ready) {
    ready = await canvas
      .evaluate((f) => {
        const d = (f as HTMLIFrameElement).contentDocument;
        if (!d) return false;
        // Pieces are display:contents (no own box) — measure the union of
        // their children, the way the editor's rectOf does.
        return [...d.querySelectorAll("[data-piece]")].some((p) => {
          let w = 0;
          let h = 0;
          for (const c of p.children) {
            const b = c.getBoundingClientRect();
            w = Math.max(w, b.width);
            h = Math.max(h, b.height);
          }
          return w > 40 && h > 20;
        });
      })
      .catch(() => false);
    if (!ready) await page.waitForTimeout(500);
  }
  if (!ready) throw new Error("no painted piece within 30s");

  // Click the CENTER of the first real piece, in parent coordinates.
  const target = await canvas.evaluate((f) => {
    const iframe = f as HTMLIFrameElement;
    const d = iframe.contentDocument!;
    const host = iframe.getBoundingClientRect();
    for (const p of d.querySelectorAll("[data-piece]")) {
      // Union of child boxes — the wrapper itself is display:contents.
      let l = Infinity, t = Infinity, r = -Infinity, b2 = -Infinity;
      for (const c of p.children) {
        const b = c.getBoundingClientRect();
        if (b.width === 0 && b.height === 0) continue;
        l = Math.min(l, b.left); t = Math.min(t, b.top);
        r = Math.max(r, b.right); b2 = Math.max(b2, b.bottom);
      }
      if (!(r - l > 40 && b2 - t > 20)) continue;
      // The center must actually HIT this piece (decorative children may be
      // pointer-events:none; empty space falls through to the body).
      const cx = (l + r) / 2;
      const cy = (t + b2) / 2;
      const hit = d.elementFromPoint(cx, cy)?.closest?.("[data-piece]");
      if (hit !== p) continue;
      return {
        id: p.getAttribute("data-piece"),
        x: host.left + cx,
        y: host.top + cy,
      };
    }
    return null;
  });
  if (!target) throw new Error("no real piece");
  console.log(`clicking center of ${target.id} at (${Math.round(target.x)}, ${Math.round(target.y)})`);
  await page.mouse.click(target.x, target.y);
  await page.waitForTimeout(600);
  const sel = await page.locator("[data-rb-selected]").first().getAttribute("data-rb-selected");
  console.log(`data-rb-selected=${JSON.stringify(sel)}`);
  console.log(sel ? "SELECTION WORKS" : "SELECTION FAILED");
  await browser.close();
  process.exit(sel ? 0 : 1);
};
void run();
