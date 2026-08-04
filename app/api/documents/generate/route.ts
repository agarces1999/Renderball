import { NextResponse } from "next/server";
import { getCurrentUser } from "../../../../lib/auth";
import { loadBriefByScriptId, loadScript, saveBrief, saveScript } from "../../../../lib/store";
import { isBlankDocument } from "../../../../lib/documents/blank-document";
import { documentDir } from "../../../../lib/render/gen-store";
import { withDbRetry } from "../../../../lib/db";
import { generateScript, DECK_SECONDS_PER_SLIDE } from "../../../../lib/agents/script-generator";
import { checkEntitlement } from "../../../../lib/entitlement";
import { checkTokenAllowance } from "../../../../lib/metering";
import { assertZaiAvailable, ZaiUnavailableError } from "../../../../lib/zai-breaker";

/**
 * Fill an existing BLANK document by generating its outline.
 *
 * This is the "generate every page for me" half of the editor's empty state.
 * It exists so the expensive path can start from inside the canvas instead of
 * from a separate form page — the document already exists and is already open,
 * so this only has to give it content.
 *
 * It stops at the OUTLINE on purpose. Designing every page costs ~$1 and
 * minutes, so the user should see what will be built before it is built; the
 * existing review/build machinery takes it from here. Gates live on this call
 * rather than on document creation, which is where the spend actually is.
 *
 * POST { scriptId, prompt, url?, pages? } → { ok, scriptId }
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { scriptId?: string; prompt?: string; url?: string; pages?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { scriptId } = body;
  const prompt = body.prompt?.trim();
  if (!scriptId || !prompt) {
    return NextResponse.json({ error: "scriptId and prompt required" }, { status: 400 });
  }
  const pages = Math.max(1, Math.min(12, Number(body.pages) || 6));

  // Ownership: the document must already exist and be theirs.
  const brief = await loadBriefByScriptId(scriptId, user.id);
  if (!brief) return NextResponse.json({ error: "document not found" }, { status: 404 });

  // Only a BLANK document may be filled. Generating an outline into a document
  // someone has already built pages into would replace their work wholesale —
  // this route had ownership and spend gates but no content gate, and the
  // "Generate every page" button is deliberately reachable from the editor.
  const existing = await loadScript(scriptId, user.id);
  // documentDir HYDRATES from durable storage first. A raw path here failed
  // OPEN: on any container that had not seen this document (every container
  // after a deploy), the manifest read threw ENOENT, "blank" came back true,
  // and the gate waved through exactly the decks it exists to protect. Same
  // reason the unreadable case is "not-blank" on this destructive path.
  const genDir = await documentDir(scriptId);
  if (existing && !(await isBlankDocument(genDir, existing, "not-blank"))) {
    return NextResponse.json(
      { error: "this document already has content — full generation would replace it. Start a new document instead." },
      { status: 409 },
    );
  }

  try {
    assertZaiAvailable();
  } catch (err) {
    if (err instanceof ZaiUnavailableError) {
      return NextResponse.json({ error: err.friendly }, { status: 503 });
    }
    throw err;
  }

  // The spend gates moved here from document creation — this is the first
  // call that costs anything.
  const ent = await checkEntitlement(user.id, "generate");
  if (!ent.allowed) {
    return NextResponse.json({ error: ent.reason ?? "plan limit reached" }, { status: 402 });
  }
  const gate = await checkTokenAllowance(user.id);
  if (!gate.allowed) {
    return NextResponse.json(
      { error: gate.reason ?? "token allowance exhausted" },
      { status: 402 },
    );
  }

  const updated = {
    ...brief,
    purpose: prompt.slice(0, 200),
    freeform_prompt: prompt,
    kind: "deck" as const,
    duration_seconds: pages * DECK_SECONDS_PER_SLIDE,
    brand_kit_url: body.url?.trim() || brief.brand_kit_url,
  };

  let result;
  try {
    result = await generateScript(
      {
        ...updated,
        moment_count: pages,
      } as unknown as Parameters<typeof generateScript>[0],
      brief.id,
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "could not generate the outline" },
      { status: 500 },
    );
  }
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  // Keep the document's EXISTING scriptId: the editor is already open on it,
  // the genDir is already on disk, and the brand panel may already hold the
  // user's colours. Re-keying here would strand all three.
  const script = { ...result.script, id: scriptId };
  await withDbRetry(() => saveScript(script, user.id));
  await withDbRetry(() =>
    saveBrief({ ...updated, script_id: scriptId, status: "script_generated" } as typeof brief),
  );

  // Send the user to the OUTLINE REVIEW, not back to the editor. The panel
  // promises "you approve the outline before anything is designed" — and a
  // reload of /preview/[id] cannot keep it: the blank composition still
  // exists, so the page takes the editor branch and the user lands on the
  // same blank canvas they left, having paid for an outline they never see.
  return NextResponse.json({ ok: true, scriptId, reviewUrl: `/review/${brief.id}` });
}
