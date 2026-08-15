//
// Nesting / drill-in helpers. A composite piece (e.g. a card panel) can contain
// child <Piece> markers inside its body. The decomposer keeps those children
// verbatim in the parent's body (balanced matching), so a drill-in edit is a splice
// WITHIN the parent's body — the parent piece file is the only thing rewritten, and
// every OTHER top-level piece stays byte-identical. Regenerate/delete a child reuse
// the top-level machinery (regeneratePiece, reassemble, finalize) with the parent
// body overridden.
//
import { CLOSE_TAG, listPieceBlocks, type PieceBlock, type DecomposedPiece, type DecomposedScene } from "../agents/lego-decompose";

export interface ChildResolution {
  parent: DecomposedPiece;
  child: PieceBlock;
  /** the parent's OTHER child pieces — read-only context for a regen */
  siblings: PieceBlock[];
}

/** Find a child piece by id inside any top-level piece of the scene. */
export const findChildInScene = (
  scene: DecomposedScene,
  childId: string,
): ChildResolution | null => {
  for (const parent of scene.pieces) {
    if (!parent.body.includes(`id="${childId}"`)) continue; // fast reject
    const blocks = listPieceBlocks(parent.body);
    const child = blocks.find((b) => b.id === childId);
    if (child) return { parent, child, siblings: blocks.filter((b) => b.id !== childId) };
  }
  return null;
};

/** Replace a child's inner body inside the parent body (keeps its <Piece> wrapper). */
export const spliceChildBody = (parentBody: string, child: PieceBlock, newInner: string): string =>
  parentBody.slice(0, child.start) + child.openTag + newInner + CLOSE_TAG + parentBody.slice(child.end);

/** Remove a child's entire <Piece> block from the parent body (drill-in delete). */
export const removeChildBlock = (parentBody: string, child: PieceBlock): string =>
  parentBody.slice(0, child.start) + parentBody.slice(child.end);

/** A PieceBlock adapted to the regeneratePiece input shape (a child regen reuses the
 *  same one-element prompt; siblings are the parent's other children). */
export const blockAsPiece = (b: PieceBlock): DecomposedPiece => ({
  id: b.id,
  kind: b.kind,
  throughline: b.throughline,
  openTag: b.openTag,
  body: b.body,
});

/**
 * A child rendered from an ARRAY, not written out literally.
 *
 * Compositions emit repeated cards as `{ARR.map((item, i) => <Piece
 * id={`s2.products.${i}`} …>)}`, so the DOM carries `data-piece="s2.products.0"`
 * while the SOURCE never contains that string. findChildInScene matches the
 * literal `id="…"` and therefore missed every one of them: the founder
 * selected a product card, pressed Delete, and got `piece "s2.products.0" not
 * found in scene 2` (2026-08-14). Every list, grid and table row in the
 * product was selectable and not editable.
 *
 * Deleting the matched <Piece> BLOCK would be wrong — it is the template for
 * the whole list, so removing it removes all five cards. The item is data, so
 * the deletion belongs to the data: filter the mapped expression.
 *
 * Chaining is correct by construction. The filter is inserted immediately
 * before `.map(`, so a second delete filters the OUTPUT of the first — which
 * is exactly what the user is looking at when they pick "the second one".
 */
export interface MappedChild {
  parent: DecomposedPiece;
  /** offset of `.map(` within the parent body */
  mapAt: number;
  /** index within the CURRENTLY rendered list */
  index: number;
}

export const findMappedChildInScene = (
  scene: DecomposedScene,
  childId: string,
): MappedChild | null => {
  const m = /^(.*)\.(\d+)$/.exec(childId);
  if (!m) return null;
  const [, prefix, idxRaw] = m;
  const index = Number(idxRaw);
  if (!Number.isInteger(index) || index < 0) return null;
  // The exact template head the composition emits for this family.
  const needle = "id={`" + prefix + ".${";
  for (const parent of scene.pieces) {
    const at = parent.body.indexOf(needle);
    if (at < 0) continue;
    const mapAt = parent.body.lastIndexOf(".map(", at);
    if (mapAt < 0) continue;
    return { parent, mapAt, index };
  }
  return null;
};

/** Insert the index-dropping filter immediately before the `.map(` call. */
export const dropMappedIndex = (parentBody: string, mapAt: number, index: number): string =>
  parentBody.slice(0, mapAt) +
  `.filter((_rbItem, _rbIdx) => _rbIdx !== ${index})` +
  parentBody.slice(mapAt);
