import { prisma } from "../db";

/**
 * Notice when the ledger has gone deaf.
 *
 * THE FAILURE THIS EXISTS FOR: in August the provider dashboard said $37.69
 * and our records held $6.52. Nothing was broken — a path simply never wrote
 * to the ledger, and silence looks exactly like thrift. The gap was found by
 * the founder reading a billing chart, three weeks late.
 *
 * Metering the transports fixes today. It does not fix the day someone adds a
 * surface, or a refactor drops the call, or an env var quietly disables the
 * write — and by construction those all present as a ledger that reports
 * nothing while money leaves. A number that can only ever be too low is not a
 * number you can launch on.
 *
 * So this asks the one question a spend ledger cannot answer about itself:
 * ARE WE GENERATING WITHOUT RECORDING? Documents are being written; spend rows
 * are not appearing. Both live in the same Postgres, so this holds across
 * instances and survives a restart — unlike anything counted in memory.
 *
 * Deliberately NOT a cost threshold. A cap answers "are we spending too much";
 * this answers "are we spending blind", which is the more dangerous state
 * because it is invisible in every dashboard we own.
 */

/** How far back to compare. Long enough that a quiet hour is not an alarm. */
const WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * Below this, silence is not evidence. One document could be a blank created
 * and abandoned before it ever reached a model — that spends nothing and
 * SHOULD record nothing.
 */
const MIN_DOCS = 3;

export interface LedgerSilence {
  /** True when documents were generated and not one spend row appeared. */
  silent: boolean;
  documents: number;
  spendRows: number;
  windowHours: number;
  /** Human sentence for the alert channel. Empty when healthy. */
  reason: string;
}

/**
 * @param now injectable so the test does not depend on the wall clock.
 */
export const checkLedgerSilence = async (now: Date = new Date()): Promise<LedgerSilence> => {
  const since = new Date(now.getTime() - WINDOW_MS);
  const windowHours = WINDOW_MS / 3_600_000;

  // Best effort by design: a monitoring query must never take the product
  // down. A database that cannot answer is reported as "not silent" rather
  // than as an alarm — a false alarm here trains everyone to ignore the real
  // one, which is precisely how the last signal died.
  try {
    const [documents, spendRows] = await Promise.all([
      prisma.scriptDoc.count({ where: { updatedAt: { gte: since } } }),
      prisma.spendRecord.count({ where: { at: { gte: since } } }),
    ]);

    const silent = documents >= MIN_DOCS && spendRows === 0;
    return {
      silent,
      documents,
      spendRows,
      windowHours,
      reason: silent
        ? `${documents} documents changed in the last ${windowHours}h and the spend ledger recorded NOTHING. ` +
          `Either generation is unwired from the ledger, or the ledger cannot write. ` +
          `Spend is happening that we cannot see — this is the $31 failure repeating.`
        : "",
    };
  } catch {
    return { silent: false, documents: 0, spendRows: 0, windowHours, reason: "" };
  }
};
