import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

/**
 * Routes that require a signed-in user.
 *
 * Bare `auth.protect()` does NOT redirect a signed-out browser to sign-in —
 * it rewrites to a 404 (`x-clerk-auth-reason: protect-rewrite`), even with
 * NEXT_PUBLIC_CLERK_SIGN_IN_URL set. Every "Open the editor" button on the
 * landing points at /new, so that served a dead end to exactly the visitors
 * we want. Page routes now pass `unauthenticatedUrl` explicitly and carry the
 * original URL so sign-in returns the visitor to where they were going.
 *
 * API routes keep the bare form on purpose: a fetch caller wants a status
 * code, not an HTML sign-in page.
 *
 * The dev-only routes (/api/dev/*) are intentionally excluded — they carry
 * their own NODE_ENV gate and run without a session. Note: on Next 14 this
 * file MUST be named `middleware.ts` (the `proxy.ts` convention is Next
 * 15+/Clerk v7).
 */
// /videos is handled by a next.config redirect (→ /documents), so it never
// reaches a page and needs no entry here. It was a permanentRedirect() page
// stub, but that served a 308 with NO Location header in production.
const isProtectedPage = createRouteMatcher([
  "/new(.*)",
  "/documents(.*)",
  "/review(.*)",
  "/preview(.*)",
  "/account(.*)",
  "/billing(.*)",
]);

const isProtectedApi = createRouteMatcher([
  "/api/preview(.*)",
  "/api/renders(.*)",
  "/api/usage(.*)",
]);

export default clerkMiddleware(async (auth, req) => {
  if (isProtectedApi(req)) {
    await auth.protect();
    return;
  }
  if (isProtectedPage(req)) {
    const signIn = new URL("/sign-in", req.url);
    signIn.searchParams.set("redirect_url", req.url);
    await auth.protect({ unauthenticatedUrl: signIn.toString() });
  }
});

export const config = {
  matcher: [
    // Run on everything except Next internals and static files,
    // unless those appear in search params.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes.
    "/(api|trpc)(.*)",
  ],
};
