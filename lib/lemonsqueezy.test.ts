/**
 * Lemon Squeezy — the parts a forged request or a malformed payload could turn
 * into free money, or into a paying customer who cannot be charged.
 *
 * The signature check is the whole security model of the webhook: anyone can
 * POST to it, and a pass means "this user is now a paying subscriber". The
 * payload reader is where a subscription item id goes missing and metered
 * billing silently stops working.
 *
 * All pure — no network, no database.
 */
import { createHmac } from "crypto";
import {
  isLemonConfigured,
  planForLemonStatus,
  readLemonSubscription,
  verifyLemonSignature,
} from "./lemonsqueezy";
import { billingProvider } from "./billing-provider";

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

const SECRET = "whsec_test_lemon_squeezy";
const sign = (body: string, secret = SECRET) =>
  createHmac("sha256", secret).update(body, "utf8").digest("hex");

console.log("lemon squeezy");

// ── the signature ─────────────────────────────────────────────────────────

check("a correctly signed body verifies", () => {
  const body = JSON.stringify({ meta: { event_name: "subscription_created" } });
  assert(verifyLemonSignature(body, sign(body), SECRET), "a genuine signature must pass");
});

check("a forged or altered request does NOT verify", () => {
  const body = JSON.stringify({ meta: { event_name: "subscription_created" } });
  const good = sign(body);
  const cases: [string, string | null][] = [
    ["no signature at all", null],
    ["empty signature", ""],
    ["a plausible-looking hex string", "a".repeat(64)],
    ["the right signature, one character changed", good.slice(0, -1) + (good.endsWith("a") ? "b" : "a")],
    ["the right signature, truncated", good.slice(0, -2)],
    ["the signature of a DIFFERENT body", sign(JSON.stringify({ meta: { event_name: "x" } }))],
    ["a signature made with the wrong secret", sign(body, "not-our-secret")],
  ];
  for (const [why, sig] of cases) {
    assert(!verifyLemonSignature(body, sig, SECRET), `must reject: ${why}`);
  }
});

check("the body must match BYTE for byte", () => {
  // Re-serialising a parsed body reorders keys and drops whitespace; the
  // signature is over the bytes Lemon Squeezy sent, which is why the route
  // verifies before it parses.
  const raw = '{"meta":{"event_name":"subscription_created"},"data":{"id":"1"}}';
  const reserialised = JSON.stringify(JSON.parse(raw));
  const sig = sign(raw);
  assert(verifyLemonSignature(raw, sig, SECRET), "the raw body verifies");
  assert(
    reserialised === raw || !verifyLemonSignature(reserialised + " ", sig, SECRET),
    "a modified body must not verify",
  );
});

check("no secret configured means nothing verifies", () => {
  const body = "{}";
  assert(!verifyLemonSignature(body, sign(body), undefined), "an unset secret must never pass");
  assert(!verifyLemonSignature(body, sign(body), ""), "an empty secret must never pass");
});

// ── status → plan ─────────────────────────────────────────────────────────

check("paying and dunning states keep access; terminal states do not", () => {
  for (const s of ["active", "on_trial", "past_due", "ACTIVE"]) {
    assert(planForLemonStatus(s) === "subscription", `${s} should keep access`);
  }
  // past_due keeps access on purpose: a card retry window is not a
  // cancellation, and locking someone out mid-dunning turns a failed payment
  // into a churned customer.
  for (const s of ["cancelled", "expired", "paused", "unpaid", "", null, undefined, "nonsense"]) {
    assert(planForLemonStatus(s) === "free", `${String(s)} should not grant access`);
  }
});

// ── reading the payload ───────────────────────────────────────────────────

const payload = (over: Record<string, unknown> = {}) => ({
  meta: { event_name: "subscription_created", custom_data: { user_id: "user_abc" } },
  data: {
    id: 987654,
    attributes: {
      status: "active",
      customer_id: 4321,
      variant_id: 111,
      renews_at: "2026-08-30T10:00:00.000000Z",
      ends_at: null,
      first_subscription_item: { id: 55555, subscription_id: 987654 },
      ...over,
    },
  },
});

check("ids arrive as numbers and come out as strings", () => {
  const e = readLemonSubscription(payload());
  assert(e.subscriptionId === "987654", `subscription id, got ${e.subscriptionId}`);
  assert(e.customerId === "4321", `customer id, got ${e.customerId}`);
  assert(e.itemId === "55555", `item id, got ${e.itemId}`);
  assert(e.userId === "user_abc", "custom_data carries OUR user id, not an email");
  assert(e.status === "active", "status passes through");
});

check("the subscription ITEM is read, because usage cannot be billed without it", () => {
  const withoutItem = readLemonSubscription(payload({ first_subscription_item: undefined }));
  assert(withoutItem.itemId === null, "a missing item must read as null, not as undefined-ish");
  assert(withoutItem.subscriptionId === "987654", "the rest of the event still parses");
});

check("the period end is renews_at while live, ends_at once cancelled", () => {
  const live = readLemonSubscription(payload());
  assert(live.periodEnd.toISOString().startsWith("2026-08-30"), `got ${live.periodEnd.toISOString()}`);
  const done = readLemonSubscription(
    payload({ status: "cancelled", renews_at: null, ends_at: "2026-09-15T10:00:00.000000Z" }),
  );
  assert(done.periodEnd.toISOString().startsWith("2026-09-15"), `got ${done.periodEnd.toISOString()}`);
});

check("a missing or unparseable date never becomes an Invalid Date", () => {
  // An Invalid Date written to a DateTime column is a 500 at the far end of the
  // flow, a long way from the event that caused it. This project has been bitten.
  for (const over of [{ renews_at: null, ends_at: null }, { renews_at: "not-a-date", ends_at: null }]) {
    const e = readLemonSubscription(payload(over));
    assert(!Number.isNaN(e.periodEnd.getTime()), `period end must be a real date for ${JSON.stringify(over)}`);
  }
});

check("an empty or hostile payload parses without throwing", () => {
  for (const p of [{}, { meta: {} }, { data: {} }, { data: { attributes: {} } }]) {
    const e = readLemonSubscription(p);
    assert(e.event === "" || typeof e.event === "string", "event is always a string");
    assert(e.subscriptionId === null || typeof e.subscriptionId === "string", "id is null or string");
  }
});

// ── configuration gates ───────────────────────────────────────────────────

check("nothing is live until every key is present", () => {
  const keys = [
    "LEMONSQUEEZY_API_KEY",
    "LEMONSQUEEZY_WEBHOOK_SECRET",
    "LEMONSQUEEZY_STORE_ID",
    "LEMONSQUEEZY_VARIANT_TOKENS",
  ];
  const saved = keys.map((k) => process.env[k]);
  try {
    for (const k of keys) delete process.env[k];
    assert(!isLemonConfigured(), "no keys → not configured");
    // Each key alone is not enough; only the full set flips it.
    for (const k of keys) {
      process.env[k] = "x";
      const complete = keys.every((other) => process.env[other]);
      assert(
        isLemonConfigured() === complete,
        `with ${keys.filter((o) => process.env[o]).length}/4 keys set, configured should be ${complete}`,
      );
    }
    assert(isLemonConfigured(), "all four keys → configured");
    assert(
      billingProvider() === "lemonsqueezy",
      "Lemon Squeezy wins the provider choice when configured — it is the one that works here",
    );
  } finally {
    keys.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i] as string;
    });
  }
});

check("with no processor configured, billing reports itself as not live", () => {
  const keys = [
    "LEMONSQUEEZY_API_KEY", "LEMONSQUEEZY_WEBHOOK_SECRET",
    "LEMONSQUEEZY_STORE_ID", "LEMONSQUEEZY_VARIANT_TOKENS",
    "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PRICE_SUBSCRIPTION", "STRIPE_PRICE_TOKENS",
  ];
  const saved = keys.map((k) => process.env[k]);
  try {
    for (const k of keys) delete process.env[k];
    assert(billingProvider() === "none", "no keys anywhere → no provider");
  } finally {
    keys.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i] as string;
    });
  }
});

console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
