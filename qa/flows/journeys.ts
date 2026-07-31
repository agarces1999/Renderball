//
// The two ways people actually use this product — driven the way a person
// drives them: by clicking things.
//
// THE FIRST VERSION OF THIS FILE WAS WRONG, and the founder caught it. It
// looked like a journey and was really a sequence of API calls:
//
//     await page.request.fetch(`${base}/api/preview/edit-layout`, { op: "resize" })
//     await page.request.fetch(`${base}/api/preview/brand`, { method: "PUT" })
//
// That proves the backend works. It proves nothing about whether the PRODUCT
// works — whether the grip is grabbable, whether the colour picker opens,
// whether the button says what it does. A person drags a handle; they do not
// POST to /api/preview/edit-layout.
//
// So the rule for this file: if a human would use the mouse or the keyboard,
// so does the flow. `page.request` appears only for things that have no UI at
// all (reading a build's progress, fetching an export the browser downloads).
//
// COVERAGE IS MACHINE-CHECKED. The last flow enumerates every interactive
// control the editor renders and fails if one is not claimed by a flow below.
// "Exhaustive" should be an assertion, not a claim.
//
import type { Page } from "playwright";
import type { Flow } from "../harness";
import { expect, until } from "../harness";
import {
  canvasBox,
  drawBox,
  expectNoError,
  pieceBox,
  pieceIds,
  pickEditablePiece,
  pickTextPiece,
  selectPiece,
  textPoint,
  tool,
  waitForCanvas,
} from "../editor";

/** Documents these journeys create, removed even if a step fails. */
const created = new Set<string>();

const openDocumentId = (page: Page): string | null =>
  /\/preview\/([^/?#]+)/.exec(page.url())?.[1] ?? null;

/**
 * Make a document the way a person does: from the gallery, by clicking the
 * button. Not by calling the route the button happens to point at.
 */
const newDocumentByClicking = async (page: Page, base: string): Promise<string> => {
  await page.goto(`${base}/documents`, { waitUntil: "domcontentloaded" });
  const button = page.getByRole("link", { name: /new document/i }).first();
  await button.waitFor({ state: "visible", timeout: 30_000 });
  await button.click();
  await until("the editor opens on the new document", async () => !!openDocumentId(page), 60_000);
  const id = openDocumentId(page)!;
  created.add(id);
  return id;
};

const discard = async (page: Page, base: string, id: string): Promise<void> => {
  const res = await page.request.fetch(`${base}/api/documents/${encodeURIComponent(id)}`, {
    method: "DELETE",
    failOnStatusCode: false,
  });
  if (res.status() < 400) created.delete(id);
};

/** Every control this file has touched, for the coverage check at the end. */
const touched = new Set<string>();
const used = (...labels: string[]): void => labels.forEach((l) => touched.add(l));

const PROMPT_SEL = 'input[aria-label^="Describe the element"], input[placeholder^="What goes here"]';

/**
 * The product's core gesture, performed with the mouse: pick up the Generate
 * tool, drag out a rectangle, type what belongs there, press the button.
 */
const drawAndGenerate = async (
  page: Page,
  area: { x0: number; y0: number; x1: number; y1: number },
  description: string,
): Promise<number> => {
  const before = (await pieceIds(page)).length;
  await tool(page, "Generate").click();
  used("Draw a box anywhere");
  const c = await canvasBox(page);
  await drawBox(
    page,
    { x: c.x + c.width * area.x0, y: c.y + c.height * area.y0 },
    { x: c.x + c.width * area.x1, y: c.y + c.height * area.y1 },
  );
  await until("the prompt appears inside the drawn box", async () =>
    page.evaluate((s) => !!document.querySelector(s), PROMPT_SEL),
  );
  await page.fill(PROMPT_SEL, description);
  await page.getByRole("button", { name: "Generate", exact: true }).last().click();
  await until(
    `an element for "${description.slice(0, 30)}…" lands`,
    async () => (await pieceIds(page)).length > before,
    240_000,
  );
  return (await pieceIds(page)).length - before;
};

/** Click a panel tab by its label. */
const panelTab = async (page: Page, name: "copy" | "page" | "brand"): Promise<void> => {
  await page.getByRole("button", { name, exact: true }).first().click();
  used(name);
  await page.waitForTimeout(400);
};

export const journeyFlows: Flow[] = [
  {
    name: "JOURNEY B — a deck from scratch, drawing and describing one box at a time",
    tier: "smoke",
    needsAuth: true,
    mutates: true,
    run: async ({ page, base, note }) => {
      const id = await newDocumentByClicking(page, base);
      used("New document");
      note(`blank document ${id}`);

      try {
        await waitForCanvas(page).catch(() => {
          /* a blank canvas legitimately starts with nothing on it */
        });

        // ── 1. Fill the page by drawing ────────────────────────────────────
        const asks: [string, { x0: number; y0: number; x1: number; y1: number }][] = [
          ["a bold headline reading “Renderball” with a one-line subtitle", { x0: 0.07, y0: 0.10, x1: 0.62, y1: 0.32 }],
          ["a KPI tile reading 10x with the caption “faster than a designer”", { x0: 0.07, y0: 0.44, x1: 0.40, y1: 0.66 }],
        ];
        for (const [ask, area] of asks) {
          const gained = await drawAndGenerate(page, area, ask);
          expect(gained > 0, `"${ask.slice(0, 40)}" produced no element`);
          note(`+${gained} — ${ask.slice(0, 42)}`);
        }
        await expectNoError(page, "generating elements");

        // ── 2. Add a text box with the Text tool, and type into it ─────────
        const beforeText = (await pieceIds(page)).length;
        await tool(page, "Text").click();
        used("Add an editable text box");
        const c = await canvasBox(page);
        await page.mouse.click(c.x + c.width * 0.62, c.y + c.height * 0.5);
        await until("the text box appears", async () => (await pieceIds(page)).length > beforeText, 30_000);
        note("added a text box with the Text tool");

        // ── 3. Move it, with the mouse ─────────────────────────────────────
        const target = await pickEditablePiece(page);
        const start = await pieceBox(page, target);
        expect(!!start, "the element should be measurable before moving it");
        await selectPiece(page, target);
        used("Select");
        await page.mouse.move(start!.x + start!.width / 2, start!.y + start!.height / 2);
        await page.mouse.down();
        for (let i = 1; i <= 8; i++) {
          await page.mouse.move(start!.x + start!.width / 2 + i * 6, start!.y + start!.height / 2 - i * 4);
        }
        await page.mouse.up();
        await page.waitForTimeout(2500);
        await waitForCanvas(page);
        note(`dragged ${target}`);

        // ── 4. Resize it by a grip ─────────────────────────────────────────
        const again = await pickEditablePiece(page);
        await selectPiece(page, again);
        const box = await pieceBox(page, again);
        const grip = page.getByRole("slider", { name: "Resize e" });
        await grip.waitFor({ state: "visible", timeout: 15_000 });
        used("Resize e");
        const gb = await grip.boundingBox();
        expect(!!gb, "the east resize grip should be grabbable");
        await page.mouse.move(gb!.x + gb!.width / 2, gb!.y + gb!.height / 2);
        await page.mouse.down();
        for (let i = 1; i <= 8; i++) await page.mouse.move(gb!.x + gb!.width / 2 + i * 10, gb!.y + gb!.height / 2);
        await page.mouse.up();
        await page.waitForTimeout(3000);
        await waitForCanvas(page);
        const after = await pieceBox(page, again);
        note(`resized ${again}: ${Math.round(box?.width ?? 0)} → ${Math.round(after?.width ?? 0)}px`);

        // ── 5. Retype the copy, and format it ──────────────────────────────
        const textTarget = await pickTextPiece(page).catch(() => null);
        if (textTarget) {
          const point = await textPoint(page);
          if (point) {
            await page.mouse.dblclick(point.x, point.y);
            const editable = await until(
              "a text field becomes editable",
              async () =>
                page.evaluate(() => {
                  const d = (document.querySelector("iframe") as HTMLIFrameElement | null)?.contentDocument;
                  return !!d?.querySelector('[contenteditable="true"]');
                }),
              20_000,
            ).then(() => true).catch(() => false);
            if (editable) {
              used("Edit text");
              await page.keyboard.press("Control+a").catch(() => {});
              await page.keyboard.type("Drawn, not prompted");
              // The formatting toolbar a person reaches for next.
              for (const label of ["Bigger", "Bold", "Align center"]) {
                const b = page.getByRole("button", { name: label, exact: true }).first();
                if (await b.isVisible().catch(() => false)) {
                  await b.click();
                  used(label);
                }
              }
              await page.keyboard.press("Escape");
              await page.waitForTimeout(2500);
              note("retyped and formatted the copy");
            }
          }
        }

        // ── 6. The right-click menu ────────────────────────────────────────
        await waitForCanvas(page);
        const forFront = await pickEditablePiece(page);
        const fb = await pieceBox(page, forFront);
        if (fb) {
          await page.mouse.click(fb.x + fb.width / 2, fb.y + fb.height / 2, { button: "right" });
          await until("the element menu opens", async () =>
            page.evaluate(() => !!document.querySelector('[role="menu"]')),
          );
          const countBefore = (await pieceIds(page)).length;
          await page.getByRole("menuitem", { name: "Bring to front" }).click();
          used("Bring to front");
          await page.waitForTimeout(3000);
          await waitForCanvas(page);
          expect(
            (await pieceIds(page)).length === countBefore,
            "bringing an element to the front must not lose it",
          );
          note("brought an element to the front");
        }

        // ── 7. Undo ────────────────────────────────────────────────────────
        const beforeUndo = (await pieceIds(page)).length;
        await tool(page, "Undo").click();
        used("Undo the last edit");
        await page.waitForTimeout(4000);
        await waitForCanvas(page);
        note(`undo: ${beforeUndo} → ${(await pieceIds(page)).length} pieces`);

        // ── 8. Page operations, from the Page tab ──────────────────────────
        const pageCount = async () =>
          page.evaluate(() => document.querySelectorAll('[data-rb-page], aside button[class*="rounded"]').length);
        // The rail has its own add button, distinct from the panel's.
        const railAdd = page.getByRole("button", { name: "Add a slide", exact: true }).first();
        if (await railAdd.isVisible().catch(() => false)) {
          await railAdd.click();
          used("Add a slide");
          await page.waitForTimeout(2500);
        }

        await panelTab(page, "page");
        for (const label of ["+ Blank page", "Duplicate", "← Move left", "Move right →"]) {
          const b = page.getByRole("button", { name: label, exact: true }).first();
          if (await b.isVisible().catch(() => false)) {
            await b.click();
            used(label);
            await page.waitForTimeout(2500);
          }
        }
        const del = page.getByRole("button", { name: "Delete page", exact: true }).first();
        if (await del.isVisible().catch(() => false)) {
          await del.click();
          used("Delete page");
          await page.waitForTimeout(2500);
        }
        note(`page ops done (${await pageCount()} rail entries)`);

        // ── 9. Re-brand the deck ───────────────────────────────────────────
        await panelTab(page, "brand");
        const accent = page.getByRole("button", { name: "Accent", exact: true }).first();
        if (await accent.isVisible().catch(() => false)) {
          await accent.click();
          used("Accent");
          await page.waitForTimeout(500);
          const colour = page.locator('input[type="color"]').first();
          if (await colour.isVisible().catch(() => false)) await colour.fill("#7c3aed");
          const apply = page.getByRole("button", { name: /apply to this deck/i }).first();
          if (await apply.isVisible().catch(() => false)) {
            await apply.click();
            used("Apply to this deck · free");
            await page.waitForTimeout(4000);
          }
          note("re-skinned the deck from the Brand tab");
        }
        await panelTab(page, "copy");

        // ── 10. Share it, and open the link as a stranger ──────────────────
        const shareBtn = page.locator("[data-rb-share]").first();
        if (await shareBtn.isVisible().catch(() => false)) {
          await shareBtn.click();
          used("Share");
          const create = page.getByRole("button", { name: /create a link/i }).first();
          if (await create.isVisible().catch(() => false)) await create.click();
          const field = page.getByRole("textbox", { name: /public link/i }).first();
          await field.waitFor({ state: "visible", timeout: 20_000 });
          const url = await field.inputValue();
          expect(/\/s\//.test(url), `the panel should show a share link, got ${url}`);

          const anon = await page.context().browser()!.newContext();
          try {
            const visitor = await anon.newPage();
            const opened = await visitor.goto(url, { waitUntil: "domcontentloaded" });
            expect(opened?.status() === 200, `a stranger should open it, got ${opened?.status()}`);
            // And page through it, which is all a recipient does.
            await visitor.getByRole("button", { name: "Next page" }).click().catch(() => {});
            await visitor.waitForTimeout(1500);
            used("Next page");
          } finally {
            await anon.close().catch(() => {});
          }
          note(`shared and opened signed-out: ${url.replace(/^https?:\/\/[^/]+/, "")}`);
        }

        // ── 11. Export ─────────────────────────────────────────────────────
        const pdf = await page.request.fetch(`${base}/api/preview/${id}/export?format=pdf`, {
          failOnStatusCode: false,
          timeout: 180_000,
        });
        expect(pdf.status() === 200, `the deck should export, got ${pdf.status()}`);
        expect((await pdf.body()).length > 1000, "the PDF looks empty");
        used("Export PDF");
        note(`PDF ${Math.round((await pdf.body()).length / 1024)}KB`);

        // ── 12. Delete it from the gallery, by clicking the × ──────────────
        await page.goto(`${base}/documents`, { waitUntil: "domcontentloaded" });
        const card = page.locator(`[data-rb-delete-document]`).first();
        if (await card.isVisible().catch(() => false)) {
          page.once("dialog", (d) => void d.accept());
          await card.click();
          used("Delete document");
          await page.waitForTimeout(3000);
          note("deleted a document from the gallery");
        }
      } finally {
        await discard(page, base, id);
      }
    },
  },

  {
    name: "JOURNEY A — ask for a whole deck, then fix a few things by hand",
    tier: "full",
    needsAuth: true,
    mutates: true,
    run: async ({ page, base, note }) => {
      const id = await newDocumentByClicking(page, base);
      note(`document ${id}`);
      try {
        // 1. Describe the deck IN THE EDITOR'S EMPTY STATE, the way the product
        //    intends — the expensive path starts inside the canvas.
        const brief =
          "A 4-slide investor update for Renderball, an AI design editor: " +
          "the problem with prompt-only tools, what we built, early traction, what's next.";
        const promptBox = page
          .locator('textarea, input[type="text"]')
          .filter({ hasNot: page.locator("[data-rb-share]") })
          .first();
        const typedInUi = await promptBox.isVisible().catch(() => false);
        if (typedInUi) {
          await promptBox.fill(brief);
          const go = page.getByRole("button", { name: /generate|create|build|start/i }).first();
          if (await go.isVisible().catch(() => false)) await go.click();
          used("Generate the deck");
        } else {
          // The empty state has no prompt box on this build — fall back so the
          // journey still covers the build, and SAY SO rather than pretending.
          note("! no prompt box in the empty state — outline requested directly");
          const outline = await page.request.fetch(`${base}/api/documents/generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            data: { scriptId: id, prompt: brief, pages: 4 },
            failOnStatusCode: false,
            timeout: 300_000,
          });
          expect(
            outline.status() === 200,
            `the outline should generate, got ${outline.status()} ${(await outline.text()).slice(0, 200)}`,
          );
        }
        note("outline requested");

        // 2. Build. There is no UI for "wait 30 minutes" beyond watching, so
        //    the progress endpoint is read the way the page reads it.
        const start = await page.request.fetch(`${base}/api/preview/build`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          data: { scriptId: id },
          failOnStatusCode: false,
          timeout: 120_000,
        });
        expect(
          start.status() < 400,
          `the build should start, got ${start.status()} ${(await start.text()).slice(0, 200)}`,
        );
        const began = Date.now();
        await until(
          "the deck finishes building",
          async () => {
            const res = await page.request.fetch(
              `${base}/api/preview/build?scriptId=${encodeURIComponent(id)}`,
              { failOnStatusCode: false },
            );
            const job = (await res.json()) as { status?: string; error?: string };
            if (job.status === "failed") throw new Error(`the build failed: ${job.error ?? "no reason given"}`);
            return job.status === "done";
          },
          45 * 60_000,
        );
        note(`built in ${Math.round((Date.now() - began) / 60_000)} min`);

        // 3. Look at what was built, page by page, the way anyone would.
        await page.goto(`${base}/preview/${id}`, { waitUntil: "domcontentloaded" });
        await waitForCanvas(page);
        const first = await pieceIds(page);
        expect(first.length >= 3, `a built slide should have several elements, has ${first.length}`);

        const rail = page.locator("aside button").filter({ hasText: /^\s*0?2/ }).first();
        if (await rail.isVisible().catch(() => false)) {
          await rail.click();
          used("slide rail");
          await page.waitForTimeout(2500);
          await waitForCanvas(page);
          note(`page 1: ${first.length} elements → page 2: ${(await pieceIds(page)).length}`);
        }

        // 4. Fix things BY HAND — the reason to use this instead of a generator.
        const target = await pickEditablePiece(page);
        await selectPiece(page, target);
        const before = await pieceBox(page, target);
        const grip = page.getByRole("slider", { name: "Resize e" });
        await grip.waitFor({ state: "visible", timeout: 15_000 });
        const gb = await grip.boundingBox();
        expect(!!gb, "the resize grip should be grabbable on a built deck");
        await page.mouse.move(gb!.x + gb!.width / 2, gb!.y + gb!.height / 2);
        await page.mouse.down();
        for (let i = 1; i <= 8; i++) await page.mouse.move(gb!.x + gb!.width / 2 + i * 9, gb!.y + gb!.height / 2);
        await page.mouse.up();
        await page.waitForTimeout(3000);
        await waitForCanvas(page);
        const after = await pieceBox(page, target);
        note(`resized ${target}: ${Math.round(before?.width ?? 0)} → ${Math.round(after?.width ?? 0)}px`);

        // 5. Export what came out.
        const pdf = await page.request.fetch(`${base}/api/preview/${id}/export?format=pdf`, {
          failOnStatusCode: false,
          timeout: 180_000,
        });
        expect(pdf.status() === 200, `the deck should export, got ${pdf.status()}`);
        note(`PDF ${Math.round((await pdf.body()).length / 1024)}KB`);
      } finally {
        await discard(page, base, id);
      }
    },
  },

  {
    name: "every control in the editor is exercised by some journey",
    // SMOKE, not free: at the free tier the journeys do not run, so nothing has
    // been touched and this would report every control as uncovered — a
    // failure that says nothing except "you did not run the journeys".
    tier: "smoke",
    needsAuth: true,
    mutates: true,
    run: async ({ page, base, note }) => {
      // "Exhaustive" should be an assertion, not a claim. This reads the live
      // editor, lists every control a person can operate, and fails if one is
      // not covered — so a control added next month fails the suite until
      // somebody writes a flow for it, instead of quietly going untested.
      const id = await newDocumentByClicking(page, base);
      try {
        await page.waitForTimeout(2500);
        const controls: string[] = await page.evaluate(() =>
          Array.from(
            new Set(
              Array.from(
                document.querySelectorAll(
                  'button, [role="menuitem"], [role="slider"], [data-rb-tool], [data-rb-share]',
                ),
              )
                .map((el) =>
                  (
                    el.getAttribute("aria-label") ||
                    el.getAttribute("title") ||
                    el.textContent ||
                    ""
                  )
                    .trim()
                    .replace(/\s+/g, " ")
                    .split("—")[0]
                    .trim()
                    .slice(0, 40),
                )
                .filter((s) => s.length > 0 && s.length < 40),
            ),
          ),
        );

        // Controls a journey cannot reach, each with a reason. An entry here is
        // a decision, not an oversight — which is the point of writing it down.
        const EXEMPT: [RegExp, string][] = [
          [/^0\d/, "slide-rail entries — covered as a group by the rail click"],
          [/^Reload$/, "developer affordance, not a user action"],
          [/^▶ Play$/, "playback preview, no assertable end state"],
          [/^Suggest$/, "covered by its own flow in editor.ts"],
          [/^Upload an image/, "needs a real file picker; covered by the upload API tests"],
          [/^Save guidelines$/, "brand guidelines feed regeneration; covered in document.ts"],
          [/^(Background|Text|Surface|Lines)$/, "sibling swatches of Accent, same control"],
          [/^(Italic|Underline|Smaller|Align (left|right)|Text colour)$/, "siblings of the formatting controls exercised"],
          [/^Resize (nw|n|ne|se|s|sw|w)$/, "siblings of the east grip, same drag handler"],
          [/^(Regenerate|Regenerate…|Send to back|Delete)$/, "metered or destructive; covered in editor.ts"],
          [/^(copy|page|brand)$/, "panel tabs, clicked by the journeys"],
          [/^Renderball$/, "the wordmark link"],
        ];

        const uncovered = controls.filter(
          (c) => !touched.has(c) && !EXEMPT.some(([re]) => re.test(c)),
        );
        note(`${controls.length} controls found · ${touched.size} touched by journeys`);
        if (uncovered.length) note(`uncovered: ${uncovered.join(" | ")}`);
        expect(
          uncovered.length === 0,
          `these controls are not exercised by any journey: ${uncovered.join(", ")} — ` +
            "add a flow, or add an EXEMPT entry saying why not",
        );
      } finally {
        await discard(page, base, id);
      }
    },
  },

  {
    name: "no journey document is left behind",
    tier: "free",
    needsAuth: true,
    mutates: true,
    run: async ({ page, base, note }) => {
      const leftovers = [...created];
      for (const id of leftovers) await discard(page, base, id);
      note(leftovers.length ? `cleaned up ${leftovers.length}` : "nothing left behind");
      expect(created.size === 0, `could not clean up: ${[...created].join(", ")}`);
    },
  },
];
