import { NextResponse } from "next/server";
import { getCurrentUser } from "../../../../lib/auth";
import { saveBrief, saveScript } from "../../../../lib/store";
import { withDbRetry } from "../../../../lib/db";
import { ulid } from "../../../../lib/ulid";
import { writeBlankDocument } from "../../../../lib/documents/blank-document";
import { persistGenDir } from "../../../../lib/render/gen-store";

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

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    // Same posture as the protected pages: sign in, then come back here.
    return redirectTo("/sign-in?redirect_url=%2Fapi%2Fdocuments%2Fnew");
  }

  const briefId = ulid();
  const scriptId = ulid();

  // Materialise on disk first: if this fails there is no orphan row pointing
  // at a document that cannot open.
  await writeBlankDocument(scriptId, 1);

  const script = (await import("../../../../lib/documents/blank-document")).blankScript(
    scriptId,
    1,
  );

  await withDbRetry(() => saveScript(script, user.id));
  await withDbRetry(() =>
    saveBrief({
      id: briefId,
      owner_id: user.id,
      purpose: "Untitled document",
      duration_seconds: 5,
      kind: "deck",
      distribution_format: "landscape",
      script_id: scriptId,
      // No brand_extract and no brand_files on purpose. Brand is set from the
      // editor's brand panel now, not demanded up front — the logo requirement
      // was a hard stop on a user's very first run.
    } as Parameters<typeof saveBrief>[0]),
  );

  // Publish immediately so the document survives a redeploy from creation,
  // not just from its first edit.
  await persistGenDir(scriptId);

  return redirectTo(`/preview/${scriptId}`);
}
