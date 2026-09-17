import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import multer from 'multer';
import { rateLimit } from 'express-rate-limit';
import {
  readDb, findUser, upsertUser, deleteUser, getServer, listServersFor, upsertServer, deleteServer,
  getCustomBot, listCustomBotsFor, upsertCustomBot, deleteCustomBot, assignLegacyOwnership,
  listStatusNodes, getStatusNode, upsertStatusNode, deleteStatusNode, getSiteSettings, updateSiteSettings,
  listSupporters, upsertSupporter, deleteSupporter, listBotServices, getBotService, upsertBotService, deleteBotService,
  createPaypalPurchase, getPaypalPurchase, getPaypalPurchaseByOrder, updatePaypalPurchase, rememberPaypalWebhookEvent, paypalWebhookEventSeen,
  createPaypalSubscriptionRecord, getPaypalSubscriptionRecord, getPaypalSubscriptionByPaypalId, listPaypalSubscriptionsForUser, updatePaypalSubscriptionRecord
} from './db.js';
import { encryptSecret, decryptSecret } from './crypto.js';
import { fetchServerStatus, gameTypeLabel } from './server-query.js';
import { esc, layout, serverForm, customBotForm, gamesPage } from './html.js';
import { tr, normalizeLang, localeCode } from './i18n.js';
import { FileSessionStore } from './file-session-store.js';
import { prepareCustomBot, parseEnvText, deleteCustomBotFiles } from './custom-bots.js';
import { ensureCustomBot, restartCustomBot, stopCustomBot, deleteCustomBotRuntime, customBotStatus, customBotLogs } from './runner-client.js';
import { gameDigMeta, gameDigFieldDefs } from './game-catalog.js';
import { PLANS, effectivePlan } from './plans.js';
import { registerStatusNode, authenticateStatusNode, heartbeatStatusNode, materializeWorkForNode, rebalanceAssignments, clusterRuntime, nodeIsHealthy, leaseSeconds, moveServerToNode, moveAllFromNode, drainStatusNode, restartAllBotsOnNode } from './cluster.js';
import { verifyFreeBoostForUser, refreshDueFreeBoosts, freeBoostRanges, recalculateStoredFreeBoostLimits } from './free-boost.js';
import { paypalConfigured, paypalEnvironment, paypalCredentialState, createCheckoutOrder, getCheckoutOrder, captureCheckoutOrder, extractCompletedCapture, verifyWebhook, ensureWebhook, ensureSubscriptionCatalog, createSubscription, getSubscription, cancelSubscription } from './paypal.js';
import { runLifecycleSweep, renewFreeAccess, freeRenewState, markPremiumDowngrade, FREE_RENEW_DAYS, GRACE_DAYS } from './lifecycle.js';

const required = ['SESSION_SECRET', 'APP_ENCRYPTION_KEY', 'STATUS_NODE_JOIN_SECRET'];
for (const key of required) if (!process.env[key]) throw new Error(`${key} fehlt in .env`);

const app = express();
const port = Number(process.env.PORT || 3000);
const baseUrl = String(process.env.PUBLIC_URL || '').replace(/\/+$/, '');
if (!/^https?:\/\//i.test(baseUrl)) throw new Error('PUBLIC_URL muss mit http:// oder https:// beginnen');
const redirectUri = `${baseUrl}/auth/discord/callback`;
const secureCookie = process.env.COOKIE_SECURE === 'true' || baseUrl.startsWith('https://');
const bootstrapAdmins = new Set((process.env.ADMIN_DISCORD_IDS || '').split(',').map((x) => x.trim()).filter(Boolean));
const firstAdmin = [...bootstrapAdmins][0] || '';
const uploadMaxMb = Math.min(25, Math.max(1, Number(process.env.CUSTOM_UPLOAD_MAX_MB || 5)));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: uploadMaxMb * 1024 * 1024, files: 1 } });

assignLegacyOwnership(firstAdmin);

if (process.env.TRUST_PROXY !== 'false') app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '128kb' }));
app.use(express.static('public', { maxAge: 0, etag: true }));
const canonical = new URL(baseUrl);
app.use((req, res, next) => {
  if (req.path.startsWith('/api/status-nodes/') || req.path === '/healthz') return next();
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const host = String(req.get('host') || '');
  const forwardedProto = String(req.headers['x-forwarded-proto'] || req.protocol || '').split(',')[0].trim();
  if (host && (host !== canonical.host || (canonical.protocol === 'https:' && forwardedProto !== 'https'))) {
    return res.redirect(308, `${baseUrl}${req.originalUrl}`);
  }
  next();
});
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 3000, standardHeaders: 'draft-8', legacyHeaders: false }));
app.use(session({
  store: new FileSessionStore({ file: 'data/sessions.json' }),
  name: 'serverhub.sid', secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: secureCookie, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

function csrf(req) { if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('base64url'); return req.session.csrf; }
function checkCsrf(req, res, next) {
  const a = Buffer.from(String(req.body?._csrf || '')); const b = Buffer.from(String(req.session.csrf || ''));
  if (!a.length || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(403).send('Ungültiges CSRF-Token. Seite neu laden.');
  next();
}
function flash(req, type, message) { req.session.flash = { type, message }; }
function takeFlash(req) { const f = req.session.flash; delete req.session.flash; return f; }
function currentUser(req) {
  const sessionUser = req.session.user;
  if (!sessionUser) return null;
  const dbUser = findUser(sessionUser.discordId);
  if (!dbUser) return null;
  return { ...dbUser, avatarUrl: sessionUser.avatarUrl || '' };
}
function langOf(req) { return normalizeLang(req.session?.lang || currentUser(req)?.locale || 'de'); }
function l(req, de, en) { return tr(langOf(req), de, en); }
function cookieValue(req, name) { const raw=String(req.headers.cookie||'').split(';').map((x)=>x.trim()).find((x)=>x.startsWith(`${name}=`)); if(!raw)return ''; try{return decodeURIComponent(raw.slice(name.length+1));}catch{return '';} }
function cookieConsent(req) { try { const value=JSON.parse(Buffer.from(cookieValue(req,'sh_cookie_consent'),'base64url').toString('utf8')); return value&&value.v===1?value:null; } catch { return null; } }
function render(req, res, title, body) { const settings=getSiteSettings(); res.send(layout({ title, body, user: currentUser(req), csrf: csrf(req), flash: takeFlash(req), lang: langOf(req), serviceDomain: settings.serviceDomain || 'status-hub.lol', cookieConsent: cookieConsent(req) })); }
function requireLogin(req, res, next) { if (!currentUser(req)) return res.redirect('/login'); next(); }
function requireAdmin(req, res, next) { const u = currentUser(req); if (!u) return res.redirect('/login'); if (u.role !== 'admin') return res.status(403).send('Keine Berechtigung'); next(); }
function validSnowflake(value) { return /^\d{17,20}$/.test(String(value || '').trim()); }
function isAdmin(req) { return currentUser(req)?.role === 'admin'; }
function statusLimit(user) { return effectivePlan(user).statusBotLimit; }
function customLimit(user) { return user?.role === 'admin' ? Infinity : Math.max(0, Number(user?.customBotLimit || 0)); }
function discordOAuthConfig(settings = getSiteSettings()) {
  const raw = settings.discordOAuth || {};
  const clientId = String(raw.clientId || process.env.DISCORD_OAUTH_CLIENT_ID || '').trim();
  let clientSecret = '';
  let storedInPanel = false;
  if (raw.clientSecretEnc) {
    try { clientSecret = decryptSecret(raw.clientSecretEnc); storedInPanel = Boolean(clientSecret); } catch {}
  }
  if (!clientSecret) clientSecret = String(process.env.DISCORD_OAUTH_CLIENT_SECRET || '').trim();
  return {
    enabled: raw.enabled !== false,
    allowRegistration: raw.allowRegistration !== false,
    clientId,
    clientSecret,
    configured: Boolean(clientId && clientSecret),
    storedInPanel,
    redirectUri
  };
}


function normalizedMoney(value) {
  const raw = String(value ?? '').trim().replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return '';
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10000) return '';
  return amount.toFixed(2);
}
function paypalAutoConfig(settings = getSiteSettings()) {
  const auto = settings.premiumSales?.paypalAuto || {};
  const currency = /^[A-Z]{3}$/.test(String(auto.currency || '').toUpperCase()) ? String(auto.currency).toUpperCase() : 'EUR';
  const accessDays = Math.max(1, Math.min(3650, Number(auto.accessDays) || 30));
  const amounts = {};
  for (const id of ['premium5','premium10','premium15','premium20']) amounts[id] = normalizedMoney(auto.amounts?.[id]);
  return { ...auto, currency, accessDays, amounts };
}
function paypalAutoReady(settings = getSiteSettings()) {
  const auto = paypalAutoConfig(settings);
  return Boolean(auto.enabled && paypalConfigured(settings));
}
function paypalSubscriptionConfig(settings = getSiteSettings()) {
  const raw = settings.premiumSales?.paypalSubscription || {};
  const currency = paypalAutoConfig(settings).currency;
  const amounts = {};
  for (const id of ['premium5','premium10','premium15','premium20']) amounts[id] = normalizedMoney(raw.amounts?.[id]);
  return { enabled: raw.enabled !== false, productId: String(raw.productId || ''), planIds: { ...(raw.planIds || {}) }, planMeta: { ...(raw.planMeta || {}) }, amounts, currency };
}
function paypalSubscriptionReady(settings = getSiteSettings(), planId = '') {
  const sub = paypalSubscriptionConfig(settings);
  if (!sub.enabled || !paypalConfigured(settings)) return false;
  if (planId) return Boolean(sub.amounts[planId] && sub.planIds[planId]);
  return ['premium5','premium10','premium15','premium20'].some((id) => sub.amounts[id] && sub.planIds[id]);
}
function subscriptionEntitlementExpiry(details, fallbackMs = 32 * 86400_000) {
  const next = Date.parse(details?.billing_info?.next_billing_time || '');
  return new Date(Number.isFinite(next) ? next : Date.now() + fallbackMs).toISOString();
}
function applyPaypalSubscription(record, details, reason = 'subscription') {
  runLifecycleSweep();
  const fresh = getPaypalSubscriptionRecord(record?.id || '');
  if (!fresh) throw new Error('PayPal subscription record not found');
  const user = findUser(fresh.userDiscordId);
  if (!user) throw new Error('User for PayPal subscription not found');
  const status = String(details?.status || fresh.status || '').toUpperCase();
  if (!['ACTIVE','APPROVED'].includes(status)) return updatePaypalSubscriptionRecord(fresh.id, { status, lastSyncAt: new Date().toISOString() });
  const hasConfirmedPayment = Boolean(details?.billing_info?.last_payment?.time) || reason === 'recurring_payment';
  if (!hasConfirmedPayment) return updatePaypalSubscriptionRecord(fresh.id, { status: 'ACTIVE_PENDING_PAYMENT', subscriptionId: fresh.subscriptionId || details?.id || '', nextBillingAt: details?.billing_info?.next_billing_time || null, lastSyncAt: new Date().toISOString() });
  const expiresAt = subscriptionEntitlementExpiry(details);
  upsertUser({ discordId: user.discordId, planId: fresh.planId, planExpiresAt: expiresAt, premiumSource: { provider: 'paypal_subscription', recordId: fresh.id, subscriptionId: fresh.subscriptionId || details?.id || '', reason }, premiumDowngradeStartedAt: null, premiumDowngradeUntil: null, premiumDowngradeKeepServerId: null, freeRenewGraceStartedAt: null });
  const updated = updatePaypalSubscriptionRecord(fresh.id, { status: 'ACTIVE', subscriptionId: fresh.subscriptionId || details?.id || '', nextBillingAt: details?.billing_info?.next_billing_time || null, entitlementExpiresAt: expiresAt, activatedAt: fresh.activatedAt || new Date().toISOString(), lastSyncAt: new Date().toISOString() });
  rebalanceAssignments();
  return updated;
}
function subscriptionFromPaypalEvent(event) {
  const resource = event?.resource || {};
  const directId = String(resource.id || '');
  if (directId) {
    const direct = getPaypalSubscriptionByPaypalId(directId);
    if (direct) return direct;
  }
  const billingId = String(resource.billing_agreement_id || resource.billing_agreement_id || resource?.supplementary_data?.related_ids?.subscription_id || '');
  if (billingId) {
    const byBilling = getPaypalSubscriptionByPaypalId(billingId);
    if (byBilling) return byBilling;
  }
  const customId = String(resource.custom_id || '');
  if (customId) {
    const byRecord = getPaypalSubscriptionRecord(customId);
    if (byRecord) return byRecord;
  }
  return null;
}
function moneyMatches(a, b) { return normalizedMoney(a) === normalizedMoney(b); }
function applyPaypalPurchase(purchase, capture) {
  runLifecycleSweep();
  const fresh = getPaypalPurchase(purchase.id);
  if (!fresh) throw new Error('PayPal purchase not found');
  if (fresh.appliedAt) return fresh;
  if (capture.status !== 'COMPLETED') throw new Error('PayPal payment is not completed');
  if (capture.customId && capture.customId !== fresh.id) throw new Error('PayPal purchase reference mismatch');
  if (!moneyMatches(capture.amount, fresh.amount) || String(capture.currency || '').toUpperCase() !== String(fresh.currency || '').toUpperCase()) throw new Error('PayPal amount mismatch');
  const user = findUser(fresh.userDiscordId);
  if (!user) throw new Error('User for PayPal purchase not found');
  const days = Math.max(1, Math.min(3650, Number(fresh.accessDays) || 30));
  const now = Date.now();
  const existingExpiry = Date.parse(user.planExpiresAt || '');
  const base = user.planId === fresh.planId && Number.isFinite(existingExpiry) && existingExpiry > now ? existingExpiry : now;
  const expiresAt = new Date(base + days * 86400_000).toISOString();
  upsertUser({ discordId: user.discordId, planId: fresh.planId, planExpiresAt: expiresAt, premiumSource: { provider: 'paypal', purchaseId: fresh.id, captureId: capture.captureId || fresh.captureId || '' }, premiumDowngradeStartedAt: null, premiumDowngradeUntil: null, premiumDowngradeKeepServerId: null, freeRenewGraceStartedAt: null });
  const updated = updatePaypalPurchase(fresh.id, { status: 'completed', captureId: capture.captureId || fresh.captureId || '', completedAt: fresh.completedAt || new Date().toISOString(), appliedAt: new Date().toISOString(), entitlementExpiresAt: expiresAt });
  rebalanceAssignments();
  return updated;
}
function revokePaypalPurchase(purchase, reason) {
  if (!purchase) return;
  const user = findUser(purchase.userDiscordId);
  updatePaypalPurchase(purchase.id, { status: reason, revokedAt: new Date().toISOString() });
  if (user?.premiumSource?.provider === 'paypal' && user.premiumSource.purchaseId === purchase.id) {
    upsertUser({ discordId: user.discordId, planId: 'free', planExpiresAt: null, premiumSource: null });
    markPremiumDowngrade(user.discordId);
    rebalanceAssignments();
  }
}
function purchaseFromPaypalEvent(event) {
  const resource = event?.resource || {};
  const customId = String(resource.custom_id || '');
  if (customId) {
    const byId = getPaypalPurchase(customId);
    if (byId) return byId;
  }
  const db = readDb();
  const related = resource.supplementary_data?.related_ids || {};
  const orderId = String(related.order_id || resource.order_id || '');
  const captureId = String(related.capture_id || resource.capture_id || '');
  return (db.paypalPurchases || []).find((x) => (orderId && x.orderId === orderId) || (captureId && x.captureId === captureId)) || null;
}

function ownedServer(req, id) {
  const server = getServer(id); const u = currentUser(req);
  if (!server || !u) return null;
  return u.role === 'admin' || server.ownerDiscordId === u.discordId ? server : null;
}
function ownedCustom(req, id) {
  const bot = getCustomBot(id); const u = currentUser(req);
  if (!bot || !u) return null;
  return u.role === 'admin' || bot.ownerDiscordId === u.discordId ? bot : null;
}

async function discordApi(path, options = {}) {
  const response = await fetch(`https://discord.com/api/v10${path}`, options);
  if (!response.ok) throw new Error(`Discord API ${response.status}: ${(await response.text()).slice(0, 250)}`);
  return response.json();
}
async function validateBotToken(token) {
  try {
    const bot = await discordApi('/users/@me', { headers: { Authorization: `Bot ${token}` } });
    if (!bot.bot) throw new Error('Der Discord Token gehört nicht zu einem Bot-Account');
    return bot;
  } catch (error) {
    if (/Discord API 401/.test(String(error.message))) throw new Error('Discord Bot Token ungültig. Verwende den Bot Token aus Developer Portal → Bot, nicht Application ID oder Client Secret.');
    throw error;
  }
}

function parseTemplates(value, gameType = '') {
  const list = String(value || '').split(/\r?\n/).map((x) => x.trim().slice(0, 128)).filter(Boolean).slice(0, 10);
  if (gameType === 'text_only' && !list.length) throw new Error('Mindestens ein Status-Text ist erforderlich');
  return list.length ? list : ['{players}/{max} Spieler online', 'Map: {map}'];
}
function buildQuery(req, old = null) {
  const gameType = ['wardogs','fivem','gamedig','generic_json','text_only'].includes(req.body.gameType) ? req.body.gameType : 'fivem';
  let queryConfig = {};
  let newSecret = null;
  let clearSecret = false;
  if (gameType === 'text_only') {
    queryConfig = {};
    clearSecret = true;
  } else if (gameType === 'wardogs') {
    const base = String(req.body.baseUrl || '').trim().replace(/\/+$/, '');
    if (!base) throw new Error('WARDOGS Basis-URL fehlt');
    queryConfig = { baseUrl: base };
    if (req.body.querySecret) newSecret = String(req.body.querySecret);
    else if (!old?.querySecretEnc || old?.gameType !== 'wardogs') throw new Error('WARDOGS RCON Passwort fehlt');
  } else if (gameType === 'fivem') {
    const base = String(req.body.baseUrl || '').trim().replace(/\/+$/, '');
    if (!base) throw new Error('FiveM Basis-URL fehlt');
    queryConfig = { baseUrl: base };
    clearSecret = true;
  } else if (gameType === 'gamedig') {
    const host = String(req.body.queryHost || '').trim();
    const gameId = String(req.body.gameId || '').trim();
    const meta = gameDigMeta(gameId);
    if (!gameId || !meta) throw new Error('Bitte ein unterstütztes GameDig-Spiel aus der Liste auswählen');
    const p = req.body.queryPort ? Number(req.body.queryPort) : (meta.defaultPort || null);
    if (p && (p < 1 || p > 65535)) throw new Error('Ungültiger Port');

    const sameGame = old?.gameType === 'gamedig' && old?.queryConfig?.gameId === gameId;
    const oldExtra = sameGame && old?.queryConfig?.extraOptions && typeof old.queryConfig.extraOptions === 'object' ? old.queryConfig.extraOptions : {};
    let secretOptions = {};
    if (sameGame && old?.querySecretEnc) {
      try { secretOptions = JSON.parse(decryptSecret(old.querySecretEnc) || '{}'); } catch { secretOptions = {}; }
    }
    const extraOptions = { ...oldExtra };
    for (const field of gameDigFieldDefs(gameId)) {
      const raw = req.body[`gd_${field.key}`];
      if (field.type === 'checkbox') {
        if (!field.secret) extraOptions[field.key] = raw === '1';
        continue;
      }
      if (field.secret) {
        if (raw) secretOptions[field.key] = String(raw).trim();
        if (field.required && !secretOptions[field.key]) throw new Error(`${meta.name}: ${field.label} fehlt`);
      } else {
        let value = String(raw ?? field.default ?? '').trim();
        if (field.type === 'number' && value) {
          const n = Number(value); if (!Number.isFinite(n) || n < 1 || n > 65535) throw new Error(`${meta.name}: ${field.label} ist ungültig`); value = n;
        }
        if (field.required && !value) throw new Error(`${meta.name}: ${field.label} fehlt`);
        if (value !== '') extraOptions[field.key] = value; else delete extraOptions[field.key];
      }
    }
    if (meta.hostMode === 'required' && !host) throw new Error(`${meta.name}: Host / IP fehlt`);
    if (meta.hostMode === 'optional' && !host && !extraOptions.serverId) throw new Error(`${meta.name}: Host / IP oder Server ID fehlt`);
    queryConfig = { host, gameId, port: p || null, extraOptions };
    if (Object.keys(secretOptions).length) newSecret = JSON.stringify(secretOptions); else clearSecret = true;
  } else {
    const url = String(req.body.jsonUrl || '').trim(); if (!url) throw new Error('JSON URL fehlt');
    queryConfig = {
      url, currentPath: String(req.body.currentPath || 'players.current').trim(), maxPath: String(req.body.maxPath || 'players.max').trim(),
      mapPath: String(req.body.mapPath || 'map').trim(), namePath: String(req.body.namePath || 'serverName').trim()
    };
    if (req.body.genericToken) newSecret = String(req.body.genericToken);
    else if (old?.gameType !== 'generic_json') clearSecret = true;
  }
  return { gameType, queryConfig, newSecret, clearSecret };
}

app.get('/healthz', (req, res) => res.json({ ok: true, service: 'server-status-hub' }));
app.get('/language/:lang', (req, res) => {
  const lang = normalizeLang(req.params.lang);
  req.session.lang = lang;
  const u = currentUser(req);
  if (u) upsertUser({ discordId: u.discordId, locale: lang });
  let target = '/';
  try { const ref = new URL(String(req.get('referer') || ''), baseUrl); if (ref.origin === new URL(baseUrl).origin) target = `${ref.pathname}${ref.search}`; } catch {}
  res.redirect(target);
});

function nodeBearer(req) { const raw = String(req.headers.authorization || ''); return raw.startsWith('Bearer ') ? raw.slice(7).trim() : ''; }
function requireStatusNode(req, res, next) {
  const node = authenticateStatusNode(req.headers['x-status-node-id'], nodeBearer(req));
  if (!node) return res.status(401).json({ error: 'Ungültige Status-Node Authentifizierung' });
  req.statusNode = node; next();
}
app.post('/api/status-nodes/register', rateLimit({ windowMs: 60_000, limit: 20 }), (req, res) => {
  try { const result = registerStatusNode(req.body || {}); rebalanceAssignments(); res.set('Cache-Control','no-store').json({ ok: true, ...result, leaseSeconds }); }
  catch (error) { res.status(403).json({ error: error.message }); }
});
app.post('/api/status-nodes/heartbeat', requireStatusNode, (req, res) => {
  heartbeatStatusNode(req.statusNode, req.body || {}); rebalanceAssignments(); res.set('Cache-Control','no-store').json({ ok: true, leaseSeconds });
});
app.get('/api/status-nodes/work', requireStatusNode, (req, res) => {
  try { res.set('Cache-Control','no-store').json({ ok: true, leaseSeconds, servers: materializeWorkForNode(req.statusNode.id) }); }
  catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/login', (req, res) => {
  if (currentUser(req)) return res.redirect('/');
  const lang = langOf(req);
  render(req, res, 'status-hub.lol', `<section class="landing-hero"><div class="landing-copy"><span class="eyebrow">status-hub.lol</span><h1>${tr(lang,'Deine Discord Status-Bots. Einfach gehostet.','Your Discord status bots. Hosted simply.')}</h1><p>${tr(lang,'Erstelle Status-Bots für WARDOGS, FiveM, GameDig, JSON-APIs oder reine Text-Rotation. Ein kostenloser Bot ist inklusive.','Create status bots for WARDOGS, FiveM, GameDig, JSON APIs or text-only rotation. One free bot is included.')}</p><div class="actions wrap"><a class="button discord landing-cta" href="/auth/discord">${tr(lang,'Kostenlos mit Discord starten','Start free with Discord')}</a><a class="button ghost" href="/games">${tr(lang,'Unterstützte Games','Supported games')}</a></div><div class="landing-points"><span>✓ ${tr(lang,'1 Bot kostenlos','1 bot free')}</span><span>✓ ${tr(lang,'Deutsch & Englisch','German & English')}</span><span>✓ ${tr(lang,'Automatisch gehostet','Fully hosted')}</span></div></div><div class="landing-preview panel"><div class="preview-status"><span class="dot online"></span><div><strong>EU Server #1</strong><span>42/100 ${tr(lang,'Spieler online','players online')}</span></div></div><div class="preview-status"><span class="dot online"></span><div><strong>Minecraft</strong><span>Map: survival</span></div></div><div class="preview-status"><span class="dot starting"></span><div><strong>${tr(lang,'Text-Rotation','Text rotation')}</strong><span>Powered by status-hub.lol</span></div></div></div></section><section class="landing-features"><article class="panel"><span class="eyebrow">Games</span><h2>${tr(lang,'Hunderte','Hundreds')}</h2><p>${tr(lang,'Spiele verfügbar für deine Status-Bots.','Games available for your status bots.')}</p></article><article class="panel"><span class="eyebrow">Free</span><h2>1–5</h2><p>${tr(lang,'Ein Bot gratis. Mit der Branding-Kategorie sind je nach Servergröße bis zu 5 möglich.','One bot free. With the branding category, server size can unlock up to 5.')}</p></article><article class="panel"><span class="eyebrow">Premium</span><h2>5–20</h2><p>${tr(lang,'Mehr Bots und kein Powered-by-Branding.','More bots and no Powered-by branding.')}</p></article></section><section class="landing-bottom panel"><div><h2>${tr(lang,'In wenigen Minuten online','Online in minutes')}</h2><p>${tr(lang,'Discord Bot Token eintragen, Game auswählen und Status konfigurieren. Hosting und Updates übernimmt der Hub.','Enter a Discord bot token, choose a game and configure the status. The Hub handles hosting and updates.')}</p></div><a class="button primary" href="/auth/discord">${tr(lang,'Jetzt starten','Get started')}</a></section>`);
});

app.get('/auth/discord', rateLimit({ windowMs: 60_000, limit: 20 }), (req, res) => {
  const oauth = discordOAuthConfig();
  if (!oauth.enabled || !oauth.configured) {
    flash(req, 'err', l(req, 'Discord Login ist derzeit nicht eingerichtet oder deaktiviert.', 'Discord login is currently not configured or disabled.'));
    return res.redirect('/login');
  }
  const returnTo = String(req.query.returnTo || '').trim();
  if (returnTo.startsWith('/') && !returnTo.startsWith('//')) req.session.oauthReturnTo = returnTo.slice(0, 500);
  const state = crypto.randomBytes(24).toString('base64url'); req.session.oauthState = state;
  const params = new URLSearchParams({ client_id: oauth.clientId, response_type: 'code', redirect_uri: oauth.redirectUri, scope: 'identify', state });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

app.get('/auth/discord/callback', rateLimit({ windowMs: 60_000, limit: 30 }), async (req, res) => {
  try {
    const oauth = discordOAuthConfig();
    if (!oauth.enabled || !oauth.configured) throw new Error(l(req, 'Discord OAuth ist nicht vollständig eingerichtet.', 'Discord OAuth is not fully configured.'));
    const { code, state } = req.query;
    if (!code || !state || state !== req.session.oauthState) throw new Error('OAuth state ungültig');
    const returnTo = String(req.session.oauthReturnTo || '/');
    const previousLang = req.session.lang;
    delete req.session.oauthState;
    delete req.session.oauthReturnTo;
    const form = new URLSearchParams({ client_id: oauth.clientId, client_secret: oauth.clientSecret, grant_type: 'authorization_code', code: String(code), redirect_uri: oauth.redirectUri });
    const tokenResponse = await fetch('https://discord.com/api/v10/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
    if (!tokenResponse.ok) {
      const detail = await tokenResponse.text().catch(() => '');
      throw new Error(`OAuth Token Exchange fehlgeschlagen (${tokenResponse.status})${detail ? `: ${detail.slice(0, 180)}` : ''}`);
    }
    const token = await tokenResponse.json();
    const profile = await discordApi('/users/@me', { headers: { Authorization: `Bearer ${token.access_token}` } });

    let user = findUser(profile.id);
    const bootstrap = bootstrapAdmins.has(profile.id);
    if (!user && !oauth.allowRegistration && !bootstrap) return res.status(403).send('Registrierung ist derzeit deaktiviert.');
    user = upsertUser({
      ...(user || {}), discordId: profile.id, role: bootstrap ? 'admin' : (user?.role || 'user'),
      planId: user?.planId || 'free', planExpiresAt: user?.planExpiresAt || null,
      statusBotLimitOverride: user?.statusBotLimitOverride ?? null, customBotLimit: user?.customBotLimit ?? 0,
      username: profile.username, globalName: profile.global_name || '', avatar: profile.avatar || '', lastLoginAt: new Date().toISOString()
    });
    const avatarUrl = profile.avatar ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png?size=64` : '';
    req.session.regenerate((err) => {
      if (err) return res.status(500).send('Session-Fehler');
      req.session.user = { discordId: user.discordId, avatarUrl };
      if (previousLang) req.session.lang = previousLang;
      req.session.csrf = crypto.randomBytes(24).toString('base64url');
      res.redirect(returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/');
    });
  } catch (error) { res.status(500).send(`Discord Login fehlgeschlagen: ${esc(error.message)}`); }
});

app.post('/logout', requireLogin, checkCsrf, (req, res) => req.session.destroy(() => res.redirect('/login')));


app.post('/cookies/preferences', checkCsrf, (req,res) => {
  const mode=String(req.body.choice||req.body.mode||'custom');
  const consent={v:1,necessary:true,analytics:mode==='accept'||(mode==='custom'&&req.body.analytics==='1'),marketing:mode==='accept'||(mode==='custom'&&req.body.marketing==='1'),savedAt:new Date().toISOString()};
  res.cookie('sh_cookie_consent',Buffer.from(JSON.stringify(consent)).toString('base64url'),{httpOnly:true,sameSite:'lax',secure:secureCookie,maxAge:180*24*60*60*1000,path:'/'});
  const back=String(req.body.returnTo||req.get('referer')||'/');
  res.redirect(back.startsWith(baseUrl)?back:back.startsWith('/')?back:'/');
});

app.get('/cookies', (req,res) => {
  const lang=langOf(req); const pref=cookieConsent(req)||{necessary:true,analytics:false,marketing:false};
  render(req,res,tr(lang,'Cookie-Einstellungen','Cookie settings'),`<div class="pagehead"><div><h1>${tr(lang,'Cookie-Einstellungen','Cookie settings')}</h1><p>${tr(lang,'Du kannst optionale Cookies jederzeit ablehnen oder deine Auswahl ändern.','You can reject optional cookies or change your choice at any time.')}</p></div></div><section class="panel"><h2>${tr(lang,'Kategorien','Categories')}</h2><form method="post" action="/cookies/preferences" class="formgrid"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><input type="hidden" name="mode" value="custom"><input type="hidden" name="returnTo" value="/cookies"><label class="check span2"><input type="checkbox" checked disabled> <strong>${tr(lang,'Notwendig','Necessary')}</strong> · ${tr(lang,'Login, Session, CSRF-Schutz und Cookie-Auswahl. Immer aktiv.','Login, session, CSRF protection and cookie choice. Always active.')}</label><label class="check span2"><input type="checkbox" name="analytics" value="1" ${pref.analytics?'checked':''}> <strong>Analytics</strong> · ${tr(lang,'Optionale Reichweitenmessung. Derzeit ist kein Analytics-Dienst eingebunden.','Optional audience measurement. No analytics service is currently integrated.')}</label><label class="check span2"><input type="checkbox" name="marketing" value="1" ${pref.marketing?'checked':''}> <strong>Marketing</strong> · ${tr(lang,'Optionale Marketing-/Tracking-Dienste. Derzeit sind keine Marketing-Tracker eingebunden.','Optional marketing/tracking services. No marketing trackers are currently integrated.')}</label><div class="span2 actions"><button class="button ghost" type="submit" name="choice" value="reject">${tr(lang,'Optionale ablehnen','Reject optional')}</button><button class="button primary">${tr(lang,'Auswahl speichern','Save choices')}</button><button class="button ghost" type="submit" name="choice" value="accept">${tr(lang,'Alle akzeptieren','Accept all')}</button></div></form></section><section class="panel"><h2>${tr(lang,'Verwendete Cookies','Cookies in use')}</h2><div class="tablewrap"><table class="cookie-table"><thead><tr><th>Name</th><th>${tr(lang,'Zweck','Purpose')}</th><th>${tr(lang,'Dauer','Duration')}</th></tr></thead><tbody><tr><td><code>serverhub.sid</code></td><td>${tr(lang,'Notwendige Anmeldung, Session und Sicherheitsfunktionen.','Necessary login, session and security functions.')}</td><td>7 ${tr(lang,'Tage','days')}</td></tr><tr><td><code>sh_cookie_consent</code></td><td>${tr(lang,'Speichert deine Cookie-Auswahl.','Stores your cookie choices.')}</td><td>180 ${tr(lang,'Tage','days')}</td></tr></tbody></table></div><p class="muted small">${tr(lang,'Optionale Cookies werden erst nach Einwilligung gesetzt. In der aktuellen Version werden keine optionalen Analyse- oder Marketing-Cookies geladen.','Optional cookies are only set after consent. The current version does not load optional analytics or marketing cookies.')}</p></section>`);
});

app.get('/games', (req, res) => {
  render(req, res, l(req, 'Games & FAQ', 'Games & FAQ'), gamesPage({ loggedIn: Boolean(currentUser(req)), lang: langOf(req) }));
});

app.get('/bot-services', (req, res) => {
  const lang = langOf(req); const settings = getSiteSettings(); const services = listBotServices(true);
  const cards = services.map((service) => {
    const name = lang === 'en' ? (service.nameEn || service.nameDe) : (service.nameDe || service.nameEn);
    const description = lang === 'en' ? (service.descriptionEn || service.descriptionDe) : (service.descriptionDe || service.descriptionEn);
    const features = lang === 'en' ? (service.featuresEn || service.featuresDe || []) : (service.featuresDe || service.featuresEn || []);
    const status = service.status === 'available' ? tr(lang,'Verfügbar','Available') : service.status === 'paused' ? tr(lang,'Pausiert','Paused') : tr(lang,'Coming Soon','Coming soon');
    const statusClass = service.status === 'available' ? 'online' : service.status === 'paused' ? 'offline' : 'neutral';
    const purchaseUrl = /^https?:\/\//i.test(String(service.purchaseUrl || '')) ? service.purchaseUrl : '';
    const fallbackSupport = /^https?:\/\//i.test(String(service.supportUrl || '')) ? service.supportUrl : (/^https?:\/\//i.test(String(settings.supportUrl || '')) ? settings.supportUrl : '');
    let action = `<span class="button ghost disabled">${esc(status)}</span>`;
    if (service.status === 'available' && purchaseUrl) action = `<a class="button primary" href="${esc(purchaseUrl)}" target="_blank" rel="noopener">${tr(lang,'Bot kaufen','Buy bot')}</a>`;
    else if (fallbackSupport) action = `<a class="button ${service.status === 'available' ? 'primary' : 'ghost'}" href="${esc(fallbackSupport)}" target="_blank" rel="noopener">${service.status === 'available' ? tr(lang,'Kaufen / Support','Buy / support') : tr(lang,'Mehr erfahren','Learn more')}</a>`;
    return `<article class="service-card panel ${service.featured ? 'featured' : ''}"><div class="row between"><div><span class="eyebrow">${tr(lang,'Managed Bot Service','Managed bot service')}</span><h2>${esc(name)}</h2></div><span class="badge ${statusClass}">${esc(status)}</span></div>${service.priceLabel ? `<div class="service-price">${esc(service.priceLabel)}</div>` : ''}<p>${esc(description)}</p><ul class="service-features">${features.map((x)=>`<li>${esc(x)}</li>`).join('')}</ul><div class="actions wrap">${action}</div></article>`;
  }).join('');
  render(req,res,tr(lang,'Bot Services','Bot Services'),`<div class="pagehead"><div><h1>${tr(lang,'Bots as a Service','Bots as a Service')}</h1><p>${tr(lang,'Einzelne, von status-hub.lol betriebene Spezial-Bots. Diese Produkte sind unabhängig von deinem Status-Bot-Limit.','Individual specialist bots operated by status-hub.lol. These products are separate from your status-bot quota.')}</p></div></div><section class="service-grid">${cards || `<div class="panel empty">${tr(lang,'Noch keine Bot Services veröffentlicht.','No bot services published yet.')}</div>`}</section><div class="panel help service-note"><strong>${tr(lang,'Wichtig','Important')}:</strong> ${tr(lang,'Status-Bot-Pläne und Custom-Bot-Freigaben bleiben davon getrennt. Kaufbare Bot Services sind eigene Managed-Produkte.','Status-bot plans and custom-bot permissions remain separate. Purchasable bot services are independent managed products.')}</div>`);
});

app.post('/paypal/checkout/:planId', requireLogin, rateLimit({ windowMs: 60_000, limit: 10 }), checkCsrf, async (req, res) => {
  const user = currentUser(req);
  const planId = String(req.params.planId || '');
  if (!PLANS[planId] || planId === 'free') return res.status(400).send('Invalid premium plan');
  const activeSubscription = listPaypalSubscriptionsForUser(user.discordId).find((x) => String(x.status || '').toUpperCase() === 'ACTIVE' && !x.cancelledAt);
  if (activeSubscription) { flash(req,'err',l(req,'Du hast bereits ein aktives monatliches Abo. Kündige oder verwalte es zuerst unter „Your Account“.','You already have an active monthly subscription. Cancel or manage it under “Your Account” first.')); return res.redirect('/account'); }
  const settings = getSiteSettings();
  const auto = paypalAutoConfig(settings);
  if (!paypalAutoReady(settings)) { flash(req,'err',l(req,'Automatischer PayPal-Checkout ist noch nicht eingerichtet.','Automatic PayPal checkout is not configured yet.')); return res.redirect('/plans'); }
  const amount = auto.amounts[planId];
  if (!amount) { flash(req,'err',l(req,'Für diesen Plan ist kein gültiger PayPal-Preis hinterlegt.','No valid PayPal price is configured for this plan.')); return res.redirect('/plans'); }
  const purchase = createPaypalPurchase({ id: crypto.randomUUID(), provider: 'paypal', userDiscordId: user.discordId, planId, amount, currency: auto.currency, accessDays: auto.accessDays, status: 'creating' });
  try {
    const order = await createCheckoutOrder({ purchaseId: purchase.id, planId, amount, currency: auto.currency, returnUrl: `${baseUrl}/paypal/return?purchase=${encodeURIComponent(purchase.id)}`, cancelUrl: `${baseUrl}/paypal/cancel?purchase=${encodeURIComponent(purchase.id)}` });
    updatePaypalPurchase(purchase.id, { orderId: order.orderId, status: 'approval_pending' });
    return res.redirect(order.approvalUrl);
  } catch (error) {
    updatePaypalPurchase(purchase.id, { status: 'failed', error: String(error.message || error).slice(0,500) });
    flash(req,'err',`PayPal: ${error.message}`); return res.redirect('/plans');
  }
});

app.get('/paypal/return', requireLogin, rateLimit({ windowMs: 60_000, limit: 20 }), async (req, res) => {
  try {
    const user = currentUser(req);
    const purchase = getPaypalPurchase(String(req.query.purchase || '')) || getPaypalPurchaseByOrder(String(req.query.token || ''));
    if (!purchase || purchase.userDiscordId !== user.discordId) throw new Error('PayPal purchase not found');
    const orderId = String(req.query.token || purchase.orderId || '');
    if (!orderId || (purchase.orderId && orderId !== purchase.orderId)) throw new Error('PayPal order mismatch');
    let order = await getCheckoutOrder(orderId);
    if (order.status !== 'COMPLETED') order = await captureCheckoutOrder(orderId);
    const capture = extractCompletedCapture(order);
    if (capture.status === 'COMPLETED') {
      applyPaypalPurchase(purchase, capture);
      flash(req,'ok',l(req,`PayPal-Zahlung erfolgreich. ${PLANS[purchase.planId].label} wurde automatisch freigeschaltet.`,`PayPal payment successful. ${PLANS[purchase.planId].label} was activated automatically.`));
    } else {
      updatePaypalPurchase(purchase.id, { status: String(capture.status || order.status || 'pending').toLowerCase() });
      flash(req,'ok',l(req,'PayPal verarbeitet die Zahlung noch. Premium wird automatisch freigeschaltet, sobald PayPal die Zahlung bestätigt.','PayPal is still processing the payment. Premium will activate automatically as soon as PayPal confirms it.'));
    }
  } catch (error) { flash(req,'err',`PayPal: ${error.message}`); }
  res.redirect('/plans');
});

app.get('/paypal/cancel', requireLogin, (req, res) => {
  const purchase = getPaypalPurchase(String(req.query.purchase || ''));
  const user = currentUser(req);
  if (purchase && purchase.userDiscordId === user.discordId && !purchase.appliedAt) updatePaypalPurchase(purchase.id, { status: 'cancelled' });
  flash(req,'err',l(req,'PayPal-Zahlung abgebrochen.','PayPal payment cancelled.'));
  res.redirect('/plans');
});

app.post('/paypal/subscribe/:planId', requireLogin, rateLimit({ windowMs: 60_000, limit: 10 }), checkCsrf, async (req, res) => {
  const user = currentUser(req);
  const planId = String(req.params.planId || '');
  if (!PLANS[planId] || planId === 'free') return res.status(400).send('Invalid premium plan');
  const settings = getSiteSettings();
  const sub = paypalSubscriptionConfig(settings);
  if (!paypalSubscriptionReady(settings, planId)) { flash(req,'err',l(req,'PayPal-Abo ist für diesen Plan noch nicht eingerichtet.','PayPal subscription is not configured for this plan yet.')); return res.redirect('/plans'); }
  const existing = listPaypalSubscriptionsForUser(user.discordId).find((x) => ['ACTIVE','APPROVAL_PENDING','creating'].includes(String(x.status || '').toUpperCase()));
  if (existing) { flash(req,'err',l(req,'Du hast bereits ein aktives oder offenes PayPal-Abo. Verwalte es zuerst unter „Your Account“.','You already have an active or pending PayPal subscription. Manage it under “Your Account” first.')); return res.redirect('/account'); }
  const record = createPaypalSubscriptionRecord({ id: crypto.randomUUID(), provider: 'paypal_subscription', userDiscordId: user.discordId, planId, amount: sub.amounts[planId], currency: sub.currency, paypalPlanId: sub.planIds[planId], status: 'creating' });
  try {
    const result = await createSubscription({ recordId: record.id, paypalPlanId: sub.planIds[planId], returnUrl: `${baseUrl}/paypal/subscription/return?record=${encodeURIComponent(record.id)}`, cancelUrl: `${baseUrl}/paypal/subscription/cancel?record=${encodeURIComponent(record.id)}`, settings });
    updatePaypalSubscriptionRecord(record.id, { subscriptionId: result.subscriptionId, status: result.status || 'APPROVAL_PENDING' });
    return res.redirect(result.approvalUrl);
  } catch (error) {
    updatePaypalSubscriptionRecord(record.id, { status: 'FAILED', error: String(error.message || error).slice(0,500) });
    flash(req,'err',`PayPal: ${error.message}`); return res.redirect('/plans');
  }
});

app.get('/paypal/subscription/return', requireLogin, rateLimit({ windowMs: 60_000, limit: 20 }), async (req, res) => {
  try {
    const user = currentUser(req);
    const record = getPaypalSubscriptionRecord(String(req.query.record || ''));
    if (!record || record.userDiscordId !== user.discordId) throw new Error('PayPal subscription not found');
    const subscriptionId = String(req.query.subscription_id || record.subscriptionId || '');
    if (!subscriptionId) throw new Error('PayPal subscription ID missing');
    const details = await getSubscription(subscriptionId);
    updatePaypalSubscriptionRecord(record.id, { subscriptionId, status: String(details.status || record.status || '').toUpperCase(), nextBillingAt: details?.billing_info?.next_billing_time || null, lastSyncAt: new Date().toISOString() });
    if (String(details.status || '').toUpperCase() === 'ACTIVE' && details?.billing_info?.last_payment?.time) {
      applyPaypalSubscription({ ...record, subscriptionId }, details, 'approved');
      flash(req,'ok',l(req,`${PLANS[record.planId].label} Abo ist aktiv. Das automatische Powered-by-Branding wurde entfernt; deine eigenen Status-Texte bleiben unverändert.`,`${PLANS[record.planId].label} subscription is active. Automatic Powered-by branding was removed; your own status texts remain unchanged.`));
    } else flash(req,'ok',l(req,'PayPal verarbeitet die erste Abo-Zahlung noch. Premium wird erst nach bestätigter Zahlung automatisch aktiviert.','PayPal is still processing the first subscription payment. Premium activates automatically only after a confirmed payment.'));
  } catch (error) { flash(req,'err',`PayPal: ${error.message}`); }
  res.redirect('/account');
});

app.get('/paypal/subscription/cancel', requireLogin, (req, res) => {
  const user = currentUser(req);
  const record = getPaypalSubscriptionRecord(String(req.query.record || ''));
  if (record && record.userDiscordId === user.discordId && !record.activatedAt) updatePaypalSubscriptionRecord(record.id, { status: 'CANCELLED_BEFORE_APPROVAL', cancelledAt: new Date().toISOString() });
  flash(req,'err',l(req,'PayPal-Aboabschluss abgebrochen.','PayPal subscription checkout cancelled.'));
  res.redirect('/plans');
});

app.get('/account', requireLogin, async (req, res) => {
  const lang = langOf(req); const user = currentUser(req); const plan = effectivePlan(user);
  const subscriptions = listPaypalSubscriptionsForUser(user.discordId);
  const active = subscriptions.find((x) => ['ACTIVE','APPROVAL_PENDING'].includes(String(x.status || '').toUpperCase())) || subscriptions[0] || null;
  let subscriptionHtml = `<p class="muted">${tr(lang,'Kein PayPal-Abo vorhanden.','No PayPal subscription.')}</p>`;
  if (active) {
    const state = String(active.status || '').toUpperCase();
    const end = active.entitlementExpiresAt || user.planExpiresAt || '';
    const canCancel = state === 'ACTIVE' && active.subscriptionId && !active.cancelledAt;
    subscriptionHtml = `<div class="account-billing"><div><span class="eyebrow">PayPal</span><h3>${esc(PLANS[active.planId]?.label || active.planId)}</h3><p>${tr(lang,'Status','Status')}: <strong>${esc(state)}</strong></p>${active.nextBillingAt ? `<p>${tr(lang,'Nächste Zahlung','Next payment')}: ${esc(new Date(active.nextBillingAt).toLocaleString(localeCode(lang)))}</p>` : ''}${active.cancelledAt && end ? `<p>${tr(lang,'Gekündigt. Premium bleibt bis','Cancelled. Premium remains until')} ${esc(new Date(end).toLocaleString(localeCode(lang)))}</p>` : ''}</div>${canCancel ? `<form method="post" action="/account/subscription/cancel" onsubmit="return confirm('${tr(lang,'Monatliches PayPal-Abo wirklich kündigen? Premium bleibt bis zum Ende des bereits bezahlten Zeitraums aktiv.','Cancel the monthly PayPal subscription? Premium remains active until the end of the already paid period.')}')"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><input type="hidden" name="recordId" value="${esc(active.id)}"><button class="button danger" type="submit">${tr(lang,'Abo kündigen','Cancel subscription')}</button></form>` : ''}</div>`;
  }
  const expiry = plan.expiresAt ? new Date(plan.expiresAt).toLocaleString(localeCode(lang)) : tr(lang,'Dauerhaft / kein Ablauf','Permanent / no expiry');
  const source = user.premiumSource?.provider === 'paypal_subscription' ? tr(lang,'Monatliches PayPal-Abo','Monthly PayPal subscription') : user.premiumSource?.provider === 'paypal' ? tr(lang,'PayPal Einmalzahlung','PayPal one-time payment') : tr(lang,'Manuell / Free','Manual / Free');
  const renew=freeRenewState(user); const renewDue=renew.dueAt?new Date(renew.dueAt).toLocaleString(localeCode(lang)):''; const deleteAt=renew.deleteAt?new Date(renew.deleteAt).toLocaleString(localeCode(lang)):'';
  const renewHtml=user.role==='admin'||user.freeRenewExempt?`<article class="panel"><span class="eyebrow">Free Renew</span><h2>${tr(lang,'Nicht erforderlich','Not required')}</h2><p>${tr(lang,'Ein Admin hat die 14-Tage-Verlängerung für diesen Account deaktiviert.','An admin disabled the 14-day renewal requirement for this account.')}</p></article>`:plan.id!=='free'&&!plan.premiumGrace?`<article class="panel"><span class="eyebrow">Free Renew</span><h2>${tr(lang,'In Premium enthalten','Included with Premium')}</h2><p>${tr(lang,'Solange Premium aktiv ist, ist keine Free-Verlängerung nötig.','No free renewal is required while Premium is active.')}</p></article>`:`<article class="panel ${renew.required?'renew-alert':'renew-card'}"><span class="eyebrow">Free Renew</span><h2>${renew.required?tr(lang,'Verlängerung erforderlich','Renewal required'):tr(lang,'14-Tage-Verlängerung','14-day renewal')}</h2><p>${renew.required?tr(lang,'Deine Status-Bots sind pausiert. Verlängere jetzt, damit sie wieder online gehen.','Your status bots are paused. Renew now to bring them back online.'):`${tr(lang,'Nächste Verlängerung spätestens','Renew by')}: ${esc(renewDue)}`}</p>${deleteAt?`<p class="lifecycle-note"><strong>${tr(lang,'Löschung am','Deletion at')}:</strong> ${esc(deleteAt)}</p>`:''}<form method="post" action="/account/renew-free"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button success" type="submit">${tr(lang,`Gratis-Bot für ${FREE_RENEW_DAYS} Tage verlängern`,`Renew free bot for ${FREE_RENEW_DAYS} days`)}</button></form></article>`;
  render(req,res,tr(lang,'Dein Account','Your Account'),`<div class="pagehead"><div><h1>${tr(lang,'Dein Account','Your Account')}</h1><p>${esc(user.globalName || user.username || user.discordId)}</p></div></div><section class="account-grid"><article class="panel"><span class="eyebrow">Plan</span><h2>${esc(plan.label)}</h2><p>${tr(lang,'Status-Bot-Limit','Status bot limit')}: <strong>${esc(plan.statusBotLimit)}</strong></p><p>${tr(lang,'Abrechnung','Billing')}: <strong>${source}</strong></p><p>${tr(lang,'Premium bis','Premium until')}: <strong>${esc(expiry)}</strong></p>${plan.premiumGrace?`<p class="lifecycle-note"><strong>${tr(lang,'7-Tage-Wiederherstellung aktiv','7-day restore window active')}</strong></p>`:''}<a class="button primary" href="/plans">${tr(lang,'Premium verwalten','Manage Premium')}</a></article><article class="panel"><span class="eyebrow">${tr(lang,'Monatliches Abo','Monthly subscription')}</span>${subscriptionHtml}</article>${renewHtml}</section>`);
});

app.post('/account/renew-free', requireLogin, checkCsrf, rateLimit({ windowMs: 60_000, limit: 10 }), (req,res) => {
  const user=currentUser(req); const plan=effectivePlan(user);
  if(user.role==='admin'||user.freeRenewExempt){flash(req,'ok',l(req,'Für deinen Account ist kein Free-Renew nötig.','Your account does not require free renewal.'));return res.redirect('/account');}
  if(plan.id!=='free'&&!plan.premiumGrace){flash(req,'ok',l(req,'Premium ist aktiv. Keine Free-Verlängerung nötig.','Premium is active. No free renewal is required.'));return res.redirect('/account');}
  runLifecycleSweep(); renewFreeAccess(user.discordId); rebalanceAssignments(); flash(req,'ok',l(req,`Gratis-Zugang um ${FREE_RENEW_DAYS} Tage verlängert. Pausierte Bots werden wieder gestartet, sofern sie noch vorhanden sind.`,`Free access renewed for ${FREE_RENEW_DAYS} days. Paused bots will restart if they still exist.`)); res.redirect('/account');
});

app.post('/account/subscription/cancel', requireLogin, checkCsrf, rateLimit({ windowMs: 60_000, limit: 5 }), async (req, res) => {
  try {
    const user = currentUser(req);
    const record = getPaypalSubscriptionRecord(String(req.body.recordId || ''));
    if (!record || record.userDiscordId !== user.discordId || !record.subscriptionId) throw new Error(l(req,'Abo nicht gefunden.','Subscription not found.'));
    let details = null;
    try { details = await getSubscription(record.subscriptionId); } catch {}
    const end = record.entitlementExpiresAt || user.planExpiresAt || (details ? subscriptionEntitlementExpiry(details) : new Date(Date.now() + 32*86400_000).toISOString());
    await cancelSubscription(record.subscriptionId, 'Cancelled by customer from status-hub.lol');
    updatePaypalSubscriptionRecord(record.id, { status: 'CANCELLED', cancelledAt: new Date().toISOString(), entitlementExpiresAt: end, nextBillingAt: null });
    if (user.premiumSource?.provider === 'paypal_subscription' && user.premiumSource?.recordId === record.id) upsertUser({ discordId: user.discordId, planExpiresAt: end });
    flash(req,'ok',l(req,'Abo gekündigt. Premium bleibt bis zum Ende des bereits bezahlten Zeitraums aktiv.','Subscription cancelled. Premium remains active until the end of the already paid period.'));
  } catch (error) { flash(req,'err',`PayPal: ${error.message}`); }
  res.redirect('/account');
});

app.post('/webhooks/paypal', rateLimit({ windowMs: 60_000, limit: 120 }), async (req, res) => {
  try {
    const settings = getSiteSettings();
    const auto = paypalAutoConfig(settings);
    if (!paypalConfigured(settings) || !auto.webhookId) return res.status(503).send('PayPal webhook not configured');
    const event = req.body || {};
    if (!event.id || !event.event_type) return res.status(400).send('Invalid webhook');
    if (paypalWebhookEventSeen(event.id)) return res.status(200).send('OK');
    if (!await verifyWebhook(req.headers, event, auto.webhookId, settings)) return res.status(400).send('Invalid PayPal signature');
    const purchase = purchaseFromPaypalEvent(event);
    const subscription = subscriptionFromPaypalEvent(event);
    const type = String(event.event_type || '');
    if (type === 'PAYMENT.CAPTURE.COMPLETED') {
      if (purchase) {
        const resource = event.resource || {};
        applyPaypalPurchase(purchase, { status: resource.status || 'COMPLETED', captureId: resource.id || '', customId: resource.custom_id || purchase.id, amount: resource.amount?.value || '', currency: resource.amount?.currency_code || '' });
      }
    } else if (type === 'PAYMENT.CAPTURE.DENIED') {
      if (purchase) updatePaypalPurchase(purchase.id, { status: 'denied', error: event.summary || 'PayPal capture denied' });
    } else if (type === 'PAYMENT.CAPTURE.REFUNDED') {
      if (purchase) {
        const refundAmount = event.resource?.amount?.value || '';
        if (!refundAmount || moneyMatches(refundAmount, purchase.amount)) revokePaypalPurchase(purchase, 'refunded');
        else updatePaypalPurchase(purchase.id, { status: 'partial_refund', lastRefundAt: new Date().toISOString() });
      }
    } else if (type === 'PAYMENT.CAPTURE.REVERSED') {
      if (purchase) revokePaypalPurchase(purchase, 'reversed');
    } else if (type === 'BILLING.SUBSCRIPTION.ACTIVATED' || type === 'BILLING.SUBSCRIPTION.UPDATED') {
      const record = subscription || getPaypalSubscriptionByPaypalId(String(event.resource?.id || '')) || getPaypalSubscriptionRecord(String(event.resource?.custom_id || ''));
      if (record) {
        const details = event.resource?.billing_info ? event.resource : await getSubscription(record.subscriptionId || event.resource?.id, settings);
        applyPaypalSubscription(record, details, 'webhook');
      }
    } else if (type === 'PAYMENT.SALE.COMPLETED') {
      const record = subscription || getPaypalSubscriptionByPaypalId(String(event.resource?.billing_agreement_id || ''));
      if (record) {
        const details = await getSubscription(record.subscriptionId, settings);
        applyPaypalSubscription(record, details, 'recurring_payment');
        updatePaypalSubscriptionRecord(record.id, { lastPaymentId: String(event.resource?.id || ''), lastPaymentAt: event.resource?.create_time || new Date().toISOString(), lastPaymentAmount: event.resource?.amount?.total || event.resource?.amount?.value || '' });
      }
    } else if (['BILLING.SUBSCRIPTION.CANCELLED','BILLING.SUBSCRIPTION.EXPIRED','BILLING.SUBSCRIPTION.SUSPENDED','BILLING.SUBSCRIPTION.PAYMENT.FAILED'].includes(type)) {
      const record = subscription || getPaypalSubscriptionByPaypalId(String(event.resource?.id || event.resource?.billing_agreement_id || ''));
      if (record) updatePaypalSubscriptionRecord(record.id, { status: type.split('.').pop(), statusEvent: type, cancelledAt: type === 'BILLING.SUBSCRIPTION.CANCELLED' ? (record.cancelledAt || new Date().toISOString()) : record.cancelledAt, lastSyncAt: new Date().toISOString() });
    }
    rememberPaypalWebhookEvent(event.id, event.event_type);
    res.status(200).send('OK');
  } catch (error) {
    console.error('PayPal webhook:', error.message);
    res.status(500).send('Webhook processing failed');
  }
});

app.get('/plans', (req, res) => {
  const lang = langOf(req); const u = currentUser(req); const current = effectivePlan(u); const settings = getSiteSettings(); const sales = settings.premiumSales || {}; const auto = paypalAutoConfig(settings); const sub = paypalSubscriptionConfig(settings); const automatic = paypalAutoReady(settings);
  const discordContact = sales.discordUserId && validSnowflake(sales.discordUserId) ? `https://discord.com/users/${encodeURIComponent(sales.discordUserId)}` : '';
  const cards = Object.values(PLANS).map((p) => {
    const oneTimePrice = p.id !== 'free' && auto.amounts[p.id] ? `${auto.amounts[p.id]} ${auto.currency} / ${auto.accessDays} ${tr(lang,'Tage','days')}` : '';
    const monthlyPrice = p.id !== 'free' && sub.amounts[p.id] ? `${sub.amounts[p.id]} ${sub.currency} / ${tr(lang,'Monat','month')}` : '';
    const displayPrice = p.id === 'free' ? tr(lang,'Kostenlos','Free') : (oneTimePrice || monthlyPrice || String(sales.prices?.[p.id] || tr(lang,'Preis auf Anfrage','Price on request')));
    let action = '';
    if (p.id !== 'free') {
      const choices = [];
      if (automatic && auto.amounts[p.id]) choices.push(u ? `<form method="post" action="/paypal/checkout/${esc(p.id)}" class="purchase-choice"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><strong>${tr(lang,'Einmalig','One-time')}</strong><span>${esc(oneTimePrice)}</span><button class="button ghost" type="submit">${tr(lang,'Einmalig kaufen','Buy once')}</button></form>` : `<div class="purchase-choice"><strong>${tr(lang,'Einmalig','One-time')}</strong><span>${esc(oneTimePrice)}</span><a class="button ghost" href="/auth/discord">${tr(lang,'Einloggen','Login')}</a></div>`);
      if (paypalSubscriptionReady(settings, p.id)) choices.push(u ? `<form method="post" action="/paypal/subscribe/${esc(p.id)}" class="purchase-choice"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><strong>${tr(lang,'Monatliches Abo','Monthly subscription')}</strong><span>${esc(monthlyPrice)}</span><button class="button primary" type="submit">${tr(lang,'Monatlich abonnieren','Subscribe monthly')}</button></form>` : `<div class="purchase-choice"><strong>${tr(lang,'Monatliches Abo','Monthly subscription')}</strong><span>${esc(monthlyPrice)}</span><a class="button primary" href="/auth/discord">${tr(lang,'Einloggen','Login')}</a></div>`);
      if (choices.length) action = `<div class="purchase-options">${choices.join('')}</div>`;
      else if (/^https?:\/\//i.test(String(sales.paypalUrl || ''))) action = `<a class="button primary" href="${esc(sales.paypalUrl)}" target="_blank" rel="noopener">${tr(lang,'Jetzt mit PayPal kaufen','Buy now with PayPal')}</a>`;
      else if (discordContact) action = `<a class="button primary" href="${esc(discordContact)}" target="_blank" rel="noopener">${tr(lang,'Auf Discord kaufen','Buy via Discord')}</a>`;
      else if (sales.discordUsername) action = `<div class="plan-contact">${tr(lang,'Zum Kaufen auf Discord anschreiben','Message on Discord to buy')}: <strong>${esc(sales.discordUsername)}</strong></div>`;
      else if (settings.supportUrl) action = `<a class="button primary" href="${esc(settings.supportUrl)}" target="_blank" rel="noopener">${tr(lang,'Kaufen / Support','Buy / support')}</a>`;
    }
    return `<article class="panel plan-card ${u && current.id===p.id?'current-plan':''}"><span class="eyebrow">${p.id==='free'?tr(lang,'Kostenlos','Free'):'Premium'}</span><h2>${esc(p.label)}</h2><div class="plan-number">${p.statusBotLimit}</div><p>Status Bot${p.statusBotLimit===1?'':'s'}</p><div class="plan-price">${esc(displayPrice)}</div><ul><li>${tr(lang,'Alle unterstützten Games','All supported games')}</li><li>${tr(lang,'Status-Rotation, Map & Spieler je nach Game','Status rotation, map & players depending on the game')}</li><li>${p.branded?tr(lang,'Powered by status-hub.lol im Free-Status','Powered by status-hub.lol on Free status bots'):tr(lang,'Kein Service-Branding','No service branding')}</li></ul>${u && current.id===p.id?`<div class="actions wrap"><span class="badge online">${tr(lang,'Aktueller Plan','Current plan')}</span></div>`:''}${action}</article>`;
  }).join('');
  const purchaseNote = automatic || paypalSubscriptionReady(settings) ? tr(lang,'Wähle je Plan zwischen Einmalzahlung und monatlichem PayPal-Abo. Abos kannst du jederzeit unter „Your Account“ kündigen.','Choose between a one-time payment and a monthly PayPal subscription for each plan. Subscriptions can be cancelled any time under “Your Account”.') : sales.paypalUrl ? tr(lang,'PayPal-Link ist hinterlegt; Freischaltung erfolgt noch manuell.','A PayPal link is configured; activation is still manual.') : sales.discordUsername ? `${tr(lang,'Aktueller Kaufkontakt','Current purchase contact')}: ${esc(sales.discordUsername)}` : tr(lang,'Kaufkontakt wird noch eingerichtet.','Purchase contact is not configured yet.');
  render(req,res,'Premium',`<div class="pagehead"><div><h1>Premium</h1><p>${tr(lang,'Free startet mit 1 Bot und kann über Server-Branding auf bis zu 5 Gratis-Bots wachsen. Premium entfernt nur das automatisch hinzugefügte Powered-by-Branding. Deine eigenen Status-Texte bleiben unverändert.','Free starts with 1 bot and can grow to up to 5 free bots through server branding. Premium removes only the automatically added Powered-by branding. Your own status texts remain unchanged.')}</p></div>${u?`<a class="button ghost" href="/account">${tr(lang,'Your Account','Your Account')}</a>`:''}</div><section class="plan-grid">${cards}</section><div class="panel help"><strong>${tr(lang,'Kaufen','Purchase')}:</strong> ${purchaseNote}<br><strong>${tr(lang,'Branding','Branding')}:</strong> ${tr(lang,'Beim Upgrade wird kein eigener User-Text gelöscht oder ergänzt. Nur der vom System dynamisch hinzugefügte „Powered by status-hub.lol“-Eintrag fällt weg.','Upgrading never deletes or adds user-authored text. Only the system-generated “Powered by status-hub.lol” entry disappears.')}<br><strong>Custom Bots:</strong> ${tr(lang,'bleiben unabhängig und werden nur manuell im Backend freigeschaltet.','remain separate and are enabled manually in the backend only.')}</div>`);
});

app.get('/get-more', requireLogin, (req, res) => {
  const lang = langOf(req); const u = currentUser(req); const plan = effectivePlan(u); const settings = getSiteSettings(); const boost = u.freeBoost || {};
  const ranges = freeBoostRanges(settings);
  const tiers = ranges.map((x) => `<div class="tier"><strong>${x.to == null ? `${esc(x.from)}+` : `${esc(x.from)}–${esc(x.to)}`}</strong><span>${esc(x.limit)} ${tr(lang,'Gratis-Bots gesamt','free bots total')}</span></div>`).join('');
  const stateText = boost.state === 'verified' ? `${tr(lang,'Verifiziert','Verified')}: ${esc(boost.guildName || boost.guildId)} · ${esc(boost.memberCount || 0)} ${tr(lang,'Mitglieder','members')} · ${esc(boost.freeBotLimit || 1)} ${tr(lang,'Gratis-Bots','free bots')}` : boost.state === 'missing-brand' ? tr(lang,'Branding-Kategorie nicht als oberste Kategorie gefunden.','Branding category was not found as the top category.') : boost.state === 'no-bot' ? tr(lang,'Du brauchst zuerst einen Status-Bot, der auf deinem Discord-Server eingeladen ist.','You first need a status bot invited to your Discord server.') : tr(lang,'Noch nicht geprüft.','Not checked yet.');
  const category = settings.freeBoost?.categoryName || settings.freeBoost?.channelName || 'Powered by status-hub.lol';
  render(req,res,tr(lang,'Mehr gratis','Get more'),`<div class="pagehead"><div><h1>${tr(lang,'Mehr gratis Status-Bots','Get more free status bots')}</h1><p>${tr(lang,'Free-Accounts können je nach Größe ihres Discord-Servers bis zu 5 Status-Bots gratis nutzen.','Free accounts can use up to 5 status bots for free depending on the size of their Discord server.')}</p></div></div><section class="boost-grid"><article class="panel boost-card"><span class="eyebrow">${tr(lang,'Voraussetzung','Requirement')}</span><h2>${tr(lang,'Branding-Kategorie ganz oben','Branding category at the very top')}</h2><p>${tr(lang,'Erstelle auf dem Discord-Server, auf dem dein Status-Bot läuft, eine sichtbare Kategorie ganz oben mit exakt diesem Namen:','On the Discord server where your status bot runs, create a visible category at the very top with exactly this name:')}</p><div class="copybox"><code>${esc(category)}</code></div><p class="muted small">${tr(lang,'Die Kategorie muss für @everyone sichtbar sein. Normale Text-Channels zählen für diese Prüfung nicht. Free-Bots zeigen zusätzlich immer „Powered by status-hub.lol“ in ihrer Statusrotation.','The category must be visible to @everyone. Normal text channels do not count for this check. Free bots also always show “Powered by status-hub.lol” in their status rotation.')}</p></article><article class="panel boost-card"><span class="eyebrow">${tr(lang,'Dein Status','Your status')}</span><h2>${esc(plan.label)}</h2><p>${stateText}</p><form method="post" action="/get-more/verify"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button primary">${tr(lang,'Jetzt prüfen','Verify now')}</button></form></article></section><section class="panel boost-tiers"><h2>${tr(lang,'Gratis-Stufen nach Servergröße','Free tiers by server size')}</h2><div class="tier-grid">${tiers}</div><p class="muted small">${tr(lang,'Die Stufen werden direkt aus den Admin-Einstellungen berechnet. Änderungen gelten sofort auch für bereits verifizierte Accounts.','Tiers are calculated directly from the admin settings. Changes apply immediately to already verified accounts too.')}</p></section><div class="actions"><a class="button ghost" href="/plans">Premium</a>${settings.supportUrl ? `<a class="button ghost" href="${esc(settings.supportUrl)}" target="_blank" rel="noopener">${tr(lang,'Support kontaktieren','Contact support')}</a>` : ''}</div>`);
});

app.post('/get-more/verify', requireLogin, checkCsrf, async (req, res) => {
  try { const result = await verifyFreeBoostForUser(currentUser(req).discordId); rebalanceAssignments(); flash(req,'ok',result.state==='verified'?l(req,`Free-Boost verifiziert: ${result.freeBotLimit} Bots gesamt.`,`Free boost verified: ${result.freeBotLimit} bots total.`):l(req,'Branding-Kategorie wurde nicht korrekt als oberste Kategorie gefunden.','Branding category was not found correctly as the top category.')); }
  catch (error) { flash(req,'err',`${l(req,'Prüfung fehlgeschlagen','Verification failed')}: ${error.message}`); }
  res.redirect('/get-more');
});

app.get('/team', (req, res) => {
  const lang = langOf(req); const db = readDb(); const settings = getSiteSettings();
  const configured = new Set((settings.teamDiscordIds || []).map(String));
  const admins = db.users.filter((u) => u.role === 'admin');
  const ids = [...new Set([...admins.map((u) => u.discordId), ...configured])];
  const members = ids.map((id) => {
    const user = db.users.find((u) => u.discordId === id) || null;
    const bootstrap = bootstrapAdmins.has(id); const admin = user?.role === 'admin' || bootstrap;
    const name = user?.globalName || user?.username || (admin ? tr(lang,'Administrator','Administrator') : tr(lang,'Team Mitglied','Team Member'));
    const role = bootstrap && id === firstAdmin ? tr(lang,'Founder & Administrator','Founder & Administrator') : admin ? tr(lang,'Administrator','Administrator') : tr(lang,'Team Mitglied','Team Member');
    const avatar = user?.avatar ? `https://cdn.discordapp.com/avatars/${encodeURIComponent(id)}/${encodeURIComponent(user.avatar)}.png?size=256` : '';
    return { id, name, role, avatar };
  }).sort((a,b) => (a.id === firstAdmin ? -1 : b.id === firstAdmin ? 1 : a.role.localeCompare(b.role)));
  const cards = members.map((m) => `<article class="team-card panel"><div class="team-avatar">${m.avatar ? `<img src="${esc(m.avatar)}" alt="">` : `<span>${esc((m.name || '?').slice(0,1).toUpperCase())}</span>`}</div><div class="team-info"><span class="eyebrow">${esc(m.role)}</span><h2>${esc(m.name)}</h2><div class="muted small">Discord ID: ${esc(m.id)}</div><a class="button ghost smallbtn" href="https://discord.com/users/${esc(m.id)}" target="_blank" rel="noopener">Discord</a></div></article>`).join('');
  render(req,res,'Team',`<div class="pagehead"><div><h1>${tr(lang,'Unser Team','Our Team')}</h1><p>${tr(lang,'Die Personen hinter status-hub.lol.','The people behind status-hub.lol.')}</p></div></div><section class="team-grid">${cards || `<div class="panel empty">${tr(lang,'Noch keine Team-Mitglieder eingetragen.','No team members configured yet.')}</div>`}</section>`);
});

app.get('/donate', (req, res) => {
  const lang = langOf(req); const settings = getSiteSettings(); const supporters = listSupporters(true); const links = settings.donationLinks || {};
  const buttons = [[links.paypal,'PayPal'],[links.kofi,'Ko-fi'],[links.stripe,'Stripe'],[links.customUrl,links.customLabel || tr(lang,'Unterstützen','Support')]].filter(([url])=>url).map(([url,label])=>`<a class="button primary donate-button" href="${esc(url)}" target="_blank" rel="noopener">${esc(label)}</a>`).join('');
  const wall = supporters.map((s)=>`<article class="supporter panel ${s.featured?'featured':''}"><div class="row between"><h3>${esc(s.displayName)}</h3>${s.amountLabel?`<span class="badge neutral">${esc(s.amountLabel)}</span>`:''}</div>${s.message?`<p>${esc(s.message)}</p>`:''}${s.link?`<a href="${esc(s.link)}" target="_blank" rel="noopener">${tr(lang,'Profil/Link','Profile/link')}</a>`:''}</article>`).join('');
  render(req,res,tr(lang,'Spenden','Donate'),`<div class="donate-hero panel"><span class="eyebrow">status-hub.lol</span><h1>${tr(lang,'status-hub.lol unterstützen','Support status-hub.lol')}</h1><p>${tr(lang,'Spenden helfen bei VPS-Kosten, Entwicklung und mehr kostenlosen Kapazitäten.','Donations help cover VPS costs, development and more free capacity.')}</p><div class="actions wrap">${buttons || `<span class="muted">${tr(lang,'Spendenlinks werden noch eingerichtet.','Donation links are being set up.')}</span>`}</div></div><div class="pagehead supporters-head"><div><h2>${tr(lang,'Supporter','Supporters')}</h2><p>${tr(lang,'Danke an alle, die das Projekt unterstützen.','Thank you to everyone supporting the project.')}</p></div></div><section class="supporter-grid">${wall || `<div class="empty panel">${tr(lang,'Noch keine öffentlichen Supporter eingetragen.','No public supporters listed yet.')}</div>`}</section>`);
});

app.get('/', requireLogin, (req, res) => {
  const lang = langOf(req); const u = currentUser(req); const db = readDb(); const settings = db.siteSettings || getSiteSettings(); const servers = listServersFor(u.discordId, false);
  const ownCount = db.servers.filter((s) => s.ownerDiscordId === u.discordId).length;
  const plan = effectivePlan(u); const limit = statusLimit(u);
  const stateLabel = (state, r, server) => state === 'online' ? (server?.gameType === 'text_only' ? tr(lang,'Text-Rotation aktiv','Text rotation active') : `${r.players}/${r.maxPlayers} ${tr(lang,'Spieler','players')}`) : state === 'offline' ? tr(lang,'Gameserver offline','Game server offline') : state === 'error' ? tr(lang,'Bot-Fehler','Bot error') : state === 'waiting-node' ? tr(lang,'Wartet auf freien Node','Waiting for free node') : state === 'node-offline' ? tr(lang,'Status-Node offline','Status node offline') : state === 'plan-paused' ? tr(lang,'Durch Limit pausiert','Paused by limit') : state === 'assigned' ? tr(lang,'Node zugewiesen','Node assigned') : state;
  const cards = servers.map((s) => {
    const r = clusterRuntime(s.id); const state = r.state || 'stopped'; const invite = (r.botId || s.botId) ? `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(r.botId || s.botId)}&scope=bot&permissions=0` : null; const owner = s.ownerDiscordId ? findUser(s.ownerDiscordId) : null;
    return `<article class="servercard panel"><div class="row between"><div><h2>${esc(s.name)}</h2><div class="chips"><span class="badge ${esc(state)}">${esc(stateLabel(state,r,s))}</span><span class="badge neutral">${esc(s.gameType === 'gamedig' ? (gameDigMeta(s.queryConfig?.gameId)?.name || `GameDig: ${s.queryConfig?.gameId || '?'}`) : gameTypeLabel(s.gameType))}</span></div></div><div class="dot ${esc(state)}"></div></div>${u.role === 'admin' ? `<p class="muted small">Owner: ${esc(owner?.globalName || owner?.username || s.ownerDiscordId || 'Legacy')} · Node: ${esc(r.nodeName || s.assignedNodeId || tr(lang,'nicht zugewiesen','unassigned'))}</p>` : ''}<dl><div><dt>Bot</dt><dd>${esc(r.botTag || tr(lang,'noch nicht verbunden','not connected yet'))}</dd></div><div><dt>Presence</dt><dd>${esc(r.presence || '—')}</dd></div>${s.gameType === 'text_only' ? '' : `<div><dt>Map</dt><dd>${esc(r.map || '—')}</dd></div><div><dt>Ping</dt><dd>${esc(r.ping == null ? '—' : `${r.ping} ms`)}</dd></div>`}</dl>${r.lastError ? `<div class="errorbox">${esc(r.lastError)}</div>` : ''}<div class="actions wrap">${invite ? `<a class="button ghost" href="${invite}" target="_blank" rel="noopener">${tr(lang,'Bot einladen','Invite bot')}</a>` : ''}<a class="button ghost" href="/servers/${esc(s.id)}/edit">${tr(lang,'Bearbeiten','Edit')}</a><form method="post" action="/servers/${esc(s.id)}/test" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button ghost">${tr(lang,'Status testen','Test status')}</button></form>${s.enabled?`<form method="post" action="/servers/${esc(s.id)}/stop" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button ghost">${tr(lang,'Offline schalten','Take offline')}</button></form><form method="post" action="/servers/${esc(s.id)}/restart" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button ghost">${tr(lang,'Neu starten','Restart')}</button></form>`:`<form method="post" action="/servers/${esc(s.id)}/restart" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button success">${tr(lang,'Bot starten','Start bot')}</button></form>`}<form method="post" action="/servers/${esc(s.id)}/delete" class="inline" onsubmit="return confirm('${tr(lang,'Status Bot wirklich löschen?','Delete this status bot?')}')"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button danger">${tr(lang,'Löschen','Delete')}</button></form></div></article>`;
  }).join('');
  const canAdd = ownCount < limit;
  const expiry = plan.expiresAt && !plan.expired ? ` · ${tr(lang,'bis','until')} ${new Date(plan.expiresAt).toLocaleString(localeCode(lang))}` : '';
  const quota = u.role === 'admin' ? tr(lang,'Admin: unbegrenzt','Admin: unlimited') : `${ownCount}/${limit} Status Bots · ${plan.label}${expiry}`;
  const branding = u.role !== 'admin' && plan.branded ? `<div class="panel help"><strong>Free:</strong> ${tr(lang,'Alle Free-Status-Bots zeigen automatisch','All Free status bots automatically show')} <code>Powered by ${esc(settings.serviceDomain || 'status-hub.lol')}</code>. <a href="/get-more">${tr(lang,'Bis zu 5 gratis bekommen','Get up to 5 for free')}</a>.</div>` : '';
  const renewalNotice=plan.renewalRequired?`<div class="panel renew-alert"><strong>${tr(lang,'Free-Renew erforderlich','Free renewal required')}:</strong> ${tr(lang,'Deine Bots sind pausiert. Verlängere den Gratis-Zugang im Account-Dashboard.','Your bots are paused. Renew free access in your account dashboard.')} <a href="/account">${tr(lang,'Jetzt verlängern','Renew now')}</a></div>`:'';
  const premiumGraceNotice=plan.premiumGrace?`<div class="panel help"><strong>${tr(lang,'Premium abgelaufen','Premium expired')}:</strong> ${tr(lang,`Ein Bot bleibt online. Deine weiteren Bots bleiben ${GRACE_DAYS} Tage gespeichert und kommen bei erneuter Zahlung automatisch zurück. Danach werden sie gelöscht.`,`One bot remains online. Your additional bots are stored for ${GRACE_DAYS} days and automatically return after payment. After that they are deleted.`)}</div>`:'';
  render(req,res,'Status Bots',`<div class="pagehead"><div><h1>Status Bots</h1><p>${esc(quota)} · WARDOGS, FiveM, GameDig, JSON & Text Rotation</p></div>${canAdd ? `<a class="button primary" href="/servers/new">+ Status Bot</a>` : `<a class="button ghost" href="/plans">${tr(lang,'Limit erreicht · Premium ansehen','Limit reached · View Premium')}</a>`}</div>${renewalNotice}${premiumGraceNotice}${branding}<section class="grid">${cards || `<div class="empty panel">${tr(lang,'Noch keine Status Bots angelegt.','No status bots yet.')}</div>`}</section>`);
});

app.get('/servers/new', requireLogin, (req, res) => {
  const u = currentUser(req); const count = readDb().servers.filter((s) => s.ownerDiscordId === u.discordId).length;
  if (count >= statusLimit(u)) { flash(req,'status-limit',l(req,'Dein Status-Bot-Limit ist erreicht. Mit Premium kannst du weitere Status-Bots freischalten.','Your status-bot limit has been reached. Premium unlocks additional status bots.')); return res.redirect('/'); }
  const requestedType = ['wardogs','fivem','gamedig','generic_json','text_only'].includes(String(req.query.type || '')) ? String(req.query.type) : 'fivem';
  const requestedGame = gameDigMeta(String(req.query.game || '')) ? String(req.query.game) : '';
  const initial = { gameType: requestedType, queryConfig: requestedType === 'gamedig' && requestedGame ? { gameId: requestedGame, port: gameDigMeta(requestedGame)?.defaultPort || null, extraOptions: {} } : {} };
  render(req, res, l(req,'Status Bot erstellen','Create status bot'), `<div class="pagehead"><div><h1>${l(req,'Status Bot erstellen','Create status bot')}</h1><p>${l(req,'Serverstatus oder reine Text-Rotation. Beides zählt als ein Status-Bot.','Server status or text-only rotation. Both count as one status bot.')}</p></div><a class="button ghost" href="/games">Games & FAQ</a></div>${serverForm({ server: initial, csrf: csrf(req), isAdmin: u.role === 'admin', lang: langOf(req) })}`);
});

app.post('/servers/new', requireLogin, checkCsrf, async (req, res) => {
  try {
    const u = currentUser(req); const count = readDb().servers.filter((s) => s.ownerDiscordId === u.discordId).length;
    if (count >= statusLimit(u)) throw new Error('Dein Status-Bot-Limit ist erreicht');
    const name = String(req.body.name || '').trim(); const token = String(req.body.botToken || '').trim();
    if (!name || !token) throw new Error('Name und Discord Bot Token sind Pflicht');
    const bot = await validateBotToken(token);
    if (readDb().servers.some((x) => x.botId === bot.id)) throw new Error('Dieser Discord Bot wird bereits von einem anderen Status-Eintrag verwendet');
    const q = buildQuery(req);
    const entry = upsertServer({
      ownerDiscordId: u.discordId, name, botTokenEnc: encryptSecret(token), botId: bot.id,
      gameType: q.gameType, queryConfig: q.queryConfig, querySecretEnc: q.newSecret ? encryptSecret(q.newSecret) : null,
      allowPrivateTarget: u.role === 'admin' && req.body.allowPrivateTarget === '1',
      intervalSeconds: Math.min(3600, Math.max(10, Number(req.body.intervalSeconds) || 30)), switchSeconds: Math.min(3600, Math.max(5, Number(req.body.switchSeconds) || 15)),
      onlineTemplates: parseTemplates(req.body.onlineTemplates, q.gameType), offlineTemplate: String(req.body.offlineTemplate || 'Server offline').slice(0, 128), wardogsSeedingEnabled: q.gameType === 'wardogs' && req.body.wardogsSeedingEnabled === '1', enabled: req.body.enabled === '1', restartNonce: Date.now()
    });
    rebalanceAssignments(); flash(req, 'ok', `Status Bot „${entry.name}“ wurde erstellt und einem freien Status-Node zugewiesen.`); res.redirect('/');
  } catch (error) { flash(req, /limit/i.test(String(error.message)) ? 'status-limit' : 'err', error.message); res.redirect('/servers/new'); }
});

app.get('/servers/:id/edit', requireLogin, (req, res) => {
  const server = ownedServer(req, req.params.id); if (!server) return res.status(404).send('Server nicht gefunden');
  render(req, res, l(req,'Status Bot bearbeiten','Edit status bot'), `<div class="pagehead"><div><h1>${esc(server.name)}</h1><p>${l(req,'Leere Secret-Felder behalten vorhandene Werte.','Empty secret fields keep their current values.')}</p></div></div>${serverForm({ server, csrf: csrf(req), isEdit: true, isAdmin: isAdmin(req), lang: langOf(req) })}`);
});

app.post('/servers/:id/edit', requireLogin, checkCsrf, async (req, res) => {
  try {
    const old = ownedServer(req, req.params.id); if (!old) return res.status(404).send('Server nicht gefunden');
    const name = String(req.body.name || '').trim(); if (!name) throw new Error('Name fehlt');
    const q = buildQuery(req, old);
    const patch = {
      id: old.id, name, gameType: q.gameType, queryConfig: q.queryConfig,
      allowPrivateTarget: isAdmin(req) ? req.body.allowPrivateTarget === '1' : Boolean(old.allowPrivateTarget),
      intervalSeconds: Math.min(3600, Math.max(10, Number(req.body.intervalSeconds) || 30)), switchSeconds: Math.min(3600, Math.max(5, Number(req.body.switchSeconds) || 15)),
      onlineTemplates: parseTemplates(req.body.onlineTemplates, q.gameType), offlineTemplate: String(req.body.offlineTemplate || 'Server offline').slice(0, 128), wardogsSeedingEnabled: q.gameType === 'wardogs' && req.body.wardogsSeedingEnabled === '1', enabled: req.body.enabled === '1'
    };
    if (req.body.botToken) { const bot = await validateBotToken(String(req.body.botToken).trim()); if (readDb().servers.some((x) => x.id !== old.id && x.botId === bot.id)) throw new Error('Dieser Discord Bot wird bereits von einem anderen Status-Eintrag verwendet'); patch.botTokenEnc = encryptSecret(String(req.body.botToken).trim()); patch.botId = bot.id; }
    if (q.newSecret) patch.querySecretEnc = encryptSecret(q.newSecret);
    else if (q.clearSecret) patch.querySecretEnc = null;
    const entry = upsertServer({ ...patch, restartNonce: Date.now() }); rebalanceAssignments(); flash(req, 'ok', l(req,'Gespeichert und Neustart ausgelöst. Der Status-Node übernimmt die Änderung.','Saved and restart triggered. The status node will apply the change.')); res.redirect('/');
  } catch (error) { flash(req, 'err', error.message); res.redirect(`/servers/${encodeURIComponent(req.params.id)}/edit`); }
});

app.post('/servers/:id/test', requireLogin, checkCsrf, async (req, res) => {
  try {
    const server = ownedServer(req, req.params.id); if (!server) return res.status(404).send('Nicht gefunden');
    if (server.gameType === 'text_only') flash(req, 'ok', l(req, 'Text-Rotation ist bereit. Es ist keine Gameserver-Abfrage nötig.', 'Text rotation is ready. No game server query is required.'));
    else { const s = await fetchServerStatus(server); flash(req, 'ok', l(req, `Status OK: ${s.current}/${s.max} Spieler${s.map ? ` · Map: ${s.map}` : ''}`, `Status OK: ${s.current}/${s.max} players${s.map ? ` · Map: ${s.map}` : ''}`)); }
  } catch (error) { flash(req, 'err', `${l(req,'Status-Test fehlgeschlagen','Status test failed')}: ${error.message}`); }
  res.redirect('/');
});
app.post('/servers/:id/restart', requireLogin, checkCsrf, async (req, res) => {
  const s = ownedServer(req, req.params.id);
  if (!s) return res.status(404).send('Nicht gefunden');
  const fromAdmin=currentUser(req)?.role==='admin' && String(req.get('referer')||'').includes('/admin');
  try {
    await validateBotToken(decryptSecret(s.botTokenEnc));
    upsertServer({ id: s.id, enabled: true, restartNonce: Date.now() });
    rebalanceAssignments();
    const fresh = getServer(s.id);
    if (!fresh?.assignedNodeId) flash(req,'err',l(req,'Bot wurde aktiviert, aber aktuell ist kein freier Status-Node verfügbar.','Bot was enabled, but no free status node is currently available.'));
    else flash(req,'ok',l(req,'Bot wird jetzt gestartet bzw. neu gestartet.','Bot is now being started or restarted.'));
  } catch (error) { flash(req,'err',error.message); }
  res.redirect(fromAdmin?'/admin?tab=bots#bots':'/');
});
app.post('/servers/:id/stop', requireLogin, checkCsrf, (req,res) => { const s=ownedServer(req,req.params.id); if(!s)return res.status(404).send('Nicht gefunden'); upsertServer({id:s.id,enabled:false,assignedNodeId:null,restartNonce:Date.now()}); rebalanceAssignments(); flash(req,'ok',l(req,'Bot wurde offline geschaltet.','Bot was taken offline.')); const fromAdmin=currentUser(req)?.role==='admin'&&String(req.get('referer')||'').includes('/admin'); res.redirect(fromAdmin?'/admin?tab=bots#bots':'/'); });
app.post('/servers/:id/delete', requireLogin, checkCsrf, async (req, res) => { const s = ownedServer(req, req.params.id); if (!s) return res.status(404).send('Nicht gefunden'); deleteServer(s.id); rebalanceAssignments(); flash(req,'ok','Status Bot gelöscht. Der Node stoppt ihn automatisch.'); res.redirect('/'); });

app.get('/custom-bots', requireLogin, async (req, res) => {
  const lang=langOf(req); const u=currentUser(req); const bots=listCustomBotsFor(u.discordId,false);
  const ownCount=readDb().customBots.filter((b)=>b.ownerDiscordId===u.discordId).length; const limit=customLimit(u);
  const rows=await Promise.all(bots.map(async (b)=>{
    let rt={running:false,exists:false}; try{rt=await customBotStatus(b);}catch{}
    const owner=findUser(b.ownerDiscordId);
    const approval=b.approvalState==='approved'?tr(lang,'freigegeben','approved'):b.approvalState==='rejected'?tr(lang,'abgelehnt','rejected'):tr(lang,'wartet auf Freigabe','pending approval');
    return `<article class="servercard panel"><div class="row between"><div><h2>${esc(b.name)}</h2><div class="chips"><span class="badge ${b.approvalState==='approved'?'online':b.approvalState==='rejected'?'error':'neutral'}">${esc(approval)}</span><span class="badge ${rt.running?'online':'neutral'}">${rt.running?tr(lang,'läuft','running'):tr(lang,'gestoppt','stopped')}</span></div></div></div><p class="muted small">${esc(b.runtime)} · ${esc(b.entrypoint)}${u.role==='admin'?` · Owner: ${esc(owner?.globalName||owner?.username||b.ownerDiscordId)}`:''}</p>${b.reviewNote?`<div class="help">Admin: ${esc(b.reviewNote)}</div>`:''}<div class="actions wrap"><a class="button ghost" href="/custom-bots/${esc(b.id)}/source">Source ZIP</a><a class="button ghost" href="/custom-bots/${esc(b.id)}/logs">Logs</a>${b.approvalState==='approved'?`<form method="post" action="/custom-bots/${esc(b.id)}/start" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button ghost">${tr(lang,'Start/Neu bauen','Start/rebuild')}</button></form><form method="post" action="/custom-bots/${esc(b.id)}/stop" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button ghost">Stop</button></form>`:''}${u.role==='admin'&&b.approvalState!=='approved'?`<form method="post" action="/custom-bots/${esc(b.id)}/approve" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button primary">${tr(lang,'Freigeben','Approve')}</button></form>`:''}${u.role==='admin'&&b.approvalState==='approved'?`<form method="post" action="/custom-bots/${esc(b.id)}/revoke" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button danger">${tr(lang,'Freigabe entziehen','Revoke approval')}</button></form>`:''}<form method="post" action="/custom-bots/${esc(b.id)}/delete" class="inline" onsubmit="return confirm('${tr(lang,'Custom Bot löschen?','Delete custom bot?')}')"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button danger">${tr(lang,'Löschen','Delete')}</button></form></div></article>`;
  }));
  const canUpload=ownCount<limit;
  const quota=u.role==='admin'?tr(lang,'Admin: unbegrenzt','Admin: unlimited'):limit>0?`${ownCount}/${limit} ${tr(lang,'Upload-Slots','upload slots')}`:tr(lang,'Custom-Bot-Uploads nicht freigeschaltet','Custom bot uploads are not enabled');
  render(req,res,'Custom Bots',`<div class="pagehead"><div><h1>Custom Bots</h1><p>${esc(quota)} · ${tr(lang,'Node.js/Python Uploads laufen isoliert','Node.js/Python uploads run in isolated containers')}</p></div>${canUpload?`<a class="button primary" href="/custom-bots/new">+ ${tr(lang,'Bot hochladen','Upload bot')}</a>`:''}</div>${limit===0&&u.role!=='admin'?`<div class="panel warning">${tr(lang,'Ein Admin muss deinen Account zuerst für Custom-Bot-Uploads freischalten.','An admin must enable custom bot uploads for your account first.')}</div>`:''}<section class="grid">${rows.join('')||`<div class="empty panel">${tr(lang,'Keine Custom Bots.','No custom bots.')}</div>`}</section>`);
});

app.get('/custom-bots/new', requireLogin, (req,res)=>{
  const u=currentUser(req); const count=readDb().customBots.filter((b)=>b.ownerDiscordId===u.discordId).length;
  if(count>=customLimit(u)){flash(req,'limit',l(req,'Keine freien Custom-Bot-Slots. Custom Bots können nur von einem Admin freigeschaltet werden.','No free custom-bot slots. Custom bots can only be enabled by an admin.'));return res.redirect('/custom-bots');}
  render(req,res,l(req,'Custom Bot hochladen','Upload custom bot'),`<div class="pagehead"><div><h1>${l(req,'Custom Bot hochladen','Upload custom bot')}</h1><p>${l(req,'ZIP mit Sourcecode; jeder Upload benötigt Admin-Freigabe.','ZIP with source code; every upload requires admin approval.')}</p></div></div>${customBotForm({csrf:csrf(req),lang:langOf(req)})}`);
});

app.post('/custom-bots/new', requireLogin, upload.single('archive'), checkCsrf, async (req,res)=>{
  try{
    const u=currentUser(req); const count=readDb().customBots.filter((b)=>b.ownerDiscordId===u.discordId).length;
    if(count>=customLimit(u))throw new Error(l(req,'Keine freien Custom-Bot-Slots','No free custom bot slots'));
    if(!req.file)throw new Error(l(req,'ZIP-Datei fehlt','ZIP file is missing'));
    const name=String(req.body.name||'').trim(); if(!name)throw new Error(l(req,'Name fehlt','Name is required'));
    const runtime=String(req.body.runtime||'node22'); const prep=prepareCustomBot({buffer:req.file.buffer,runtime,entrypoint:req.body.entrypoint});
    const env=parseEnvText(req.body.envText); const adminUpload=u.role==='admin';
    const bot=upsertCustomBot({id:prep.id,ownerDiscordId:u.discordId,name,runtime:prep.runtime,entrypoint:prep.entrypoint,envEnc:encryptSecret(JSON.stringify(env)),approvalState:adminUpload?'approved':'pending',enabled:adminUpload,fileCount:prep.fileCount,unpackedBytes:prep.unpackedBytes,reviewNote:''});
    if(adminUpload)await ensureCustomBot(bot);
    flash(req,'ok',adminUpload?l(req,'Custom Bot hochgeladen und gestartet.','Custom bot uploaded and started.'):l(req,'Upload gespeichert. Ein Admin muss ihn vor dem Start freigeben.','Upload saved. An admin must approve it before it can start.')); res.redirect('/custom-bots');
  }catch(error){flash(req,/slots|limit/i.test(String(error.message))?'limit':'err',error.message);res.redirect('/custom-bots/new');}
});

app.post('/custom-bots/:id/approve', requireAdmin, checkCsrf, async (req,res)=>{try{const b=getCustomBot(req.params.id);if(!b)return res.status(404).send('Not found');const bot=upsertCustomBot({id:b.id,approvalState:'approved',enabled:true,reviewNote:l(req,'Von Admin freigegeben','Approved by admin')});await ensureCustomBot(bot);flash(req,'ok',l(req,'Custom Bot freigegeben und gestartet.','Custom bot approved and started.'));}catch(e){flash(req,'err',e.message);}res.redirect('/admin?tab=bots#bots');});
app.post('/custom-bots/:id/revoke', requireAdmin, checkCsrf, async (req,res)=>{const b=getCustomBot(req.params.id);if(!b)return res.status(404).send('Not found');await stopCustomBot(b).catch(()=>{});upsertCustomBot({id:b.id,approvalState:'rejected',enabled:false,reviewNote:l(req,'Freigabe entzogen','Approval revoked')});flash(req,'ok',l(req,'Freigabe entzogen.','Approval revoked.'));res.redirect('/admin?tab=bots#bots');});
app.post('/custom-bots/:id/start', requireLogin, checkCsrf, async (req,res)=>{try{const b=ownedCustom(req,req.params.id);if(!b)return res.status(404).send('Not found');if(b.approvalState!=='approved')throw new Error(l(req,'Bot ist nicht freigegeben','Bot is not approved'));const bot=upsertCustomBot({id:b.id,enabled:true});await restartCustomBot(bot);flash(req,'ok',l(req,'Custom Bot neu gebaut und gestartet.','Custom bot rebuilt and started.'));}catch(e){flash(req,'err',e.message);}res.redirect('/custom-bots');});
app.post('/custom-bots/:id/stop', requireLogin, checkCsrf, async (req,res)=>{const b=ownedCustom(req,req.params.id);if(!b)return res.status(404).send('Not found');await stopCustomBot(b).catch(()=>{});upsertCustomBot({id:b.id,enabled:false});flash(req,'ok',l(req,'Custom Bot gestoppt.','Custom bot stopped.'));res.redirect('/custom-bots');});
app.get('/custom-bots/:id/source', requireLogin, (req,res)=>{const b=ownedCustom(req,req.params.id);if(!b)return res.status(404).send('Not found');const file=`custom-bots/${b.id}/source.zip`;res.download(file,`${String(b.name||'custom-bot').replace(/[^A-Za-z0-9._-]+/g,'_')}.zip`);});
app.get('/custom-bots/:id/logs', requireLogin, async (req,res)=>{const b=ownedCustom(req,req.params.id);if(!b)return res.status(404).send('Not found');let logs='';try{logs=(await customBotLogs(b)).logs||'';}catch(e){logs=`Logs unavailable: ${e.message}`;}render(req,res,'Custom Bot Logs',`<div class="pagehead"><div><h1>${esc(b.name)} · Logs</h1></div><a class="button ghost" href="/custom-bots">${l(req,'Zurück','Back')}</a></div><pre class="panel logbox">${esc(logs)}</pre>`);});
app.post('/custom-bots/:id/delete', requireLogin, checkCsrf, async (req,res)=>{const b=ownedCustom(req,req.params.id);if(!b)return res.status(404).send('Not found');await deleteCustomBotRuntime(b).catch(()=>{});deleteCustomBotFiles(b.id);deleteCustomBot(b.id);flash(req,'ok',l(req,'Custom Bot gelöscht.','Custom bot deleted.'));res.redirect('/custom-bots');});

function adminShell(req, active, content) {
  const lang=langOf(req);
  const items=[['overview',tr(lang,'Übersicht','Overview')],['bots',tr(lang,'Alle Bots','All bots')],['nodes',tr(lang,'Nodes','Nodes')],['users',tr(lang,'Benutzer & Pläne','Users & plans')],['services',tr(lang,'Bot Services','Bot services')],['settings',tr(lang,'Einstellungen','Settings')]];
  const nav=items.map(([id,label])=>`<a class="${active===id?'active':''}" href="/admin?tab=${id}#${id}">${esc(label)}</a>`).join('');
  return `<div class="admin-shell"><aside class="admin-sidebar panel"><span class="eyebrow">Admin</span><h2>Control Center</h2><nav>${nav}</nav></aside><section class="admin-content" id="${esc(active)}">${content}</section></div>`;
}

function adminNodesContent(req) {
  rebalanceAssignments();
  const lang=langOf(req),db=readDb(),nodes=listStatusNodes();
  const rows=nodes.map((n)=>{const healthy=nodeIsHealthy(n),assigned=db.servers.filter((s)=>s.assignedNodeId===n.id).length,m=n.metrics||{},mode=n.disabled?tr(lang,'Deaktiviert','Disabled'):n.acceptNewBots===false?tr(lang,'Keine neuen Bots','No new bots'):tr(lang,'Nimmt Bots an','Accepting bots');return `<tr><td><strong>${esc(n.name||n.id)}</strong><div class="muted small">${esc(n.id)} · ${esc(n.hostname||'')}</div></td><td><span class="badge ${healthy?'online':'error'}">${healthy?'online':'offline'}</span><div class="muted small">${esc(mode)}</div></td><td>${assigned}/${esc(n.capacity||0)}</td><td>${esc(m.rssMb??'—')} MB RSS<div class="muted small">${tr(lang,'frei','free')} ${esc(m.freeMemMb??'—')} MB / ${esc(m.totalMemMb??'—')} MB</div></td><td><form method="post" action="/nodes/${esc(n.id)}" class="nodeform"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><input name="name" maxlength="100" value="${esc(n.name||'')}"><input name="capacity" type="number" min="1" max="1000" value="${esc(n.capacity||50)}"><label class="check"><input type="checkbox" name="acceptNewBots" value="1" ${n.acceptNewBots!==false?'checked':''}> ${tr(lang,'Neue Bots','New bots')}</label><label class="check"><input type="checkbox" name="disabled" value="1" ${n.disabled?'checked':''}> ${tr(lang,'Deaktiviert','Disabled')}</label><button class="button ghost smallbtn">${tr(lang,'Speichern','Save')}</button></form><div class="actions wrap"><a class="button ghost smallbtn" href="/nodes/${esc(n.id)}/details">${tr(lang,'Bots verwalten','Manage bots')}</a><form method="post" action="/nodes/${esc(n.id)}/restart-all" class="inline" onsubmit="return confirm('${tr(lang,'Alle aktiven Bots auf diesem Node neu starten?','Restart all active bots on this node?')}')"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button primary smallbtn">${tr(lang,'Alle Bots neu starten','Restart all bots')}</button></form><form method="post" action="/nodes/${esc(n.id)}/drain"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button ghost smallbtn">Drain</button></form></div></td></tr>`}).join('');
  const installer=String(process.env.NODE_INSTALL_SCRIPT_URL||'https://raw.githubusercontent.com/testererrewr/wardogs-status-panel/main/install-node.sh');
  const deploy=`curl -fsSL ${installer} | bash -s -- ${baseUrl} ${process.env.STATUS_NODE_JOIN_SECRET} 50 "Worker VPS"`;
  return `<div class="pagehead"><div><h1>${tr(lang,'Node Manager','Node Manager')}</h1><p>${tr(lang,'Neue Bots sperren, Nodes drainen, Kapazitäten setzen und Bots verschieben.','Block new bots, drain nodes, set capacity and move bots.')}</p></div></div><div class="panel node-deploy"><h2>${tr(lang,'Neuen VPS hinzufügen','Add a new VPS')}</h2><pre class="logbox">${esc(deploy)}</pre></div><div class="panel tablewrap"><table><thead><tr><th>Node</th><th>Status</th><th>${tr(lang,'Belegung','Load')}</th><th>RAM</th><th>${tr(lang,'Verwaltung','Management')}</th></tr></thead><tbody>${rows||`<tr><td colspan="5">${tr(lang,'Keine Nodes','No nodes')}</td></tr>`}</tbody></table></div>`;
}

function adminBotsContent(req) {
  const lang=langOf(req),db=readDb();
  const statusRows=db.servers.map((server)=>{
    const owner=db.users.find((u)=>u.discordId===server.ownerDiscordId); const runtime=clusterRuntime(server.id); const state=runtime.state||'stopped';
    const game=server.gameType==='gamedig'?(gameDigMeta(server.queryConfig?.gameId)?.name||server.queryConfig?.gameId||'GameDig'):gameTypeLabel(server.gameType);
    return `<tr><td><strong>${esc(server.name)}</strong><div class="muted small">${esc(server.id)}</div></td><td>${esc(owner?.globalName||owner?.username||server.ownerDiscordId||'—')}<div class="muted small">${esc(server.ownerDiscordId||'')}</div></td><td>${esc(game)}</td><td><span class="badge ${state==='online'?'online':state==='error'?'error':'neutral'}">${esc(state)}</span></td><td>${esc(runtime.nodeName||server.assignedNodeId||'—')}</td><td><div class="actions wrap"><a class="button ghost smallbtn" href="/servers/${esc(server.id)}/edit">${tr(lang,'Bearbeiten','Edit')}</a>${server.enabled?`<form method="post" action="/servers/${esc(server.id)}/stop" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button ghost smallbtn">${tr(lang,'Offline','Offline')}</button></form>`:''}<form method="post" action="/servers/${esc(server.id)}/restart" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button ghost smallbtn">${server.enabled?tr(lang,'Neustart','Restart'):tr(lang,'Starten','Start')}</button></form></div></td></tr>`;
  }).join('');
  const customRows=db.customBots.map((bot)=>{const owner=db.users.find((u)=>u.discordId===bot.ownerDiscordId);const approval=bot.approvalState||'pending';return `<tr><td><strong>${esc(bot.name)}</strong><div class="muted small">${esc(bot.id)}</div></td><td>${esc(owner?.globalName||owner?.username||bot.ownerDiscordId||'—')}</td><td>${esc(bot.runtime||'—')}</td><td>${esc(approval)}</td><td><div class="actions wrap"><a class="button ghost smallbtn" href="/custom-bots/${esc(bot.id)}/logs">Logs</a><a class="button ghost smallbtn" href="/custom-bots/${esc(bot.id)}/source">Source</a>${approval!=='approved'?`<form method="post" action="/custom-bots/${esc(bot.id)}/approve" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button primary smallbtn">${tr(lang,'Freigeben','Approve')}</button></form>`:`<form method="post" action="/custom-bots/${esc(bot.id)}/revoke" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button danger smallbtn">${tr(lang,'Entziehen','Revoke')}</button></form>`}</div></td></tr>`;}).join('');
  return `<div class="pagehead"><div><h1>${tr(lang,'Alle Bots','All bots')}</h1><p>${tr(lang,'Bots anderer Benutzer werden nur hier im Adminbereich angezeigt.','Bots owned by other users are shown only here in the admin area.')}</p></div></div><div class="admin-subhead"><h2>Status Bots</h2></div><div class="panel tablewrap"><table><thead><tr><th>Bot</th><th>Owner</th><th>Game</th><th>Status</th><th>Node</th><th>${tr(lang,'Aktionen','Actions')}</th></tr></thead><tbody>${statusRows||`<tr><td colspan="6">${tr(lang,'Keine Status Bots','No status bots')}</td></tr>`}</tbody></table></div><div class="admin-subhead subsection"><h2>Custom Bots</h2></div><div class="panel tablewrap"><table><thead><tr><th>Bot</th><th>Owner</th><th>Runtime</th><th>${tr(lang,'Freigabe','Approval')}</th><th>${tr(lang,'Aktionen','Actions')}</th></tr></thead><tbody>${customRows||`<tr><td colspan="5">${tr(lang,'Keine Custom Bots','No custom bots')}</td></tr>`}</tbody></table></div>`;
}

function adminUsersContent(req) {
  const lang=langOf(req),db=readDb();
  const baseOptions=Object.values(PLANS).map((p)=>`<option value="${esc(p.id)}">${esc(p.label)} (${p.statusBotLimit})</option>`).join('');
  const rows=db.users.map((u)=>{const count=db.servers.filter((s)=>s.ownerDiscordId===u.discordId).length,custom=db.customBots.filter((b)=>b.ownerDiscordId===u.discordId).length,plan=effectivePlan(u),opts=baseOptions.replace(`value="${esc(u.planId||'free')}"`,`value="${esc(u.planId||'free')}" selected`);return `<tr><td><strong>${esc(u.globalName||u.username||u.discordId)}</strong><div class="muted small">${esc(u.discordId)}</div></td><td>${count}/${plan.statusBotLimit===Infinity?'∞':esc(plan.statusBotLimit)}<div class="muted small">${esc(plan.label)}</div></td><td>${custom}/${esc(u.customBotLimit||0)}</td><td><form method="post" action="/users/${esc(u.discordId)}" class="userform"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><select name="role"><option value="user" ${u.role==='user'?'selected':''}>user</option><option value="admin" ${u.role==='admin'?'selected':''}>admin</option></select><select name="planId">${opts}</select><input name="planDuration" type="number" min="0" max="87600" placeholder="${tr(lang,'Dauer','Duration')}"><select name="planDurationUnit"><option value="hours">${tr(lang,'Stunden','Hours')}</option><option value="days" selected>${tr(lang,'Tage','Days')}</option><option value="months">${tr(lang,'Monate','Months')}</option></select><input name="statusBotLimitOverride" type="number" min="0" max="500" value="${u.statusBotLimitOverride??''}" placeholder="Bot override"><input name="customBotLimit" type="number" min="0" max="50" value="${esc(u.customBotLimit??0)}" placeholder="Custom"><label class="check compact"><input type="checkbox" name="freeRenewExempt" value="1" ${u.freeRenewExempt?'checked':''}> ${tr(lang,'Kein 14-Tage-Renew','No 14-day renew')}</label><button class="button ghost smallbtn">${tr(lang,'Speichern','Save')}</button></form></td></tr>`}).join('');
  return `<div class="pagehead"><div><h1>${tr(lang,'Benutzer & Pläne','Users & plans')}</h1><p>${tr(lang,'Premium zeitlich oder dauerhaft freischalten. Custom Bots bleiben separat.','Enable Premium temporarily or permanently. Custom bots remain separate.')}</p></div></div><div class="panel tablewrap"><table><thead><tr><th>User</th><th>Status Bots</th><th>Custom Bots</th><th>${tr(lang,'Freigaben','Permissions')}</th></tr></thead><tbody>${rows||`<tr><td colspan="4">${tr(lang,'Keine Benutzer','No users')}</td></tr>`}</tbody></table></div>`;
}

function adminServicesContent(req) {
  const lang=langOf(req),services=listBotServices(false),editId=String(req.query.edit||''),edit=editId?getBotService(editId):null,f=edit||{};
  const rows=services.map((x)=>`<tr><td><strong>${esc(x.nameDe||x.nameEn)}</strong></td><td>${esc(x.priceLabel||'—')}</td><td>${esc(x.status)}</td><td><div class="actions wrap"><a class="button ghost smallbtn" href="/admin?tab=services&edit=${encodeURIComponent(x.id)}#services">${tr(lang,'Bearbeiten','Edit')}</a><form method="post" action="/admin/bot-services/${esc(x.id)}/delete" class="inline" onsubmit="return confirm('${tr(lang,'Bot Service löschen?','Delete bot service?')}')"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button danger smallbtn">${tr(lang,'Löschen','Delete')}</button></form></div></td></tr>`).join('');
  return `<div class="pagehead"><div><h1>${tr(lang,'Bot Services','Bot services')}</h1><p>${tr(lang,'Einzeln kaufbare Managed Bots verwalten.','Manage individually purchasable managed bots.')}</p></div><a class="button ghost" href="/bot-services" target="_blank">${tr(lang,'Öffentliche Seite','Public page')}</a></div><form method="post" action="/admin/bot-services" class="panel formgrid"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><input type="hidden" name="id" value="${esc(f.id||'')}"><label>${tr(lang,'Name Deutsch','Name German')}<input name="nameDe" required value="${esc(f.nameDe||'')}"></label><label>${tr(lang,'Name Englisch','Name English')}<input name="nameEn" required value="${esc(f.nameEn||'')}"></label><label class="span2">${tr(lang,'Beschreibung Deutsch','Description German')}<textarea name="descriptionDe" rows="3" required>${esc(f.descriptionDe||'')}</textarea></label><label class="span2">${tr(lang,'Beschreibung Englisch','Description English')}<textarea name="descriptionEn" rows="3" required>${esc(f.descriptionEn||'')}</textarea></label><label>${tr(lang,'Preis','Price')}<input name="priceLabel" value="${esc(f.priceLabel||'')}"></label><label>Status<select name="status"><option value="coming_soon" ${f.status==='coming_soon'||!f.status?'selected':''}>Coming soon</option><option value="available" ${f.status==='available'?'selected':''}>Available</option><option value="paused" ${f.status==='paused'?'selected':''}>Paused</option></select></label><label>${tr(lang,'Kauf-Link','Purchase URL')}<input name="purchaseUrl" value="${esc(f.purchaseUrl||'')}"></label><label>${tr(lang,'Support-Link','Support URL')}<input name="supportUrl" value="${esc(f.supportUrl||'')}"></label><label class="check"><input type="checkbox" name="visible" value="1" ${f.visible!==false?'checked':''}> ${tr(lang,'Sichtbar','Visible')}</label><label class="check"><input type="checkbox" name="featured" value="1" ${f.featured?'checked':''}> Featured</label><label class="span2">${tr(lang,'Features Deutsch','Features German')}<textarea name="featuresDe" rows="5">${esc((f.featuresDe||[]).join('\n'))}</textarea></label><label class="span2">${tr(lang,'Features Englisch','Features English')}<textarea name="featuresEn" rows="5">${esc((f.featuresEn||[]).join('\n'))}</textarea></label><div class="span2 actions"><button class="button primary">${edit?tr(lang,'Speichern','Save'):tr(lang,'Hinzufügen','Add')}</button></div></form><div class="panel tablewrap"><table><thead><tr><th>Service</th><th>${tr(lang,'Preis','Price')}</th><th>Status</th><th></th></tr></thead><tbody>${rows||`<tr><td colspan="4">${tr(lang,'Keine Services','No services')}</td></tr>`}</tbody></table></div>`;
}

function adminSettingsContent(req) {
  const lang=langOf(req),settings=getSiteSettings(),supporters=listSupporters(false),tiers=settings.freeBoost?.tiers||[],teamIds=(settings.teamDiscordIds||[]).join(', '),sales=settings.premiumSales||{},prices=sales.prices||{},auto=paypalAutoConfig(settings),sub=paypalSubscriptionConfig(settings),apiState=paypalCredentialState(settings),discordAuth=discordOAuthConfig(settings);
  const tierValue=(limit,fallback)=>tiers.find((x)=>Number(x.limit)===limit)?.members??fallback;
  const rows=supporters.map((x)=>`<tr><td><strong>${esc(x.displayName)}</strong></td><td>${esc(x.amountLabel||'—')}</td><td><form method="post" action="/admin/supporters/${esc(x.id)}/delete"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button danger smallbtn">${tr(lang,'Entfernen','Remove')}</button></form></td></tr>`).join('');
  const paypalCredentialStateHtml=apiState.configured?`<span class="badge online">${tr(lang,'PayPal API bereit','PayPal API ready')}</span><span class="badge ${apiState.storedInPanel?'online':'neutral'}">${apiState.storedInPanel?tr(lang,'Im Panel gespeichert','Stored in panel'):tr(lang,'Legacy .env Fallback','Legacy .env fallback')}</span>`:`<span class="badge error">${tr(lang,'PayPal API Zugangsdaten fehlen','PayPal API credentials missing')}</span>`;
  const webhookState=auto.webhookId?`<span class="badge online">Webhook ${esc(auto.webhookId)}</span>`:`<span class="badge neutral">${tr(lang,'Webhook nicht eingerichtet','Webhook not configured')}</span>`;
  return `<div class="pagehead"><div><h1>${tr(lang,'Einstellungen','Settings')}</h1><p>${tr(lang,'Branding, Premium-Verkauf, Free-Boost und öffentliche Links.','Branding, Premium sales, free boost and public links.')}</p></div></div>
  <form method="post" action="/admin/settings" class="panel formgrid"><input type="hidden" name="_csrf" value="${esc(csrf(req))}">
    <label>${tr(lang,'Service-Domain','Service domain')}<input name="serviceDomain" required value="${esc(settings.serviceDomain||'status-hub.lol')}"></label><label>Support URL<input name="supportUrl" value="${esc(settings.supportUrl||'')}"></label><label class="span2">${tr(lang,'Team Discord IDs','Team Discord IDs')}<input name="teamDiscordIds" value="${esc(teamIds)}"></label>
    <div class="span2 admin-subhead"><h3>Discord OAuth</h3></div>
    <label class="check"><input type="checkbox" name="discordOAuthEnabled" value="1" ${discordAuth.enabled?'checked':''}> ${tr(lang,'Discord Login aktivieren','Enable Discord login')}</label>
    <label class="check"><input type="checkbox" name="discordAllowRegistration" value="1" ${discordAuth.allowRegistration?'checked':''}> ${tr(lang,'Neue Benutzer dürfen sich registrieren','Allow new user registrations')}</label>
    <label class="span2">Discord Client / Application ID<input name="discordClientId" value="${esc(discordAuth.clientId||'')}" autocomplete="off" placeholder="Application ID"></label>
    <label class="span2">Discord Client Secret<input name="discordClientSecret" type="password" autocomplete="new-password" placeholder="${discordAuth.clientSecret?tr(lang,'Leer lassen = vorhandenes Secret behalten','Leave empty to keep current secret'):'Client Secret'}"></label>
    <label class="span2">OAuth Redirect URL<input value="${esc(discordAuth.redirectUri)}" readonly></label>
    <label class="check span2"><input type="checkbox" name="discordClearCredentials" value="1"> ${tr(lang,'Gespeicherte Discord OAuth Zugangsdaten löschen','Clear stored Discord OAuth credentials')}</label>
    <div class="span2 help"><div class="actions wrap"><span class="badge ${discordAuth.configured?'online':'error'}">${discordAuth.configured?tr(lang,'Discord OAuth bereit','Discord OAuth ready'):tr(lang,'Discord OAuth unvollständig','Discord OAuth incomplete')}</span><span class="badge ${discordAuth.storedInPanel?'online':'neutral'}">${discordAuth.storedInPanel?tr(lang,'Secret im Panel gespeichert','Secret stored in panel'):tr(lang,'Legacy .env Fallback','Legacy .env fallback')}</span><button class="button ghost" type="submit" formaction="/admin/discord/test" formmethod="post">${tr(lang,'Speichern & Discord Login testen','Save & test Discord login')}</button></div><p class="muted small">${tr(lang,'Die Redirect URL muss im Discord Developer Portal unter OAuth2 → Redirects exakt eingetragen sein. Das Client Secret wird verschlüsselt gespeichert.','The redirect URL must be entered exactly in the Discord Developer Portal under OAuth2 → Redirects. The client secret is stored encrypted.')}</p></div>
    <div class="span2 admin-subhead"><h3>Premium & PayPal</h3></div>
    <label>${tr(lang,'PayPal Modus','PayPal mode')}<select name="paypalMode"><option value="sandbox" ${apiState.mode==='sandbox'?'selected':''}>Sandbox</option><option value="live" ${apiState.mode==='live'?'selected':''}>Live</option></select></label>
    <label>PayPal Client ID<input name="paypalClientId" value="${esc(apiState.clientId||'')}" autocomplete="off" placeholder="Client ID"></label>
    <label class="span2">PayPal Client Secret<input name="paypalClientSecret" type="password" autocomplete="new-password" placeholder="${apiState.hasSecret?tr(lang,'Leer lassen = vorhandenes Secret behalten','Leave empty to keep current secret'):'Client Secret'}"></label>
    <div class="span2 help">${tr(lang,'Sandbox benötigt die Client ID und das Client Secret einer PayPal Sandbox REST-App. Live-Zugangsdaten funktionieren im Sandbox-Modus nicht.','Sandbox requires the Client ID and Client Secret from a PayPal Sandbox REST app. Live credentials do not work in Sandbox mode.')}</div>
    <label class="check span2"><input type="checkbox" name="paypalClearCredentials" value="1"> ${tr(lang,'Gespeicherte PayPal API-Zugangsdaten löschen','Clear stored PayPal API credentials')}</label>
    <label class="check span2"><input type="checkbox" name="paypalAutoEnabled" value="1" ${auto.enabled?'checked':''}> ${tr(lang,'Automatische PayPal-Freischaltung aktivieren','Enable automatic PayPal activation')}</label>
    <label>${tr(lang,'Währung','Currency')}<input name="paypalCurrency" maxlength="3" value="${esc(auto.currency)}" placeholder="EUR"></label><label>${tr(lang,'Premium-Dauer pro Kauf (Tage)','Premium duration per purchase (days)')}<input name="paypalAccessDays" type="number" min="1" max="3650" value="${esc(auto.accessDays)}"></label>
    <label>Premium 5 PayPal<input name="paypalAmountPremium5" inputmode="decimal" value="${esc(auto.amounts.premium5||'')}"></label><label>Premium 10 PayPal<input name="paypalAmountPremium10" inputmode="decimal" value="${esc(auto.amounts.premium10||'')}"></label><label>Premium 15 PayPal<input name="paypalAmountPremium15" inputmode="decimal" value="${esc(auto.amounts.premium15||'')}"></label><label>Premium 20 PayPal<input name="paypalAmountPremium20" inputmode="decimal" value="${esc(auto.amounts.premium20||'')}"></label>
    <div class="span2 admin-subhead"><h3>${tr(lang,'Monatliche PayPal-Abos','Monthly PayPal subscriptions')}</h3></div>
    <label class="check span2"><input type="checkbox" name="paypalSubscriptionEnabled" value="1" ${sub.enabled?'checked':''}> ${tr(lang,'Monatliche Abos anbieten','Offer monthly subscriptions')}</label>
    <label>Premium 5 / ${tr(lang,'Monat','month')}<input name="paypalSubAmountPremium5" inputmode="decimal" value="${esc(sub.amounts.premium5||'')}"></label><label>Premium 10 / ${tr(lang,'Monat','month')}<input name="paypalSubAmountPremium10" inputmode="decimal" value="${esc(sub.amounts.premium10||'')}"></label><label>Premium 15 / ${tr(lang,'Monat','month')}<input name="paypalSubAmountPremium15" inputmode="decimal" value="${esc(sub.amounts.premium15||'')}"></label><label>Premium 20 / ${tr(lang,'Monat','month')}<input name="paypalSubAmountPremium20" inputmode="decimal" value="${esc(sub.amounts.premium20||'')}"></label>
    <div class="span2 help"><strong>${tr(lang,'Abo-Setup','Subscription setup')}:</strong> ${sub.productId ? `<span class="badge online">Product ${esc(sub.productId)}</span>` : `<span class="badge neutral">${tr(lang,'Noch nicht erstellt','Not created yet')}</span>`} <span class="muted small">${tr(lang,'Der PayPal-Setup-Button erstellt/aktualisiert Produkt und Monatspläne automatisch.','The PayPal setup button creates/updates the product and monthly plans automatically.')}</span></div>
    <div class="span2 help"><div class="actions wrap">${paypalCredentialStateHtml}${webhookState}<span class="badge neutral">${esc(apiState.mode)}</span><button class="button primary" type="submit" formaction="/admin/paypal/setup" formmethod="post">${tr(lang,'Speichern & PayPal automatisch einrichten / testen','Save & automatically set up / test PayPal')}</button></div><p class="muted small">${tr(lang,'Client Secret wird verschlüsselt in der Panel-Datenbank gespeichert. Für PayPal ist danach keine SSH- oder .env-Änderung nötig.','The client secret is encrypted in the panel database. No SSH or .env changes are needed for PayPal afterwards.')}</p></div>
    <label>PayPal URL (${tr(lang,'Fallback','fallback')})<input name="premiumPaypalUrl" value="${esc(sales.paypalUrl||'')}" placeholder="https://paypal.me/..."></label><label>${tr(lang,'Discord Username für Kauf','Discord username for sales')}<input name="salesDiscordUsername" value="${esc(sales.discordUsername||'')}" placeholder="@username"></label><label>${tr(lang,'Discord User ID für Kauf-Link','Discord user ID for sales link')}<input name="salesDiscordUserId" value="${esc(sales.discordUserId||'')}"></label>
    <label>Premium 5 ${tr(lang,'Anzeige','display')}<input name="pricePremium5" value="${esc(prices.premium5||'')}"></label><label>Premium 10 ${tr(lang,'Anzeige','display')}<input name="pricePremium10" value="${esc(prices.premium10||'')}"></label><label>Premium 15 ${tr(lang,'Anzeige','display')}<input name="pricePremium15" value="${esc(prices.premium15||'')}"></label><label>Premium 20 ${tr(lang,'Anzeige','display')}<input name="pricePremium20" value="${esc(prices.premium20||'')}"></label>
    <div class="span2 admin-subhead"><h3>${tr(lang,'Free-Boost','Free boost')}</h3></div><label>${tr(lang,'Branding-Kategorie','Branding category')}<input name="categoryName" value="${esc(settings.freeBoost?.categoryName||settings.freeBoost?.channelName||'Powered by status-hub.lol')}"></label><label>${tr(lang,'Prüfintervall Stunden','Verification hours')}<input name="verifyHours" type="number" min="1" max="48" value="${esc(settings.freeBoost?.verifyHours||6)}"></label><label>2 Bots ${tr(lang,'ab Mitgliedern','from members')}<input name="tier2" type="number" min="1" value="${esc(tierValue(2,50))}"></label><label>3 Bots ${tr(lang,'ab Mitgliedern','from members')}<input name="tier3" type="number" min="1" value="${esc(tierValue(3,100))}"></label><label>4 Bots ${tr(lang,'ab Mitgliedern','from members')}<input name="tier4" type="number" min="1" value="${esc(tierValue(4,250))}"></label><label>5 Bots ${tr(lang,'ab Mitgliedern','from members')}<input name="tier5" type="number" min="1" value="${esc(tierValue(5,500))}"></label>
    <div class="span2 admin-subhead"><h3>${tr(lang,'Spenden','Donations')}</h3></div><label>PayPal URL<input name="paypal" value="${esc(settings.donationLinks?.paypal||'')}"></label><label>Ko-fi URL<input name="kofi" value="${esc(settings.donationLinks?.kofi||'')}"></label><label>Stripe URL<input name="stripe" value="${esc(settings.donationLinks?.stripe||'')}"></label><label>${tr(lang,'Eigener Link','Custom URL')}<input name="customUrl" value="${esc(settings.donationLinks?.customUrl||'')}"></label><label>${tr(lang,'Button-Text','Button label')}<input name="customLabel" value="${esc(settings.donationLinks?.customLabel||'')}"></label><div class="span2 actions"><button class="button primary">${tr(lang,'Einstellungen speichern','Save settings')}</button></div>
  </form>
  <div class="pagehead subsection"><div><h2>Supporter</h2></div></div><form method="post" action="/admin/supporters" class="panel formgrid"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><label>${tr(lang,'Anzeigename','Display name')}<input name="displayName" required></label><label>${tr(lang,'Betrag/Badge','Amount/badge')}<input name="amountLabel"></label><label>${tr(lang,'Link optional','Optional link')}<input name="link"></label><label class="check"><input type="checkbox" name="featured" value="1"> Featured</label><label class="check"><input type="checkbox" name="visible" value="1" checked> ${tr(lang,'Sichtbar','Visible')}</label><div class="span2 actions"><button class="button primary">${tr(lang,'Supporter hinzufügen','Add supporter')}</button></div></form><div class="panel tablewrap"><table><tbody>${rows||`<tr><td>${tr(lang,'Keine Supporter','No supporters')}</td></tr>`}</tbody></table></div>`;
}


app.get('/admin', requireAdmin, (req,res)=>{
  const tab=['overview','bots','nodes','users','services','settings'].includes(String(req.query.tab||''))?String(req.query.tab):'overview';
  const db=readDb(); let content='';
  if(tab==='bots')content=adminBotsContent(req); else if(tab==='nodes')content=adminNodesContent(req); else if(tab==='users')content=adminUsersContent(req); else if(tab==='services')content=adminServicesContent(req); else if(tab==='settings')content=adminSettingsContent(req); else { const healthy=listStatusNodes().filter((n)=>nodeIsHealthy(n)).length; content=`<div class="pagehead"><div><h1>Admin Control Center</h1><p>${l(req,'Alles an einem Ort verwalten.','Manage everything from one place.')}</p></div></div><section class="admin-stats"><article class="panel"><span class="eyebrow">Users</span><strong>${db.users.length}</strong></article><article class="panel"><span class="eyebrow">Status Bots</span><strong>${db.servers.length}</strong></article><article class="panel"><span class="eyebrow">Nodes online</span><strong>${healthy}/${db.statusNodes.length}</strong></article><article class="panel"><span class="eyebrow">Custom Bots</span><strong>${db.customBots.length}</strong></article></section>`; }
  render(req,res,'Admin',adminShell(req,tab,content));
});

app.get('/nodes', requireAdmin, (req,res) => res.redirect('/admin?tab=nodes'));

app.post('/nodes/:id', requireAdmin, checkCsrf, (req,res) => {
  const n=getStatusNode(req.params.id); if(!n)return res.status(404).send('Not found');
  upsertStatusNode({id:n.id,name:String(req.body.name || n.name || n.id).trim().slice(0,100),capacity:Math.min(1000,Math.max(1,Number(req.body.capacity)||50)),disabled:req.body.disabled==='1',acceptNewBots:req.body.acceptNewBots==='1'});
  rebalanceAssignments(); flash(req,'ok',l(req,'Node gespeichert.','Node saved.')); res.redirect('/admin?tab=nodes#nodes');
});

app.post('/nodes/:id/restart-all', requireAdmin, checkCsrf, (req,res) => {
  try {
    const result=restartAllBotsOnNode(req.params.id);
    flash(req,'ok',l(req,`${result.restarted} aktive Bots werden neu gestartet.`,`${result.restarted} active bots are being restarted.`));
  } catch(e){ flash(req,'err',e.message); }
  const ref=String(req.get('referer')||'');
  res.redirect(ref.includes('/details')?`/nodes/${encodeURIComponent(req.params.id)}/details`:'/admin?tab=nodes#nodes');
});

app.post('/nodes/:id/drain', requireAdmin, checkCsrf, (req,res) => {
  try { const result=drainStatusNode(req.params.id); flash(req,'ok',l(req,`Node wird gedraint. ${result.released} Bots wurden zur Neuverteilung freigegeben.`,`Node is draining. ${result.released} bots were released for redistribution.`)); }
  catch(e){flash(req,'err',e.message);} res.redirect('/admin?tab=nodes#nodes');
});

app.get('/nodes/:id/details', requireAdmin, (req,res) => {
  const lang=langOf(req); const node=getStatusNode(req.params.id); if(!node)return res.status(404).send('Not found'); const db=readDb();
  const assigned=db.servers.filter((s)=>s.assignedNodeId===node.id); const targets=db.statusNodes.filter((n)=>n.id!==node.id && nodeIsHealthy(n));
  const targetOptions=targets.map((n)=>`<option value="${esc(n.id)}">${esc(n.name||n.id)} · ${db.servers.filter((s)=>s.assignedNodeId===n.id).length}/${esc(n.capacity||0)}</option>`).join('');
  const rows=assigned.map((s)=>{const owner=db.users.find((u)=>u.discordId===s.ownerDiscordId);return `<tr><td><strong>${esc(s.name)}</strong><div class="muted small">${esc(owner?.globalName||owner?.username||s.ownerDiscordId||'')}</div></td><td>${esc(s.gameType==='gamedig'?(gameDigMeta(s.queryConfig?.gameId)?.name||s.queryConfig?.gameId):gameTypeLabel(s.gameType))}</td><td><form method="post" action="/servers/${esc(s.id)}/move-node" class="moveform"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><select name="targetNodeId" required><option value="">${tr(lang,'Ziel auswählen','Select target')}</option>${targetOptions}</select><button class="button ghost smallbtn">${tr(lang,'Verschieben','Move')}</button></form></td></tr>`;}).join('');
  render(req,res,`${node.name||node.id} · ${tr(lang,'Bots','Bots')}`,`<div class="pagehead"><div><h1>${esc(node.name||node.id)}</h1><p>${assigned.length} ${tr(lang,'zugewiesene Status-Bots','assigned status bots')}</p></div><a class="button ghost" href="/nodes">${tr(lang,'Zurück','Back')}</a></div><div class="panel node-actions"><div class="actions wrap"><form method="post" action="/nodes/${esc(node.id)}/restart-all" class="inline" onsubmit="return confirm('${tr(lang,'Alle aktiven Bots auf diesem Node neu starten?','Restart all active bots on this node?')}')"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button primary">${tr(lang,'Alle Bots neu starten','Restart all bots')}</button></form></div><form method="post" action="/nodes/${esc(node.id)}/move-all" class="actions wrap"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><select name="targetNodeId" required><option value="">${tr(lang,'Alle Bots auf Node verschieben …','Move all bots to node …')}</option>${targetOptions}</select><button class="button primary">${tr(lang,'Alle verschieben','Move all')}</button></form></div><div class="panel tablewrap"><table><thead><tr><th>Bot</th><th>Game</th><th>${tr(lang,'Aktion','Action')}</th></tr></thead><tbody>${rows||`<tr><td colspan="3">${tr(lang,'Keine Bots auf diesem Node.','No bots on this node.')}</td></tr>`}</tbody></table></div>`);
});

app.post('/servers/:id/move-node', requireAdmin, checkCsrf, (req,res)=>{
  try { moveServerToNode(req.params.id,String(req.body.targetNodeId||'')); flash(req,'ok',l(req,'Bot verschoben.','Bot moved.')); }
  catch(e){flash(req,'err',e.message);} const from=req.get('referer'); res.redirect(from&&from.startsWith(baseUrl)?from:'/nodes');
});

app.post('/nodes/:id/move-all', requireAdmin, checkCsrf, (req,res)=>{
  try { const result=moveAllFromNode(req.params.id,String(req.body.targetNodeId||'')); flash(req,'ok',l(req,`${result.moved} Bots verschoben.`,`${result.moved} bots moved.`)); }
  catch(e){flash(req,'err',e.message);} res.redirect(`/nodes/${encodeURIComponent(req.params.id)}/details`);
});

app.get('/users', requireAdmin, (req,res) => res.redirect('/admin?tab=users'));

app.post('/users/:id', requireAdmin, checkCsrf, (req,res)=>{
  const old=findUser(req.params.id); if(!old)return res.status(404).send('Not found'); const protectedAdmin=bootstrapAdmins.has(old.discordId); const planId=PLANS[req.body.planId]?req.body.planId:(old.planId||'free'); let planExpiresAt=old.planExpiresAt||null; const durationRaw=String(req.body.planDuration??'').trim();
  if(durationRaw!==''){const amount=Math.min(87600,Math.max(0,Number(durationRaw)||0));const unit=['hours','days','months'].includes(req.body.planDurationUnit)?req.body.planDurationUnit:'days';const multiplier=unit==='hours'?3600_000:unit==='months'?30*86400_000:86400_000;planExpiresAt=amount===0?null:new Date(Date.now()+amount*multiplier).toISOString();}else if(planId!==(old.planId||'free'))planExpiresAt=null;
  const overrideRaw=String(req.body.statusBotLimitOverride??'').trim(); const statusBotLimitOverride=overrideRaw===''?null:Math.min(500,Math.max(0,Number(overrideRaw)||0));
  const goingFree=(old.planId||'free')!=='free'&&planId==='free'; const freeRenewExempt=req.body.freeRenewExempt==='1'; const renewExemptionRemoved=Boolean(old.freeRenewExempt)&&!freeRenewExempt;
  upsertUser({discordId:old.discordId,role:protectedAdmin?'admin':(req.body.role==='admin'?'admin':'user'),planId,planExpiresAt,statusBotLimitOverride,customBotLimit:Math.min(50,Math.max(0,Number(req.body.customBotLimit)||0)),freeRenewExempt,freeRenewedAt:renewExemptionRemoved?new Date().toISOString():old.freeRenewedAt,freeRenewGraceStartedAt:freeRenewExempt||renewExemptionRemoved?null:old.freeRenewGraceStartedAt,premiumSource:null});
  if(goingFree) markPremiumDowngrade(old.discordId); else if(planId!=='free') upsertUser({discordId:old.discordId,premiumDowngradeStartedAt:null,premiumDowngradeUntil:null,premiumDowngradeKeepServerId:null});
  runLifecycleSweep(); rebalanceAssignments(); flash(req,'ok',l(req,'Benutzerplan und Freigaben gespeichert.','User plan and permissions saved.')); res.redirect('/admin?tab=users#users');
});

app.post('/users/:id/delete', requireAdmin, checkCsrf, (req,res)=>{if(bootstrapAdmins.has(req.params.id)){flash(req,'err',l(req,'.env Admin kann nicht entfernt werden.','.env admin cannot be removed.'));return res.redirect('/admin?tab=users#users');}if(req.params.id===currentUser(req).discordId){flash(req,'err',l(req,'Eigenen Account nicht entfernen.','Do not remove your own account.'));return res.redirect('/admin?tab=users#users');}deleteUser(req.params.id);rebalanceAssignments();flash(req,'ok',l(req,'Benutzer entfernt.','User removed.'));res.redirect('/admin?tab=users#users');});

app.get('/admin/bot-services', requireAdmin, (req,res) => { const q = new URLSearchParams(); q.set('tab','services'); if (req.query.edit) q.set('edit', String(req.query.edit)); res.redirect(`/admin?${q}`); });

app.post('/admin/bot-services', requireAdmin, checkCsrf, (req,res) => {
  const id=String(req.body.id||'').trim(); const old=id?getBotService(id):null;
  const nameDe=String(req.body.nameDe||'').trim(); const nameEn=String(req.body.nameEn||'').trim();
  if(!nameDe||!nameEn){flash(req,'err',l(req,'Name fehlt.','Name is required.'));return res.redirect('/admin?tab=services#services');}
  const url=(value)=>{const v=String(value||'').trim();return /^https?:\/\//i.test(v)?v.slice(0,500):'';};
  const lines=(value)=>String(value||'').split(/\r?\n/).map((x)=>x.trim()).filter(Boolean).slice(0,20).map((x)=>x.slice(0,160));
  const status=['coming_soon','available','paused'].includes(req.body.status)?req.body.status:'coming_soon';
  const slug=(old?.slug||nameEn.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,80)||`service-${Date.now()}`);
  upsertBotService({id:old?.id,slug,nameDe:nameDe.slice(0,100),nameEn:nameEn.slice(0,100),descriptionDe:String(req.body.descriptionDe||'').trim().slice(0,800),descriptionEn:String(req.body.descriptionEn||'').trim().slice(0,800),featuresDe:lines(req.body.featuresDe),featuresEn:lines(req.body.featuresEn),priceLabel:String(req.body.priceLabel||'').trim().slice(0,60),status,purchaseUrl:url(req.body.purchaseUrl),supportUrl:url(req.body.supportUrl),visible:req.body.visible==='1',featured:req.body.featured==='1',sortOrder:Math.max(0,Math.min(9999,Number(req.body.sortOrder)||10))});
  flash(req,'ok',l(req,'Bot Service gespeichert.','Bot service saved.')); res.redirect('/admin?tab=services#services');
});

app.post('/admin/bot-services/:id/delete', requireAdmin, checkCsrf, (req,res) => { deleteBotService(req.params.id); flash(req,'ok',l(req,'Bot Service gelöscht.','Bot service deleted.')); res.redirect('/admin?tab=services#services'); });

app.get('/admin/settings', requireAdmin, (req,res) => res.redirect('/admin?tab=settings'));

function saveAdminSettingsFromBody(req) {
  const current=getSiteSettings();
  const cleanDomain=String(req.body.serviceDomain||'status-hub.lol').trim().replace(/^https?:\/\//i,'').replace(/\/+$/,'').slice(0,120) || 'status-hub.lol';
  const oldDiscord=current.discordOAuth||{};
  let discordClientId=String(req.body.discordClientId??oldDiscord.clientId??process.env.DISCORD_OAUTH_CLIENT_ID??'').trim().slice(0,100);
  let discordClientSecretEnc=String(oldDiscord.clientSecretEnc||'');
  const discordNewSecret=String(req.body.discordClientSecret||'').trim();
  if(req.body.discordClearCredentials==='1'){discordClientId='';discordClientSecretEnc='';}
  else if(discordNewSecret) discordClientSecretEnc=encryptSecret(discordNewSecret.slice(0,500));
  const discordOAuth={enabled:req.body.discordOAuthEnabled==='1',allowRegistration:req.body.discordAllowRegistration==='1',clientId:discordClientId,clientSecretEnc:discordClientSecretEnc};
  const defaults={2:50,3:100,4:250,5:500};
  const values=[2,3,4,5].map((limit)=>({limit,members:Math.max(1,Number(req.body[`tier${limit}`])||defaults[limit])})).sort((a,b)=>a.members-b.members);
  const teamDiscordIds=String(req.body.teamDiscordIds||'').split(',').map((x)=>x.trim()).filter((x)=>validSnowflake(x)).slice(0,25);
  const currency=/^[A-Za-z]{3}$/.test(String(req.body.paypalCurrency||''))?String(req.body.paypalCurrency).toUpperCase():'EUR';
  const oldAuto=paypalAutoConfig(current); const oldSub=paypalSubscriptionConfig(current); const oldApi=current.premiumSales?.paypalApi||{};
  const mode=String(req.body.paypalMode||oldApi.mode||'sandbox').toLowerCase()==='live'?'live':'sandbox';
  let clientId=String(req.body.paypalClientId??oldApi.clientId??'').trim().slice(0,300);
  let clientSecretEnc=String(oldApi.clientSecretEnc||'');
  const newSecret=String(req.body.paypalClientSecret||'').trim(); const clearCredentials=req.body.paypalClearCredentials==='1';
  if(clearCredentials){clientId='';clientSecretEnc='';}
  else if(newSecret) clientSecretEnc=encryptSecret(newSecret.slice(0,500));
  const credentialsChanged=clearCredentials||Boolean(newSecret)||mode!==String(oldApi.mode||'sandbox')||clientId!==String(oldApi.clientId||'');
  const updated=updateSiteSettings({serviceDomain:cleanDomain,discordOAuth,supportUrl:String(req.body.supportUrl||'').trim().slice(0,500),teamDiscordIds,donationLinks:{paypal:String(req.body.paypal||'').trim().slice(0,500),kofi:String(req.body.kofi||'').trim().slice(0,500),stripe:String(req.body.stripe||'').trim().slice(0,500),customUrl:String(req.body.customUrl||'').trim().slice(0,500),customLabel:String(req.body.customLabel||'').trim().slice(0,80)},premiumSales:{paypalUrl:String(req.body.premiumPaypalUrl||'').trim().slice(0,500),discordUserId:validSnowflake(req.body.salesDiscordUserId)?String(req.body.salesDiscordUserId).trim():'',discordUsername:String(req.body.salesDiscordUsername||'').trim().slice(0,80),prices:{premium5:String(req.body.pricePremium5||'').trim().slice(0,60),premium10:String(req.body.pricePremium10||'').trim().slice(0,60),premium15:String(req.body.pricePremium15||'').trim().slice(0,60),premium20:String(req.body.pricePremium20||'').trim().slice(0,60)},paypalApi:{mode,clientId,clientSecretEnc},paypalAuto:{enabled:req.body.paypalAutoEnabled==='1',currency,accessDays:Math.max(1,Math.min(3650,Number(req.body.paypalAccessDays)||30)),webhookId:credentialsChanged?'':(oldAuto.webhookId||''),amounts:{premium5:normalizedMoney(req.body.paypalAmountPremium5),premium10:normalizedMoney(req.body.paypalAmountPremium10),premium15:normalizedMoney(req.body.paypalAmountPremium15),premium20:normalizedMoney(req.body.paypalAmountPremium20)}},paypalSubscription:{enabled:req.body.paypalSubscriptionEnabled==='1',productId:credentialsChanged?'':(oldSub.productId||''),planIds:credentialsChanged?{}:(oldSub.planIds||{}),planMeta:credentialsChanged?{}:(oldSub.planMeta||{}),amounts:{premium5:normalizedMoney(req.body.paypalSubAmountPremium5),premium10:normalizedMoney(req.body.paypalSubAmountPremium10),premium15:normalizedMoney(req.body.paypalSubAmountPremium15),premium20:normalizedMoney(req.body.paypalSubAmountPremium20)}}},freeBoost:{categoryName:String(req.body.categoryName||'Powered by status-hub.lol').trim().slice(0,100),verifyHours:Math.max(1,Math.min(48,Number(req.body.verifyHours)||6)),tiers:values}});
  recalculateStoredFreeBoostLimits(updated);
  rebalanceAssignments();
  return updated;
}

app.post('/admin/settings', requireAdmin, checkCsrf, (req,res) => {
  saveAdminSettingsFromBody(req);
  flash(req,'ok',l(req,'Einstellungen gespeichert.','Settings saved.'));
  res.redirect('/admin?tab=settings#settings');
});

app.post('/admin/discord/test', requireAdmin, checkCsrf, rateLimit({ windowMs: 60_000, limit: 10 }), (req,res) => {
  const settings=saveAdminSettingsFromBody(req);
  const oauth=discordOAuthConfig(settings);
  if(!oauth.enabled){flash(req,'err',l(req,'Discord Login ist deaktiviert.','Discord login is disabled.'));return res.redirect('/admin?tab=settings#settings');}
  if(!oauth.configured){flash(req,'err',l(req,'Discord Client ID oder Client Secret fehlen.','Discord Client ID or Client Secret is missing.'));return res.redirect('/admin?tab=settings#settings');}
  req.session.oauthReturnTo='/admin?tab=settings#settings';
  res.redirect('/auth/discord');
});

app.post('/admin/paypal/setup', requireAdmin, checkCsrf, rateLimit({ windowMs: 60_000, limit: 5 }), async (req,res) => {
  try {
    const settings=saveAdminSettingsFromBody(req);
    if (!paypalConfigured(settings)) throw new Error(l(req,'PayPal Client ID oder Client Secret fehlen in den Admin-Einstellungen.','PayPal Client ID or Client Secret is missing in the admin settings.'));
    const auto=paypalAutoConfig(settings);
    const sub=paypalSubscriptionConfig(settings);
    const webhook=await ensureWebhook(auto.webhookId,`${baseUrl}/webhooks/paypal`,settings);
    let subPatch={};
    if(sub.enabled){
      const catalog=await ensureSubscriptionCatalog({productId:sub.productId,planIds:sub.planIds,planMeta:sub.planMeta,amounts:sub.amounts,currency:sub.currency,settings});
      subPatch={paypalSubscription:{...sub,...catalog}};
    }
    updateSiteSettings({premiumSales:{paypalAuto:{enabled:true,webhookId:webhook.id},...subPatch}});
    flash(req,'ok',l(req,`PayPal ${paypalEnvironment(settings)} verbunden. Webhook und monatliche Abo-Pläne wurden eingerichtet.`,`PayPal ${paypalEnvironment(settings)} connected. Webhook and monthly subscription plans were set up.`));
  } catch(error) { flash(req,'err',`PayPal: ${error.message}`); }
  res.redirect('/admin?tab=settings#settings');
});

app.post('/admin/supporters', requireAdmin, checkCsrf, (req,res) => {
  const name=String(req.body.displayName||'').trim(); if(!name){flash(req,'err',l(req,'Anzeigename fehlt.','Display name is required.'));return res.redirect('/admin?tab=settings#settings');}
  upsertSupporter({displayName:name.slice(0,80),amountLabel:String(req.body.amountLabel||'').trim().slice(0,40),message:'',link:String(req.body.link||'').trim().slice(0,500),featured:req.body.featured==='1',visible:req.body.visible==='1'});
  flash(req,'ok',l(req,'Supporter hinzugefügt.','Supporter added.')); res.redirect('/admin?tab=settings#settings');
});

app.post('/admin/supporters/:id/delete', requireAdmin, checkCsrf, (req,res) => { deleteSupporter(req.params.id); flash(req,'ok',l(req,'Supporter entfernt.','Supporter removed.')); res.redirect('/admin?tab=settings#settings'); });

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) { flash(req,'err',`Upload fehlgeschlagen: ${err.message}`); return res.redirect('/custom-bots/new'); }
  console.error(err); res.status(500).send('Interner Fehler');
});
app.use((req,res)=>res.status(404).send('Nicht gefunden'));

const httpServer = app.listen(port, async () => {
  console.log(`status-hub.lol: ${baseUrl}`); console.log(`Discord OAuth Redirect URI: ${redirectUri}`);
  try { runLifecycleSweep(); rebalanceAssignments(); } catch (e) { console.error('Status-Node-Zuweisung:',e); }
  setTimeout(async () => {
    for (const b of readDb().customBots.filter((x)=>x.approvalState==='approved' && x.enabled)) {
      try { await ensureCustomBot(b); } catch (e) { console.error(`Custom Bot ${b.id}:`, e.message); }
    }
  }, 3000).unref();
  setInterval(() => { try { rebalanceAssignments(); } catch (e) { console.error('Status-Node-Rebalance:', e.message); } }, 10_000).unref();
  setInterval(() => { try { const r=runLifecycleSweep(); if(r.premiumDeleted||r.renewDeleted||r.premiumGraceStarted||r.renewGraceStarted) rebalanceAssignments(); } catch (e) { console.error('Lifecycle:', e.message); } }, 60_000).unref();
  setTimeout(() => { refreshDueFreeBoosts().then(()=>rebalanceAssignments()).catch(()=>{}); }, 5000).unref();
  setInterval(() => { refreshDueFreeBoosts().then(()=>rebalanceAssignments()).catch(()=>{}); }, 15 * 60_000).unref();
});
async function shutdown(signal){console.log(`\n${signal}: fahre herunter...`);httpServer.close(()=>process.exit(0));setTimeout(()=>process.exit(1),5000).unref();}
process.on('SIGINT',()=>shutdown('SIGINT')); process.on('SIGTERM',()=>shutdown('SIGTERM'));
