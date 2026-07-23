// One-time Stripe setup for usage-based token billing (docs/METERING.md).
//
// Creates, idempotently (safe to re-run; finds existing objects first):
//   1. A Billing Meter aggregating token meter-events (event_name below —
//      must match tokenMeterEventName() in lib/metering.ts).
//   2. A "Renderball tokens" Product + flat per-unit METERED monthly Price.
//      NO tiers, NO credits: the 1M free allowance lives app-side and Stripe
//      only ever receives overage tokens — see docs/METERING.md for why.
//
// The retail rate is a FOUNDER DECISION (markup % is an open PIVOT.md item),
// so it is a required argument, never a default:
//
//   node scripts/stripe-setup-meter.mjs --usd-per-million 10
//
// Run once against the test key, later once against the live key. Prints the
// env lines to add to the deploy environment.
import { readFileSync } from "fs";
import { join } from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const Stripe = require("stripe");

const EVENT_NAME = process.env.STRIPE_TOKEN_METER_EVENT || "renderball_tokens";
const PRICE_LOOKUP_KEY = "renderball_tokens_per_unit_v1";

const envLocal = (name) => {
  try {
    const content = readFileSync(join(process.cwd(), ".env.local"), "utf-8");
    const m = content.match(new RegExp(`^${name}=(.+)$`, "m"));
    let v = m?.[1]?.trim();
    if (v && /^["'].*["']$/.test(v)) v = v.slice(1, -1);
    return v || undefined;
  } catch {
    return undefined;
  }
};

const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const usdPerMillion = Number(argValue("--usd-per-million"));
if (!Number.isFinite(usdPerMillion) || usdPerMillion <= 0) {
  console.error(
    "Usage: node scripts/stripe-setup-meter.mjs --usd-per-million <rate>\n\n" +
      "The retail $ per 1M tokens is a founder call (markup on ~$3.1/M blended\n" +
      "COGS — see docs/METERING.md), so it must be passed explicitly.",
  );
  process.exit(1);
}

const key = process.env.STRIPE_SECRET_KEY?.trim() || envLocal("STRIPE_SECRET_KEY");
if (!key) {
  console.error("STRIPE_SECRET_KEY is not set (env or .env.local).");
  process.exit(1);
}
const stripe = new Stripe(key);
const mode = key.startsWith("sk_live") ? "LIVE" : "test";
console.log(`Stripe ${mode} mode — event_name "${EVENT_NAME}", $${usdPerMillion}/M tokens\n`);

// ── 1. Billing Meter (find by event_name, else create) ──────────────────────
let meter = null;
for await (const m of stripe.billing.meters.list({ status: "active", limit: 100 })) {
  if (m.event_name === EVENT_NAME) {
    meter = m;
    break;
  }
}
if (meter) {
  console.log(`✓ meter exists: ${meter.id} (${meter.event_name})`);
} else {
  meter = await stripe.billing.meters.create({
    display_name: "Renderball tokens",
    event_name: EVENT_NAME,
    default_aggregation: { formula: "sum" },
    customer_mapping: { event_payload_key: "stripe_customer_id", type: "by_id" },
    value_settings: { event_payload_key: "value" },
  });
  console.log(`+ meter created: ${meter.id} (${meter.event_name})`);
}

// ── 2. Product + flat per-unit metered Price (find by lookup_key, else create) ──
const existing = await stripe.prices.list({ lookup_keys: [PRICE_LOOKUP_KEY], limit: 1 });
let price = existing.data[0] ?? null;
if (price) {
  console.log(`✓ price exists: ${price.id} (lookup_key ${PRICE_LOOKUP_KEY})`);
  console.log("  (to change the rate, create a new price version by hand — Stripe prices are immutable)");
} else {
  const product = await stripe.products.create({
    name: "Renderball tokens",
    description: "Usage-based generation tokens. Editing is always free.",
  });
  // $/M → per-token cents with full precision (e.g. $10/M = 0.001¢/token).
  // unit_amount_decimal accepts up to 12 decimal places.
  const centsPerToken = (usdPerMillion * 100) / 1_000_000;
  price = await stripe.prices.create({
    product: product.id,
    currency: "usd",
    lookup_key: PRICE_LOOKUP_KEY,
    billing_scheme: "per_unit",
    unit_amount_decimal: centsPerToken.toFixed(12).replace(/0+$/, "").replace(/\.$/, ""),
    recurring: { interval: "month", usage_type: "metered", meter: meter.id },
    nickname: `Tokens @ $${usdPerMillion}/M`,
  });
  console.log(`+ product created: ${product.id}`);
  console.log(`+ price created: ${price.id} (${price.unit_amount_decimal}¢/token, monthly metered)`);
}

console.log(`\nAdd to the ${mode} deploy environment:\n`);
console.log(`  STRIPE_PRICE_TOKENS=${price.id}`);
if (process.env.STRIPE_TOKEN_METER_EVENT) {
  console.log(`  STRIPE_TOKEN_METER_EVENT=${EVENT_NAME}`);
} else {
  console.log(`  # STRIPE_TOKEN_METER_EVENT defaults to "${EVENT_NAME}" in code — set only to override`);
}
console.log(`\nThen flip RB_METERING (off → count → on) per docs/METERING.md.`);
