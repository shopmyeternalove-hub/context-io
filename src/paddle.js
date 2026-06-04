/*
  paddle.js
  ---------
  Thin wrapper around @paddle/paddle-node-sdk for two jobs:
    1. unmarshalWebhook() — verify a webhook's signature and return the event.
    2. handlePaddleEvent() — translate a subscription lifecycle event into a
       single user_profiles update (plan + paddle ids + status).

  Reconciliation: at checkout the portal passes customData.userId. Subscription
  creation carries it through, so we read it from event.data.customData.userId.
  Later events (updated/canceled) may not carry customData, so we fall back to
  looking the user up by the paddle_subscription_id we stored on creation.

  Env: PADDLE_API_KEY, PADDLE_WEBHOOK_SECRET, PADDLE_ENVIRONMENT (sandbox|production).
*/

const { Paddle, Environment } = require("@paddle/paddle-node-sdk");
const supabase = require("./supabase");

let paddleClient = null;

function getPaddle() {
  if (paddleClient) return paddleClient;
  const apiKey = process.env.PADDLE_API_KEY;
  if (!apiKey) return null;
  const environment =
    process.env.PADDLE_ENVIRONMENT === "production"
      ? Environment.production
      : Environment.sandbox;
  paddleClient = new Paddle(apiKey, { environment });
  return paddleClient;
}

// Verify a raw webhook body + signature. Throws if not configured or invalid.
async function unmarshalWebhook(rawBody, signature) {
  const p = getPaddle();
  if (!p) throw new Error("paddle_not_configured");
  const secret = process.env.PADDLE_WEBHOOK_SECRET;
  if (!secret) throw new Error("paddle_webhook_secret_missing");
  // unmarshal validates the signature and returns a typed event entity.
  return p.webhooks.unmarshal(rawBody, secret, signature);
}

// Subscription statuses that should grant Pro access. Per Paddle's guidance,
// trialing / active / past_due all keep the customer provisioned.
const ACTIVE_STATUSES = new Set(["active", "trialing", "past_due"]);

async function resolveUserId(event) {
  const fromCustom = event?.data?.customData?.userId;
  if (fromCustom) return fromCustom;
  const subId = event?.data?.id;
  if (subId) {
    const userId = await supabase.findUserByPaddleSubscription(subId);
    if (userId) return userId;
  }
  return null;
}

async function handlePaddleEvent(event) {
  const type = event?.eventType || "";
  // We only act on subscription lifecycle events for now.
  if (!type.startsWith("subscription.")) return;

  const data = event.data || {};
  const status = data.status; // active | trialing | past_due | paused | canceled
  const subId = data.id;
  const customerId = data.customerId;

  const userId = await resolveUserId(event);
  if (!userId) {
    console.error(
      `[paddle] unresolved user — event=${type} sub=${subId || "?"}`
    );
    return; // nothing to update; route still returns 200
  }

  const plan = ACTIVE_STATUSES.has(status) ? "pro" : "free";
  await supabase.applySubscriptionState(userId, {
    plan,
    paddle_customer_id: customerId || null,
    paddle_subscription_id: subId || null,
    subscription_status: status || null,
  });

  // No PII, no card data — mirrors the [translate] log line style.
  console.log(
    `[paddle] {"event":"${type}","user_id":"${userId}","status":"${status || "?"}","plan":"${plan}"}`
  );
}

// Schedule cancellation for the end of the current billing period; the
// customer keeps Pro until then. subscription.canceled fires at period end,
// which flips plan -> free via handlePaddleEvent.
async function cancelSubscription(subscriptionId) {
  const p = getPaddle();
  if (!p) throw new Error("paddle_not_configured");
  return p.subscriptions.cancel(subscriptionId, { effectiveFrom: "next_billing_period" });
}

module.exports = { getPaddle, unmarshalWebhook, handlePaddleEvent, cancelSubscription };
