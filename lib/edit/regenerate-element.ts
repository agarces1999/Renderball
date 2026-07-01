//
// M2 orchestrator — regenerate ONE element of a rendered video, in place.
//
// Flow: read the decomposed scene → hand the target piece + its frozen design
// system + its read-only siblings to the LLM (regeneratePiece) → reassemble the
// FULL Composition with the new body overriding ONLY this piece → compile-check
// the whole file → persist exactly one piece file + the Composition.tsx.
//
// The zero-neighbor guarantee is structural: reassembleFromDisk overrides this one
// piece's body and re-inlines every sibling byte-for-byte from its own file, so the
// only source difference between before and after is this element's JSX. If the
// regeneration doesn't compile, nothing is written — the store + render source stay
// exactly as they were.
//
import { promises as fs } from "fs";
import path from "path";
import { readDecomposed, writePieceBody, reassembleFromDisk } from "../agents/lego-store";
import { regeneratePiece } from "../agents/regenerate-piece";
import { finalizeUndefinedRefs } from "../agents/finalize-refs";
import { verifyCompilable } from "../agents/code-extraction";
import { withGenDirLock } from "./gendir-lock";
import { findChildInScene, spliceChildBody, blockAsPiece } from "./nested-piece";
import type { DecomposedPiece } from "../agents/lego-decompose";
import type { Usage } from "../usage";

export interface RegenerateElementInput {
  genDir: string;
  sceneIndex: number;
  pieceId: string;
  instruction?: string;
}
export interface RegenerateElementResult {
  ok: boolean;
  code?: string;
  body?: string;
  usage?: Usage;
  error?: string;
}

export const regenerateElement = async (
  input: RegenerateElementInput,
): Promise<RegenerateElementResult> => {
  const { genDir, sceneIndex, pieceId, instruction } = input;

  // Serialize with any other edit to the same video (move/delete/regen) so their
  // read-modify-write of manifest + Composition.tsx cannot interleave.
  return withGenDirLock(genDir, async () => {
  const d = await readDecomposed(genDir);
  const scene = d.scenes.find((s) => s.sceneIndex === sceneIndex);
  if (!scene) return { ok: false, error: `scene ${sceneIndex} not found` };

  // Route: a top-level piece regenerates directly; a nested child (a <Piece> inside
  // a composite's body — e.g. one card in a panel) regenerates against its sibling
  // children and is spliced back into the PARENT's body, so the parent piece file is
  // the only thing rewritten. `writeId` is whichever piece file gets persisted.
  const top = scene.pieces.find((p) => p.id === pieceId);
  let regenTarget: DecomposedPiece;
  let siblings: DecomposedPiece[];
  let writeId: string;
  let makeBody: (regenBody: string) => string;

  if (top) {
    regenTarget = top;
    siblings = scene.pieces.filter((p) => p.id !== pieceId);
    writeId = pieceId;
    makeBody = (b) => b;
  } else {
    const nested = findChildInScene(scene, pieceId);
    if (!nested) return { ok: false, error: `piece "${pieceId}" not found in scene ${sceneIndex}` };
    regenTarget = blockAsPiece(nested.child);
    siblings = nested.siblings.map(blockAsPiece);
    writeId = nested.parent.id;
    makeBody = (b) => spliceChildBody(nested.parent.body, nested.child, b);
  }

  const regen = await regeneratePiece({
    preamble: d.preamble,
    piece: regenTarget,
    siblings,
    sceneIndex,
    instruction,
  });
  if (!regen.ok || !regen.body) {
    return { ok: false, usage: regen.usage, error: regen.error || "regeneration failed" };
  }
  const newBody = makeBody(regen.body);

  // Reassemble the FULL composition, overriding ONLY the written piece's body; every
  // sibling re-inlines byte-identically from its own file.
  const reassembled = await reassembleFromDisk(genDir, (si, p) =>
    si === sceneIndex && p.id === writeId ? newBody : p.body,
  );

  // Finalize the render source the same way the build does — a regen can reach for
  // a lucide icon it didn't import (<Camera/>) or an invented component; esbuild's
  // syntax check passes those through, so repair them before rendering. Idempotent,
  // and applied to the reassembled whole (imports/stubs live in the module scope).
  const fin = await finalizeUndefinedRefs(reassembled);
  const candidate = fin.code;

  const compileError = await verifyCompilable(candidate);
  if (compileError) {
    return { ok: false, usage: regen.usage, error: `regenerated element does not compile: ${compileError}` };
  }

  // Persist: the one piece file (edit sticks for future reads) + the finalized
  // Composition.tsx (the render source, with any added imports/stubs). The manifest
  // preamble stays as-authored; finalize re-applies on every reassemble, so it
  // self-heals across subsequent edits.
  await writePieceBody(genDir, writeId, newBody);
  await fs.writeFile(path.join(genDir, "Composition.tsx"), candidate, "utf8");

  return { ok: true, code: candidate, body: regen.body, usage: regen.usage };
  });
};
