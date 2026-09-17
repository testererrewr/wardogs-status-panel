import crypto from 'node:crypto';
import { getSiteSettings } from './db.js';
import { decryptSecret } from './crypto.js';

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
  const cfg = credentials(settings);
  return cfg.mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
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
      if (current?.id === existingId && current?.url === url) return current;
    } catch {}
  }
  return api('/v1/notifications/webhooks', {
    method: 'POST', requestId: crypto.randomUUID(), settings,
    body: { url, event_types: [{ name: 'PAYMENT.CAPTURE.COMPLETED' }, { name: 'PAYMENT.CAPTURE.DENIED' }, { name: 'PAYMENT.CAPTURE.REFUNDED' }, { name: 'PAYMENT.CAPTURE.REVERSED' }] }
  });
}
