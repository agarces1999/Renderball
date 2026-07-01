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
