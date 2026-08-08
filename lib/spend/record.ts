/**
 * The spend ledger sink — one durable row per paid provider call.
 *
 * THE PROBLEM THIS EXISTS FOR (measured, 2026-08-08): Fireworks' dashboard
 * said $37.69 for August; our own records covered $6.52. Fireworks exposes no
 * usage or billing API to reconcile against — /v1/accounts/{id}/usage,
 * /billing and /invoices all 404 on this account — so OUR ledger has to BE the
 * exact number. It can be: every completion response carries exact
 * prompt_tokens / completion_tokens.
 *
 * The gap was never a missing function. recordUsage() had eight call sites.
 * It was that recording was a PER-CALL-SITE CONVENTION, so every surface
 * written after the convention never opted in: the production outline route,
 * image-attachment OCR, suggest-layout, ~12 offline scripts, and an esbuild
 * lab bundle (.data/outline-matrix/gen.mjs) that ran ~180 paid generations
 * over two days with `recordUsage` tree-shaken out of it entirely. That last
 * one alone accounts for roughly the whole $31.17 gap.
 *
 * So the write lives INSIDE the transports (lib/llm/cast-provider.ts,
 * lib/render/zai-vision.ts × 2, lib/llm/image-provider.ts). A new route cannot
 * forget, and an offline script that imports the real transport records
 * automatically — including the esbuild-bundle pattern, because the recorder
 * is now REACHED from castCall rather than being an unused export.
 *
 * BEST EFFORT, ALWAYS. lib/usage.ts states the rule and this module keeps it:
 * usage logging must never break a call. Every path here swallows. But it
 * swallows LOUDLY (console.error) and, when the database write fails, falls
 * back to appending the row to disk rather than dropping it — an undercount
 * here means we do not know what we are spending, which is the whole problem.
 *
 * PRICING IS NOT DUPLICATED. Cost comes from lib/usage.ts's costUsd /
 * imageCostUsd — one RATES table for the whole codebase. A second one would
 * drift, and two ledgers disagreeing about the same call is worse than one
 * ledger being wrong.
 */
import { promises as fs } from "fs";
import path from "path";
import { costUsd, imageCostUsd, type Usage } from "../usage";
import { spendContext } from "./context";
import { noteSpendRecorded } from "./cap";

/**
 * Which RATES table priced these rows. BUMP THIS whenever RATES or IMAGE_RATES
 * in lib/usage.ts changes. lib/usage.ts openly admits the Kimi vision rate is
 * "the K2-lineage estimate — TODO verify against the first Fireworks invoice"
 * and that image rates are rounded UP; token counts are immutable fact, prices
 * are a current belief. Storing both means the first real invoice can re-price
 * history with a script instead of silently rewriting it — or being unable to.
 */
export const RATE_VERSION = "2026-08-08";

/** What a transport hands in. Everything but `model` is optional so a caller
 *  can never be blocked from recording by a field it does not have. */
export interface SpendEntry {
  /** The WIRE model id — what the provider actually bills. */
  model: string;
  provider?: string;
  /** Explicit label from the caller. Highest precedence. */
  stage?: string;
  /**
   * The transport's own fallback, used only when neither the caller nor the
   * ambient context named a stage. Ordering matters and is deliberate:
   * caller → context → transport default → "unattributed". A transport
   * default that OUTRANKED the context would make every crawl vision call
   * read "vision" and quietly erase the fact that it was a crawl.
   */
  defaultStage?: string;
  ownerId?: string;
  scriptId?: string;
  runId?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** prompt_tokens_details.cached_tokens — recorded, deliberately not discounted. */
  cachedTokens?: number;
  images?: number;
  latencyMs?: number;
  /** false = we paid (or may have) and got nothing usable. */
  ok?: boolean;
  /** Provider may have billed but reported no usage we could read. */
  tokensUnknown?: boolean;
  /** Test/replay override; defaults to now. */
  at?: Date;
}

export interface SpendRow {
  at: Date;
  provider: string;
  model: string;
  stage: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  images: number;
  costUsd: number;
  rateVersion: string;
  ownerId: string | null;
  scriptId: string | null;
  runId: string | null;
  ok: boolean;
  tokensUnknown: boolean;
  latencyMs: number | null;
  origin: string;
}

const int = (n: number | undefined): number =>
  Number.isFinite(n) && (n as number) > 0 ? Math.round(n as number) : 0;

/**
 * Where this row came from. NEXT_RUNTIME is set by the Next.js server and by
 * nothing else, so a plain `node scripts/…` run is distinguishable from a
 * customer request without anyone remembering to say so. That distinction is
 * not cosmetic: offline lab spend was the MAJORITY of August, and unit
 * economics computed over a table that mixes the two are fiction.
 */
export const spendOrigin = (): string =>
  process.env.RB_SPEND_ORIGIN || (process.env.NEXT_RUNTIME ? "web" : "script");

/**
 * PURE: build the row that gets persisted, including the cost math.
 *
 * Cached tokens are recorded but priced at the FULL input rate — i.e. they are
 * NOT subtracted out of prompt_tokens. Fireworks' cached-input semantics are
 * unverified on this account (no invoice has landed yet, and a live probe
 * costs money), and lib/usage.ts's standing rule is to err on overstating,
 * never under. The count is stored so the correction is a re-price, not a
 * re-collection.
 */
export const makeSpendRow = (entry: SpendEntry, ctx = spendContext()): SpendRow => {
  const usage: Usage = {
    input_tokens: int(entry.inputTokens),
    output_tokens: int(entry.outputTokens),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  const images = int(entry.images);
  return {
    at: entry.at ?? new Date(),
    provider: entry.provider ?? "fireworks",
    model: entry.model,
    // A missing label must never lose the row. "unattributed" is honest and
    // is itself the signal that an entrypoint still needs a withSpend() wrap.
    stage: entry.stage ?? ctx.stage ?? entry.defaultStage ?? "unattributed",
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cachedTokens: int(entry.cachedTokens),
    images,
    costUsd: Number(
      (costUsd(entry.model, usage) + imageCostUsd(entry.model, images)).toFixed(8),
    ),
    rateVersion: RATE_VERSION,
    ownerId: entry.ownerId ?? ctx.ownerId ?? null,
    scriptId: entry.scriptId ?? ctx.scriptId ?? null,
    runId: entry.runId ?? ctx.runId ?? null,
    ok: entry.ok ?? true,
    tokensUnknown: entry.tokensUnknown ?? false,
    latencyMs: entry.latencyMs === undefined ? null : Math.max(0, Math.round(entry.latencyMs)),
    origin: spendOrigin(),
  };
};

/** Local fallback file. Overridable so tests can exercise the REAL append path
 *  (including concurrency) without writing into the developer's own ledger. */
const spendLogPath = (): string =>
  process.env.RB_SPEND_LOG || path.join(process.cwd(), ".data", "spend.jsonl");

const appendJsonl = async (row: SpendRow): Promise<void> => {
  const file = spendLogPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  // One appendFile per row, no read-modify-write: POSIX O_APPEND makes writes
  // under PIPE_BUF atomic, and a row is ~300 bytes, so concurrent transports
  // interleave whole lines rather than corrupting each other. That property is
  // the reason this is not a "read the file, push, write it back".
  await fs.appendFile(file, JSON.stringify({ ...row, at: row.at.toISOString() }) + "\n", "utf8");
};

/**
 * Test seam. lib/spend/*.test.ts swaps the writer so the suite can assert on
 * rows without a database and without network. Precedent:
 * resetZaiBreakerForTests in lib/zai-breaker.ts.
 */
type Writer = (row: SpendRow) => Promise<void>;
let testWriter: Writer | null = null;
export const __setSpendWriterForTests = (w: Writer | null): void => {
  testWriter = w;
};

const writeRow = async (row: SpendRow): Promise<void> => {
  if (testWriter) return testWriter(row);
  if (!process.env.DATABASE_URL) {
    // No database configured (a bare offline script, a fresh checkout). Disk
    // is worse than Postgres but infinitely better than nothing, and
    // scripts/spend-report.mjs merges it back in.
    return appendJsonl(row);
  }
  // Lazy import: keeps @prisma/client out of the eager module graph of the
  // transports, which are bundled into offline scripts and (via esbuild) into
  // lab harnesses where a top-level `new PrismaClient()` would throw before
  // the first line of work.
  const { prisma, withDbRetry } = await import("../db");
  // withDbRetry, not a bare create: Neon scales compute to zero, and the first
  // query after an idle period loses Prisma's connect race (P1001). A single
  // retry after 2.5s is what the rest of the app uses for exactly this.
  await withDbRetry(() =>
    prisma.spendRecord.create({
      data: {
        at: row.at,
        provider: row.provider,
        model: row.model,
        stage: row.stage,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cachedTokens: row.cachedTokens,
        images: row.images,
        costUsd: row.costUsd,
        rateVersion: row.rateVersion,
        ownerId: row.ownerId,
        scriptId: row.scriptId,
        runId: row.runId,
        ok: row.ok,
        tokensUnknown: row.tokensUnknown,
        latencyMs: row.latencyMs,
        origin: row.origin,
      },
    }),
  );
};

/** In-flight writes, so an offline script can await them before exiting. */
const inFlight = new Set<Promise<void>>();

/**
 * Record one paid provider call. NEVER throws, NEVER rejects — the returned
 * promise always resolves, so a transport can `void` it or await it and
 * neither can be poisoned by the ledger.
 *
 * RB_SPEND_DISABLE=1 turns it off entirely, mirroring RB_USAGE_DISABLE: the
 * test runner loads .env.local (so every test process is armed with a real
 * DATABASE_URL) and unit tests drive real orchestrators. Without an off
 * switch a test run writes phantom money into the launch ledger.
 */
export const recordSpend = (entry: SpendEntry): Promise<void> => {
  if (process.env.RB_SPEND_DISABLE === "1") return Promise.resolve();
  let row: SpendRow;
  try {
    row = makeSpendRow(entry);
  } catch (err) {
    console.error("[spend] could not build row (spend NOT counted):", err);
    return Promise.resolve();
  }
  const p = writeRow(row)
    .catch(async (err) => {
      // Loud, not quiet: an undercount here is the exact failure this table
      // was built to end. Then try disk, so the row survives at least until
      // the container does.
      console.error(
        `[spend] DB write failed for ${row.stage}/${row.model} $${row.costUsd} — falling back to disk:`,
        err,
      );
      try {
        await appendJsonl(row);
      } catch (err2) {
        console.error("[spend] disk fallback ALSO failed — this spend is unrecorded:", err2);
      }
    })
    .finally(() => {
      inFlight.delete(p);
    });
  inFlight.add(p);

  // WRITE-DRIVEN THRESHOLD CHECK. A runaway loop should be caught by its own
  // spending rather than by whoever next looks at a dashboard. Throttled to
  // one ledger read a minute inside noteSpendRecorded(), synchronous, never
  // throws, and deliberately NOT awaited — it must not be on the critical path
  // of the call that just finished. (/api/health drives the same function as a
  // heartbeat, for the case where spend stops and nobody is generating.)
  noteSpendRecorded();

  return p;
};

/**
 * Await every in-flight ledger write. Offline scripts should call this before
 * they finish: `void recordSpend(...)` keeps the event loop alive on its own,
 * but a script that calls process.exit() would drop the last rows — which is
 * precisely the class of script whose spend went missing in August.
 */
export const flushSpend = async (): Promise<void> => {
  while (inFlight.size > 0) await Promise.all([...inFlight]);
};
