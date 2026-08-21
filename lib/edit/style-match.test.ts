/**
 * Style-match resolution — the pure parts (reference picking, prompt
 * composition) plus the provenance merge that keeps a cached descriptor
 * alive across route re-records.
 */
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { pickStyleReference, withStyleHint } from "./style-match";
import { mergeProvenance, readProvenance, type ProvenanceMap } from "./provenance";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
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

console.log("style-match (icon/image family resolution)");

const gm = (kind: "icon" | "image", seed: number, extra: Record<string, unknown> = {}) => ({
  kind,
  model: `m-${kind}`,
  seed,
  assetRef: `assets/img-${seed}.png`,
  ...extra,
});

await check("picks the NEWEST same-kind generated piece; ignores other kinds and meta-less entries", () => {
  const map: ProvenanceMap = {
    "s0.a": { origin: "marquee", at: "2026-08-14T10:00:00Z", genMeta: gm("icon", 11) },
    "s0.b": { origin: "marquee", at: "2026-08-14T12:00:00Z", genMeta: gm("icon", 22) },
    "s0.c": { origin: "marquee", at: "2026-08-14T13:00:00Z", genMeta: gm("image", 33) },
    "s0.d": { origin: "marquee", at: "2026-08-14T14:00:00Z" },
  };
  const ref = pickStyleReference(map, "icon");
  assert(ref?.pieceId === "s0.b" && ref.genMeta.seed === 22, `newest icon, got ${ref?.pieceId}`);
  const img = pickStyleReference(map, "image");
  assert(img?.pieceId === "s0.c", "image kind resolves independently");
  assert(pickStyleReference({}, "icon") === null, "empty map → null (fresh first icon, not an error)");
});

await check("withStyleHint appends only when a descriptor exists", () => {
  assert(withStyleHint("a rocket", "bold outlines, flat orange") === "a rocket, in this exact visual family: bold outlines, flat orange", "appended");
  assert(withStyleHint("a rocket", undefined) === "a rocket", "unchanged without a descriptor");
});

await check("mergeProvenance keeps a cached descriptor through a route re-record", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rb-style-"));
  try {
    // Generation day: the route records origin+prompt, then merges genMeta.
    await mergeProvenance(dir, "s0.add1", { origin: "marquee", prompt: "a rocket" });
    await mergeProvenance(dir, "s0.add1", { genMeta: gm("icon", 77) });
    // First match: descriptor cached onto the entry.
    await mergeProvenance(dir, "s0.add1", { genMeta: { ...gm("icon", 77), styleDescriptor: "bold flat orange" } });
    // A later regen re-records origin+prompt…
    await mergeProvenance(dir, "s0.add1", { origin: "regen", prompt: "make it warmer" });
    // …and the route re-merges the fresh genMeta (no descriptor yet for the new pixels).
    await mergeProvenance(dir, "s0.add1", { genMeta: gm("icon", 78) });
    const map = await readProvenance(dir);
    const e = map["s0.add1"];
    assert(e.origin === "regen" && e.prompt === "make it warmer", "the patch wins on origin/prompt");
    assert(e.genMeta?.seed === 78, "fresh genMeta wins on seed");
    // The descriptor described the OLD asset's pixels — a fresh assetRef must
    // shed it (it gets recomputed from the new pixels on the next match).
    assert(e.genMeta?.styleDescriptor === undefined, `stale descriptor dropped, got ${JSON.stringify(e.genMeta?.styleDescriptor)}`);
    // Same-asset merges DO keep it — that is the cache working.
    await mergeProvenance(dir, "s0.add1", { genMeta: { ...gm("icon", 78), styleDescriptor: "navy sticker style" } });
    await mergeProvenance(dir, "s0.add1", { genMeta: gm("icon", 78) });
    const map2 = await readProvenance(dir);
    assert(map2["s0.add1"].genMeta?.styleDescriptor === "navy sticker style", "same-asset merge preserves the cache");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

await check("REGRESSION: regenerating a generated icon keeps it eligible as a style reference", async () => {
  // The bug: the regenerate route wrote provenance with a REPLACING writer, so
  // `genMeta` vanished and pickStyleReference — which skips any entry without
  // one — stopped seeing the piece. "Match my existing icons" lost the family
  // the first time you regenerated a member of it, with nothing shown to say so.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rb-style-"));
  try {
    await mergeProvenance(dir, "s0.icon", { origin: "marquee", prompt: "a shield" });
    await mergeProvenance(dir, "s0.icon", { genMeta: { ...gm("icon", 42), styleDescriptor: "navy line art" } });
    assert(pickStyleReference(await readProvenance(dir), "icon")?.pieceId === "s0.icon", "reference before the regen");

    // Exactly what app/api/preview/regenerate-element/route.ts writes.
    await mergeProvenance(dir, "s0.icon", { origin: "regen", prompt: "make it warmer" });

    const ref = pickStyleReference(await readProvenance(dir), "icon");
    assert(ref?.pieceId === "s0.icon", "the regenerated icon must still be a style reference");
    assert(ref?.genMeta.seed === 42, "its generation facts must survive the regen record");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

await check("`at` means CREATED, so the newest-made asset wins the reference, not the newest-touched", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rb-style-"));
  try {
    await mergeProvenance(dir, "s0.old", { origin: "marquee", genMeta: gm("icon", 1) });
    await new Promise((r) => setTimeout(r, 5));
    await mergeProvenance(dir, "s0.new", { origin: "marquee", genMeta: gm("icon", 2) });
    await new Promise((r) => setTimeout(r, 5));
    // Touching the OLDER one must not promote it over the one made later.
    await mergeProvenance(dir, "s0.old", { origin: "regen", prompt: "tweak" });
    assert(pickStyleReference(await readProvenance(dir), "icon")?.pieceId === "s0.new", "creation order decides");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
