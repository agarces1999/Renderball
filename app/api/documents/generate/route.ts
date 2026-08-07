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
import { buildStatus, startBuild } from "../../../../lib/render/build-jobs";

/**
 * Outline jobs share build-jobs' machinery — the sweep, the retention window
 * and the lost-job age are all the same problem — but under a NAMESPACED key
 * so an outline job and a build job for one document can never overwrite each
 * other's state.
 */
const outlineJob = (scriptId: string) => `outline:${scriptId}`;

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
  // Only blame the brief when it is REALLY thin. A 91-character fragment
  // produced 12 good pages in the outline matrix, so shortness is not a known
  // cause of failure and saying it is would send someone rewriting perfectly
  // good input. Never blocks; only chooses the wording of a failure.
  const BRIEF_CHARS_PER_PAGE = 15;

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

  // A closure, not a hoisted declaration: the early-return guards above have
  // already narrowed scriptId and prompt, and a hoisted function is analysed
  // independently of that narrowing.
  const finish = async (
    result: Awaited<ReturnType<typeof generateScript>>,
  ): Promise<{ status: number; body: unknown }> => {
  if (!result.ok) {
    // The validator's complaint is OUR vocabulary — "visual_concept too thin
    // (602 chars, 2 drawable nouns)", one clause per scene. A founder saw the
    // whole wall of it in red, in the form, with no way forward. It is a
    // useful diagnostic and it belongs in the log, not in front of a person
    // who just spent a minute waiting.
    console.error(
      `[documents/generate] outline failed for ${scriptId} (${pages} pages, ${prompt.length} chars of brief): ${result.error}`,
    );
    // A REFUSAL is not the same as a breakdown, and must not read like one.
    // When the model invented a statistic, the truth gate stopped it on
    // purpose — that is the system protecting the user from printing a number
    // they cannot defend in a room. Telling them "it didn't come together"
    // would hide the one thing they can actually act on: put the real figure
    // in the brief and it will be used.
    const invented = /^Ungrounded numeric claims|^Ungrounded funding-stage/.test(result.error);
    if (invented) {
      const tokens = result.error.replace(/^Ungrounded [^:]*:\s*/, "").split(",").map((t) => t.trim()).filter(Boolean);
      const named = tokens.slice(0, 3).join(", ");
      return {
        status: 502,
        body: {
          error: `The outline kept reaching for figures that aren't in your brief${named ? ` (${named})` : ""}, and we won't put a number in your deck that you can't stand behind. Add the real figures to the brief and generate again — or leave them out and it will write around them.`,
          retryable: true,
        },
      };
    }

    const thin = prompt.length < pages * BRIEF_CHARS_PER_PAGE;
    return {
      status: 502,
      body: {
        error: thin
          ? `The outline didn't come together. ${pages} pages is a lot to build from ${prompt.length} characters — try a few more sentences about who it is for, what problem it solves and what you are asking for, or ask for fewer pages.`
          : "The outline didn't come together this time. Try again — and if it keeps happening, adding a little more detail about the audience and the ask usually settles it.",
        retryable: true,
      },
    };
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
    return { status: 200, body: { ok: true, scriptId, reviewUrl: `/review/${brief.id}` } };
  };

  // OFF THE REQUEST. Measured over 94 successful generations: the median
  // outline takes 79s, p95 is 185s, and 28% exceed 100 SECONDS — 37% at twelve
  // pages. The origin sits behind Cloudflare, whose origin-response timeout is
  // 100s, so better than one twelve-page generation in three returned a 524 to
  // the browser while the outline completed perfectly well on the server. The
  // user saw a failure for work they had already paid for.
  //
  // This is the identical bug lib/render/build-jobs.ts was written to fix for
  // builds, and it is fixed the identical way. Everything measured before now
  // missed it: the matrix calls generateScript directly and the journey probe
  // runs against localhost, so neither ever crossed a proxy.
  const started = await startBuild(outlineJob(scriptId), async () => {
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
      return {
        status: 500,
        body: { error: err instanceof Error ? err.message : "could not generate the outline" },
      };
    }
    return await finish(result);
  });

  if (started.kind === "settled") {
    return NextResponse.json(started.body, { status: started.status });
  }
  // 202: it is genuinely running. The client polls GET below.
  return NextResponse.json({ status: "running", scriptId }, { status: 202 });
}

/**
 * Poll an outline that is still being written. Same contract as the build
 * poll (app/api/preview/build/route.ts) so the client machinery matches.
 *
 * GET ?scriptId=… → { status: "running" | "done" | "error" | "unknown", … }
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const scriptId = new URL(request.url).searchParams.get("scriptId");
  if (!scriptId) return NextResponse.json({ error: "scriptId required" }, { status: 400 });

  // Ownership, on the same terms POST uses: never report another account's
  // outline state.
  const owned = await loadBriefByScriptId(scriptId, user.id);
  if (!owned) return NextResponse.json({ error: "not found" }, { status: 404 });

  const job = buildStatus(outlineJob(scriptId));
  if (job.state === "done") {
    return NextResponse.json({ status: "done", result: job.body, resultStatus: job.status });
  }
  if (job.state === "error") {
    return NextResponse.json({ status: "error", error: job.message });
  }
  return NextResponse.json({ status: job.state });
}
