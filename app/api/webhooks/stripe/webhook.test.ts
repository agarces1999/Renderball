/**
 * The money path. Untested until now, and the least visible thing in the product:
 * nobody notices a broken subscription webhook until a paying customer is locked
 * out, or a cancelled one keeps their access.
 *
 * These are REAL signed requests. Stripe's SDK can mint a valid signature header
 * for a payload (`generateTestHeaderString`), so the handler runs its genuine
 * `constructEvent` verification rather than a stub of it — which means the test
 * covers the verification itself, not just the branch after it.
 *
 * Four properties matter here:
 *
 *   1. a forged or absent signature is refused — the endpoint is public, so
 *      signature verification is the ONLY thing between a stranger and
 *      "this customer cancelled";
 *   2. checkout completion grants the plan;
 *   3. subscription deletion revokes it;
 *   4. a REPLAYED event is harmless. Stripe retries on any non-2xx and can
 *      deliver the same event twice; a handler that is not idempotent will
 *      double-apply it.
 */
import { prisma } from "../../../../lib/db";
import { ulid } from "../../../../lib/ulid";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => Promise<void>) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

const SECRET = "whsec_test_secret_for_signing_only";

/** A signed request the handler will accept as genuine. */
const signedRequest = async (body: unknown): Promise<Request> => {
  const Stripe = (await import("stripe")).default;
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "sk_test_dummy");
  const payload = JSON.stringify(body);
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
  return new Request("https://renderball.com/api/webhooks/stripe", {
    method: "POST",
    headers: { "Content-Type": "application/json", "stripe-signature": header },
    body: payload,
  });
};

const event = (type: string, object: Record<string, unknown>) => ({
  id: `evt_${ulid()}`,
  object: "event",
  type,
  data: { object },
});

const run = async () => {
  console.log("stripe webhook");

  // The handler is env-gated; give it what it needs for the duration.
  // isStripeConfigured() wants all three; the handler answers 503 without them,
  // which is correct behaviour and also the reason these branches were never
  // exercised. Restored in `finally`.
  const prev = {
    webhook: process.env.STRIPE_WEBHOOK_SECRET,
    key: process.env.STRIPE_SECRET_KEY,
    price: process.env.STRIPE_PRICE_SUBSCRIPTION,
  };
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  process.env.STRIPE_SECRET_KEY ||= "sk_test_dummy";
  process.env.STRIPE_PRICE_SUBSCRIPTION ||= "price_test_subscription";

  const { POST } = await import("./route");

  let userId = "";
  const stamp = ulid();
  const customerId = `cus_test_${stamp}`;

  try {
    const user = await prisma.user.create({
      data: {
        clerkId: `STRIPEHOOK_${stamp}`,
        email: `stripehook-${stamp}@invalid.test`,
        stripeCustomerId: customerId,
      },
    });
    userId = user.id;

    await check("an UNSIGNED request is refused", async () => {
      const res = await POST(
        new Request("https://renderball.com/api/webhooks/stripe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(event("customer.subscription.deleted", { customer: customerId })),
        }),
      );
      assert(res.status >= 400, `expected a refusal, got ${res.status}`);
    });

    await check("a FORGED signature is refused", async () => {
      const res = await POST(
        new Request("https://renderball.com/api/webhooks/stripe", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "stripe-signature": "t=1,v1=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
          },
          body: JSON.stringify(event("customer.subscription.deleted", { customer: customerId })),
        }),
      );
      assert(res.status >= 400, `a forged signature must be refused, got ${res.status}`);
    });

    await check("a signature over DIFFERENT content is refused", async () => {
      // Sign one payload, send another — the classic replay-with-tampering.
      const req = await signedRequest(event("customer.subscription.deleted", { customer: customerId }));
      const tampered = new Request(req.url, {
        method: "POST",
        headers: req.headers,
        body: JSON.stringify(event("customer.subscription.updated", { customer: customerId, status: "active" })),
      });
      const res = await POST(tampered);
      assert(res.status >= 400, `a tampered body must be refused, got ${res.status}`);
    });

    await check("checkout links the Stripe customer to the user", async () => {
      // The customer link is written BEFORE the subscription is fetched, so this
      // half is verifiable without a live Stripe account.
      await prisma.user.update({ where: { id: userId }, data: { stripeCustomerId: null } });
      await POST(
        await signedRequest(
          event("checkout.session.completed", {
            customer: customerId,
            client_reference_id: userId,
            mode: "subscription",
          }),
        ),
      );
      const u = await prisma.user.findUnique({ where: { id: userId } });
      assert(
        u?.stripeCustomerId === customerId,
        `the checkout should link customer ${customerId}, got ${u?.stripeCustomerId}`,
      );
    });

    await check("a checkout that is not ours is acknowledged and ignored", async () => {
      // No client_reference_id — someone else's checkout on a shared account, or
      // a test event. Must be acked so Stripe stops retrying, and must change
      // nothing.
      const res = await POST(
        await signedRequest(event("checkout.session.completed", { customer: "cus_someone_else" })),
      );
      assert(res.status === 200, `expected an ack, got ${res.status}`);
    });

    await check("a checkout whose subscription cannot be fetched is RETRYABLE", async () => {
      // This branch calls Stripe's API to expand the subscription. When that
      // call fails the customer has PAID and has no access yet, so the only safe
      // answer is a retryable status — Stripe re-delivers on any non-2xx. A 200
      // here would strand a paying customer permanently, silently.
      const res = await POST(
        await signedRequest(
          event("checkout.session.completed", {
            customer: customerId,
            subscription: `sub_unfetchable_${stamp}`,
            client_reference_id: userId,
            mode: "subscription",
          }),
        ),
      );
      assert(
        res.status >= 500,
        `a failed subscription fetch must be retryable, got ${res.status} — a paying customer would be stranded`,
      );
    });

    await check("subscription.updated to active grants access", async () => {
      const res = await POST(
        await signedRequest(
          event("customer.subscription.updated", {
            id: `sub_test_${stamp}`,
            customer: customerId,
            status: "active",
            items: { data: [{ price: { id: "price_test" } }] },
          }),
        ),
      );
      assert(res.status === 200, `expected 200, got ${res.status}: ${await res.text()}`);
      const sub = await prisma.subscription.findUnique({ where: { userId } });
      assert(!!sub, "an active subscription event should leave a subscription row");
    });

    await check("subscription.deleted revokes access", async () => {
      const res = await POST(
        await signedRequest(
          event("customer.subscription.deleted", {
            id: `sub_test_${stamp}`,
            customer: customerId,
            status: "canceled",
            items: { data: [{ price: { id: "price_test" } }] },
          }),
        ),
      );
      assert(res.status === 200, `expected 200, got ${res.status}: ${await res.text()}`);
      const sub = await prisma.subscription.findUnique({ where: { userId } });
      // Either the row is gone or it no longer grants a paid plan — both are
      // valid revocations; what matters is that it is not still "active".
      assert(
        !sub || sub.status !== "active",
        `a deleted subscription must not remain active (status=${sub?.status})`,
      );
    });

    await check("a REPLAYED event is idempotent", async () => {
      const req = event("customer.subscription.deleted", {
        id: `sub_test_${stamp}`,
        customer: customerId,
        status: "canceled",
        items: { data: [{ price: { id: "price_test" } }] },
      });
      const first = await POST(await signedRequest(req));
      const second = await POST(await signedRequest(req));
      assert(first.status === 200, `first delivery should succeed, got ${first.status}`);
      assert(
        second.status === 200,
        `a replay must be accepted rather than error (Stripe retries on non-2xx), got ${second.status}`,
      );
      const rows = await prisma.subscription.findMany({ where: { userId } });
      assert(rows.length <= 1, `a replay must not duplicate rows (found ${rows.length})`);
    });

    await check("an event for an UNKNOWN customer is accepted, not crashed", async () => {
      // Stripe will retry forever on a 5xx. An event we cannot match must be
      // acknowledged, not treated as a server fault.
      const res = await POST(
        await signedRequest(
          event("customer.subscription.deleted", {
            id: "sub_nobody",
            customer: "cus_does_not_exist",
            status: "canceled",
            items: { data: [{ price: { id: "price_test" } }] },
          }),
        ),
      );
      assert(res.status < 500, `an unmatched event must not 5xx (got ${res.status})`);
    });

    await check("an unrecognised event type is acknowledged", async () => {
      const res = await POST(await signedRequest(event("invoice.payment_action_required", { customer: customerId })));
      assert(res.status < 500, `an unhandled type must not 5xx (got ${res.status})`);
    });
  } finally {
    if (userId) {
      await prisma.subscription.deleteMany({ where: { userId } }).catch(() => {});
      await prisma.user.delete({ where: { id: userId } }).catch(() => {});
      const left = await prisma.user.findUnique({ where: { id: userId } }).catch(() => null);
      console.log(`  · cleanup — user:${left ? "LEFT" : "gone"}`);
    }
    for (const [k, v] of [
      ["STRIPE_WEBHOOK_SECRET", prev.webhook],
      ["STRIPE_SECRET_KEY", prev.key],
      ["STRIPE_PRICE_SUBSCRIPTION", prev.price],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await prisma.$disconnect().catch(() => {});
  }

  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
};

await run();
