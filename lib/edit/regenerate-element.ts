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

  const d = await readDecomposed(genDir);
  const scene = d.scenes.find((s) => s.sceneIndex === sceneIndex);
  if (!scene) return { ok: false, error: `scene ${sceneIndex} not found` };
  const piece = scene.pieces.find((p) => p.id === pieceId);
  if (!piece) return { ok: false, error: `piece "${pieceId}" not found in scene ${sceneIndex}` };
  const siblings = scene.pieces.filter((p) => p.id !== pieceId);

  const regen = await regeneratePiece({
    preamble: d.preamble,
    piece,
    siblings,
    sceneIndex,
    instruction,
  });
  if (!regen.ok || !regen.body) {
    return { ok: false, usage: regen.usage, error: regen.error || "regeneration failed" };
  }
  const newBody = regen.body;

  // Reassemble the FULL composition, overriding ONLY this piece's body; every
  // sibling re-inlines byte-identically from its own file.
  const reassembled = await reassembleFromDisk(genDir, (si, p) =>
    si === sceneIndex && p.id === pieceId ? newBody : p.body,
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
  await writePieceBody(genDir, pieceId, newBody);
  await fs.writeFile(path.join(genDir, "Composition.tsx"), candidate, "utf8");

  return { ok: true, code: candidate, body: newBody, usage: regen.usage };
};
