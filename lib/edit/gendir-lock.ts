//
// Per-genDir serialization for editor mutations. Every edit op (regenerate, move,
// delete) does a read-modify-write of manifest.json + Composition.tsx. Two edits to
// the same video landing concurrently (a double-click, two open tabs) would race
// that read-modify-write and desync the store from the render. Next.js runs
// same-path POSTs concurrently, so we serialize per genDir in-process: each op
// chains after the previous op for that genDir and runs only once it settles.
//
// In-process only (single Node server) — enough for the realistic double-submit
// case. The map holds one settled-promise tail per edited genDir (tiny); not
// pruned, which is fine for a bounded set of videos in a session.
//
import { stat } from "fs/promises";
import path from "path";
import { healStaleStore } from "../agents/lego-store";

const chains = new Map<string, Promise<unknown>>();

/**
 * genDirs already checked, keyed to the STATE of the store when we checked it.
 *
 * This was a bare Set — check a genDir once per process, never again. That is
 * wrong for the way documents actually arrive: production re-hydrates a genDir
 * from durable storage on read, so the same document can be restored from the
 * same stale snapshot MORE THAN ONCE inside one process. After the first repair
 * the Set said "seen" and every later rehydration went unrepaired, which is the
 * original bug wearing a hat.
 *
 * Keyed on the manifest's size and mtime instead: unchanged store, no work;
 * store rewritten by anything at all, checked again. Found by the QA seam flow
 * that corrupts a document twice in one run — the coarse memo made the second
 * corruption survive, and a passing test would have been the wrong answer.
 */
const healChecked = new Map<string, string>();

/**
 * A document rehydrated from R2 can come back carrying a store that predates its
 * build (see healStaleStore). Every op below reads that store, so the check
 * belongs here — once per genDir per process, before the first mutation, and
 * never fatal: a heal that cannot run leaves the op to fail with its own
 * (accurate) error rather than a new one from the repair.
 */
const storeFingerprint = async (genDir: string): Promise<string> => {
  try {
    const st = await stat(path.join(genDir, "lego", "manifest.json"));
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return "absent";
  }
};

const healOnce = async (genDir: string): Promise<void> => {
  try {
    const before = await storeFingerprint(genDir);
    if (healChecked.get(genDir) === before) return; // same store we already cleared
    await healStaleStore(genDir);
    // Record what we END on: a heal rewrites the manifest, so fingerprinting
    // the pre-heal state would make the next edit re-check for no reason.
    healChecked.set(genDir, await storeFingerprint(genDir));
  } catch (err) {
    console.warn(`[gendir-lock] stale-store check failed for ${genDir}:`, err);
  }
};

export const withGenDirLock = async <T>(genDir: string, fn: () => Promise<T>): Promise<T> => {
  const prior = chains.get(genDir) ?? Promise.resolve();
  // Run fn once the prior op settles, regardless of whether it resolved or threw.
  // The heal runs INSIDE the chain so it cannot race a concurrent op's store read.
  const guarded = async () => {
    await healOnce(genDir);
    return fn();
  };
  const run = prior.then(guarded, guarded);
  // Keep a non-throwing tail as the chain head so one failed op can't break the queue.
  chains.set(genDir, run.then(() => {}, () => {}));
  return run;
};
