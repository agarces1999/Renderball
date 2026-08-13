/**
 * The single-page rewrite: one attempt + one corrective round, validated by
 * the SAME pass full generation uses, invariants pinned, nothing partial.
 * Driven through a fake transport — the loop's decisions are what's tested.
 */
import type { Script } from "../../src/schema";
import { parseSceneReply, rewriteOutlinePage } from "./outline-page-rewrite";
import { DECK_SECONDS_PER_SLIDE } from "./script-generator";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => Promise<void> | void) => {
  try {
    await fn();
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

console.log("outline-page-rewrite");

/** A minimal deck the validators accept — content shaped like real outlines. */
const deck = (): Script =>
  ({
    id: "S",
    brief: { purpose: "A quarterly update deck", duration_seconds: 2 * DECK_SECONDS_PER_SLIDE },
    narrative: {
      logline: "The quarter, honestly told.",
      arc: "numbers → meaning → the ask",
      throughline: "one honest thread",
    },
    config: { kind: "deck", duration_seconds: 2 * DECK_SECONDS_PER_SLIDE, aspect_ratio: "16:9", resolution: "1080p" },
    scenes: [0, 1].map((i) => ({
      id: `sc${i}`,
      index: i,
      label: `Page ${i + 1}`,
      description: "What this page conveys to the room.",
      visual_concept:
        "Composition: a centered headline block over a stat row of three KPI tiles on a calm panel.",
      register: "centered",
      content: {
        headline: i === 0 ? "The quarter in one line" : "The ask",
        lede: "One supporting sentence that frames the number honestly.",
      },
      start_seconds: i * DECK_SECONDS_PER_SLIDE,
      end_seconds: (i + 1) * DECK_SECONDS_PER_SLIDE,
    })),
    assets: { images: [], fonts: [] },
  }) as unknown as Script;

const U = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

const goodScene = (over: Record<string, unknown> = {}) => ({
  id: "WRONG-ID-THE-PIN-MUST-FIX",
  index: 99,
  label: "Numbers, plainly",
  description: "The quarter's three numbers, stated without varnish.",
  visual_concept:
    "Composition: a centered headline block above a stat row of three KPI tiles, each tile carrying a value, a label and a delta chip; a thin accent bar sits under the headline. Animations: headline fadeRise at 0s duration 0.6s. KPI tiles rise in sequence from 1s with 0.2s stagger. accent bar extends at 3.5s.",
  register: "centered",
  content: { headline: "Three numbers, no varnish", lede: "Revenue, retention and burn in one glance." },
  start_seconds: 999,
  end_seconds: 1000,
  ...over,
});

await check("parseSceneReply accepts {scene:{…}} and bare scene, rejects junk", () => {
  assert(parseSceneReply(JSON.stringify({ scene: goodScene() })) !== null, "wrapped");
  assert(parseSceneReply(JSON.stringify(goodScene())) !== null, "bare");
  assert(parseSceneReply("not json") === null, "junk");
  assert(parseSceneReply(JSON.stringify({ hello: 1 })) === null, "no content field");
});

await check("happy path: rewrite lands, invariants pinned, deck re-tiled", async () => {
  const s = deck();
  const r = await rewriteOutlinePage(s, 0, "make it about the numbers", async () => ({
    text: JSON.stringify({ scene: goodScene() }),
    usage: U,
  }));
  assert(r.ok, `expected ok, got: ${r.error}`);
  assert(r.scene?.id === "sc0", "the model cannot change the scene id");
  assert(r.scene?.index === 0, "index pinned");
  assert(r.scene?.start_seconds === 0 && r.scene?.end_seconds === DECK_SECONDS_PER_SLIDE, "timing pinned");
  assert(r.scene?.content.headline === "Three numbers, no varnish", "the rewrite's content landed");
  assert(r.script?.scenes[1].content.headline === "The ask", "the other page untouched");
});

await check("a parse failure gets ONE corrective round, then succeeds", async () => {
  let calls = 0;
  const r = await rewriteOutlinePage(deck(), 0, "sharper", async () => {
    calls++;
    return calls === 1
      ? { text: "```json not even json", usage: U }
      : { text: JSON.stringify({ scene: goodScene() }), usage: U };
  });
  assert(r.ok, `expected recovery, got: ${r.error}`);
  assert(calls === 2, `exactly two calls, got ${calls}`);
  assert(r.usage.input_tokens === 20, "both rounds' tokens accounted");
});

await check("two bad rounds end honestly — original outline untouched", async () => {
  const s = deck();
  const before = JSON.stringify(s);
  const r = await rewriteOutlinePage(s, 0, "sharper", async () => ({
    text: "junk",
    usage: U,
  }));
  assert(!r.ok, "must fail");
  assert(!!r.error && /\s/.test(r.error), "with a human sentence");
  assert(r.script === undefined, "no partial script escapes");
  assert(JSON.stringify(s) === before, "input script not mutated");
});

await check("pre-existing complaints on OTHER pages do not hold a rewrite hostage", async () => {
  // The fixture's untouched pages are deliberately thin — they fail the
  // closed-whitelist gates. Rewriting page 0 with a clean scene must still
  // land: the gates may only judge what THIS rewrite changed.
  const r = await rewriteOutlinePage(deck(), 0, "make it about the numbers", async () => ({
    text: JSON.stringify({ scene: goodScene() }),
    usage: U,
  }));
  assert(r.ok, `expected ok despite page 1's pre-existing thinness, got: ${r.error}`);
});

await check("an empty instruction is refused without spending", async () => {
  let calls = 0;
  const r = await rewriteOutlinePage(deck(), 0, "   ", async () => {
    calls++;
    return { text: "{}", usage: U };
  });
  assert(!r.ok && calls === 0, "no model call on an empty ask");
});

await check("an out-of-range page is refused without spending", async () => {
  let calls = 0;
  const r = await rewriteOutlinePage(deck(), 9, "x", async () => {
    calls++;
    return { text: "{}", usage: U };
  });
  assert(!r.ok && calls === 0, "no model call for a page that does not exist");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
