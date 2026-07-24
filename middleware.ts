import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

/**
 * Routes that require a signed-in user. `auth.protect()` redirects browser
 * navigations to Clerk sign-in and returns 401 to API/fetch callers. The
 * dev-only routes (/api/dev/*) are intentionally excluded — they carry their
 * own NODE_ENV gate and run without a session. Note: on Next 14 this file MUST
 * be named `middleware.ts` (the `proxy.ts` convention is Next 15+/Clerk v7).
 */
// /videos is deliberately NOT protected: it's a bare permanentRedirect stub to
// /documents (canvas pivot). Letting the 308 run first means old bookmarks
// migrate to the new URL, THEN /documents' own protection kicks in.
const isProtectedRoute = createRouteMatcher([
  "/new(.*)",
  "/documents(.*)",
  "/review(.*)",
  "/preview(.*)",
  "/account(.*)",
  "/billing(.*)",
  "/api/preview(.*)",
  "/api/renders(.*)",
  "/api/usage(.*)",
]);

export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) await auth.protect();
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
