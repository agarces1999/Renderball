/**
 * Public share links — the security properties, not the happy path.
 *
 * This is the first feature that deliberately serves a document to someone with
 * no account, so the questions worth asking are all about what a link does NOT
 * grant: it must not be guessable, must not be derivable from a scriptId, must
 * not survive revocation, must not name a document a visitor could then reach
 * another way, and must not let anyone but the owner turn it on.
 *
 * Real rows, real tokens, cleaned up at the end.
 */
import { prisma } from "./db";
import {
  disableShare,
  enableShare,
  loadSharedDocument,
  newShareToken,
  shareStateFor,
  shareTitle,
  shareUrlPath,
} from "./share";
import { saveBrief, saveScript } from "./store";
import { blankBrief, blankScript } from "./documents/blank-document";
import { ulid } from "./ulid";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => Promise<void> | void) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

const run = async () => {
  console.log("share links");

  const stamp = ulid();
  let ownerId = "";
  let strangerId = "";
  const briefId = ulid();
  const scriptId = ulid();

  try {
    const owner = await prisma.user.create({
      data: { clerkId: `SHARE_OWNER_${stamp}`, email: `share-owner-${stamp}@invalid.test` },
    });
    const stranger = await prisma.user.create({
      data: { clerkId: `SHARE_OTHER_${stamp}`, email: `share-other-${stamp}@invalid.test` },
    });
    ownerId = owner.id;
    strangerId = stranger.id;

    await saveScript(blankScript(scriptId, 3), ownerId);
    await saveBrief(blankBrief(briefId, ownerId, scriptId, 3));

    // ── the token itself ───────────────────────────────────────────────────

    await check("tokens are long, URL-safe and never repeat", () => {
      const seen = new Set<string>();
      for (let i = 0; i < 500; i++) {
        const t = newShareToken();
        assert(t.length >= 40, `token too short to resist guessing: ${t.length} chars`);
        assert(/^[A-Za-z0-9_-]+$/.test(t), `token must be URL-safe, got ${t}`);
        assert(!seen.has(t), "tokens must never collide");
        seen.add(t);
      }
    });

    await check("a brief-length purpose becomes a title a tab can hold", () => {
      const long =
        "Introduce Flarebit's AI-native design studio: paste a URL, get an on-brand " +
        "presentation deck in minutes, edit by drawing a box and describing content, " +
        "close on requesting early access.";
      const t = shareTitle(long);
      assert(t.length <= 73, `a tab title must stay short, got ${t.length} chars`);
      assert(t.startsWith("Introduce Flarebit"), `it should keep the beginning, got ${t}`);

      assert(shareTitle("Q3 board update.") === "Q3 board update", "a short sentence loses its full stop");
      assert(shareTitle("Q3 board update") === "Q3 board update", "a short label passes through");
      assert(shareTitle("   ") === "Untitled document", "an empty purpose still names something");
      assert(
        shareTitle("a".repeat(200)).endsWith("…"),
        "an unbreakable string is cut with an ellipsis",
      );
    });

    // ── default state ──────────────────────────────────────────────────────

    await check("a document is PRIVATE until someone shares it", async () => {
      const state = await shareStateFor(scriptId, ownerId);
      assert(state !== null, "the owner should be able to read the share state");
      assert(state!.shared === false, "a new document must not be shared");
    });

    await check("a scriptId is NOT a share token", async () => {
      // The whole point: ids leak (URLs, exports, support threads). Knowing one
      // must not open the deck.
      assert(
        (await loadSharedDocument(scriptId)) === null,
        "a document id must never work as a share token",
      );
    });

    // ── sharing ────────────────────────────────────────────────────────────

    let token = "";
    await check("the owner can share, and the link resolves", async () => {
      const state = await enableShare(scriptId, ownerId);
      assert(!!state?.token, "sharing should produce a token");
      token = state!.token!;
      const shared = await loadSharedDocument(token);
      assert(!!shared, "the token should resolve to the document");
      assert(shared!.scriptId === scriptId, "it should resolve to the RIGHT document");
      assert(shared!.script.scenes.length === 3, "the viewer needs the pages");
      assert(shareUrlPath(token) === `/s/${token}`, "the shareable path should be /s/<token>");
    });

    await check("sharing twice returns the SAME link", async () => {
      // Otherwise every visit to the share panel would silently break the URL
      // the user already sent.
      const again = await enableShare(scriptId, ownerId);
      assert(again?.token === token, "re-sharing must not mint a second link");
    });

    await check("a stranger cannot share someone else's document", async () => {
      const attempt = await enableShare(scriptId, strangerId);
      assert(attempt === null, "sharing must be owner-scoped");
      const state = await shareStateFor(scriptId, strangerId);
      assert(state === null, "a stranger must not even see the share state");
    });

    // ── what a link grants ─────────────────────────────────────────────────

    await check("a wrong or invented token resolves to nothing", async () => {
      for (const bad of [newShareToken(), "short", "", "../../etc/passwd", token.slice(0, -1)]) {
        assert(
          (await loadSharedDocument(bad)) === null,
          `an invalid token must not resolve: ${JSON.stringify(bad.slice(0, 24))}`,
        );
      }
    });

    await check("the shared payload carries pages and a title, not the owner", async () => {
      const shared = await loadSharedDocument(token);
      const raw = JSON.stringify(shared);
      assert(!raw.includes(ownerId), "the public payload must not name the owner");
      assert(!/@invalid\.test/.test(raw), "the public payload must not include an email");
      assert(!!shared!.title, "a viewer should see the document's title");
    });

    // ── revocation ─────────────────────────────────────────────────────────

    await check("revoking breaks the link immediately", async () => {
      const off = await disableShare(scriptId, ownerId);
      assert(off?.shared === false, "revoking should report the document private");
      assert(
        (await loadSharedDocument(token)) === null,
        "a revoked link must stop working at once",
      );
    });

    await check("a revoked link is indistinguishable from one that never existed", async () => {
      // Both null — so a visitor cannot learn that a document is there but
      // withdrawn, which is itself information about the owner.
      const revoked = await loadSharedDocument(token);
      const invented = await loadSharedDocument(newShareToken());
      assert(revoked === invented, "revoked and unknown must be the same answer");
    });

    await check("revoking twice is harmless", async () => {
      const again = await disableShare(scriptId, ownerId);
      assert(again?.shared === false, "a second revoke should be a clean no-op");
    });

    await check("a stranger cannot revoke someone else's link", async () => {
      await enableShare(scriptId, ownerId);
      const attempt = await disableShare(scriptId, strangerId);
      assert(attempt === null, "revoking must be owner-scoped");
      const state = await shareStateFor(scriptId, ownerId);
      assert(state?.shared === true, "the owner's link must survive a stranger's attempt");
    });

    // ── rotation ───────────────────────────────────────────────────────────

    await check("rotating issues a new link and kills the old one", async () => {
      const before = (await shareStateFor(scriptId, ownerId))!.token!;
      const after = await enableShare(scriptId, ownerId, { rotate: true });
      assert(!!after?.token && after.token !== before, "rotation must produce a different token");
      assert((await loadSharedDocument(before)) === null, "the old link must stop working");
      assert(!!(await loadSharedDocument(after!.token!)), "the new link must work");
    });

    await check("sharing one document does not share any other", async () => {
      const otherScript = ulid();
      const otherBrief = ulid();
      await saveScript(blankScript(otherScript, 1), ownerId);
      await saveBrief(blankBrief(otherBrief, ownerId, otherScript));
      const state = await shareStateFor(otherScript, ownerId);
      assert(state?.shared === false, "a sibling document must stay private");
      await prisma.project.deleteMany({ where: { id: otherBrief } }).catch(() => {});
      await prisma.scriptDoc.deleteMany({ where: { id: otherScript } }).catch(() => {});
    });

    await check("deleting the account takes the public link with it", async () => {
      // A shared deck must not outlive the account that published it.
      const live = (await shareStateFor(scriptId, ownerId))!.token!;
      assert(!!(await loadSharedDocument(live)), "precondition: the link works");
      const { deleteUserData } = await import("./delete-user");
      await deleteUserData(ownerId);
      ownerId = ""; // already gone; skip in cleanup
      assert(
        (await loadSharedDocument(live)) === null,
        "a deleted account's share link must stop resolving",
      );
    });
  } finally {
    for (const id of [ownerId, strangerId]) {
      if (id) await prisma.user.delete({ where: { id } }).catch(() => {});
    }
    await prisma.scriptDoc.deleteMany({ where: { id: scriptId } }).catch(() => {});
    const left = await prisma.user
      .findMany({ where: { clerkId: { in: [`SHARE_OWNER_${stamp}`, `SHARE_OTHER_${stamp}`] } } })
      .catch(() => []);
    console.log(`  · cleanup — users left: ${left.length}`);
    await prisma.$disconnect().catch(() => {});
  }

  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
};

await run();
