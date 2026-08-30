/**
 * Forensics for refused model-written code (founder, 2026-08-29).
 *
 * A generated element that fails the commit gate used to be destroyed with
 * zero trace — the founder's "why did my chart fail?" was unanswerable by
 * anyone, prod logs included. Every refusal now writes a sidecar under
 * lego/refused/ carrying the prompt, the refused code, and the ACTUAL
 * compile/render error. The directory rides persistGenDir into durable
 * storage, so a hydrated bundle answers the question months later.
 *
 * Log-only path: every failure here is swallowed. Recording a refusal must
 * never break the edit that is being refused.
 */
import { promises as fs } from "fs";
import path from "path";

/** Keep the last N refusals per document — forensic value decays fast and the
 *  sidecars ride the doc bundle, so unbounded growth would bloat every
 *  hydrate. 8 covers a frustrated retry burst with room to spare. */
const KEEP = 8;

export interface RefusedEntry {
  op: string;
  sceneIndex: number;
  prompt?: string;
  /** The inner JSX the model emitted — the thing that was refused. */
  body: string;
  /** The commit gate's actual error (compile message or per-page render error). */
  error: string;
  model?: string;
  attempt?: number;
}

export const recordRefused = async (genDir: string, entry: RefusedEntry): Promise<void> => {
  try {
    const dir = path.join(genDir, "lego", "refused");
    await fs.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await fs.writeFile(
      path.join(dir, `${stamp}.json`),
      JSON.stringify({ at: new Date().toISOString(), ...entry }, null, 2),
      "utf8",
    );
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json")).sort();
    for (const stale of files.slice(0, Math.max(0, files.length - KEEP))) {
      await fs.rm(path.join(dir, stale), { force: true });
    }
  } catch {
    /* forensics must never break the edit */
  }
};
