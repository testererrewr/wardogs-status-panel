import crypto from 'node:crypto';
import { getSiteSettings } from './db.js';
import { decryptSecret } from './crypto.js';

const PREMIUM_IDS = ['premium5', 'premium10', 'premium15', 'premium20'];

function credentials(settings = getSiteSettings()) {
  const api = settings?.premiumSales?.paypalApi || {};
  const mode = String(api.mode || process.env.PAYPAL_MODE || 'sandbox').toLowerCase() === 'live' ? 'live' : 'sandbox';
  const clientId = String(api.clientId || process.env.PAYPAL_CLIENT_ID || '').trim();
  let clientSecret = '';
  if (api.clientSecretEnc) {
    try { clientSecret = decryptSecret(api.clientSecretEnc); } catch { clientSecret = ''; }
  }
  if (!clientSecret) clientSecret = String(process.env.PAYPAL_CLIENT_SECRET || '').trim();
  return { mode, clientId, clientSecret };
}

function baseUrl(settings) {
  return credentials(settings).mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}

export function paypalEnvironment(settings = getSiteSettings()) { return credentials(settings).mode; }
export function paypalConfigured(settings = getSiteSettings()) {
  const cfg = credentials(settings);
  return Boolean(cfg.clientId && cfg.clientSecret);
}
export function paypalCredentialState(settings = getSiteSettings()) {
  const api = settings?.premiumSales?.paypalApi || {};
  const cfg = credentials(settings);
  return { mode: cfg.mode, clientId: String(api.clientId || process.env.PAYPAL_CLIENT_ID || ''), hasSecret: Boolean(cfg.clientSecret), configured: Boolean(cfg.clientId && cfg.clientSecret), storedInPanel: Boolean(api.clientId && api.clientSecretEnc) };
}

async function accessToken(settings = getSiteSettings()) {
  const cfg = credentials(settings);
  if (!cfg.clientId || !cfg.clientSecret) throw new Error('PayPal API credentials are not configured');
  const auth = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
  const response = await fetch(`${baseUrl(settings)}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: 'grant_type=client_credentials'
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    const detail = body.error_description || body.message || body.error || `PayPal OAuth failed (${response.status})`;
    if (response.status === 401 && /authentication failed|invalid_client/i.test(String(detail))) {
      const label = cfg.mode === 'sandbox' ? 'Sandbox' : 'Live';
      throw new Error(`PayPal ${label} credentials rejected. Client ID and Client Secret must come from the same ${label} REST app.`);
    }
    throw new Error(detail);
  }
  return body.access_token;
}

async function api(path, { method = 'GET', body, requestId, settings = getSiteSettings() } = {}) {
  const token = await accessToken(settings);
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (requestId) headers['PayPal-Request-Id'] = requestId;
  const response = await fetch(`${baseUrl(settings)}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = Array.isArray(data.details) && data.details[0]?.description ? `: ${data.details[0].description}` : '';
    throw new Error(`${data.message || data.error_description || data.name || 'PayPal API error'}${detail} (${response.status})`);
  }
  return data;
}

export async function createCheckoutOrder({ purchaseId, planId, amount, currency, returnUrl, cancelUrl, settings = getSiteSettings() }) {
  const data = await api('/v2/checkout/orders', {
    method: 'POST', requestId: purchaseId, settings,
    body: {
      intent: 'CAPTURE',
      purchase_units: [{ reference_id: 'default', description: `status-hub.lol ${planId}`, custom_id: purchaseId, invoice_id: `SH-${purchaseId}`.slice(0, 127), amount: { currency_code: currency, value: amount } }],
      payment_source: { paypal: { experience_context: { brand_name: 'status-hub.lol', shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW', return_url: returnUrl, cancel_url: cancelUrl } } }
    }
  });
  const approvalUrl = data.links?.find((x) => x.rel === 'payer-action' || x.rel === 'approve')?.href || '';
  if (!data.id || !approvalUrl) throw new Error('PayPal did not return an approval URL');
  return { orderId: data.id, approvalUrl };
}

export async function getCheckoutOrder(orderId, settings = getSiteSettings()) { return api(`/v2/checkout/orders/${encodeURIComponent(orderId)}`, { settings }); }
export async function captureCheckoutOrder(orderId, settings = getSiteSettings()) {
  return api(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, { method: 'POST', requestId: `capture-${orderId}`, body: {}, settings });
}

export function extractCompletedCapture(order) {
  const pu = Array.isArray(order?.purchase_units) ? order.purchase_units[0] : null;
  const captures = pu?.payments?.captures || [];
  const capture = captures.find((x) => x.status === 'COMPLETED') || captures[0] || null;
  return { orderId: order?.id || '', status: capture?.status || order?.status || '', captureId: capture?.id || '', customId: capture?.custom_id || pu?.custom_id || '', amount: capture?.amount?.value || pu?.amount?.value || '', currency: capture?.amount?.currency_code || pu?.amount?.currency_code || '' };
}

export async function createSubscriptionProduct({ settings = getSiteSettings() } = {}) {
  return api('/v1/catalogs/products', {
    method: 'POST', requestId: crypto.randomUUID(), settings,
    body: { name: 'status-hub.lol Premium', description: 'Monthly status-hub.lol Premium subscription', type: 'SERVICE', category: 'SOFTWARE', home_url: 'https://status-hub.lol' }
  });
}

export async function createManagedServiceProduct({ name, description, homeUrl = 'https://status-hub.lol', settings = getSiteSettings() }) {
  return api('/v1/catalogs/products', {
    method: 'POST', requestId: crypto.randomUUID(), settings,
    body: {
      name: String(name || 'status-hub.lol Managed Bot').slice(0, 127),
      description: String(description || 'Managed bot service subscription').slice(0, 255),
      type: 'SERVICE', category: 'SOFTWARE', home_url: String(homeUrl || 'https://status-hub.lol').slice(0, 2048)
    }
  });
}

export async function createManagedServicePlan({ productId, name, description, amount, currency, settings = getSiteSettings() }) {
  return api('/v1/billing/plans', {
    method: 'POST', requestId: crypto.randomUUID(), settings,
    body: {
      product_id: productId,
      name: String(name || 'Managed Bot').slice(0, 127),
      description: String(description || 'Managed bot monthly subscription').slice(0, 127),
      billing_cycles: [{ frequency: { interval_unit: 'MONTH', interval_count: 1 }, tenure_type: 'REGULAR', sequence: 1, total_cycles: 0, pricing_scheme: { fixed_price: { value: amount, currency_code: currency } } }],
      payment_preferences: { auto_bill_outstanding: true, setup_fee_failure_action: 'CANCEL', payment_failure_threshold: 1 }
    }
  });
}

export async function ensureManagedServiceSubscriptionPlan({ productId = '', planId = '', planMeta = {}, name, description, amount, currency = 'EUR', homeUrl = 'https://status-hub.lol', settings = getSiteSettings() }) {
  let finalProductId = String(productId || '');
  if (!finalProductId) {
    const product = await createManagedServiceProduct({ name, description, homeUrl, settings });
    if (!product?.id) throw new Error('PayPal did not return a product ID for the bot service');
    finalProductId = product.id;
  }
  const meta = planMeta && typeof planMeta === 'object' ? planMeta : {};
  if (planId && meta.amount === amount && meta.currency === currency) return { productId: finalProductId, planId, planMeta: meta };
  const plan = await createManagedServicePlan({ productId: finalProductId, name, description, amount, currency, settings });
  if (!plan?.id) throw new Error('PayPal did not return a plan ID for the bot service');
  return { productId: finalProductId, planId: plan.id, planMeta: { amount, currency, createdAt: new Date().toISOString() } };
}

export async function createSubscriptionPlan({ productId, planId, amount, currency, settings = getSiteSettings() }) {
  const names = { premium5: 'Premium 5', premium10: 'Premium 10', premium15: 'Premium 15', premium20: 'Premium 20' };
  return api('/v1/billing/plans', {
    method: 'POST', requestId: crypto.randomUUID(), settings,
    body: {
      product_id: productId,
      name: `status-hub.lol ${names[planId] || planId}`,
      description: `${names[planId] || planId} monthly subscription`,
      billing_cycles: [{ frequency: { interval_unit: 'MONTH', interval_count: 1 }, tenure_type: 'REGULAR', sequence: 1, total_cycles: 0, pricing_scheme: { fixed_price: { value: amount, currency_code: currency } } }],
      payment_preferences: { auto_bill_outstanding: true, setup_fee_failure_action: 'CANCEL', payment_failure_threshold: 1 }
    }
  });
}

export async function ensureSubscriptionCatalog({ productId = '', planIds = {}, planMeta = {}, amounts = {}, currency = 'EUR', settings = getSiteSettings() }) {
  let finalProductId = String(productId || '');
  if (!finalProductId) {
    const product = await createSubscriptionProduct({ settings });
    if (!product?.id) throw new Error('PayPal did not return a product ID');
    finalProductId = product.id;
  }
  const finalPlanIds = { ...planIds };
  const finalPlanMeta = { ...planMeta };
  for (const planId of PREMIUM_IDS) {
    const amount = String(amounts?.[planId] || '').trim();
    if (!amount) continue;
    const meta = finalPlanMeta[planId] || {};
    const unchanged = finalPlanIds[planId] && meta.amount === amount && meta.currency === currency;
    if (unchanged) continue;
    const plan = await createSubscriptionPlan({ productId: finalProductId, planId, amount, currency, settings });
    if (!plan?.id) throw new Error(`PayPal did not return a plan ID for ${planId}`);
    finalPlanIds[planId] = plan.id;
    finalPlanMeta[planId] = { amount, currency, createdAt: new Date().toISOString() };
  }
  return { productId: finalProductId, planIds: finalPlanIds, planMeta: finalPlanMeta };
}

export async function createSubscription({ recordId, paypalPlanId, returnUrl, cancelUrl, settings = getSiteSettings() }) {
  const data = await api('/v1/billing/subscriptions', {
    method: 'POST', requestId: recordId, settings,
    body: {
      plan_id: paypalPlanId,
      custom_id: recordId,
      application_context: { brand_name: 'status-hub.lol', shipping_preference: 'NO_SHIPPING', user_action: 'SUBSCRIBE_NOW', return_url: returnUrl, cancel_url: cancelUrl }
    }
  });
  const approvalUrl = data.links?.find((x) => x.rel === 'approve')?.href || '';
  if (!data.id || !approvalUrl) throw new Error('PayPal did not return a subscription approval URL');
  return { subscriptionId: data.id, approvalUrl, status: data.status || 'APPROVAL_PENDING' };
}

export async function getSubscription(subscriptionId, settings = getSiteSettings()) {
  return api(`/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`, { settings });
}

export async function cancelSubscription(subscriptionId, reason = 'Cancelled by customer', settings = getSiteSettings()) {
  return api(`/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, { method: 'POST', body: { reason: String(reason).slice(0, 128) || 'Cancelled by customer' }, settings });
}

export async function verifyWebhook(headers, event, webhookId, settings = getSiteSettings()) {
  if (!webhookId) throw new Error('PayPal webhook ID is not configured');
  const payload = {
    auth_algo: String(headers['paypal-auth-algo'] || ''), cert_url: String(headers['paypal-cert-url'] || ''), transmission_id: String(headers['paypal-transmission-id'] || ''), transmission_sig: String(headers['paypal-transmission-sig'] || ''), transmission_time: String(headers['paypal-transmission-time'] || ''), webhook_id: webhookId, webhook_event: event
  };
  if (!payload.auth_algo || !payload.cert_url || !payload.transmission_id || !payload.transmission_sig || !payload.transmission_time) return false;
  const result = await api('/v1/notifications/verify-webhook-signature', { method: 'POST', body: payload, settings });
  return result.verification_status === 'SUCCESS';
}

export async function ensureWebhook(existingId, url, settings = getSiteSettings()) {
  if (existingId) {
    try {
      const current = await api(`/v1/notifications/webhooks/${encodeURIComponent(existingId)}`, { settings });
      if (current?.id === existingId && current?.url === url) {
        const hasAll = Array.isArray(current.event_types) && current.event_types.some((x) => x.name === '*');
        if (!hasAll) {
          try { await api(`/v1/notifications/webhooks/${encodeURIComponent(existingId)}`, { method: 'PATCH', body: [{ op: 'replace', path: '/event_types', value: [{ name: '*' }] }], settings }); } catch {}
        }
        return await api(`/v1/notifications/webhooks/${encodeURIComponent(existingId)}`, { settings });
      }
    } catch {}
  }
  return api('/v1/notifications/webhooks', {
    method: 'POST', requestId: crypto.randomUUID(), settings,
    body: { url, event_types: [{ name: '*' }] }
  });
}
