/**
 * Gate fire-rate telemetry — the DELETION CRITERION from docs/QUALITY-ARCHITECTURE.md.
 *
 * Strategy: gates are cheap, retries are expensive; gates get demoted/deleted only
 * as a CONSEQUENCE of telemetry (N consecutive clean builds per gate), never on
 * faith. This module tallies, per build, how often each check fired — measured
 * render-truth findings, static warnings, vision findings — plus the retry work
 * they caused, and appends one line to `.data/gate-telemetry.jsonl`.
 *
 * Pure tally + best-effort IO (telemetry must never break a build).
 */
import { promises as fs } from "fs";
import path from "path";
import type { RenderTruthFinding } from "./render-truth-gates";

export interface GateTelemetry {
  ts: string;
  scriptId: string;
  /** fires per check key: render-truth kinds, static-warning keys, "vision" */
  fires: Record<string, number>;
  /** repair-ladder steps taken (0 = clean first pass through the measured gates) */
  repairSteps: number;
  /** true when NO blocking finding fired and NO repair step ran — the yield metric */
  firstPassClean: boolean;
  buildWallMs?: number;
}

/** Tally fire counts from every check family. Pure — unit-testable. */
export const tallyGateFires = (input: {
  findings: RenderTruthFinding[];
  /** BuildWarnings or any warnings-shaped object (arrays/counts per key). */
  warnings?: object | null;
  visionFindings?: { scene: number; issue: string }[];
}): Record<string, number> => {
  const fires: Record<string, number> = {};
  const bump = (k: string, n = 1) => {
    fires[k] = (fires[k] ?? 0) + n;
  };
  for (const f of input.findings) bump(f.kind);
  // Static build warnings: each key's fire count is its array length (or 1 for
  // scalars) — the shape buildBuildWarnings emits (undwelled_text: [...], etc.).
  for (const [k, v] of Object.entries(input.warnings ?? {})) {
    if (v == null) continue;
    if (Array.isArray(v)) {
      if (v.length > 0) bump(`warn:${k}`, v.length);
    } else if (typeof v === "number") {
      if (v > 0) bump(`warn:${k}`, v);
    } else {
      bump(`warn:${k}`);
    }
  }
  if (input.visionFindings?.length) bump("vision", input.visionFindings.length);
  return fires;
};

const TELEMETRY_LOG = path.join(process.cwd(), ".data", "gate-telemetry.jsonl");

/** Append one build's telemetry. Best-effort: never throws. */
export const recordGateTelemetry = async (
  entry: Omit<GateTelemetry, "ts"> & { ts?: string },
): Promise<void> => {
  try {
    const rec: GateTelemetry = { ts: entry.ts ?? new Date().toISOString(), ...entry };
    await fs.mkdir(path.dirname(TELEMETRY_LOG), { recursive: true });
    await fs.appendFile(TELEMETRY_LOG, JSON.stringify(rec) + "\n", "utf8");
  } catch (err) {
    console.warn("[gate-telemetry] write skipped:", err instanceof Error ? err.message : err);
  }
};
