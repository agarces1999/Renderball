//
// JOURNEY D — "someone sent me a link".
//
// The recipient is a user too, and until now nothing tested their side of the
// product. They have no account, they did not choose this tool, and they are
// usually holding a phone: a link lands in a chat, they tap it on the train,
// and the thirty seconds that follow are the entire impression Renderball makes
// on them. If the deck arrives as a white rectangle, or the arrows do nothing,
// or a dead link greets them with Next's black-and-white 404, the person who
// sent it looks bad and nobody who could have noticed ever will.
//
// WHAT IS ALREADY COVERED, so this file does not repeat it. `share.ts` proves
// the ROUTES behave — statuses, revocation, token probes, the unfurl — and
// journey B opens one link once, in a desktop context, and clicks Next. Both
// are about the server. Neither one is a person reading a deck.
//
// So this file has one point of view and holds it: the owner half is thin and
// entirely CLICKED (the link is minted and revoked through the ShareButton
// panel, because that panel is the only place the product ever promises "anyone
// with the link can view", and a link created by a fetch proves nothing about
// the control an owner actually operates), and everything after the link exists
// is asserted from a context with NO cookies, NO session and a 375×812 screen.
// `page.request` appears once, in cleanup, where a failed run has no UI left to
// click.
//
// Assertions are phrased as what the RECIPIENT would conclude — "the deck
// arrived blank", not "the iframe had two child nodes" — because that is the
// only form in which a failure here is actionable.
//
import { randomBytes } from "crypto";
import type { BrowserContext, Page } from "playwright";
import type { Flow } from "../harness";
import { expect, until } from "../harness";
import { pieceIds } from "../editor";

/** The deck the suite drives, which this journey shares. */
const fixtureId = (): string => process.env.QA_DEV_SCRIPT_ID ?? "";

/** A phone. The recipient's screen is the point of this journey, not a detail. */
const PHONE = { width: 375, height: 812 };

/**
 * Open the fixture deck AS ITS OWNER, or say why that is not possible.
 *
 * `/preview/[id]` is owner-scoped — `loadScript` filters by ownerId and
 * `notFound()`s anything else — so the deck the rest of the suite drives
 * through the dev harness is only reachable here when the account in
 * QA_TEST_EMAIL happens to own it. That is a configuration fact about the
 * machine, not a defect in the product, and a journey that failed on it would
 * be pointing at the wrong thing entirely. It returns a reason instead, and the
 * flow skips saying so out loud.
 */
const openFixtureAsOwner = async (
  page: Page,
  base: string,
): Promise<{ id: string } | { skip: string }> => {
  const id = fixtureId();
  if (!id) return { skip: "no fixture document is configured (QA_DEV_SCRIPT_ID is empty)" };

  const res = await page.goto(`${base}/preview/${encodeURIComponent(id)}`, {
    waitUntil: "domcontentloaded",
  });
  const status = res?.status() ?? 0;
  if (status >= 400 || !/\/preview\//.test(page.url())) {
    return {
      skip:
        `the fixture deck ${id} does not belong to the signed-in QA account ` +
        `(/preview/${id} answered ${status} and landed on ${page.url()}) — ` +
        "point QA_DEV_SCRIPT_ID at a deck that account owns, or sign in as its owner",
    };
  }
  return { id };
};

/**
 * The share panel's link, created if there isn't one — by clicking.
 *
 * waitFor, never isVisible({timeout}): the panel fetches its share state before
 * it can render anything and shows "Checking…" meanwhile, so a non-polling
 * check answers false and the button is never pressed. That exact mistake has
 * been paid for twice in this suite (the Clerk code field, then journey B's
 * share step); it is not paid for a third time here.
 *
 * Returns the reason instead of a link when the panel cannot report a state at
 * all — which is what an unowned document or a dead session looks like from the
 * outside, and is not this journey's subject.
 */
const shareLinkByClicking = async (page: Page): Promise<{ url: string } | { skip: string }> => {
  const button = page.locator("[data-rb-share]").first();
  const present = await button
    .waitFor({ state: "visible", timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  if (!present) return { skip: "the editor opened but never showed a share control" };
  await button.click();

  // The panel by its own role and label, not by position: it is one of several
  // popovers this header can open, and `.first()` over a comma-selector has
  // picked the wrong one in this codebase before.
  const panel = page.getByRole("dialog", { name: /share this document/i });
  await panel.waitFor({ state: "visible", timeout: 15_000 });

  const create = panel.getByRole("button", { name: /create a link/i }).first();
  const field = panel.getByRole("textbox", { name: /public link/i }).first();

  // isVisible with no timeout INSIDE until() is the correct pairing — until
  // does the polling, the check answers now.
  const decided = await until(
    "the share panel finishes checking and offers either a link or a way to make one",
    async () =>
      (await create.isVisible().catch(() => false)) || (await field.isVisible().catch(() => false)),
    25_000,
  )
    .then(() => true)
    .catch(() => false);
  if (!decided) {
    const said = (await panel.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    return { skip: `the share panel never resolved its state — it says: "${said.slice(0, 120)}"` };
  }

  if (await create.isVisible().catch(() => false)) await create.click();
  await field.waitFor({ state: "visible", timeout: 20_000 });
  const url = await field.inputValue();
  expect(
    /\/s\/[^/]+$/.test(url),
    `the panel should hand the owner a public link to send, and instead shows "${url}"`,
  );
  return { url };
};

/** A browser with none of the owner's cookies, on a phone-sized screen. */
const recipientContext = async (page: Page): Promise<BrowserContext> =>
  page.context().browser()!.newContext({
    viewport: PHONE,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });

interface Paint {
  /** The frame is the "this link is no longer active" document. */
  gone: boolean;
  /** Something opaque sits between the recipient and the slide (the loading veil). */
  covered: boolean;
  /** Elements that actually put ink on the page: a fill, or their own text. */
  painted: number;
  text: string;
}

/**
 * What the recipient can SEE inside the deck frame.
 *
 * Deliberately hook-free. `data-piece` exists in built compositions, but a
 * viewer assertion that depends on our own build-time attributes would pass on
 * a slide that renders nothing a human could see; counting fills and text
 * measures the thing being claimed. `covered` is read with elementFromPoint
 * rather than by class name — if the loading veil never lifts, the recipient is
 * looking at a blank rectangle no matter how well the frame behind it rendered.
 */
const paintOf = async (visitor: Page): Promise<Paint> =>
  visitor.evaluate(() => {
    const blank: {
      gone: boolean;
      covered: boolean;
      painted: number;
      text: string;
    } = { gone: false, covered: true, painted: 0, text: "" };
    const f = document.querySelector("iframe") as HTMLIFrameElement | null;
    const d = f?.contentDocument;
    if (!f || !d?.body) return blank;

    const host = f.getBoundingClientRect();
    const onTop = document.elementFromPoint(host.left + host.width / 2, host.top + host.height / 2);
    const covered = onTop?.tagName !== "IFRAME";

    let painted = 0;
    for (const el of Array.from(d.body.querySelectorAll("*"))) {
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      const cs = d.defaultView?.getComputedStyle(el);
      const bg = cs?.backgroundColor ?? "";
      const filled =
        (cs?.backgroundImage ?? "none") !== "none" ||
        (!!bg && !/^rgba\(0, 0, 0, 0\)$|^transparent$/.test(bg));
      const inks = !el.firstElementChild && (el.textContent ?? "").trim().length > 0;
      if (filled || inks) painted++;
    }

    return {
      gone: d.body.hasAttribute("data-share-gone"),
      covered,
      painted,
      text: (d.body.innerText ?? "").replace(/\s+/g, " ").trim(),
    };
  });

/**
 * Nothing a person would call a page.
 *
 * Two signals, either of which is enough, because the viewer scales a 1920px
 * canvas down to ~335px on a phone: at that scale plenty of real elements
 * measure under a few pixels and stop counting as ink, so a slide that is
 * genuinely there can look sparse by geometry alone. Decks are made of words —
 * if there is neither ink nor text, the recipient is looking at a white box.
 */
const looksBlank = (p: Paint): boolean => p.gone || (p.painted < 3 && p.text.length < 20);

/**
 * Wait until the slide is actually on screen, and hand back what is on it.
 *
 * Waits for the VEIL to lift (the viewer covers the frame with a counter until
 * the document loads) and then reports whatever is there, rather than waiting
 * for content: a page that loads blank should be reported as blank, in those
 * words, not as a timeout whose message says nothing about what went wrong.
 *
 * 90s for the first page: the frame is compiled on demand (esbuild over
 * Composition.tsx) and the suite runs several flows against one dev server, so
 * a cold first page legitimately takes far longer than a warm one. A wait sized
 * to the warm case reports a healthy product as broken, which is worse than a
 * slow test.
 */
const slideOnScreen = async (visitor: Page, what: string, timeoutMs = 90_000): Promise<Paint> => {
  await until(what, async () => !(await paintOf(visitor)).covered, timeoutMs);
  // A beat for the frame to paint what it just loaded.
  await visitor.waitForTimeout(300);
  return paintOf(visitor);
};

/**
 * Where the recipient is in the deck, as two numbers.
 *
 * Read as digits, never matched against a string: the counter carries live
 * state, and a suite that hardcodes "1 / 5" breaks the day somebody improves
 * the label — which has already happened once here, to the PNG button, the
 * night that flow was written.
 */
const counterOn = async (visitor: Page): Promise<{ at: number; of: number } | null> =>
  visitor.evaluate(() => {
    const m = /(\d+)\s*\/\s*(\d+)/.exec(document.querySelector("footer")?.innerText ?? "");
    return m ? { at: Number(m[1]), of: Number(m[2]) } : null;
  });

/** An arrow, by what it means to a person rather than by which glyph it wears. */
const arrow = (visitor: Page, direction: "next" | "previous") =>
  visitor
    .getByRole("button", { name: direction === "next" ? /next page/i : /previous page/i })
    .first();

const turnPage = async (
  visitor: Page,
  direction: "next" | "previous",
  landOn: number,
): Promise<void> => {
  const control = arrow(visitor, direction);
  await control.waitFor({ state: "visible", timeout: 15_000 });
  await control.click();
  await until(
    `the ${direction} arrow takes the recipient to page ${landOn}`,
    async () => (await counterOn(visitor))?.at === landOn,
    30_000,
  );
};

/**
 * Text a recipient must never be shown, and what seeing it would tell them.
 *
 * The pairing matters: the failure message has to say what the person on the
 * other end concluded, and "a JSON parse error is on the slide" is a sentence
 * about them, whereas "regex #4 matched" is a sentence about the test.
 */
const WIRE: { re: RegExp; human: string }[] = [
  { re: /\[object Object\]/, human: "a raw object printed where a sentence belongs" },
  { re: /\bundefined\b/, human: '"undefined" printed as copy' },
  { re: /\bNaN\b/, human: '"NaN" where a number belongs' },
  { re: /Unexpected token|SyntaxError|is not valid JSON|JSON\.parse/i, human: "a JSON parse error" },
  {
    re: /TypeError|ReferenceError|Cannot read propert(y|ies)|is not a function/i,
    human: "a JavaScript error",
  },
  {
    re: /Unhandled Runtime Error|Application error: a client-side exception|Internal Server Error/i,
    human: "a crash page",
  },
  {
    re: /\b(scriptId|sceneIndex|shareToken|ownerId|contentPath|data-piece)\b/,
    human: "one of our internal identifiers",
  },
  { re: /^\s*[[{]\s*"/, human: "a raw JSON payload served as the page" },
];

const wireTextIn = (text: string): string[] =>
  WIRE.filter((w) => w.re.test(text)).map((w) => w.human);

/**
 * A link that leads nowhere has to EXPLAIN ITSELF, in our voice.
 *
 * Two failure modes, both of which a recipient meets and neither of which is
 * about status codes. Next's stock 404 is a dead end that makes the sender look
 * like they sent a broken URL; and a page that states as FACT that the link was
 * turned off is a lie whenever the token was simply mistyped, garbled by a chat
 * client, or invented — the deck is fine and the recipient goes back to the
 * sender with a false story. Hedged copy ("it may have been turned off") is the
 * honest form, because the server genuinely cannot tell those apart, which is
 * the same indistinguishability lib/share.ts is built around.
 */
const brandedDeadEnd = async (
  visitor: Page,
  url: string,
  what: string,
): Promise<{ text: string }> => {
  const res = await visitor.goto(url, { waitUntil: "domcontentloaded" });
  expect(res?.status() === 404, `${what} should answer 404, got ${res?.status()}`);

  // innerText needs LAYOUT, and at domcontentloaded there may be none yet —
  // it returned "" for a page whose markup (verified by curl) says
  // "Renderball" three times, which then read as a missing brand. Wait for
  // the page to actually paint something before judging what it says.
  await visitor.waitForLoadState("load").catch(() => {});
  await until(
    "the dead-end page renders its text",
    async () => ((await visitor.evaluate(() => document.body.innerText ?? "")) || "").trim().length > 0,
    15_000,
  ).catch(() => {});

  const seen = await visitor.evaluate(() => ({
    text: (document.body.innerText ?? "").replace(/\s+/g, " ").trim(),
    wayOut: Array.from(document.querySelectorAll("a")).some(
      (a) => (a.getAttribute("href") ?? "") === "/",
    ),
  }));

  expect(
    !/This page could not be found/i.test(seen.text) && seen.text.replace(/\W/g, "") !== "404",
    `${what} showed the recipient the framework's stock 404 — ` +
      "they have no idea whether the link is dead or the product is",
  );
  expect(
    /renderball/i.test(seen.text),
    `${what} showed a page that never says who it is from ("${seen.text.slice(0, 90)}") — ` +
      "the recipient cannot tell a revoked deck from a broken website",
  );
  expect(
    seen.wayOut,
    `${what} left the recipient with no way forward — a dead link is the only Renderball page ` +
      "most of these people will ever see, and it should offer them the product",
  );

  const statesAsFact =
    /(has|have|was|were) been (turned off|revoked|disabled|deleted)|(is|was) (no longer|now) (active|shared|available)/i;
  const hedged = /\b(may|might|maybe|perhaps|if)\b/i;
  expect(
    !statesAsFact.test(seen.text) || hedged.test(seen.text),
    `${what} told the recipient as a matter of fact that the sender turned the link off: ` +
      `"${seen.text.slice(0, 140)}". The server cannot know that — a mistyped or chat-mangled ` +
      "link reads identically — so this sends people back to the sender with a false story",
  );

  return seen;
};

export const recipientFlows: Flow[] = [
  {
    name: "JOURNEY D — someone sent me a link, and I open it on my phone with no account",
    // FREE: nothing here generates. Sharing is a database write, the viewer is
    // read-only, and the deck already exists — so this runs on every QA run,
    // which is the whole point of a journey nobody would otherwise re-test.
    tier: "free",
    needsAuth: true,
    // Writes a share token onto the fixture's row, so it runs alone.
    mutates: true,
    run: async ({ page, base, note }) => {
      const opened = await openFixtureAsOwner(page, base);
      if ("skip" in opened) {
        note(`skipped: ${opened.skip}`);
        return;
      }
      const { id } = opened;

      // The deck must be GOOD before the recipient's view is judged. Without
      // this, an empty fixture would fail the "the pages actually render"
      // assertion below and blame the viewer for a deck that has nothing on it —
      // a confusing red that sends somebody debugging the wrong component.
      const ownerSees = await until(
        "the owner's own canvas renders the deck",
        async () => (await pieceIds(page)).length > 0,
        90_000,
      )
        .then(() => true)
        .catch(() => false);
      if (!ownerSees) {
        note(`skipped: the fixture deck ${id} renders nothing for its OWNER, so a blank shared view would not be the viewer's fault`);
        return;
      }

      const link = await shareLinkByClicking(page);
      if ("skip" in link) {
        note(`skipped: ${link.skip}`);
        return;
      }
      // Navigate against the base under test rather than the origin baked into
      // the panel's value, so this still works through a tunnel or a preview
      // deployment. The panel's own URL is asserted above.
      const linkPath = link.url.replace(/^https?:\/\/[^/]+/, "");
      note(`owner created ${linkPath}`);

      let created = true;
      const anon = await recipientContext(page);
      try {
        const visitor = await anon.newPage();

        // ── 1. The link opens, and the deck is actually on the screen ────────
        const landed = await visitor.goto(`${base}${linkPath}`, { waitUntil: "domcontentloaded" });
        expect(
          landed?.status() === 200,
          `a stranger with no account should be able to open the link they were sent, got ${landed?.status()}`,
        );

        // One frame, so every read below is unambiguously the deck. Stated as an
        // assertion rather than assumed: `querySelector("iframe")` silently
        // measures the wrong thing the day a second frame appears, and this
        // journey's every conclusion is drawn through that one call.
        const frames = await visitor.evaluate(() => document.querySelectorAll("iframe").length);
        expect(frames === 1, `the shared deck should show exactly one page at a time, saw ${frames} frames`);

        const first = await slideOnScreen(
          visitor,
          "the first page of the deck appears for the recipient",
        );
        expect(
          !first.gone,
          "the recipient was told the link is no longer active while the deck is live and open " +
            "in the owner's editor — the worst possible lie for a link somebody just sent",
        );
        expect(
          !looksBlank(first),
          `the deck arrived as a blank frame — ${first.painted} things with any ink on them and ` +
            `${first.text.length} characters of text, on a page the owner's own editor renders fine`,
        );
        note(`page 1: ${first.painted} painted elements, ${first.text.length} chars`);

        // ── 2. It fits a phone ───────────────────────────────────────────────
        const layout = await visitor.evaluate(() => {
          const f = document.querySelector("iframe") as HTMLIFrameElement | null;
          const r = f?.getBoundingClientRect();
          return {
            overflow: document.documentElement.scrollWidth - window.innerWidth,
            frameW: Math.round(r?.width ?? 0),
            frameH: Math.round(r?.height ?? 0),
            screenW: window.innerWidth,
            // Noted, not asserted — see below.
            taps: Array.from(document.querySelectorAll("footer button")).map((b) => {
              const q = b.getBoundingClientRect();
              return Math.round(Math.min(q.width, q.height));
            }),
          };
        });
        expect(
          layout.overflow <= 2,
          `the shared deck is ${layout.overflow}px wider than the phone screen — the recipient ` +
            "has to pan sideways to read a document somebody sent them",
        );
        expect(
          layout.frameW >= layout.screenW * 0.6,
          `the slide is ${layout.frameW}px wide on a ${layout.screenW}px screen — it arrives as a stamp`,
        );
        // The arrows measure ~30px against the 44px both platforms recommend
        // for a touch target. That is a DESIGN.md judgement for the founder, not
        // something this journey should turn the suite red over, so it is
        // reported every run and left as a number.
        note(`phone: slide ${layout.frameW}×${layout.frameH}, arrow targets ${layout.taps.join("/")}px`);

        // ── 3. The arrows work — in BOTH directions ─────────────────────────
        const start = await counterOn(visitor);
        expect(
          !!start && start.at === 1,
          `the recipient should open on page 1 of the deck, and the viewer says "${JSON.stringify(start)}"`,
        );
        const total = start!.of;
        expect(
          total >= 1,
          `the viewer should tell the recipient how long the deck is, and reports ${total} pages`,
        );

        expect(
          await arrow(visitor, "previous").isDisabled(),
          "the back arrow is live on the first page — a recipient who taps it learns nothing happens, " +
            "which is how a working deck starts feeling broken",
        );

        if (total === 1) {
          note("single-page deck — nothing to page through");
        } else {
          // Walk to the LAST page, one arrow press at a time, checking each
          // page actually renders on the way. A deck whose page 4 is blank is
          // exactly the failure the sender never sees, because they only ever
          // look at their own editor.
          const reach = Math.min(total, 20);
          if (reach < total) note(`walking the first ${reach} of ${total} pages`);
          const blank: number[] = [];
          for (let at = 2; at <= reach; at++) {
            await turnPage(visitor, "next", at);
            const paint = await slideOnScreen(visitor, `page ${at} appears for the recipient`, 60_000);
            if (looksBlank(paint)) blank.push(at);
          }
          expect(
            blank.length === 0,
            `the recipient pages into ${blank.length} blank slide(s) (page ${blank.join(", ")}) — ` +
              "the deck's own author never sees this, because they only look at their editor",
          );
          const atEnd = await counterOn(visitor);
          expect(
            atEnd?.at === reach,
            `pressing the arrow ${reach - 1} times should reach page ${reach}, and the viewer says ${atEnd?.at}`,
          );
          if (reach === total) {
            expect(
              await arrow(visitor, "next").isDisabled(),
              "the forward arrow is still live on the last page — the recipient cannot tell they " +
                "have reached the end of the deck",
            );
          }

          // BACK again. One direction passing proves nothing about the other:
          // this suite has already shipped a resize that grew and refused to
          // shrink, and a viewer that only walks forward would hide the same
          // shape of bug in the only navigation a recipient has.
          for (let at = reach - 1; at >= 1; at--) await turnPage(visitor, "previous", at);
          const home = await counterOn(visitor);
          expect(
            home?.at === 1,
            `walking back with the other arrow should return to page 1, and the viewer says ${home?.at} — ` +
              "forward-only navigation strands a recipient who overshoots",
          );
          note(`paged 1 → ${reach} → 1 with the arrows`);
        }

        // ── 4. Nothing anywhere reads like a developer wrote it ─────────────
        const surface = await visitor.evaluate(() => ({
          body: (document.body.innerText ?? "").replace(/\s+/g, " ").trim(),
          title: document.title,
        }));
        const frameNow = await paintOf(visitor);
        const leaked = [
          ...wireTextIn(surface.body).map((h) => `${h} (on the page)`),
          ...wireTextIn(surface.title).map((h) => `${h} (in the browser tab)`),
          ...wireTextIn(frameNow.text).map((h) => `${h} (on the slide)`),
        ];
        expect(
          leaked.length === 0,
          `the recipient is shown ${leaked.join("; ")} — they have no account, no context and no ` +
            "reason to forgive it; this is what the product looks like to them",
        );
        expect(
          surface.title.trim().length > 0 && !/^\s*[[{]/.test(surface.title),
          `the browser tab reads "${surface.title}" — a shared deck should be titled like a document`,
        );
        note("no wire text, JSON or developer vocabulary anywhere the recipient can see");

        // ── 5. It is a READER, not the owner's editor ────────────────────────
        const chrome = await visitor.evaluate(() => ({
          hooks: document.querySelectorAll(
            "[data-rb-tool],[data-rb-share],[data-rb-selected],[data-rb-selection],[data-rb-delete-document],[data-rb-confirm-delete],[data-rb-font-slot]",
          ).length,
          labels: Array.from(document.querySelectorAll('button, a, [role="menuitem"]'))
            .map((el) =>
              (
                el.getAttribute("aria-label") ||
                el.getAttribute("title") ||
                el.textContent ||
                ""
              )
                .replace(/\s+/g, " ")
                .trim(),
            )
            .filter(Boolean),
        }));
        expect(
          chrome.hooks === 0,
          `the shared view ships ${chrome.hooks} of the owner's own controls — a recipient must ` +
            "never be one tap away from editing or deleting somebody else's document",
        );
        const ownerish = chrome.labels.filter((l) =>
          /\b(delete|remove|regenerate|export|download|duplicate|rename|share|sign out|new document|upload)\b/i.test(
            l,
          ),
        );
        expect(
          ownerish.length === 0,
          `the shared view offers the recipient owner actions: ${ownerish.join(", ")}`,
        );

        // And the deck itself does not become editable when they poke at it —
        // the gesture that opens a text box in the editor is a double-tap, and
        // a recipient reading on a phone will make it by accident.
        const copyAt = await visitor.evaluate(() => {
          const f = document.querySelector("iframe") as HTMLIFrameElement | null;
          const d = f?.contentDocument;
          if (!f || !d?.body) return null;
          const host = f.getBoundingClientRect();
          let best: { area: number; x: number; y: number } | null = null;
          for (const el of Array.from(d.body.querySelectorAll("*"))) {
            if (el.firstElementChild) continue;
            if (!(el.textContent ?? "").trim()) continue;
            const r = el.getBoundingClientRect();
            if (r.width < 12 || r.height < 8) continue;
            const area = r.width * r.height;
            if (!best || area > best.area) {
              best = { area, x: host.left + r.left + r.width / 2, y: host.top + r.top + r.height / 2 };
            }
          }
          return best ? { x: best.x, y: best.y } : null;
        });
        if (copyAt) {
          await visitor.mouse.dblclick(copyAt.x, copyAt.y);
          await visitor.waitForTimeout(800);
          const editable = await visitor.evaluate(() => {
            const d = (document.querySelector("iframe") as HTMLIFrameElement | null)?.contentDocument;
            return (
              document.querySelectorAll('[contenteditable="true"]').length +
              (d?.querySelectorAll('[contenteditable="true"]').length ?? 0)
            );
          });
          expect(
            editable === 0,
            "double-tapping the copy put the recipient into a text editor on somebody else's deck",
          );
          note("read-only: double-tapping the copy edits nothing");
        } else {
          note("no text large enough to double-tap — read-only gesture unchecked on this deck");
        }

        // ── 6. A link that was never real, met the way a mangled one is ──────
        // Right shape, never issued: the token a chat client garbles, or a
        // character dropped on the way into a message.
        await brandedDeadEnd(
          visitor,
          `${base}/s/${randomBytes(32).toString("base64url")}`,
          "a link that was never issued",
        );
        note("an invented token explains itself in our voice");

        // ── 7. The owner turns it off, and the recipient is told the truth ───
        const panel = page.getByRole("dialog", { name: /share this document/i });
        if (!(await panel.isVisible().catch(() => false))) {
          await page.locator("[data-rb-share]").first().click();
          await panel.waitFor({ state: "visible", timeout: 15_000 });
        }
        await panel.getByRole("button", { name: /stop sharing/i }).first().click();
        // The owner's own proof that it worked: the panel falls back to
        // offering a new link. Asserted from the owner's screen because "did
        // that button do anything?" is the question the panel exists to answer.
        await panel
          .getByRole("button", { name: /create a link/i })
          .first()
          .waitFor({ state: "visible", timeout: 20_000 });
        created = false;
        note("owner clicked Stop sharing");

        // Mid-read revocation, which is the realistic version of this: the tab
        // is still open, and the next arrow press is what discovers it. The
        // frame has its own copy for this, and it must not be a blank rectangle.
        if (total > 1) {
          await arrow(visitor, "next").click();
          const after = await until(
            "the frame says something about the link it can no longer load",
            async () => {
              const p = await paintOf(visitor);
              return !p.covered && (p.gone || p.text.length > 0);
            },
            30_000,
          )
            .then(() => paintOf(visitor))
            .catch(() => null);
          expect(
            !!after && after.text.length > 0,
            "the link was revoked while the recipient was reading and the next page came up as an " +
              "empty white rectangle — nothing tells them what happened or what to do",
          );
          note(`mid-read revocation: the frame says "${(after?.text ?? "").slice(0, 60)}"`);
        }

        // And the link itself, reopened — a WhatsApp thread keeps working links
        // forever, so this is the most common way a revoked deck is met.
        await brandedDeadEnd(visitor, `${base}${linkPath}`, "a revoked link, reopened");
        note("revoked link explains itself in our voice too");
      } finally {
        await anon.close().catch(() => {});
        // Cleanup, and the one place page.request belongs in this file: after a
        // failure the owner's page may be anywhere at all, and there is no UI
        // left to click. The UI path is the asserted one above.
        if (created) {
          await page.request
            .fetch(`${base}/api/preview/share`, {
              method: "DELETE",
              headers: { "Content-Type": "application/json" },
              data: { scriptId: id },
              failOnStatusCode: false,
            })
            .catch(() => {});
        }
      }
    },
  },

  {
    // No account, no fixture, no owner — so this one runs even on a checkout
    // with no test credentials, where the journey above skips. A dead link is
    // the single most-viewed page this product has, and it should never be
    // untested for want of a password.
    name: "a share link that leads nowhere explains itself instead of showing a stock 404",
    tier: "free",
    run: async ({ page, base, note }) => {
      const anon = await recipientContext(page);
      try {
        const visitor = await anon.newPage();
        // The shapes a real recipient arrives with: a token that was never
        // issued, one a chat client truncated, and one somebody retyped wrong.
        const issued = randomBytes(32).toString("base64url");
        const arrivals: [string, string][] = [
          [issued, "a link that was never issued"],
          [issued.slice(0, 20), "a link truncated by a chat client"],
          [`${issued.slice(0, 42)}x`, "a link with one character retyped wrong"],
        ];
        for (const [token, what] of arrivals) {
          const seen = await brandedDeadEnd(visitor, `${base}/s/${token}`, what);
          const leaked = wireTextIn(seen.text);
          expect(
            leaked.length === 0,
            `${what} shows the recipient ${leaked.join("; ")}`,
          );
        }
        note(`${arrivals.length} dead links, all branded and all honest about what they know`);
      } finally {
        await anon.close().catch(() => {});
      }
    },
  },
];
