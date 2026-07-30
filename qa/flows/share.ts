//
// Public share links, driven the way a recipient meets them: a URL in a chat
// message, opened by a browser with no account and no cookies.
//
// This is the only surface in the product that serves a document to a stranger,
// so the flows below are weighted towards what a link must NOT do. The happy
// path is one assertion; the rest are attempts to reach a deck without holding a
// link the owner issued, and attempts to keep reading one after they revoked it.
//
// The lifecycle flow mints its token through the real `enableShare`, against the
// same document the editor flows drive — a fake row would prove the route parses
// a token, not that the product shares a deck.
//
import type { Flow } from "../harness";
import { expect } from "../harness";
import { disableShare, enableShare, newShareToken, shareStateFor } from "../../lib/share";
import { DEV_OWNER_ID } from "../../lib/store";
import { prisma } from "../../lib/db";

/** The document the QA fixture points at. */
const devScript = (): string => process.env.QA_DEV_SCRIPT_ID ?? "";

/**
 * The fixture's script exists on disk; a share needs a Project row to hang the
 * token on. Create one if the local document never had a brief saved for it, so
 * the flow works on a fresh checkout rather than only on the author's machine.
 */
const ensureShareableProject = async (scriptId: string): Promise<void> => {
  const existing = await prisma.project.findFirst({ where: { scriptId, ownerId: DEV_OWNER_ID } });
  if (existing) return;
  await prisma.user.upsert({
    where: { id: DEV_OWNER_ID },
    update: {},
    create: { id: DEV_OWNER_ID, clerkId: DEV_OWNER_ID, email: "dev@local.invalid" },
  });
  await prisma.project.create({
    data: {
      id: `qa-share-${scriptId}`,
      ownerId: DEV_OWNER_ID,
      scriptId,
      purpose: "QA fixture deck.",
      status: "rendered",
      brief: {},
    },
  });
};

export const shareFlows: Flow[] = [
  {
    // Mutating: it writes a share token onto the fixture's row. Serialised so it
    // cannot race the negative-probe flow, which asserts tokens do NOT resolve.
    name: "a share link opens the deck for a visitor with no account, and dies when revoked",
    tier: "free",
    mutates: true,
    run: async ({ page, base, note }) => {
      const scriptId = devScript();
      expect(!!scriptId, "the QA fixture should have resolved a document");
      await ensureShareableProject(scriptId);

      // Start from private, whatever a previous run left behind.
      await disableShare(scriptId, DEV_OWNER_ID);

      const state = await enableShare(scriptId, DEV_OWNER_ID);
      const token = state?.token ?? "";
      expect(!!token, "sharing the fixture should mint a token");
      note(`token ${token.slice(0, 8)}…`);

      try {
        // A visitor with no session, no cookies, no referrer.
        const res = await page.request.fetch(`${base}/s/${token}`, { failOnStatusCode: false });
        expect(res.status() === 200, `a shared deck should open for anyone, got ${res.status()}`);

        await page.goto(`${base}/s/${token}`, { waitUntil: "domcontentloaded" });

        // The page must be a READER: none of the editor's controls exist here.
        const chrome = await page.evaluate(() => ({
          tools: document.querySelectorAll("[data-rb-tool]").length,
          share: document.querySelectorAll("[data-rb-share]").length,
          overlay: document.querySelectorAll("[data-rb-selection]").length,
          frames: document.querySelectorAll("iframe").length,
          footer: document.querySelector("footer")?.textContent ?? "",
        }));
        expect(chrome.tools === 0, `the viewer must not ship the editor toolbar (${chrome.tools} tools)`);
        expect(chrome.share === 0, "a visitor must not get the owner's share control");
        expect(chrome.overlay === 0, "a visitor must not get the selection overlay");
        expect(chrome.frames === 1, `the viewer should render one page frame, saw ${chrome.frames}`);
        expect(/1\s*\/\s*\d+/.test(chrome.footer), `the viewer should say which page, got "${chrome.footer}"`);

        // Every page of the deck renders, not just the first.
        const pages = parseInt(chrome.footer.replace(/^.*\/\s*/, ""), 10);
        expect(pages >= 1, `the footer should name a page count, got "${chrome.footer}"`);
        const broken: string[] = [];
        for (let i = 0; i < pages; i++) {
          const frame = await page.request.fetch(`${base}/api/share/${token}/iframe?scene=${i}`, {
            failOnStatusCode: false,
          });
          if (frame.status() !== 200) broken.push(`scene ${i} → ${frame.status()}`);
        }
        expect(broken.length === 0, `these pages did not render for a visitor: ${broken.join("; ")}`);
        note(`${pages} pages rendered anonymously`);

        // A page that does not exist is not a crash and not a blank — it is a 404.
        for (const scene of [pages, -1, 9999]) {
          const r = await page.request.fetch(`${base}/api/share/${token}/iframe?scene=${scene}`, {
            failOnStatusCode: false,
          });
          expect(r.status() === 404, `scene ${scene} should 404, got ${r.status()}`);
        }

        // The unfurl. A shared link's whole job is to be pasted somewhere, and
        // the preview is what decides whether it looks like a deck or like
        // nothing at all.
        const html = await (await page.request.fetch(`${base}/s/${token}`)).text();
        const ogImage = /<meta property="og:image" content="([^"]+)"/.exec(html)?.[1] ?? "";
        expect(!!ogImage, "the shared page should declare an og:image");
        expect(
          /twitter:card" content="summary_large_image/.test(html),
          "the card should be the large format, not a thumbnail strip",
        );
        const card = await page.request.fetch(ogImage, { failOnStatusCode: false });
        expect(card.status() === 200, `the link preview image should load, got ${card.status()}`);
        const bytes = (await card.body()).length;
        // WhatsApp silently declines previews past a few hundred KB, so the
        // ceiling is a product requirement, not a nicety.
        expect(
          bytes < 600_000,
          `the preview is ${Math.round(bytes / 1024)}KB — too heavy to unfurl everywhere`,
        );
        note(`og:image ${Math.round(bytes / 1024)}KB`);

        // A link is read-only: holding one must not open the owner's API.
        const write = await page.request.fetch(`${base}/api/preview/edit-layout`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          data: { scriptId, sceneIndex: 0, pieceId: "x", op: "move", dxPct: 1, dyPct: 1 },
          failOnStatusCode: false,
          maxRedirects: 0,
        });
        expect(
          write.status() >= 400,
          `a share visitor edited the document (${write.status()}) — links must be read-only`,
        );

        // Revocation, from the recipient's side: the link they already have.
        await disableShare(scriptId, DEV_OWNER_ID);
        const afterPage = await page.request.fetch(`${base}/s/${token}`, { failOnStatusCode: false });
        const afterFrame = await page.request.fetch(`${base}/api/share/${token}/iframe?scene=0`, {
          failOnStatusCode: false,
        });
        const afterCard = await page.request.fetch(`${base}/api/share/${token}/thumbnail`, {
          failOnStatusCode: false,
        });
        expect(afterPage.status() === 404, `a revoked link must stop opening, got ${afterPage.status()}`);
        expect(
          afterFrame.status() === 404,
          `a revoked link must stop rendering pages, got ${afterFrame.status()} — ` +
            "the page and the frame are separate routes and both have to die",
        );
        expect(
          afterCard.status() === 404,
          `a revoked link must stop serving its preview image, got ${afterCard.status()} — ` +
            "otherwise the deck's first slide outlives the link in every chat it was pasted into",
        );
        note("revoked: page, frame and preview all 404");
      } finally {
        await disableShare(scriptId, DEV_OWNER_ID).catch(() => {});
      }
    },
  },

  {
    name: "the public share surface cannot be reached without a link the owner issued",
    tier: "free",
    mutates: true,
    run: async ({ page, base, note }) => {
      const scriptId = devScript();
      await ensureShareableProject(scriptId);
      await disableShare(scriptId, DEV_OWNER_ID);

      // The identifiers a stranger could plausibly hold or guess. A scriptId is
      // the dangerous one: it appears in the owner's own URLs and in exports, so
      // if it doubled as a share token, every link ever shared would leak the
      // whole document space.
      const notTokens = [
        scriptId,
        `qa-share-${scriptId}`,
        newShareToken(), // right shape, never issued
        "a".repeat(43),
        "short",
        "../../../etc/passwd",
        "..%2F..%2F.env.local",
      ];

      const leaks: string[] = [];
      for (const candidate of notTokens) {
        const id = encodeURIComponent(candidate);
        const asPage = await page.request.fetch(`${base}/s/${id}`, { failOnStatusCode: false });
        const asFrame = await page.request.fetch(`${base}/api/share/${id}/iframe?scene=0`, {
          failOnStatusCode: false,
        });
        const asCard = await page.request.fetch(`${base}/api/share/${id}/thumbnail`, {
          failOnStatusCode: false,
        });
        if (asPage.status() < 400) leaks.push(`/s/${candidate.slice(0, 24)} → ${asPage.status()}`);
        if (asFrame.status() < 400) {
          leaks.push(`/api/share/${candidate.slice(0, 24)}/iframe → ${asFrame.status()}`);
        }
        if (asCard.status() < 400) {
          leaks.push(`/api/share/${candidate.slice(0, 24)}/thumbnail → ${asCard.status()}`);
        }
        // A 500 is its own failure: it means the input reached something that
        // did not expect it, and it distinguishes real ids from invented ones.
        if (asPage.status() >= 500 || asFrame.status() >= 500 || asCard.status() >= 500) {
          leaks.push(
            `${candidate.slice(0, 24)} crashed ` +
              `(${asPage.status()}/${asFrame.status()}/${asCard.status()})`,
          );
        }
      }
      note(`${notTokens.length} non-tokens probed`);
      expect(leaks.length === 0, `the share surface answered without a real link: ${leaks.join("; ")}`);

      // An unshared document is private, and a stranger cannot make it public.
      const priv = await shareStateFor(scriptId, DEV_OWNER_ID);
      expect(priv?.shared === false, "the fixture should be private after the probes");
      const steal = await enableShare(scriptId, "someone-else");
      expect(steal === null, "a non-owner must not be able to share a document");
    },
  },
];
