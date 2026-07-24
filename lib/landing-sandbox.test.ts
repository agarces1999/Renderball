/**
 * Tests for the landing-canvas sandbox: marquee geometry (editor bounds
 * discipline), storage round-trip with versioning + expiry + corrupt input,
 * and the /new seed text (describe + compose).
 */
import {
  MARQUEE_MIN,
  SANDBOX_CONTENT,
  SANDBOX_MAX_AGE_MS,
  SANDBOX_STORAGE_KEY,
  clampBoxToHost,
  clampBoxToRegion,
  clearSandboxState,
  composeBriefFromSandbox,
  describeSandbox,
  isRealMarquee,
  loadSandboxState,
  normalizeBox,
  saveSandboxState,
  variantFor,
  type LandingSandboxState,
  type SandboxElement,
} from "./landing-sandbox";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

const fakeStorage = () => {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    map,
  };
};

const el = (over: Partial<SandboxElement> = {}): SandboxElement => ({
  id: "sb-1",
  intent: "kpi",
  variant: 0,
  box: { x: 100, y: 120, w: 260, h: 140 },
  moved: false,
  ...over,
});

const state = (over: Partial<LandingSandboxState> = {}): LandingSandboxState => ({
  v: 1,
  surface: "stage",
  stage: { w: 1180, h: 900 },
  elements: [el()],
  heroMoves: 0,
  updatedAt: 1_000_000,
  ...over,
});

console.log("landing-sandbox");

/* ── geometry: the user's box is law ─────────────────────────────────── */

await check("normalizeBox handles any drag direction", () => {
  const b = normalizeBox(300, 200, 100, 120);
  assert(b.x === 100 && b.y === 120 && b.w === 200 && b.h === 80, JSON.stringify(b));
});

await check(`sub-${MARQUEE_MIN}px drags are stray clicks (editor threshold)`, () => {
  assert(!isRealMarquee({ x: 0, y: 0, w: MARQUEE_MIN - 1, h: 100 }), "narrow box passed");
  assert(!isRealMarquee({ x: 0, y: 0, w: 100, h: MARQUEE_MIN - 1 }), "short box passed");
  assert(isRealMarquee({ x: 0, y: 0, w: MARQUEE_MIN, h: MARQUEE_MIN }), "exact-min box failed");
});

await check("clampBoxToHost slides the box inside without resizing it", () => {
  const b = clampBoxToHost({ x: 1100, y: -30, w: 200, h: 100 }, 1180, 900);
  assert(b.w === 200 && b.h === 100, `size changed: ${JSON.stringify(b)}`);
  assert(b.x === 980 && b.y === 0, `not slid inside: ${JSON.stringify(b)}`);
});

await check("clampBoxToHost caps size only when the host is smaller", () => {
  const b = clampBoxToHost({ x: 10, y: 10, w: 500, h: 500 }, 400, 300);
  assert(b.w === 400 && b.h === 300 && b.x === 0 && b.y === 0, JSON.stringify(b));
});

await check("clampBoxToRegion holds the band contract (box never above the band)", () => {
  const band = { x: 0, y: 500, w: 1180, h: 400 };
  const b = clampBoxToRegion({ x: 200, y: 430, w: 220, h: 120 }, band);
  assert(b.y === 500 && b.x === 200 && b.w === 220 && b.h === 120, JSON.stringify(b));
  const low = clampBoxToRegion({ x: -40, y: 880, w: 220, h: 120 }, band);
  assert(low.x === 0 && low.y === 780, JSON.stringify(low));
});

await check("variantFor rotates through each intent's content set", () => {
  const n = SANDBOX_CONTENT.kpi.length;
  assert(variantFor("kpi", 0) === 0 && variantFor("kpi", n) === 0, "no wrap");
  assert(variantFor("kpi", 1) === 1, "no rotate");
});

/* ── storage round-trip ──────────────────────────────────────────────── */

await check("save → load round-trips the state", () => {
  const store = fakeStorage();
  const s = state({ elements: [el(), el({ id: "sb-2", intent: "chart", moved: true })], heroMoves: 2 });
  saveSandboxState(s, store);
  const back = loadSandboxState(store, s.updatedAt + 1000);
  assert(!!back, "load returned null");
  assert(back!.elements.length === 2, `elements ${back!.elements.length}`);
  assert(back!.elements[1].moved === true, "moved flag lost");
  assert(back!.heroMoves === 2, `heroMoves ${back!.heroMoves}`);
  assert(back!.surface === "stage", "surface lost");
});

await check("stale state (>14 days) is ignored", () => {
  const store = fakeStorage();
  const s = state();
  saveSandboxState(s, store);
  assert(loadSandboxState(store, s.updatedAt + SANDBOX_MAX_AGE_MS + 1) === null, "stale state returned");
  assert(loadSandboxState(store, s.updatedAt + SANDBOX_MAX_AGE_MS - 1) !== null, "fresh state dropped");
});

await check("corrupt JSON / wrong version / malformed elements are filtered", () => {
  const store = fakeStorage();
  store.setItem(SANDBOX_STORAGE_KEY, "{not json");
  assert(loadSandboxState(store, 0) === null, "corrupt JSON returned state");
  store.setItem(SANDBOX_STORAGE_KEY, JSON.stringify({ v: 2, elements: [], updatedAt: 1 }));
  assert(loadSandboxState(store, 1) === null, "future version accepted");
  const s = state();
  store.setItem(
    SANDBOX_STORAGE_KEY,
    JSON.stringify({ ...s, elements: [el(), { id: 7, intent: "kpi" }, el({ id: "sb-3", box: { x: 1, y: 2, w: NaN, h: 4 } })] }),
  );
  const back = loadSandboxState(store, s.updatedAt);
  assert(back !== null && back.elements.length === 1, `malformed elements kept: ${back?.elements.length}`);
});

await check("clearSandboxState removes the entry; null store is a no-op", () => {
  const store = fakeStorage();
  saveSandboxState(state(), store);
  clearSandboxState(store);
  assert(store.map.size === 0, "entry not removed");
  // Guarded helpers must not throw with no storage (SSR / blocked).
  saveSandboxState(state(), null);
  clearSandboxState(null);
  assert(loadSandboxState(null) === null, "null store should load null");
});

/* ── the /new banner + brief seed ────────────────────────────────────── */

await check("describeSandbox counts and collapses intents in draw order", () => {
  const s = state({
    elements: [el(), el({ id: "sb-2" }), el({ id: "sb-3", intent: "quote" })],
  });
  assert(
    describeSandbox(s) === "3 elements — kpi tile ×2 · pull-quote",
    describeSandbox(s),
  );
  assert(
    describeSandbox(state()) === "1 element — kpi tile",
    describeSandbox(state()),
  );
});

await check("composeBriefFromSandbox names each element's real content", () => {
  const s = state({
    elements: [el(), el({ id: "sb-2", intent: "chart", variant: 0 })],
  });
  const brief = composeBriefFromSandbox(s);
  assert(brief.includes("a KPI tile (First draft — 4.6 min from one URL)"), brief);
  assert(brief.includes("a bar chart (minutes per deck)"), brief);
  assert(brief.includes("landing canvas"), brief);
  assert(brief.includes("Build the opening slide around them."), brief);
});

await check("composeBriefFromSandbox honors hand-arrangement (moved / heroMoves)", () => {
  const moved = composeBriefFromSandbox(state({ elements: [el({ moved: true })] }));
  assert(moved.includes("Keep my arrangement"), moved);
  const heroOnly = composeBriefFromSandbox(state({ heroMoves: 1 }));
  assert(heroOnly.includes("Keep my arrangement"), heroOnly);
});

await check("composeBriefFromSandbox caps the list and counts the rest", () => {
  const many = state({
    elements: Array.from({ length: 8 }, (_, i) => el({ id: `sb-${i}` })),
  });
  const brief = composeBriefFromSandbox(many);
  assert(brief.includes("and 2 more elements"), brief);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
