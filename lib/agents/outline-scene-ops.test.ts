/**
 * The deterministic outline-page ops (reorder / delete / add) — the pure half
 * of "edit the outline itself". The invariant that matters: after ANY op, the
 * deck's scenes are contiguously indexed and tiled at 5s each, exactly what
 * the generator promises the build.
 */
import type { Script } from "../../src/schema";
import {
  deleteScene,
  insertBlankScene,
  moveScene,
  renumberScenes,
} from "./outline-scene-ops";
import { DECK_SECONDS_PER_SLIDE } from "./script-generator";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`);
  }
};
const assert = (c: boolean, m: string) => {
  if (!c) throw new Error(m);
};

console.log("outline-scene-ops");

const deck = (n: number): Script =>
  ({
    id: "S",
    config: { kind: "deck", duration_seconds: n * DECK_SECONDS_PER_SLIDE, aspect_ratio: "16:9", resolution: "1080p" },
    scenes: Array.from({ length: n }, (_, i) => ({
      id: `sc${i}`,
      index: i,
      label: `Page ${i}`,
      visual_concept: "Composition: something.",
      content: { headline: `H${i}` },
      start_seconds: i * DECK_SECONDS_PER_SLIDE,
      end_seconds: (i + 1) * DECK_SECONDS_PER_SLIDE,
    })),
    assets: { images: [], fonts: [] },
  }) as unknown as Script;

const tiledOk = (s: Script): boolean =>
  s.scenes.every(
    (sc, i) =>
      sc.index === i &&
      sc.start_seconds === i * DECK_SECONDS_PER_SLIDE &&
      sc.end_seconds === (i + 1) * DECK_SECONDS_PER_SLIDE,
  ) && s.config.duration_seconds === s.scenes.length * DECK_SECONDS_PER_SLIDE;

check("move re-tiles indexes and timings", () => {
  const s = moveScene(deck(4), 3, 0);
  assert(s.scenes[0].id === "sc3", "moved to front");
  assert(s.scenes[1].id === "sc0", "others shifted");
  assert(tiledOk(s), "tiling invariant");
});

check("move with out-of-range or same index is a no-op", () => {
  const d = deck(3);
  assert(moveScene(d, 1, 1) === d, "same index");
  assert(moveScene(d, -1, 2) === d, "negative");
  assert(moveScene(d, 0, 9) === d, "past end");
});

check("delete removes the page and re-tiles", () => {
  const s = deleteScene(deck(3), 1);
  assert(s.scenes.length === 2 && s.scenes.map((x) => x.id).join(",") === "sc0,sc2", "right page gone");
  assert(tiledOk(s), "tiling invariant");
});

check("the last page cannot be deleted", () => {
  const d = deck(1);
  assert(deleteScene(d, 0) === d, "an outline must keep at least one page");
});

check("insert adds a fresh page after the anchor, re-tiled, with a unique id", () => {
  const s = insertBlankScene(deck(3), 1);
  assert(s.scenes.length === 4, "one more page");
  assert(s.scenes[2].label === "New page", "inserted after index 1");
  assert(!["sc0", "sc1", "sc2"].includes(s.scenes[2].id), "fresh id");
  assert(s.scenes[2].content.headline.length > 0, "born with a headline");
  assert(tiledOk(s), "tiling invariant");
});

check("renumber is idempotent", () => {
  const once = renumberScenes(deck(5));
  const twice = renumberScenes(once);
  assert(JSON.stringify(once) === JSON.stringify(twice), "stable under repetition");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
