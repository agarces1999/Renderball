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
import { decompose, reassemble, pieceCount, type Decomposed, type DecomposedPiece } from "./lego-decompose";

const LEGO_DIR = "lego";

interface PieceMeta {
  id: string;
  kind: string;
  throughline?: string;
  openTag: string;
  file: string; // relative to genDir/lego/
}
interface SceneMeta {
  sceneIndex: number;
  template: string;
  pieces: PieceMeta[];
}
interface Manifest {
  preamble: string;
  tail: string;
  scenes: SceneMeta[];
}

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
  const manifest: Manifest = JSON.parse(await fs.readFile(path.join(legoDir, "manifest.json"), "utf8"));
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
 * Reassemble the Composition.tsx from the on-disk lego artifacts, applying optional
 * per-piece body edits. The basis for the M2/M3 edit + regenerate + move flows —
 * with no edits it reproduces the byte-identical original.
 */
export const reassembleFromDisk = async (
  genDir: string,
  bodyOf?: (sceneIndex: number, piece: DecomposedPiece) => string,
): Promise<string> => {
  const d = await readDecomposed(genDir);
  return reassemble(d, bodyOf);
};
