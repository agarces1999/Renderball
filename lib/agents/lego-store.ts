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
  /**
   * Explicit stacking layer, set by "bring to front" / "send to back".
   *
   * Absent for almost every piece, and that is the point: slot order in the
   * scene template already decides paint order for anything without an explicit
   * z-index. But GENERATED pieces routinely carry one — five of eight in the
   * reference deck do — and an explicit z-index beats document order, so moving
   * the slot alone changed the manifest and nothing on screen. This is the
   * escape hatch for that case, applied by the reassembler so it survives a
   * regenerate exactly like `offset` does.
   */
  layer?: number;
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

/**
 * Read the piece manifest, DECOMPOSING first if it is not there yet.
 *
 * Every lego mutation — insert, move, delete, edit, page ops — funnels through
 * this read, which is why the heal lives here rather than at each call site.
 *
 * It exists because the manifest was only ever written by the build pipeline
 * (run-preview-build), regenerate-scene, and apply-brand. A blank document
 * created by `writeBlankDocument` had a perfectly good Composition.tsx with a
 * <Piece> in it and NO lego/ directory, so the first edit of any kind threw
 * `ENOENT ... lego/manifest.json` out of an API route with no try/catch —
 * an HTTP 500 on "draw a box and generate", which is the product's core move.
 *
 * Decomposition is derived, cheap, and safe to redo: `decomposeGenDir` only
 * writes when decompose → reassemble round-trips byte-identically, so it can
 * never corrupt the render source. Treating an absent manifest as "not built
 * yet" rather than as an error also repairs documents already on disk.
 */
export const readManifest = async (genDir: string): Promise<Manifest> => {
  try {
    return JSON.parse(await fs.readFile(manifestPath(genDir), "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    const rep = await decomposeGenDir(genDir);
    if (!rep.ok) {
      // Genuinely not editable (no composition, or no <Piece> markers). Say so
      // in words a route can hand to the user instead of leaking an fs errno.
      throw new Error(`this page has no editable elements yet (${rep.reason ?? "not decomposable"})`);
    }
    return JSON.parse(await fs.readFile(manifestPath(genDir), "utf8"));
  }
};

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

/**
 * Wrap a piece in a Section-sized layer with an explicit z-index.
 *
 * This one DOES establish a stacking context, unlike wrapOffset above, and that
 * is deliberate rather than an oversight: it makes the piece a single unit in
 * the stack, so its internals can no longer interleave with another piece's.
 * That is precisely what a user means by "send this to the back" — they mean
 * the whole thing, not most of it.
 *
 * Only pieces the user has explicitly reordered get one, so nothing else's
 * rendering changes.
 */
const wrapLayer = (body: string, layer: number): string =>
  `<div style={{ position: "absolute", inset: 0, zIndex: ${Math.round(layer)} }}>${body}</div>`;

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
  const layers = new Map<string, number>();
  for (const s of manifest.scenes)
    for (const p of s.pieces) {
      if (p.offset) offsets.set(`${s.sceneIndex}:${p.id}`, p.offset);
      if (typeof p.layer === "number") layers.set(`${s.sceneIndex}:${p.id}`, p.layer);
    }

  const d = await readDecomposed(genDir);
  // Caller's body override first, then the move offset, then the stacking layer
  // OUTERMOST — the layer has to wrap the offset, or the offset wrapper would
  // sit outside the stacking context and the z-index would apply to a box that
  // isn't the one being stacked. A regenerated, moved and reordered piece keeps
  // all three. Pieces with neither are untouched, byte for byte.
  return reassemble(d, (si, p) => {
    const key = `${si}:${p.id}`;
    let body = bodyOf ? bodyOf(si, p) : p.body;
    const off = offsets.get(key);
    if (off) body = wrapOffset(body, off);
    const layer = layers.get(key);
    if (typeof layer === "number") body = wrapLayer(body, layer);
    return body;
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

// ── undo ring ───────────────────────────────────────────────────────────────
// Every editor mutation is a read-modify-write over manifest.json + the piece
// files, so ONE snapshot of both restores any op (insert, move, resize, delete,
// regenerate, text/format) uniformly — no per-op inverse logic. Snapshots are
// captured BEFORE the mutation but only written AFTER it succeeds, so a failed
// op never leaves a no-op entry on the stack.

const UNDO_DIR = ".undo";
const UNDO_CAP = 25;

export interface UndoSnapshot {
  manifest: Manifest;
  /** filename (e.g. "s0.copy.tsx") → body. The whole pieces dir, so a snapshot
   *  restores adds AND deletes without knowing which happened. */
  pieces: Record<string, string>;
  /**
   * The pre-op Script, attached ONLY by ops that mutate the scene list (page
   * add/remove/move/duplicate — canvas pivot). Restoring a scene-count change
   * without the script would desync Section components from scenes, so these
   * snapshots carry it; element-level ops keep omitting it (their undo never
   * touches the script). Stored as the caller's Script object, JSON-ified.
   */
  script?: unknown;
}

const undoDir = (genDir: string): string => path.join(genDir, LEGO_DIR, UNDO_DIR);

const entryNames = async (genDir: string): Promise<string[]> => {
  const names = await fs.readdir(undoDir(genDir)).catch(() => [] as string[]);
  return names.filter((n) => n.endsWith(".json")).sort(); // zero-padded → lexical == chronological
};

/** Snapshot the current store. Cheap enough to take on every op (piece bodies are
 *  a few KB each) and taken before mutating so it captures the pre-edit state.
 *  Pass `script` ONLY from scene-structure ops (page ops) — see UndoSnapshot. */
export const captureUndo = async (
  genDir: string,
  script?: unknown,
): Promise<UndoSnapshot | null> => {
  try {
    const manifest = await readManifest(genDir);
    const dir = path.join(genDir, LEGO_DIR, "pieces");
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    const pieces: Record<string, string> = {};
    for (const n of names) {
      if (n.endsWith(".tsx")) pieces[n] = await fs.readFile(path.join(dir, n), "utf8");
    }
    return script === undefined ? { manifest, pieces } : { manifest, pieces, script };
  } catch {
    return null; // not decomposed / unreadable — undo simply isn't available
  }
};

/** Read the whole undo ring into memory (filename → raw JSON). Page ops rewrite
 *  the lego dir (which houses the ring), so they lift it out first and put it
 *  back after — structural edits stay undoable instead of clearing history. */
export const readUndoRing = async (genDir: string): Promise<Record<string, string>> => {
  const out: Record<string, string> = {};
  for (const name of await entryNames(genDir)) {
    try {
      out[name] = await fs.readFile(path.join(undoDir(genDir), name), "utf8");
    } catch {
      /* a torn entry is dropped rather than failing the op */
    }
  }
  return out;
};

/** Restore a ring previously read with readUndoRing (best-effort). */
export const restoreUndoRing = async (
  genDir: string,
  ring: Record<string, string>,
): Promise<void> => {
  try {
    await fs.mkdir(undoDir(genDir), { recursive: true });
    for (const [name, body] of Object.entries(ring)) {
      await fs.writeFile(path.join(undoDir(genDir), name), body, "utf8");
    }
  } catch {
    /* history is best-effort — never fail the op over it */
  }
};

/** Push a captured snapshot onto the ring (call only after the op succeeded). */
export const commitUndo = async (
  genDir: string,
  snapshot: UndoSnapshot | null,
  label: string,
): Promise<void> => {
  if (!snapshot) return;
  try {
    await fs.mkdir(undoDir(genDir), { recursive: true });
    const names = await entryNames(genDir);
    const nextIdx = names.length === 0 ? 1 : Number(names[names.length - 1].slice(0, 6)) + 1;
    const file = `${String(nextIdx).padStart(6, "0")}.json`;
    await fs.writeFile(
      path.join(undoDir(genDir), file),
      JSON.stringify({ label, ...snapshot }),
      "utf8",
    );
    // Prune oldest beyond the cap.
    const all = await entryNames(genDir);
    for (const stale of all.slice(0, Math.max(0, all.length - UNDO_CAP))) {
      await fs.rm(path.join(undoDir(genDir), stale), { force: true });
    }
  } catch {
    /* undo is best-effort — never fail the user's edit because history couldn't be written */
  }
};

export const undoDepth = async (genDir: string): Promise<number> => (await entryNames(genDir)).length;

/**
 * Restore the newest snapshot into the store (manifest + the whole pieces dir) and
 * pop it. Does NOT write Composition.tsx — the caller commits, so a restore that
 * somehow fails to compile can be rolled back like any other op.
 */
export const undoLast = async (
  genDir: string,
): Promise<{
  ok: boolean;
  label?: string;
  remaining?: number;
  /** Present when the snapshot carried a Script (page ops) — the caller must
   *  persist it so scenes and sections stay in lockstep. */
  script?: unknown;
  error?: string;
}> => {
  const names = await entryNames(genDir);
  if (names.length === 0) return { ok: false, error: "nothing to undo" };
  const file = path.join(undoDir(genDir), names[names.length - 1]);
  let snap: UndoSnapshot & { label?: string };
  try {
    snap = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    await fs.rm(file, { force: true });
    return { ok: false, error: "undo history entry was unreadable" };
  }
  const piecesDir = path.join(genDir, LEGO_DIR, "pieces");
  // Rewrite the pieces dir to exactly the snapshot's contents: added files vanish,
  // deleted files come back, edited bodies revert.
  await fs.rm(piecesDir, { recursive: true, force: true });
  await fs.mkdir(piecesDir, { recursive: true });
  for (const [name, body] of Object.entries(snap.pieces)) {
    await fs.writeFile(path.join(piecesDir, name), body, "utf8");
  }
  await writeManifest(genDir, snap.manifest);
  // Scene-structure snapshots (page ops) carry the Script — refresh the genDir
  // mirror here; the route persists it to the store of record.
  if (snap.script !== undefined) {
    await fs
      .writeFile(path.join(genDir, "script.json"), JSON.stringify(snap.script, null, 2), "utf8")
      .catch(() => {});
  }
  await fs.rm(file, { force: true });
  return { ok: true, label: snap.label, remaining: names.length - 1, script: snap.script };
};

export interface InsertPieceInput {
  sceneIndex: number;
  /** Collision-free id (allocate with `nextPieceId`, never trust a caller). */
  id: string;
  kind: string;
  /** The `<Piece id=".." kind="..">` marker — must match emitPiece's shape. */
  openTag: string;
  /** The positioned wrapper div + inner JSX, verbatim (written to pieces/<id>.tsx). */
  body: string;
  offset?: PieceOffset;
}

/**
 * Splice a fresh `{/*RB:id* /}` slot into a scene template. Placed just BEFORE the
 * chrome piece's slot so BrandChrome keeps painting last (on top); else after the
 * last existing slot; else (no slots remain) before the Section's closing `</div>`.
 * Matches the observed template's blank-line + 6-space slot indentation.
 */
const insertSlotIntoTemplate = (template: string, pieces: PieceMeta[], id: string): string => {
  const newSlot = pieceSlot(id);
  const pad = "\n\n      ";
  const chrome = pieces.find((p) => p.kind === "chrome");
  if (chrome) {
    const at = template.indexOf(pieceSlot(chrome.id));
    if (at >= 0) return template.slice(0, at) + newSlot + pad + template.slice(at);
  }
  let lastEnd = -1;
  for (const p of pieces) {
    const at = template.lastIndexOf(pieceSlot(p.id));
    if (at >= 0) lastEnd = Math.max(lastEnd, at + pieceSlot(p.id).length);
  }
  if (lastEnd >= 0) return template.slice(0, lastEnd) + pad + newSlot + template.slice(lastEnd);
  // No slots at all — splice before the Section's closing </div>.
  return template.replace(/<\/div>(\s*\);\s*};?\s*)$/, (m) => `${pad}${newSlot}\n    ${m}`);
};

/**
 * Insert a NEW top-level piece into a scene (the add-primitive / marquee-generate
 * path — the counterpart of removePieceFromManifest). Writes the body file, splices
 * a slot into the template, appends the PieceMeta. Pure store mutation: the caller's
 * commit() reassembles + compile-checks. Returns false if the scene is missing or the
 * id already exists (never double-insert). The reassembler then emits the new piece
 * exactly like any other; a later regen/move/delete/decompose treats it as native.
 */
export const insertPiece = async (genDir: string, input: InsertPieceInput): Promise<boolean> => {
  const { sceneIndex, id, kind, openTag, body, offset } = input;
  const legoDir = path.join(genDir, LEGO_DIR);
  const manifest = await readManifest(genDir);
  const scene = manifest.scenes.find((s) => s.sceneIndex === sceneIndex);
  if (!scene) return false;
  if (scene.pieces.some((p) => p.id === id)) return false;

  const file = path.posix.join("pieces", `${id}.tsx`);
  await fs.writeFile(path.join(legoDir, file), body, "utf8");
  scene.template = insertSlotIntoTemplate(scene.template, scene.pieces, id);

  // Insert the meta before chrome (keeps the array in DOM/paint order); else append.
  const chromeIdx = scene.pieces.findIndex((p) => p.kind === "chrome");
  const meta: PieceMeta = { id, kind, openTag, file, ...(offset ? { offset } : {}) };
  if (chromeIdx >= 0) scene.pieces.splice(chromeIdx, 0, meta);
  else scene.pieces.push(meta);
  await writeManifest(genDir, manifest);
  return true;
};

/**
 * Allocate a collision-free id for a new piece in a scene: `s<sceneIndex>.add<n>`,
 * smallest n≥1 free of EVERY id already in use — manifest piece ids AND any `id="…"`
 * inside a piece body (nested children live in bodies, not the manifest). Always
 * server-allocated: a duplicate id makes reassemble's slot replace hit the wrong piece.
 */
export const nextPieceId = async (genDir: string, sceneIndex: number): Promise<string> => {
  const d = await readDecomposed(genDir);
  const used = new Set<string>();
  for (const s of d.scenes) {
    for (const p of s.pieces) {
      used.add(p.id);
      for (const m of p.body.matchAll(/\bid="([^"]+)"/g)) used.add(m[1]);
    }
  }
  let n = 1;
  while (used.has(`s${sceneIndex}.add${n}`)) n++;
  return `s${sceneIndex}.add${n}`;
};
