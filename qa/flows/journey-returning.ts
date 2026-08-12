//
// JOURNEY C — "I came back the next day".
//
// Every other journey in this suite is ONE SITTING: make a document, work on
// it, assert, delete it. Real use is not one sitting, and the bugs the founder
// found on 2026-08-03/04 were all about the SECOND visit — the "how do you want
// to start?" panel reopening over a deck somebody had already built by hand
// (blankness was judged from the script, which hand edits never touch), a
// gallery card describing pipeline work nobody was doing, a rail link that
// crashed the review page for a document that has no outline to review. None of
// those are reachable without leaving and coming back, so nothing in the suite
// could see them.
//
// So this flow leaves. It navigates away, CLOSES THE TAB, opens a new one in
// the same signed-in session, and finds its way back in through the gallery's
// left rail — the way a person returns, from the app's home base rather than
// from a URL they happened to keep.
//
// FREE TIER ON PURPOSE. The work it leaves behind is built with the Text tool
// and the keyboard, both deterministic and unmetered, so the return trip is
// checked on EVERY run instead of on the rare full one. A returning-user
// regression that only a paid build could reach is a regression nobody catches.
//
// Same rule as journeys.ts: if a human would use the mouse or the keyboard, so
// does the flow. `request` appears only for the cleanup delete, which is not
// what this journey is about.
//
import type { Page } from "playwright";
import type { Flow } from "../harness";
import { expect, until } from "../harness";
import { expectNoError, pieceIds, textPoint, tool, waitForCanvas, waitIdle } from "../editor";

/** Documents this journey creates, removed even if a step fails. */
const created = new Set<string>();

/** The words left behind on the first visit, and the ones typed on the second. */
const MADE_BEFORE = "Written before I left";
const MADE_AFTER = "Changed after I came back";

/**
 * How long the start panel gets to appear before "it is not there" is believed.
 *
 * It is hydration-gated on purpose (BlankDocumentPanel renders null until its
 * effect runs, so that a visible card is always a live one), which means an
 * immediate check answers "absent" on a perfectly healthy blank document. The
 * SAME window is used for both directions below — the flow first watches the
 * panel arrive within it on an untouched document, then asserts it never
 * arrives within it once there is work on the page. An absence measured with a
 * ruler that just saw a presence is worth something; one measured on its own is
 * not.
 */
const PANEL_WINDOW = 20_000;

const openDocumentId = (page: Page): string | null =>
  /\/preview\/([^/?#]+)/.exec(page.url())?.[1] ?? null;

/**
 * Make a document the way a person does: from the gallery, by clicking. Mirrors
 * the helper journeys.ts keeps to itself.
 *
 * `.first()` is safe here and only here: /documents renders "New document"
 * twice — once in the rail, once beside the heading — and both are the same
 * control pointing at the same route, so DOM order cannot pick a wrong one.
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

/**
 * Delete a document. Uses the context's request rather than a page's, because
 * this journey deliberately closes the tab it started in and the cleanup still
 * has to run from the `finally`.
 */
const discard = async (page: Page, base: string, id: string): Promise<void> => {
  const res = await page.context().request.fetch(`${base}/api/documents/${encodeURIComponent(id)}`, {
    method: "DELETE",
    failOnStatusCode: false,
  });
  // Already gone is the goal state for a cleanup, not a failure.
  if (res.status() < 400 || res.status() === 404) created.delete(id);
};

/** Is the start panel on screen — asked with a poll, never isVisible({timeout}). */
const startPanelShows = async (page: Page, within = PANEL_WINDOW): Promise<boolean> =>
  page
    // Either face of the blank-document panel: the brand ceremony (its first
    // beat since 2026-08-11) or the start choice. The negative assertion
    // below ("must not reopen over work") would pass VACUOUSLY if it only
    // knew the old heading while the ceremony sat over the user's deck.
    .getByRole("heading", { name: /how do you want to start|whose document is this/i })
    .waitFor({ state: "visible", timeout: within })
    .then(() => true)
    .catch(() => false);

/** Step past the brand ceremony when it is the panel's first beat. */
const passCeremonyIfShown = async (page: Page): Promise<void> => {
  const skip = page.getByRole("button", { name: /start without a brand/i });
  if (await skip.isVisible().catch(() => false)) {
    await skip.click();
    await page
      .getByRole("heading", { name: /how do you want to start/i })
      .waitFor({ state: "visible", timeout: 10_000 })
      .catch(() => {});
  }
};

/** Everything the slide is currently saying, for text assertions and notes. */
const canvasText = async (page: Page): Promise<string> =>
  page.evaluate(() => {
    const d = (document.querySelector("iframe") as HTMLIFrameElement | null)?.contentDocument;
    return (d?.body?.innerText ?? "").replace(/\s+/g, " ").trim();
  });

const bodyText = async (page: Page): Promise<string> =>
  page.evaluate(() => (document.body?.innerText ?? "").replace(/\s+/g, " ").trim());

/** The pages a returning user must never land on. */
const ERROR_PAGE =
  /Something went wrong on our side|This page isn.t available|Application error|Unhandled Runtime Error|Internal Server Error/i;

/**
 * Pipeline vocabulary. A document somebody has been editing by hand was never
 * drafted, rendered or approved by an agent, so a card that says any of this is
 * describing work nobody did. ("Drafting" on every blank document forever was
 * the actual bug.)
 */
const PIPELINE_WORDS = /\bdraft(ing)?\b|\brendering\b|\brendered\b|\bstory ready\b|\bapproved\b|\boutline ready\b/i;

/** Everything the gallery card for this document says, chip included. */
const cardText = async (page: Page, scriptId: string): Promise<string | null> =>
  page.evaluate((sid) => {
    const link = document.querySelector(`a[href="/preview/${sid}"]`);
    return link ? (link as HTMLElement).innerText.replace(/\s+/g, " ").trim() : null;
  }, scriptId);

/**
 * The project id the RAIL is keyed by, read off this card and no other.
 *
 * The rail links to /review/<projectId> while the card links to
 * /preview/<scriptId>, so the two ids have to be tied together somewhere. The ×
 * button carries the project id and is a direct SIBLING of the card's link (a
 * <button> inside an <a> would be invalid markup — see DeleteDocumentButton).
 * Only that one sibling is read: walking further up the tree would happily
 * return a NEIGHBOURING card's id, and the flow would then go and open somebody
 * else's document while claiming to test this one.
 */
const projectIdFor = async (page: Page, scriptId: string): Promise<string | null> =>
  page.evaluate((sid) => {
    const link = document.querySelector(`a[href="/preview/${sid}"]`);
    const del = link?.parentElement?.querySelector(":scope > [data-rb-delete-document]");
    return del?.getAttribute("data-rb-delete-document") ?? null;
  }, scriptId);

/** Add a text box from the toolbar — deterministic, no model, no spend. */
const addTextBox = async (page: Page): Promise<void> => {
  const before = (await pieceIds(page)).length;
  await tool(page, "Text").click();
  await until("the new text box appears on the page", async () => (await pieceIds(page)).length > before, 30_000);
  await waitIdle(page);
};

/**
 * Rewrite a text box's copy the way a person does: double-click into it, select
 * what is there, type over it, press ENTER.
 *
 * ENTER, not Escape. The editor's own key handler commits on Enter and CANCELS
 * on Escape (`finish(false)` in ElementEditor.tsx), so escaping out types words
 * into a field and then throws them away — which in a journey about work
 * surviving would assert the exact opposite of what it means to.
 */
const retype = async (page: Page, words: string): Promise<void> => {
  const point = await textPoint(page);
  expect(!!point, "the page should have a text box on it to rewrite");
  await page.mouse.dblclick(point!.x, point!.y);
  await until(
    "the copy becomes editable after a double-click",
    async () =>
      page.evaluate(() => {
        const d = (document.querySelector("iframe") as HTMLIFrameElement | null)?.contentDocument;
        return !!d?.querySelector('[contenteditable="true"]');
      }),
    20_000,
  );
  // ControlOrMeta, so the same press selects all on a Mac and on CI's Linux.
  await page.keyboard.press("ControlOrMeta+a").catch(() => {});
  await page.keyboard.type(words);
  await page.keyboard.press("Enter");
  await waitIdle(page);
  const landed = await until(`"${words}" appears on the page`, async () => (await canvasText(page)).includes(words), 30_000)
    .then(() => true)
    .catch(() => false);
  expect(
    landed,
    `typing "${words}" into a text box and pressing Enter did not change what the page says — ` +
      `it reads: ${(await canvasText(page)).slice(0, 160)}`,
  );
};

export const returningFlows: Flow[] = [
  {
    name: "JOURNEY C — I came back the next day, and my work was where I left it",
    // FREE: every element here is made with the Text tool and the keyboard.
    tier: "free",
    needsAuth: true,
    mutates: true,
    run: async ({ page, base, note }) => {
      const id = await newDocumentByClicking(page, base);
      note(`document ${id}`);
      // The tab this journey starts in gets closed halfway through, so the
      // cleanup below must not depend on it.
      const context = page.context();
      let current: Page = page;

      try {
        // ── 1. Reopening a document with NOTHING in it still offers the choice
        // The other direction of the assertion further down. Without it,
        // "the panel did not reappear" would also pass if the panel had been
        // deleted from the product — which is exactly how it silently vanished
        // once already, and nothing noticed for weeks.
        await page.goto(`${base}/preview/${id}`, { waitUntil: "domcontentloaded" });
        expect(
          await startPanelShows(page),
          "reopening a document you have not touched yet must still ask how you want to start — " +
            "an empty document with no route to generation is a dead end",
        );
        note("untouched document: the start panel is offered on reopen");

        await passCeremonyIfShown(page);
        await page.getByRole("button", { name: /build it yourself/i }).click();
        await waitForCanvas(page);

        // ── 2. Build something real, by hand ─────────────────────────────────
        await addTextBox(page);
        await addTextBox(page);
        await retype(page, MADE_BEFORE);
        await expectNoError(page, "building a page by hand");
        const before = await pieceIds(page);
        note(`left behind ${before.length} elements and the words “${MADE_BEFORE}”`);

        // ── 3. Leave ─────────────────────────────────────────────────────────
        // Away to the gallery, then the tab itself is gone. A reload keeps the
        // renderer, the cache and every scrap of client state; closing the page
        // is the closest this harness gets to "shut the laptop", and it is the
        // only way to prove nothing that matters was living in that tab.
        await page.goto(`${base}/documents`, { waitUntil: "domcontentloaded" });
        await page.close();
        const fresh = await context.newPage();
        current = fresh;
        note("closed the tab and opened a new one in the same signed-in session");

        // A crash on reopen is the whole bug class this journey exists for, and
        // the harness only watches the page it created. Same exclusions it
        // applies: `next dev` compiling a route throws from inside webpack with
        // none of our code in the stack, and cannot happen in production.
        const crashes: string[] = [];
        fresh.on("pageerror", (e) => {
          const m = String(e);
          if (!/__webpack_modules__|webpack-runtime|ChunkLoadError|reading 'useContext'|reading 'call'/.test(m)) {
            crashes.push(m);
          }
        });

        // ── 4. Come back — to the gallery, where a returning user starts ─────
        await fresh.goto(`${base}/documents`, { waitUntil: "domcontentloaded" });
        const card = fresh.locator(`a[href="/preview/${id}"]`);
        const listed = await card
          .waitFor({ state: "visible", timeout: 30_000 })
          .then(() => true)
          .catch(() => false);
        expect(
          listed,
          "yesterday's document is not offered as an editable deck in the gallery — " +
            "a document built by hand must be listed and must open its editor, not an outline",
        );

        const said = (await cardText(fresh, id)) ?? "";
        note(`its card says: ${said}`);
        expect(
          !PIPELINE_WORDS.test(said),
          `the card for a document edited by hand claims pipeline progress — it says "${said}". ` +
            "Nothing drafted, rendered or approved it; the user did.",
        );

        // ── 5. Back in through the LEFT RAIL ─────────────────────────────────
        // The rail is keyed by project id and points at /review/<id>, and a
        // hand-built document has no outline to review — that combination is
        // what crashed the review page. Clicked, not fetched: the crash was in
        // the page the click lands on.
        const projectId = await projectIdFor(fresh, id);
        const railLink = projectId ? fresh.locator(`aside a[href="/review/${projectId}"]`) : null;
        const inRail = railLink
          ? await railLink
              .waitFor({ state: "visible", timeout: 15_000 })
              .then(() => true)
              .catch(() => false)
          : false;

        if (inRail && railLink) {
          await railLink.click();
          await fresh.waitForLoadState("domcontentloaded");
          // The rail points at /review, and the server REDIRECTS a document
          // with no outline to its editor. Reading the URL while that 307 is
          // still in flight reports the intermediate hop and blames the
          // product for a race in the test — measured: the route answers
          // 307 → /preview every time, but this assertion saw /review.
          // Wait for the DESTINATION, not for "any of the URLs this might be
          // passing through" — a predicate that also accepts /review resolves
          // on the intermediate hop and re-creates the race it was added to
          // close. If the redirect never comes the catch lets the assertion
          // below report the truth.
          await fresh.waitForURL(/\/preview\//, { timeout: 30_000 }).catch(() => {});
          await fresh.waitForLoadState("load").catch(() => {});
          const landedOn = fresh.url().replace(base, "");
          expect(
            !ERROR_PAGE.test(await bodyText(fresh)),
            `opening a hand-built document from the left rail landed on an error page (${landedOn}) — ` +
              "a document with no outline must still open somewhere the user can work",
          );
          expect(
            /\/preview\//.test(fresh.url()),
            `the left rail sent a hand-built document to ${landedOn}; it has no outline to approve, ` +
              "so it must land in its editor",
          );
          note(`the rail opened it at ${landedOn}`);
        } else {
          // Say so and carry on: the rest of the journey is about the document,
          // not the rail, and a silent skip would read as coverage.
          note(
            "COULD NOT CHECK THE RAIL — this document has no entry in the left rail " +
              `(project id ${projectId ?? "not readable from its card"}). Opening it directly instead.`,
          );
          await fresh.goto(`${base}/preview/${id}`, { waitUntil: "domcontentloaded" });
        }

        await waitForCanvas(fresh);

        // ── 6. The start panel must NOT reopen over work that exists ─────────
        expect(
          !(await startPanelShows(fresh)),
          'coming back to a document with elements on it reopened "How do you want to start?" over the ' +
            "user's own work — an empty state is not a mode, and blankness cannot be judged from the " +
            "script, which hand edits never touch",
        );
        note("returning to a page with work on it: no start panel");

        // ── 7. The work itself came back ─────────────────────────────────────
        const countBack = await until(
          `the ${before.length} elements from the first visit to still be on the page`,
          async () => (await pieceIds(fresh)).length >= before.length,
          30_000,
        )
          .then(() => true)
          .catch(() => false);
        const back = await pieceIds(fresh);
        expect(
          countBack,
          `the document lost work between visits — ${before.length} elements when it was closed, ` +
            `${back.length} on return`,
        );

        const wordsBack = await until(
          `the copy typed before leaving ("${MADE_BEFORE}") to still be on the page`,
          async () => (await canvasText(fresh)).includes(MADE_BEFORE),
          30_000,
        )
          .then(() => true)
          .catch(() => false);
        expect(
          wordsBack,
          `the words typed before leaving are gone — the page now reads: ` +
            `${(await canvasText(fresh)).slice(0, 160)}`,
        );
        await expectNoError(fresh, "reopening the document");
        note(`${back.length} elements and the old copy are all still there`);

        // ── 8. And an edit made AFTER coming back survives too ───────────────
        // Work saved on the first visit proves the write path. Work saved on a
        // SECOND visit proves the document is still writable after a round trip
        // — the failure mode where a reopened document reads fine and quietly
        // stops persisting.
        await retype(fresh, MADE_AFTER);
        await fresh.goto(`${base}/preview/${id}`, { waitUntil: "domcontentloaded" });
        await waitForCanvas(fresh);
        const stuck = await until(
          `the change made after coming back ("${MADE_AFTER}") to survive a reload`,
          async () => (await canvasText(fresh)).includes(MADE_AFTER),
          30_000,
        )
          .then(() => true)
          .catch(() => false);
        expect(
          stuck,
          "an edit made after reopening the document did not survive a reload — the page now reads: " +
            `${(await canvasText(fresh)).slice(0, 160)}`,
        );
        expect(
          (await pieceIds(fresh)).length >= back.length,
          `editing after coming back cost the page elements — ${back.length} before the edit, ` +
            `${(await pieceIds(fresh)).length} after reloading`,
        );
        note("an edit made on the second visit survives another reload");

        expect(crashes.length === 0, `reopening the document threw an uncaught error: ${crashes[0]}`);
      } finally {
        await discard(current, base, id);
      }
    },
  },

  {
    name: "no returning-journey document is left behind",
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
