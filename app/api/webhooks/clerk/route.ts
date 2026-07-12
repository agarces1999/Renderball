import { NextResponse, type NextRequest } from "next/server";
import { verifyWebhook } from "@clerk/nextjs/webhooks";
import { clerkClient } from "@clerk/nextjs/server";
import { prisma } from "../../../../lib/db";
import { deleteUserData } from "../../../../lib/delete-user";

/**
 * Clerk webhook — keeps our User table in sync with Clerk after sign-up.
 * Env-gated: 503 with a setup hint until CLERK_WEBHOOK_SIGNING_SECRET exists,
 * so registering the endpoint in the Clerk dashboard later "just works".
 *
 * Events handled:
 *   user.updated → refresh the stored email by clerkId (getCurrentUser also
 *                  refreshes on next sign-in; this covers users who change
 *                  email and never sign back in before contacting support)
 *   user.deleted → run the SAME deletion path as the GDPR CLI
 *                  (lib/delete-user.ts): R2 objects, ScriptDocs, User cascade,
 *                  local artifacts. Clerk deletion = full account deletion.
 *
 * Unknown users warn-and-ack (200) — Clerk retries non-2xx, and a user who
 * never hit getCurrentUser has no row to sync; retrying won't change that.
 * This route must stay outside the Clerk-protected matcher (it is —
 * middleware.ts only protects the listed app/api/preview routes).
 */
export async function POST(request: NextRequest) {
  if (!process.env.CLERK_WEBHOOK_SIGNING_SECRET) {
    return NextResponse.json(
      {
        error:
          "Clerk webhook not configured — set CLERK_WEBHOOK_SIGNING_SECRET from the Clerk dashboard's webhook endpoint settings.",
      },
      { status: 503 },
    );
  }

  let evt;
  try {
    evt = await verifyWebhook(request);
  } catch (err) {
    console.warn("[clerk] webhook signature verification failed:", err);
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  try {
    switch (evt.type) {
      case "user.updated": {
        const clerkId = evt.data.id;
        const email =
          evt.data.email_addresses?.find((e) => e.id === evt.data.primary_email_address_id)
            ?.email_address ?? evt.data.email_addresses?.[0]?.email_address;
        if (!email) break;
        const user = await prisma.user.findUnique({ where: { clerkId } });
        if (!user) {
          console.warn(`[clerk] user.updated for unknown clerkId ${clerkId} — no row to sync`);
          break;
        }
        if (user.email !== email) {
          try {
            await prisma.user.update({ where: { clerkId }, data: { email } });
            console.log(`[clerk] user ${user.id} email synced`);
          } catch (err) {
            const code = (err as { code?: string })?.code;
            if (code === "P2002") {
              // The new email already belongs to ANOTHER row (row B) that holds
              // a stale address. Resolve by pulling row B's CURRENT email from
              // Clerk and correcting it — that frees the address — then retry.
              const conflicting = await prisma.user.findUnique({ where: { email } });
              if (conflicting && conflicting.clerkId !== clerkId) {
                try {
                  const cc = await clerkClient();
                  const cu = await cc.users.getUser(conflicting.clerkId);
                  const trueEmail =
                    cu.primaryEmailAddress?.emailAddress ?? cu.emailAddresses?.[0]?.emailAddress;
                  if (trueEmail && trueEmail !== email) {
                    await prisma.user.update({ where: { id: conflicting.id }, data: { email: trueEmail } });
                    await prisma.user.update({ where: { clerkId }, data: { email } });
                    console.log(`[clerk] resolved email conflict: freed ${email} from user ${conflicting.id}`);
                    break;
                  }
                } catch (e2) {
                  console.error(`[clerk] conflict-resolution lookup failed for ${email}:`, e2);
                }
              }
              // Genuinely unresolved (both rows really use this email, or Clerk
              // lookup failed) — 500 so Clerk retries; do NOT swallow (that left
              // the stale email forever and broke email-based GDPR lookup).
              console.error(`[clerk] unresolved email conflict for ${email} — returning 500 for retry`);
              return NextResponse.json({ error: "email conflict — will retry" }, { status: 500 });
            }
            throw err; // transient/unknown → 500 via the outer catch (Clerk retries)
          }
        }
        break;
      }
      case "user.deleted": {
        const clerkId = evt.data.id;
        if (!clerkId) break;
        const user = await prisma.user.findUnique({ where: { clerkId } });
        if (!user) {
          console.warn(`[clerk] user.deleted for unknown clerkId ${clerkId} — nothing to delete`);
          break;
        }
        const summary = await deleteUserData(user.id);
        console.log(
          `[clerk] user ${summary.userId} <${summary.email}> deleted — ${summary.projectCount} project(s), ${summary.scriptCount} script(s), r2=${summary.r2Deleted ?? "skipped"}, stripe=${summary.stripeCancel}`,
        );
        if (summary.r2Failures.length > 0) {
          // The DB deletion (what the user observes) succeeded; only object
          // storage lagged. Don't 500 — that would make Clerk redeliver and
          // re-run the whole deletion. Log loudly for a manual sweep.
          console.error(`[clerk] user ${summary.userId} R2 sweep needed: ${summary.r2Failures.join(", ")}`);
        }
        break;
      }
      default:
        break; // acknowledge everything else (user.created handled lazily by getCurrentUser)
    }
    return NextResponse.json({ received: true });
  } catch (err) {
    console.error("[clerk] webhook handler failed:", err);
    // 500 → Clerk retries with backoff; correct for transient DB failures.
    return NextResponse.json({ error: "handler failed" }, { status: 500 });
  }
}
