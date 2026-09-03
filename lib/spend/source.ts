/**
 * Where spend rows are read FROM.
 *
 * Two sources, and the priority between them is the whole point:
 *
 *   POSTGRES (SpendRecord) — the source of truth. It is the only one that
 *   survives a deploy and the only one a second container can see.
 *
 *   .data/usage.jsonl — the legacy/offline file, read ONLY when Postgres is
 *   not available, or when the caller explicitly asks (`includeJsonl`) to see
 *   history. Never merged silently: if a call is in both, merging DOUBLE
 *   COUNTS, and a spend number that reads high is just as useless as one that
 *   reads low. That is why the merge is opt-in and the integrity report calls
 *   it out when it happens.
 *
 * WHY `.data` cannot be the ledger (this is settled, with receipts):
 *   · `.dockerignore` excludes `.data` from the image, so a fresh container
 *     starts with none of it.
 *   · lib/render/gen-store.ts exists BECAUSE of this exact failure class —
 *     "every deploy destroyed every user's work" (2026-07-25 launch blockers).
 *   · prisma/schema.prisma's OpWindow comment says it plainly: the in-process
 *     version "reset on every deploy … and could not see a second container."
 *     A Railway volume attaches to ONE instance; the day this service runs two
 *     replicas a file ledger is split-brain and structurally undercounts.
 *   · lib/store.ts already made this move once — DEFAULT_BACKEND = "pg" after
 *     migrating 297 briefs out of `.data` for the same reasons. The ledger is
 *     the piece that was left behind.
 *
 * THE WRITER CONTRACT (see the note on `PgSpendRecord` below): this module
 * reads what lib/spend/record.ts writes. It is written to tolerate that
 * writer not existing yet — a container running new code against a database
 * that has not been migrated must degrade to "no Postgres rows", not 500.
 */
import { promises as fs } from "fs";
import path from "path";
import type { LedgerRow } from "./ledger";

// @prisma/client is imported LAZILY, inside readPostgres. Same reason
// lib/spend/record.ts does it: the transports and this reader get bundled into
// offline lab harnesses by esbuild, where a top-level `new PrismaClient()`
// throws before the first line of work when DATABASE_URL is unset. Importing
// it only when there is a database to talk to keeps `npm run spend` usable on
// a bare checkout.

export interface SpendQuery {
  /** Inclusive lower bound. Omitted → everything the source holds. */
  since?: Date;
  /** Exclusive upper bound. */
  until?: Date;
  /** Merge the LEGACY `.data/usage.jsonl` in as well. Opt-in — see above. */
  includeJsonl?: boolean;
  /** Hard row ceiling, so a pathological range cannot exhaust memory. */
  limit?: number;
}

export interface LoadedSpend {
  rows: LedgerRow[];
  /** What actually answered, for the report header. */
  source: "postgres" | "file" | "postgres+file" | "none";
  postgresAvailable: boolean;
  /** Anything the reader should know about HOW this was loaded. */
  notes: string[];
}

/** Rows are capped so a "since the beginning of time" query stays bounded. */
const DEFAULT_LIMIT = 200_000;

/**
 * The shape lib/spend/record.ts writes, as this module needs to read it.
 *
 * Declared structurally rather than imported from @prisma/client on purpose.
 * The SpendRecord model ships in a sibling change; until its migration has run
 * BOTH the generated client (no `prisma.spendRecord` delegate) and the
 * database (no table) can be behind this code. Deploy order is not guaranteed
 * — Railway starts the new container before anyone runs `prisma migrate
 * deploy` — so both states are handled at runtime and neither is an outage:
 * the spend report degrades to "no Postgres rows" and says so.
 */
interface PgSpendRecord {
  at: Date;
  stage: string;
  model: string;
  costUsd: unknown; // Prisma Decimal — see toNumber() below
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  images: number;
  scriptId: string | null;
  ownerId: string | null;
  origin: string;
  ok: boolean;
  tokensUnknown: boolean;
  latencyMs: number | null;
}

interface SpendDelegate {
  findMany: (args: unknown) => Promise<PgSpendRecord[]>;
}

/**
 * The delegate — but a truthy one PROVES NOTHING.
 *
 * Measured, not assumed: Prisma 6's client is a Proxy, so
 * `typeof prisma.spendRecord.findMany === "function"` is true even for a model
 * that does not exist in the schema at all. The call then throws P2021 ("The
 * table `public.SpendRecord` does not exist in the current database"). So the
 * only honest availability test is to run the query and catch — which is also
 * exactly what a container running ahead of `prisma migrate deploy` hits.
 */
const spendDelegate = (client: unknown): SpendDelegate | undefined => {
  const d = (client as { spendRecord?: SpendDelegate }).spendRecord;
  return d && typeof d.findMany === "function" ? d : undefined;
};

/** Prisma messages start with a blank line; the first NON-empty one is the point. */
const firstLine = (err: unknown): string => {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split("\n").map((l) => l.trim()).find(Boolean) ?? "unknown error";
};

/**
 * Prisma Decimal → number.
 *
 * costUsd is Decimal(12,8) so Postgres can SUM it exactly; the client hands
 * back a Decimal.js object, and `Number(obj)` on one of those silently goes
 * through valueOf. Going via toString first is the form that is right for a
 * Decimal, a number, and a string alike — this column has been all three
 * across the two ledgers.
 */
const toNumber = (v: unknown): number => {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (v === null || v === undefined) return 0;
  const n = Number(String(v));
  return Number.isFinite(n) ? n : 0;
};

interface PgRead {
  /** false = Postgres could not answer, so the caller must fall back. */
  available: boolean;
  rows: LedgerRow[];
  notes: string[];
}

const readPostgres = async (q: SpendQuery): Promise<PgRead> => {
  if (!process.env.DATABASE_URL) return { available: false, rows: [], notes: [] };
  const { prisma, withDbRetry } = await import("../db");
  const delegate = spendDelegate(prisma);
  if (!delegate) return { available: false, rows: [], notes: [] };

  const where: Record<string, unknown> = {};
  if (q.since || q.until) {
    where.at = {
      ...(q.since ? { gte: q.since } : {}),
      ...(q.until ? { lt: q.until } : {}),
    };
  }
  try {
    // withDbRetry: Neon scales to zero, and the first read after an idle
    // period loses Prisma's connect race. A spend report that fails because
    // the database was asleep is a spend report nobody runs twice.
    const found = await withDbRetry(() =>
      delegate.findMany({
        where,
        orderBy: { at: "asc" },
        take: q.limit ?? DEFAULT_LIMIT,
      }),
    );
    return {
      available: true,
      rows: found.map((r) => ({
        at: r.at instanceof Date ? r.at : new Date(String(r.at)),
        stage: r.stage,
        model: r.model,
        costUsd: toNumber(r.costUsd),
        inputTokens: r.inputTokens ?? 0,
        outputTokens: r.outputTokens ?? 0,
        cachedTokens: r.cachedTokens ?? 0,
        images: r.images ?? 0,
        scriptId: r.scriptId ?? null,
        ownerId: r.ownerId ?? null,
        origin: r.origin ?? "web",
        ok: r.ok !== false,
        tokensUnknown: r.tokensUnknown === true,
        latencyMs: r.latencyMs ?? null,
        source: "postgres" as const,
      })),
      notes: [],
    };
  } catch (err) {
    // A missing TABLE lands here (P2021), which is both "the sibling migration
    // has not landed" and "this container is ahead of the database". Degrade to
    // unavailable — so the caller falls back to the file and the reader still
    // gets a number — and say exactly what to run. Reporting $0.00 here would
    // be the worst outcome available: a confident, wrong, reassuring zero.
    const code = (err as { code?: string } | null)?.code;
    return {
      available: false,
      rows: [],
      notes: [
        code === "P2021"
          ? "The SpendRecord table does not exist yet — run `npm run db:deploy` (dev: `npm run db:migrate`). Falling back to the local files."
          : `Postgres spend read failed: ${firstLine(err)}. Falling back to the local files.`,
      ],
    };
  }
};

/**
 * Legacy op → stage, so history lines up with the stage vocabulary the
 * transport now records. Anything not listed passes through VERBATIM: an
 * unrecognised op is data, and renaming it to "other" would hide it.
 */
const LEGACY_STAGE: Record<string, string> = {
  generate: "outline",
  build: "build",
  crawl: "crawl",
  // "vision", not "gate.vision" — the vocabulary in prisma/schema.prisma's
  // SpendRecord.stage doc is the one the transports write, and history has to
  // group with it or the breakdown shows the same spend twice under two names.
  "vision-qa": "vision",
  "regen-element": "edit.regen",
  "animate-element": "edit.animate",
  "insert-element": "edit.insert",
  "failed-stream-attempt": "build.failed-stream",
};

interface LegacyRow {
  ts?: string;
  op?: string;
  model?: string;
  scriptId?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  images?: number;
  cost_usd?: number;
  failed?: boolean;
}

export const usageLogPath = (): string => path.join(process.cwd(), ".data", "usage.jsonl");

/** PURE: one legacy JSONL line → a LedgerRow. Null when the line is unusable. */
export const legacyRowToSpendRow = (raw: LegacyRow): LedgerRow | null => {
  if (!raw || typeof raw.ts !== "string") return null;
  const at = new Date(raw.ts);
  if (Number.isNaN(at.getTime())) return null;
  const op = raw.op ?? "unattributed";
  const u = raw.usage ?? {};
  return {
    at,
    stage: LEGACY_STAGE[op] ?? op,
    model: raw.model ?? "unknown",
    costUsd: typeof raw.cost_usd === "number" ? raw.cost_usd : 0,
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cachedTokens: (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    images: raw.images ?? 0,
    scriptId: raw.scriptId ?? null,
    ownerId: null, // the file ledger never carried one
    origin: "legacy-jsonl",
    ok: raw.failed !== true,
    tokensUnknown: false,
    latencyMs: null,
    source: "usage-jsonl",
  };
};

/**
 * The fallback file lib/spend/record.ts writes to when Postgres is unset or a
 * write FAILS. Every row in here is by construction a row that did NOT reach
 * the database, so including it in the total is the opposite of double
 * counting — it is the only way that money appears at all.
 *
 * The path mirrors record.ts's spendLogPath(), RB_SPEND_LOG included, so a
 * test that redirects the writer redirects the reader too.
 */
export const spendLogPath = (): string =>
  process.env.RB_SPEND_LOG || path.join(process.cwd(), ".data", "spend.jsonl");

/** The serialized form of record.ts's SpendRow (`at` becomes an ISO string). */
interface FallbackRow {
  at?: string;
  model?: string;
  stage?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  images?: number;
  costUsd?: number;
  ownerId?: string | null;
  scriptId?: string | null;
  ok?: boolean;
  tokensUnknown?: boolean;
  latencyMs?: number | null;
  origin?: string;
}

/** PURE: one `.data/spend.jsonl` line → a LedgerRow. Null when unusable. */
export const fallbackRowToLedgerRow = (raw: FallbackRow): LedgerRow | null => {
  if (!raw || typeof raw.at !== "string") return null;
  const at = new Date(raw.at);
  if (Number.isNaN(at.getTime())) return null;
  return {
    at,
    stage: raw.stage ?? "unattributed",
    model: raw.model ?? "unknown",
    costUsd: typeof raw.costUsd === "number" ? raw.costUsd : 0,
    inputTokens: raw.inputTokens ?? 0,
    outputTokens: raw.outputTokens ?? 0,
    cachedTokens: raw.cachedTokens ?? 0,
    images: raw.images ?? 0,
    scriptId: raw.scriptId ?? null,
    ownerId: raw.ownerId ?? null,
    origin: raw.origin ?? "script",
    ok: raw.ok !== false,
    tokensUnknown: raw.tokensUnknown === true,
    latencyMs: raw.latencyMs ?? null,
    source: "spend-jsonl",
  };
};

/** Read one JSONL file through a row mapper. Missing file → no rows, no noise. */
const readJsonlFile = async <T>(
  file: string,
  map: (raw: T) => LedgerRow | null,
  q: SpendQuery,
): Promise<{ rows: LedgerRow[]; notes: string[] }> => {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return { rows: [], notes: [] };
  }
  const rows: LedgerRow[] = [];
  let unparsable = 0;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let row: LedgerRow | null;
    try {
      row = map(JSON.parse(t) as T);
    } catch {
      row = null;
    }
    if (!row) {
      unparsable++;
      continue;
    }
    if (q.since && row.at < q.since) continue;
    if (q.until && row.at >= q.until) continue;
    rows.push(row);
  }
  return {
    rows,
    notes: unparsable > 0 ? [`${unparsable} unparsable line(s) in ${file} were skipped.`] : [],
  };
};

/**
 * Load spend rows for a window. Three sources, three different reasons:
 *
 *   Postgres           — the truth, whenever it can answer.
 *   .data/spend.jsonl  — ALWAYS read. Rows here are ones that could not reach
 *                        Postgres, so leaving them out would hide real money.
 *   .data/usage.jsonl  — the pre-SpendRecord ledger. Opt-in only, because
 *                        recordUsage and recordSpend both run today and
 *                        merging them counts the same spend twice.
 *
 * Never throws — every caller is a monitoring surface, and a monitor that dies
 * on a bad row tells you less than one that reports what it could read plus a
 * note about what it could not.
 */
export const loadSpendRows = async (q: SpendQuery = {}): Promise<LoadedSpend> => {
  const pg = await readPostgres(q);

  const fallback = await readJsonlFile(spendLogPath(), fallbackRowToLedgerRow, q);
  const legacy = q.includeJsonl
    ? await readJsonlFile(usageLogPath(), legacyRowToSpendRow, q)
    : { rows: [] as LedgerRow[], notes: [] as string[] };

  const rows = [...pg.rows, ...fallback.rows, ...legacy.rows].sort(
    (a, b) => a.at.getTime() - b.at.getTime(),
  );

  const notes = [...pg.notes, ...fallback.notes, ...legacy.notes];
  if (!pg.available && !process.env.DATABASE_URL) {
    notes.push("DATABASE_URL is not set — reading local files only.");
  }

  const fileRows = fallback.rows.length + legacy.rows.length;
  const source: LoadedSpend["source"] =
    pg.available && fileRows > 0
      ? "postgres+file"
      : pg.available
        ? "postgres"
        : fileRows > 0
          ? "file"
          : "none";

  return { rows, source, postgresAvailable: pg.available, notes };
};
