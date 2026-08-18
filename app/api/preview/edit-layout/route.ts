import { NextResponse } from "next/server";
import { documentDir } from "../../../../lib/render/gen-store";
import path from "path";
import { getCurrentUser } from "../../../../lib/auth";
import { loadScript } from "../../../../lib/store";
import {
  moveElement,
  deleteElement,
  resizeElement,
  reorderElement,
} from "../../../../lib/edit/edit-layout";
import { duplicateElement } from "../../../../lib/edit/duplicate-element";

/**
 * M3 layout-edit endpoint — reposition, resize, or delete one element, NO LLM.
 *
 * POST body: { scriptId, sceneIndex, pieceId, op: "move"|"resize"|"delete"|"front"|"back", … }
 *   move   → dx/dy pixel delta added to the piece's current offset
 *   resize → x/y/w/h absolute canvas px (the dragged handles); bakes the origin and
 *            clears any move offset so the two can't stack
 *   delete → removes the piece (siblings never reflow — pieces self-position)
 * All rewrite Composition.tsx, which the preview iframe + MP4 both consume.
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: {
    scriptId?: string;
    sceneIndex?: number;
    pieceId?: string;
    // front/back were accepted by the runtime guard but missing HERE, so every
    // reorder narrowed to "delete" and took the delete branch.
    op?: "move" | "resize" | "delete" | "duplicate" | "front" | "back";
    dx?: number;
    dy?: number;
    x?: number;
    y?: number;
    w?: number;
    h?: number;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { scriptId, sceneIndex, pieceId, op, dx, dy, x, y, w, h } = body;
  if (!scriptId || typeof scriptId !== "string") {
    return NextResponse.json({ error: "scriptId required" }, { status: 400 });
  }
  if (typeof sceneIndex !== "number" || sceneIndex < 0) {
    return NextResponse.json({ error: "sceneIndex must be a non-negative number" }, { status: 400 });
  }
  if (!pieceId || typeof pieceId !== "string") {
    return NextResponse.json({ error: "pieceId required" }, { status: 400 });
  }
  if (op !== "move" && op !== "resize" && op !== "delete" && op !== "front" && op !== "back" && op !== "duplicate") {
    return NextResponse.json(
      { error: 'op must be "move", "resize", "delete", "duplicate", "front" or "back"' },
      { status: 400 },
    );
  }
  if (op === "move" && (typeof dx !== "number" || typeof dy !== "number")) {
    return NextResponse.json({ error: "move requires numeric dx and dy" }, { status: 400 });
  }
  if (op === "resize" && ![x, y, w, h].every((n) => typeof n === "number" && Number.isFinite(n))) {
    return NextResponse.json({ error: "resize requires numeric x, y, w and h" }, { status: 400 });
  }

  const script = await loadScript(scriptId, user.id);
  if (!script) {
    return NextResponse.json({ error: "script not found" }, { status: 404 });
  }

  // Anything below can throw — filesystem, storage hydration. Uncaught, that
  // reached the user as a bare "request failed (500)" with no server-side
  // trace (the same gap insert-element closed).
  try {
    const genDir = await documentDir(scriptId);
    const result =
      op === "move"
        ? await moveElement({ genDir, sceneIndex, pieceId, dx: dx as number, dy: dy as number })
        : op === "resize"
          ? await resizeElement({ genDir, sceneIndex, pieceId, x: x as number, y: y as number, w: w as number, h: h as number })
          : op === "duplicate"
          ? await duplicateElement({ genDir, sceneIndex, pieceId, ...(typeof dx === "number" ? { dx } : {}), ...(typeof dy === "number" ? { dy } : {}) })
          : op === "front" || op === "back"
            // Ordering the element, not removing it. This chain used to end at
            // deleteElement for these two ops — a validated "bring to front"
            // silently deleted the piece, which is exactly the data loss that
            // kept z-order unshipped.
            ? await reorderElement({ genDir, sceneIndex, pieceId, to: op })
            : await deleteElement({ genDir, sceneIndex, pieceId });

    const status = result.ok ? 200 : /not found/.test(result.error ?? "") ? 404 : 400;
    if (!result.ok) {
      // `code` is forwarded so the editor can branch on WHY a resize failed
      // (e.g. "no-wrapper" → rebuild the element at the new size) instead of
      // string-matching an error message that is written for humans.
      return NextResponse.json(
        { ok: false, code: (result as { code?: string }).code, error: result.error },
        { status },
      );
    }
    const payload =
      op === "move"
        ? { ok: true, sceneIndex, pieceId, op, offset: (result as { offset?: unknown }).offset }
        : op === "resize" || op === "front" || op === "back"
          ? { ok: true, sceneIndex, pieceId, op }
          : { ok: true, sceneIndex, pieceId, op, remaining: (result as { remaining?: number }).remaining };
    return NextResponse.json(payload, { status });
  } catch (err) {
    console.error(
      `[edit-layout] ${op} failed for owner=${user.id} script=${scriptId} scene=${sceneIndex}:`,
      err instanceof Error ? (err.stack ?? err.message) : String(err),
    );
    return NextResponse.json(
      { ok: false, error: "that edit didn't go through — nothing was changed. Please try again." },
      { status: 500 },
    );
  }
}
