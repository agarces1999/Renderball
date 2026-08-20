/**
 * Live-autofit-while-typing probe (client-preview Phase 2).
 *
 * Opens the dev editor, double-clicks a fitted text piece to start a text
 * session, types enough characters to overflow the box, and asserts the
 * fitted font-size SHRINKS before any commit — then cancels with Escape so
 * the fixture deck is untouched. Also asserts the session's input listener
 * cleans up (no refit after Escape).
 */
import { chromium } from "playwright";
import { harness } from "./kit";

const BASE = process.env.QA_BASE ?? "http://localhost:3000";
const DECK = process.env.RB_REFIT_DECK ?? "01M0BZ88XN1PBF4582HFJ2NN5S";

const main = async () => {
  const h = harness();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  await page.goto(`${BASE}/dev/edit/${DECK}`, { waitUntil: "domcontentloaded" });

  // The editor canvas is the LAST iframe on the page.
  const frameEl = page.locator("iframe").last();
  await frameEl.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(1500); // fit pass settles
  const frame = page.frames().at(-1);
  if (!frame) throw new Error("no canvas frame");

  // Target a FIT-MANAGED box (the pass stamps data-rb-fit) — only those can
  // shrink; an unmanaged paragraph just grows its box and proves nothing.
  const target = await frame.evaluate(() => {
    const boxes = [...document.querySelectorAll<HTMLElement>("[data-piece] [data-rb-fit], [data-piece][data-rb-fit]")];
    for (const boxEl of boxes) {
      const el = [...boxEl.querySelectorAll<HTMLElement>("*"), boxEl].find((e) =>
        [...e.childNodes].some((n) => n.nodeType === 3 && (n.nodeValue ?? "").trim().length > 6),
      );
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 60 || r.height < 12) continue;
      const piece = el.closest("[data-piece]");
      if (!piece) continue;
      return {
        pieceId: piece.getAttribute("data-piece"),
        x: r.x + r.width / 2,
        y: r.y + r.height / 2,
        fontPx: parseFloat(getComputedStyle(el).fontSize),
        text: (el.textContent ?? "").slice(0, 30),
      };
    }
    return null;
  });
  h.expect(!!target, `found a text target (${target?.text ?? "none"})`);
  if (!target) process.exit(h.finish("live-refit"));

  // Double-click to open the text session (parent-relative coordinates).
  const box = await frameEl.boundingBox();
  if (!box) throw new Error("no iframe box");
  await page.mouse.dblclick(box.x + target.x, box.y + target.y);
  await page.waitForTimeout(400);

  const editing = await frame.evaluate(() => !!document.querySelector('[contenteditable="true"]'));
  h.expect(editing, "text session opened (contenteditable present)");

  // Measure the FIELD THAT LIVES IN THE FIT BOX (the session opens every
  // field in the piece; the first contenteditable can be an eyebrow that
  // isn't fit-managed). Track the box's fit stamp too — a changed stamp
  // proves the refit pass actually re-ran.
  const before = await frame.evaluate(() => {
    const fields = [...document.querySelectorAll<HTMLElement>('[contenteditable="true"]')];
    const el = fields.find((f) => f.closest("[data-rb-fit]")) ?? fields[0];
    if (!el) return null;
    (window as unknown as { __probeField?: HTMLElement }).__probeField = el;
    const box = el.closest<HTMLElement>("[data-rb-fit]");
    return {
      font: parseFloat(getComputedStyle(el).fontSize),
      len: (el.textContent ?? "").length,
      stamp: box?.getAttribute("data-rb-fit") ?? "",
      refitAvailable: typeof (window as unknown as { __rbRefit?: unknown }).__rbRefit === "function",
    };
  });
  h.expect(!!before?.refitAvailable, "__rbRefit hook present in doc");

  // Focus the FIELD itself — after the dblclick, page-level focus can sit on
  // the parent overlay, so keystrokes never reach the iframe. A click inside
  // the field keeps the session open (onDown ignores in-field clicks) and
  // moves the caret there.
  const fieldRect = await frame.evaluate(() => {
    const el = (window as unknown as { __probeField?: HTMLElement }).__probeField;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + Math.min(r.width - 4, r.width / 2), y: r.y + r.height / 2 };
  });
  if (fieldRect) await page.mouse.click(box.x + fieldRect.x, box.y + fieldRect.y);
  await page.waitForTimeout(150);

  // Type enough to overflow whatever box this is.
  await page.keyboard.press("End");
  await page.keyboard.type(" measured live autofit while typing keeps every added word inside the box", { delay: 4 });
  await page.waitForTimeout(500); // > refit throttle

  const after = await frame.evaluate(() => {
    const el = (window as unknown as { __probeField?: HTMLElement }).__probeField;
    if (!el) return null;
    const box = el.closest<HTMLElement>("[data-rb-fit]");
    return {
      font: parseFloat(getComputedStyle(el).fontSize),
      len: (el.textContent ?? "").length,
      stamp: box?.getAttribute("data-rb-fit") ?? "",
    };
  });

  h.expect(!!before && !!after && after.len > before.len, `text grew (${before?.len} → ${after?.len})`);
  h.expect(
    !!before && !!after && after.stamp !== before.stamp,
    `refit re-ran (fit stamp ${before?.stamp || "none"} → ${after?.stamp || "none"})`,
  );
  h.expect(
    !!before && !!after && after.font < before.font,
    `font size shrank live before commit (${before?.font}px → ${after?.font}px)`,
  );

  // Escape cancels — deck untouched, listener torn down.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const closed = await frame.evaluate(() => !document.querySelector('[contenteditable="true"]'));
  h.expect(closed, "Escape closed the session");

  await browser.close();
  process.exit(h.finish("live-refit"));
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
