//
// JOURNEY F — "I ran out, and I want to leave".
//
// The two paths nothing in this suite has ever walked: the one where the
// PRODUCT says no, and the one where the CUSTOMER says no. Every other journey
// assumes both parties are willing. These are the moments where somebody is
// already unhappy — they have been refused, or they are on their way out — and
// they are the two moments where a small ugliness costs the most.
//
// WHAT IS ACTUALLY TESTABLE HERE. Lemon Squeezy is not configured on this
// machine, so `isBillingLive()` is false and there is no checkout to click. The
// thing that can be asserted in EVERY environment is that /billing tells ONE
// story: a meter showing what has gone, and a next step that matches whichever
// state the product is really in — either a way to pay, or a plain statement
// that there is nothing to pay yet AND how to get more. A page that shows a
// ceiling and offers nothing is the dead end this journey exists to catch. It
// is not hypothetical: the deny copy in lib/entitlement.ts used to advertise an
// upgrade that does not exist and marched people to a page with no pay button
// on it, which is a refund conversation dressed as a feature.
//
// SAFETY — THE HARD CONSTRAINT. This suite shares ONE test account with every
// other signed-in flow, and account deletion is the single irreversible action
// the product offers. So nothing here deletes anything. What is asserted is the
// GATE: that one click does not delete, that the confirmation wants a phrase
// typed, that Cancel puts it all back, and that the account still works
// afterwards. The phrase that arms the button is never typed — a near miss is
// typed instead — and the irreversible button is never clicked, only read. Any
// future edit that wants to watch a real deletion needs its own throwaway
// account first; there is no safe way to borrow this one.
//
// NO MODEL CALLS, so tier "free": billing and account are read-only pages, and
// the delete gate is client state. The 402 surfaces themselves (the build
// ceremony's "Plan limit" screen and the editor's limit strip) can only be
// reached by being refused a real generation, which costs money — so what this
// journey pins is the page they point AT, and it says so out loud rather than
// implying coverage it does not have.
//
// Same rule as journeys.ts: if a human would use the mouse or the keyboard, so
// does the flow. `page.request` appears once, against /api/usage — the data
// BEHIND the account meter, which has no UI of its own — and only ever to
// explain an absence, never to manufacture a pass.
//
import type { Locator, Page } from "playwright";
import type { Flow } from "../harness";
import { expect, until } from "../harness";

/** Everything the page is saying, as a person would read it. */
const bodyText = async (page: Page): Promise<string> =>
  page.evaluate(() => (document.body?.innerText ?? "").replace(/\s+/g, " ").trim());

/**
 * Wait for the page in front of us to actually SAY something, then hand back
 * what it says.
 *
 * innerText needs LAYOUT. Read at domcontentloaded it comes back empty on a
 * page whose markup is perfectly correct, and every assertion built on that
 * empty string reports missing copy that is sitting right there on the screen —
 * the exact mistake journey-recipient's dead-end check paid for once already.
 * So: wait for load, poll until there is text, and only then judge what it says.
 */
const settledHere = async (page: Page, what: string): Promise<string> => {
  await page.waitForLoadState("load").catch(() => {});
  await until(`${what} renders its text`, async () => (await bodyText(page)).length > 0, 25_000);
  return bodyText(page);
};

const settledOn = async (page: Page, base: string, path: string): Promise<string> => {
  await page.goto(`${base}${path}`, { waitUntil: "domcontentloaded" });
  // ONE retry on a sign-in bounce, and only one.
  //
  // Every signed-in flow replays a stored session rather than signing in
  // again, and under the suite's parallel load a server-rendered page can be
  // reached before that replayed session is accepted — this flow was bounced
  // to /sign-in inside the full run and passed alone, twice, seconds later.
  // Retrying once absorbs that; retrying forever would hide a genuine auth
  // regression, which is the more expensive mistake. A second bounce fails,
  // and the note says it happened so a real problem is not silently smoothed.
  if (/\/sign-in/.test(page.url())) {
    await page.waitForTimeout(1500);
    await page.goto(`${base}${path}`, { waitUntil: "domcontentloaded" });
  }
  return settledHere(page, path);
};

const pathOf = (page: Page): string => new URL(page.url()).pathname;

/**
 * The first match a person can actually SEE.
 *
 * The app shell renders its navigation twice — a desktop rail and a mobile top
 * bar — and only one of them is on screen at a given viewport. `.first()`
 * resolves by DOM order, so it happily hands back the hidden twin, and the
 * click then waits for an element that will never become visible until the flow
 * times out complaining about the wrong thing entirely. `isVisible()` with no
 * timeout is the correct use of it: this asks NOW, and nothing here is waiting.
 */
const firstVisible = async (candidates: Locator): Promise<Locator | null> => {
  const n = await candidates.count();
  for (let i = 0; i < n; i++) {
    const one = candidates.nth(i);
    if (await one.isVisible().catch(() => false)) return one;
  }
  return null;
};

/**
 * Vocabulary that belongs on the wire and never on a page about money.
 *
 * Paired with what the CUSTOMER would conclude, not with what matched: a
 * failure here has to read as a sentence about the person looking at the
 * screen, because that is the only form in which it is actionable.
 */
const WIRE: { re: RegExp; human: string }[] = [
  {
    re: /\bunauthori[sz]ed\b/i,
    human: '"unauthorized" — wire vocabulary for "we cannot tell who you are", on a page they are signed into',
  },
  // Status codes, but only in CONTEXT. A bare three-digit number is not
  // evidence of anything on a page made of counters — a customer who has burned
  // 402 tokens would otherwise read as a leaked HTTP status, and this suite
  // would go red over a working meter. This fires only when the number is
  // wearing its wire clothes.
  {
    re: /\bHTTP\s*\d{3}\b|\b(4\d\d|5\d\d)\s+(error|status|response)\b|\bstatus(?: code)?\s*:?\s*\d{3}\b/i,
    human: "a raw HTTP status code",
  },
  { re: /\bJSON\b|Unexpected token|is not valid JSON/i, human: "JSON said out loud to a customer" },
  { re: /\bundefined\b/, human: '"undefined" where a number or a sentence belongs' },
  { re: /\bNaN\b/, human: '"NaN" where a number belongs' },
  { re: /\[object Object\]/, human: "a raw object printed as copy" },
  {
    re: /Unhandled Runtime Error|Application error: a client-side exception|Internal Server Error|Something went wrong on our side/i,
    human: "a stock crash page",
  },
  { re: /This page could not be found/i, human: "the framework's stock 404" },
];

const wireIn = (text: string): string[] => WIRE.filter((w) => w.re.test(text)).map((w) => w.human);

const expectNoWire = (text: string, where: string): void => {
  const leaked = wireIn(text);
  expect(
    leaked.length === 0,
    `${where} shows the customer ${leaked.join("; ")} — this is the page somebody reads when they ` +
      "are already unhappy about money, and it is the last place that can afford to look unfinished",
  );
};

interface Meter {
  used: number;
  limit: number;
  /** What the page actually printed, for the note. */
  raw: string;
}

/** "1,402" → 1402, "1M" → 1000000, "500k" → 500000. */
const toCount = (raw: string): number => {
  const m = /^(\d+(?:\.\d+)?)\s*([Mk])?$/.exec(raw.replace(/,/g, "").trim());
  if (!m) return NaN;
  const n = Number(m[1]);
  return m[2] === "M" ? n * 1_000_000 : m[2] === "k" ? n * 1_000 : n;
};

/**
 * The usage meters on screen, read as DIGITS out of the rendered text.
 *
 * Never matched against a whole string: a meter's label carries live state
 * ("0 / 1000000 this month" on billing, "0 / 1M free" on the account page) and
 * a suite that hardcodes either one goes red the day somebody improves the
 * copy — which has already happened once here, to the PNG button. What is being
 * asked is "does this page tell me how much I have left", and two numbers with
 * a slash between them is that question's honest form.
 */
const metersIn = (text: string): Meter[] => {
  const out: Meter[] = [];
  for (const m of text.matchAll(/(\d[\d,]*)\s*\/\s*(\d[\d,]*\s*[Mk]?)\b/g)) {
    const used = toCount(m[1]);
    const limit = toCount(m[2]);
    if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0) {
      out.push({ used, limit, raw: m[0].replace(/\s+/g, " ").trim() });
    }
  }
  return out;
};

/** What a control that actually takes money is called, by meaning. */
const PAY_CONTROL = /subscribe|manage (subscription|billing)|add (a )?(payment|card)|checkout|start (metered )?billing/i;

interface BillingSurface {
  text: string;
  meters: Meter[];
  /** A live control that takes money — checkout, or the portal for a subscriber. */
  canPay: boolean;
  payLabel: string;
  /** It says, in so many words, that there is nothing to pay yet. */
  saysNothingToPay: boolean;
  /** It states what generating costs, rather than leaving the person guessing. */
  statesPricing: boolean;
  /** It says how to get past the free allowance without paying. */
  offersMore: boolean;
}

/** Read whatever billing page is currently open — no navigation of its own. */
const billingSurface = async (page: Page): Promise<BillingSurface> => {
  const text = await settledHere(page, "/billing");
  // Buttons and links asked separately rather than as one comma-selector:
  // `.first()` over a comma-selector resolves by DOM order and has picked the
  // wrong element in this codebase repeatedly.
  const payButton = await firstVisible(page.getByRole("button", { name: PAY_CONTROL }));
  const payLink = payButton ? null : await firstVisible(page.getByRole("link", { name: PAY_CONTROL }));
  const pay = payButton ?? payLink;
  return {
    text,
    meters: metersIn(text),
    canPay: !!pay,
    payLabel: pay ? ((await pay.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim() : "",
    saysNothingToPay:
      /nothing to pay|opens shortly|isn'?t live|is not live|not live yet|coming soon|being wired up/i.test(text),
    statesPricing: /per token|free tokens|1M tokens|metered/i.test(text),
    offersMore: /support@[\w.-]+|resets on the 1st|raise it/i.test(text),
  };
};

const openBilling = async (page: Page, base: string): Promise<BillingSurface> => {
  await page.goto(`${base}/billing`, { waitUntil: "domcontentloaded" });
  return billingSurface(page);
};

/**
 * What a CTA's label promises, and whether the destination keeps it.
 *
 * This is the whole point of the journey's middle section. "View usage →" and
 * "See plans →" are the two sentences the product says to somebody it has just
 * refused, and each one is a promise about the page it points at. A CTA that
 * promises plans and lands on a page with no plans is worse than no CTA at all:
 * it costs the customer a click to discover there is nothing here for them, and
 * they conclude the product is broken rather than unfinished.
 *
 * Returns the broken promise as a phrase that completes "…and <this>", or null.
 */
const promiseBroken = (label: string, b: BillingSurface): string | null => {
  if (/\busage\b|\bused\b|\bbalance\b/i.test(label) && b.meters.length === 0) {
    return "the page carries no usage meter at all";
  }
  if (
    /\bplans?\b|pricing|upgrade|subscribe|\bpay\b|payment/i.test(label) &&
    !(b.canPay || (b.statesPricing && b.saysNothingToPay))
  ) {
    return "the page offers neither a way to pay nor a word about why not";
  }
  return null;
};

/**
 * Our own delete-account section, and never Clerk's.
 *
 * Clerk's UserProfile renders on this same page and carries a "Delete account"
 * of its own, which deletes the same identity. Probed 2026-08-04: on the
 * default tab Clerk shows no such button, so today a loose match would in fact
 * find only ours — and that is precisely the kind of fact that changes the day
 * somebody enables another UserProfile tab, with the failure mode being that
 * this flow drives CLERK's deletion while believing it is exercising the gate.
 * So the section is found by the heading that names it (exactly one match on
 * the live page, measured), every control below is scoped inside it, and the
 * arm button is matched on "delete MY account" — wording only ours uses.
 */
const dangerZone = (page: Page): Locator =>
  page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: /^delete account$/i }) })
    .first();

/** The phrase the product wants typed, MISSING ITS LAST LETTER — see the header. */
const NEAR_MISS = "delete my accoun";

export const limitFlows: Flow[] = [
  {
    name: "JOURNEY F — I ran out: the billing page says what I used and what to do about it",
    // FREE: /billing is a read of counters somebody else already wrote. Nothing
    // here generates, and nothing here pays.
    tier: "free",
    needsAuth: true,
    run: async ({ page, base, note }) => {
      const b = await openBilling(page, base);
      expect(
        pathOf(page) === "/billing",
        `a signed-in customer opening the billing page landed on ${page.url()} instead — ` +
          "somebody trying to give us money was shown the door",
      );

      // ── 1. A meter. Being told "you are out" without being told OF WHAT is
      // the complaint that starts every one of these support threads.
      expect(
        b.meters.length > 0,
        "the billing page never says how much of the allowance is gone — the customer has just been " +
          "stopped by a limit and this page, the one place that exists to explain it, shows no numbers",
      );
      for (const m of b.meters) note(`meter: ${m.raw}`);
      const maxed = b.meters.filter((m) => m.used >= m.limit);
      if (maxed.length) note(`${maxed.length} of ${b.meters.length} meters are already at the ceiling`);

      // ── 2. ONE story, and an actionable next step in it.
      note(
        `state: ${b.canPay ? `a live pay control ("${b.payLabel}")` : "no pay control"}, ` +
          `${b.saysNothingToPay ? "says payments are not open yet" : "says nothing about payments being closed"}, ` +
          `${b.offersMore ? "offers a way to get more" : "offers no way to get more"}`,
      );
      expect(
        b.canPay || (b.saysNothingToPay && b.offersMore),
        "the billing page shows a limit and offers nothing to do about it: there is no way to pay, and " +
          "no sentence saying there is nothing to pay yet plus how to get more. Somebody who has just " +
          "been refused arrives here, finds a wall, and leaves",
      );
      expect(
        !(b.canPay && b.saysNothingToPay),
        `the billing page offers "${b.payLabel}" AND says payments are not open yet — one of those is ` +
          "a lie, and the customer finds out which by pressing the button",
      );
      expect(
        b.statesPricing,
        "the billing page never says what generating actually costs — a metered product that will not " +
          "state its meter is asking for a card on trust",
      );

      // ── 3. The pre-pivot price must never come back.
      // Pricing is per token (docs/PIVOT.md); a flat monthly figure here would
      // contradict the landing page and the refund policy at the same time,
      // which is the sort of thing that gets read out in a chargeback.
      const flat = /\$\s?\d[\d.,]*\s*(\/|per\s+)\s*(mo\b|month)/i.exec(b.text);
      expect(
        !flat,
        `the billing page quotes ${flat?.[0]} — pricing is usage-based per token, and a flat monthly ` +
          "figure here contradicts both the landing page and the refund policy",
      );

      expectNoWire(b.text, "the billing page");
      note("one coherent story: a meter, and a next step that matches the state the product is in");
    },
  },

  {
    name: "a plan-limit CTA never lands the customer on a page that contradicts it",
    tier: "free",
    needsAuth: true,
    run: async ({ page, base, note }) => {
      const b = await openBilling(page, base);

      // ── 1. The standing contract.
      // "View usage →" (the build ceremony's Plan limit screen) and "See plans →"
      // (the editor's limit strip) are the only two sentences the product says
      // to somebody it has just refused. Reaching either FOR REAL needs a denied
      // generate, which costs money this journey does not spend — so what is
      // asserted here is the contract those buttons are written against. Said
      // out loud, because a silent gap reads as coverage.
      note(
        "the 402 limit surfaces themselves need a denied generation to appear, which this journey does " +
          "not buy — what is pinned here is the page they send people to",
      );
      for (const promised of ["View usage", "See plans"]) {
        const broken = promiseBroken(promised, b);
        expect(
          !broken,
          `a customer who has just been refused clicks "${promised}" and ${broken} — the message that ` +
            "sent them here promised something this page does not have",
        );
      }
      note("both promises the limit screens make are kept by /billing");

      // ── 2. And every route to billing that is actually on screen — followed
      // by CLICKING it, because a link that exists in the markup and cannot be
      // reached by a mouse is not a way out of anything.
      const followed: string[] = [];
      for (const surface of ["/account", "/documents"]) {
        await settledOn(page, base, surface);
        const labels: string[] = await page.evaluate(() =>
          Array.from(document.querySelectorAll('a[href="/billing"]'))
            .filter((a) => (a as HTMLElement).getClientRects().length > 0)
            .map((a) => (a.textContent ?? "").replace(/\s+/g, " ").trim())
            .filter(Boolean),
        );
        if (!labels.length) {
          note(`${surface} offers no route to billing`);
          continue;
        }
        for (const label of Array.from(new Set(labels))) {
          const link = await firstVisible(
            page.locator('a[href="/billing"]').filter({ hasText: label }),
          );
          if (!link) {
            note(`"${label}" on ${surface} was in the markup but not on the screen`);
            continue;
          }
          await link.click();
          // Wait for the DESTINATION specifically. A predicate that also accepts
          // where we started, or the sign-in hop in between, resolves on the
          // wrong page and then judges it.
          await page.waitForURL((u) => u.pathname === "/billing", { timeout: 30_000 });
          const landed = await billingSurface(page);
          const broken = promiseBroken(label, landed);
          expect(
            !broken,
            `"${label}" on ${surface} promised something billing does not have — ${broken}`,
          );
          expectNoWire(landed.text, `the page "${label}" leads to`);
          followed.push(`${surface} → "${label}"`);
          await settledOn(page, base, surface);
        }
      }
      expect(
        followed.length > 0,
        "no page in the signed-in product offers any route to billing at all — a customer who hits a " +
          "limit has nowhere to go but the URL bar",
      );
      note(`followed ${followed.length}: ${followed.join(", ")}`);
    },
  },

  {
    name: "JOURNEY F — I want to leave: deletion asks before it acts, and changing my mind costs nothing",
    tier: "free",
    needsAuth: true,
    // SERIAL. It arms the account-deletion control on the ONE account every
    // signed-in flow in this suite shares. Nothing is ever deleted (see the
    // header), but a destructive control left half-open while another flow is
    // mid-write against the same account is not a trade worth making for
    // parallelism.
    mutates: true,
    run: async ({ page, base, note }) => {
      const text = await settledOn(page, base, "/account");
      expect(
        pathOf(page) === "/account",
        `a signed-in customer opening their account landed on ${page.url()} instead`,
      );
      expectNoWire(text, "the account page");

      // ── 1. What have I used? ────────────────────────────────────────────
      const meters = metersIn(text);
      if (meters.length > 0) {
        for (const m of meters) note(`account meter: ${m.raw}`);
      } else {
        // The account page hides its token meter while RB_METERING is off, and
        // from inside a browser that is INDISTINGUISHABLE from the meter having
        // regressed — /api/usage answers with zeros either way. So this does not
        // guess: it says what it saw, and then asserts the thing the customer
        // actually needs, which is that the numbers are still reachable. The one
        // page.request in this file, against the data behind the missing meter.
        const res = await page.request.fetch(`${base}/api/usage`, { failOnStatusCode: false });
        const summary =
          res.status() === 200
            ? ((await res.json()) as { usedTokens?: number; freeTokens?: number })
            : null;
        expect(
          !!summary,
          `the account page shows no usage at all and its own usage endpoint answered ${res.status()} — ` +
            "the customer has no way whatsoever to find out what they have spent",
        );
        note(
          `no token meter on /account; the numbers behind it are ${summary?.usedTokens ?? "?"} of ` +
            `${summary?.freeTokens ?? "?"} tokens. Pre-launch the page hides the meter while metering ` +
            "is off, and the browser cannot tell that apart from a regression — so what is asserted " +
            "instead is that the usage is still one click away",
        );

        const toBilling = await firstVisible(page.locator('a[href="/billing"]'));
        expect(
          !!toBilling,
          "the account page shows no usage and offers no route to the page that does — somebody " +
            "wondering what they have spent is stuck",
        );
        await toBilling!.click();
        await page.waitForURL((u) => u.pathname === "/billing", { timeout: 30_000 });
        const elsewhere = metersIn(await settledHere(page, "/billing"));
        expect(
          elsewhere.length > 0,
          "neither the account page nor the billing page it links to says how much of the allowance " +
            "is gone — the number exists and the customer cannot see it anywhere",
        );
        note(`usage is one click away: ${elsewhere.map((m) => m.raw).join(", ")}`);
        await settledOn(page, base, "/account");
      }

      // ── 2. The way out exists at all ────────────────────────────────────
      // The privacy policy promises deletion, and this control is the only
      // thing that keeps that promise (the Clerk webhook behind it is env-gated
      // off until its secret is configured). waitFor, not isVisible({timeout}):
      // the section renders null until hydration on purpose, so a non-polling
      // check answers "absent" on a perfectly healthy page.
      const arm = page.getByRole("button", { name: /^delete my account/i }).first();
      const offered = await arm
        .waitFor({ state: "visible", timeout: 30_000 })
        .then(() => true)
        .catch(() => false);
      expect(
        offered,
        "the account page offers no way to delete the account — the privacy policy promises exactly " +
          "that, and this control is the only thing that keeps the promise",
      );

      const zone = dangerZone(page);
      expect(
        await zone.getByRole("button", { name: /^delete my account/i }).isVisible(),
        "the delete control is not inside the section this flow scoped itself to — refusing to click " +
          "further rather than risk driving Clerk's own account deletion by mistake",
      );

      // ── 3. One click must NOT delete anything ───────────────────────────
      await arm.click();
      const field = zone.getByRole("textbox").first();
      await field.waitFor({ state: "visible", timeout: 15_000 });
      const confirm = zone.getByRole("button", { name: /delete (forever|permanently)/i }).first();
      await confirm.waitFor({ state: "visible", timeout: 15_000 });
      expect(
        await confirm.isDisabled(),
        "one click on the delete button left a live, pressable “Delete forever” next to it — the most " +
          "destructive action in the product is then two ordinary clicks away, with nothing typed",
      );
      expect(
        pathOf(page) === "/account",
        `clicking delete once navigated to ${page.url()} — a single click must ask, not act`,
      );
      note("one click opens a confirmation and does nothing else");

      // ── 4. It wants the exact words ─────────────────────────────────────
      // A NEAR MISS, deliberately: the phrase that actually arms the button is
      // never typed by this suite, on this account, under any condition.
      await field.click();
      await page.keyboard.type(NEAR_MISS);
      expect(
        (await field.inputValue()) === NEAR_MISS,
        `the confirmation field did not take what was typed — it reads "${await field.inputValue()}"`,
      );
      expect(
        await confirm.isDisabled(),
        `typing "${NEAR_MISS}" — one letter short of the confirmation phrase — armed the irreversible ` +
          "button. A confirmation that accepts approximately the right words is not a confirmation",
      );
      note('a near-miss phrase leaves "Delete forever" dead');

      // ── 5. Cancel abandons it, cleanly ──────────────────────────────────
      await zone.getByRole("button", { name: /^cancel$/i }).first().click();
      await field.waitFor({ state: "detached", timeout: 15_000 });
      await arm.waitFor({ state: "visible", timeout: 15_000 });

      // And it forgot what was typed. A confirmation that remembers a
      // half-typed phrase is one stray keystroke away from doing the thing the
      // person just decided not to do.
      await arm.click();
      const reopened = zone.getByRole("textbox").first();
      await reopened.waitFor({ state: "visible", timeout: 15_000 });
      const carried = await reopened.inputValue();
      expect(
        carried === "",
        `cancelling left "${carried}" sitting in the confirmation field — the customer changed their ` +
          "mind and the product kept their answer",
      );
      expect(
        await zone.getByRole("button", { name: /delete (forever|permanently)/i }).first().isDisabled(),
        "reopening the confirmation came back already armed",
      );
      await zone.getByRole("button", { name: /^cancel$/i }).first().click();
      await reopened.waitFor({ state: "detached", timeout: 15_000 });
      note("Cancel closes it, forgets what was typed, and leaves the section as it was found");

      // ── 6. And the account still works ──────────────────────────────────
      // The entire reason to test the gate rather than the deletion: the next
      // flow in this suite signs in as this same person.
      const gallery = await settledOn(page, base, "/documents");
      expect(
        pathOf(page) === "/documents",
        `after backing out of the delete confirmation the session was bounced to ${page.url()} — ` +
          "something in that gate signed the customer out of an account it did not delete",
      );
      expect(
        !!(await firstVisible(page.getByRole("link", { name: /new document/i }))),
        "after backing out of the delete confirmation the gallery no longer offers the button to make " +
          "a document — the account did not survive being asked about",
      );
      expectNoWire(gallery, "the document gallery, after backing out of account deletion");
      note("backed out of the delete gate and the account is still signed in and usable");
    },
  },
];
