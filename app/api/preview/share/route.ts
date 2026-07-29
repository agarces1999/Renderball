import { NextResponse } from "next/server";
import { getCurrentUser } from "../../../../lib/auth";
import { disableShare, enableShare, shareStateFor, shareUrlPath } from "../../../../lib/share";

/**
 * Owner-side control of a document's public link.
 *
 * Lives under /api/preview so the Clerk middleware protects it — turning sharing
 * on or off is an owner action and must never be reachable anonymously. The
 * PUBLIC half is somewhere else entirely (/s/<token> and /api/share/<token>/*),
 * which is what keeps "anyone can view" from becoming "anyone can change".
 *
 * Every operation is owner-scoped in the query itself, so knowing a scriptId is
 * not enough to share, rotate or revoke someone else's document.
 *
 * GET    ?scriptId=…              → { shared, url? }
 * POST   { scriptId, rotate? }    → { shared: true, url }
 * DELETE { scriptId }             → { shared: false }
 */

export const dynamic = "force-dynamic";

const readScriptId = async (request: Request): Promise<string | null> => {
  if (request.method === "GET") return new URL(request.url).searchParams.get("scriptId");
  try {
    const body = (await request.json()) as { scriptId?: unknown };
    return typeof body.scriptId === "string" ? body.scriptId : null;
  } catch {
    return null;
  }
};

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const scriptId = new URL(request.url).searchParams.get("scriptId");
  if (!scriptId) return NextResponse.json({ error: "scriptId required" }, { status: 400 });

  const state = await shareStateFor(scriptId, user.id);
  if (!state) return NextResponse.json({ error: "document not found" }, { status: 404 });

  return NextResponse.json({
    shared: state.shared,
    url: state.token ? shareUrlPath(state.token) : undefined,
    sharedAt: state.sharedAt ?? undefined,
  });
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let rotate = false;
  let scriptId: string | null = null;
  try {
    const body = (await request.json()) as { scriptId?: unknown; rotate?: unknown };
    scriptId = typeof body.scriptId === "string" ? body.scriptId : null;
    rotate = body.rotate === true;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!scriptId) return NextResponse.json({ error: "scriptId required" }, { status: 400 });

  const state = await enableShare(scriptId, user.id, { rotate });
  if (!state) return NextResponse.json({ error: "document not found" }, { status: 404 });

  return NextResponse.json({ shared: true, url: shareUrlPath(state.token!), sharedAt: state.sharedAt });
}

export async function DELETE(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const scriptId = await readScriptId(request);
  if (!scriptId) return NextResponse.json({ error: "scriptId required" }, { status: 400 });

  const state = await disableShare(scriptId, user.id);
  if (!state) return NextResponse.json({ error: "document not found" }, { status: 404 });

  return NextResponse.json({ shared: false });
}
