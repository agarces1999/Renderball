/**
 * Owner resolution — the ONLY thing that ever differed between an
 * `/api/preview/*` route and its `/api/dev/*` twin.
 *
 * Measured 2026-08-14: 13 such pairs existed, 908 dev lines of which 700
 * (77%) were byte-identical to their preview counterpart. The duplication
 * had already drifted in production — `dev/edit-element` and
 * `preview/edit-element` returned DIFFERENT error text for the same
 * out-of-range sceneIndex, because a fix landed on one and not the other.
 * That is the real cost: not the lines, the divergence.
 *
 * The shape both lanes now share: resolve an owner, run ONE handler, shape
 * the result. Handlers live in lib/api/handlers/* and take an ownerId — they
 * never see a session, so neither lane can grow behavior the other lacks.
 */
import { NextResponse } from "next/server";
import { getCurrentUser, DEV_OWNER_ID } from "../auth";

export type OwnerGate =
  | { ok: true; ownerId: string }
  | { ok: false; response: NextResponse };

/** Production lane: the signed-in Clerk user owns the document. */
export const sessionOwner = async (): Promise<OwnerGate> => {
  const user = await getCurrentUser();
  if (!user) {
    return { ok: false, response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  }
  return { ok: true, ownerId: user.id };
};

/**
 * Dev/QA-harness lane: a fixed owner, and a hard 404 in production. The
 * NODE_ENV gate lives HERE rather than in each route so it cannot be
 * forgotten when a new dev twin is added.
 */
export const devOwner = (): OwnerGate => {
  if (process.env.NODE_ENV === "production") {
    return { ok: false, response: NextResponse.json({ error: "dev-only" }, { status: 404 }) };
  }
  return { ok: true, ownerId: DEV_OWNER_ID };
};

/** What every shared handler returns: a status and a JSON body, nothing more. */
export interface HandlerResult {
  status: number;
  body: unknown;
}

export const toResponse = (r: HandlerResult): NextResponse =>
  NextResponse.json(r.body, { status: r.status });
