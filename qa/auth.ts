//
// A signed-in session for the QA suite.
//
// Everything the suite could reach until now was public or behind the dev
// harness, which is a real gap: the routes a paying user actually touches —
// their document list, export, delete, share, billing — were the only ones with
// no automated coverage at all, and they are the ones where a regression is
// visible to a customer.
//
// SIGN IN ONCE. Clerk's sign-in is a real network round trip and it rate-limits;
// doing it per flow would be slow and would eventually start failing for reasons
// that have nothing to do with the product. So the first sign-in captures the
// storage state and every later context is seeded from it.
//
// Credentials come from the environment and nowhere else. With none set,
// `authenticator()` returns null, the harness skips every needsAuth flow with a
// clear reason, and the free tier still runs green — a developer without a test
// account is not blocked.
//
import type { BrowserContext, Page } from "playwright";

export interface Credentials {
  email: string;
  password: string;
}

/** The test account, if one is configured. */
export const testCredentials = (): Credentials | null => {
  const email = process.env.QA_TEST_EMAIL;
  const password = process.env.QA_TEST_PASSWORD;
  return email && password ? { email, password } : null;
};

/** Cached across the whole run — see the header. */
let storageState: Awaited<ReturnType<BrowserContext["storageState"]>> | null = null;

/**
 * The form's PRIMARY action, and nothing else.
 *
 * `button:has-text("Continue")` seems reasonable and is a trap: Clerk renders
 * "Continue with Google" above "Continue", so `.first()` picks the social
 * button. The suite spent its whole first run being redirected to
 * accounts.google.com and reporting six flows as "not signed in", with no error
 * anywhere — the click worked, it just went somewhere else.
 *
 * `button[type="submit"]` is the second trap. Clerk renders a hidden submit
 * shim — `<button type="submit" aria-hidden style="…">` — EARLIER in the DOM
 * than the real button, so a comma-separated selector with `.first()` resolves
 * to it and Playwright waits forever for an element that will never be visible.
 *
 * `.cl-formButtonPrimary` is Clerk's own class for a form's primary action.
 * Social buttons carry `cl-socialButtonsBlockButton` instead, and the hidden
 * shim carries no class at all. On its own, it is unambiguous.
 */
const submitButton = (page: Page) => page.locator(".cl-formButtonPrimary").first();

/**
 * Drive Clerk's hosted sign-in form.
 *
 * Written against the DOM rather than a Clerk API because that is what a user
 * does, and because a session minted through a backend API would not prove the
 * sign-in page works — which is the first thing every customer touches.
 *
 * Clerk may put identifier and password on one step or two, depending on the
 * instance's configured strategies, so both shapes are handled.
 */
const signIn = async (context: BrowserContext, base: string, creds: Credentials): Promise<void> => {
  const page = await context.newPage();
  try {
    await page.goto(`${base}/sign-in`, { waitUntil: "domcontentloaded" });

    const identifier = page.locator('input[name="identifier"]').first();
    await identifier.waitFor({ state: "visible", timeout: 30000 });
    await identifier.fill(creds.email);

    // One step or two — fill the password if it is already here, otherwise
    // advance and wait for it.
    const password = page.locator('input[name="password"]').first();
    if (!(await password.isVisible().catch(() => false))) {
      await submitButton(page).click();
      await password.waitFor({ state: "visible", timeout: 30000 });
    }
    await password.fill(creds.password);
    await submitButton(page).click();

    // Some instances then ask for an emailed code ("Check your email",
    // /sign-in/factor-two). A Clerk TEST address — anything+clerk_test@… —
    // accepts a fixed code, so no inbox is involved and nothing has to be
    // polled. Without this the sign-in stops here every single time, which is
    // exactly where the first real run got stuck.
    //
    // ONE selector, again for the reason above: the code UI is a stack of
    // segment boxes with the real input laid over them, so a comma-separated
    // list resolves to a decorative div and Playwright reports the actual input
    // "intercepts pointer events". `autocomplete="one-time-code"` is on the
    // real one and only the real one.
    //
    // waitFor, NOT isVisible({timeout}). The timeout option on isVisible does
    // not make it poll — it answers immediately, and immediately after
    // submitting the password the code field does not exist yet. So the check
    // returned false every time, the whole step was skipped, and the failure
    // surfaced 45 seconds later as "the app still refuses the session".
    const codeField = page.locator('input[autocomplete="one-time-code"]').first();
    const needsCode = await codeField
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    if (needsCode) {
      // Filled, not clicked-and-typed: clicking lands on the segment boxes.
      await codeField.fill(process.env.QA_TEST_CODE || "424242");
      // Clerk submits on its own once the code is complete; the click is for
      // the instances that do not.
      await page.waitForTimeout(1500);
      if (await submitButton(page).isVisible().catch(() => false)) {
        await submitButton(page).click().catch(() => {});
      }
    }

    // PROOF, not a proxy. Waiting for the URL to stop being /sign-in was the
    // other half of that first run's silent failure: a redirect to an OAuth
    // provider satisfies it perfectly while leaving no session at all. Ask the
    // app instead — /api/usage answers 200 only for a real signed-in user.
    const deadline = Date.now() + 45_000;
    for (;;) {
      const res = await page.request.fetch(`${base}/api/usage`, { failOnStatusCode: false });
      if (res.status() === 200) return;
      if (Date.now() > deadline) break;
      await page.waitForTimeout(500);
    }

    // Failed. Whatever Clerk is telling a human is the most useful thing to say.
    const shown = await page
      .evaluate(() =>
        Array.from(document.querySelectorAll('[role="alert"], .cl-formFieldErrorText'))
          .map((n) => (n.textContent ?? "").trim())
          .filter(Boolean)
          .join("; "),
      )
      .catch(() => "");
    throw new Error(
      `signed in as ${creds.email} but the app still refuses the session` +
        (shown ? ` — Clerk says: ${shown}` : ` (no on-screen error; landed on ${page.url()})`),
    );
  } finally {
    await page.close().catch(() => {});
  }
};

/** Copy the cached session into a fresh context. */
const replaySession = async (context: BrowserContext): Promise<void> => {
  if (!storageState) return;
  // Playwright cannot restore storage state into an existing context, so the
  // cookies and origin storage are replayed by hand.
  if (storageState.cookies?.length) await context.addCookies(storageState.cookies);
  for (const origin of storageState.origins ?? []) {
    await context.addInitScript(
      ({ items }: { items: { name: string; value: string }[] }) => {
        for (const { name, value } of items) {
          try { window.localStorage.setItem(name, value); } catch { /* ignore */ }
        }
      },
      { items: origin.localStorage ?? [] },
    );
  }
};

/**
 * The one sign-in, shared by everyone who arrives while it is happening.
 *
 * WITHOUT THIS the suite signs in three times at once. Flows run three at a
 * time, the read-only signed-in flows all start together, and each looks at an
 * empty `storageState` and decides it should be the one to log in. Three
 * simultaneous Clerk sign-ins on the same account — three second-factor
 * challenges, three sets of cookies racing — and the symptom is not an auth
 * error at all: one flow gets a 500 from /documents, a different flow each run,
 * sometimes after fifty seconds. It read exactly like a flaky product bug.
 */
let signInFlight: Promise<void> | null = null;

/**
 * Build the harness's `authenticate` hook, or null when no account is set up.
 *
 * Called with each needsAuth flow's fresh context: whoever gets there first
 * signs in for real, everyone else waits for that and replays the result.
 */
export const authenticator = (
  base: string,
): ((context: BrowserContext) => Promise<void>) | null => {
  const creds = testCredentials();
  if (!creds) return null;

  return async (context: BrowserContext): Promise<void> => {
    if (storageState) return replaySession(context);

    if (!signInFlight) {
      // This context does the work — and ends up signed in directly, which is
      // also why the sign-in PAGE is covered by every run without a flow
      // dedicated to it.
      signInFlight = (async () => {
        await signIn(context, base, creds);
        storageState = await context.storageState();
      })();
      try {
        await signInFlight;
        return;
      } catch (err) {
        // Let the next arrival try rather than wedging the whole suite on one
        // bad attempt.
        signInFlight = null;
        throw err;
      }
    }

    await signInFlight;
    return replaySession(context);
  };
};
