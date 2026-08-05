import { NextResponse } from "next/server";
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

/** The slide canvas's own document — an <iframe src>, not a fetch. */
const isCanvasIframe = createRouteMatcher(["/api/preview/(.*)/iframe"]);

export default clerkMiddleware(async (auth, req) => {
  if (isProtectedApi(req)) {
    // The CANVAS IFRAME is a special case. auth.protect() rewrites a dead
    // session to a 404/sign-in document, and because the canvas is an iframe
    // that document renders INSIDE the slide — a full sign-in form squeezed
    // into a 16:9 box where the user's deck should be, with no explanation
    // and no way out (it cannot navigate the top window). A frame that is
    // about to show a sign-in page should instead say what happened and
    // break out to a real one.
    if (isCanvasIframe(req)) {
      const { userId } = await auth();
      if (!userId) {
        const target = `/sign-in?redirect_url=${encodeURIComponent(req.nextUrl.pathname.replace(/^\/api\/preview\/([^/]+)\/iframe.*$/, "/preview/$1"))}`;
        return new NextResponse(
          `<!doctype html><html lang="en"><head><meta charset="utf-8"/><title>Session expired</title>` +
            `<style>html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;` +
            `background:#fff;color:#69707e;text-align:center;font:400 14px/1.6 "Geist",system-ui,sans-serif}` +
            `a{color:#047857}</style></head><body><main><p>Your session expired — your document is safe.</p>` +
            `<p><a href="${target}" target="_top">Sign in to keep editing</a></p></main></body></html>`,
          { status: 401, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
        );
      }
      return;
    }
    await auth.protect();
    return;
  }
  if (isProtectedPage(req)) {
    const signIn = new URL("/sign-in", req.url);
    // Relative, deliberately. `req.url` inside the container is the internal
    // bind address (https://0.0.0.0:8080/...), so passing it whole sent
    // post-sign-in traffic to an unreachable origin. A path is origin-correct
    // wherever this runs, and cannot be pointed off-site.
    signIn.searchParams.set("redirect_url", req.nextUrl.pathname + req.nextUrl.search);
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
