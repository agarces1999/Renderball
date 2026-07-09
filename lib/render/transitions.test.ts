/**
 * Tests for the deterministic scene transitions in the generated wrapper
 * (buildIndexTsx): every non-last scene's Sequence is extended by
 * TRANSITION_FRAMES (the crossfade window) and wrapped in SceneTransition;
 * the last scene is unextended so the composition never overruns. The full
 * render-truth proof (real MP4 frames through this wrapper) lives in
 * animation-clock.test.ts.
 */
import { buildIndexTsx, TRANSITION_FRAMES } from "./build-wrapper";
import type { Script } from "../../src/schema";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

console.log("transitions");

const SCRIPT = {
  config: { aspect_ratio: "16:9", fps: 30, duration_seconds: 15 },
  scenes: [
    { label: "A", start_seconds: 0, end_seconds: 5 },
    { label: "B", start_seconds: 5, end_seconds: 10 },
    { label: "C", start_seconds: 10, end_seconds: 15 },
  ],
} as unknown as Script;

const index = buildIndexTsx(SCRIPT);

check("TRANSITION_FRAMES is ~0.4s and emitted into the wrapper", () => {
  assert(TRANSITION_FRAMES === 12, `expected 12 at 30fps, got ${TRANSITION_FRAMES}`);
  assert(index.includes(`const TRANSITION_FRAMES = ${TRANSITION_FRAMES};`), "const emitted");
  assert(index.includes("SceneTransition"), "SceneTransition component present");
});

check("non-last scenes extended by the overlap; last scene unextended", () => {
  // scenes are 150 frames scripted; first two mount 150+12, last mounts 150.
  const durations = [...index.matchAll(/durationInFrames=\{(\d+)\}/g)].map((m) => Number(m[1]));
  // First match is per-scene Sequences (3), last is the Composition total.
  assert(durations.length === 4, `expected 3 sequences + composition, got ${durations.length}`);
  assert(durations[0] === 150 + TRANSITION_FRAMES, `scene 0 extended: ${durations[0]}`);
  assert(durations[1] === 150 + TRANSITION_FRAMES, `scene 1 extended: ${durations[1]}`);
  assert(durations[2] === 150, `last scene NOT extended: ${durations[2]}`);
  assert(durations[3] === 450, `composition total unchanged: ${durations[3]}`);
});

check("first/last flags mark the opening fade and the no-push tail", () => {
  assert(/scripted=\{150\} isFirst=\{true\} isLast=\{false\}/.test(index), "scene 0 flags");
  assert(/scripted=\{150\} isFirst=\{false\} isLast=\{true\}/.test(index), "scene 2 flags");
});

check("film gate + anchor push: data-rb-film emitted, push origin at the motif anchor", () => {
  assert(index.includes('data-rb-film=""'), "SceneTransition carries the film gate attribute");
  assert(index.includes('const PUSH_ORIGIN = "1360px 540px"'), "16:9 push origin = throughline anchor");
  assert(index.includes("transformOrigin: PUSH_ORIGIN"), "outgoing push centered on the anchor");
});

check("single-scene script: no extension, still fades from black", () => {
  const solo = buildIndexTsx({
    config: { aspect_ratio: "16:9", fps: 30, duration_seconds: 5 },
    scenes: [{ label: "only", start_seconds: 0, end_seconds: 5 }],
  } as unknown as Script);
  const durations = [...solo.matchAll(/durationInFrames=\{(\d+)\}/g)].map((m) => Number(m[1]));
  assert(durations[0] === 150, `solo scene unextended: ${durations[0]}`);
  assert(/isFirst=\{true\} isLast=\{true\}/.test(solo), "solo scene is first AND last");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
