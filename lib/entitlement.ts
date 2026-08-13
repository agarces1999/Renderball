/**
 * Metering gate — LAUNCH.md critical-path #4.
 *
 * A FAIL-CLOSED entitlement check that runs BEFORE any paid spend (script
 * generation ~$0.10, build ~$0.60-1.90). Pre-gate, any authed user could
 * trigger unlimited GLM + render spend; the ledger only recorded costs after
 * the fact. Policy:
 *
 *   - Counts come from Prisma UsageRecord (ownerId + operation + createdAt,
 *     indexed), current UTC calendar month, failed rows excluded.
 *   - Limits per plan via env with safe defaults (free: 3 stories / 1 build;
 *     subscription: 60 / 30). Change limits in env, not code.
 *   - DEV_OWNER_ID is exempt — the headless validation loop runs sessionless.
 *   - Any metering error DENIES (fail-closed): an outage must never mean free
 *     unlimited spend. The dev exemption keeps local loops alive regardless.
 *
 * decideEntitlement is pure (unit-tested); the Prisma IO wraps it.
 */
import { prisma } from "./db";
import { DEV_OWNER_ID } from "./store";

export type MeteredOp = "generate" | "build";
export type PlanName = "free" | "subscription";

const envInt = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
};

/**
 * This gate runs BEFORE the token gate in the build route, so whichever is
 * tighter is what the user actually experiences. The free build limit was 1
 * while the landing sells "your first 1,000,000 tokens are free (about three
 * decks)" — users hit a wall at a third of the advertised allowance, which is
 * a refund generator. The default now matches the promise, and the token
 * allowance is intended to be the binding constraint once metering is on.
 */
/**
 * Count caps are ABUSE BACKSTOPS, not the offer (2026-08-13). The advertised
 * free tier is TOKENS ("1M free, then per token" — docs/PIVOT.md), enforced
 * by checkTokenAllowance whenever metering counts. These monthly op counts
 * exist only to bound runaway scripted use if the token meter's write path
 * ever fails (recordTokenUsage fails open into an undercount by design), so
 * they sit far above anything the token allowance permits: 1M tokens buys
 * roughly one or two builds, and the backstop allows twenty-five. The old
 * defaults (3 builds) predate the pivot — they WERE the subscription-era
 * offer, and until tonight they were also the only live wall, which is how
 * the product came to enforce a model the landing page never sold.
 */
export const planLimit = (plan: PlanName, op: MeteredOp): number => {
  if (plan === "subscription") {
    return op === "generate"
      ? envInt("SUB_GENERATES_PER_MONTH", 200)
      : envInt("SUB_BUILDS_PER_MONTH", 100);
  }
  return op === "generate"
    ? envInt("FREE_GENERATES_PER_MONTH", 100)
    : envInt("FREE_BUILDS_PER_MONTH", 25);
};

export interface Entitlement {
  allowed: boolean;
  plan: PlanName;
  op: MeteredOp;
  used: number;
  limit: number;
  /** Present iff denied — safe to show the user verbatim. */
  reason?: string;
}

/** PURE: the decision given a plan and this month's successful-op count. */
export const decideEntitlement = (
  plan: PlanName,
  op: MeteredOp,
  used: number,
): Entitlement => {
  const limit = planLimit(plan, op);
  if (used >= limit) {
    const noun = op === "generate" ? "outlines" : "document builds";
    return {
      allowed: false,
      plan,
      op,
      used,
      limit,
      // Backstop language, not offer language: the free tier is TOKENS, and
      // a user who hits THIS wall is far outside normal use (or the token
      // meter failed) — either way the honest next step is a human.
      reason:
        `That's an unusually high volume this month (${limit} ${noun}) — this cap is a safety ` +
        `limit, not your token allowance. Email support@renderball.com and we'll look at your ` +
        `account right away.`,
    };
  }
  return { allowed: true, plan, op, used, limit };
};

const monthStartUtc = (): Date => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
};

export const checkEntitlement = async (
  ownerId: string,
  op: MeteredOp,
): Promise<Entitlement> => {
  if (ownerId === DEV_OWNER_ID) {
    return { allowed: true, plan: "subscription", op, used: 0, limit: Number.MAX_SAFE_INTEGER };
  }
  try {
    const user = await prisma.user.findUnique({
      where: { id: ownerId },
      select: { plan: true },
    });
    const plan: PlanName = user?.plan === "subscription" ? "subscription" : "free";
    const used = await prisma.usageRecord.count({
      where: {
        ownerId,
        operation: op,
        failed: false,
        createdAt: { gte: monthStartUtc() },
      },
    });
    return decideEntitlement(plan, op, used);
  } catch (err) {
    console.error("[entitlement] check failed — denying (fail-closed):", err);
    return {
      allowed: false,
      plan: "free",
      op,
      used: 0,
      limit: 0,
      reason: "We couldn't verify your plan just now — please try again in a moment.",
    };
  }
};

/**
 * Read-only usage summary for the billing page's meter — the SAME plan lookup
 * and UTC-month window checkEntitlement enforces, so what the user sees is
 * exactly what the gate counts. Best-effort: on error return null (the meter
 * hides rather than blocking the page).
 */
export const getUsageSummary = async (
  ownerId: string,
): Promise<{
  plan: PlanName;
  generate: { used: number; limit: number };
  build: { used: number; limit: number };
} | null> => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: ownerId },
      select: { plan: true },
    });
    const plan: PlanName = user?.plan === "subscription" ? "subscription" : "free";
    const count = (op: MeteredOp) =>
      prisma.usageRecord.count({
        where: { ownerId, operation: op, failed: false, createdAt: { gte: monthStartUtc() } },
      });
    const [gen, build] = await Promise.all([count("generate"), count("build")]);
    return {
      plan,
      generate: { used: gen, limit: planLimit(plan, "generate") },
      build: { used: build, limit: planLimit(plan, "build") },
    };
  } catch (err) {
    console.warn("[entitlement] usage summary failed:", err);
    return null;
  }
};

/**
 * Record one metered operation against the owner (the entitlement counter).
 * Best-effort — a write failure must never break a finished build — but it is
 * logged loudly because a silent miss under-counts the very quota that
 * protects spend. Dev owner is never recorded (exempt + not a real User row).
 */
export const recordMeteredUsage = async (entry: {
  ownerId: string;
  operation: MeteredOp;
  model: string;
  costUsd: number;
  inputTokens?: number;
  outputTokens?: number;
  projectId?: string;
  failed?: boolean;
}): Promise<void> => {
  if (entry.ownerId === DEV_OWNER_ID) return;
  try {
    await prisma.usageRecord.create({
      data: {
        ownerId: entry.ownerId,
        operation: entry.operation,
        model: entry.model,
        costUsd: entry.costUsd,
        inputTokens: entry.inputTokens ?? 0,
        outputTokens: entry.outputTokens ?? 0,
        projectId: entry.projectId,
        failed: entry.failed ?? false,
      },
    });
  } catch (err) {
    console.error("[entitlement] usage record write FAILED (quota under-count):", err);
  }
};
