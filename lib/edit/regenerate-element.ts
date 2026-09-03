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
import { readDocumentBrand } from "../brand/document-brand";
import { brandPromptBlock } from "../brand/brand-prompt";
import path from "path";
import { readDecomposed, writePieceBody, captureUndo, commitUndo } from "../agents/lego-store";
import { commitGenDir } from "./commit";
import { regeneratePiece } from "../agents/regenerate-piece";
import { withGenDirLock } from "./gendir-lock";
import { findChildInScene, spliceChildBody, blockAsPiece } from "./nested-piece";
import type { DecomposedPiece } from "../agents/lego-decompose";
import { recordUsage, type Usage } from "../usage";
import { withSpend } from "../spend/context";
import { MODELS } from "../anthropic";

export interface RegenerateElementInput {
  genDir: string;
  sceneIndex: number;
  pieceId: string;
  instruction?: string;
  /** "animate" (2026-09-03): the same one-piece op with the model told to
   *  change ONLY the element's motion — its own ledger op, spend stage, undo
   *  label and provenance field, so the two kinds of edit stay distinguishable
   *  everywhere they are counted. */
  mode?: "regenerate" | "animate";
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
  const animate = input.mode === "animate";
  const scriptId = path.basename(genDir);

  // Every LLM regen lands in .data/usage.jsonl — editor regens were previously
  // invisible to the cost ledger (found reconciling against live z.ai billing).
  const logUsage = (usage: Usage | undefined, failed: boolean) => {
    if (usage) {
      void recordUsage({
        op: animate ? "animate-element" : "regen-element",
        model: MODELS.codingAgentBuild,
        scriptId,
        usage,
        ...(failed ? { failed: true } : {}),
      });
    }
  };

  // Serialize with any other edit to the same video (move/delete/regen) so their
  // read-modify-write of manifest + Composition.tsx cannot interleave.
  return withSpend({ stage: animate ? "edit.animate" : "edit.regen", scriptId }, () =>
  withGenDirLock(genDir, async () => {
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

  // The user's brand rules + materials, so a regenerated element comes out
  // on-brand instead of merely matching the old design system.
  const brandBlock = brandPromptBlock(await readDocumentBrand(genDir));
  const regen = await regeneratePiece({
    brandBlock,
    preamble: d.preamble,
    piece: regenTarget,
    siblings,
    sceneIndex,
    instruction,
    mode: input.mode,
  });
  if (!regen.ok || !regen.body) {
    logUsage(regen.usage, true); // failed attempts are still billed
    return { ok: false, usage: regen.usage, error: regen.error || (animate ? "animation failed" : "regeneration failed") };
  }
  const newBody = makeBody(regen.body);

  // Through the SHARED write barrier (commitGenDir), not around it.
  //
  // This path used to reassemble, finalize, compile-check and write
  // Composition.tsx itself — the same sequence commit.ts exists to own, minus
  // its RENDER check. That omission was backwards: commit.ts turns the render
  // check on precisely for "ops that write NEW COMPONENT CODE, because a model
  // wrote it and it can reference something that does not exist", and
  // regeneration is the op where a model writes the code. So the one op most
  // able to produce a scene that parses and renders `undefined` was the one op
  // not checked for it, and the result went straight to disk.
  //
  // The store is mutated first and rolled back byte-exact on refusal, which is
  // the contract every other caller of commitGenDir already follows.
  const priorBody = (
    await readDecomposed(genDir)
  ).scenes.find((s) => s.sceneIndex === sceneIndex)?.pieces.find((p) => p.id === writeId)?.body;

  const undo = await captureUndo(genDir);
  await writePieceBody(genDir, writeId, newBody);
  const commit = await commitGenDir(genDir, animate ? "animated element" : "regenerated element", { checkRender: true });
  if (!commit.ok) {
    if (priorBody !== undefined) await writePieceBody(genDir, writeId, priorBody);
    logUsage(regen.usage, true); // failed attempts are still billed
    return { ok: false, usage: regen.usage, error: commit.error ?? (animate ? "animation failed" : "regeneration failed") };
  }
  await commitUndo(genDir, undo, animate ? "animate" : "regenerate");

  logUsage(regen.usage, false);
  return { ok: true, code: commit.code, body: regen.body, usage: regen.usage };
  }),
  );
};
