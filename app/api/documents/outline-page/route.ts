import { NextResponse } from "next/server";
import { getCurrentUser } from "../../../../lib/auth";
import { loadBriefByScriptId, loadScript, saveScript } from "../../../../lib/store";
import { assertZaiAvailable, ZaiUnavailableError } from "../../../../lib/zai-breaker";
import { checkTokenAllowance, recordTokenUsage } from "../../../../lib/metering";
import { buildStatus, startBuild } from "../../../../lib/render/build-jobs";
import { withPhaseTimeout } from "../../../../lib/render/phase-timeout";
import { rewriteOutlinePage } from "../../../../lib/agents/outline-page-rewrite";

/**
 * Rewrite ONE outline page from a user instruction (the review screen's
 * per-page "rewrite" box — founder ask 2026-08-13).
 *
 * POST { scriptId, scene, instruction } → 202 { status: "running" }
 * GET  ?scriptId=…                     → { status, result, resultStatus }
 *
 * Off the request under the shared job machinery (key `outline-page:` —
 * namespaced like `outline:` / `brand:`), phase-bounded at 4 minutes so a
 * hung await settles as an error while the user is still looking (the
 * outline-stall lesson, b51ae6b). A rewrite is deliberately NOT counted
 * against the free plan's outline slots — it is an EDIT of an outline the
 * user already paid a slot for; tokens still meter (allowance + ledger via
 * the transport) like every model call.
 *
 * The page the user approved is replaced only when the rewrite passes the
 * same normalize + validate pass full generation passes — a failed rewrite
 * changes nothing and says why.
 */

const jobKey = (scriptId: string) => `outline-page:${scriptId}`;

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { scriptId?: string; scene?: number; instruction?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { scriptId } = body;
  const sceneIndex = Number(body.scene);
  const instruction = String(body.instruction ?? "").trim();
  if (!scriptId || !Number.isInteger(sceneIndex) || sceneIndex < 0) {
    return NextResponse.json({ error: "scriptId and scene required" }, { status: 400 });
  }
  if (!instruction) {
    return NextResponse.json({ error: "Say what should change on this page." }, { status: 400 });
  }

  const brief = await loadBriefByScriptId(scriptId, user.id);
  if (!brief) return NextResponse.json({ error: "document not found" }, { status: 404 });
  const script = await loadScript(scriptId, user.id);
  if (!script) return NextResponse.json({ error: "outline not found" }, { status: 404 });
  if (sceneIndex >= script.scenes.length) {
    return NextResponse.json({ error: "that page no longer exists" }, { status: 400 });
  }

  try {
    assertZaiAvailable();
  } catch (err) {
    if (err instanceof ZaiUnavailableError) {
      return NextResponse.json({ error: err.friendly }, { status: 503 });
    }
    throw err;
  }
  const gate = await checkTokenAllowance(user.id);
  if (!gate.allowed) {
    return NextResponse.json({ error: gate.reason ?? "token allowance exhausted" }, { status: 402 });
  }

  const outcome = await startBuild(jobKey(scriptId), async () => {
    const r = await withPhaseTimeout(
      "Rewriting the page",
      240_000,
      rewriteOutlinePage(script, sceneIndex, instruction),
    );
    // Tokens meter whether or not the rewrite validated — the spend happened.
    if (r.usage) {
      await recordTokenUsage({ ownerId: user.id, usage: r.usage, op: "outline-edit" });
    }
    if (!r.ok || !r.script) {
      return { status: 422, body: { error: r.error ?? "The rewrite didn't come together." } };
    }
    await saveScript(r.script, user.id);
    return { status: 200, body: { ok: true, scene: r.scene, scenes: r.script.scenes } };
  });

  if (outcome.kind === "settled") {
    return NextResponse.json(outcome.body as Record<string, unknown>, { status: outcome.status });
  }
  return NextResponse.json({ status: "running" }, { status: 202 });
}

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const scriptId = new URL(request.url).searchParams.get("scriptId");
  if (!scriptId) return NextResponse.json({ error: "scriptId required" }, { status: 400 });
  const owned = await loadScript(scriptId, user.id);
  if (!owned) return NextResponse.json({ error: "not found" }, { status: 404 });

  const job = buildStatus(jobKey(scriptId));
  if (job.state === "done") {
    return NextResponse.json({ status: "done", result: job.body, resultStatus: job.status });
  }
  if (job.state === "error") {
    return NextResponse.json({ status: "error", error: job.message });
  }
  return NextResponse.json({ status: job.state });
}
