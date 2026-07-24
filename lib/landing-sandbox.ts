/**
 * Landing-canvas sandbox — shared state, content, and persistence for the
 * "your turn — draw here" beat (DESIGN.md "Landing — the canvas performs";
 * the 2026-07-24 consultation's two deferred ideas).
 *
 * The visitor drags a real marquee on the landing stage and picks a
 * precomputed intent; the element materializes instantly from the local sets
 * below — zero LLM calls, mono `sandbox` label per the page's honesty rules.
 * The same bounds discipline as the editor applies: the user's box is law —
 * content fits the box; it never resizes or moves the box.
 *
 * Everything here also serializes to localStorage so /new can offer
 * "continue what you started" after sign-in: the smallest honest version
 * seeds the brief prompt from the drawn intents (no forged genDir).
 *
 * Pure module: no React, no window access outside the guarded storage
 * helpers — so geometry + compose logic is unit-testable in node.
 */

export type SandboxIntent = "kpi" | "chart" | "quote";

export type SandboxBox = { x: number; y: number; w: number; h: number };

export type SandboxElement = {
  id: string;
  intent: SandboxIntent;
  /** Index into the intent's content set (rotates per draw). */
  variant: number;
  /** Host-local px — exactly the box the visitor drew (or dragged to). */
  box: SandboxBox;
  /** Dragged after materializing. */
  moved: boolean;
};

export type LandingSandboxState = {
  v: 1;
  /** Which surface the visitor drew on (scroll stage vs the bounded panel). */
  surface: "stage" | "panel";
  /** Host size at save time, so consumers can reason about the coords. */
  stage: { w: number; h: number };
  elements: SandboxElement[];
  /** How many times the scripted hero elements (KPI tile / chart) were dragged. */
  heroMoves: number;
  updatedAt: number;
};

/* ── precomputed sandbox content (the whole point: zero LLM calls) ────── */

export const SANDBOX_CONTENT = {
  kpi: [
    { eyebrow: "Pipeline", value: "3.2×", note: "faster close" },
    { eyebrow: "Retention", value: "128%", note: "net revenue retained" },
    { eyebrow: "Onboarding", value: "−41%", note: "time to first value" },
  ],
  chart: [
    { label: "last 6 quarters", bars: [34, 48, 42, 61, 74, 92] },
    { label: "signups per week", bars: [22, 30, 55, 48, 70, 88] },
  ],
  quote: [
    { text: "Your box is law — I just fill it.", by: "the model" },
    { text: "Drawn in a second. Real the same second.", by: "this canvas" },
  ],
} as const;

/** Picker chips + prose nouns, in display order. */
export const SANDBOX_INTENTS: {
  intent: SandboxIntent;
  chip: string;
  noun: string;
}[] = [
  { intent: "kpi", chip: "kpi tile", noun: "a KPI tile" },
  { intent: "chart", chip: "bar chart", noun: "a bar chart" },
  { intent: "quote", chip: "pull-quote", noun: "a pull-quote" },
];

export const variantFor = (intent: SandboxIntent, drawCount: number): number =>
  drawCount % SANDBOX_CONTENT[intent].length;

/* ── marquee geometry (mirrors the editor's discipline) ──────────────── */

/** Below this on either axis a drag is a stray click, not a box (editor rule). */
export const MARQUEE_MIN = 24;

export const normalizeBox = (
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): SandboxBox => ({
  x: Math.min(x0, x1),
  y: Math.min(y0, y1),
  w: Math.abs(x1 - x0),
  h: Math.abs(y1 - y0),
});

export const isRealMarquee = (box: SandboxBox): boolean =>
  box.w >= MARQUEE_MIN && box.h >= MARQUEE_MIN;

/** Keep the box fully inside a region (e.g. the landing's performance band —
 *  the no-overlap contract: visitor generations never touch the hero copy).
 *  The box's SIZE is the user's — only cap it when the region itself is
 *  smaller; otherwise just slide it inside. */
export const clampBoxToRegion = (
  box: SandboxBox,
  region: SandboxBox,
): SandboxBox => {
  const w = Math.min(box.w, region.w);
  const h = Math.min(box.h, region.h);
  return {
    x: Math.max(region.x, Math.min(box.x, region.x + region.w - w)),
    y: Math.max(region.y, Math.min(box.y, region.y + region.h - h)),
    w,
    h,
  };
};

/** Whole-host region clamp. */
export const clampBoxToHost = (
  box: SandboxBox,
  hostW: number,
  hostH: number,
): SandboxBox => clampBoxToRegion(box, { x: 0, y: 0, w: hostW, h: hostH });

/* ── persistence (localStorage, guarded) ─────────────────────────────── */

export const SANDBOX_STORAGE_KEY = "rb:landing-sandbox:v1";

/** Stale sandboxes don't chase people: ignore anything older than 14 days. */
export const SANDBOX_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const defaultStorage = (): StorageLike | null => {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null; // storage blocked (private mode / embedded) — sandbox still works, just doesn't persist
  }
};

const isBox = (b: unknown): b is SandboxBox => {
  if (typeof b !== "object" || b === null) return false;
  const box = b as Record<string, unknown>;
  return (["x", "y", "w", "h"] as const).every(
    (k) => typeof box[k] === "number" && Number.isFinite(box[k] as number),
  );
};

const isElement = (e: unknown): e is SandboxElement => {
  if (typeof e !== "object" || e === null) return false;
  const el = e as Record<string, unknown>;
  return (
    typeof el.id === "string" &&
    (el.intent === "kpi" || el.intent === "chart" || el.intent === "quote") &&
    typeof el.variant === "number" &&
    isBox(el.box)
  );
};

export function loadSandboxState(
  store: StorageLike | null = defaultStorage(),
  now: number = Date.now(),
): LandingSandboxState | null {
  if (!store) return null;
  try {
    const raw = store.getItem(SANDBOX_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LandingSandboxState>;
    if (parsed.v !== 1 || !Array.isArray(parsed.elements)) return null;
    if (
      typeof parsed.updatedAt !== "number" ||
      now - parsed.updatedAt > SANDBOX_MAX_AGE_MS
    ) {
      return null;
    }
    const elements = parsed.elements.filter(isElement).map((e) => ({
      ...e,
      moved: e.moved === true,
    }));
    return {
      v: 1,
      surface: parsed.surface === "panel" ? "panel" : "stage",
      stage: isBoxSize(parsed.stage) ? parsed.stage : { w: 0, h: 0 },
      elements,
      heroMoves:
        typeof parsed.heroMoves === "number" && parsed.heroMoves > 0
          ? Math.floor(parsed.heroMoves)
          : 0,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return null; // corrupt entry — treat as absent
  }
}

const isBoxSize = (s: unknown): s is { w: number; h: number } => {
  if (typeof s !== "object" || s === null) return false;
  const size = s as Record<string, unknown>;
  return typeof size.w === "number" && typeof size.h === "number";
};

export function saveSandboxState(
  state: LandingSandboxState,
  store: StorageLike | null = defaultStorage(),
): void {
  if (!store) return;
  try {
    store.setItem(SANDBOX_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // quota / blocked — the sandbox stays usable, it just won't carry over
  }
}

export function clearSandboxState(
  store: StorageLike | null = defaultStorage(),
): void {
  if (!store) return;
  try {
    store.removeItem(SANDBOX_STORAGE_KEY);
  } catch {
    // nothing to do
  }
}

/* ── describing the visitor's work (the /new banner + brief seed) ────── */

const chipFor = (intent: SandboxIntent): string =>
  SANDBOX_INTENTS.find((i) => i.intent === intent)?.chip ?? intent;

/** "2 elements — kpi tile · bar chart" (counts collapse: "kpi tile ×2"). */
export function describeSandbox(state: LandingSandboxState): string {
  const counts = new Map<SandboxIntent, number>();
  for (const el of state.elements) {
    counts.set(el.intent, (counts.get(el.intent) ?? 0) + 1);
  }
  const chips = [...counts.entries()].map(
    ([intent, n]) => `${chipFor(intent)}${n > 1 ? ` ×${n}` : ""}`,
  );
  const n = state.elements.length;
  return `${n} element${n === 1 ? "" : "s"} — ${chips.join(" · ")}`;
}

const summarize = (el: SandboxElement): string => {
  switch (el.intent) {
    case "kpi": {
      const c = SANDBOX_CONTENT.kpi[el.variant % SANDBOX_CONTENT.kpi.length];
      return `a KPI tile (${c.eyebrow} — ${c.value} ${c.note})`;
    }
    case "chart": {
      const c =
        SANDBOX_CONTENT.chart[el.variant % SANDBOX_CONTENT.chart.length];
      return `a bar chart (${c.label})`;
    }
    case "quote": {
      const c =
        SANDBOX_CONTENT.quote[el.variant % SANDBOX_CONTENT.quote.length];
      return `a pull-quote (“${c.text}”)`;
    }
  }
};

const listJoin = (parts: string[]): string => {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
};

/**
 * The brief prompt that seeds the visitor's first document. Honest smallest
 * version of "your edits come with you": we hand the agent their intents as
 * words the user can read and edit — we do not forge a generated document.
 */
export function composeBriefFromSandbox(state: LandingSandboxState): string {
  const MAX_LISTED = 6;
  const parts = state.elements.slice(0, MAX_LISTED).map(summarize);
  const extra = state.elements.length - MAX_LISTED;
  const listed =
    listJoin(parts) + (extra > 0 ? ` and ${extra} more element${extra === 1 ? "" : "s"}` : "");
  const arranged =
    state.elements.some((e) => e.moved) || state.heroMoves > 0
      ? " Keep my arrangement for those elements and design the rest of the slide around them."
      : " Build the opening slide around them.";
  return (
    `A deck whose first slide starts from what I drew on the landing canvas: ${listed}.` +
    arranged +
    " Then tell the rest of the story."
  );
}
