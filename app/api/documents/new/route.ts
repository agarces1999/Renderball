import { NextResponse } from "next/server";
import { getCurrentUser } from "../../../../lib/auth";
import { saveBrief, saveScript } from "../../../../lib/store";
import { withDbRetry } from "../../../../lib/db";
import { ulid } from "../../../../lib/ulid";
import {
  blankBrief,
  blankScript,
  writeBlankDocument,
} from "../../../../lib/documents/blank-document";
import { persistGenDir } from "../../../../lib/render/gen-store";
import { startBrandCrawl } from "../../../../lib/documents/brand-crawl";
import { normalizeSiteUrl } from "../../../../lib/documents/site-brand";

/**
 * Create an empty document and open its editor.
 *
 * This replaces `/new` as the entry point. Creating a document used to mean a
 * brief form, a mandatory logo upload, ~60s and tokens for an outline, an
 * approval page, then ~$1 and minutes of build — four surfaces and two paid
 * steps before the user saw a canvas, on a product whose landing promises
 * "draw a box, say what belongs inside it".
 *
 * Here a document is real from the first instant: a legal script and a valid
 * composition are SYNTHESISED (lib/documents/blank-document.ts), so this costs
 * nothing, calls no model, and needs no brand kit. Generation moves inside the
 * editor, where the user can generate the whole deck from a brief or build it
 * up element by element — the choice the founder asked for, and the one the
 * landing already sells.
 *
 * GET so a plain link works; it is a create action, so it is deliberately not
 * cached and always redirects to a fresh document.
 */
export const dynamic = "force-dynamic";

/**
 * Relative redirect, deliberately.
 *
 * `new URL(path, request.url)` resolves against the CONTAINER's own address —
 * inside Railway that is https://0.0.0.0:8080, so the browser was sent to an
 * unreachable origin. (The same trap bit the auth middleware.) A relative
 * Location is resolved by the browser against the address it actually used.
 */
const redirectTo = (path: string): NextResponse =>
  new NextResponse(null, { status: 303, headers: { Location: path } });

export async function GET(request: Request) {
  // NEVER create on a prefetch. In production the App Router prefetches any
  // same-origin Link the moment it scrolls into view — with session cookies —
  // and every "New document" button is such a Link. Before this guard, a
  // signed-in user minted a phantom document (DB rows, disk, R2) just by
  // LOOKING at a page with the button on it; dev never shows this because
  // viewport prefetch is disabled outside production. The links also carry
  // prefetch={false} now, but a route with side effects must refuse on its
  // own. Only the Next-Router-Prefetch header is checked — a real click-through
  // navigation sends RSC:1 WITHOUT it, and that is the legitimate create.
  if (request.headers.get("next-router-prefetch") === "1") {
    return new NextResponse(null, { status: 204 });
  }
  const user = await getCurrentUser();
  if (!user) {
    // Same posture as the protected pages: sign in, then come back here.
    return redirectTo("/sign-in?redirect_url=%2Fapi%2Fdocuments%2Fnew");
  }

  const briefId = ulid();
  const scriptId = ulid();

  try {
    // Materialise on disk first: if this fails there is no orphan row pointing
    // at a document that cannot open.
    await writeBlankDocument(scriptId, 1);

    const script = blankScript(scriptId, 1);

    await withDbRetry(() => saveScript(script, user.id));
    await withDbRetry(() => saveBrief(blankBrief(briefId, user.id, scriptId)));

    // Publish so the document survives a redeploy from creation — but in the
    // BACKGROUND (founder, 2026-08-29: "why does it take so long"). Awaiting
    // this R2 upload put a full storage round-trip between the click and the
    // canvas, buying insurance against a redeploy landing in the few seconds
    // before the upload completes anyway. Fire, log on failure, don't bill
    // the user's patience for it. First-edit persistence is unchanged.
    void persistGenDir(scriptId).catch((e) =>
      console.error(`[documents/new] background persist failed for ${scriptId}:`, e),
    );
  } catch (err) {
    // This is the front door — every "New document" button in the app points
    // here. A bare throw renders the browser's own 500 page, which tells the
    // user nothing and leaves no trace to debug from, so log with the ids and
    // send them somewhere they can retry.
    console.error(
      `[documents/new] create failed for owner=${user.id} script=${scriptId}:`,
      err instanceof Error ? (err.stack ?? err.message) : String(err),
    );
    return redirectTo("/documents?error=create_failed");
  }

  // Brand, if we already know where to look. `?url=` is optional and the
  // create path never waits on it: `startBrandCrawl` registers the job and
  // returns, so this adds no measurable time to a route whose whole promise is
  // that it is instant. The read it starts is the FREE tier — zero model calls
  // — because nothing may be spent on creating a document (see brand-crawl.ts
  // TIER_COST). With no url this is a no-op and the user sails through.
  //
  // Most documents get their URL a second later from the editor's own field
  // (components/BlankDocumentPanel.tsx → POST /api/documents/brand), which is
  // the same job under the same key. This parameter is here so a link that
  // already knows the site — a landing-page hand-off, a "new document like
  // this one" — starts the read at creation rather than after it.
  const url = normalizeSiteUrl(new URL(request.url).searchParams.get("url") ?? "");
  if (url) {
    startBrandCrawl({ scriptId, ownerId: user.id, url, tier: "free" });
  }

  return redirectTo(`/preview/${scriptId}`);
}
