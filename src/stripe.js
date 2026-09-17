import Stripe from 'stripe';
import { decryptSecret } from './crypto.js';
import { getSiteSettings } from './db.js';

const PREMIUM_IDS = ['premium5','premium10','premium15','premium20'];

function config(settings = getSiteSettings()) {
  const api = settings?.premiumSales?.stripeApi || {};
  let secretKey = '';
  let webhookSecret = '';
  try { if (api.secretKeyEnc) secretKey = decryptSecret(api.secretKeyEnc); } catch {}
  try { if (api.webhookSecretEnc) webhookSecret = decryptSecret(api.webhookSecretEnc); } catch {}
  secretKey ||= String(process.env.STRIPE_SECRET_KEY || '').trim();
  webhookSecret ||= String(process.env.STRIPE_WEBHOOK_SECRET || '').trim();
  const mode = String(api.mode || (secretKey.startsWith('sk_live_') ? 'live' : 'test')).toLowerCase() === 'live' ? 'live' : 'test';
  return { mode, secretKey, webhookSecret, endpointId: String(api.endpointId || '') };
}

function client(settings = getSiteSettings()) {
  const cfg = config(settings);
  if (!cfg.secretKey) throw new Error('Stripe Secret Key is not configured');
  if (cfg.mode === 'test' && !cfg.secretKey.startsWith('sk_test_')) throw new Error('Stripe Test mode requires an sk_test_ Secret Key');
  if (cfg.mode === 'live' && !cfg.secretKey.startsWith('sk_live_')) throw new Error('Stripe Live mode requires an sk_live_ Secret Key');
  return new Stripe(cfg.secretKey);
}

export function stripeConfigured(settings = getSiteSettings()) {
  const cfg = config(settings);
  return Boolean(cfg.secretKey);
}

export function stripeCredentialState(settings = getSiteSettings()) {
  const api = settings?.premiumSales?.stripeApi || {};
  const cfg = config(settings);
  return { mode: cfg.mode, configured: Boolean(cfg.secretKey), hasSecret: Boolean(cfg.secretKey), hasWebhookSecret: Boolean(cfg.webhookSecret), endpointId: cfg.endpointId, storedInPanel: Boolean(api.secretKeyEnc) };
}

export async function testStripeConnection(settings = getSiteSettings()) {
  const stripe = client(settings);
  return stripe.balance.retrieve();
}

export async function createStripeCheckout({ recordId, userDiscordId, planId, amount, currency, accessDays = 30, recurring = false, successUrl, cancelUrl, settings = getSiteSettings() }) {
  const stripe = client(settings);
  const unitAmount = Math.round(Number(amount) * 100);
  if (!Number.isInteger(unitAmount) || unitAmount < 50) throw new Error('Stripe amount is invalid or too small');
  const label = ({premium5:'Premium 5',premium10:'Premium 10',premium15:'Premium 15',premium20:'Premium 20'})[planId] || planId;
  const metadata = { recordId, userDiscordId, planId, billingType: recurring ? 'subscription' : 'one_time', accessDays: String(accessDays) };
  const priceData = { currency: String(currency || 'EUR').toLowerCase(), product_data: { name: `status-hub.lol ${label}` }, unit_amount: unitAmount };
  if (recurring) priceData.recurring = { interval: 'month', interval_count: 1 };
  return stripe.checkout.sessions.create({
    mode: recurring ? 'subscription' : 'payment',
    success_url: `${successUrl}${successUrl.includes('?')?'&':'?'}session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: cancelUrl,
    client_reference_id: recordId,
    metadata,
    ...(recurring ? { subscription_data: { metadata } } : { payment_intent_data: { metadata } }),
    line_items: [{ price_data: priceData, quantity: 1 }]
  });
}

export async function retrieveStripeCheckout(sessionId, settings = getSiteSettings()) {
  return client(settings).checkout.sessions.retrieve(sessionId, { expand: ['subscription','payment_intent'] });
}

export async function retrieveStripeSubscription(subscriptionId, settings = getSiteSettings()) {
  return client(settings).subscriptions.retrieve(subscriptionId);
}

export async function cancelStripeSubscriptionAtPeriodEnd(subscriptionId, settings = getSiteSettings()) {
  return client(settings).subscriptions.update(subscriptionId, { cancel_at_period_end: true });
}

export async function resumeStripeSubscription(subscriptionId, settings = getSiteSettings()) {
  return client(settings).subscriptions.update(subscriptionId, { cancel_at_period_end: false });
}

export function verifyStripeWebhook(rawBody, signature, settings = getSiteSettings()) {
  const cfg = config(settings);
  if (!cfg.webhookSecret) throw new Error('Stripe webhook secret is not configured');
  return client(settings).webhooks.constructEvent(rawBody, signature, cfg.webhookSecret);
}

export async function ensureStripeWebhook({ endpointId = '', url, settings = getSiteSettings() }) {
  const stripe = client(settings);
  if (endpointId) {
    try {
      const existing = await stripe.webhookEndpoints.retrieve(endpointId);
      if (existing && !existing.deleted) {
        if (existing.url !== url) {
          const updated = await stripe.webhookEndpoints.update(endpointId, { url, enabled_events: ['checkout.session.completed','invoice.paid','invoice.payment_failed','customer.subscription.updated','customer.subscription.deleted'] });
          return { endpoint: updated, secret: '' };
        }
        return { endpoint: existing, secret: '' };
      }
    } catch {}
  }
  const endpoint = await stripe.webhookEndpoints.create({
    url,
    enabled_events: ['checkout.session.completed','invoice.paid','invoice.payment_failed','customer.subscription.updated','customer.subscription.deleted']
  });
  return { endpoint, secret: endpoint.secret || '' };
}

export function stripePlanIds() { return [...PREMIUM_IDS]; }
