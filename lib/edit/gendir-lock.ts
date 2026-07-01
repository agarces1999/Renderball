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
const chains = new Map<string, Promise<unknown>>();

export const withGenDirLock = async <T>(genDir: string, fn: () => Promise<T>): Promise<T> => {
  const prior = chains.get(genDir) ?? Promise.resolve();
  // Run fn once the prior op settles, regardless of whether it resolved or threw.
  const run = prior.then(fn, fn);
  // Keep a non-throwing tail as the chain head so one failed op can't break the queue.
  chains.set(genDir, run.then(() => {}, () => {}));
  return run;
};
