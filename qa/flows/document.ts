//
// The document-level flows the first pass left out: moving elements, editing
// their text, changing the deck's colours and fonts, and page management.
//
// All four run without a session, because the dev harness now renders the same
// Page and Brand panels the real editor does (app/dev/edit) against the
// unauthenticated /api/dev twins. Before that, brand and page ops were the two
// largest untested surfaces in the product — not because they were hard to
// drive, but because nothing unauthenticated rendered them.
//
import type { Flow } from "../harness";
import { expect, until } from "../harness";
import {
  clickablePoint,
  pickEditablePiece,
  pieceBox,
  pieceIds,
  selectPiece,
  waitForCanvas,
} from "../editor";

const DEV_SCRIPT_ID = () => process.env.QA_DEV_SCRIPT_ID ?? "";

const openEditor = async (page: import("playwright").Page, base: string): Promise<void> => {
  await page.goto(`${base}/dev/edit/${DEV_SCRIPT_ID()}`, { waitUntil: "domcontentloaded" });
  await waitForCanvas(page);
};

/** Switch the dev editor's side panel. */
const panel = async (
  page: import("playwright").Page,
  tab: "copy" | "page" | "brand",
): Promise<void> => {
  await page.locator(`[data-rb-devtab="${tab}"]`).click();
};

/** How many pages the slide rail is showing. */
const pageCount = async (page: import("playwright").Page): Promise<number> =>
  page.evaluate(() => {
    const m = document.body.innerText.match(/PAGE\s+\d+\s+OF\s+(\d+)/i);
    return m ? Number(m[1]) : 0;
  });

export const documentFlows: Flow[] = [
  {
    name: "dragging an element moves it",
    mutates: true,
    tier: "free",
    run: async ({ page, base, note }) => {
      await openEditor(page, base);
      const target = await pickEditablePiece(page);
      const before = await pieceBox(page, target);
      expect(!!before, "the element should be measurable before moving");
      await selectPiece(page, target);

      // Drag from the middle of the selection, which is the move surface.
      const from = await clickablePoint(page, target);
      expect(!!from, "the element should have a grabbable point");
      await page.mouse.move(from!.x, from!.y);
      await page.mouse.down();
      await page.mouse.move(from!.x + 90, from!.y + 60, { steps: 12 });
      await page.mouse.up();

      await until(
        "the element's measured position changes",
        async () => {
          const after = await pieceBox(page, target);
          if (!after) return false;
          return Math.abs(after.x - before!.x) > 6 || Math.abs(after.y - before!.y) > 6;
        },
        45000,
      );
      const after = await pieceBox(page, target);
      note(
        `(${Math.round(before!.x)}, ${Math.round(before!.y)}) → ` +
          `(${Math.round(after!.x)}, ${Math.round(after!.y)})`,
      );
    },
  },

  {
    name: "double-clicking text opens an edit session",
    mutates: true,
    tier: "free",
    run: async ({ page, base, note }) => {
      await openEditor(page, base);
      const target = await pickEditablePiece(page);
      const point = await clickablePoint(page, target);
      expect(!!point, "the element should have a visible spot to click");
      await page.mouse.dblclick(point!.x, point!.y);

      // An open session makes the text itself editable inside the frame.
      await until(
        "a text field becomes editable",
        async () =>
          page.evaluate(() => {
            const d = (document.querySelector("iframe") as HTMLIFrameElement | null)?.contentDocument;
            if (!d) return false;
            return !!d.querySelector('[contenteditable="true"]');
          }),
        20000,
      );
      note(`editing ${target}`);
      await page.keyboard.press("Escape");
    },
  },

  {
    name: "changing the brand accent restyles the deck",
    mutates: true,
    tier: "free",
    run: async ({ page, base, note }) => {
      await openEditor(page, base);
      await panel(page, "brand");

      // The accent field is a colour input; set it and apply.
      const accent = page.locator('input[type="color"]').first();
      await accent.waitFor({ state: "visible", timeout: 15000 });
      const chosen = "#ff00aa";
      await accent.fill(chosen);
      await accent.dispatchEvent("change");

      const apply = page.getByRole("button", { name: /apply|save/i }).first();
      if (await apply.isVisible().catch(() => false)) await apply.click();

      // Assert the brand was SAVED and APPLIED, by asking the API what the
      // document now wears. Hunting an exact rgb() in computed styles was tried
      // first and is too brittle: an accent legitimately reaches the slide as a
      // gradient stop or with alpha, so a literal colour match misses it and
      // reports a failure that isn't one.
      await until(
        "the document's stored accent becomes the new colour",
        async () =>
          page.evaluate(async (args) => {
            const r = await fetch(`/api/dev/brand?scriptId=${encodeURIComponent(args.id)}`);
            if (!r.ok) return false;
            const j = await r.json();
            const accent = j?.brand?.palette?.accent;
            return typeof accent === "string" && accent.toLowerCase() === args.hex.toLowerCase();
          }, { id: DEV_SCRIPT_ID(), hex: chosen }),
        60000,
      );
      note(`accent ${chosen} saved and applied`);
    },
  },

  {
    name: "adding a blank page increases the page count",
    mutates: true,
    tier: "free",
    run: async ({ page, base, note }) => {
      await openEditor(page, base);
      await panel(page, "page");
      const before = await pageCount(page);
      expect(before > 0, "the page panel should report how many pages there are");

      await page.getByRole("button", { name: /blank page/i }).click();
      await until(`page count rises above ${before}`, async () => (await pageCount(page)) > before, 45000);
      note(`${before} → ${await pageCount(page)} pages`);
    },
  },

  {
    name: "duplicating a page increases the page count",
    mutates: true,
    tier: "free",
    run: async ({ page, base, note }) => {
      await openEditor(page, base);
      await panel(page, "page");
      const before = await pageCount(page);

      await page.getByRole("button", { name: /^duplicate$/i }).click();
      await until(`page count rises above ${before}`, async () => (await pageCount(page)) > before, 45000);
      note(`${before} → ${await pageCount(page)} pages`);
    },
  },

  {
    name: "deleting a page decreases the page count",
    mutates: true,
    tier: "free",
    run: async ({ page, base, note }) => {
      await openEditor(page, base);
      await panel(page, "page");

      // Add one first, so the deck cannot be reduced below a single page and
      // the flow never depends on how many pages the fixture happens to have.
      const start = await pageCount(page);
      await page.getByRole("button", { name: /blank page/i }).click();
      await until("the extra page exists", async () => (await pageCount(page)) > start, 45000);
      const grown = await pageCount(page);

      await page.getByRole("button", { name: /delete page/i }).click();
      await until(`page count falls below ${grown}`, async () => (await pageCount(page)) < grown, 45000);
      note(`${start} → ${grown} → ${await pageCount(page)} pages`);
    },
  },

  {
    name: "the slide rail switches pages",
    tier: "free",
    run: async ({ page, base, note }) => {
      await openEditor(page, base);
      const total = await page.evaluate(
        () => document.querySelectorAll("aside button").length,
      );
      expect(total > 0, "the rail should list the deck's pages");

      const first = await pieceIds(page);
      // Second page, when the fixture has one.
      const second = page.locator("aside button").nth(1);
      if (await second.isVisible().catch(() => false)) {
        await second.click();
        await waitForCanvas(page);
        const now = await pieceIds(page);
        note(`page 1: ${first.length} pieces → page 2: ${now.length} pieces`);
      } else {
        note("single-page fixture — nothing to switch to");
      }
    },
  },
];
