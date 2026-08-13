/**
 * Outline stream sink — the live text of an outline generation, relayed to
 * the panel so the user watches their outline being TYPED (founder,
 * 2026-08-14, from the Gamma comparison) instead of staring at a paced
 * spinner for a minute.
 *
 * Shape: the generate job pushes model deltas here; the SSE route
 * (app/api/documents/generate/stream) replays them to any number of
 * subscribers, from the beginning — a reload mid-generation reattaches and
 * catches up. This mirrors lib/render/build-jobs.ts's philosophy (in-memory,
 * single-process, honest about it): on the single Railway container an
 * in-memory ring is exactly as durable as the build job registry it rides
 * next to. If the process dies, the poll fallback still owns completion.
 *
 * The panel NEVER learns anything load-bearing from this stream: it is pure
 * ceremony. pollOutline (GET /api/documents/generate) remains the one source
 * of truth for "done / failed / where is my review page". A dropped stream
 * costs theater, not outcomes.
 */

export interface OutlineStreamEvent {
  /** Monotonic per-stream index, for replay-from-N. */
  i: number;
  /** "delta" = model text; "note" = phase marker (thinking|writing|polish|restart). */
  kind: "delta" | "note";
  data: string;
}

interface OutlineStream {
  events: OutlineStreamEvent[];
  subscribers: Set<(ev: OutlineStreamEvent) => void>;
  done: boolean;
  /** Total delta chars, to cap memory on a pathological generation. */
  chars: number;
  closedAt?: number;
}

/**
 * On globalThis, not module scope — the identical move lib/db.ts makes for
 * Prisma and for the identical reason: in dev, the generate job (POST
 * ../route.ts) and the SSE relay (stream/route.ts) live in different route
 * bundles, and a bare module Map can exist once per bundle. The job then
 * pushes into one instance while the relay subscribes to another, and every
 * client is told "unavailable" while the text streams into the void.
 */
const globalForOutline = globalThis as unknown as { __rbOutlineStreams?: Map<string, OutlineStream> };
const streams: Map<string, OutlineStream> = (globalForOutline.__rbOutlineStreams ??= new Map());

/** One outline's text is ~8-16k chars; 512k = deep margin, not a real limit. */
const MAX_CHARS = 512_000;
/** Keep a finished stream around long enough for a reload to replay it. */
const CLOSED_TTL_MS = 10 * 60_000;

const sweep = () => {
  const now = Date.now();
  for (const [id, s] of streams) {
    if (s.done && s.closedAt && now - s.closedAt > CLOSED_TTL_MS) streams.delete(id);
  }
};

export interface OutlineSink {
  push: (delta: string) => void;
  note: (marker: "thinking" | "writing" | "polish" | "restart") => void;
  close: () => void;
}

/** Open (or reset) the stream for one scriptId. Called once per generate job. */
export const openOutlineStream = (scriptId: string): OutlineSink => {
  sweep();
  // A regenerate on the same document replaces the old stream wholesale —
  // subscribers of the previous run get its close and re-open on the new one.
  const prev = streams.get(scriptId);
  if (prev && !prev.done) {
    prev.done = true;
    prev.closedAt = Date.now();
  }
  const s: OutlineStream = { events: [], subscribers: new Set(), done: false, chars: 0 };
  streams.set(scriptId, s);

  const emit = (kind: OutlineStreamEvent["kind"], data: string) => {
    if (s.done) return;
    if (kind === "delta") {
      s.chars += data.length;
      if (s.chars > MAX_CHARS) return; // cap memory; the poll still finishes the job
    }
    const ev: OutlineStreamEvent = { i: s.events.length, kind, data };
    s.events.push(ev);
    for (const cb of s.subscribers) {
      try {
        cb(ev);
      } catch {
        /* a broken subscriber must not stall the generation */
      }
    }
  };

  return {
    push: (delta) => emit("delta", delta),
    note: (marker) => emit("note", marker),
    close: () => {
      if (s.done) return;
      s.done = true;
      s.closedAt = Date.now();
      for (const cb of s.subscribers) {
        try {
          cb({ i: s.events.length, kind: "note", data: "done" });
        } catch {
          /* ditto */
        }
      }
      s.subscribers.clear();
    },
  };
};

/**
 * Subscribe from an event index: replays events[from..] synchronously, then
 * live events until close. Returns an unsubscribe. If no stream exists (other
 * container, process restart), returns null — the caller ends the SSE and the
 * panel falls back to paced steps.
 */
export const subscribeOutlineStream = (
  scriptId: string,
  from: number,
  cb: (ev: OutlineStreamEvent) => void,
): (() => void) | null => {
  const s = streams.get(scriptId);
  if (!s) return null;
  for (let i = Math.max(0, from); i < s.events.length; i++) cb(s.events[i]);
  if (s.done) {
    cb({ i: s.events.length, kind: "note", data: "done" });
    return () => {};
  }
  s.subscribers.add(cb);
  return () => s.subscribers.delete(cb);
};

/** Test seam. */
export const __resetOutlineStreams = () => streams.clear();
