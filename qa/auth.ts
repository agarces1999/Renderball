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
import type { BrowserContext } from "playwright";

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
 * Drive Clerk's hosted sign-in form.
 *
 * Written against the DOM rather than a Clerk API because that is what a user
 * does, and because a session minted through a backend API would not prove the
 * sign-in page works — which is the first thing every customer touches.
 *
 * Clerk splits identifier and password across two steps, but not always (it
 * depends on the instance's configured strategies), so both shapes are handled:
 * fill what is present, continue, fill what appears next.
 */
const signIn = async (context: BrowserContext, base: string, creds: Credentials): Promise<void> => {
  const page = await context.newPage();
  try {
    await page.goto(`${base}/sign-in`, { waitUntil: "domcontentloaded" });

    const identifier = page.locator('input[name="identifier"]').first();
    await identifier.waitFor({ state: "visible", timeout: 30000 });
    await identifier.fill(creds.email);

    // The password field may already be on screen, or may need a Continue.
    const password = page.locator('input[name="password"]').first();
    if (!(await password.isVisible().catch(() => false))) {
      await page.locator('button[type="submit"], button:has-text("Continue")').first().click();
      await password.waitFor({ state: "visible", timeout: 30000 });
    }
    await password.fill(creds.password);
    await page.locator('button[type="submit"], button:has-text("Continue")').first().click();

    // Signed in when Clerk sends us anywhere that is not the sign-in page.
    await page.waitForURL((url) => !/\/sign-in|\/sign-up/.test(url.pathname), { timeout: 45000 });
  } finally {
    await page.close().catch(() => {});
  }
};

/**
 * Build the harness's `authenticate` hook, or null when no account is set up.
 *
 * The returned function is what runFlows calls for each needsAuth flow's fresh
 * context: seed from the cached storage state when we have one, otherwise sign
 * in for real and cache it.
 */
export const authenticator = (
  base: string,
): ((context: BrowserContext) => Promise<void>) | null => {
  const creds = testCredentials();
  if (!creds) return null;

  return async (context: BrowserContext): Promise<void> => {
    if (!storageState) {
      // The first signed-in flow pays for a real sign-in — which also means the
      // sign-in PAGE is covered, by every run, without a flow dedicated to it.
      await signIn(context, base, creds);
      storageState = await context.storageState();
      return;
    }
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
};
