/**
 * Who is allowed to see the operator surfaces.
 *
 * There was no admin concept before this: every authenticated surface in the
 * app is scoped to the caller's OWN data, so "signed in" was a sufficient
 * check. A spend report is the first thing that is about the BUSINESS —
 * dollar totals, volume, unit economics — and "any signed-in user" is not an
 * acceptable audience for it.
 *
 * FAIL CLOSED. With RB_ADMIN_USER_IDS unset nobody is an admin, including on
 * the first deploy after this ships. The alternative — an empty allowlist
 * meaning "everyone", which is a shape that shows up in real codebases —
 * would publish the company's cost structure to every user the moment the
 * route landed.
 *
 * Matching accepts a Clerk id, our own User id, or an email, because at 2am
 * the founder will paste whichever one is in front of him and a surface that
 * rejects the "wrong kind" of correct identifier is a surface he cannot get
 * into. Emails compare case-insensitively; ids do not (they are case-sensitive
 * identifiers and a case-folded match on them would be a genuine widening).
 */

export interface AdminIdentity {
  id: string;
  clerkId?: string | null;
  email?: string | null;
}

/** The configured allowlist, as written. Empty when unset. */
export const adminAllowlist = (env: NodeJS.ProcessEnv = process.env): string[] =>
  (env.RB_ADMIN_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export const isAdminConfigured = (env: NodeJS.ProcessEnv = process.env): boolean =>
  adminAllowlist(env).length > 0;

/** PURE: is this user on the allowlist? Unset allowlist → false, always. */
export const isAdminUser = (
  user: AdminIdentity | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean => {
  if (!user) return false;
  const allow = adminAllowlist(env);
  if (allow.length === 0) return false;
  const emails = new Set(allow.filter((a) => a.includes("@")).map((a) => a.toLowerCase()));
  const ids = new Set(allow.filter((a) => !a.includes("@")));
  if (user.email && emails.has(user.email.toLowerCase())) return true;
  if (ids.has(user.id)) return true;
  if (user.clerkId && ids.has(user.clerkId)) return true;
  return false;
};
