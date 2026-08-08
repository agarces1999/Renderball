import { NextResponse } from "next/server";
import { prisma } from "../../../lib/db";
import { isStorageConfigured } from "../../../lib/storage/r2";
import { spendCapState, zaiBreakerState } from "../../../lib/zai-breaker";
import { billingProvider } from "../../../lib/billing-provider";
import { isAlertingConfigured } from "../../../lib/alert";
import { noteSpendRecorded } from "../../../lib/spend/cap";

/**
 * Is the app actually working?
 *
 * /api/version answers "what code is running". This answers the different and
 * more urgent question: can that code reach the things it needs. An uptime
 * monitor pointed here (UptimeRobot's free tier, Railway's healthcheck, curl in
 * cron) turns a silent outage into a notification, which until now did not
 * exist at all — the app could lose its database and nobody would learn it from
 * anywhere but a user complaint.
 *
 * Public on purpose: a check that needs a session cannot be used by a monitor.
 * That constrains what may appear here, and the rule is strict — this endpoint
 * reveals whether a dependency is reachable and NOTHING about what is in it. No
 * counts, no ids, no configuration values, no error text from the driver (which
 * routinely contains the connection string).
 *
 * 200 when everything essential is up, 503 when something is not, so a monitor
 * can alert on status code alone without parsing the body.
 */
export const dynamic = "force-dynamic";

type CheckState = "ok" | "down" | "not-configured";

/**
 * A public endpoint that touches the database on every request is a free
 * amplifier for anyone who wants to hammer it. Ten seconds of cache makes a
 * flood cost one query while staying far inside any sane monitor's interval.
 */
const CACHE_MS = 10_000;
let cached: { at: number; body: Record<string, unknown>; healthy: boolean } | null = null;

const timed = async <T>(what: string, fn: () => Promise<T>, ms = 4000): Promise<T> => {
  return Promise.race([
    fn(),
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms)),
  ]);
};

const checkDb = async (): Promise<CheckState> => {
  try {
    // The cheapest possible round trip that proves the connection AND that Neon
    // has woken up — a cold serverless database is the failure this catches most.
    await timed("database", () => prisma.$queryRaw`SELECT 1`);
    return "ok";
  } catch {
    return "down";
  }
};

export async function GET() {
  const now = Date.now();

  // THE SPEND HEARTBEAT. Thresholds have to be evaluated by something that
  // runs whether or not anyone is generating, and this app has no cron. Health
  // is the one endpoint production is guaranteed to poll (Railway's healthcheck
  // and any uptime monitor), which makes it the cheapest trigger available.
  // noteSpendRecorded() is throttled to one ledger read a minute and never
  // throws, so a flood of health checks costs one query and cannot fail this
  // endpoint. Deliberately OUTSIDE the response cache: the tick should happen
  // even when the cached body is served.
  noteSpendRecorded();

  if (cached && now - cached.at < CACHE_MS) {
    return NextResponse.json(cached.body, {
      status: cached.healthy ? 200 : 503,
      headers: { "cache-control": "no-store, max-age=0" },
    });
  }

  const db = await checkDb();
  const breaker = zaiBreakerState();
  const cap = spendCapState();

  const checks = {
    // Essential: without it nothing in the product works.
    database: db,
    // Built decks are restored from object storage on a cold container. Missing
    // config is a deployment mistake, not an outage, so it reads distinctly.
    storage: isStorageConfigured() ? ("ok" as CheckState) : ("not-configured" as CheckState),
    // Open means every build, generate and regenerate is failing fast. The
    // product still serves and edits existing decks, so this is degraded, not
    // dead — but it is the thing most worth being woken up for.
    //
    // Our own spend cap stops generation just as completely as an empty
    // provider account, so it belongs in the same field: a monitor asking "can
    // people generate?" must get "no" either way.
    generation: breaker.open || cap.tripped ? ("down" as CheckState) : ("ok" as CheckState),
    // WHY generation is down, without saying what anything cost. A boolean is
    // the most this public endpoint may carry (see the docstring's rule): it
    // is outage-shaped, and it distinguishes "the provider ran out" from "we
    // stopped ourselves", which are opposite actions. No dollars, no
    // thresholds, no counts — those are GET /api/admin/spend.
    spendCap: cap.tripped ? ("down" as CheckState) : ("ok" as CheckState),
    billing: billingProvider() === "none" ? ("not-configured" as CheckState) : ("ok" as CheckState),
    alerting: isAlertingConfigured() ? ("ok" as CheckState) : ("not-configured" as CheckState),
    // Without this secret, deleting an account in Clerk's own UI silently
    // keeps every document — the sync path is env-gated off. Self-serve
    // deletion (POST /api/account/delete) works regardless; this flags the
    // Clerk-side path.
    clerkWebhook: process.env.CLERK_WEBHOOK_SIGNING_SECRET
      ? ("ok" as CheckState)
      : ("not-configured" as CheckState),
  };

  // Only the database and generation can fail this check. "not-configured" is a
  // statement about a launch checklist, not an incident, and a monitor that
  // pages for it would be teaching its owner to ignore it.
  const healthy = checks.database === "ok" && checks.generation === "ok";

  const body = {
    status: healthy ? "ok" : "degraded",
    checks,
    uptimeSeconds: Math.round(process.uptime()),
    // WHICH COMMIT is actually serving. Without this, "is it deployed?" can
    // only be answered by inference — comparing a restart time against a
    // commit time — which is right until the day a build fails and the old
    // process keeps answering happily. Railway injects the SHA; the fallbacks
    // cover other hosts, and "unknown" is honest when nothing sets it.
    commit: (
      process.env.RAILWAY_GIT_COMMIT_SHA ||
      process.env.VERCEL_GIT_COMMIT_SHA ||
      process.env.GIT_COMMIT_SHA ||
      "unknown"
    ).slice(0, 7),
  };
  cached = { at: now, body, healthy };

  return NextResponse.json(body, {
    status: healthy ? 200 : 503,
    headers: { "cache-control": "no-store, max-age=0" },
  });
}
