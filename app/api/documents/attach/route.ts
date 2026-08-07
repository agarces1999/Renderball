import { NextResponse } from "next/server";
import { getCurrentUser } from "../../../../lib/auth";
import { extractText } from "../../../../lib/documents/extract-text";

/**
 * Read an attached document and hand back its text for the brief box.
 *
 * NOTHING IS STORED. The bytes are read, the text is returned, and the buffer
 * is dropped — the user's own brief field is where the text lives from then
 * on, which they can see and edit before spending anything. A document someone
 * attaches to describe their company is exactly the kind of thing that should
 * not quietly accumulate in object storage, and not storing it means there is
 * nothing to leak, expire or delete on request.
 *
 * Extraction is deterministic and costs no tokens.
 *
 * POST multipart { file } → { ok, text, truncated?, name } | { error }
 */

/** Generous for a brief, far below anything that threatens the process. */
const MAX_BYTES = 10 * 1024 * 1024;

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Reject on the declared length BEFORE reading the body, so an oversized
  // upload costs nothing to refuse.
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) {
    return NextResponse.json(
      { error: "That file is larger than 10 MB. Attach a smaller one, or paste the text in." },
      { status: 413 },
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "could not read the upload" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "no file attached" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: "That file is larger than 10 MB. Attach a smaller one, or paste the text in." },
      { status: 413 },
    );
  }

  const buf = Buffer.from(await file.arrayBuffer());
  // file.name is used ONLY to choose a strategy and to echo back for display;
  // it never touches a path.
  const result = extractText(buf, file.name || "attachment");

  if (!result.ok) {
    // reason is written for a person and is safe to show as-is.
    return NextResponse.json({ error: result.reason ?? "That file could not be read." }, { status: 422 });
  }

  return NextResponse.json({
    ok: true,
    text: result.text,
    truncated: !!result.truncated,
    name: file.name || "attachment",
  });
}
