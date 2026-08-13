/**
 * Deterministic outline-page operations for the review screen (founder,
 * 2026-08-13: "allow me to edit the outline itself" — reorder, remove, add,
 * and edit pages, not just the brief that produced them).
 *
 * All pure: the review client applies an op to the script it holds and
 * persists the WHOLE result through the existing saveScriptEdits action, the
 * same trust boundary every headline edit has used since stage 2. No
 * generation-time validator runs on user edits — a person rewriting their own
 * outline is the authority the validators exist to approximate.
 */
import type { Scene, Script } from "../../src/schema";

/**
 * Deck pages tile at a fixed 5s each — inert schema metadata on a deck (the
 * numbers are never shown) but load-bearing for the build's Section mapping.
 * DEFINED here (a dependency-free module the REVIEW CLIENT bundles) and
 * re-exported by script-generator for its historical importers: this module
 * must never pull the generator's transport graph into a browser bundle.
 */
export const DECK_SECONDS_PER_SLIDE = 5;

/**
 * Restore the invariants the generator promises: 0-based contiguous `index`
 * and, for decks, the inert 5s timing tiles (scenes[i] spans
 * [i*5, (i+1)*5)) plus config.duration_seconds — the same arithmetic the
 * script prompt dictates, applied after any reorder/insert/delete.
 */
export const renumberScenes = (script: Script): Script => {
  const isDeck = script.config.kind === "deck";
  const scenes = script.scenes.map((sc, i) => ({
    ...sc,
    index: i,
    ...(isDeck
      ? {
          start_seconds: i * DECK_SECONDS_PER_SLIDE,
          end_seconds: (i + 1) * DECK_SECONDS_PER_SLIDE,
        }
      : {}),
  }));
  return {
    ...script,
    scenes,
    config: isDeck
      ? { ...script.config, duration_seconds: scenes.length * DECK_SECONDS_PER_SLIDE }
      : script.config,
  };
};

export const moveScene = (script: Script, from: number, to: number): Script => {
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= script.scenes.length ||
    to >= script.scenes.length
  ) {
    return script;
  }
  const scenes = [...script.scenes];
  const [sc] = scenes.splice(from, 1);
  scenes.splice(to, 0, sc);
  return renumberScenes({ ...script, scenes });
};

export const deleteScene = (script: Script, at: number): Script => {
  // Never delete the last page — an outline with zero pages builds nothing
  // and the review screen would have nothing left to offer but confusion.
  if (script.scenes.length <= 1 || at < 0 || at >= script.scenes.length) return script;
  const scenes = script.scenes.filter((_, i) => i !== at);
  return renumberScenes({ ...script, scenes });
};

/** ULID-ish id, same alphabet/length shape as generated scene ids. Collision
 *  space vastly exceeds a deck's page count; crypto where available. */
const freshId = (): string => {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let out = "";
  const bytes =
    typeof crypto !== "undefined" && "getRandomValues" in crypto
      ? crypto.getRandomValues(new Uint8Array(26))
      : Array.from({ length: 26 }, () => Math.floor(Math.random() * 256));
  for (let i = 0; i < 26; i++) out += alphabet[bytes[i] % 32];
  return out;
};

/**
 * A NEW page, inserted after `after` (or at the end for after = last). Born
 * minimal and honest: a placeholder headline the user is clearly meant to
 * replace, and a visual concept simple enough that a build of the untouched
 * page still renders something sane rather than tripping density gates.
 */
export const insertBlankScene = (script: Script, after: number): Script => {
  const anchor = script.scenes[Math.max(0, Math.min(after, script.scenes.length - 1))];
  const scene: Scene = {
    id: freshId(),
    index: 0, // renumber fixes it
    label: "New page",
    description: "A new page — say what belongs on it.",
    visual_concept:
      "Composition: a centered headline block on a calm ground with one short supporting line beneath it.",
    register: anchor?.register ?? "centered",
    content: { headline: "New page — click to write its headline" },
    start_seconds: 0,
    end_seconds: DECK_SECONDS_PER_SLIDE,
  } as Scene;
  const scenes = [...script.scenes];
  scenes.splice(Math.min(after + 1, scenes.length), 0, scene);
  return renumberScenes({ ...script, scenes });
};
