/**
 * Lemon Squeezy — the processor that can actually take our money.
 *
 * WHY NOT STRIPE. Stripe does not support Colombia, where this company is. The
 * workaround is incorporating in the UK or US first, which is weeks and money
 * before a single dollar of revenue. Lemon Squeezy is a merchant of record:
 * they are the seller, they handle VAT/sales tax worldwide, and they pay out to
 * founders in countries Stripe has not reached. The Stripe code stays in the
 * tree, dormant, because if an entity ever exists Stripe's fees are lower — see
 * lib/billing-provider.ts for how one of the two is chosen.
 *
 * WHAT'S DIFFERENT, and matters:
 *
 *   * Usage records attach to a subscription ITEM, not a subscription. The item
 *     id arrives in the subscription webhook payload and is stored on the
 *     Subscription row; without it, metered billing cannot report a token.
 *   * A metered checkout charges ZERO up front by design. The customer is
 *     billed in arrears on the usage we report, which is exactly the pivot's
 *     1M-free-then-metered model.
 *   * Webhooks are signed with plain HMAC-SHA256 over the raw body in an
 *     `X-Signature` header — no SDK, so the comparison must be timing-safe by
 *     hand.
 *   * The API is JSON:API. Requests and responses need the vendor content type
 *     or Lemon Squeezy rejects them.
 *
 * Everything is env-gated exactly like the Stripe module: this ships before the
 * store exists, and activates when the keys land.
 */
import { createHmac, timingSafeEqual } from "crypto";

const API = "https://api.lemonsqueezy.com/v1";
const JSON_API = "application/vnd.api+json";

/**
 * Live when we can create a checkout AND verify a webhook. The variant id is
 * the metered plan the customer subscribes to; the store id scopes the checkout.
 */
export const isLemonConfigured = (): boolean =>
  Boolean(
    process.env.LEMONSQUEEZY_API_KEY &&
      process.env.LEMONSQUEEZY_WEBHOOK_SECRET &&
      process.env.LEMONSQUEEZY_STORE_ID &&
      process.env.LEMONSQUEEZY_VARIANT_TOKENS,
  );

const apiKey = (): string => {
  const key = process.env.LEMONSQUEEZY_API_KEY;
  if (!key) throw new Error("Lemon Squeezy is not configured (LEMONSQUEEZY_API_KEY missing).");
  return key;
};

/**
 * One request to the Lemon Squeezy API.
 *
 * Errors carry the API's own message where there is one: JSON:API returns
 * `errors: [{detail}]`, and "variant not found" is a far more useful log line
 * than "400".
 */
const call = async <T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> => {
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Accept: JSON_API,
      "Content-Type": JSON_API,
      Authorization: `Bearer ${apiKey()}`,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { errors?: { detail?: string }[] };
      if (parsed.errors?.length) detail = parsed.errors.map((e) => e.detail).join("; ");
    } catch {
      /* not JSON — the raw prefix is the best we have */
    }
    throw new Error(`Lemon Squeezy ${init.method ?? "GET"} ${path} → ${res.status}: ${detail}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
};

/**
 * PURE: is this webhook really from Lemon Squeezy?
 *
 * HMAC-SHA256 of the RAW body under the signing secret, hex, compared against
 * X-Signature. Timing-safe because a byte-at-a-time comparison leaks the
 * expected digest to anyone willing to make enough requests — and this endpoint
 * is the only thing standing between a stranger and "this user is now a paying
 * subscriber".
 */
export const verifyLemonSignature = (
  rawBody: string,
  signature: string | null,
  secret: string | undefined,
): boolean => {
  if (!signature || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature.trim(), "utf8");
  if (a.length !== b.length) return false; // timingSafeEqual throws on length mismatch
  return timingSafeEqual(a, b);
};

/**
 * PURE: map a Lemon Squeezy subscription status to our plan.
 *
 * `on_trial` and `past_due` keep access — the same call the Stripe mapping
 * makes, for the same reason: a card retry window is not a cancellation, and
 * locking someone out mid-dunning is how you turn a failed payment into a
 * churned customer. Everything terminal is free.
 *
 * Lemon Squeezy spells it "cancelled". A subscription that is cancelled but has
 * not yet reached the end of its paid period reports `cancelled` immediately,
 * so access ends at `ends_at` — which is what `expired` marks.
 */
export const planForLemonStatus = (
  status: string | null | undefined,
): "free" | "subscription" => {
  switch ((status ?? "").toLowerCase()) {
    case "active":
    case "on_trial":
    case "past_due":
      return "subscription";
    default:
      return "free";
  }
};

/** The app origin for checkout redirects — production must not fall back to localhost. */
export const appOrigin = (): string => {
  const url = process.env.NEXT_PUBLIC_APP_URL;
  if (url) return url;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "NEXT_PUBLIC_APP_URL must be set in production — checkout would otherwise redirect to localhost.",
    );
  }
  return "http://localhost:3000";
};

export interface LemonCheckout {
  url: string;
}

/**
 * A hosted checkout for the metered token plan.
 *
 * `custom_data.user_id` is how the webhook maps the purchase back to OUR user.
 * Email is never the identity key: people buy with a different address than
 * they signed up with, and a mismatch would silently upgrade the wrong account
 * or nobody at all.
 */
export const createLemonCheckout = async (user: {
  id: string;
  email: string;
}): Promise<LemonCheckout> => {
  const body = {
    data: {
      type: "checkouts",
      attributes: {
        checkout_data: {
          email: user.email,
          custom: { user_id: user.id },
        },
        product_options: {
          redirect_url: `${appOrigin()}/billing?checkout=success`,
          receipt_button_text: "Back to Renderball",
          receipt_link_url: `${appOrigin()}/documents`,
        },
        checkout_options: { embed: false, dark: false },
      },
      relationships: {
        store: { data: { type: "stores", id: String(process.env.LEMONSQUEEZY_STORE_ID) } },
        variant: {
          data: { type: "variants", id: String(process.env.LEMONSQUEEZY_VARIANT_TOKENS) },
        },
      },
    },
  };
  const json = await call<{ data?: { attributes?: { url?: string } } }>("/checkouts", {
    method: "POST",
    body,
  });
  const url = json.data?.attributes?.url;
  if (!url) throw new Error("Lemon Squeezy returned a checkout with no URL");
  return { url };
};

/**
 * Where a subscriber manages their plan.
 *
 * There is no portal SESSION to create: Lemon Squeezy puts signed
 * customer-portal and update-payment-method URLs on the subscription itself,
 * and they expire, so this reads a fresh one each time rather than storing it.
 */
export const lemonPortalUrl = async (subscriptionId: string): Promise<string> => {
  const json = await call<{
    data?: { attributes?: { urls?: { customer_portal?: string; update_payment_method?: string } } };
  }>(`/subscriptions/${encodeURIComponent(subscriptionId)}`);
  const urls = json.data?.attributes?.urls;
  const url = urls?.customer_portal || urls?.update_payment_method;
  if (!url) throw new Error("Lemon Squeezy returned no portal URL for that subscription");
  return url;
};

/**
 * Cancel a subscription.
 *
 * Called when an account is deleted, and it is the difference between a closed
 * account and one that keeps being charged forever with no row left to map the
 * payments back to. Lemon Squeezy cancels at the end of the paid period, which
 * is the correct behaviour — the customer keeps what they bought.
 */
export const cancelLemonSubscription = async (subscriptionId: string): Promise<void> => {
  await call(`/subscriptions/${encodeURIComponent(subscriptionId)}`, { method: "DELETE" });
};

/**
 * Report metered usage against a subscription item.
 *
 * "increment" adds to the period's running total, which is the shape our outbox
 * already produces: each row is a delta of overage tokens, never a cumulative
 * figure. There is no idempotency key in this API — that is why the outbox
 * claims its watermark in the database BEFORE a row is written, so a retry
 * re-sends a row that was never marked sent rather than double-counting one
 * that was.
 */
export const reportLemonUsage = async (
  subscriptionItemId: string,
  quantity: number,
): Promise<void> => {
  await call("/usage-records", {
    method: "POST",
    body: {
      data: {
        type: "usage-records",
        attributes: { quantity, action: "increment" },
        relationships: {
          "subscription-item": {
            data: { type: "subscription-items", id: String(subscriptionItemId) },
          },
        },
      },
    },
  });
};

/** The webhook payload shape we actually read. */
export interface LemonWebhook {
  meta?: { event_name?: string; custom_data?: { user_id?: string } };
  data?: {
    // A number on the wire, a string everywhere in our schema. Both are
    // accepted here so the reader below is the single place that converts.
    id?: number | string;
    attributes?: {
      status?: string;
      customer_id?: number | string;
      variant_id?: number | string;
      renews_at?: string | null;
      ends_at?: string | null;
      first_subscription_item?: { id?: number | string; subscription_id?: number | string };
    };
  };
}

/**
 * PURE: everything the webhook handler needs, pulled out of the payload.
 *
 * Separated from the route so the parsing is testable without HTTP, and so the
 * awkward parts are visible: ids arrive as numbers and must be stored as
 * strings, and the period end is `renews_at` while the subscription lives but
 * `ends_at` once it is cancelled.
 */
export const readLemonSubscription = (
  payload: LemonWebhook,
): {
  event: string;
  userId: string | null;
  subscriptionId: string | null;
  customerId: string | null;
  itemId: string | null;
  variantId: string | null;
  status: string;
  periodEnd: Date;
} => {
  const attrs = payload.data?.attributes ?? {};
  const str = (v: unknown): string | null =>
    v === null || v === undefined || v === "" ? null : String(v);
  const when = attrs.renews_at || attrs.ends_at;
  const parsed = when ? new Date(when) : null;
  return {
    event: payload.meta?.event_name ?? "",
    userId: payload.meta?.custom_data?.user_id ?? null,
    subscriptionId: str(payload.data?.id),
    customerId: str(attrs.customer_id),
    itemId: str(attrs.first_subscription_item?.id),
    variantId: str(attrs.variant_id),
    status: attrs.status ?? "",
    // A missing or unparseable date must not write an Invalid Date into the
    // row — that poisoned a whole document-creation path once already.
    periodEnd: parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date(),
  };
};
