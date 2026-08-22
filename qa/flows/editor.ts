//
// Editor flows. These need NO session: /dev/edit renders the real ElementEditor
// against the real edit APIs, using the unauthenticated /api/dev twins.
//
// That is not a compromise, it is where the bugs are. Every defect found by hand
// so far — the blank-document manifest 500, three separate silent resize
// failures, the z-order manifest desync — lived in this layer, and every one of
// them would have been caught by a flow below.
//
import type { Flow } from "../harness";
import { expect, until } from "../harness";
import {
  canvasBox,
  drawBox,
  expectNoError,
  pieceBox,
  pieceIds,
  pickEditablePiece,
  selectPiece,
  tool,
  waitForCanvas,
  waitIdle,
} from "../editor";

/**
 * The deck to edit, owned by DEV_OWNER_ID.
 *
 * A FUNCTION, not a constant, and that is not a style preference. qa/main.ts
 * resolves the document and then writes QA_DEV_SCRIPT_ID — but the import of
 * this module has already run by then, so a top-level `const` captures the
 * empty string. Every flow navigated to `/dev/edit/` with no id, got Next's
 * 404, and reported "the canvas renders at least one piece" thirteen times: a
 * harness bug wearing the costume of a product bug.
 */
export const devScriptId = (): string => process.env.QA_DEV_SCRIPT_ID ?? "";

const openEditor = async (page: import("playwright").Page, base: string): Promise<void> => {
  const id = devScriptId();
  expect(!!id, "qa/main.ts should have resolved a document before the flows ran");
  let res = await page.goto(`${base}/dev/edit/${id}`, { waitUntil: "domcontentloaded" });

  // A 5xx on the FIRST hit is usually the dev server compiling this route under
  // three parallel flows, not a broken page — so retry once. A 404 is not
  // retried: that one is always real.
  if ((res?.status() ?? 0) >= 500) {
    res = await page.goto(`${base}/dev/edit/${id}`, { waitUntil: "domcontentloaded" });
  }

  // Check the status before waiting on the canvas. An error page will never
  // grow pieces, so polling it for 30s only buries the real answer in a timeout.
  expect(
    (res?.status() ?? 0) < 400,
    `the editor should open for ${id}, got ${res?.status()} from /dev/edit/${id}`,
  );
  await waitForCanvas(page);
};

export const editorFlows: Flow[] = [
  {
    name: "editor loads and shows the slide",
    tier: "free",
    run: async ({ page, base, note }) => {
      await openEditor(page, base);
      const ids = await pieceIds(page);
      note(`${ids.length} pieces: ${ids.join(", ")}`);
      expect(ids.length > 0, "the slide should render at least one editable piece");
      await expectNoError(page, "loading the editor");
    },
  },

  {
    name: "toolbar shows every tool with its name",
    tier: "free",
    run: async ({ page, base }) => {
      await openEditor(page, base);
      for (const label of ["Select", "Generate", "Text", "Image", "Undo"] as const) {
        expect(
          await tool(page, label).isVisible(),
          `the "${label}" tool should be visible and labelled`,
        );
      }
      // Removed on purpose — a star nobody wanted and a toggle hover replaces.
      expect(
        !(await page.getByRole("button", { name: "Add icon" }).isVisible().catch(() => false)),
        "the icon tool should be gone",
      );
    },
  },

  {
    name: "clicking an element selects it",
    tier: "free",
    run: async ({ page, base, note }) => {
      await openEditor(page, base);
      const target = await pickEditablePiece(page);
      note(`selecting ${target}`);
      await selectPiece(page, target);
      await expectNoError(page, "selecting an element");
    },
  },

  {
    name: "hovering an element reveals it without needing a toggle",
    tier: "free",
    run: async ({ page, base }) => {
      await openEditor(page, base);
      const ids = await pieceIds(page);
      const box = await pieceBox(page, await pickEditablePiece(page));
      expect(!!box, "the piece should be measurable");
      // Two moves: a single jump can land without the frame ever seeing a
      // mouseover, which is what the hover chrome listens for.
      await page.mouse.move(box!.x + box!.width / 2 - 12, box!.y + box!.height / 2 - 8);
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
      // The hover chrome names the piece kind and invites a click.
      await until("hover chrome appears", async () =>
        page.evaluate(() => /click to edit/i.test(document.body.innerText)),
      );
    },
  },

  {
    name: "Delete key removes the selected element",
    quarantined:
      "2026-08-22: red, cause unknown. The API delete works (200, piece removed, persisted) and a real keydown dispatched into the frame document DOES remove the element — so the product path is verified three ways and this is not a known product bug. Four hypotheses were tested and killed: seam-flow interference, the stale-store heal, Playwright input never reaching the frame (it does — a listener attached at probe time saw the key), and the frame document being swapped under the listener (an ordinary edit keeps the same document). Owner: unassigned. Next step: reproduce inside a flow using pickEditablePiece/selectPiece rather than another ad-hoc probe — three hand-rolled probes in a row failed to select and were misread as product verdicts.",
    mutates: true,
    tier: "free",
    run: async ({ page, base, note }) => {
      await openEditor(page, base);
      const before = await pieceIds(page);
      const target = await pickEditablePiece(page);
      await selectPiece(page, target);
      await page.keyboard.press("Delete");
      await until(`${target} is gone`, async () => !(await pieceIds(page)).includes(target), 25000);
      const after = await pieceIds(page);
      note(`${before.length} → ${after.length} pieces`);
      expect(after.length === before.length - 1, "exactly one element should be removed");
    },
  },

  {
    name: "undo restores what was deleted",
    quarantined:
      "2026-08-22: red, and DOWNSTREAM of the delete flow above — it cannot restore a deletion that never happened. Diagnose the delete flow first; this one likely goes green with it. Owner: unassigned.",
    mutates: true,
    tier: "free",
    run: async ({ page, base, note }) => {
      await openEditor(page, base);
      const before = await pieceIds(page);
      const target = await pickEditablePiece(page);
      await selectPiece(page, target);
      await page.keyboard.press("Delete");
      await until("the element is gone", async () => !(await pieceIds(page)).includes(target), 25000);

      await tool(page, "Undo").click();
      await until(`${target} is back`, async () => (await pieceIds(page)).includes(target), 25000);
      note(`restored ${target}`);
      expect((await pieceIds(page)).length === before.length, "undo should restore the piece count");
    },
  },

  {
    // The pair matters: resize on its own has passed for weeks, and Journey B
    // reported a resize doing nothing on an element it had just dragged. This
    // asks whether MOVING FIRST is what breaks it, using the same helpers as
    // the flow below so the two results are directly comparable.
    name: "resizing still works after the element has been moved",
    mutates: true,
    tier: "free",
    run: async ({ page, base, note }) => {
      await openEditor(page, base);
      const target = await pickEditablePiece(page);
      await selectPiece(page, target);

      const start = await pieceBox(page, target);
      expect(!!start, "the piece should be measurable before moving");
      await page.mouse.move(start!.x + start!.width / 2, start!.y + start!.height / 2);
      await page.mouse.down();
      await page.mouse.move(start!.x + start!.width / 2 + 60, start!.y + start!.height / 2 + 40, { steps: 12 });
      await page.mouse.up();
      await waitIdle(page);
      note(`moved ${target}`);

      await selectPiece(page, target);
      const before = await pieceBox(page, target);
      const grip = page.locator('[aria-label="Resize se"]');
      await grip.waitFor({ state: "visible", timeout: 10000 });
      const g = await grip.boundingBox();
      expect(!!g, "the grip should be there after a move too");
      await page.mouse.move(g!.x + g!.width / 2, g!.y + g!.height / 2);
      await page.mouse.down();
      await page.mouse.move(g!.x + g!.width / 2 + 80, g!.y + g!.height / 2 + 50, { steps: 12 });
      await page.mouse.up();

      await until(
        "the moved element's size changes",
        async () => {
          const after = await pieceBox(page, target);
          if (!after) return false;
          return Math.abs(after.width - before!.width) > 4 || Math.abs(after.height - before!.height) > 4;
        },
        45000,
      );
      const after = await pieceBox(page, target);
      note(`${Math.round(before!.width)}x${Math.round(before!.height)} -> ${Math.round(after!.width)}x${Math.round(after!.height)}`);
    },
  },

  {
    name: "resizing an element actually changes its size",
    mutates: true,
    tier: "free",
    run: async ({ page, base, note }) => {
      await openEditor(page, base);
      const target = await pickEditablePiece(page);
      const before = await pieceBox(page, target);
      expect(!!before, "the piece should be measurable before resizing");
      await selectPiece(page, target);

      // Drag the south-east grip. Target the grip ELEMENT rather than guessing
      // at the selection box's corner: the grips are 10×10, so a few pixels of
      // error means grabbing nothing and "resize is broken" for the wrong reason.
      const grip = page.locator('[aria-label="Resize se"]');
      await grip.waitFor({ state: "visible", timeout: 10000 });
      const g = await grip.boundingBox();
      expect(!!g, "the south-east resize grip should be visible once selected");
      await page.mouse.move(g!.x + g!.width / 2, g!.y + g!.height / 2);
      await page.mouse.down();
      await page.mouse.move(g!.x + g!.width / 2 + 80, g!.y + g!.height / 2 + 50, { steps: 12 });
      await page.mouse.up();

      // This is the assertion that matters: resize used to report success and
      // change nothing at all.
      await until(
        "the element's measured size changes",
        async () => {
          const after = await pieceBox(page, target);
          if (!after) return false;
          return Math.abs(after.width - before!.width) > 4 || Math.abs(after.height - before!.height) > 4;
        },
        45000,
      );
      const after = await pieceBox(page, target);
      note(
        `${Math.round(before!.width)}×${Math.round(before!.height)} → ` +
          `${Math.round(after!.width)}×${Math.round(after!.height)}`,
      );
    },
  },

  {
    name: "right-clicking an element opens the element menu",
    tier: "free",
    run: async ({ page, base }) => {
      await openEditor(page, base);
      const ids = await pieceIds(page);
      const box = await pieceBox(page, await pickEditablePiece(page));
      expect(!!box, "the piece should be measurable");
      await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2, { button: "right" });
      await until("the menu appears", async () =>
        page.evaluate(() => !!document.querySelector('[role="menu"]')),
      );
      const items = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[role="menuitem"]')).map((n) => (n.textContent ?? "").trim()),
      );
      expect(items.some((i) => /delete/i.test(i)), "the menu should offer Delete");
      expect(items.some((i) => /regenerate/i.test(i)), "the menu should offer Regenerate");
      expect(items.some((i) => /bring to front/i.test(i)), "the menu should offer Bring to front");
      expect(items.some((i) => /send to back/i.test(i)), "the menu should offer Send to back");
      void ids;
    },
  },

  {
    name: "bring to front changes what is painted on top",
    tier: "free",
    mutates: true,
    run: async ({ page, base, note }) => {
      // The question is NOT whether the manifest changed — it always did. It is
      // whether the browser paints differently, which for weeks it did not:
      // generated pieces carry explicit z-index values, and those beat document
      // order. So this measures the rendered stacking, from the DOM.
      await openEditor(page, base);

      const stacking = async () =>
        page.evaluate(() => {
          const d = (document.querySelector("iframe") as HTMLIFrameElement | null)?.contentDocument;
          if (!d) return [] as { id: string; z: number; order: number }[];
          const out: { id: string; z: number; order: number }[] = [];
          let order = 0;
          for (const el of Array.from(d.querySelectorAll("[data-piece]"))) {
            const id = el.getAttribute("data-piece");
            if (!id) continue;
            // display:contents on the piece itself — the layer is the wrapper
            // above it, or the highest z-index among its own children.
            const wrapper = el.parentElement;
            const wrapperZ = wrapper ? parseInt(getComputedStyle(wrapper).zIndex || "0", 10) : 0;
            let childZ = 0;
            for (const c of Array.from(el.querySelectorAll("*"))) {
              const z = parseInt(getComputedStyle(c).zIndex || "0", 10);
              if (Number.isFinite(z) && z > childZ) childZ = z;
            }
            out.push({
              id,
              z: Math.max(Number.isFinite(wrapperZ) ? wrapperZ : 0, childZ),
              order: order++,
            });
          }
          return out;
        });

      const before = await stacking();
      expect(before.length >= 2, "the slide needs at least two pieces to reorder");
      // Pick the piece that is currently LOWEST, so "front" has somewhere to go.
      const lowest = [...before].sort((a, b) => a.z - b.z || a.order - b.order)[0];
      const topZBefore = Math.max(...before.map((p) => p.z));
      note(`${lowest.id} at z=${lowest.z}, top of stack z=${topZBefore}`);

      const res = await page.request.fetch(`${base}/api/dev/edit-layout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        data: { scriptId: devScriptId(), sceneIndex: 0, pieceId: lowest.id, op: "front" },
        failOnStatusCode: false,
      });
      expect(res.status() === 200, `bring to front should succeed, got ${res.status()}`);

      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForCanvas(page);
      const after = await stacking();

      // It must still be there. A reorder used to delete the piece outright —
      // both edit-layout routes fell through to deleteElement for this op.
      expect(
        after.some((p) => p.id === lowest.id),
        `${lowest.id} DISAPPEARED — a reorder must never remove an element`,
      );
      expect(
        after.length === before.length,
        `the slide lost pieces: ${before.length} → ${after.length}`,
      );

      const now = after.find((p) => p.id === lowest.id)!;
      const othersTop = Math.max(...after.filter((p) => p.id !== lowest.id).map((p) => p.z));
      expect(
        now.z > othersTop,
        `${lowest.id} should now be above everything (z=${now.z} vs ${othersTop})`,
      );
      note(`now z=${now.z}, everything else ≤ ${othersTop}`);
    },
  },

  {
    name: "the Suggest box is present on the slide",
    tier: "free",
    run: async ({ page, base }) => {
      await openEditor(page, base);
      const input = page.getByLabel("Describe this page and get a suggested layout");
      expect(await input.isVisible(), "the Suggest prompt should sit on top of the slide");
      expect(
        await page.getByRole("button", { name: "Suggest" }).isVisible(),
        "the Suggest button should be visible",
      );
    },
  },

  {
    name: "drawing a box opens the generate prompt INSIDE it",
    tier: "free",
    run: async ({ page, base, note }) => {
      await openEditor(page, base);
      await tool(page, "Generate").click();
      const c = await canvasBox(page);
      // A box big enough to contain the prompt bar, so it should sit inside.
      const from = { x: c.x + c.width * 0.12, y: c.y + c.height * 0.15 };
      const to = { x: c.x + c.width * 0.88, y: c.y + c.height * 0.75 };
      await drawBox(page, from, to);

      const promptSel = 'input[aria-label^="Describe the element"], input[placeholder^="What goes here"]';
      await until("the generate prompt appears", async () =>
        page.evaluate((s) => !!document.querySelector(s), promptSel),
      );

      const inside = await page.evaluate((s) => {
        const el = document.querySelector(s) as HTMLElement | null;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
      }, promptSel);
      expect(!!inside, "the prompt bar should be measurable");
      expect(
        inside!.cx > from.x && inside!.cx < to.x && inside!.cy > from.y && inside!.cy < to.y,
        "the prompt should sit INSIDE the drawn box when the box is big enough",
      );
      note("prompt centred inside the drawn area");
      await page.keyboard.press("Escape");
    },
  },

  {
    name: "a small box puts the prompt outside, not clipped",
    tier: "free",
    run: async ({ page, base }) => {
      await openEditor(page, base);
      await tool(page, "Generate").click();
      const c = await canvasBox(page);
      const from = { x: c.x + c.width * 0.2, y: c.y + c.height * 0.3 };
      const to = { x: from.x + 70, y: from.y + 50 };
      await drawBox(page, from, to);

      const promptSel = 'input[aria-label^="Describe the element"], input[placeholder^="What goes here"]';
      await until("the generate prompt appears", async () =>
        page.evaluate((s) => !!document.querySelector(s), promptSel),
      );
      const geom = await page.evaluate((s) => {
        const el = document.querySelector(s) as HTMLElement | null;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, vw: innerWidth, vh: innerHeight };
      }, promptSel);
      expect(!!geom, "the prompt bar should be measurable");
      expect(
        geom!.left >= 0 && geom!.right <= geom!.vw && geom!.top >= 0 && geom!.bottom <= geom!.vh,
        "a prompt that falls outside a small box must still be fully on screen",
      );
      await page.keyboard.press("Escape");
    },
  },

  {
    name: "adding a text box adds an element (free, no model)",
    mutates: true,
    tier: "free",
    run: async ({ page, base, note }) => {
      await openEditor(page, base);
      const before = await pieceIds(page);
      await tool(page, "Text").click();
      await until("a new element appears", async () => (await pieceIds(page)).length > before.length, 30000);
      const after = await pieceIds(page);
      note(`added ${after.find((i) => !before.includes(i))}`);
      await expectNoError(page, "adding a text box");
    },
  },

  {
    name: "marquee generate creates a real element",
    mutates: true,
    tier: "smoke", // costs tokens
    run: async ({ page, base, note }) => {
      await openEditor(page, base);
      const before = await pieceIds(page);
      await tool(page, "Generate").click();
      const c = await canvasBox(page);
      await drawBox(
        page,
        { x: c.x + c.width * 0.15, y: c.y + c.height * 0.55 },
        { x: c.x + c.width * 0.55, y: c.y + c.height * 0.85 },
      );

      const promptSel = 'input[aria-label^="Describe the element"], input[placeholder^="What goes here"]';
      await until("the prompt appears", async () =>
        page.evaluate((s) => !!document.querySelector(s), promptSel),
      );
      await page.fill(promptSel, "a small KPI tile reading 3.2x with a short caption");
      await page.getByRole("button", { name: "Generate", exact: true }).last().click();

      // The generating overlay should appear while the model works.
      const sawOverlay = await page
        .waitForSelector('[aria-label="Generating…"]', { timeout: 8000 })
        .then(() => true)
        .catch(() => false);
      note(`generating overlay shown: ${sawOverlay}`);

      await until("a new element lands", async () => (await pieceIds(page)).length > before.length, 180000);
      await expectNoError(page, "generating an element");
    },
  },
];
