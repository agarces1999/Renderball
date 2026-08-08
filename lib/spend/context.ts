/**
 * Attribution context for the spend ledger.
 *
 * The ledger's TOTAL is complete without this — every paid transport records
 * unconditionally (lib/spend/record.ts). This module only answers the second
 * question: WHICH part of the product spent it.
 *
 * WHY AsyncLocalStorage rather than a `stage` parameter threaded through every
 * signature: that is the exact mechanism that failed. In August 2026 the
 * ledger missed $31.17 not because recordUsage was absent — it had eight call
 * sites — but because recording was a per-call-site convention, so surfaces
 * written afterwards (the production outline route, image-attachment OCR,
 * suggest-layout, a dozen offline scripts) never opted in. A label set once at
 * the entrypoint cannot be forgotten by a call site that does not know it
 * exists, and a call site that DOES know can still override it explicitly.
 *
 * WHY NOT A MODULE GLOBAL: runPreviewBuild fills scenes with Promise.all, so
 * several stages are genuinely in flight at once inside one process. A global
 * would cross-attribute them to whichever branch wrote last — silently, and in
 * exactly the fan-out that costs the most money. ALS gives each async branch
 * its own view. lib/spend/context.test.ts pins this with a real Promise.all.
 *
 * node:async_hooks is in the Node standard library — no dependency added.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface SpendContext {
  /** "outline" | "build" | "vision" | "crawl" | "edit.insert" | "image" | ... */
  stage?: string;
  /** The signed-in user this spend is on behalf of, when there is one. */
  ownerId?: string;
  /** The deck being generated — this is what makes cost-per-deck answerable. */
  scriptId?: string;
  /** Groups every provider call of ONE build attempt. */
  runId?: string;
}

const store = new AsyncLocalStorage<SpendContext>();

/** Drop undefined keys so an inner scope that sets only `stage` INHERITS the
 *  outer scriptId/ownerId instead of blanking them. */
const defined = (ctx: SpendContext): SpendContext => {
  const out: SpendContext = {};
  if (ctx.stage !== undefined) out.stage = ctx.stage;
  if (ctx.ownerId !== undefined) out.ownerId = ctx.ownerId;
  if (ctx.scriptId !== undefined) out.scriptId = ctx.scriptId;
  if (ctx.runId !== undefined) out.runId = ctx.runId;
  return out;
};

/**
 * Run `fn` with these attribution fields attached to every paid provider call
 * made inside it, including across `await` boundaries and parallel fan-out.
 *
 * Nesting merges: the inner scope wins on the keys it sets, and inherits the
 * rest. So a build wraps once with { stage:"build", scriptId } and a phase
 * inside it can re-wrap with just { stage:"build.motion" } without losing the
 * deck it belongs to.
 */
export const withSpend = <T>(ctx: SpendContext, fn: () => T): T =>
  store.run({ ...(store.getStore() ?? {}), ...defined(ctx) }, fn);

/** The context in force right now. Empty object outside any scope — a call
 *  with no context still records, it just lands as "unattributed". */
export const spendContext = (): SpendContext => store.getStore() ?? {};
