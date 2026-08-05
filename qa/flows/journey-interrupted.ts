//
// JOURNEY E — "I changed my mind."
//
// Everything else in this suite drives the product forwards. Nothing drives it
// BACKWARDS: no flow has ever abandoned an operation halfway, and the two ways
// a person does that — pressing Escape, and having their session die under
// them — are both places this editor has already failed a real user.
//
// The one that was found on 2026-08-04: Escape during an in-flight generate
// cleared the drawn box and the prompt bar, so it LOOKED like the request was
// gone. It wasn't. The fetch stayed in flight, `busy` stayed "insert", and
// every control in the toolbar stayed disabled behind a spinner that was no
// longer on screen. Then, thirty seconds later, the element the user had
// abandoned arrived on the slide anyway. Two bugs wearing one gesture:
// cancelling did not cancel, and the cancelled work still shipped.
//
// So the assertions here are deliberately about what the user can DO after
// cancelling, not about what the UI stopped showing. A cleared overlay proved
// nothing last time. Clicking an element and having it select is the check
// that would have caught it.
//
// WHAT THIS COSTS. Three generate requests reach the server, but only ONE is
// allowed to finish — the two interrupted ones are abandoned within a second
// or so of starting, which is the whole point of them. There is no way to test
// the cancellation of an in-flight request without starting one. Whether the
// route abandons its model call when the client aborts is NOT known here (it
// takes no `request.signal`), so this flow measures the delta and says what it
// saw rather than asserting a server behaviour nobody has confirmed.
//
// Same rule as journeys.ts: if a human would use the mouse or the keyboard, so
// does the flow. `page.request` appears only for the discard, which has no UI
// on this path.
//
import type { BrowserContext, Page } from "playwright";
import type { Flow } from "../harness";
import { expect, until } from "../harness";
import {
  canvasBox,
  drawBox,
  expectNoError,
  pickEditablePiece,
  pieceIds,
  selectPiece,
  tool,
} from "../editor";

/** Documents this journey creates, removed even if a step fails. */
const created = new Set<string>();

const openDocumentId = (page: Page): string | null =>
  /\/preview\/([^/?#]+)/.exec(page.url())?.[1] ?? null;

/** Make a document the way a person does: from the gallery, by clicking. */
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
  // 404 counts as CLEANED — for a cleanup, already-gone is the goal state.
  if (res.status() < 400 || res.status() === 404) created.delete(id);
};

/**
 * The editor's own in-flight state, read the way `waitIdle` reads it.
 *
 * "" when idle, otherwise the name of what it is doing ("insert", "move", …).
 * This attribute is the whole subject of the flow: the founder-found bug was
 * an editor that kept saying "insert" long after it had stopped showing it.
 */
const busyState = async (page: Page): Promise<string> =>
  page.evaluate(() => document.querySelector("[data-rb-busy]")?.getAttribute("data-rb-busy") ?? "");

/**
 * The editor's OWN red error strip, and what it says.
 *
 * Not `errorToast` from editor.ts, which scans every div and span for the word
 * "error" — good enough for "is anything wrong", far too loose to build a
 * failure on. This is the one element the editor renders for a failed request
 * (its dismiss affordance is unique in the app), so a hit here is the editor
 * talking, not a coincidence in some other component's copy.
 */
const errorStrip = async (page: Page): Promise<string | null> => {
  const strip = page.locator('div[title="Dismiss"]').first();
  if (!(await strip.isVisible().catch(() => false))) return null;
  return (await strip.innerText().catch(() => "")).trim().slice(0, 160) || null;
};

/** A blank document opens on the start panel, which covers the canvas. */
const startBuilding = async (page: Page): Promise<void> => {
  const byHand = page.getByText("Build it yourself");
  const offered = await byHand
    .waitFor({ state: "visible", timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  if (offered) await byHand.click();
};

/**
 * Put one element on the page for free.
 *
 * The Text tool is deterministic — no model, no spend — and it gives the flow
 * something to click at, which is how "the editor is still usable" gets
 * checked. A blank slide has nothing selectable, so without this the usability
 * check would fail for want of a target and blame the wrong thing.
 */
const addTextBox = async (page: Page): Promise<number> => {
  const before = (await pieceIds(page)).length;
  await tool(page, "Text").click();
  await until(
    "the text box the toolbar promised lands on the slide",
    async () => (await pieceIds(page)).length > before,
    60_000,
  );
  return (await pieceIds(page)).length - before;
};

/**
 * The generate prompt bar, and the two buttons inside it.
 *
 * Scoped to the form that owns the prompt input rather than picked out of the
 * page by name. "Generate" also names the toolbar tool, and `.last()` would
 * resolve by DOM order — a coin flip dressed as a selector. Matched by
 * MEANING too: the submit button relabels itself to "Generating…" and the
 * abandon button to "Stop" the moment a request is in flight, so an exact
 * label would only ever match half the states this flow cares about.
 */
const genBar = (page: Page) => page.locator('form:has(input[aria-label^="Describe the"])').first();
const genSubmit = (page: Page) => genBar(page).getByRole("button", { name: /generat/i });
const genAbandon = (page: Page) => genBar(page).getByRole("button", { name: /^(stop|cancel)$/i });
const genPrompt = (page: Page) => page.locator('input[aria-label^="Describe the element"]').first();

/**
 * Draw a box, describe it, press Generate — and return the moment the request
 * is actually in flight, NOT when it finishes. Everything this journey tests
 * happens inside that window.
 *
 * Returns null once the request is running, or the REASON it never started.
 * That distinction matters: the hourly generation cap and the model breaker
 * both refuse before anything goes in flight, and a flow about interrupting a
 * running request has no subject then. Reporting that as "cancellation is
 * broken" would be a confident lie about the wrong layer.
 */
const startGenerate = async (
  page: Page,
  area: { x0: number; y0: number; x1: number; y1: number },
  description: string,
): Promise<string | null> => {
  await tool(page, "Generate").click();
  const c = await canvasBox(page);
  await drawBox(
    page,
    { x: c.x + c.width * area.x0, y: c.y + c.height * area.y0 },
    { x: c.x + c.width * area.x1, y: c.y + c.height * area.y1 },
  );
  const prompt = genPrompt(page);
  await prompt.waitFor({ state: "visible", timeout: 20_000 });
  await prompt.fill(description);
  await genSubmit(page).click();
  const inFlight = await until(
    "the generate is actually in flight (the editor reports itself busy)",
    async () => (await busyState(page)) === "insert",
    30_000,
  )
    .then(() => true)
    .catch(() => false);
  if (inFlight) return null;
  const said = await errorStrip(page);
  return said
    ? `the editor refused the generate outright — "${said}" — so no request ever went in flight`
    : "the Generate button was pressed and the editor never reported any work in flight";
};

/**
 * The assertion the 2026-08-04 bug would have failed.
 *
 * Not "the overlay went away" — the overlay DID go away, and the editor was
 * dead anyway. What a person notices is that nothing responds: the tools stay
 * greyed, and clicking an element no longer selects it. So that is what gets
 * checked.
 */
const expectUsable = async (page: Page, after: string): Promise<void> => {
  expect(
    (await busyState(page)) === "",
    `after ${after} the editor still reports itself busy — every control is dead behind a spinner ` +
      "that is no longer on screen, and the only way out is reloading the page",
  );
  for (const t of ["Generate", "Text"] as const) {
    expect(
      !(await tool(page, t).isDisabled()),
      `after ${after} the ${t} tool is still greyed out — the toolbar never came back`,
    );
  }
  const target = await pickEditablePiece(page);
  const selects = await selectPiece(page, target)
    .then(() => true)
    .catch(() => false);
  expect(
    selects,
    `after ${after} clicking an element no longer selects it — the editor is frozen, which is ` +
      "exactly what a stuck busy state looks like from the user's side",
  );
};

/**
 * Watch the canvas for a while and report anything that arrives uninvited.
 *
 * Polled rather than slept-then-checked: the point is that NOTHING shows up at
 * any moment in the window, and a single look at the end would miss an element
 * that landed and was then replaced by a reload. 30s is sized against a real
 * generate on this stack (roughly 20-60s), so an abandoned request that was
 * still running would have had time to come back with something.
 */
const straysWithin = async (page: Page, ms: number): Promise<string[]> => {
  const before = new Set(await pieceIds(page));
  const deadline = Date.now() + ms;
  for (;;) {
    const extra = (await pieceIds(page)).filter((p) => !before.has(p));
    if (extra.length) return extra;
    if (Date.now() >= deadline) return [];
    await page.waitForTimeout(1000);
  }
};

/** What the editor is telling a person whose session just died. */
type DeadSessionSurface = "explained" | "sign-in-page" | "bare-failure" | "nothing";

export const interruptedFlows: Flow[] = [
  {
    name: "JOURNEY E — changing your mind mid-generate, by Escape and by Stop",
    // SMOKE, and one completed generation is the whole budget: the two
    // interrupted requests are abandoned seconds after they start.
    tier: "smoke",
    needsAuth: true,
    mutates: true,
    run: async ({ page, base, note }) => {
      const id = await newDocumentByClicking(page, base);
      note(`blank document ${id}`);

      try {
        await startBuilding(page);
        await addTextBox(page);
        note("one text box on the slide, so there is something to click at");

        // ── 1. Escape, pressed the way a person presses it ─────────────────
        // The natural gesture when a generate feels stuck is to click the
        // canvas ("is this thing alive?") and THEN hit Escape — which puts
        // focus inside the iframe. A window-only key listener is dead exactly
        // there, so the click is part of the test, not scene-setting.
        const blockedEsc = await startGenerate(
          page,
          { x0: 0.06, y0: 0.62, x1: 0.42, y1: 0.88 },
          "a small caption reading “changed my mind”",
        );
        if (blockedEsc) {
          note(`SKIPPED — there is nothing to interrupt: ${blockedEsc}`);
          return;
        }
        note("generate #1 in flight");
        const c = await canvasBox(page);
        await page.mouse.click(c.x + c.width * 0.85, c.y + c.height * 0.15);
        await page.keyboard.press("Escape");

        await until(
          "the editor stops reporting an in-flight generate after Escape",
          async () => (await busyState(page)) === "",
          20_000,
        ).catch(() => {
          /* let expectUsable say what a human would conclude */
        });
        await expectUsable(page, "pressing Escape during a generate");
        // Abandoning something on purpose must not leave a red strip under it.
        await expectNoError(page, "abandoning a generate with Escape");
        expect(
          !(await genBar(page).isVisible().catch(() => false)),
          "the prompt bar is still on the canvas after Escape — the drawn box was never released",
        );
        note("Escape: editor idle, toolbar live, a click still selects");

        // ── 1b. And nothing lands afterwards ───────────────────────────────
        // The other half of the same bug: the request kept running and the
        // element the user walked away from arrived anyway.
        const afterEsc = await straysWithin(page, 30_000);
        expect(
          afterEsc.length === 0,
          `${afterEsc.length} element(s) appeared on the slide up to 30s after the generate was ` +
            `cancelled with Escape (${afterEsc.join(", ")}) — the user abandoned that work and got it anyway`,
        );
        note("Escape: nothing arrived in the 30s after");

        // ── 2. The Stop button, which must work when nothing else does ─────
        const blockedStop = await startGenerate(
          page,
          { x0: 0.56, y0: 0.62, x1: 0.92, y1: 0.88 },
          "a small caption reading “stopped it”",
        );
        if (blockedStop) {
          note(`SKIPPED the Stop half — nothing to interrupt: ${blockedStop}`);
          return;
        }
        note("generate #2 in flight");
        const stop = genAbandon(page);
        await stop.waitFor({ state: "visible", timeout: 15_000 });
        const stopLabel = (await stop.innerText()).trim();
        expect(
          /^stop$/i.test(stopLabel),
          `while generating, the abandon button reads "${stopLabel}" — a person looking for the way ` +
            'out of a running request needs it to say "Stop", not offer to cancel something already sent',
        );
        // The one control that has to survive the busy state. Disabling it is
        // how a stalled generate became a mandatory page reload.
        expect(
          !(await stop.isDisabled()),
          "the Stop button is disabled while generating — the only control that has to work when " +
            "everything else is stuck is the one that has been switched off",
        );
        await stop.click();

        await until(
          "the editor stops reporting an in-flight generate after Stop",
          async () => (await busyState(page)) === "",
          20_000,
        ).catch(() => {
          /* expectUsable reports it in the user's terms */
        });
        await expectUsable(page, "pressing Stop during a generate");
        await expectNoError(page, "abandoning a generate with Stop");
        const afterStop = await straysWithin(page, 30_000);
        expect(
          afterStop.length === 0,
          `${afterStop.length} element(s) appeared on the slide up to 30s after Stop was pressed ` +
            `(${afterStop.join(", ")}) — pressing Stop stopped the spinner but not the work`,
        );
        note("Stop: labelled, live while busy, editor idle after, nothing arrived");

        // ── 3. The editor is not poisoned — ask again, and get an element ──
        // The ONE generate this flow pays for in full.
        const before = (await pieceIds(page)).length;
        const blockedThird = await startGenerate(
          page,
          { x0: 0.08, y0: 0.10, x1: 0.52, y1: 0.34 },
          "a bold headline reading “Second thoughts”",
        );
        // NOT a graceful skip, unlike the two above: this is the assertion.
        // "You cancelled twice and now the editor will not start anything" is
        // precisely the poisoned state the flow exists to catch, so a refusal
        // here fails and quotes what the editor said.
        expect(
          !blockedThird,
          `a generate started after two cancellations never got going — ${blockedThird} — so the ` +
            "cancels left the editor unable to do the thing the user came back for",
        );
        note("generate #3 in flight — this one is allowed to finish");
        // 300s: a stalled attempt (120s cap) plus its retry must FIT, or a
        // recovered stall gets reported as a failure.
        await until(
          "the element asked for after two cancellations actually lands",
          async () => (await pieceIds(page)).length > before,
          300_000,
        );
        const gained = (await pieceIds(page)).length - before;
        await expectNoError(page, "generating again after cancelling twice");
        expect(
          gained > 0,
          "a generate started after two cancellations produced nothing — the editor was left poisoned " +
            "by the cancels, and the user's only fix is a page reload",
        );
        // NOT asserted, because nobody has confirmed it: the route takes no
        // abort signal, so an abandoned request may well finish server-side
        // and surface on the next canvas reload. If it does, `gained` is 3
        // rather than 1 and this note is where that shows up. Asserting a
        // number here would be stating a hypothesis as a conclusion.
        note(
          gained === 1
            ? "generate #3 landed 1 element — the two cancelled requests left nothing behind"
            : `generate #3 landed ${gained} elements — more than the one asked for, so the cancelled ` +
              "requests appear to have completed server-side and surfaced on the reload (worth a probe)",
        );
      } finally {
        await discard(page, base, id);
      }
    },
  },

  {
    name: "JOURNEY E — a session that dies mid-edit says so, and offers the way back",
    // FREE: expiry costs nothing to provoke, so this runs on every QA run.
    tier: "free",
    needsAuth: true,
    mutates: true,
    run: async ({ page, base, note }) => {
      const id = await newDocumentByClicking(page, base);
      note(`blank document ${id}`);
      const context: BrowserContext = page.context();
      // Kept so the flow can hand the session back before cleaning up — the
      // discard below is a signed-in DELETE, and a flow that expired its own
      // session would leave its document behind forever.
      const session = await context.cookies();

      try {
        await startBuilding(page);
        await addTextBox(page);

        // Expiry, simulated the only way a browser can: take the cookies away
        // mid-edit and make a gesture. Clerk's middleware answers a dead
        // session on /api/preview/* with an HTML 404 — to a fetch that
        // expected JSON — which is how every gesture after an expiry used to
        // read "request failed (404)" forever, with no hint that signing back
        // in fixed everything.
        await context.clearCookies();
        note("auth cookies cleared — the session is now dead from the server's point of view");

        // A deterministic gesture, so nothing about this depends on a model.
        await tool(page, "Text").click();

        // Order matters: the explanation is checked BEFORE the error strip,
        // because an editor that does both is behaving correctly and only the
        // bare strip on its own is the bug.
        const surface = async (): Promise<DeadSessionSurface> => {
          if (/\/sign-in/.test(page.url())) return "sign-in-page";
          const explained = await page
            .getByText(/session expired/i)
            .first()
            .isVisible()
            .catch(() => false);
          if (explained) return "explained";
          return (await errorStrip(page)) ? "bare-failure" : "nothing";
        };

        let seen: DeadSessionSurface = "nothing";
        await until(
          "the editor reacts to the dead session",
          async () => {
            seen = await surface();
            return seen !== "nothing";
          },
          30_000,
        ).catch(() => {
          /* "nothing" is itself an outcome — reported below, not thrown */
        });

        if (seen === "nothing") {
          // Rule of this suite: a flow that cannot reach its subject says so.
          // Clearing cookies did not end the session here — a dev instance
          // without Clerk configured, say — so the expiry path is NOT covered
          // by this run, and pretending otherwise would be worse than a skip.
          note(
            "SKIPPED the expiry assertion: clearing the auth cookies did not end the session in this " +
              "environment (the edit still went through), so there was no expiry to observe",
          );
        } else {
          const said = seen === "bare-failure" ? await errorStrip(page) : null;
          expect(
            seen !== "bare-failure",
            `a session that expired mid-edit says only "${said}" — the user is left clicking a dead ` +
              "editor, one red strip per gesture, with no idea that signing back in fixes everything " +
              "and that nothing was lost",
          );
          if (seen === "explained") {
            // Explaining is half of it. The other half is a way out.
            //
            // Located by where it GOES, not by `.first()` on its name: the
            // editor chrome carries no other sign-in link, so this resolves to
            // exactly one element — and if a second one ever appears,
            // Playwright's strict mode says so loudly instead of quietly
            // picking whichever the DOM listed first.
            const wayBack = page.locator('a[href^="/sign-in"]');
            await wayBack.waitFor({ state: "visible", timeout: 10_000 });
            const href = (await wayBack.getAttribute("href")) ?? "";
            const back = decodeURIComponent(/redirect_url=([^&]*)/.exec(href)?.[1] ?? "");
            expect(
              back.includes(id),
              `the way back out of the expiry message points at "${href}" — signing in has to return ` +
                "the user to the document they were editing, not drop them somewhere they then have " +
                "to navigate from",
            );
            note(`expiry explained in place, and the way back returns to ${back}`);
          } else {
            note("the app took the user straight to sign-in when the session died");
          }
        }
      } finally {
        // Hand the session back BEFORE cleaning up, or the discard is a
        // signed-out DELETE and the document survives the run.
        await context.addCookies(session).catch(() => {});
        await discard(page, base, id);
      }
    },
  },

  {
    name: "no interrupted-journey document is left behind",
    tier: "free",
    needsAuth: true,
    mutates: true,
    run: async ({ page, base, note }) => {
      const leftovers = [...created];
      for (const docId of leftovers) await discard(page, base, docId);
      note(leftovers.length ? `cleaned up ${leftovers.length}` : "nothing left behind");
      expect(created.size === 0, `could not clean up: ${[...created].join(", ")}`);
    },
  },
];
