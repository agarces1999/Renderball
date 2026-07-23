//
// Deterministic PAGE operations for deck documents (canvas pivot P1):
// duplicate / remove / move / add-blank. NO LLM, no spend.
//
// A page = one Script scene + one lego SceneMeta (template + pieces). Every
// scene's template references ONLY its own index (`export const Section{K}` +
// `script.scenes[K]` reads — verified across generated decks), and piece ids
// embed the scene prefix ("s{K}.role"), so renumbering is a per-entry string
// retag — Section{K}→Section{K'}, scenes[K]→scenes[K'], s{K}.→s{K'}. —
// applied to the template, piece ids/openTags, and (defensively) bodies.
// Piece FILES are re-derived from ids by writeDecomposed, so the whole store
// rewrite is one primitive: readDecomposed → transform in memory →
// writeDecomposed → commit.
//
// UNDO CONTRACT: page ops ARE undoable. writeDecomposed rm -rf's the lego dir
// (which houses the .undo ring), so the op lifts the ring into memory first
// and puts it back after, then pushes its own snapshot — one that CARRIES THE
// SCRIPT (UndoSnapshot.script), because replaying a scene-count change without
// it would desync Section components from scenes. The undo routes persist the
// restored script whenever a popped snapshot carries one.
//
// Deck-only BY DESIGN (routes enforce config.kind === "deck"): timings are
// retiled as inert 5s/slide metadata; video timeline semantics are not
// preserved.
//
import type { Script, Scene } from "../../src/schema";
import { ulid } from "../ulid";
import {
  readDecomposed,
  writeDecomposed,
  readManifest,
  writeManifest,
  captureUndo,
  commitUndo,
  readUndoRing,
  restoreUndoRing,
  type PieceOffset,
} from "../agents/lego-store";
import {
  pieceSlot,
  type Decomposed,
  type DecomposedScene,
} from "../agents/lego-decompose";
import { DECK_SECONDS_PER_SLIDE } from "../agents/script-generator";
import { commitGenDir } from "./commit";

export type PageOp =
  | { op: "duplicate"; page: number }
  | { op: "remove"; page: number }
  | { op: "move"; page: number; to: number }
  | { op: "add"; after: number };

export interface PageOpResult {
  ok: boolean;
  /** The updated script — the CALLER persists it (saveScript + mirror). */
  script?: Script;
  pages?: number;
  /** Page index the UI should select after the op. */
  focus?: number;
  error?: string;
}

/** Parse an untrusted request body into a PageOp (null = invalid). Shared by
 *  the authed route and its dev twin. */
export const normalizePageOp = (b: Record<string, unknown>): PageOp | null => {
  const int = (v: unknown): number | null =>
    typeof v === "number" && Number.isInteger(v) ? v : null;
  switch (b.op) {
    case "duplicate": {
      const page = int(b.page);
      return page === null ? null : { op: "duplicate", page };
    }
    case "remove": {
      const page = int(b.page);
      return page === null ? null : { op: "remove", page };
    }
    case "move": {
      const page = int(b.page);
      const to = int(b.to);
      return page === null || to === null ? null : { op: "move", page, to };
    }
    case "add": {
      const after = int(b.after);
      return after === null ? null : { op: "add", after };
    }
    default:
      return null;
  }
};

/** Background/brand layers a blank page keeps; content pieces are stripped. */
const BLANK_KEEP_KINDS = new Set(["atmosphere", "chrome"]);

/** Retag every own-index reference from one scene index to another.
 *  Boundary-safe: Section10 never matches Section1; s10. never matches s1. */
const retag = (text: string, from: number, to: number): string => {
  if (from === to) return text;
  return text
    .replace(new RegExp(`Section${from}(?![0-9])`, "g"), `Section${to}`)
    .replace(new RegExp(`scenes\\[${from}\\]`, "g"), `scenes[${to}]`)
    .replace(new RegExp(`\\bs${from}\\.`, "g"), `s${to}.`);
};

interface OrderEntry {
  src: number;
  mode: "keep" | "clone" | "blank";
}

/** The new page order as references into the old one (string = validation error). */
const planFor = (op: PageOp, count: number): OrderEntry[] | string => {
  const inRange = (i: number) => Number.isInteger(i) && i >= 0 && i < count;
  const base: OrderEntry[] = Array.from({ length: count }, (_, i) => ({
    src: i,
    mode: "keep" as const,
  }));
  switch (op.op) {
    case "duplicate":
      if (!inRange(op.page)) return `page ${op.page + 1} is out of range`;
      return [
        ...base.slice(0, op.page + 1),
        { src: op.page, mode: "clone" },
        ...base.slice(op.page + 1),
      ];
    case "add":
      if (!inRange(op.after)) return `page ${op.after + 1} is out of range`;
      return [
        ...base.slice(0, op.after + 1),
        { src: op.after, mode: "blank" },
        ...base.slice(op.after + 1),
      ];
    case "remove":
      if (!inRange(op.page)) return `page ${op.page + 1} is out of range`;
      if (count <= 1) return "a document needs at least one page";
      return base.filter((e) => e.src !== op.page);
    case "move": {
      if (!inRange(op.page) || !inRange(op.to)) return "page index out of range";
      if (op.page === op.to) return base;
      const rest = base.filter((e) => e.src !== op.page);
      rest.splice(op.to, 0, { src: op.page, mode: "keep" });
      return rest;
    }
  }
};

const focusFor = (op: PageOp, pages: number): number => {
  switch (op.op) {
    case "duplicate":
      return Math.min(op.page + 1, pages - 1);
    case "add":
      return Math.min(op.after + 1, pages - 1);
    case "move":
      return op.to;
    case "remove":
      return Math.min(op.page, pages - 1);
  }
};

/** Transform one lego scene entry to its new index. Blank mode keeps only the
 *  background/brand layers and strips every other piece's template slot. */
const transformMeta = (
  src: DecomposedScene,
  mode: OrderEntry["mode"],
  to: number,
): DecomposedScene => {
  const from = src.sceneIndex;
  if (mode !== "blank") {
    return {
      sceneIndex: to,
      template: retag(src.template, from, to),
      pieces: src.pieces.map((p) => ({
        ...p,
        id: retag(p.id, from, to),
        openTag: retag(p.openTag, from, to),
        body: retag(p.body, from, to),
      })),
    };
  }
  let template = retag(src.template, from, to);
  const kept: DecomposedScene["pieces"] = [];
  for (const p of src.pieces) {
    const id = retag(p.id, from, to);
    if (BLANK_KEEP_KINDS.has(p.kind)) {
      kept.push({
        ...p,
        id,
        openTag: retag(p.openTag, from, to),
        body: retag(p.body, from, to),
      });
    } else {
      template = template.replace(pieceSlot(id), "");
    }
  }
  return { sceneIndex: to, template, pieces: kept };
};

const transformScene = (src: Scene, mode: OrderEntry["mode"], index: number): Scene => {
  if (mode === "keep") return { ...src, index };
  const copy: Scene = JSON.parse(JSON.stringify(src));
  copy.id = ulid();
  copy.index = index;
  delete copy.regenerated_at;
  if (mode === "clone") {
    copy.label = `${src.label} copy`;
  } else {
    copy.label = "New page";
    copy.description = "Blank page added by the user.";
    copy.visual_concept = "Blank page.";
    copy.content = { headline: "New page", asset_ids: [] };
  }
  return copy;
};

/**
 * Apply one page operation to the lego store + script. The store commit is the
 * gate: on a compile failure the store is rolled back byte-exact and the
 * script is untouched. Returns the updated script for the caller to persist.
 */
export const applyPageOp = async (
  genDir: string,
  script: Script,
  op: PageOp,
): Promise<PageOpResult> => {
  let d: Decomposed;
  let manifest: Awaited<ReturnType<typeof readManifest>>;
  try {
    d = await readDecomposed(genDir);
    manifest = await readManifest(genDir);
  } catch {
    return { ok: false, error: "document store not found — build the document first" };
  }
  if (d.scenes.length !== script.scenes.length) {
    return {
      ok: false,
      error: `store/script scene mismatch (${d.scenes.length} vs ${script.scenes.length})`,
    };
  }

  const plan = planFor(op, script.scenes.length);
  if (typeof plan === "string") return { ok: false, error: plan };

  // Persistent move offsets, keyed by the piece's NEW scene:id so they survive
  // the store rewrite (writeDecomposed doesn't carry offsets).
  const offsetBySrc = new Map<string, PieceOffset>();
  for (const s of manifest.scenes)
    for (const p of s.pieces) if (p.offset) offsetBySrc.set(`${s.sceneIndex}:${p.id}`, p.offset);

  const newScenesMeta = plan.map((e, j) => transformMeta(d.scenes[e.src], e.mode, j));
  const carriedOffsets: { scene: number; id: string; off: PieceOffset }[] = [];
  plan.forEach((e, j) => {
    const survivors = new Set(newScenesMeta[j].pieces.map((p) => p.id));
    for (const p of d.scenes[e.src].pieces) {
      const off = offsetBySrc.get(`${d.scenes[e.src].sceneIndex}:${p.id}`);
      const newId = retag(p.id, d.scenes[e.src].sceneIndex, j);
      if (off && survivors.has(newId)) carriedOffsets.push({ scene: j, id: newId, off });
    }
  });

  // Lift the undo ring + snapshot the pre-op state (WITH the script — scene
  // structure is changing) before the store rewrite nukes the lego dir.
  const ring = await readUndoRing(genDir);
  const snapshot = await captureUndo(genDir, script);

  await writeDecomposed(genDir, { preamble: d.preamble, tail: d.tail, scenes: newScenesMeta });
  if (carriedOffsets.length > 0) {
    const m2 = await readManifest(genDir);
    for (const o of carriedOffsets) {
      const sm = m2.scenes.find((s) => s.sceneIndex === o.scene);
      const pm = sm?.pieces.find((p) => p.id === o.id);
      if (pm) pm.offset = o.off;
    }
    await writeManifest(genDir, m2);
  }

  const commit = await commitGenDir(genDir, "page operation");
  if (!commit.ok) {
    // Roll the store back byte-exact (offsets included), restore the ring,
    // and re-commit — a failed op leaves history untouched.
    await writeDecomposed(genDir, d);
    await writeManifest(genDir, manifest);
    await restoreUndoRing(genDir, ring);
    await commitGenDir(genDir, "page operation rollback");
    return { ok: false, error: commit.error };
  }
  await restoreUndoRing(genDir, ring);
  await commitUndo(genDir, snapshot, `page ${op.op}`);

  const newScenes = plan.map((e, j) => transformScene(script.scenes[e.src], e.mode, j));
  const isDeck = script.config.kind === "deck";
  if (isDeck) {
    newScenes.forEach((sc, j) => {
      sc.start_seconds = j * DECK_SECONDS_PER_SLIDE;
      sc.end_seconds = (j + 1) * DECK_SECONDS_PER_SLIDE;
    });
  }
  const newScript: Script = {
    ...script,
    scenes: newScenes,
    config: {
      ...script.config,
      duration_seconds: isDeck
        ? newScenes.length * DECK_SECONDS_PER_SLIDE
        : script.config.duration_seconds,
    },
  };
  return {
    ok: true,
    script: newScript,
    pages: newScenes.length,
    focus: focusFor(op, newScenes.length),
  };
};
