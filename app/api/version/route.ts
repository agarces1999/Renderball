import { NextResponse } from "next/server";

/**
 * What commit is actually running.
 *
 * This exists because "did my change deploy?" turned out to be unanswerable
 * from outside the app, repeatedly and expensively. Every probe tried failed to
 * discriminate:
 *
 *   - status codes — the Clerk middleware rewrites EVERY /api/preview/* path to
 *     a 404 before routing, so a route that exists and one that does not are
 *     byte-identical to an anonymous caller;
 *   - response headers — same cause, same headers;
 *   - the landing page's content-hashed bundle — only rehashes when the landing
 *     itself changes, so a perfectly successful deploy of editor or API work
 *     leaves it untouched.
 *
 * The result was guessing, and twice I guessed wrong in opposite directions:
 * once declaring a healthy pipeline dead, once assuming shipped code was live.
 * A build stamp ends that: one public, cacheless GET that names the commit.
 *
 * Deliberately minimal — short SHA and when the process started, nothing else.
 * No branch, no message, no environment detail. The repository is private and a
 * bare SHA grants nothing, which is why this can be public: a check that needs
 * a session cannot answer "is the new code live" from a browser or a script.
 *
 * The SHA comes from the platform at RUNTIME (Railway injects it), so nothing in
 * the image build has to change to keep it accurate.
 */
export const dynamic = "force-dynamic";

/** Set by the host on every deploy; first one that exists wins. */
const COMMIT_ENV_KEYS = [
  "RAILWAY_GIT_COMMIT_SHA",
  "VERCEL_GIT_COMMIT_SHA",
  "GIT_COMMIT_SHA",
  "SOURCE_VERSION",
  "COMMIT_SHA",
];

/** When this process started — i.e. when the running build was deployed. */
const STARTED_AT = new Date().toISOString();

export async function GET() {
  const full = COMMIT_ENV_KEYS.map((k) => process.env[k]).find(
    (v): v is string => typeof v === "string" && v.length > 0,
  );

  return NextResponse.json(
    {
      commit: full ? full.slice(0, 7) : "unknown",
      startedAt: STARTED_AT,
      uptimeSeconds: Math.round(process.uptime()),
    },
    // Never cached: a stale answer here is worse than no answer, since the whole
    // point is to tell a new deployment from an old one.
    { headers: { "cache-control": "no-store, max-age=0" } },
  );
}
