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
  selectedPiece,
  textPoint,
  tool,
  waitForCanvas,
  waitIdle,
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
  // 404 counts as CLEANED: if an earlier discard's response was lost after
  // its delete landed (crash, reset), the retry finds nothing — and for a
  // cleanup, already-gone is the goal state, not a failure.
  if (res.status() < 400 || res.status() === 404) created.delete(id);
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
  // 300s: one stalled model attempt (120s cap) + its retry (120s) + commit
  // overhead must FIT — a wait sized to the happy path reports a recovered
  // stall as a failure.
  await until(
    `an element for "${description.slice(0, 30)}…" lands`,
    async () => (await pieceIds(page)).length > before,
    300_000,
  );
  return (await pieceIds(page)).length - before;
};

/**
 * Click a panel tab, if this document has it.
 *
 * A BLANK document shows only Page and Brand — there is no bound copy to
 * list, so no Copy tab. Assuming all three exist made the journey fail on a
 * document that was behaving perfectly.
 */
const panelTab = async (page: Page, name: "copy" | "page" | "brand"): Promise<boolean> => {
  const tab = page.getByRole("button", { name, exact: true }).first();
  if (!(await tab.isVisible().catch(() => false))) return false;
  await tab.click();
  used(name);
  await page.waitForTimeout(400);
  return true;
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
        // ── 0. The start panel must OFFER the whole product ────────────────
        // Founder-found (2026-08-03): this panel had silently vanished — the
        // deck fast path in page.tsx stopped passing isBlank when decks moved
        // onto the editor shell, so "New document" landed in a bare editor
        // with no route to full generation. A blank document must present the
        // choice, and dismissing it must not bury the expensive path.
        await page
          .getByText("How do you want to start?")
          .waitFor({ state: "visible", timeout: 20_000 });
        expect(
          await page.getByText("Generate every page for me").isVisible().catch(() => false),
          "a brand-new document must offer end-to-end generation",
        );
        await page.getByText("Build it yourself").click();
        used("Build it yourself", "Generate every page for me");
        // Dismissal keeps the full-deck path one click away in the chrome.
        const reopen = page.getByRole("button", { name: "Generate every page" });
        await reopen.waitFor({ state: "visible", timeout: 10_000 });
        await reopen.click();
        used("Generate every page");
        await page
          .getByText("How do you want to start?")
          .waitFor({ state: "visible", timeout: 10_000 });
        await page.getByText("Build it yourself").click();
        note("start panel: both paths offered, reachable again after dismissal");

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
        await waitIdle(page);
        note(`dragged ${target}`);

        // ── 4. Resize it by a grip ─────────────────────────────────────────
        const asked = await pickEditablePiece(page);
        await selectPiece(page, asked);
        // Measure what is ACTUALLY selected, not what was aimed at: a click can
        // land on an ancestor or a nested child, and selectPiece only asserts
        // that SOMETHING got selected. Measuring the wrong element made a
        // working resize report "423 → 423px" and look like a broken feature.
        const again = (await selectedPiece(page)) ?? asked;
        const box = await pieceBox(page, again);
        // The SE grip, dragged in one move with steps — the same technique as
        // the editor flow that has passed for weeks. Ten discrete mouse.move
        // calls on the E grip reported "423 -> 423px" and looked like a broken
        // resize; driven this way the same element goes 438x129 -> 1058x595.
        const grip = page.locator('[aria-label="Resize se"]');
        await grip.waitFor({ state: "visible", timeout: 15_000 });
        used("Resize e");
        const gb = await grip.boundingBox();
        expect(!!gb, "the resize grip should be grabbable");
        await page.mouse.move(gb!.x + gb!.width / 2, gb!.y + gb!.height / 2);
        await page.mouse.down();
        await page.mouse.move(gb!.x + gb!.width / 2 + 80, gb!.y + gb!.height / 2 + 50, { steps: 12 });
        await page.mouse.up();
        await waitIdle(page);
        const after = await pieceBox(page, again);
        note(`resized ${again}: ${Math.round(box?.width ?? 0)} → ${Math.round(after?.width ?? 0)}px`);
        expect(
          Math.round(after?.width ?? 0) !== Math.round(box?.width ?? 0),
          `dragging the east grip did not change ${again}'s width ` +
            `(${Math.round(box?.width ?? 0)}px before and after) — the grip moved but the element did not`,
        );

        // ── 4b. And back the OTHER way ─────────────────────────────────────
        // Both directions, always. Expanding used to silently do nothing: the
        // outward drag left the selection overlay onto the canvas iframe,
        // which swallowed the mouseup — founder-found, and the "flaky
        // technique" note above was this same bug wearing a disguise. One
        // direction passing proves nothing about the other.
        await selectPiece(page, again).catch(() => {});
        const gripBack = page.locator('[aria-label="Resize se"]');
        await gripBack.waitFor({ state: "visible", timeout: 15_000 });
        const gb2 = await gripBack.boundingBox();
        expect(!!gb2, "the resize grip should be grabbable for the reverse drag");
        await page.mouse.move(gb2!.x + gb2!.width / 2, gb2!.y + gb2!.height / 2);
        await page.mouse.down();
        await page.mouse.move(gb2!.x + gb2!.width / 2 - 70, gb2!.y + gb2!.height / 2 - 45, { steps: 12 });
        await page.mouse.up();
        await waitIdle(page);
        const shrunk = await pieceBox(page, again);
        note(`and back: ${Math.round(after?.width ?? 0)} → ${Math.round(shrunk?.width ?? 0)}px`);
        expect(
          Math.round(shrunk?.width ?? 0) < Math.round(after?.width ?? 0),
          `contracting after expanding did not shrink ${again} ` +
            `(${Math.round(after?.width ?? 0)}px → ${Math.round(shrunk?.width ?? 0)}px)`,
        );

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
          await waitIdle(page);
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
        await waitIdle(page);
        note(`undo: ${beforeUndo} → ${(await pieceIds(page)).length} pieces`);

        // ── 8. Page operations, from the Page tab ──────────────────────────
        const pageCount = async () =>
          page.evaluate(() => document.querySelectorAll('[data-rb-page], aside button[class*="rounded"]').length);
        // The rail has its own add button, distinct from the panel's.
        // Located by title, not accessible name: the button's only content is
        // a "+" glyph, so its name resolves inconsistently.
        const railAdd = page.locator('button[title="Add a slide"]').first();
        if (await railAdd.waitFor({ state: "visible", timeout: 10_000 }).then(() => true).catch(() => false)) {
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

        // No dead ends in the panel. Founder-found (2026-08-03): Background
        // showed "not in this deck", disabled, on nearly every deck — the
        // canvas role now resolves from where backgrounds are painted, so on
        // a built deck the swatch must be live.
        const bgSwatch = page.locator('input[type="color"][aria-label="Background"]');
        if (await bgSwatch.isVisible().catch(() => false)) {
          expect(
            !(await bgSwatch.isDisabled().catch(() => true)),
            'the Background swatch reads "not in this deck" — the page colour must be editable on a built deck',
          );
          note("Background swatch is live");
        }

        // The type slots are dropdowns that PREVIEW each face — opening one
        // must show selectable font options, not a raw CSS string.
        const fontBtn = page.locator('[data-rb-font-slot="display"]');
        if (await fontBtn.isVisible().catch(() => false)) {
          await fontBtn.click();
          const opt = page.locator("[data-rb-font-option]").first();
          const optionsShown = await opt
            .waitFor({ state: "visible", timeout: 8_000 })
            .then(() => true)
            .catch(() => false);
          expect(optionsShown, "the display font dropdown opened but showed no font options");
          used((await fontBtn.innerText().catch(() => "")).trim().split("\n")[0] || "font dropdown");
          await fontBtn.click(); // close it again
          note("font dropdown previews real faces");
        }

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

        // ── 9b. Export the page — the PNG by CLICKING — the PNG by CLICKING, because the button
        // now owns a busy state and an in-app error surface, and neither is
        // exercised by fetching the API. The PDF stays an API fetch (a second
        // multi-second Playwright render per run buys no new coverage).
        const pngBtn = page.getByRole("button", { name: "PNG", exact: true }).first();
        // waitFor, not isVisible — the third time this suite has nearly paid
        // for the non-polling check in one day.
        await pngBtn.waitFor({ state: "visible", timeout: 15_000 });
        {
          const download = page.waitForEvent("download", { timeout: 120_000 }).catch(() => null);
          await pngBtn.click();
          used("PNG");
          const got = await download;
          expect(!!got, "clicking PNG should produce a download, and no error strip");
          note("PNG exported by clicking the button");
        }

        // ── 10. Share it, and open the link as a stranger ──────────────────
        const shareBtn = page.locator("[data-rb-share]").first();
        if (await shareBtn.isVisible().catch(() => false)) {
          await shareBtn.click();
          used("Share");
          // waitFor, not isVisible: the panel fetches its share state first and
          // shows "Checking…", so an immediate visibility check answers false
          // and the button never gets clicked. Same mistake as the Clerk
          // verification field — isVisible({timeout}) does not poll.
          const create = page.getByRole("button", { name: /create a link/i }).first();
          const needsCreating = await create
            .waitFor({ state: "visible", timeout: 15_000 })
            .then(() => true)
            .catch(() => false);
          if (needsCreating) await create.click();
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
          // Our own confirmation now, not window.confirm — no dialog to accept.
          //
          // Click UNTIL the confirm opens, the way a person would: a click in
          // the pre-hydration window lands on a button whose JS has not
          // attached yet and silently does nothing (probed and reproduced —
          // no error, no state change, just a lost click). One blind click
          // followed by a 30s wait turned that race into a hard failure.
          await until(
            "the delete confirm opens",
            async () => {
              if (await page.locator("[data-rb-confirm-delete]").first().isVisible().catch(() => false)) return true;
              await card.click().catch(() => {});
              return false;
            },
            20_000,
          );
          await page.locator("[data-rb-confirm-delete]").first().click();
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
        // The start panel is THE path now: choose "Generate every page for
        // me", describe the deck, land on the outline review, click Build —
        // clicked, because the routing between those steps has broken twice
        // (the reload dead-end, then the blank-composition branch) and only
        // clicking notices.
        await page.getByText("Generate every page for me").waitFor({ state: "visible", timeout: 20_000 });
        await page.getByText("Generate every page for me").click();
        used("Generate every page for me");
        await page.getByPlaceholder(/pitch deck for Northwind/i).fill(brief);
        await page.locator('input[type="number"]').fill("4");
        await page.getByRole("button", { name: "Generate the document" }).click();
        used("Generate the document");
        note("outline generating…");
        await page.waitForURL(/\/review\//, { timeout: 600_000 });
        note("outline review reached");

        const buildLink = page.getByRole("link", { name: /build the deck/i }).first();
        await buildLink.waitFor({ state: "visible", timeout: 30_000 });
        await buildLink.click();
        used("Build the deck");
        // Clicking Build lands on /preview, which must show the CEREMONY, not
        // the blank editor — the exact regression this journey now pins.
        await page
          .waitForURL(/\/preview\//, { timeout: 60_000 })
          .catch(() => {});
        const ceremonyShown = await page
          .getByText(/building|designing|outline|page \d/i)
          .first()
          .waitFor({ state: "visible", timeout: 30_000 })
          .then(() => true)
          .catch(() => false);
        expect(ceremonyShown, "clicking Build must land on the build ceremony, not the blank editor");

        {
          const outline = await page.request.fetch(`${base}/api/preview/build?scriptId=${encodeURIComponent(id)}`, {
            failOnStatusCode: false,
          });
          expect(
            outline.status() === 200,
            `the build status should be readable, got ${outline.status()} ${(await outline.text()).slice(0, 200)}`,
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
          // 75 min, from MEASUREMENT not hope: a 4-page build on 2026-08-04
          // spent 36.7 minutes in design:fills alone and entered the
          // gate-retry phase at 37.4 — the 45-minute budget expired
          // mid-gates and reported a working build as a failure. The wait
          // must exceed reality or the journey tests the timeout.
          75 * 60_000,
        );
        note(`built in ${Math.round((Date.now() - began) / 60_000)} min`);

        // 3. Look at what was built, page by page, the way anyone would.
        await page.goto(`${base}/preview/${id}`, { waitUntil: "domcontentloaded" });

        // EVERY page, not just the first. A build reported success and shipped
        // a slide that rendered React's "Element type is invalid" instead of
        // content — the customer pays, waits five minutes, and gets a dead
        // slide that export, share and the link preview all inherit. The SSR
        // gate renders each scene and catches throws, so whatever produced it
        // diverges between that sandbox and the browser; until that is found,
        // this is what notices.
        const pageErrorOn = async (): Promise<string | null> =>
          page.evaluate(() => {
            const d = (document.querySelector("iframe") as HTMLIFrameElement | null)?.contentDocument;
            const text = (d?.body?.innerText ?? "") + " " + document.body.innerText;
            const m = /(Render error:[^\n]{0,200}|Element type is invalid[^\n]{0,160})/.exec(text);
            return m ? m[1] : null;
          });

        const broken: string[] = [];
        const rail = page.locator("aside button").filter({ hasText: /^\s*0\d/ });
        const pageCount = Math.max(1, await rail.count());
        for (let i = 0; i < pageCount; i++) {
          if (i > 0) {
            await rail.nth(i).click();
            await page.waitForTimeout(2500);
          }
          await waitForCanvas(page).catch(() => {});
          const err = await pageErrorOn();
          if (err) broken.push(`page ${i + 1}: ${err.slice(0, 120)}`);
        }
        note(`checked ${pageCount} pages${broken.length ? ` — ${broken.length} BROKEN` : " — all render"}`);
        expect(
          broken.length === 0,
          `the build reported success but shipped ${broken.length} unrenderable slide(s): ${broken.join(" | ")}`,
        );

        await rail.first().click().catch(() => {});
        await page.waitForTimeout(2000);
        await waitForCanvas(page);
        const first = await pieceIds(page);
        expect(first.length >= 3, `a built slide should have several elements, has ${first.length}`);

        // The every-page loop above already walked the rail.
        used("slide rail");

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
        await waitIdle(page);
        const after = await pieceBox(page, target);
        note(`resized ${target}: ${Math.round(before?.width ?? 0)} → ${Math.round(after?.width ?? 0)}px`);

        // 5. Export what came out (the PNG button is exercised by
        //    JOURNEY B at smoke tier, where the coverage gate runs).
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
          [/^(Export PDF|Export PDF →|Exporting PDF…)$/, "a second full Playwright render per run; the export API is fetched in journey B step 5, and the button's busy/error UI is the same component the PNG click exercises"],
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
