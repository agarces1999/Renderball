/**
 * Who can read the spend surface.
 *
 * Run: `node scripts/run-tests.mjs lib/admin.test.ts`. Pure, no Clerk, no DB.
 *
 * The failure this guards is one line of code away at all times: an empty
 * allowlist that means "everyone". GET /api/admin/spend publishes month-to-date
 * cost, volume and per-deck unit economics, and the first deploy after it lands
 * is exactly when RB_ADMIN_USER_IDS is most likely to be unset.
 */
import { adminAllowlist, isAdminConfigured, isAdminUser } from "./admin";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : err}`);
  }
};
const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg);
};

const env = (v?: string) => ({ ...(v === undefined ? {} : { RB_ADMIN_USER_IDS: v }) }) as unknown as NodeJS.ProcessEnv;
const user = { id: "usr_1", clerkId: "user_abc", email: "alfonso@flarebit.ai" };

check("an UNSET allowlist admits nobody", () => {
  assert(!isAdminConfigured(env()), "not configured");
  assert(!isAdminUser(user, env()), "an unset allowlist must not mean 'everyone'");
});

check("an EMPTY or comma-only allowlist admits nobody", () => {
  assert(!isAdminUser(user, env("")), "empty string");
  assert(!isAdminUser(user, env("  ")), "whitespace");
  assert(!isAdminUser(user, env(",, ,")), "commas only");
  assert(!isAdminConfigured(env(",, ,")), "and reports itself unconfigured");
});

check("a signed-out caller is never an admin", () => {
  assert(!isAdminUser(null, env("alfonso@flarebit.ai")), "null user");
  assert(!isAdminUser(undefined, env("alfonso@flarebit.ai")), "undefined user");
});

check("all three identifiers work, because whichever is to hand is the right one", () => {
  assert(isAdminUser(user, env("alfonso@flarebit.ai")), "by email");
  assert(isAdminUser(user, env("user_abc")), "by Clerk id");
  assert(isAdminUser(user, env("usr_1")), "by our own User id");
  assert(isAdminUser(user, env("someone@else.com, user_abc ,other")), "inside a list, with spaces");
});

check("emails match case-insensitively; ids do NOT", () => {
  assert(isAdminUser(user, env("ALFONSO@Flarebit.AI")), "email case does not matter");
  // Case-folding an opaque identifier is a real widening of who gets in.
  assert(!isAdminUser(user, env("USER_ABC")), "a Clerk id is case-sensitive");
});

check("a non-listed user is refused even when the allowlist is populated", () => {
  const other = { id: "usr_2", clerkId: "user_zzz", email: "someone@else.com" };
  assert(!isAdminUser(other, env("alfonso@flarebit.ai,user_abc")), "not on the list");
});

check("a user with no email or clerkId cannot match an email entry", () => {
  const thin = { id: "usr_3", clerkId: null, email: null };
  assert(!isAdminUser(thin, env("alfonso@flarebit.ai")), "no email to match");
  assert(isAdminUser(thin, env("usr_3")), "but its id still works");
});

check("the allowlist is parsed as written, trimmed, with blanks dropped", () => {
  assert(
    adminAllowlist(env(" a@b.com , user_1 ,, ")).join("|") === "a@b.com|user_1",
    "trim and drop empties",
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
