//
// M3 layout edits — reposition + delete, NO LLM. Both are pure manifest edits
// applied deterministically:
//
//   move:   accumulate a per-piece translate offset in the manifest; the
//           reassembler wraps only that piece in a section-filling translate layer.
//   delete: drop the piece from the scene + strip its template slot + remove its
//           file; the reassembler emits nothing for it.
//
// Both then reassemble the full Composition, finalize (import/stub any undefined
// refs — a no-op here, but keeps every write path identical to build + regen), and
// write. Zero-neighbor is structural: no sibling piece file or body is touched, and
// because pieces are self-positioned there is no reflow — a moved/deleted element
// changes only itself.
//
import { promises as fs } from "fs";
import path from "path";
import {
  readManifest,
  writeManifest,
  readDecomposed,
  writePieceBody,
  setPieceOffset,
  removePieceFromManifest,
  captureUndo,
  commitUndo,
  storeErrorMessage,
  type PieceOffset,
} from "../agents/lego-store";
import { pieceSlot } from "../agents/lego-decompose";
import { commitGenDir } from "./commit";
import { withGenDirLock } from "./gendir-lock";
import { findChildInScene, findMappedChildInScene, dropMappedIndex, removeChildBlock } from "./nested-piece";

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The shared reassemble → finalize → compile-check → write barrier (lib/edit/commit.ts). */
const commit = (genDir: string) => commitGenDir(genDir, "layout edit");

export interface MoveElementInput {
  genDir: string;
  sceneIndex: number;
  pieceId: string;
  /** Pixel delta to add to the piece's current offset (a drag). */
  dx: number;
  dy: number;
}
export interface MoveElementResult {
  ok: boolean;
  code?: string;
  offset?: PieceOffset;
  error?: string;
}

export const moveElement = async (input: MoveElementInput): Promise<MoveElementResult> => {
  const { genDir, sceneIndex, pieceId, dx, dy } = input;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
    return { ok: false, error: "dx and dy must be finite numbers" };
  }

  return withGenDirLock(genDir, async () => {
    const snapshot = await readManifest(genDir);
    const piece = snapshot.scenes
      .find((s) => s.sceneIndex === sceneIndex)
      ?.pieces.find((p) => p.id === pieceId);
    if (!piece) {
      // Nested children can be regenerated/deleted but not (yet) moved — their offset
      // would live inside the parent's coordinate space, not the manifest.
      const d = await readDecomposed(genDir);
      const scene = d.scenes.find((s) => s.sceneIndex === sceneIndex);
      if (scene && findChildInScene(scene, pieceId)) {
        return { ok: false, error: "moving a nested element isn't supported yet — regenerate or delete it, or move the whole group" };
      }
      return { ok: false, error: `piece "${pieceId}" not found in scene ${sceneIndex}` };
    }

    const prev = piece.offset ?? { dx: 0, dy: 0 };
    const offset: PieceOffset = { dx: prev.dx + dx, dy: prev.dy + dy };
    const undo = await captureUndo(genDir);
    try {
      await setPieceOffset(genDir, sceneIndex, pieceId, offset);
      const res = await commit(genDir);
      if (!res.ok) {
        await writeManifest(genDir, snapshot); // roll back the offset
        return { ok: false, error: res.error };
      }
      await commitUndo(genDir, undo, "move");
      return { ok: true, code: res.code, offset };
    } catch (e) {
      await writeManifest(genDir, snapshot).catch(() => {});
      return { ok: false, error: `move failed: ${msg(e)}` };
    }
    // The reads ABOVE the inner try (readManifest, readDecomposed) throw too —
    // uncaught, they escaped the route as a non-JSON 500 and the user saw
    // "request failed (500)" instead of the store's own sentence.
  }).catch((e) => ({ ok: false, error: storeErrorMessage(e) }));
};

export interface DeleteElementInput {
  genDir: string;
  sceneIndex: number;
  pieceId: string;
}
export interface DeleteElementResult {
  ok: boolean;
  code?: string;
  remaining?: number;
  error?: string;
}

export const deleteElement = async (input: DeleteElementInput): Promise<DeleteElementResult> => {
  const { genDir, sceneIndex, pieceId } = input;

  return withGenDirLock(genDir, async () => {
    const snapshot = await readManifest(genDir);
    const undo = await captureUndo(genDir);
    // A top-level piece: mutate the manifest but DEFER the irreversible body-file
    // delete until commit succeeds, so a compile failure rolls back to an intact store.
    const removed = await removePieceFromManifest(genDir, sceneIndex, pieceId);
    if (removed.ok) {
      try {
        const res = await commit(genDir);
        if (!res.ok) {
          await writeManifest(genDir, snapshot); // restore the piece + slot
          return { ok: false, error: res.error };
        }
        await fs.rm(removed.file!, { force: true }); // safe now — commit succeeded
        await commitUndo(genDir, undo, "delete");
        const manifest = await readManifest(genDir);
        const remaining = manifest.scenes.find((s) => s.sceneIndex === sceneIndex)?.pieces.length ?? 0;
        return { ok: true, code: res.code, remaining };
      } catch (e) {
        await writeManifest(genDir, snapshot).catch(() => {});
        return { ok: false, error: `delete failed: ${msg(e)}` };
      }
    }

    // Not a top-level piece — it may be a nested CHILD. Splice its <Piece> block out
    // of the parent's body; only the parent piece file changes, no sibling reflows.
    const d = await readDecomposed(genDir);
    const scene = d.scenes.find((s) => s.sceneIndex === sceneIndex);
    const nested = scene ? findChildInScene(scene, pieceId) : null;
    if (!nested) {
      // Not written out literally either — it may be one item of a MAPPED
      // list, whose id exists only after the template evaluates. Delete the
      // DATA (filter the mapped expression), never the <Piece> block, which
      // is the template for every item in the list.
      const mapped = scene ? findMappedChildInScene(scene, pieceId) : null;
      if (!mapped) return { ok: false, error: `piece "${pieceId}" not found in scene ${sceneIndex}` };
      const before = mapped.parent.body;
      try {
        await writePieceBody(
          genDir,
          mapped.parent.id,
          dropMappedIndex(before, mapped.mapAt, mapped.index),
        );
        const res = await commit(genDir);
        if (!res.ok) {
          await writePieceBody(genDir, mapped.parent.id, before); // rollback
          return { ok: false, error: res.error };
        }
        await commitUndo(genDir, undo, "delete");
        return { ok: true, code: res.code };
      } catch (e) {
        await writePieceBody(genDir, mapped.parent.id, before).catch(() => {});
        return { ok: false, error: `delete failed: ${msg(e)}` };
      }
    }

    const originalBody = nested.parent.body;
    try {
      await writePieceBody(genDir, nested.parent.id, removeChildBlock(originalBody, nested.child));
      const res = await commit(genDir);
      if (!res.ok) {
        await writePieceBody(genDir, nested.parent.id, originalBody); // rollback the parent body
        return { ok: false, error: res.error };
      }
      await commitUndo(genDir, undo, "delete");
      return { ok: true, code: res.code, remaining: nested.siblings.length };
    } catch (e) {
      await writePieceBody(genDir, nested.parent.id, originalBody).catch(() => {});
      return { ok: false, error: `delete failed: ${msg(e)}` };
    }
    // Store reads outside the inner try blocks — see moveElement.
  }).catch((e) => ({ ok: false, error: storeErrorMessage(e) }));
};

// ── z-order ─────────────────────────────────────────────────────────────────
//
// Paint order is SLOT order in the scene template ({/*RB:<id>*/} markers), not
// the order of the manifest's `pieces` array — pieces render as fragments in one
// stacking context, so whichever slot is emitted last paints on top.
//
// THAT IS ONLY HALF THE STORY, and the missing half is why this feature sat
// unshipped: an explicit z-index beats document order, and generated pieces
// routinely carry one. Measured on the reference deck, five of its eight pieces
// had `zIndex: 1..5` baked into their bodies by the element-insert path. Moving
// the marker for any of those changed the manifest, changed the DOM, and
// changed nothing on screen — the "manifest/render desync" that looked
// mysterious and was simply CSS.
//
// So a reorder does both: it moves the marker AND records an explicit layer
// that clears (or undercuts) every z-index in the scene. The layer is applied by
// the reassembler, like a move offset, so it survives a regenerate.
const zIndexInBody = /(?:zIndex|z-index)\s*[:=]\s*["'{\s]*(-?\d+)/g;

/**
 * Where explicit layers live, above anything generated code writes.
 *
 * A source scan is not sufficient on its own and the QA flow proved it: on the
 * reference deck the scan found a highest z-index of 5, while the browser
 * computed 20 for an element whose stacking comes from somewhere the piece
 * bodies do not show — a stylesheet rule, the scene preamble, a value this
 * regex cannot see. Anything built from an incomplete scan is a "bring to
 * front" that lands underneath something.
 *
 * So fronting puts the piece in a band that generated code does not use.
 * Observed z-indexes across every local deck sit in the 1–20 range; a thousand
 * is not a magic number so much as a different order of magnitude, and the scan
 * below still raises it if a deck ever exceeds the band.
 */
const FRONT_BAND = 1000;

/**
 * The highest z-index visible in a scene's piece sources.
 *
 * Read from the SOURCE because this runs server-side during an edit and there
 * is no browser. Incomplete by nature — see FRONT_BAND — so it is used only to
 * RAISE the band, never to set the layer on its own. A regex is enough for
 * that: matching a number inside a comment or a string is harmless when the
 * only use is "at least this high".
 */
const highestZIndex = (bodies: string[]): number => {
  let max = 0;
  for (const body of bodies) {
    for (const m of body.matchAll(zIndexInBody)) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return max;
};

export interface ReorderElementInput {
  genDir: string;
  sceneIndex: number;
  pieceId: string;
  to: "front" | "back";
}
export interface ReorderElementResult {
  ok: boolean;
  code?: string;
  error?: string;
}

export const reorderElement = async (
  input: ReorderElementInput,
): Promise<ReorderElementResult> => {
  const { genDir, sceneIndex, pieceId, to } = input;

  return withGenDirLock(genDir, async () => {
    const manifest = await readManifest(genDir);
    const scene = manifest.scenes.find((s) => s.sceneIndex === sceneIndex);
    if (!scene) return { ok: false, error: `scene ${sceneIndex} not found` };
    if (!scene.pieces.some((p) => p.id === pieceId)) {
      return { ok: false, error: `piece "${pieceId}" not found in scene ${sceneIndex}` };
    }

    const slot = pieceSlot(pieceId);
    const at = scene.template.indexOf(slot);
    if (at < 0) return { ok: false, error: `piece "${pieceId}" has no slot in this scene` };

    // Where the other slots live, so the marker can be re-inserted outside all
    // of them rather than at an arbitrary character offset.
    const others = scene.pieces
      .filter((p) => p.id !== pieceId)
      .map((p) => ({ id: p.id, at: scene.template.indexOf(pieceSlot(p.id)) }))
      .filter((p) => p.at >= 0);
    if (others.length === 0) return { ok: true }; // a lone element is already both

    const without = scene.template.slice(0, at) + scene.template.slice(at + slot.length);

    // Each surviving marker's START and END, kept together as one record.
    //
    // These were two parallel arrays, and the ends were derived by indexing the
    // piece list with the position list's index — which stops lining up the
    // moment any piece has no marker, because the positions were filtered and
    // the piece list was not. The wrong marker's length then landed the
    // insertion point INSIDE another marker, nesting one comment in another, and
    // the reassembler emitted neither: the element silently disappeared from the
    // slide. Unit fixtures never caught it because every piece had a slot.
    const spans = others
      .map((p) => {
        const s = pieceSlot(p.id);
        const i = without.indexOf(s);
        return i >= 0 ? { start: i, end: i + s.length } : null;
      })
      .filter((v): v is { start: number; end: number } => v !== null);
    if (spans.length === 0) return { ok: true };

    const insertAt =
      to === "back"
        ? Math.min(...spans.map((s) => s.start))
        : Math.max(...spans.map((s) => s.end));

    const snapshot = await readManifest(genDir);
    scene.template = without.slice(0, insertAt) + slot + without.slice(insertAt);

    // The half that actually moves pixels. Read every OTHER piece's baked-in
    // z-index and step outside the range: front clears the highest, back goes
    // under the lowest. The moved piece's own z-indexes are excluded — it is
    // being wrapped, so its internals stack inside the new layer and cannot
    // compete with it.
    const decomposed = await readDecomposed(genDir);
    const otherBodies = (decomposed.scenes.find((s) => s.sceneIndex === sceneIndex)?.pieces ?? [])
      .filter((p) => p.id !== pieceId)
      .map((p) => p.body);
    const max = highestZIndex(otherBodies);
    const target = scene.pieces.find((p) => p.id === pieceId)!;
    // Existing layers count too, or a second "bring to front" would land level
    // with the first one and paint order would fall back to document order.
    const layers = scene.pieces
      .filter((p) => p.id !== pieceId && typeof p.layer === "number")
      .map((p) => p.layer as number);
    //
    // "Back" clamps at ZERO rather than going negative, and that is a safety
    // decision, not a rounding one. The Section root is `position: absolute`
    // with `z-index: auto`, so it does NOT establish a stacking context — a
    // child at z-index -1 would escape it and paint behind the slide's own
    // background, which reads as "send to back deleted my element". Zero puts
    // the piece under everything with a positive z-index, and the slot move
    // above orders it against the pieces that have none. That is the whole of
    // what "back" means here, without the disappearing act.
    target.layer = to === "front" ? Math.max(FRONT_BAND, max, ...layers) + 1 : 0;

    const undo = await captureUndo(genDir);
    try {
      await writeManifest(genDir, manifest);
      const res = await commit(genDir);
      if (!res.ok) {
        await writeManifest(genDir, snapshot);
        return { ok: false, error: res.error };
      }

      // SAFETY NET — the reassembled render must still contain every piece.
      //
      // Moving a marker is only ever meant to change paint order, but on some
      // decks a moved marker did not survive reassembly, the render came back a
      // piece short, and the next commit re-derived the manifest from that
      // render — so a cosmetic click permanently deleted an element. The trigger
      // is template-shaped and not fully characterised, so rather than trust the
      // edit, the result is checked and rolled back when anything went missing.
      // Refusing to reorder is a small annoyance; losing the user's element is
      // not recoverable from the UI.
      const dropped = scene.pieces
        .map((p) => p.id)
        .filter((id) => !(res.code ?? "").includes(`id="${id}"`));
      if (dropped.length > 0) {
        await writeManifest(genDir, snapshot);
        await commit(genDir); // put the previous render back on disk
        return {
          ok: false,
          code: "would-drop",
          error: `couldn't reorder without losing ${dropped.join(", ")} — nothing was changed`,
        };
      }

      await commitUndo(genDir, undo, to === "front" ? "bring to front" : "send to back");
      return { ok: true, code: res.code };
    } catch (e) {
      await writeManifest(genDir, snapshot).catch(() => {});
      return { ok: false, error: `reorder failed: ${msg(e)}` };
    }
    // Store reads outside the inner try blocks — see moveElement.
  }).catch((e) => ({ ok: false, error: storeErrorMessage(e) }));
};

// ── resize ──────────────────────────────────────────────────────────────────
// A piece's box lives as literal `left/top/width/height` on the outermost
// positioned wrapper its body opens with — the shape BOTH the inserted primitives
// (lib/edit/insert-element.ts) and the cast assembler (assemble.ts emitPiece)
// emit. Resizing rewrites those literals in place. Bodies that don't open with
// such a wrapper (freeform design-agent markup) are rejected with a clear reason
// rather than silently resizing some inner decorative div.

/**
 * Locate the body's FIRST element when it is a positioned wrapper, returning the
 * span of its style object so we only ever rewrite the piece's own box.
 *
 * Brace-COUNTING rather than a regex, because the regex it replaced used
 * `[^{}]*` to bound the style object and therefore gave up on any style
 * containing a template literal — `background: \`radial-gradient(… ${PALETTE.x})\``
 * is extremely common in generated pieces, and every one of them was reported as
 * "not a positioned box" despite being exactly that. Measured on a real deck:
 * only 1 of 4 pieces could be resized before this.
 */
const findWrapperStyle = (
  body: string,
): { start: number; end: number; style: string } | null => {
  const open = body.match(/^\s*<div[^>]*?style=\{\{/);
  if (!open) return null;
  const start = open[0].length; // first char INSIDE the style object
  let depth = 1; // we are inside the outer `{` of `{{`
  for (let i = start; i < body.length; i++) {
    const c = body[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        const style = body.slice(start, i);
        // The wrapper must actually be positioned; anything else is inner markup.
        return /position:\s*"absolute"/.test(style) ? { start, end: i, style } : null;
      }
    }
  }
  return null;
};

/**
 * Drop the offsets that move a positioned box away from its own left/top.
 *
 * Only the centring idioms are touched — negative margins paired with a
 * self-referential size, and a translate that shifts by a percentage of the box.
 * A transform doing anything else (rotate, scale) is left alone, since it is
 * styling rather than placement.
 */
const clearCenteringOffsets = (style: string): string =>
  style
    .replace(/\bmarginLeft:\s*(-?[0-9.]+|"[^"]*"),?\s*/g, "")
    .replace(/\bmarginTop:\s*(-?[0-9.]+|"[^"]*"),?\s*/g, "")
    .replace(/\btransform:\s*"translate\(-?50%,\s*-?50%\)",?\s*/g, "");

/**
 * Set a CSS length on a flat style object.
 *
 * Replaces the WHOLE value whatever form it takes — bare number, `"62%"`,
 * `"200px"` — and inserts the key when it is absent. The previous version only
 * matched bare numbers, so a wrapper positioned in percentages (`left: "62%"`)
 * was rewritten to... nothing: resize reported success and the element did not
 * move. A silent no-op is worse than a refusal, so `resizeElement` now verifies
 * the write actually landed.
 */
const setStyleLength = (style: string, key: string, value: number): string => {
  // value forms: "…" | `…` | 123 | -1.5
  const rx = new RegExp(`(\\b${key}:\\s*)("[^"]*"|\`[^\`]*\`|-?[0-9.]+)`);
  if (rx.test(style)) return style.replace(rx, `$1${value}`);
  // Absent — introduce it next to the anchor that proves this is the box.
  return style.replace(/(position:\s*"absolute",?)/, `$1 ${key}: ${value},`);
};

export interface ResizeElementInput {
  genDir: string;
  sceneIndex: number;
  pieceId: string;
  /** The new box in absolute canvas px (what the user dragged the handles to). */
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface ResizeElementResult {
  ok: boolean;
  code?: string;
  error?: string;
}

export const resizeElement = async (input: ResizeElementInput): Promise<ResizeElementResult> => {
  const { genDir, sceneIndex, pieceId, x, y, w, h } = input;
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) {
    return { ok: false, error: "resize needs finite bounds with positive width and height" };
  }

  return withGenDirLock(genDir, async () => {
    const d = await readDecomposed(genDir);
    const scene = d.scenes.find((s) => s.sceneIndex === sceneIndex);
    const piece = scene?.pieces.find((p) => p.id === pieceId);
    if (!piece) return { ok: false, error: `piece "${pieceId}" not found in scene ${sceneIndex}` };

    const wrapper = findWrapperStyle(piece.body);
    if (!wrapper) {
      // Genuinely not a single positioned box — a bare component, or a fragment
      // of siblings each positioned in the SECTION's coordinate space. Wrapping
      // those would re-base their absolute coordinates and scatter them, so the
      // caller is told to regenerate at the new size instead. `code` is machine
      // readable so the editor can offer that without string-matching.
      return {
        ok: false,
        code: "no-wrapper",
        error:
          "this element isn't a single positioned box, so it can't be resized directly — regenerating it at the new size instead",
      };
    }

    // The rendered position already includes any persisted move offset, and the
    // caller sends absolute bounds — so bake the new origin into the body and clear
    // the offset, otherwise the two would stack and the piece would jump.
    const manifest = await readManifest(genDir);
    const meta = manifest.scenes.find((s) => s.sceneIndex === sceneIndex)?.pieces.find((p) => p.id === pieceId);
    const hadOffset = !!meta?.offset;

    let style = wrapper.style;
    // Neutralise anything that shifts the box away from its own left/top.
    // Generated pieces centre themselves with negative margins or a
    // translate(-50%, -50%); once the user has dragged an explicit box, those
    // offsets are stale and would drop the element somewhere it wasn't put —
    // the CSS analogue of the persisted move offset cleared just below.
    style = clearCenteringOffsets(style);
    style = setStyleLength(style, "left", Math.round(x));
    style = setStyleLength(style, "top", Math.round(y));
    style = setStyleLength(style, "width", Math.round(w));
    // Only when it already exists: text wrappers flow-size on maxWidth, but
    // introducing one on a box that never had it can clamp unrelated content.
    if (/\bmaxWidth:/.test(style)) style = setStyleLength(style, "maxWidth", Math.round(w));
    style = setStyleLength(style, "height", Math.round(h));

    // A rewrite that changed nothing means the box is expressed in a form this
    // does not understand. Report that rather than "resized" — a silent no-op
    // sends the user back to drag the handles again and again.
    if (style === wrapper.style) {
      return {
        ok: false,
        code: "no-wrapper",
        error: "this element's box could not be rewritten — regenerating it at the new size instead",
      };
    }

    const newBody = piece.body.slice(0, wrapper.start) + style + piece.body.slice(wrapper.end);

    const snapshot = await readManifest(genDir);
    const undo = await captureUndo(genDir);
    try {
      await writePieceBody(genDir, pieceId, newBody);
      if (hadOffset && meta) {
        delete meta.offset;
        await writeManifest(genDir, manifest);
      }
      const res = await commit(genDir);
      if (!res.ok) {
        await writePieceBody(genDir, pieceId, piece.body);
        if (hadOffset) await writeManifest(genDir, snapshot);
        return { ok: false, error: res.error };
      }
      await commitUndo(genDir, undo, "resize");
      return { ok: true, code: res.code };
    } catch (e) {
      await writePieceBody(genDir, pieceId, piece.body).catch(() => {});
      if (hadOffset) await writeManifest(genDir, snapshot).catch(() => {});
      return { ok: false, error: `resize failed: ${msg(e)}` };
    }
    // Store reads outside the inner try blocks — see moveElement.
  }).catch((e) => ({ ok: false, error: storeErrorMessage(e) }));
};
