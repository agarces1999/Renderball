//
// The auth boundary, asserted route by route.
//
// 28 production API routes and not one of them had a test. The whole
// authorisation model is "the middleware protects /api/preview/*, /api/renders/*
// and /api/usage, and every handler re-checks the session" — which is sound, and
// which nothing verified. A route added outside those matchers, or a handler that
// forgets `getCurrentUser`, is a silent hole: it works perfectly for the
// developer who is signed in, and is wide open to everyone else.
//
// The list below is deliberately HAND-WRITTEN rather than discovered from the
// filesystem. A new route should not quietly inherit "tested"; adding one should
// require a decision about whether it is public.
//
// "Refused" means any non-2xx: a Clerk 404 rewrite, a 401, or the 303 to sign-in
// that /api/documents/new answers with are all correct answers to an anonymous
// caller. The failure this catches is a 200.
//
import type { Flow } from "../harness";
import { expect } from "../harness";

type Probe = { method: "GET" | "POST" | "PUT"; path: string; why?: string };

/** Every route that must NOT serve an anonymous caller. */
const PROTECTED: Probe[] = [
  { method: "POST", path: "/api/billing/checkout" },
  { method: "POST", path: "/api/billing/portal" },
  { method: "POST", path: "/api/documents/generate" },
  { method: "GET", path: "/api/documents/new" },
  { method: "GET", path: "/api/preview/edit-element?scriptId=x&sceneIndex=0" },
  { method: "POST", path: "/api/preview/edit-layout" },
  { method: "POST", path: "/api/preview/edit-piece-text" },
  { method: "POST", path: "/api/preview/insert-element" },
  { method: "POST", path: "/api/preview/page-op" },
  { method: "POST", path: "/api/preview/regenerate-element" },
  { method: "POST", path: "/api/preview/regenerate-scene" },
  { method: "POST", path: "/api/preview/suggest-layout" },
  { method: "POST", path: "/api/preview/build" },
  { method: "GET", path: "/api/preview/undo?scriptId=x" },
  { method: "POST", path: "/api/preview/undo" },
  { method: "POST", path: "/api/preview/upload-image" },
  { method: "GET", path: "/api/preview/brand?scriptId=x" },
  { method: "PUT", path: "/api/preview/brand" },
  { method: "POST", path: "/api/preview/brand/asset" },
  { method: "GET", path: "/api/preview/asset?scriptId=x&ref=y" },
  { method: "GET", path: "/api/preview/x/iframe?scene=0" },
  { method: "GET", path: "/api/preview/x/export?format=pdf" },
  { method: "GET", path: "/api/preview/x/thumbnail" },
  { method: "POST", path: "/api/preview/x/render-mp4" },
  { method: "GET", path: "/api/renders/x" },
  { method: "GET", path: "/api/usage" },
];

/** Pages that must send an anonymous visitor to sign-in rather than render. */
const PROTECTED_PAGES = ["/documents", "/preview/x", "/account", "/billing", "/new", "/review/x"];

/** Pages that must stay reachable without an account. */
const PUBLIC_PAGES = ["/", "/privacy", "/terms", "/refunds", "/acceptable-use", "/contact"];

export const securityFlows: Flow[] = [
  {
    name: "every protected API route refuses an anonymous caller",
    tier: "free",
    run: async ({ page, base, note }) => {
      const leaks: string[] = [];
      for (const p of PROTECTED) {
        const res = await page.request.fetch(`${base}${p.path}`, {
          method: p.method,
          headers: { "Content-Type": "application/json" },
          data: p.method === "GET" ? undefined : {},
          failOnStatusCode: false,
          // NEVER follow redirects here. A refusal is often "303 to /sign-in",
          // and a client that chases it reports the sign-in page's 200 — which
          // reads as a protected route serving an anonymous caller. It would
          // also HIDE a genuine leak behind any redirect, so this is the
          // difference between a security test and a decoration.
          maxRedirects: 0,
        });
        if (res.status() >= 200 && res.status() < 300) {
          leaks.push(`${p.method} ${p.path} → ${res.status()}`);
        }
      }
      note(`${PROTECTED.length} routes probed`);
      expect(
        leaks.length === 0,
        `these routes served an anonymous caller: ${leaks.join("; ")}`,
      );
    },
  },

  {
    name: "protected pages send an anonymous visitor to sign-in",
    tier: "free",
    run: async ({ page, base, note }) => {
      const leaks: string[] = [];
      for (const path of PROTECTED_PAGES) {
        const res = await page.goto(`${base}${path}`, { waitUntil: "domcontentloaded" });
        const url = page.url();
        const signedOut = /sign-in|sign-up/.test(url) || url === `${base}/` || (res?.status() ?? 0) >= 400;
        if (!signedOut) leaks.push(`${path} → ${url} (${res?.status()})`);
      }
      note(`${PROTECTED_PAGES.length} pages probed`);
      expect(leaks.length === 0, `these pages rendered for an anonymous visitor: ${leaks.join("; ")}`);
    },
  },

  {
    name: "public pages stay reachable without an account",
    tier: "free",
    run: async ({ page, base, note }) => {
      const broken: string[] = [];
      for (const path of PUBLIC_PAGES) {
        const res = await page.request.fetch(`${base}${path}`, { failOnStatusCode: false });
        if (res.status() !== 200) broken.push(`${path} → ${res.status()}`);
      }
      note(`${PUBLIC_PAGES.length} pages probed`);
      expect(broken.length === 0, `these public pages did not load: ${broken.join("; ")}`);
    },
  },

  {
    name: "the version endpoint is public and names the running build",
    tier: "free",
    run: async ({ page, base, note }) => {
      const res = await page.request.fetch(`${base}/api/version`, { failOnStatusCode: false });
      expect(res.status() === 200, `/api/version should be public, got ${res.status()}`);
      const body = (await res.json()) as { commit?: string; startedAt?: string };
      expect(typeof body.commit === "string", "the response should name a commit");
      expect(typeof body.startedAt === "string", "the response should say when the build started");
      note(`commit ${body.commit}`);
      // It must not leak configuration.
      const raw = JSON.stringify(body);
      for (const secret of ["DATABASE_URL", "sk_", "pk_live", "postgres://", "CLERK_SECRET"]) {
        expect(!raw.includes(secret), `/api/version must not disclose ${secret}`);
      }
    },
  },

  {
    name: "webhooks reject an unsigned request",
    tier: "free",
    run: async ({ page, base, note }) => {
      // Anyone can POST to a webhook — that is the point. Signature verification
      // is the only thing standing between a stranger and "this user cancelled",
      // or "this user was deleted".
      const results: string[] = [];
      for (const path of [
        "/api/webhooks/clerk",
        "/api/webhooks/stripe",
        "/api/webhooks/lemonsqueezy",
      ]) {
        const res = await page.request.fetch(`${base}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          data: { type: "user.deleted", data: { id: "forged" } },
          failOnStatusCode: false,
        });
        results.push(`${path} → ${res.status()}`);
        expect(
          res.status() >= 400,
          `${path} accepted an UNSIGNED payload (${res.status()}) — a stranger could forge events`,
        );
      }
      note(results.join("; "));
    },
  },

  {
    name: "malformed input is refused, never a 500",
    tier: "free",
    run: async ({ page, base, note }) => {
      // Against the dev twins, which need no session — so this exercises the
      // handlers' own validation rather than the auth wall in front of it.
      const cases: { path: string; data: unknown }[] = [
        { path: "/api/dev/edit-layout", data: {} },
        { path: "/api/dev/edit-layout", data: { scriptId: "x", sceneIndex: "not-a-number", op: "move" } },
        { path: "/api/dev/edit-layout", data: { scriptId: "x", sceneIndex: 0, pieceId: "p", op: "nonsense" } },
        { path: "/api/dev/insert-element", data: {} },
        { path: "/api/dev/page-op", data: {} },
        { path: "/api/dev/suggest-layout", data: {} },
        { path: "/api/dev/suggest-layout", data: { scriptId: "x", sceneIndex: 0 } },
        { path: "/api/dev/brand", data: { scriptId: "x", brand: { palette: { accent: "not-a-colour" } } } },
      ];
      const crashes: string[] = [];
      for (const c of cases) {
        const res = await page.request.fetch(`${base}${c.path}`, {
          method: c.path.endsWith("/brand") ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          data: c.data as Record<string, unknown>,
          failOnStatusCode: false,
        });
        if (res.status() >= 500) crashes.push(`${c.path} ${JSON.stringify(c.data)} → ${res.status()}`);
      }
      note(`${cases.length} malformed payloads probed`);
      expect(crashes.length === 0, `these crashed instead of refusing: ${crashes.join("; ")}`);
    },
  },

  {
    name: "a path-traversal id cannot escape the document store",
    tier: "free",
    run: async ({ page, base, note }) => {
      const ids = ["../../../etc/passwd", "..%2F..%2F.env.local", ".env.local", "%2e%2e%2f%2e%2e%2f"];
      const leaks: string[] = [];
      for (const id of ids) {
        const res = await page.request.fetch(
          `${base}/api/dev/edit-element?scriptId=${id}&sceneIndex=0`,
          { failOnStatusCode: false },
        );
        const text = (await res.text().catch(() => "")).slice(0, 4000);
        if (/DATABASE_URL|CLERK_SECRET|root:|BEGIN [A-Z ]*PRIVATE KEY/.test(text)) {
          leaks.push(`${id} → returned file contents`);
        }
        if (res.status() >= 500) leaks.push(`${id} → ${res.status()}`);
      }
      note(`${ids.length} traversal shapes probed`);
      expect(leaks.length === 0, `traversal problems: ${leaks.join("; ")}`);
    },
  },
];
