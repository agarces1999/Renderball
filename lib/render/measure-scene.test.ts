/**
 * Tests for the persisted measurement record (Bug 2, item 1).
 *
 * Run: `node scripts/run-tests.mjs lib/render/measure-scene.test.ts`
 *
 * `measureScenes` itself needs a real Chromium and a written genDir, so it is
 * exercised offline against stored builds rather than here — the unit suite is
 * deliberately hermetic (no browser launches). What IS locked here is the part
 * that has to stay stable for the persisted files to be worth anything: the
 * SHAPE of a `SceneRects` record, and the arithmetic of the telemetry rollup
 * that reports how far pieces painted outside their declared boxes.
 */
import { summarizeBoxOverflow, type PieceRect, type SceneRects, type SceneMeasurement } from "./measure-scene";

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

const piece = (over: Partial<PieceRect> & { id: string }): PieceRect => ({
  kind: "diegetic",
  declared: { x: 0, y: 0, w: 100, h: 100 },
  heightDeclared: true,
  wrapper: { x: 0, y: 0, w: 100, h: 100 },
  painted: { x: 0, y: 0, w: 100, h: 100 },
  overflow: { top: 0, right: 0, bottom: 0, left: 0, maxPx: 0 },
  nodes: 3,
  ...over,
});

const scene = (n: number, pieces: PieceRect[]): Pick<SceneMeasurement, "scene" | "pieces"> => ({ scene: n, pieces });

// ─── the persisted record's shape ───────────────────────────────────────────

check("SceneRects carries everything an offline query needs, and is JSON round-trippable", () => {
  const rec: SceneRects = {
    version: 1,
    scene: 2,
    width: 1920,
    height: 1080,
    aspect: "16:9",
    measuredAt: "2026-07-18T00:00:00.000Z",
    pieces: [piece({ id: "s2.hero" })],
    elements: [],
  };
  const back = JSON.parse(JSON.stringify(rec)) as SceneRects;
  assert(back.version === 1, "version must survive — readers key off it");
  assert(back.scene === 2 && back.aspect === "16:9", "scene identity survives");
  const p = back.pieces[0];
  // The four fields that make the record ANSWER the question it exists for.
  for (const k of ["id", "kind", "declared", "wrapper", "painted", "overflow", "heightDeclared", "nodes"] as const) {
    assert(k in p, `PieceRect lost "${k}" through JSON`);
  }
  assert(back.elements.length === 0, "the raw element walk is part of the record");
});

check("a piece with no declared box records null overflow, not a fake zero", () => {
  const p = piece({ id: "s0.atmosphere", kind: "atmosphere", declared: null, overflow: null, heightDeclared: false });
  assert(p.declared === null && p.overflow === null, "atmosphere declares no box");
  const s = summarizeBoxOverflow([scene(0, [p])]);
  assert(s.pieces === 0, "a piece with no box is not counted as compliant either");
});

// ─── the telemetry rollup ───────────────────────────────────────────────────

check("counts only pieces that painted OUTSIDE their box, and reports the worst", () => {
  const s = summarizeBoxOverflow([
    scene(0, [
      piece({ id: "s0.a" }),
      piece({ id: "s0.b", overflow: { top: 0, right: 12, bottom: 0, left: 0, maxPx: 12 } }),
    ]),
    scene(1, [piece({ id: "s1.c", kind: "text", overflow: { top: 0, right: 0, bottom: 44, left: 0, maxPx: 44 } })]),
  ]);
  assert(s.pieces === 3, `3 pieces have boxes, got ${s.pieces}`);
  assert(s.overflowing === 2, `2 overflowed, got ${s.overflowing}`);
  assert(s.totalPx === 56, `total spill 12+44=56, got ${s.totalPx}`);
  assert(s.worst?.pieceId === "s1.c" && s.worst.scene === 1 && s.worst.maxPx === 44, `worst wrong: ${JSON.stringify(s.worst)}`);
  assert(s.line.includes("2/3"), `line must state the ratio: ${s.line}`);
  assert(s.line.includes("diegetic:1") && s.line.includes("text:1"), `line must break down by kind: ${s.line}`);
  assert(s.line.includes("+44px"), `line must name the worst spill: ${s.line}`);
});

check("surfaces pieces whose bottom edge is UNENFORCEABLE (text declares no height)", () => {
  // This is Bug 2's text half made visible: before data-box-h, every text piece
  // landed here, so "inside its box" was vacuously true.
  const s = summarizeBoxOverflow([
    scene(0, [piece({ id: "s0.copy", kind: "text", heightDeclared: false })]),
  ]);
  assert(s.noHeight === 1, `expected 1 heightless piece, got ${s.noHeight}`);
  assert(/declare no height/.test(s.line), `line must say so: ${s.line}`);
});

check("a clean build reports a clean line (no worst, no spill)", () => {
  const s = summarizeBoxOverflow([scene(0, [piece({ id: "s0.a" }), piece({ id: "s0.b" })])]);
  assert(s.overflowing === 0 && s.totalPx === 0 && s.worst === null, "nothing should be flagged");
  assert(s.line.includes("0/2"), `line: ${s.line}`);
  assert(!s.line.includes("worst"), `no worst on a clean build: ${s.line}`);
});

check("measurements with no piece data degrade to an empty summary, never a throw", () => {
  const s = summarizeBoxOverflow([{ scene: 0 }, { scene: 1, pieces: [] }]);
  assert(s.pieces === 0 && s.overflowing === 0 && s.worst === null, "empty");
  assert(typeof s.line === "string" && s.line.length > 0, "still produces a line");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
