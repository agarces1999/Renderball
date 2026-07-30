/**
 * The Lemon Squeezy webhook, driven the way Lemon Squeezy drives it: a real
 * POST, a real HMAC signature, a real database row at the other end.
 *
 * This endpoint is the only writer of User.plan on the live billing path, and
 * it is open to the internet. Two questions matter, and neither can be answered
 * by reading the code: does a forged request get turned away, and does a
 * genuine one leave the account in a state we can actually bill?
 *
 * The second half is easy to get wrong quietly. A subscriber whose row lost its
 * subscription-item id looks completely healthy — plan=subscription, portal
 * works, no errors anywhere — and cannot be charged a cent.
 */
import { createHmac } from "crypto";
import { prisma } from "../../../../lib/db";
import { POST } from "./route";
import { ulid } from "../../../../lib/ulid";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => Promise<void>) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

const SECRET = "lemon_test_signing_secret";

/** Configure the module gate the way a live deployment would. */
const configure = () => {
  process.env.LEMONSQUEEZY_API_KEY = "test_api_key";
  process.env.LEMONSQUEEZY_WEBHOOK_SECRET = SECRET;
  process.env.LEMONSQUEEZY_STORE_ID = "1";
  process.env.LEMONSQUEEZY_VARIANT_TOKENS = "2";
};

const post = async (body: unknown, opts: { signature?: string | null } = {}) => {
  const raw = JSON.stringify(body);
  const signature =
    opts.signature === undefined ? createHmac("sha256", SECRET).update(raw, "utf8").digest("hex") : opts.signature;
  const res = await POST(
    new Request("https://renderball.com/api/webhooks/lemonsqueezy", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(signature ? { "x-signature": signature } : {}),
      },
      body: raw,
    }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};

const event = (
  name: string,
  over: {
    status?: string;
    item?: unknown;
    userId?: string | null;
    subId?: number;
    customerId?: number;
  } = {},
) => ({
  meta: {
    event_name: name,
    ...(over.userId === null ? {} : { custom_data: { user_id: over.userId } }),
  },
  data: {
    id: over.subId ?? 700100,
    attributes: {
      status: over.status ?? "active",
      customer_id: over.customerId ?? 900200,
      variant_id: 2,
      renews_at: "2026-09-01T00:00:00.000000Z",
      ends_at: null,
      first_subscription_item:
        over.item === undefined ? { id: 800300, subscription_id: over.subId ?? 700100 } : over.item,
    },
  },
});

const run = async () => {
  console.log("lemonsqueezy webhook");
  configure();

  const stamp = ulid();
  const user = await prisma.user.create({
    data: { clerkId: `LEMON_${stamp}`, email: `lemon-${stamp}@invalid.test` },
  });

  try {
    // ── the door ──────────────────────────────────────────────────────────

    await check("an UNSIGNED request is refused", async () => {
      const r = await post(event("subscription_created", { userId: user.id }), { signature: null });
      assert(r.status === 401, `expected 401, got ${r.status}`);
      const after = await prisma.user.findUnique({ where: { id: user.id } });
      assert(after?.plan === "free", "an unsigned request must not grant a plan");
    });

    await check("a FORGED signature is refused", async () => {
      const r = await post(event("subscription_created", { userId: user.id }), {
        signature: "f".repeat(64),
      });
      assert(r.status === 401, `expected 401, got ${r.status}`);
      const after = await prisma.user.findUnique({ where: { id: user.id } });
      assert(after?.plan === "free", "a forged request must not grant a plan");
    });

    await check("a signature for a DIFFERENT body is refused", async () => {
      const other = createHmac("sha256", SECRET).update("{}", "utf8").digest("hex");
      const r = await post(event("subscription_created", { userId: user.id }), { signature: other });
      assert(r.status === 401, `expected 401, got ${r.status}`);
    });

    // ── the happy path ────────────────────────────────────────────────────

    await check("subscription_created grants access and stores what we need to bill", async () => {
      const r = await post(event("subscription_created", { userId: user.id }));
      assert(r.status === 200, `expected 200, got ${r.status}`);

      const after = await prisma.user.findUnique({ where: { id: user.id } });
      assert(after?.plan === "subscription", `plan should be subscription, got ${after?.plan}`);
      assert(after?.lemonCustomerId === "900200", `customer id stored, got ${after?.lemonCustomerId}`);

      const sub = await prisma.subscription.findUnique({ where: { userId: user.id } });
      assert(sub?.provider === "lemonsqueezy", `provider should be recorded, got ${sub?.provider}`);
      assert(sub?.lemonSubscriptionId === "700100", `subscription id, got ${sub?.lemonSubscriptionId}`);
      assert(
        sub?.lemonItemId === "800300",
        `the subscription ITEM id must be stored — without it no usage can ever be billed (got ${sub?.lemonItemId})`,
      );
      assert(sub?.status === "active", `status, got ${sub?.status}`);
    });

    await check("a later event that omits the item id does NOT erase it", async () => {
      // Lemon Squeezy does not include every field on every event type. An
      // update that blanked the item would leave a healthy-looking subscriber
      // who cannot be charged — silent revenue loss, no error anywhere.
      const r = await post(event("subscription_updated", { userId: user.id, item: null }));
      assert(r.status === 200, `expected 200, got ${r.status}`);
      const sub = await prisma.subscription.findUnique({ where: { userId: user.id } });
      assert(sub?.lemonItemId === "800300", `item id must survive, got ${sub?.lemonItemId}`);
    });

    await check("an event with no custom_data is matched by the ids we already hold", async () => {
      const r = await post(event("subscription_updated", { userId: null, status: "past_due" }));
      assert(r.status === 200, `expected 200, got ${r.status}`);
      const after = await prisma.user.findUnique({ where: { id: user.id } });
      // past_due keeps access: a card retry window is not a cancellation.
      assert(after?.plan === "subscription", `past_due should keep access, got ${after?.plan}`);
    });

    // ── losing access ─────────────────────────────────────────────────────

    await check("subscription_expired revokes access", async () => {
      const r = await post(event("subscription_expired", { userId: user.id, status: "expired" }));
      assert(r.status === 200, `expected 200, got ${r.status}`);
      const after = await prisma.user.findUnique({ where: { id: user.id } });
      assert(after?.plan === "free", `expired should drop to free, got ${after?.plan}`);
    });

    await check("a REPLAYED event is idempotent", async () => {
      const e = event("subscription_updated", { userId: user.id, status: "active" });
      await post(e);
      await post(e);
      const subs = await prisma.subscription.findMany({ where: { userId: user.id } });
      assert(subs.length === 1, `a replay must not create a second subscription (got ${subs.length})`);
      const after = await prisma.user.findUnique({ where: { id: user.id } });
      assert(after?.plan === "subscription", "the replayed state still applies");
    });

    // ── things that must not crash the endpoint ───────────────────────────

    await check("an event we cannot attribute to anyone is acknowledged, not retried", async () => {
      // Genuinely unattributable: no custom_data, a subscription id we have
      // never seen, and a customer id belonging to nobody. 500 here would make
      // Lemon Squeezy retry for days and can get the endpoint disabled — which
      // would then break real customers' events too.
      const before = await prisma.user.findUnique({ where: { id: user.id } });
      const r = await post(
        event("subscription_updated", {
          userId: null,
          subId: 999999,
          customerId: 999999,
          status: "expired",
        }),
      );
      assert(r.status === 200, `expected a 200 ack, got ${r.status}`);
      assert(r.json.warning === "unattributed", `it should say why it was ignored, got ${JSON.stringify(r.json)}`);
      const after = await prisma.user.findUnique({ where: { id: user.id } });
      assert(
        after?.plan === before?.plan,
        "a stranger's subscription event must not touch anyone else's plan",
      );
    });

    await check("a non-subscription event is acknowledged and ignored", async () => {
      const r = await post({ meta: { event_name: "order_created" }, data: { id: 1, attributes: {} } });
      assert(r.status === 200, `expected 200, got ${r.status}`);
    });

    await check("malformed JSON is refused, not crashed on", async () => {
      const raw = "{not json";
      const signature = createHmac("sha256", SECRET).update(raw, "utf8").digest("hex");
      const res = await POST(
        new Request("https://renderball.com/api/webhooks/lemonsqueezy", {
          method: "POST",
          headers: { "x-signature": signature },
          body: raw,
        }),
      );
      assert(res.status === 400, `expected 400, got ${res.status}`);
    });

    await check("with no keys configured the endpoint is closed", async () => {
      const saved = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
      delete process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
      try {
        const r = await post(event("subscription_created", { userId: user.id }));
        assert(r.status === 503, `expected 503, got ${r.status}`);
      } finally {
        process.env.LEMONSQUEEZY_WEBHOOK_SECRET = saved;
      }
    });
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    const left = await prisma.user.findUnique({ where: { id: user.id } }).catch(() => null);
    console.log(`  · cleanup — user:${left ? "LEFT BEHIND" : "gone"}`);
    await prisma.$disconnect().catch(() => {});
  }

  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
};

await run();
