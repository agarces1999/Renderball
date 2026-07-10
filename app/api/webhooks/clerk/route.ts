import { NextResponse, type NextRequest } from "next/server";
import { verifyWebhook } from "@clerk/nextjs/webhooks";
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
            // P2002: the new email already belongs to another row (recycled
            // address). getCurrentUser re-links on next sign-in; don't make
            // Clerk retry forever over it.
            console.warn(`[clerk] email sync conflict for user ${user.id}:`, err);
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
          `[clerk] user ${summary.userId} <${summary.email}> deleted — ${summary.projectCount} project(s), ${summary.scriptCount} script(s), r2=${summary.r2Deleted ?? "skipped"}`,
        );
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
