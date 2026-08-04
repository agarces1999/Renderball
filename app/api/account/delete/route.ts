import { NextResponse } from "next/server";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { getCurrentUser } from "../../../../lib/auth";
import { deleteUserData } from "../../../../lib/delete-user";
import { sendAlert } from "../../../../lib/alert";

/**
 * Self-serve account deletion — the path that DID NOT EXIST.
 *
 * Before this route the only way user data ever got purged was the Clerk
 * user.deleted webhook, which is env-gated off until
 * CLERK_WEBHOOK_SIGNING_SECRET is configured — so "delete my account" was a
 * promise the privacy policy made and nothing kept. This route is the same
 * purge (lib/delete-user.ts), triggered by the account's own owner.
 *
 * Order: the Clerk identity goes FIRST. Once it is gone the person cannot
 * sign in, so even if the data purge below hits a transient failure they are
 * never left signed in with their documents missing — and the failure alerts
 * us to finish the purge by hand (the same CLI the webhook shares).
 */
export async function POST() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { userId: clerkId } = await auth();
  if (!clerkId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const client = await clerkClient();
    await client.users.deleteUser(clerkId);
  } catch (err) {
    console.error(`[account-delete] Clerk deletion failed for ${user.id}:`, err);
    return NextResponse.json(
      { error: "We couldn't delete the account just now — nothing was removed. Try again, or email support@renderball.com." },
      { status: 502 },
    );
  }

  try {
    await deleteUserData(user.id);
  } catch (err) {
    console.error(`[account-delete] data purge failed for ${user.id} AFTER Clerk deletion:`, err);
    void sendAlert({
      key: `account-delete-purge-failed:${user.id}`,
      level: "critical",
      title: "Account deleted in Clerk but the data purge failed",
      detail: `User ${user.id} (${user.email}) deleted their account and deleteUserData threw — finish the purge with the GDPR CLI. Error: ${err instanceof Error ? err.message : String(err)}`,
    }).catch(() => {});
  }

  return NextResponse.json({ ok: true });
}
