//
// On-disk store for the LEGO editable artifacts (M1 wire-in). After a build, the
// decomposer splits genDir/Composition.tsx into per-file pieces + a manifest under
// genDir/lego/, so the editor can read/edit/regenerate one piece at a time. The
// rendered Composition.tsx stays the canonical render source; an edit reassembles
// from these artifacts and overwrites it.
//
//   genDir/lego/manifest.json          { preamble, tail, scenes:[{sceneIndex,
//                                         template, pieces:[{id,kind,throughline?,
//                                         openTag, file}]}] }
//   genDir/lego/pieces/<id>.tsx        each piece's body (the editable unit)
//
// decomposeGenDir only writes if the decompose -> reassemble round trip is
// byte-identical (it always is for agent output, but the guard makes a hand-edited
// or unusual composition fall back to "not piece-editable" rather than corrupt it).
//
import { promises as fs } from "fs";
import path from "path";
import { decompose, reassemble, pieceCount, pieceSlot, type Decomposed, type DecomposedPiece } from "./lego-decompose";

const LEGO_DIR = "lego";

/** A persistent per-piece move (M3 reposition). Applied at reassemble time as a
 *  section-filling translate layer, so the piece body stays position-pure and a
 *  later regenerate keeps the piece where the user dragged it. */
export interface PieceOffset {
  dx: number;
  dy: number;
}
export interface PieceMeta {
  id: string;
  kind: string;
  throughline?: string;
  openTag: string;
  file: string; // relative to genDir/lego/
  offset?: PieceOffset;
}
export interface SceneMeta {
  sceneIndex: number;
  template: string;
  pieces: PieceMeta[];
}
export interface Manifest {
  preamble: string;
  tail: string;
  scenes: SceneMeta[];
}

const manifestPath = (genDir: string): string =>
  path.join(genDir, LEGO_DIR, "manifest.json");

export const readManifest = async (genDir: string): Promise<Manifest> =>
  JSON.parse(await fs.readFile(manifestPath(genDir), "utf8"));

export const writeManifest = async (genDir: string, m: Manifest): Promise<void> =>
  fs.writeFile(manifestPath(genDir), JSON.stringify(m, null, 2), "utf8");

/**
 * Wrap a piece body in a Section-sized absolute layer whose ORIGIN is shifted by
 * (dx, dy). The box is `left: dx; top: dy; right: -dx; bottom: -dy`, so it stays the
 * exact size of the Section (children keep both pixel `left: 96` and percentage
 * `left: "50%"` positions) but its content origin moves by (dx, dy) — shifting the
 * whole group.
 *
 * Deliberately NO `transform`: a transform would establish a new stacking context,
 * trapping the moved piece's children's z-index locally and flipping their paint
 * order against untouched sibling pieces (pieces render as Fragments and share the
 * Section's single stacking context, where cross-piece zIndex is load-bearing). An
 * absolutely-positioned wrapper with `z-index: auto` establishes a containing block
 * WITHOUT a stacking context, so descendant z-index still competes globally — the
 * move stays a pure visual offset with zero effect on any sibling piece.
 */
const wrapOffset = (body: string, off: PieceOffset): string =>
  `<div style={{ position: "absolute", left: ${off.dx}, top: ${off.dy}, right: ${-off.dx}, bottom: ${-off.dy} }}>${body}</div>`;

export const writeDecomposed = async (genDir: string, d: Decomposed): Promise<void> => {
  const legoDir = path.join(genDir, LEGO_DIR);
  await fs.rm(legoDir, { recursive: true, force: true });
  await fs.mkdir(path.join(legoDir, "pieces"), { recursive: true });

  const scenes: SceneMeta[] = [];
  for (const s of d.scenes) {
    const pieces: PieceMeta[] = [];
    for (const p of s.pieces) {
      const file = path.posix.join("pieces", `${p.id}.tsx`);
      await fs.writeFile(path.join(legoDir, file), p.body, "utf8"); // body VERBATIM (byte-exact)
      pieces.push({ id: p.id, kind: p.kind, throughline: p.throughline, openTag: p.openTag, file });
    }
    scenes.push({ sceneIndex: s.sceneIndex, template: s.template, pieces });
  }

  const manifest: Manifest = { preamble: d.preamble, tail: d.tail, scenes };
  await fs.writeFile(path.join(legoDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
};

export const readDecomposed = async (genDir: string): Promise<Decomposed> => {
  const legoDir = path.join(genDir, LEGO_DIR);
  const manifest = await readManifest(genDir);
  const scenes = await Promise.all(
    manifest.scenes.map(async (s) => ({
      sceneIndex: s.sceneIndex,
      template: s.template,
      pieces: await Promise.all(
        s.pieces.map(async (pm): Promise<DecomposedPiece> => ({
          id: pm.id,
          kind: pm.kind,
          throughline: pm.throughline,
          openTag: pm.openTag,
          body: await fs.readFile(path.join(legoDir, pm.file), "utf8"),
        })),
      ),
    })),
  );
  return { preamble: manifest.preamble, tail: manifest.tail, scenes };
};

/**
 * Decompose genDir/Composition.tsx to the lego artifacts. Best-effort: only writes
 * when the round trip is byte-identical, so it can never corrupt the render source.
 * Returns a small report for logging.
 */
export const decomposeGenDir = async (
  genDir: string,
): Promise<{ ok: boolean; pieces: number; reason?: string }> => {
  let code: string;
  try {
    code = await fs.readFile(path.join(genDir, "Composition.tsx"), "utf8");
  } catch {
    return { ok: false, pieces: 0, reason: "no Composition.tsx" };
  }
  const d = decompose(code);
  if (pieceCount(d) === 0) return { ok: false, pieces: 0, reason: "no <Piece> markers" };
  if (reassemble(d) !== code) return { ok: false, pieces: 0, reason: "round-trip mismatch — not decomposed" };
  await writeDecomposed(genDir, d);
  return { ok: true, pieces: pieceCount(d) };
};

/**
 * Overwrite ONE piece's body file in place (M2 regenerate / text edit). Finds the
 * piece by id across scenes via the manifest, writes the new body to its file. The
 * next readDecomposed/reassembleFromDisk picks it up; every sibling file is
 * untouched, so the zero-neighbor guarantee holds as a filesystem fact. Returns
 * false if the id isn't in the manifest.
 */
export const writePieceBody = async (
  genDir: string,
  pieceId: string,
  body: string,
): Promise<boolean> => {
  const legoDir = path.join(genDir, LEGO_DIR);
  const manifest: Manifest = JSON.parse(await fs.readFile(path.join(legoDir, "manifest.json"), "utf8"));
  for (const s of manifest.scenes) {
    const pm = s.pieces.find((p) => p.id === pieceId);
    if (pm) {
      await fs.writeFile(path.join(legoDir, pm.file), body, "utf8");
      return true;
    }
  }
  return false;
};

/**
 * Reassemble the Composition.tsx from the on-disk lego artifacts, applying optional
 * per-piece body edits. The basis for the M2/M3 edit + regenerate + move flows —
 * with no edits it reproduces the byte-identical original.
 */
export const reassembleFromDisk = async (
  genDir: string,
  bodyOf?: (sceneIndex: number, piece: DecomposedPiece) => string,
): Promise<string> => {
  const manifest = await readManifest(genDir);
  const offsets = new Map<string, PieceOffset>();
  for (const s of manifest.scenes)
    for (const p of s.pieces) if (p.offset) offsets.set(`${s.sceneIndex}:${p.id}`, p.offset);

  const d = await readDecomposed(genDir);
  // Apply the caller's body override first, THEN the persistent move offset, so a
  // regenerated-and-moved piece keeps both. Every piece with no offset is untouched.
  return reassemble(d, (si, p) => {
    const base = bodyOf ? bodyOf(si, p) : p.body;
    const off = offsets.get(`${si}:${p.id}`);
    return off ? wrapOffset(base, off) : base;
  });
};

/**
 * Set (absolute) a piece's persistent move offset in the manifest. Returns false
 * if the id isn't in that scene. The reassembler applies it on every render; the
 * body file is never touched, so the move survives a later regenerate.
 */
export const setPieceOffset = async (
  genDir: string,
  sceneIndex: number,
  pieceId: string,
  offset: PieceOffset,
): Promise<boolean> => {
  const manifest = await readManifest(genDir);
  const scene = manifest.scenes.find((s) => s.sceneIndex === sceneIndex);
  const piece = scene?.pieces.find((p) => p.id === pieceId);
  if (!piece) return false;
  piece.offset = offset;
  await writeManifest(genDir, manifest);
  return true;
};

/**
 * Delete a piece (M3): drop it from the scene's pieces, strip its template slot so
 * the reassembler emits nothing for it, and remove its body file. Because pieces are
 * self-positioned and independent, no sibling reflows — the deleted element simply
 * vanishes. Returns false if the id isn't in that scene.
 */
export const removePieceFromDisk = async (
  genDir: string,
  sceneIndex: number,
  pieceId: string,
): Promise<boolean> => {
  const r = await removePieceFromManifest(genDir, sceneIndex, pieceId);
  if (!r.ok) return false;
  await fs.rm(r.file!, { force: true });
  return true;
};

/**
 * Remove a piece from the manifest (drop from scene.pieces + strip its template
 * slot) WITHOUT deleting the body file. Returns the absolute path of the now-orphan
 * body file so the caller can rm it AFTER a successful commit — deferring the
 * irreversible file delete lets deleteElement roll back cleanly if the reassembled
 * composition fails to compile.
 */
export const removePieceFromManifest = async (
  genDir: string,
  sceneIndex: number,
  pieceId: string,
): Promise<{ ok: boolean; file?: string }> => {
  const manifest = await readManifest(genDir);
  const scene = manifest.scenes.find((s) => s.sceneIndex === sceneIndex);
  if (!scene) return { ok: false };
  const idx = scene.pieces.findIndex((p) => p.id === pieceId);
  if (idx < 0) return { ok: false };

  const [pm] = scene.pieces.splice(idx, 1);
  scene.template = scene.template.replace(pieceSlot(pieceId), "");
  await writeManifest(genDir, manifest);
  return { ok: true, file: path.join(genDir, LEGO_DIR, pm.file) };
};
