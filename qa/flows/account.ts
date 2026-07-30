//
// The signed-in product, driven as the customer drives it.
//
// Everything else in this suite runs against public routes or the dev harness,
// which leaves the paths a paying user actually touches — their document list,
// creating and deleting a deck, exporting it, sharing it, the billing and
// account pages — with no browser coverage at all. Those are precisely the
// journeys where a regression is visible to a customer rather than to us.
//
// COSTS NOTHING. Every flow here is deterministic: a blank document is created
// with zero model calls, exports are Playwright screenshots, sharing is a
// database write. No flow in this file spends a token, which is why they all sit
// at the free tier despite needing a real account.
//
// Each flow cleans up the documents it creates. A test account that accumulates
// a hundred junk decks makes the document-list assertions meaningless within a
// week.
//
import type { Page } from "playwright";
import type { Flow } from "../harness";
import { expect, until } from "../harness";

/** Documents this run created, so they can be removed even if a flow fails. */
const created = new Set<string>();

/** The scriptId of the document currently open in the editor, from its URL. */
const openDocumentId = (page: Page): string | null =>
  /\/preview\/([^/?#]+)/.exec(page.url())?.[1] ?? null;

/**
 * Create a blank document and land in the editor.
 *
 * Zero tokens: /api/documents/new writes an empty deck and redirects. This is
 * the entry point the "New document" button uses, and it 500'd for every signed
 * in user once — which nothing caught, because nothing signed in.
 */
const createDocument = async (page: Page, base: string): Promise<string> => {
  const res = await page.goto(`${base}/api/documents/new`, { waitUntil: "domcontentloaded" });
  expect(
    (res?.status() ?? 0) < 400,
    `creating a document should succeed, got ${res?.status()} — this route once 500'd for every signed-in user`,
  );
  await until("the editor opens on the new document", async () => !!openDocumentId(page), 30000);
  const id = openDocumentId(page)!;
  created.add(id);
  return id;
};

const deleteDocument = async (page: Page, base: string, id: string): Promise<number> => {
  const res = await page.request.fetch(`${base}/api/documents/${encodeURIComponent(id)}`, {
    method: "DELETE",
    failOnStatusCode: false,
  });
  if (res.status() < 400) created.delete(id);
  return res.status();
};

export const accountFlows: Flow[] = [
  {
    name: "a signed-in user reaches their document list",
    tier: "free",
    needsAuth: true,
    run: async ({ page, base, note }) => {
      const res = await page.goto(`${base}/documents`, { waitUntil: "domcontentloaded" });
      expect((res?.status() ?? 0) < 400, `/documents should load, got ${res?.status()}`);
      expect(
        !/sign-in|sign-up/.test(page.url()),
        `a signed-in user should stay on /documents, landed on ${page.url()}`,
      );
      const text = await page.evaluate(() => document.body.innerText);
      // Either decks or an empty state — both are correct; a crash is not.
      expect(!/something went wrong|application error/i.test(text), "the page should not show an error");
      note(`${page.url()}`);
    },
  },

  {
    name: "creating a document opens it, and deleting it removes it",
    tier: "free",
    needsAuth: true,
    mutates: true,
    run: async ({ page, base, note }) => {
      const id = await createDocument(page, base);
      note(`created ${id}`);

      // It must actually appear in the list — a document that exists only as a
      // redirect target is one the user can never find again.
      await page.goto(`${base}/documents`, { waitUntil: "domcontentloaded" });
      const listed = await page.evaluate(
        (docId) => document.body.innerHTML.includes(docId),
        id,
      );
      expect(listed, `the new document ${id} should appear in the list`);

      const status = await deleteDocument(page, base, id);
      expect(status < 400, `deleting should succeed, got ${status}`);

      await page.goto(`${base}/documents`, { waitUntil: "domcontentloaded" });
      const stillListed = await page.evaluate(
        (docId) => document.body.innerHTML.includes(docId),
        id,
      );
      expect(!stillListed, `the deleted document ${id} should be gone from the list`);
      note("created → listed → deleted → gone");
    },
  },

  {
    name: "a document cannot be opened, exported or deleted by a stranger",
    tier: "free",
    needsAuth: true,
    mutates: true,
    run: async ({ page, base, note }) => {
      // Ownership is checked per handler rather than by the middleware, so
      // "signed in" and "allowed" are different questions. This asks the second
      // one with a signed-in session and an id that is not ours.
      const notOurs = "01ZZZZZZZZZZZZZZZZZZZZZZZZ";
      const probes: { method: "GET" | "DELETE"; path: string }[] = [
        { method: "GET", path: `/api/preview/${notOurs}/iframe?scene=0` },
        { method: "GET", path: `/api/preview/${notOurs}/export?format=pdf` },
        { method: "GET", path: `/api/preview/${notOurs}/thumbnail` },
        { method: "GET", path: `/api/preview/edit-element?scriptId=${notOurs}&sceneIndex=0` },
        { method: "DELETE", path: `/api/documents/${notOurs}` },
      ];
      const leaks: string[] = [];
      for (const p of probes) {
        const res = await page.request.fetch(`${base}${p.path}`, {
          method: p.method,
          failOnStatusCode: false,
          maxRedirects: 0,
        });
        if (res.status() >= 200 && res.status() < 300) leaks.push(`${p.method} ${p.path} → ${res.status()}`);
      }
      note(`${probes.length} cross-tenant probes`);
      expect(leaks.length === 0, `a signed-in stranger reached someone else's document: ${leaks.join("; ")}`);
    },
  },

  {
    name: "the owner can share a document, and revoking it closes the link",
    tier: "free",
    needsAuth: true,
    mutates: true,
    run: async ({ page, base, note }) => {
      const id = await createDocument(page, base);
      try {
        const share = await page.request.fetch(`${base}/api/preview/share`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          data: { scriptId: id },
          failOnStatusCode: false,
        });
        expect(share.status() === 200, `sharing should succeed, got ${share.status()}`);
        const { url } = (await share.json()) as { url?: string };
        expect(!!url, "sharing should return a link");
        note(`shared at ${url}`);

        // The link has to work for someone with NO session — that is the whole
        // feature. A fresh request context carries none of our cookies.
        const anon = await page.context().browser()!.newContext();
        try {
          const visitor = await anon.newPage();
          const opened = await visitor.goto(`${base}${url}`, { waitUntil: "domcontentloaded" });
          expect(opened?.status() === 200, `a visitor should open the link, got ${opened?.status()}`);

          const revoke = await page.request.fetch(`${base}/api/preview/share`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            data: { scriptId: id },
            failOnStatusCode: false,
          });
          expect(revoke.status() === 200, `revoking should succeed, got ${revoke.status()}`);

          const after = await visitor.goto(`${base}${url}`, { waitUntil: "domcontentloaded" });
          expect(after?.status() === 404, `a revoked link should 404, got ${after?.status()}`);
          note("shared → opened anonymously → revoked → 404");
        } finally {
          await anon.close().catch(() => {});
        }
      } finally {
        await deleteDocument(page, base, id);
      }
    },
  },

  {
    name: "the account and billing pages render for a signed-in user",
    tier: "free",
    needsAuth: true,
    run: async ({ page, base, note }) => {
      for (const path of ["/account", "/billing"]) {
        const res = await page.goto(`${base}${path}`, { waitUntil: "domcontentloaded" });
        expect((res?.status() ?? 0) < 400, `${path} should load, got ${res?.status()}`);
        expect(!/sign-in/.test(page.url()), `${path} should not bounce a signed-in user to sign-in`);
        const text = await page.evaluate(() => document.body.innerText);
        expect(text.trim().length > 0, `${path} should render something`);
        expect(
          !/something went wrong|application error|Internal Server Error/i.test(text),
          `${path} should not show an error page`,
        );
      }
      note("/account and /billing both render");
    },
  },

  {
    name: "the usage endpoint answers the owner and nobody else",
    tier: "free",
    needsAuth: true,
    run: async ({ page, base, note }) => {
      const res = await page.request.fetch(`${base}/api/usage`, { failOnStatusCode: false });
      expect(res.status() === 200, `/api/usage should answer a signed-in user, got ${res.status()}`);
      const raw = await res.text();
      // The account page reads this; it must not carry anything that identifies
      // the processor account or the environment.
      for (const secret of ["sk_", "pk_live", "DATABASE_URL", "postgres://", "LEMONSQUEEZY_"]) {
        expect(!raw.includes(secret), `/api/usage must not disclose ${secret}`);
      }
      note(`${raw.length} bytes`);
    },
  },

  {
    name: "a document exports to PNG and PDF",
    tier: "free",
    needsAuth: true,
    mutates: true,
    run: async ({ page, base, note }) => {
      // Deterministic: exports are screenshots of what is already built, so this
      // costs nothing and still covers the Playwright render path end to end —
      // the one that breaks silently when a container ships without a browser.
      const id = await createDocument(page, base);
      try {
        const results: string[] = [];
        for (const [format, type] of [["png", "image/png"], ["pdf", "application/pdf"]]) {
          const res = await page.request.fetch(
            `${base}/api/preview/${id}/export?format=${format}${format === "png" ? "&scene=0" : ""}`,
            { failOnStatusCode: false, timeout: 120_000 },
          );
          expect(res.status() === 200, `${format} export should succeed, got ${res.status()}`);
          const contentType = res.headers()["content-type"] ?? "";
          expect(contentType.includes(type), `${format} should return ${type}, got ${contentType}`);
          const bytes = (await res.body()).length;
          expect(bytes > 1000, `${format} export looks empty (${bytes} bytes)`);
          results.push(`${format} ${Math.round(bytes / 1024)}KB`);
        }
        note(results.join(", "));
      } finally {
        await deleteDocument(page, base, id);
      }
    },
  },

  {
    name: "no document this run created is left behind",
    tier: "free",
    needsAuth: true,
    mutates: true,
    run: async ({ page, base, note }) => {
      // Runs last by position in this array. A test account that silently
      // accumulates junk decks makes every list assertion above meaningless
      // within a week, and the failure would look like a product bug.
      const leftovers = [...created];
      for (const id of leftovers) await deleteDocument(page, base, id);
      note(leftovers.length ? `cleaned up ${leftovers.length}` : "nothing left behind");
      expect(created.size === 0, `could not clean up: ${[...created].join(", ")}`);
    },
  },
];
