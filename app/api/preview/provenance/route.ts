import { NextResponse } from "next/server";
import { getCurrentUser } from "../../../../lib/auth";
import { loadBriefByScriptId } from "../../../../lib/store";
import { documentDir } from "../../../../lib/render/gen-store";
import { readProvenance } from "../../../../lib/edit/provenance";

/**
 * The element panel's read: which elements carry a kept creation instruction
 * (lib/edit/provenance.ts). Elements absent from the map were born with their
 * page — the client shows the page's visual brief for those instead.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const scriptId = new URL(request.url).searchParams.get("scriptId");
  if (!scriptId) return NextResponse.json({ error: "scriptId required" }, { status: 400 });
  const brief = await loadBriefByScriptId(scriptId, user.id);
  if (!brief) return NextResponse.json({ error: "not found" }, { status: 404 });
  const genDir = await documentDir(scriptId);
  return NextResponse.json({ provenance: await readProvenance(genDir) });
}
