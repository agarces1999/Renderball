/**
 * Outline stream sink — replay, live fan-out, close semantics, and the
 * "no stream here" answer the SSE route turns into a client fallback.
 */
import {
  openOutlineStream,
  subscribeOutlineStream,
  __resetOutlineStreams,
  type OutlineStreamEvent,
} from "./outline-stream";

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
const collect = () => {
  const evs: OutlineStreamEvent[] = [];
  return { evs, cb: (ev: OutlineStreamEvent) => evs.push(ev) };
};

console.log("outline-stream (the ceremony sink)");

check("a late subscriber replays everything, then rides live", () => {
  __resetOutlineStreams();
  const sink = openOutlineStream("doc1");
  sink.note("thinking");
  sink.push("{\"scenes\":[");
  const { evs, cb } = collect();
  const un = subscribeOutlineStream("doc1", 0, cb);
  assert(un !== null, "stream must exist");
  assert(evs.length === 2 && evs[0].data === "thinking" && evs[1].data === "{\"scenes\":[", "replayed both events in order");
  sink.push("{\"label\":\"x\"}");
  assert(evs.length === 3 && evs[2].kind === "delta", "live delta reached the subscriber");
  un!();
  sink.push("ignored");
  assert(evs.length === 3, "unsubscribed = no more events");
});

check("from=N skips what the client already has", () => {
  __resetOutlineStreams();
  const sink = openOutlineStream("doc2");
  sink.push("a");
  sink.push("b");
  sink.push("c");
  const { evs, cb } = collect();
  subscribeOutlineStream("doc2", 2, cb);
  assert(evs.length === 1 && evs[0].data === "c", `replay from index 2 = just "c", got ${JSON.stringify(evs)}`);
});

check("close notifies live subscribers with done; later subscribers get done immediately", () => {
  __resetOutlineStreams();
  const sink = openOutlineStream("doc3");
  const live = collect();
  subscribeOutlineStream("doc3", 0, live.cb);
  sink.push("text");
  sink.close();
  assert(live.evs.some((e) => e.kind === "note" && e.data === "done"), "live subscriber saw done");
  const late = collect();
  const un = subscribeOutlineStream("doc3", 0, late.cb);
  assert(un !== null, "closed stream still replayable inside the TTL");
  assert(late.evs[0]?.data === "text", "late subscriber got the text");
  assert(late.evs.at(-1)?.data === "done", "…then done");
});

check("no stream = null (the route 'unavailable' path)", () => {
  __resetOutlineStreams();
  assert(subscribeOutlineStream("ghost", 0, () => {}) === null, "unknown scriptId must return null");
});

check("re-opening a document replaces the old stream wholesale", () => {
  __resetOutlineStreams();
  const first = openOutlineStream("doc4");
  first.push("old run");
  openOutlineStream("doc4");
  const { evs, cb } = collect();
  subscribeOutlineStream("doc4", 0, cb);
  assert(!evs.some((e) => e.data === "old run"), "old run's text must not replay into the new run");
  first.push("zombie");
  const after = evs.length;
  assert(!evs.some((e) => e.data === "zombie") && evs.length === after, "the replaced sink is dead");
});

check("pushes after close are dropped", () => {
  __resetOutlineStreams();
  const sink = openOutlineStream("doc5");
  sink.close();
  sink.push("late");
  const { evs, cb } = collect();
  subscribeOutlineStream("doc5", 0, cb);
  assert(evs.length === 1 && evs[0].data === "done", "only the done marker survives");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
