/**
 * SPECULATIVE SCAFFOLD (founder go, 2026-08-19). The ~49s design-foundation
 * stage runs WHILE the user reads the outline's approval beat, so clicking
 * "Build the deck" starts from a finished scaffold instead of a cold one.
 *
 * Correctness posture:
 * - The artifact is keyed on a hash of the WHOLE script: any refine — copy
 *   included — discards it. Conservative on purpose; the founder priced the
 *   waste (~$0.15) and took it.
 * - The build waits briefly for an in-flight speculative run (the common
 *   case: user clicks Build within the scaffold's own runtime) instead of
 *   double-paying.
 * - Everything is fail-open: a missing, stale, or unfit artifact means the
 *   build runs its own scaffold exactly as before.
 */
import { promises as fs } from "fs";
import path from "path";
import { createHash } from "crypto";
import type { Script } from "../../src/schema";

const DIR = path.join(process.cwd(), ".data", "prescaffold");
const ARTIFACT_TTL_MS = 15 * 60 * 1000;
const INFLIGHT_TTL_MS = 90 * 1000;

export const scriptHash = (script: Script): string =>
  createHash("sha1").update(JSON.stringify(script)).digest("hex");

const artifactPath = (scriptId: string): string => path.join(DIR, `${scriptId}.json`);
const inflightPath = (scriptId: string): string => path.join(DIR, `${scriptId}.inflight`);

export interface PrescaffoldArtifact {
  hash: string;
  code: string;
  at: number;
}

export const writeInflight = async (scriptId: string): Promise<void> => {
  await fs.mkdir(DIR, { recursive: true });
  await fs.writeFile(inflightPath(scriptId), String(Date.now()), "utf8");
};

export const clearInflight = async (scriptId: string): Promise<void> => {
  await fs.rm(inflightPath(scriptId), { force: true });
};

export const writeArtifact = async (scriptId: string, artifact: PrescaffoldArtifact): Promise<void> => {
  await fs.mkdir(DIR, { recursive: true });
  await fs.writeFile(artifactPath(scriptId), JSON.stringify(artifact), "utf8");
};

/** Fresh artifact matching this exact script, or null. */
export const readArtifact = async (scriptId: string, script: Script): Promise<PrescaffoldArtifact | null> => {
  try {
    const raw = JSON.parse(await fs.readFile(artifactPath(scriptId), "utf8")) as PrescaffoldArtifact;
    if (!raw?.code || raw.hash !== scriptHash(script)) return null;
    if (Date.now() - raw.at > ARTIFACT_TTL_MS) return null;
    return raw;
  } catch {
    return null;
  }
};

/** True while a speculative run for this doc looks alive. */
export const inflightFresh = async (scriptId: string): Promise<boolean> => {
  try {
    const at = Number(await fs.readFile(inflightPath(scriptId), "utf8"));
    return Number.isFinite(at) && Date.now() - at < INFLIGHT_TTL_MS;
  } catch {
    return false;
  }
};

/**
 * The build's entry: wait briefly for an in-flight speculative run (user
 * clicked Build during the scaffold's own runtime — the COMMON case), then
 * return whatever fresh artifact exists.
 */
export const awaitArtifact = async (scriptId: string, script: Script): Promise<PrescaffoldArtifact | null> => {
  const direct = await readArtifact(scriptId, script);
  if (direct) return direct;
  if (!(await inflightFresh(scriptId))) return null;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2_000));
    const found = await readArtifact(scriptId, script);
    if (found) return found;
    if (!(await inflightFresh(scriptId))) return null;
  }
  return null;
};
