import { NextResponse } from "next/server";
import { getCurrentUser } from "../../../../lib/auth";
import { deleteDocument } from "../../../../lib/delete-document";

/**
 * DELETE /api/documents/<id> — remove one document and everything it owns.
 *
 * Accepts either the project id or the scriptId; both appear in the app's own
 * URLs and asking the user to know which is which would be silly.
 *
 * A document that is not yours answers 404, not 403: "you may not touch this"
 * confirms the id exists, and the id space should not be probeable by a
 * signed-in stranger any more than by an anonymous one.
 *
 * Inside the Clerk matcher? No — /api/documents is not in it, so the session
 * check here is the ONLY thing standing between an anonymous caller and this
 * route. That is why it comes first and why there is nothing above it.
 */
export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const result = await deleteDocument(params.id, user.id);
    if (!result) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (result.storageFailures.length) {
      // The document is gone as far as the user is concerned; the objects are
      // orphaned and need a sweep. Loud, because nothing else will notice.
      console.error(
        `[delete-document] ${result.projectId} deleted with orphaned storage: ${result.storageFailures.join(", ")}`,
      );
    }
    return NextResponse.json({ deleted: true, id: result.projectId });
  } catch (err) {
    console.error("[delete-document] failed:", err);
    return NextResponse.json({ error: "Could not delete that document." }, { status: 500 });
  }
}
