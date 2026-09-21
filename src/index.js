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
  getManagedBot, getManagedBotForUserService, getManagedBotByAccessRecord, listManagedBotsForUserService, listManagedBotsAccessibleToUserService, listManagedBotsFor, listManagedBotsAccessibleFor, upsertManagedBot, deleteManagedBot, listBanSyncServers, getBanSyncServer,
  listStatusNodes, getStatusNode, upsertStatusNode, deleteStatusNode, getSiteSettings, updateSiteSettings,
  listSupporters, upsertSupporter, deleteSupporter, listBotServices, getBotService, upsertBotService, deleteBotService,
  createPaypalPurchase, getPaypalPurchase, getPaypalPurchaseByOrder, updatePaypalPurchase, rememberPaypalWebhookEvent, paypalWebhookEventSeen,
  createPaypalSubscriptionRecord, getPaypalSubscriptionRecord, getPaypalSubscriptionByPaypalId, listPaypalSubscriptionsForUser, updatePaypalSubscriptionRecord,
  createPaypalServiceSubscriptionRecord, getPaypalServiceSubscriptionRecord, getPaypalServiceSubscriptionByPaypalId, listPaypalServiceSubscriptionsForUser, updatePaypalServiceSubscriptionRecord,
  createStripePurchase, getStripePurchase, getStripePurchaseBySession, updateStripePurchase, createStripeSubscriptionRecord, getStripeSubscriptionRecord, getStripeSubscriptionByStripeId, getStripeSubscriptionBySession, listStripeSubscriptionsForUser, updateStripeSubscriptionRecord, rememberStripeWebhookEvent, stripeWebhookEventSeen
} from './db.js';
import { encryptSecret, decryptSecret } from './crypto.js';
import { fetchServerStatus, gameTypeLabel } from './server-query.js';
import { esc, layout, serverForm, customBotForm, gamesPage } from './html.js';
import { tr, normalizeLang, localeCode } from './i18n.js';
import { FileSessionStore } from './file-session-store.js';
import { prepareCustomBot, parseEnvText, deleteCustomBotFiles, listCustomBotFiles, resolveCustomBotFile, overlayCustomBotFiles } from './custom-bots.js';
import { ensureCustomBot, restartCustomBot, stopCustomBot, deleteCustomBotRuntime, customBotStatus, customBotLogs } from './runner-client.js';
import { managedBotRuntime, parseManagedRules, testManagedWardogs, syncManagedBots, restartManagedBot, stopManagedBot, shutdownManagedBots, managedDashboard, managedMapOptions, MANAGED_DISCORD_PERMISSION_KEYS, broadcastManaged, banManagedPlayer, temporaryBanManagedPlayer, kickManagedPlayer, killManagedPlayer, whisperManagedPlayer, whisperManagedFaction, moveManagedPlayer, unbanManagedPlayer, addManagedReservedSlot, removeManagedReservedSlot, restartManagedMatch, endManagedMatch, setManagedLighting, changeManagedMap, normalizeSteamId64, normalizeManagedBanDiscordLink, formatManagedBanDuration, requestManagedBanSync, acceptManagedBanSync, rejectManagedBanSync, syncManagedBanSnapshot, createManagedBanSyncServer, joinManagedBanSyncServer, leaveManagedBanSyncServer, resyncManagedBanSyncServer, updateManagedBanSyncCommunitySettings, appendManagedAudit, restoreManagedDynamicServerName } from './managed-bots.js';
import { playtimeBotRuntime, syncPlaytimeBots, restartPlaytimeBot, stopPlaytimeBot, shutdownPlaytimeBots, testPlaytimeWardogs, refreshPlaytimeTracker, playtimeTrackerSnapshot, playtimeTrackerServers, combinedStatsSnapshot, searchCombinedPlayers, leaderboardPositions, HEADSHOT_RATE_MIN_KILLS, PLAYTIME_SERVICE_ID } from './playtime-tracker.js';
import { KILL_STATS_SERVICE_ID, killStatsBotRuntime, syncKillStatsBots, restartKillStatsBot, stopKillStatsBot, shutdownKillStatsBots, testKillStatsWardogs, refreshKillStatsDiscord, killStatsSnapshot, searchKillStatsPlayer, managementKillFeed, prettyCause, configureWardogsKillFeed, configureWardogsPlaytimeKillFeed, configureWardogsManagementFeed, ingestWardogsKillFeed, killStatsSnapshotFromStats, searchKillStatsSnapshot } from './kill-stats.js';
import { normalizeManagedServers, managedServerContext, managedServerContexts, newManagedServerRow } from './managed-servers.js';
import { readManagedChatPage } from './managed-chat.js';
import { wardogsAuthLockedMessage } from './wardogs-auth.js';
import { createStatusStatsDocx } from './stats-docx.js';
import { gameDigMeta, gameDigFieldDefs } from './game-catalog.js';
import { PLANS, effectivePlan } from './plans.js';
import { registerStatusNode, authenticateStatusNode, heartbeatStatusNode, materializeWorkForNode, rebalanceAssignments, clusterRuntime, nodeIsHealthy, leaseSeconds, moveServerToNode, moveAllFromNode, drainStatusNode, restartAllBotsOnNode } from './cluster.js';
import { verifyFreeBoostForUser, refreshDueFreeBoosts, freeBoostRanges, recalculateStoredFreeBoostLimits } from './free-boost.js';
import { paypalConfigured, paypalEnvironment, paypalCredentialState, createCheckoutOrder, getCheckoutOrder, captureCheckoutOrder, extractCompletedCapture, verifyWebhook, ensureWebhook, ensureSubscriptionCatalog, ensureManagedServiceSubscriptionPlan, createSubscription, getSubscription, cancelSubscription } from './paypal.js';
import { stripeConfigured, stripeCredentialState, testStripeConnection, createStripeCheckout, retrieveStripeCheckout, retrieveStripeSubscription, cancelStripeSubscriptionAtPeriodEnd, verifyStripeWebhook, ensureStripeWebhook } from './stripe.js';
import { runLifecycleSweep, renewFreeAccess, freeRenewState, markPremiumDowngrade, FREE_RENEW_DAYS, GRACE_DAYS } from './lifecycle.js';

const required = ['SESSION_SECRET', 'APP_ENCRYPTION_KEY', 'STATUS_NODE_JOIN_SECRET'];
for (const key of required) if (!process.env[key]) throw new Error(`${key} fehlt in .env`);

const app = express();
const port = Number(process.env.PORT || 3000);
const baseUrl = String(process.env.PUBLIC_URL || '').replace(/\/+$/, '');
if (!/^https?:\/\//i.test(baseUrl)) throw new Error('PUBLIC_URL muss mit http:// oder https:// beginnen');
const redirectUri = `${baseUrl}/auth/discord/callback`;
const secureCookie = process.env.COOKIE_SECURE === 'true' || baseUrl.startsWith('https://');
const sessionCookieName = secureCookie ? '__Host-serverhub.sid' : 'serverhub.sid';
const adminIpAllowlist = new Set(String(process.env.ADMIN_IP_ALLOWLIST || '').split(',').map((x) => x.trim()).filter(Boolean));
const bootstrapAdmins = new Set((process.env.ADMIN_DISCORD_IDS || '').split(',').map((x) => x.trim()).filter(Boolean));
const firstAdmin = [...bootstrapAdmins][0] || '';
const uploadMaxMb = Math.min(25, Math.max(1, Number(process.env.CUSTOM_UPLOAD_MAX_MB || 25)));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: uploadMaxMb * 1024 * 1024, files: 1, fields: 8, parts: 10, fieldSize: 256 * 1024 } });
function customBotUpload(req, res, next) {
  upload.single('archive')(req, res, (err) => {
    if (!err) return next();
    const code = err instanceof multer.MulterError ? err.code : '';
    const message = code === 'LIMIT_FILE_SIZE'
      ? l(req, `Upload zu groß. Maximal ${uploadMaxMb} MB ZIP erlaubt.`, `Upload too large. Maximum ZIP size is ${uploadMaxMb} MB.`)
      : l(req, `ZIP-Upload fehlgeschlagen: ${String(err.message || err).slice(0, 180)}`, `ZIP upload failed: ${String(err.message || err).slice(0, 180)}`);
    flash(req, 'err', message);
    return res.redirect('/custom-bots/new');
  });
}

const customFilesUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: uploadMaxMb * 1024 * 1024, files: 20, fields: 5, parts: 30, fieldSize: 32 * 1024 } });
function customBotLooseFilesUpload(req, res, next) {
  customFilesUpload.array('files', 20)(req, res, (err) => {
    if (!err) return next();
    const code = err instanceof multer.MulterError ? err.code : '';
    const message = code === 'LIMIT_FILE_SIZE'
      ? l(req, `Datei zu groß. Maximal ${uploadMaxMb} MB pro Datei.`, `File too large. Maximum ${uploadMaxMb} MB per file.`)
      : l(req, `Datei-Upload fehlgeschlagen: ${String(err.message || err).slice(0, 180)}`, `File upload failed: ${String(err.message || err).slice(0, 180)}`);
    flash(req, 'err', message);
    return res.redirect(`/custom-bots/${encodeURIComponent(req.params.id)}/files`);
  });
}
function customBotOverlayZipUpload(req, res, next) {
  customFilesUpload.single('archive')(req, res, (err) => {
    if (!err) return next();
    const code = err instanceof multer.MulterError ? err.code : '';
    const message = code === 'LIMIT_FILE_SIZE'
      ? l(req, `ZIP zu groß. Maximal ${uploadMaxMb} MB.`, `ZIP too large. Maximum ${uploadMaxMb} MB.`)
      : l(req, `ZIP-Upload fehlgeschlagen: ${String(err.message || err).slice(0, 180)}`, `ZIP upload failed: ${String(err.message || err).slice(0, 180)}`);
    flash(req, 'err', message);
    return res.redirect(`/custom-bots/${encodeURIComponent(req.params.id)}/files`);
  });
}

const managedConfigUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 256 * 1024, files: 1, fields: 4, parts: 6, fieldSize: 16 * 1024 } });
function managedConfigFile(req, res, next) {
  managedConfigUpload.single('config')(req, res, (err) => {
    if (!err) return next();
    flash(req, 'err', l(req, `Config-Import fehlgeschlagen: ${String(err.message || err).slice(0, 180)}`, `Config import failed: ${String(err.message || err).slice(0, 180)}`));
    return res.redirect(String(req.get('referer') || '/bot-services'));
  });
}

assignLegacyOwnership(firstAdmin);

const trustProxy = process.env.TRUST_PROXY === 'true';
if (trustProxy) app.set('trust proxy', 1);
app.disable('x-powered-by');
const securityRateLimit = (name, windowMs, limit, extra = {}) => rateLimit({
  windowMs, limit, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
  ...extra
});
const skipInfrastructureLimits = (req) => req.path === '/healthz' || req.path === '/api/ingest/events' || req.path.startsWith('/webhooks/') || req.path.startsWith('/api/status-nodes/');
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: secureCookie ? [] : null
    }
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'no-referrer' },
  hsts: secureCookie ? { maxAge: 15552000, includeSubDomains: false, preload: false } : false
}));
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), usb=(), bluetooth=(), browsing-topics=()');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  next();
});
app.use(express.json({ limit: '256kb', verify: (req, res, buf) => { if (req.originalUrl === '/webhooks/stripe') req.rawBody = Buffer.from(buf); } }));
app.use(express.urlencoded({ extended: false, limit: '128kb', parameterLimit: 300 }));
app.use(express.static('public', { maxAge: 0, etag: true, dotfiles: 'deny', fallthrough: true }));
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});
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
app.use(securityRateLimit('global', 10 * 60 * 1000, Number(process.env.SECURITY_GLOBAL_LIMIT || 1200), { skip: skipInfrastructureLimits }));
app.use(securityRateLimit('writes', 5 * 60 * 1000, Number(process.env.SECURITY_WRITE_LIMIT || 180), {
  skip: (req) => skipInfrastructureLimits(req) || ['GET','HEAD','OPTIONS'].includes(req.method)
}));
app.use(session({
  store: new FileSessionStore({ file: 'data/sessions.json' }),
  name: sessionCookieName, secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false, rolling: true,
  proxy: trustProxy,
  cookie: { httpOnly: true, sameSite: 'lax', secure: secureCookie, priority: 'high', path: '/', maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

function csrf(req) { if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('base64url'); return req.session.csrf; }
function allowedRequestOrigin(req, rawOrigin) {
  const value = String(rawOrigin || '').trim();
  // Origin is a defence-in-depth check on top of the mandatory per-session CSRF
  // token. Some browsers/privacy modes can legitimately send Origin: null.
  if (!value || value === 'null') return true;
  try {
    const candidate = new URL(value);
    if (!['http:', 'https:'].includes(candidate.protocol)) return false;

    // Compare only against the configured PUBLIC_URL. Do not compare the browser
    // Origin with req.get('host'): behind Caddy/another reverse proxy that Host can
    // legitimately be an internal container host even though the public browser
    // origin is correct. CSRF remains mandatory below.
    if (candidate.hostname.toLowerCase() !== canonical.hostname.toLowerCase()) return false;

    const canonicalPort = canonical.port || (canonical.protocol === 'https:' ? '443' : '80');
    const candidatePort = candidate.port || (candidate.protocol === 'https:' ? '443' : '80');
    // If PUBLIC_URL explicitly includes a non-standard port, require it. With the
    // normal 80/443 public setup, allow an HTTPS browser origin in front of an
    // older http:// PUBLIC_URL configuration used behind TLS termination.
    if (canonical.port && candidatePort !== canonicalPort) return false;
    if (!canonical.port && candidate.port && !['80', '443'].includes(candidatePort)) return false;
    if (canonical.protocol === 'https:' && candidate.protocol !== 'https:') return false;
    return true;
  } catch {
    return false;
  }
}
function checkCsrf(req, res, next) {
  const origin = String(req.get('origin') || '').trim();
  if (!allowedRequestOrigin(req, origin)) return res.status(403).send('Ungültige Request-Origin.');
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
function requireAdmin(req, res, next) { const u = currentUser(req); if (!u) return res.redirect('/login'); if (u.role !== 'admin') return res.status(403).send('Keine Berechtigung'); const ip=String(req.ip||'').replace(/^::ffff:/,''); if (adminIpAllowlist.size && !adminIpAllowlist.has(ip)) return res.status(403).send('Admin access is not allowed from this IP.'); next(); }
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
function stripeAutoConfig(settings = getSiteSettings()) {
  const raw = settings.premiumSales?.stripeAuto || {};
  const currency = /^[A-Z]{3}$/.test(String(raw.currency || '').toUpperCase()) ? String(raw.currency).toUpperCase() : 'EUR';
  const accessDays = Math.max(1, Math.min(3650, Number(raw.accessDays) || 30));
  const amounts = {};
  for (const id of ['premium5','premium10','premium15','premium20']) amounts[id] = normalizedMoney(raw.amounts?.[id]);
  return { enabled: raw.enabled === true, currency, accessDays, amounts };
}
function stripeSubscriptionConfig(settings = getSiteSettings()) {
  const raw = settings.premiumSales?.stripeSubscription || {};
  const currency = stripeAutoConfig(settings).currency;
  const amounts = {};
  for (const id of ['premium5','premium10','premium15','premium20']) amounts[id] = normalizedMoney(raw.amounts?.[id]);
  return { enabled: raw.enabled !== false, currency, amounts };
}
function stripeAutoReady(settings = getSiteSettings(), planId = '') {
  const cfg = stripeAutoConfig(settings);
  if (!cfg.enabled || !stripeConfigured(settings)) return false;
  return planId ? Boolean(cfg.amounts[planId]) : Object.values(cfg.amounts).some(Boolean);
}
function stripeSubscriptionReady(settings = getSiteSettings(), planId = '') {
  const cfg = stripeSubscriptionConfig(settings);
  if (!cfg.enabled || !stripeConfigured(settings)) return false;
  return planId ? Boolean(cfg.amounts[planId]) : Object.values(cfg.amounts).some(Boolean);
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
  if (fresh.cancelledAt) return updatePaypalSubscriptionRecord(fresh.id, { remoteStatus: status, lastSyncAt: new Date().toISOString() });
  if (!['ACTIVE','APPROVED'].includes(status)) return updatePaypalSubscriptionRecord(fresh.id, { status, lastSyncAt: new Date().toISOString() });
  const hasConfirmedPayment = Boolean(details?.billing_info?.last_payment?.time) || reason === 'recurring_payment';
  if (!hasConfirmedPayment) return updatePaypalSubscriptionRecord(fresh.id, { status: 'ACTIVE_PENDING_PAYMENT', subscriptionId: fresh.subscriptionId || details?.id || '', nextBillingAt: details?.billing_info?.next_billing_time || null, lastSyncAt: new Date().toISOString() });
  const expiresAt = subscriptionEntitlementExpiry(details);
  upsertUser({ discordId: user.discordId, planId: fresh.planId, planExpiresAt: expiresAt, premiumSource: { provider: 'paypal_subscription', recordId: fresh.id, subscriptionId: fresh.subscriptionId || details?.id || '', reason }, premiumDowngradeStartedAt: null, premiumDowngradeUntil: null, premiumDowngradeKeepServerId: null, freeRenewGraceStartedAt: null });
  const updated = updatePaypalSubscriptionRecord(fresh.id, { status: 'ACTIVE', subscriptionId: fresh.subscriptionId || details?.id || '', nextBillingAt: details?.billing_info?.next_billing_time || null, entitlementExpiresAt: expiresAt, activatedAt: fresh.activatedAt || new Date().toISOString(), lastSyncAt: new Date().toISOString() });
  rebalanceAssignments();
  return updated;
}
async function stopCancelledPaypalSubscription(record, details, settings = getSiteSettings()) {
  if (!record?.cancelledAt) return false;
  const subscriptionId = String(record.subscriptionId || details?.id || '');
  const remoteStatus = String(details?.status || '').toUpperCase();
  const terminal = ['CANCELLED','EXPIRED'].includes(remoteStatus);
  if (subscriptionId && !terminal) {
    try {
      await cancelSubscription(subscriptionId, 'Cancelled earlier by customer from status-hub.lol', settings);
      updatePaypalSubscriptionRecord(record.id, { status: 'CANCELLED', remoteStatus: remoteStatus || null, remoteCancelError: null, lastSyncAt: new Date().toISOString() });
    } catch (error) {
      updatePaypalSubscriptionRecord(record.id, { remoteStatus: remoteStatus || null, remoteCancelError: String(error.message || error).slice(0,500), lastSyncAt: new Date().toISOString() });
      console.error(`PayPal cancelled-subscription guard (${subscriptionId}):`, error.message);
    }
  } else {
    updatePaypalSubscriptionRecord(record.id, { remoteStatus: remoteStatus || null, lastSyncAt: new Date().toISOString() });
  }
  return true;
}
function applyPaypalServiceSubscription(record, details, reason = 'service_subscription') {
  const fresh = getPaypalServiceSubscriptionRecord(record?.id || '');
  if (!fresh) throw new Error('PayPal bot-service subscription record not found');
  const user = findUser(fresh.userDiscordId);
  const service = getBotService(fresh.serviceId);
  if (!user || !service) throw new Error('Bot service or user no longer exists');
  const status = String(details?.status || fresh.status || '').toUpperCase();
  if (fresh.cancelledAt) return updatePaypalServiceSubscriptionRecord(fresh.id, { remoteStatus: status, lastSyncAt: new Date().toISOString() });
  if (fresh.paypalPlanId && details?.plan_id && String(details.plan_id) !== String(fresh.paypalPlanId)) throw new Error('PayPal bot-service plan mismatch');
  if (!['ACTIVE','APPROVED'].includes(status)) return updatePaypalServiceSubscriptionRecord(fresh.id, { status, lastSyncAt: new Date().toISOString() });
  const hasConfirmedPayment = Boolean(details?.billing_info?.last_payment?.time) || reason === 'recurring_payment';
  if (!hasConfirmedPayment) return updatePaypalServiceSubscriptionRecord(fresh.id, { status: 'ACTIVE_PENDING_PAYMENT', subscriptionId: fresh.subscriptionId || details?.id || '', nextBillingAt: details?.billing_info?.next_billing_time || null, lastSyncAt: new Date().toISOString() });
  const expiresAt = subscriptionEntitlementExpiry(details);
  let bot = getManagedBotByAccessRecord(fresh.id);
  if (!bot) {
    // One PayPal service subscription owns exactly one managed-bot instance.
    // This makes recurring webhooks idempotent while allowing the same user
    // to purchase the same service multiple times.
    const existingInstances = managedOwnedServicesForUser(user.discordId, service.id);
    const instanceNumber = existingInstances.length + 1;
    bot = upsertManagedBot({
      ownerDiscordId: user.discordId,
      serviceId: service.id,
      name: `${service.nameDe || service.nameEn || 'Managed Bot'} #${instanceNumber}`,
      enabled: false,
      autoBanEnabled: false,
      welcomeWhisperEnabled: false,
      welcomeWhisperMessage: 'Hello {player}, welcome to the server! Join our Discord.',
      pollSeconds: service.id === PLAYTIME_SERVICE_ID ? 30 : 20,
      rulesText: '',
      statsTimezone: 'Europe/Vienna',
      adminGrant: false,
      accessSource: 'paypal_subscription',
      accessRecordId: fresh.id
    });
  }
  upsertManagedBot({ id: bot.id, accessSource: 'paypal_subscription', accessRecordId: fresh.id, accessUntil: expiresAt, adminGrant: false });
  rebalanceAssignments();
  const updated = updatePaypalServiceSubscriptionRecord(fresh.id, { status: 'ACTIVE', subscriptionId: fresh.subscriptionId || details?.id || '', nextBillingAt: details?.billing_info?.next_billing_time || null, entitlementExpiresAt: expiresAt, activatedAt: fresh.activatedAt || new Date().toISOString(), lastSyncAt: new Date().toISOString() });
  syncAllServiceBots().catch((error) => console.error('Managed bot sync:', error.message));
  return updated;
}
async function stopCancelledPaypalServiceSubscription(record, details, settings = getSiteSettings()) {
  if (!record?.cancelledAt) return false;
  const subscriptionId = String(record.subscriptionId || details?.id || '');
  const remoteStatus = String(details?.status || '').toUpperCase();
  const terminal = ['CANCELLED','EXPIRED'].includes(remoteStatus);
  if (subscriptionId && !terminal) {
    try {
      await cancelSubscription(subscriptionId, 'Cancelled earlier by customer from status-hub.lol', settings);
      updatePaypalServiceSubscriptionRecord(record.id, { status: 'CANCELLED', remoteStatus: remoteStatus || null, remoteCancelError: null, lastSyncAt: new Date().toISOString() });
    } catch (error) {
      updatePaypalServiceSubscriptionRecord(record.id, { remoteStatus: remoteStatus || null, remoteCancelError: String(error.message || error).slice(0,500), lastSyncAt: new Date().toISOString() });
      console.error(`PayPal cancelled service-subscription guard (${subscriptionId}):`, error.message);
    }
  } else updatePaypalServiceSubscriptionRecord(record.id, { remoteStatus: remoteStatus || null, lastSyncAt: new Date().toISOString() });
  return true;
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
function serviceSubscriptionFromPaypalEvent(event) {
  const resource = event?.resource || {};
  const directId = String(resource.id || '');
  if (directId) {
    const direct = getPaypalServiceSubscriptionByPaypalId(directId);
    if (direct) return direct;
  }
  const billingId = String(resource.billing_agreement_id || resource?.supplementary_data?.related_ids?.subscription_id || '');
  if (billingId) {
    const byBilling = getPaypalServiceSubscriptionByPaypalId(billingId);
    if (byBilling) return byBilling;
  }
  const customId = String(resource.custom_id || '');
  if (customId) {
    const byRecord = getPaypalServiceSubscriptionRecord(customId);
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
function stripeExpiryFromSubscription(details, fallbackMs = 32 * 86400_000) {
  const end = Number(details?.current_period_end || 0) * 1000;
  return new Date(end > Date.now() ? end : Date.now() + fallbackMs).toISOString();
}
function applyStripePurchase(purchase, session) {
  runLifecycleSweep();
  const fresh = getStripePurchase(purchase?.id || '');
  if (!fresh) throw new Error('Stripe purchase not found');
  if (fresh.appliedAt) return fresh;
  if (String(session?.payment_status || '').toLowerCase() !== 'paid') throw new Error('Stripe payment is not completed');
  if (String(session?.client_reference_id || '') && String(session.client_reference_id) !== fresh.id) throw new Error('Stripe purchase reference mismatch');
  const paid = Number(session?.amount_total || 0) / 100;
  if (!moneyMatches(paid.toFixed(2), fresh.amount) || String(session?.currency || '').toUpperCase() !== String(fresh.currency || '').toUpperCase()) throw new Error('Stripe amount mismatch');
  const user = findUser(fresh.userDiscordId);
  if (!user) throw new Error('User for Stripe purchase not found');
  const days = Math.max(1, Math.min(3650, Number(fresh.accessDays) || 30));
  const now = Date.now();
  const existingExpiry = Date.parse(user.planExpiresAt || '');
  const base = user.planId === fresh.planId && Number.isFinite(existingExpiry) && existingExpiry > now ? existingExpiry : now;
  const expiresAt = new Date(base + days * 86400_000).toISOString();
  upsertUser({ discordId:user.discordId, planId:fresh.planId, planExpiresAt:expiresAt, premiumSource:{ provider:'stripe', purchaseId:fresh.id, sessionId:session.id || fresh.sessionId || '', paymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || '' }, premiumDowngradeStartedAt:null, premiumDowngradeUntil:null, premiumDowngradeKeepServerId:null, freeRenewGraceStartedAt:null });
  const updated = updateStripePurchase(fresh.id, { status:'completed', sessionId:session.id || fresh.sessionId || '', paymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || '', completedAt:fresh.completedAt || new Date().toISOString(), appliedAt:new Date().toISOString(), entitlementExpiresAt:expiresAt });
  rebalanceAssignments();
  return updated;
}
async function applyStripeSubscription(record, sessionOrSubscription, reason='subscription') {
  runLifecycleSweep();
  const fresh = getStripeSubscriptionRecord(record?.id || '');
  if (!fresh) throw new Error('Stripe subscription record not found');
  const user = findUser(fresh.userDiscordId);
  if (!user) throw new Error('User for Stripe subscription not found');
  let subscription = sessionOrSubscription;
  if (sessionOrSubscription?.object === 'checkout.session') {
    const sid = typeof sessionOrSubscription.subscription === 'string' ? sessionOrSubscription.subscription : sessionOrSubscription.subscription?.id;
    if (!sid) throw new Error('Stripe subscription ID missing');
    subscription = await retrieveStripeSubscription(sid);
  }
  const sid = String(subscription?.id || fresh.subscriptionId || '');
  const status = String(subscription?.status || fresh.status || '').toUpperCase();
  if (!['ACTIVE','TRIALING'].includes(status)) return updateStripeSubscriptionRecord(fresh.id, { status, subscriptionId:sid, lastSyncAt:new Date().toISOString() });
  const expiresAt = stripeExpiryFromSubscription(subscription);
  upsertUser({ discordId:user.discordId, planId:fresh.planId, planExpiresAt:expiresAt, premiumSource:{ provider:'stripe_subscription', recordId:fresh.id, subscriptionId:sid, reason }, premiumDowngradeStartedAt:null, premiumDowngradeUntil:null, premiumDowngradeKeepServerId:null, freeRenewGraceStartedAt:null });
  const updated = updateStripeSubscriptionRecord(fresh.id, { status:'ACTIVE', subscriptionId:sid, customerId: typeof subscription?.customer === 'string' ? subscription.customer : subscription?.customer?.id || fresh.customerId || '', entitlementExpiresAt:expiresAt, currentPeriodEnd: subscription?.current_period_end || null, cancelAtPeriodEnd:Boolean(subscription?.cancel_at_period_end), activatedAt:fresh.activatedAt || new Date().toISOString(), lastSyncAt:new Date().toISOString() });
  rebalanceAssignments();
  return updated;
}
function stripeInvoiceSubscriptionId(invoice) {
  return String(invoice?.subscription || invoice?.parent?.subscription_details?.subscription || invoice?.lines?.data?.[0]?.parent?.subscription_item_details?.subscription || '');
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
function ownedManaged(req, id) {
  const bot = getManagedBot(id); const u = currentUser(req);
  if (!bot || !u) return null;
  return u.role === 'admin' || bot.ownerDiscordId === u.discordId || (Array.isArray(bot.sharedPanelUserIds) && bot.sharedPanelUserIds.includes(u.discordId)) ? bot : null;
}
function managedOwner(req, id) {
  const bot = getManagedBot(id); const u = currentUser(req);
  if (!bot || !u) return null;
  return u.role === 'admin' || bot.ownerDiscordId === u.discordId ? bot : null;
}
function isManagedOwnerUser(user, bot) { return Boolean(user && bot && (user.role === 'admin' || bot.ownerDiscordId === user.discordId)); }
function managedAccessActive(bot) {
  if (!bot) return false;
  if (bot.adminGrant) return true;
  const until = Date.parse(bot.accessUntil || '');
  return Number.isFinite(until) && until > Date.now();
}
function managedServicesForUser(discordId, serviceId, isAdminUser = false) { return listManagedBotsAccessibleToUserService(discordId, serviceId, isAdminUser); }
function managedOwnedServicesForUser(discordId, serviceId) { return listManagedBotsForUserService(discordId, serviceId); }
function managedServiceForUser(discordId, serviceId) { return managedServicesForUser(discordId, serviceId)[0] || null; }
function latestServiceSubscription(discordId, serviceId) { return listPaypalServiceSubscriptionsForUser(discordId, serviceId)[0] || null; }
function pendingServiceSubscription(discordId, serviceId) { return listPaypalServiceSubscriptionsForUser(discordId, serviceId).find((x) => ['CREATING','APPROVAL_PENDING','APPROVED','ACTIVE_PENDING_PAYMENT'].includes(String(x.status || '').toUpperCase()) && !x.cancelledAt) || null; }
function serviceSubscriptionForBot(bot) { return bot?.accessRecordId ? getPaypalServiceSubscriptionRecord(String(bot.accessRecordId)) : null; }
function managedManageUrl(serviceId, botId = '') { const base = `/bot-services/${encodeURIComponent(serviceId)}/manage`; return botId ? `${base}?bot=${encodeURIComponent(botId)}` : base; }
function supportedManagedService(service) { return Boolean(service && ['wardogs-warning-bot', PLAYTIME_SERVICE_ID, KILL_STATS_SERVICE_ID].includes(String(service.id))); }
function serviceBotRuntime(bot) { return bot?.serviceId === PLAYTIME_SERVICE_ID ? playtimeBotRuntime(bot.id) : bot?.serviceId === KILL_STATS_SERVICE_ID ? killStatsBotRuntime(bot.id) : managedBotRuntime(bot?.id); }
async function syncAllServiceBots() { const bots=readDb().managedBots||[]; await Promise.all([syncManagedBots(bots), syncPlaytimeBots(bots), syncKillStatsBots(bots)]); }
async function restartServiceBot(bot) { return bot?.serviceId === PLAYTIME_SERVICE_ID ? restartPlaytimeBot(bot) : bot?.serviceId === KILL_STATS_SERVICE_ID ? restartKillStatsBot(bot) : restartManagedBot(bot); }
async function stopServiceBot(bot) { return bot?.serviceId === PLAYTIME_SERVICE_ID ? stopPlaytimeBot(bot.id) : bot?.serviceId === KILL_STATS_SERVICE_ID ? stopKillStatsBot(bot.id) : stopManagedBot(bot.id); }

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

app.post('/api/ingest/events', rateLimit({ windowMs: 10 * 60_000, limit: 1200, standardHeaders: 'draft-8', legacyHeaders: false }), async (req, res) => {
  const auth = String(req.get('authorization') || '');
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return res.status(401).json({ error: { code: 'unauthorized', message: 'Bearer token required.' } });
  try {
    const result = await ingestWardogsKillFeed(match[1].trim(), req.body || {});
    return res.status(202).json({ ok: true, ...result });
  } catch (error) {
    const status = Number(error?.status || 0) === 401 ? 401 : 400;
    return res.status(status).json({ error: { code: status === 401 ? 'unauthorized' : 'invalid_feed', message: String(error?.message || error).slice(0, 240) } });
  }
});
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

app.get('/auth/discord', securityRateLimit('oauth-start', 10 * 60_000, 15), (req, res) => {
  const oauth = discordOAuthConfig();
  if (!oauth.enabled || !oauth.configured) {
    flash(req, 'err', l(req, 'Discord Login ist derzeit nicht eingerichtet oder deaktiviert.', 'Discord login is currently not configured or disabled.'));
    return res.redirect('/login');
  }
  const returnTo = String(req.query.returnTo || '').trim();
  if (returnTo.startsWith('/') && !returnTo.startsWith('//')) req.session.oauthReturnTo = returnTo.slice(0, 500);
  const state = crypto.randomBytes(24).toString('base64url'); req.session.oauthState = state; req.session.oauthStateCreatedAt = Date.now();
  const params = new URLSearchParams({ client_id: oauth.clientId, response_type: 'code', redirect_uri: oauth.redirectUri, scope: 'identify', state });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

app.get('/auth/discord/callback', securityRateLimit('oauth-callback', 10 * 60_000, 20), async (req, res) => {
  try {
    const oauth = discordOAuthConfig();
    if (!oauth.enabled || !oauth.configured) throw new Error(l(req, 'Discord OAuth ist nicht vollständig eingerichtet.', 'Discord OAuth is not fully configured.'));
    const { code, state } = req.query;
    if (!code || !state || state !== req.session.oauthState || !Number.isFinite(Number(req.session.oauthStateCreatedAt)) || Date.now() - Number(req.session.oauthStateCreatedAt) > 10 * 60_000) throw new Error('OAuth state ungültig oder abgelaufen');
    const returnTo = String(req.session.oauthReturnTo || '/');
    const previousLang = req.session.lang;
    delete req.session.oauthState;
    delete req.session.oauthStateCreatedAt;
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
  } catch (error) {
    console.error('Discord OAuth failed:', String(error?.message || error).slice(0, 300));
    res.status(500).send(l(req, 'Discord Login fehlgeschlagen. Bitte später erneut versuchen.', 'Discord login failed. Please try again later.'));
  }
});

app.post('/logout', requireLogin, checkCsrf, (req, res) => req.session.destroy(() => { res.clearCookie(sessionCookieName, { path: '/' }); res.redirect('/login'); }));


app.post('/cookies/preferences', checkCsrf, (req,res) => {
  const mode=String(req.body.choice||req.body.mode||'custom');
  const consent={v:1,necessary:true,analytics:mode==='accept'||(mode==='custom'&&req.body.analytics==='1'),marketing:mode==='accept'||(mode==='custom'&&req.body.marketing==='1'),savedAt:new Date().toISOString()};
  res.cookie('sh_cookie_consent',Buffer.from(JSON.stringify(consent)).toString('base64url'),{httpOnly:true,sameSite:'lax',secure:secureCookie,maxAge:180*24*60*60*1000,path:'/'});
  const back=String(req.body.returnTo||req.get('referer')||'/');
  res.redirect(back.startsWith(baseUrl)?back:back.startsWith('/')?back:'/');
});

app.get('/cookies', (req,res) => {
  const lang=langOf(req); const pref=cookieConsent(req)||{necessary:true,analytics:false,marketing:false};
  render(req,res,tr(lang,'Cookie-Einstellungen','Cookie settings'),`<div class="pagehead"><div><h1>${tr(lang,'Cookie-Einstellungen','Cookie settings')}</h1><p>${tr(lang,'Du kannst optionale Cookies jederzeit ablehnen oder deine Auswahl ändern.','You can reject optional cookies or change your choice at any time.')}</p></div></div><section class="panel"><h2>${tr(lang,'Kategorien','Categories')}</h2><form method="post" action="/cookies/preferences" class="formgrid"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><input type="hidden" name="mode" value="custom"><input type="hidden" name="returnTo" value="/cookies"><label class="check span2"><input type="checkbox" checked disabled> <strong>${tr(lang,'Notwendig','Necessary')}</strong> · ${tr(lang,'Login, Session, CSRF-Schutz und Cookie-Auswahl. Immer aktiv.','Login, session, CSRF protection and cookie choice. Always active.')}</label><label class="check span2"><input type="checkbox" name="analytics" value="1" ${pref.analytics?'checked':''}> <strong>Analytics</strong> · ${tr(lang,'Optionale Reichweitenmessung. Derzeit ist kein Analytics-Dienst eingebunden.','Optional audience measurement. No analytics service is currently integrated.')}</label><label class="check span2"><input type="checkbox" name="marketing" value="1" ${pref.marketing?'checked':''}> <strong>Marketing</strong> · ${tr(lang,'Optionale Marketing-/Tracking-Dienste. Derzeit sind keine Marketing-Tracker eingebunden.','Optional marketing/tracking services. No marketing trackers are currently integrated.')}</label><div class="span2 actions"><button class="button ghost" type="submit" name="choice" value="reject">${tr(lang,'Optionale ablehnen','Reject optional')}</button><button class="button primary">${tr(lang,'Auswahl speichern','Save choices')}</button><button class="button ghost" type="submit" name="choice" value="accept">${tr(lang,'Alle akzeptieren','Accept all')}</button></div></form></section><section class="panel"><h2>${tr(lang,'Verwendete Cookies','Cookies in use')}</h2><div class="tablewrap"><table class="cookie-table"><thead><tr><th>Name</th><th>${tr(lang,'Zweck','Purpose')}</th><th>${tr(lang,'Dauer','Duration')}</th></tr></thead><tbody><tr><td><code>${esc(sessionCookieName)}</code></td><td>${tr(lang,'Notwendige Anmeldung, Session und Sicherheitsfunktionen.','Necessary login, session and security functions.')}</td><td>7 ${tr(lang,'Tage','days')}</td></tr><tr><td><code>sh_cookie_consent</code></td><td>${tr(lang,'Speichert deine Cookie-Auswahl.','Stores your cookie choices.')}</td><td>180 ${tr(lang,'Tage','days')}</td></tr></tbody></table></div><p class="muted small">${tr(lang,'Optionale Cookies werden erst nach Einwilligung gesetzt. In der aktuellen Version werden keine optionalen Analyse- oder Marketing-Cookies geladen.','Optional cookies are only set after consent. The current version does not load optional analytics or marketing cookies.')}</p></section>`);
});

app.get('/games', (req, res) => {
  render(req, res, l(req, 'Games & FAQ', 'Games & FAQ'), gamesPage({ loggedIn: Boolean(currentUser(req)), lang: langOf(req) }));
});

app.get('/bot-services', (req, res) => {
  const lang = langOf(req); const settings = getSiteSettings(); const allServices = listBotServices(true); const user = currentUser(req);
  const categories=[...new Set(allServices.map((x)=>String(x.category||'wardogs').toLowerCase()))].sort();
  const requestedCategory=String(req.query.category||'all').toLowerCase();
  const activeCategory=requestedCategory==='all'||categories.includes(requestedCategory)?requestedCategory:'all';
  const services=activeCategory==='all'?allServices:allServices.filter((x)=>String(x.category||'wardogs').toLowerCase()===activeCategory);
  const categoryLabel=(id)=>id==='wardogs'?'WARDOGS':id.replace(/[-_]+/g,' ').replace(/\b\w/g,(c)=>c.toUpperCase());
  const categoryFilter=`<div class="service-filters"><a class="button ${activeCategory==='all'?'primary':'ghost'} smallbtn" href="/bot-services?category=all">${tr(lang,'Alle','All')}</a>${categories.map((id)=>`<a class="button ${activeCategory===id?'primary':'ghost'} smallbtn" href="/bot-services?category=${encodeURIComponent(id)}">${esc(categoryLabel(id))}</a>`).join('')}</div>`;
  const cards = services.map((service) => {
    const name = lang === 'en' ? (service.nameEn || service.nameDe) : (service.nameDe || service.nameEn);
    const description = lang === 'en' ? (service.descriptionEn || service.descriptionDe) : (service.descriptionDe || service.descriptionEn);
    const features = lang === 'en' ? (service.featuresEn || service.featuresDe || []) : (service.featuresDe || service.featuresEn || []);
    const status = service.status === 'available' ? tr(lang,'Verfügbar','Available') : service.status === 'paused' ? tr(lang,'Pausiert','Paused') : tr(lang,'Coming Soon','Coming soon');
    const statusClass = service.status === 'available' ? 'online' : service.status === 'paused' ? 'offline' : 'neutral';
    const purchaseUrl = /^https?:\/\//i.test(String(service.purchaseUrl || '')) ? service.purchaseUrl : '';
    const fallbackSupport = /^https?:\/\//i.test(String(service.supportUrl || '')) ? service.supportUrl : (/^https?:\/\//i.test(String(settings.supportUrl || '')) ? settings.supportUrl : '');
    const instances = user ? managedServicesForUser(user.discordId, service.id) : [];
    const activeInstances = instances.filter((instance) => managedAccessActive(instance) || user?.role === 'admin');
    const pending = user ? pendingServiceSubscription(user.discordId, service.id) : null;
    const pendingState = String(pending?.status || '').toUpperCase();
    let action = `<span class="button ghost disabled">${esc(status)}</span>`;
    if (supportedManagedService(service) && service.status === 'available') {
      if (!user) action = `<a class="button primary" href="/auth/discord?returnTo=${encodeURIComponent('/bot-services')}">${tr(lang,'Einloggen & Bot aktivieren','Login & activate bot')}</a>`;
      else {
        const parts=[];
        if (instances.length) parts.push(`<a class="button primary" href="${esc(managedManageUrl(service.id, activeInstances[0]?.id || instances[0].id))}">${tr(lang,`Bots verwalten (${instances.length})`,`Manage bots (${instances.length})`)}</a>`);
        if (user.role === 'admin') {
          parts.push(`<form method="post" action="/bot-services/${encodeURIComponent(service.id)}/admin-activate" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button success" type="submit">${instances.length ? tr(lang,'+ Weitere Gratis-Instanz','+ Add free instance') : tr(lang,'Gratis für Admin aktivieren','Activate free for admin')}</button></form>`);
        } else if (pending) {
          parts.push(`<a class="button ghost" href="${esc(managedManageUrl(service.id))}">${tr(lang,'Neues Abo wird verarbeitet','New subscription pending')} · ${esc(pendingState)}</a>`);
        } else if (normalizedMoney(service.monthlyAmount)) {
          parts.push(`<a class="button ${instances.length ? 'ghost' : 'primary'}" href="/bot-services/${encodeURIComponent(service.id)}/checkout">${instances.length ? tr(lang,'+ Weiteren Bot holen','+ Add another bot') : tr(lang,'Bot holen','Get bot')} · ${esc(normalizedMoney(service.monthlyAmount))} ${esc(service.currency || 'EUR')} / ${tr(lang,'Monat','month')}</a>`);
        } else if (fallbackSupport) parts.push(`<a class="button primary" href="${esc(fallbackSupport)}" target="_blank" rel="noopener">${tr(lang,'Support kontaktieren','Contact support')}</a>`);
        action=parts.join('');
      }
    } else if (service.status === 'available' && purchaseUrl) action = `<a class="button primary" href="${esc(purchaseUrl)}" target="_blank" rel="noopener">${tr(lang,'Bot kaufen','Buy bot')}</a>`;
    else if (fallbackSupport) action = `<a class="button ${service.status === 'available' ? 'primary' : 'ghost'}" href="${esc(fallbackSupport)}" target="_blank" rel="noopener">${service.status === 'available' ? tr(lang,'Kaufen / Support','Buy / support') : tr(lang,'Mehr erfahren','Learn more')}</a>`;
    const accessBadge = activeInstances.length ? `<span class="badge online">${tr(lang,`${activeInstances.length} Bot${activeInstances.length===1?'':'s'} aktiv`,`${activeInstances.length} bot${activeInstances.length===1?'':'s'} active`)}</span>` : pending ? `<span class="badge starting">${esc(pendingState)}</span>` : '';
    return `<article class="service-card panel ${service.featured ? 'featured' : ''}"><div class="row between"><div><span class="eyebrow">${esc(categoryLabel(String(service.category||'wardogs').toLowerCase()))} · ${tr(lang,'Managed Bot Service','Managed bot service')}</span><h2>${esc(name)}</h2></div><span class="badge ${statusClass}">${esc(status)}</span></div>${service.priceLabel ? `<div class="service-price">${esc(service.priceLabel)}</div>` : ''}${accessBadge}<p>${esc(description)}</p><ul class="service-features">${features.map((x)=>`<li>${esc(x)}</li>`).join('')}</ul><div class="actions wrap">${action}</div></article>`;
  }).join('');
  render(req,res,tr(lang,'Bot Services','Bot Services'),`<div class="pagehead"><div><h1>${tr(lang,'Bots as a Service','Bots as a Service')}</h1></div></div>${categoryFilter}<section class="service-grid">${cards || `<div class="panel empty">${tr(lang,'Keine Bot Services in dieser Kategorie.','No bot services in this category.')}</div>`}</section>`);
});


app.get('/bot-services/:id/checkout', (req,res)=>{
  const lang=langOf(req),settings=getSiteSettings(),service=getBotService(req.params.id),user=currentUser(req);
  if(!supportedManagedService(service)||service.status!=='available')return res.status(404).send('Service not found');
  const name=lang==='en'?(service.nameEn||service.nameDe):(service.nameDe||service.nameEn);
  const description=lang==='en'?(service.descriptionEn||service.descriptionDe):(service.descriptionDe||service.descriptionEn);
  const features=lang==='en'?(service.featuresEn||service.featuresDe||[]): (service.featuresDe||service.featuresEn||[]);
  const amount=normalizedMoney(service.monthlyAmount),currency=/^[A-Z]{3}$/.test(String(service.currency||'').toUpperCase())?String(service.currency).toUpperCase():'EUR';
  const owned=user?managedOwnedServicesForUser(user.discordId,service.id):[];
  const pending=user?pendingServiceSubscription(user.discordId,service.id):null;
  const category=String(service.category||'wardogs').toUpperCase();
  let action='';
  if(!user){
    action=`<div class="checkout-option"><div><span class="eyebrow">PayPal</span><h3>${tr(lang,'Monatliches Abo','Monthly subscription')}</h3><p>${esc(amount||service.priceLabel||'—')} ${amount?esc(currency):''}${amount?` / ${tr(lang,'Monat','month')}`:''}</p></div><a class="button primary" href="/auth/discord?returnTo=${encodeURIComponent(`/bot-services/${service.id}/checkout`)}">${tr(lang,'Einloggen & weiter','Login & continue')}</a></div>`;
  } else if(user.role==='admin'){
    action=`<form method="post" action="/bot-services/${encodeURIComponent(service.id)}/admin-activate" class="checkout-option"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><div><span class="eyebrow">Admin</span><h3>${tr(lang,'Gratis-Instanz','Free instance')}</h3><p>${tr(lang,'Admins können diesen Service ohne PayPal-Abo aktivieren.','Admins can activate this service without a PayPal subscription.')}</p></div><button class="button success" type="submit">${owned.length?tr(lang,'Weitere Gratis-Instanz anlegen','Create another free instance'):tr(lang,'Gratis aktivieren','Activate free')}</button></form>`;
  } else if(pending){
    action=`<div class="checkout-option"><div><span class="eyebrow">PayPal</span><h3>${tr(lang,'Checkout läuft bereits','Checkout already pending')}</h3><p>${esc(String(pending.status||'APPROVAL_PENDING').toUpperCase())}</p></div><a class="button ghost" href="${esc(managedManageUrl(service.id))}">${tr(lang,'Abo verwalten','Manage subscription')}</a></div>`;
  } else if(amount&&paypalConfigured(settings)){
    action=`<form method="post" action="/bot-services/${encodeURIComponent(service.id)}/paypal/subscribe" class="checkout-option"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><div><span class="eyebrow">PayPal</span><h3>${tr(lang,'Monatliches Abo','Monthly subscription')}</h3><p>${esc(amount)} ${esc(currency)} / ${tr(lang,'Monat','month')} · ${tr(lang,'1 neue Bot-Instanz','1 new bot instance')}</p></div><button class="button primary" type="submit">${tr(lang,'Weiter mit PayPal','Continue with PayPal')}</button></form>`;
  } else {
    const support=/^https?:\/\//i.test(String(service.supportUrl||''))?service.supportUrl:(/^https?:\/\//i.test(String(settings.supportUrl||''))?settings.supportUrl:'');
    action=`<div class="checkout-option"><div><span class="eyebrow">Checkout</span><h3>${tr(lang,'Noch nicht verfügbar','Not available yet')}</h3><p>${tr(lang,'Für diesen Service ist aktuell kein automatischer PayPal-Checkout eingerichtet.','Automatic PayPal checkout is not configured for this service yet.')}</p></div>${support?`<a class="button primary" href="${esc(support)}" target="_blank" rel="noopener">${tr(lang,'Support kontaktieren','Contact support')}</a>`:''}</div>`;
  }
  const ownedNote=user&&owned.length?`<div class="panel help"><strong>${tr(lang,'Bereits vorhanden','Already owned')}:</strong> ${tr(lang,`Du hast bereits ${owned.length} Instanz${owned.length===1?'':'en'} dieses Services. Dieser Checkout legt eine weitere, vollständig getrennte Instanz mit eigenem Abo an.`,`You already have ${owned.length} instance${owned.length===1?'':'s'} of this service. This checkout creates another fully separate instance with its own subscription.`)}</div>`:'';
  render(req,res,tr(lang,'Service Bot Checkout','Service bot checkout'),`<div class="pagehead"><div><span class="eyebrow">${esc(category)} · ${tr(lang,'Service Bot Checkout','Service bot checkout')}</span><h1>${esc(name)}</h1><p>${esc(description)}</p></div><a class="button ghost" href="/bot-services">${tr(lang,'Zurück zu Bot Services','Back to Bot Services')}</a></div>
    <section class="panel checkout-summary"><div><span class="eyebrow">${tr(lang,'Ausgewählter Service','Selected service')}</span><h2>${esc(name)}</h2><div class="service-price">${esc(service.priceLabel||`${amount||'—'} ${currency} / month`)}</div><p>${tr(lang,'Jeder Kauf erstellt genau eine neue Instanz.','Each purchase creates exactly one new instance.')}</p></div><div><ul class="service-features">${features.map((x)=>`<li>${esc(x)}</li>`).join('')}</ul></div></section>
    ${ownedNote}<section class="checkout-section"><div class="pagehead compact"><div><h2>${tr(lang,'Monatliches Abo','Monthly subscription')}</h2><p>${tr(lang,'Das Abo gehört nur zu dieser neuen Service-Bot-Instanz und kann separat gekündigt werden.','The subscription belongs only to this new service-bot instance and can be cancelled separately.')}</p></div></div><div class="checkout-grid">${action}</div></section>`);
});

function managedRuleRows(text) {
  const rows=[];
  for(const rawLine of String(text||'').split(/\r?\n/).map((x)=>x.trim()).filter((x)=>x&&!x.startsWith('#'))){
    try {
      const parsed=parseManagedRules(rawLine)[0]; if(!parsed||parsed.legacy)continue;
      rows.push({type:parsed.type,op:parsed.op||'',value:parsed.value===true?'':String(parsed.value??''),reason:parsed.reason||'',action:parsed.action||'alert',durationMinutes:Number(parsed.durationMinutes||0)});
    } catch {}
  }
  return rows;
}

function managedRulesFromBody(req){
  const lines=[];
  const numericTypes=new Set(['vac_bans','game_bans','playtime','account_age','recent_ban']);
  const booleanTypes=new Set(['community_ban','economy_ban','private_profile']);
  const actions=new Set(['alert','kick','ban','tempban']);
  for(let i=0;i<100;i+=1){
    const type=String(req.body[`ruleType_${i}`]||'').trim().toLowerCase();
    if(!type)continue;
    if(!numericTypes.has(type)&&!booleanTypes.has(type))throw new Error(l(req,`Regel ${i+1}: ungültiger Typ.`,`Rule ${i+1}: invalid type.`));
    const reason=String(req.body[`ruleReason_${i}`]||'').trim().replace(/\|/g,'/').slice(0,180);
    const actionRaw=String(req.body[`ruleAction_${i}`]||'alert').trim().toLowerCase();
    const action=actions.has(actionRaw)?actionRaw:'alert';
    let durationMinutes=0;
    if(action==='tempban'){
      durationMinutes=managedDurationMinutesFromBody(req, `ruleDuration_${i}Value`, `ruleDuration_${i}Unit`, 1440, true);
    }
    let expr='';
    if(booleanTypes.has(type)){
      if(type==='community_ban')expr='communityban=true';
      else if(type==='economy_ban')expr='economyban=true';
      else expr='privateprofile=true';
    } else {
      const raw=String(req.body[`ruleValue_${i}`]||'').trim();
      if(!raw)throw new Error(l(req,`Regel ${i+1}: Wert fehlt.`,`Rule ${i+1}: value is required.`));
      const value=Number(raw.replace(',','.'));
      if(!Number.isFinite(value)||value<0)throw new Error(l(req,`Regel ${i+1}: Wert ist ungültig.`,`Rule ${i+1}: value is invalid.`));
      if(type==='vac_bans')expr=`vac>=${Math.max(1,Math.min(100,Math.floor(value)))}`;
      else if(type==='game_bans')expr=`gameban>=${Math.max(1,Math.min(100,Math.floor(value)))}`;
      else if(type==='playtime')expr=`playtime<${Math.max(0.1,Math.min(100000,value))}`;
      else if(type==='account_age')expr=`accountage<${Math.max(1,Math.min(36500,Math.floor(value)))}`;
      else expr=`recentban<=${Math.max(0,Math.min(36500,Math.floor(value)))}`;
    }
    const meta=[`@action=${action}`];
    if(action==='tempban')meta.push(`@duration=${durationMinutes}`);
    lines.push(`${expr}${reason?` | ${reason}`:''} | ${meta.join(' | ')}`);
  }
  const text=lines.join('\n');parseManagedRules(text);return text;
}

function managedRuleTypeLabel(req,type){
  const labels={
    vac_bans:['VAC-Bans','VAC bans'],
    game_bans:['Game-Bans','Game bans'],
    playtime:['Wenig Spielzeit','Low playtime'],
    account_age:['Neues Steam-Konto','New Steam account'],
    recent_ban:['Kürzlicher Steam-Ban','Recent Steam ban'],
    community_ban:['Community-Ban','Community ban'],
    economy_ban:['Economy-Ban','Economy ban'],
    private_profile:['Privates Steam-Profil','Private Steam profile']
  };
  return (labels[type]||[type,type])[langOf(req)==='en'?1:0];
}

const managedGrantLabels={view:['Panel / Spieler ansehen','View panel / players'],announce:['Announcements','Announcements'],whisper:['Whisper','Whisper'],kick:['Kick','Kick'],ban:['Ban','Ban'],unban:['Unban','Unban'],kill:['Kill / Respawn','Kill / respawn'],setteam:['Team setzen','Set team'],match:['Match steuern','Match control'],map:['Map wechseln','Change map'],lighting:['Lighting','Lighting'],ignore:['Warnungen ignorieren','Ignore detection alerts']};
function managedGrantRows(bot){
  const input=Array.isArray(bot.discordGrants)?bot.discordGrants:[];
  return input.filter((g)=>validSnowflake(g?.id)&&Array.isArray(g?.permissions)).slice(0,20);
}
function managedGrantsFromBody(req){
  const out=[],seen=new Map();
  for(let i=0;i<20;i+=1){
    const id=String(req.body[`grantId_${i}`]||'').trim(); if(!id)continue;
    if(!validSnowflake(id))throw new Error(l(req,`Discord Freigabe ${i+1}: ID ist ungültig.`,`Discord grant ${i+1}: invalid ID.`));
    const type=String(req.body[`grantType_${i}`]||'role')==='user'?'user':'role';
    const permissions=MANAGED_DISCORD_PERMISSION_KEYS.filter((key)=>req.body[`grantPerm_${i}_${key}`]==='1');
    if(!permissions.length)continue;
    const key=`${type}:${id}`;
    if(seen.has(key)){const row=seen.get(key);row.permissions=[...new Set([...row.permissions,...permissions])];continue;}
    const row={type,id,permissions};out.push(row);seen.set(key,row);
  }
  return out;
}

function managedBanTemplates(bot){
  return (Array.isArray(bot?.banTemplates)?bot.banTemplates:[]).map((entry,index)=>({
    id:String(entry?.id||`template-${index+1}`).replace(/[^a-zA-Z0-9_-]+/g,'-').slice(0,64)||`template-${index+1}`,
    label:String(entry?.label||'').trim().slice(0,60),
    reason:String(entry?.reason||'').trim().slice(0,180),
    durationMinutes:Math.max(0,Math.min(525600,Math.floor(Number(entry?.durationMinutes)||0)))
  })).filter((entry)=>entry.label&&entry.reason).slice(0,12);
}
function managedDurationParts(durationMinutes, temporaryOnly=false){
  const minutes=Math.max(0,Math.min(525600,Math.floor(Number(durationMinutes)||0)));
  if(!minutes&&!temporaryOnly)return {unit:'permanent',value:1};
  const safe=minutes||1440;
  if(safe%1440===0)return {unit:'days',value:safe/1440};
  if(safe%60===0)return {unit:'hours',value:safe/60};
  return {unit:'minutes',value:safe};
}
function managedDurationMinutesFromBody(req,valueName,unitName,fallbackMinutes=0,temporaryOnly=false){
  const fallback=managedDurationParts(fallbackMinutes,temporaryOnly);
  const rawUnit=String(req.body[unitName]||fallback.unit||'permanent').trim().toLowerCase();
  const unit=rawUnit==='days'?'days':rawUnit==='hours'?'hours':rawUnit==='minutes'?'minutes':temporaryOnly?'minutes':'permanent';
  if(unit==='permanent'&&!temporaryOnly)return 0;
  const raw=String(req.body[valueName]??fallback.value??'').trim().replace(',','.');
  const value=Number(raw);
  if(!Number.isFinite(value)||value<=0)throw new Error(l(req,'Die Ban-Dauer muss größer als 0 sein.','Ban duration must be greater than 0.'));
  const multiplier=unit==='days'?1440:unit==='hours'?60:1;
  const minutes=Math.round(value*multiplier);
  if(minutes<1||minutes>525600)throw new Error(l(req,'Die Ban-Dauer ist ungültig oder zu lang.','Ban duration is invalid or too long.'));
  return minutes;
}
function managedDurationControlsHtml(req,baseName,durationMinutes,{temporaryOnly=false}={}){
  const parts=managedDurationParts(durationMinutes,temporaryOnly);
  const permanentOption=temporaryOnly?'':`<option value="permanent" ${parts.unit==='permanent'?'selected':''}>${l(req,'Permanent','Permanent')}</option>`;
  return `<span class="managed-duration" data-ban-duration><select name="${baseName}Unit" data-duration-unit>${permanentOption}<option value="minutes" ${parts.unit==='minutes'?'selected':''}>${l(req,'Minuten','Minutes')}</option><option value="hours" ${parts.unit==='hours'?'selected':''}>${l(req,'Stunden','Hours')}</option><option value="days" ${parts.unit==='days'?'selected':''}>${l(req,'Tage','Days')}</option></select><input name="${baseName}Value" data-duration-value type="number" min="1" max="525600" step="1" value="${esc(parts.value)}" ${parts.unit==='permanent'&&!temporaryOnly?'hidden disabled':''}></span>`;
}

function managedBanTemplatesFromBody(req){
  const rows=[];
  for(let i=0;i<12;i+=1){
    const label=String(req.body[`banTemplateLabel_${i}`]||'').trim().slice(0,60);
    const reason=String(req.body[`banTemplateReason_${i}`]||'').trim().slice(0,180);
    if(!label&&!reason)continue;
    if(!label||!reason)throw new Error(l(req,`Ban Template ${i+1}: Name und Grund sind erforderlich.`,`Ban template ${i+1}: label and reason are required.`));
    rows.push({id:`template-${i+1}`,label,reason,durationMinutes:managedDurationMinutesFromBody(req,`banTemplateDuration_${i}Value`,`banTemplateDuration_${i}Unit`,0,false)});
  }
  return rows;
}
function managedBanTemplateRowsHtml(req,bot){
  const rows=managedBanTemplates(bot);
  if(!rows.length)rows.push({id:'template-1',label:'',reason:'',durationMinutes:0});
  return rows.map((row,i)=>`<div class="managed-ban-template-row" data-ban-template-row><input name="banTemplateLabel_${i}" maxlength="60" value="${esc(row.label||'')}" placeholder="${l(req,'Name, z. B. Teamkilling','Label, e.g. Teamkilling')}"><input name="banTemplateReason_${i}" maxlength="180" value="${esc(row.reason||'')}" placeholder="${l(req,'Ban-Grund','Ban reason')}">${managedDurationControlsHtml(req,`banTemplateDuration_${i}`,row.durationMinutes)}<button class="button danger smallbtn" type="button" data-remove-ban-template>×</button></div>`).join('');
}
function managedRuleRowHtml(req,row,index){
  const type=row?.type||'vac_bans';
  const options=['vac_bans','game_bans','playtime','account_age','recent_ban','community_ban','economy_ban','private_profile'].map((key)=>`<option value="${key}" ${type===key?'selected':''}>${esc(managedRuleTypeLabel(req,key))}</option>`).join('');
  const booleanType=['community_ban','economy_ban','private_profile'].includes(type);
  const op=type==='playtime'||type==='account_age'?'&lt;':type==='recent_ban'?'≤':'≥';
  const unit=type==='playtime'?l(req,'Stunden','hours'):['account_age','recent_ban'].includes(type)?l(req,'Tage','days'):l(req,'Anzahl','count');
  const action=String(row?.action||'alert');
  const actionOptions=[['alert',l(req,'Nur Alert','Alert only')],['kick','Kick'],['ban',l(req,'Permanent Ban','Permanent ban')],['tempban',l(req,'Temporary Ban','Temporary ban')]].map(([value,label])=>`<option value="${value}" ${action===value?'selected':''}>${esc(label)}</option>`).join('');
  return `<div class="managed-rule-row" data-rule-row><select name="ruleType_${index}" data-rule-type>${options}</select><span class="managed-rule-op" data-rule-op-label>${op}</span><input name="ruleValue_${index}" data-rule-value type="number" min="0" step="${type==='playtime'?'0.1':'1'}" value="${esc(row?.value||'')}" placeholder="${type==='playtime'?'10':type==='account_age'?'30':type==='recent_ban'?'365':'1'}" ${booleanType?'disabled':''}><span class="managed-rule-unit" data-rule-unit>${esc(booleanType?l(req,'aktiv','active'):unit)}</span><select name="ruleAction_${index}" data-rule-action>${actionOptions}</select><span data-rule-duration ${action==='tempban'?'':'hidden'}>${managedDurationControlsHtml(req,`ruleDuration_${index}`,row?.durationMinutes||1440,{temporaryOnly:true})}</span><input name="ruleReason_${index}" maxlength="180" value="${esc(row?.reason||'')}" placeholder="${l(req,'Warn-/Banngrund (optional)','Alert/ban reason (optional)')}"><button class="button danger smallbtn" type="button" data-remove-rule>×</button></div>`;
}

function managedGrantRowHtml(req,row,index){
  const type=row?.type==='user'?'user':'role',perms=new Set(Array.isArray(row?.permissions)?row.permissions:[]);
  return `<div class="managed-grant-row" data-grant-row><div class="managed-grant-head"><select name="grantType_${index}"><option value="role" ${type==='role'?'selected':''}>${l(req,'Discord Rolle','Discord role')}</option><option value="user" ${type==='user'?'selected':''}>${l(req,'Discord Benutzer','Discord user')}</option></select><input name="grantId_${index}" inputmode="numeric" value="${esc(row?.id||'')}" placeholder="Discord ID"><button class="button danger smallbtn" type="button" data-remove-grant>×</button></div><div class="managed-perm-grid">${MANAGED_DISCORD_PERMISSION_KEYS.map((key)=>`<label class="check"><input type="checkbox" name="grantPerm_${index}_${key}" value="1" ${perms.has(key)?'checked':''}> ${esc((managedGrantLabels[key]||[key,key])[langOf(req)==='en'?1:0])}</label>`).join('')}</div></div>`;
}

function managedBotForm(req, service, bot) {
  const lang=langOf(req),u=currentUser(req),rt=serviceBotRuntime(bot),auto=bot.autoBanEnabled===true;
  const rules=managedRuleRows(bot.rulesText||'');
  const grants=managedGrantRows(bot); if(!grants.length)grants.push({type:'role',id:'',permissions:[]});
  const ruleRows=rules.map((row,i)=>managedRuleRowHtml(req,row,i)).join('');
  const hasGlobalSteamKey=Boolean(String(process.env.STEAM_WEB_API_KEY||'').trim());
  const grantRows=grants.map((row,i)=>managedGrantRowHtml(req,row,i)).join('');
  const banTemplateRows=managedBanTemplateRowsHtml(req,bot);
  const banSyncCommunity=bot.banSyncServerId?getBanSyncServer(String(bot.banSyncServerId)):null;
  const communityMember=Boolean(banSyncCommunity&&Array.isArray(banSyncCommunity.members)&&banSyncCommunity.members.map(String).includes(String(bot.id)));
  const communityOwner=communityMember&&String(banSyncCommunity.ownerBotId||'')===String(bot.id);
  const dynamicPolicy=communityMember?{
    enabled:banSyncCommunity.dynamicBanEnabled===true,
    joins:Math.max(2,Math.min(20,Math.floor(Number(banSyncCommunity.dynamicBanEscalateJoins)||3))),
    window:Math.max(1,Math.min(1440,Math.floor(Number(banSyncCommunity.dynamicBanEscalateWindowMinutes)||5)))
  }:{enabled:bot.dynamicBanEnabled===true,joins:Number(bot.dynamicBanEscalateJoins||3),window:Number(bot.dynamicBanEscalateWindowMinutes||5)};
  const dynamicLocked=communityMember&&!communityOwner;
  const managedServers=normalizeManagedServers(bot); if(!managedServers.length)managedServers.push(newManagedServerRow(0));
  const managedServerRows=managedServers.map((row,i)=>managedServerRowHtml(req,row,i,bot)).join('');
   return `<form method="post" action="/bot-services/${encodeURIComponent(service.id)}/manage" class="panel formgrid" id="managed-bot-config">
    <input type="hidden" name="_csrf" value="${esc(csrf(req))}">
    <input type="hidden" name="botId" value="${esc(bot.id)}">
    <label>${tr(lang,'Bot-Name','Bot name')}<input name="name" maxlength="80" required value="${esc(bot.name||service.nameDe||service.nameEn||'WARDOGS Bot')}"></label>
    <label>Discord Bot Token <span class="required">*</span><input name="botToken" type="password" autocomplete="new-password" placeholder="${bot.botTokenEnc?tr(lang,'Leer lassen = unverändert','Leave blank = unchanged'):tr(lang,'Pflicht für Discord Alerts und Management Panel','Required for Discord alerts and management panel')}"></label>
    <label>${tr(lang,'Rollen-Ping ID (optional)','Role mention ID (optional)')}<input name="mentionRoleId" inputmode="numeric" value="${esc(bot.mentionRoleId||'')}" placeholder="123456789012345678"></label>
    <div class="span2 managed-config-block"><div class="row between"><div><strong>${tr(lang,'Verwaltete Gameserver','Managed game servers')}</strong><p class="muted small">${tr(lang,'Ein Management Bot kann bis zu 12 WARDOGS Server verwalten. Jeder Server erhält eigene Discord-Alert- und Management-Panel-Channels.','One Management Bot can manage up to 12 WARDOGS servers. Each server has its own Discord alert and management-panel channels.')}</p></div><button class="button ghost smallbtn" type="button" id="add-managed-server">+ ${tr(lang,'Server','Server')}</button></div><div id="managed-server-list" data-next-index="${managedServers.length}">${managedServerRows}</div></div>
    <div class="span2 managed-config-block"><div class="row between"><strong>${tr(lang,'Discord Rechtevergabe','Discord permission grants')}</strong><button class="button ghost smallbtn" type="button" id="add-managed-grant">+ ${tr(lang,'Freigabe','Grant')}</button></div><p class="muted small">${tr(lang,'Wichtig: Auch der Bot-Owner erhält im Discord-Management-Panel keine automatischen Rechte. Seine Discord User-ID muss hier wie jede andere Person eingetragen werden. Discord-Server-Administratoren behalten ihre Discord-Adminrechte.','Important: The bot owner no longer receives automatic Discord management-panel permissions. Add the owner’s Discord user ID here like any other user. Discord server administrators still retain their Discord administrator rights.')}</p><div id="managed-grants" class="managed-grants" data-lang="${esc(lang)}" data-next-index="${grants.length}">${grantRows}</div></div>
    <div class="span2 managed-config-block"><div class="row between"><strong>${tr(lang,'Dynamic Name','Dynamic Name')}</strong><span class="badge ${bot.dynamicNameEnabled===true?'online':'neutral'}">${bot.dynamicNameEnabled===true?tr(lang,'AN','ON'):tr(lang,'AUS','OFF')}</span></div><p class="muted small">${tr(lang,'Ändert den echten WARDOGS-Servernamen automatisch. Alle Teilfunktionen sind einzeln schaltbar. Priorität: Seeding überschreibt Stats; die 2-Namen-Rotation liefert den Basisnamen für Stats/Seeding. Beim Abschalten wird der ursprüngliche Servername wiederhergestellt.','Automatically changes the real WARDOGS server name. Every sub-feature can be enabled separately. Priority: seeding overrides stats; the two-name rotation provides the base name used by stats/seeding. Disabling restores the original server name.')}</p><label class="check"><input type="checkbox" name="dynamicNameEnabled" value="1" ${bot.dynamicNameEnabled===true?'checked':''}> <strong>${tr(lang,'Dynamic Name aktivieren','Enable Dynamic Name')}</strong></label><div class="managed-config-block"><label class="check"><input type="checkbox" name="dynamicNameStatsEnabled" value="1" ${bot.dynamicNameStatsEnabled===true?'checked':''}> <strong>${tr(lang,'Stats im Servernamen','Stats in server name')}</strong></label><label>${tr(lang,'Stats-Format','Stats format')}<input name="dynamicNameStatsTemplate" maxlength="96" value="${esc(bot.dynamicNameStatsTemplate||'{base} | {score1} | {score2} | {score3}')}" placeholder="{base} | {score1} | {score2} | {score3}"><span class="muted small">${tr(lang,'Variablen: {base}, {players}, {max}, {map}, {scores}, {team1}–{team6}, {score1}–{score6}','Variables: {base}, {players}, {max}, {map}, {scores}, {team1}–{team6}, {score1}–{score6}')}</span></label></div><div class="managed-config-block"><label class="check"><input type="checkbox" name="dynamicNameSeedingEnabled" value="1" ${bot.dynamicNameSeedingEnabled===true?'checked':''}> <strong>${tr(lang,'Seeding-Name nach Spielerzahl','Seeding name by player count')}</strong></label><div class="managed-add-row"><label>${tr(lang,'Ab Spieler','Min players')}<input name="dynamicNameSeedingMinPlayers" type="number" min="1" max="512" value="${esc(bot.dynamicNameSeedingMinPlayers??1)}"></label><label>${tr(lang,'Bis Spieler','Max players')}<input name="dynamicNameSeedingMaxPlayers" type="number" min="0" max="512" value="${esc(bot.dynamicNameSeedingMaxPlayers??20)}"></label></div><label>${tr(lang,'Seeding-Name / Format','Seeding name / format')}<input name="dynamicNameSeedingTemplate" maxlength="96" value="${esc(bot.dynamicNameSeedingTemplate||'JOIN SEEDING')}" placeholder="JOIN SEEDING"><span class="muted small">${tr(lang,'Beispiel: 1–20 Spieler → JOIN SEEDING. Variablen wie {players}/{max} sind erlaubt.','Example: 1–20 players → JOIN SEEDING. Variables such as {players}/{max} are supported.')}</span></label></div><div class="managed-config-block"><label class="check"><input type="checkbox" name="dynamicNameRotationEnabled" value="1" ${bot.dynamicNameRotationEnabled===true?'checked':''}> <strong>${tr(lang,'Zwischen zwei Namen wechseln','Rotate between two names')}</strong></label><div class="managed-add-row"><label>${tr(lang,'Name A','Name A')}<input name="dynamicNameRotationNameA" maxlength="96" value="${esc(bot.dynamicNameRotationNameA||'')}" placeholder="[EU1] WARDOGS"></label><label>${tr(lang,'Name B','Name B')}<input name="dynamicNameRotationNameB" maxlength="96" value="${esc(bot.dynamicNameRotationNameB||'')}" placeholder="JOIN OUR DISCORD"></label><label>${tr(lang,'Wechsel alle X Minuten','Switch every X minutes')}<input name="dynamicNameRotationMinutes" type="number" min="1" max="1440" value="${esc(bot.dynamicNameRotationMinutes||5)}"></label></div></div>${rt.dynamicNameCurrent?`<div class="help"><strong>${tr(lang,'Aktueller Dynamic Name','Current Dynamic Name')}:</strong> ${esc(rt.dynamicNameCurrent)}</div>`:''}${rt.dynamicNameLastError?`<div class="warning"><strong>Dynamic Name:</strong> ${esc(rt.dynamicNameLastError)}</div>`:''}</div>
    <label>${tr(lang,'Prüfintervall','Poll interval')}<input name="pollSeconds" type="number" min="10" max="300" value="${esc(bot.pollSeconds||20)}"><span class="muted small">10–300 s</span></label>
    <label class="check"><input type="checkbox" name="enabled" value="1" ${bot.enabled?'checked':''}> ${tr(lang,'Bot aktiv / gehostet','Bot enabled / hosted')}</label>
    <label class="check"><input type="checkbox" name="autoRecoveryEnabled" value="1" ${bot.autoRecoveryEnabled!==false?'checked':''}> ${tr(lang,'Auto-Recovery','Auto recovery')}</label>
    <label class="check span2 auto-ban-toggle"><input type="checkbox" name="autoBanEnabled" value="1" ${auto?'checked':''}> <strong>${tr(lang,'Auto-Ban AKTIVIEREN','ENABLE auto-ban')}</strong> · ${tr(lang,'Standard ist AUS. Nur bei Regel-Treffern wird automatisch gebannt.','Default is OFF. Automatic bans happen only on matching rules.')}</label>
    <label class="check span2"><input type="checkbox" name="announcementEnabled" value="1" ${bot.announcementEnabled===true?'checked':''}> <strong>${tr(lang,'Automatische Server-Announcements aktivieren','Enable scheduled server announcements')}</strong></label>
    <label>${tr(lang,'Announcement-Intervall','Announcement interval')}<input name="announcementIntervalMinutes" type="number" min="1" max="1440" value="${esc(bot.announcementIntervalMinutes||15)}"><span class="muted small">1–1440 min</span></label>
    <label class="span2">${tr(lang,'Automatische Announcements','Scheduled announcements')}<textarea name="announcementMessages" rows="5" maxlength="10050" placeholder="Welcome to our server!&#10;Read the rules in Discord.&#10;Have fun!">${esc(bot.announcementMessages||'')}</textarea><span class="muted small">${tr(lang,'Eine Nachricht pro Zeile, maximal 200 Zeichen. Die Nachrichten rotieren automatisch.','One message per line, maximum 200 characters. Messages rotate automatically.')}</span></label>
    <label class="check span2"><input type="checkbox" name="welcomeWhisperEnabled" value="1" ${bot.welcomeWhisperEnabled===true?'checked':''}> <strong>${tr(lang,'Welcome-Whisper bei jedem Join aktivieren','Enable welcome whisper on every join')}</strong></label>
    <label class="span2">${tr(lang,'Welcome-Whisper','Welcome whisper')}<textarea name="welcomeWhisperMessage" rows="3" maxlength="200" placeholder="Hello {player}, welcome to the server! Join our Discord: discord.gg/example">${esc(bot.welcomeWhisperMessage||'Hello {player}, welcome to the server! Join our Discord.')}</textarea><span class="muted small">${tr(lang,'Variablen: {player}, {steamid}, {faction}. Versand erst nach einer erkannten Teamauswahl nach dem Join: echte Server-Fraktion, zwei stabile Prüfungen und kurzer Spawn-Puffer – auch während Seeding / Waiting for Players.','Variables: {player}, {steamid}, {faction}. Sent only after a post-join team-selection transition is confirmed: real server faction, two stable checks and a short spawn settle – including during seeding / Waiting for Players.')}</span></label>
    ${u.role==='admin'?`<label class="check span2"><input type="checkbox" name="allowPrivateTarget" value="1" ${bot.allowPrivateTarget?'checked':''}> ${tr(lang,'Private/LAN WARDOGS-Ziele erlauben (Admin)','Allow private/LAN WARDOGS targets (admin)')}</label>`:''}
    <div class="span2 managed-config-block"><strong>${tr(lang,'Ban-Nachrichten','Ban messages')}</strong><label>${tr(lang,'Discord Server / Invite-Link','Discord server / invite link')}<input name="banDiscordLink" maxlength="120" value="${esc(bot.banDiscordLink||'')}" placeholder="https://discord.gg/example"></label></div>
    <div class="span2 managed-config-block"><strong>Dynamic Ban</strong>${communityMember?`<p class="muted small"><strong>${communityOwner?tr(lang,'Community-Einstellung (du bist Owner)','Community setting (you are owner)'):tr(lang,'Von der Ban-Sync-Community gesteuert','Controlled by the Ban Sync Community')}</strong> · ${communityOwner?tr(lang,'Änderungen hier werden automatisch auf alle Community-Mitglieder übernommen.','Changes here are automatically applied to every community member.'):tr(lang,'Nur der Community-Owner kann diese Werte ändern.','Only the community owner can change these values.')}</p>`:''}<label class="check"><input type="checkbox" name="dynamicBanEnabled" value="1" ${dynamicPolicy.enabled?'checked':''} ${dynamicLocked?'disabled':''}> <strong>${tr(lang,'Temporäre Bans als Dynamic Ban ausführen','Use Dynamic Ban for temporary bans')}</strong></label><p class="muted small">${tr(lang,'Dynamic Ban setzt zunächst keinen Game-/WARDOGS-Ban. Der Spieler wird bei jedem erneuten Join gekickt, solange die eingestellte Ban-Zeit läuft. Rejoint derselbe Spieler zu oft im eingestellten Zeitfenster, wird er für den REST der ursprünglichen Laufzeit in einen normalen WARDOGS-Ban eskaliert. Die Ablaufzeit wird dabei niemals verlängert. Das ist nützlich, weil ein normaler Game-Ban beim erneuten Connect nicht immer eine verständliche Ban-Nachricht zeigt.','Dynamic Ban initially creates no game/WARDOGS ban. The player is kicked on every rejoin while the configured ban duration is active. If the same player rejoins too often inside the configured window, the ban escalates to a normal WARDOGS ban only for the REMAINDER of the original duration. The expiry is never extended. This is useful because a normal game ban does not always show a useful ban message on reconnect.')}</p><div class="managed-add-row"><label>${tr(lang,'Eskalation nach Joins','Escalate after joins')}<input name="dynamicBanEscalateJoins" type="number" min="2" max="20" value="${esc(dynamicPolicy.joins)}" ${dynamicLocked?'disabled':''}></label><label>${tr(lang,'Zeitfenster (Minuten)','Window (minutes)')}<input name="dynamicBanEscalateWindowMinutes" type="number" min="1" max="1440" value="${esc(dynamicPolicy.window)}" ${dynamicLocked?'disabled':''}></label></div></div>
    <div class="span2 managed-config-block"><strong>Ban Sync Community</strong><p class="muted small">${tr(lang,'Mehrere Management Bots können einer gemeinsamen, passwortgeschützten Ban-Sync-Community beitreten. Bans und Unbans werden zwischen allen Mitgliedern gespiegelt. Dynamic-Ban-Einstellungen werden zentral vom Community-Owner vorgegeben. Erstellen/Beitreten findest du weiter unten im Community Browser.','Multiple management bots can join one shared, password-protected Ban Sync Community. Bans and unbans are mirrored across all members. Dynamic Ban settings are centrally controlled by the community owner. Create/join it in the Community Browser below.')}</p><label>${tr(lang,'Aktuelle BOT ID','Current BOT ID')}<input type="text" readonly value="${esc(bot.id)}" onclick="this.select()" aria-label="${tr(lang,'Aktuelle BOT ID','Current BOT ID')}"></label></div>
    <div class="span2 managed-config-block"><div class="row between"><strong>${tr(lang,'Ban Templates','Ban templates')}</strong><button class="button ghost smallbtn" type="button" id="add-ban-template">+ Template</button></div><div id="managed-ban-templates" data-next-index="${managedBanTemplates(bot).length||1}">${banTemplateRows}</div></div>
    <div class="span2 managed-config-block"><div class="row between"><strong>${tr(lang,'Steam Detection Rules','Steam detection rules')}</strong><button class="button ghost smallbtn" type="button" id="add-managed-rule">+ ${tr(lang,'Regel','Rule')}</button></div><div class="managed-steam-settings"><label>${tr(lang,'Steam Web API Key','Steam Web API key')}<input name="steamWebApiKey" type="password" autocomplete="new-password" placeholder="${bot.steamWebApiKeyEnc?tr(lang,'Leer lassen = unverändert','Leave blank = unchanged'):hasGlobalSteamKey?tr(lang,'Globaler Key ist konfiguriert','Global key is configured'):tr(lang,'Für Steam-Regeln erforderlich','Required for Steam rules')}"></label></div><div id="managed-rules" class="managed-rules" data-lang="${esc(lang)}" data-next-index="${rules.length}">${ruleRows||`<div class="muted small managed-rule-empty">${tr(lang,'Noch keine Detection Rule aktiv.','No detection rule active yet.')}</div>`}</div></div>
    <div class="span2 actions wrap"><button class="button primary" type="submit">${tr(lang,'Speichern','Save')}</button><button class="button ghost" type="submit" formaction="/bot-services/${encodeURIComponent(service.id)}/test">${tr(lang,'Verbindung testen','Test connection')}</button>${bot.enabled?`<button class="button ghost" type="submit" formaction="/managed-bots/${esc(bot.id)}/restart">${tr(lang,'Neu starten','Restart')}</button><button class="button danger" type="submit" formaction="/managed-bots/${esc(bot.id)}/stop">Stop</button>`:`<button class="button success" type="submit" formaction="/managed-bots/${esc(bot.id)}/restart">${tr(lang,'Starten','Start')}</button>`}<span class="badge ${rt.state==='online'?'online':rt.state==='error'?'error':'neutral'}">${esc(rt.state||'stopped')}</span></div>
    ${bot.welcomeWhisperEnabled===true?`<div class="span2 help"><strong>Welcome Watcher:</strong> ${rt.welcomeWatcherLastPollAt?tr(lang,'aktiv','active'):tr(lang,'wartet auf ersten Poll','waiting for first poll')} · ${tr(lang,'Spieler','players')}: ${esc(rt.welcomeWatcherPlayers??'—')} · Queue: ${esc(rt.welcomeWatcherPending??0)} · ${tr(lang,'wartet auf Teamauswahl','waiting for team selection')}: ${esc(rt.welcomeWatcherWaitingForFaction??0)}${rt.lastWelcomeJoinDetectedAt?` · ${tr(lang,'letzter Join erkannt','last join detected')}: ${esc(rt.lastWelcomeJoinDetectedPlayer||'player')} (${esc(new Date(rt.lastWelcomeJoinDetectedAt).toLocaleTimeString(localeCode(lang)))})`:''}${rt.lastWelcomeWhisperAt?` · ${tr(lang,'letzter Whisper','last whisper')}: ${esc(rt.lastWelcomeWhisperPlayer||'player')} (${esc(new Date(rt.lastWelcomeWhisperAt).toLocaleTimeString(localeCode(lang)))})`:''}</div>`:''}
    ${rt.lastError?`<div class="span2 warning"><strong>Runtime:</strong> ${esc(rt.lastError)}</div>`:''}${rt.lastSteamError?`<div class="span2 warning"><strong>Steam Check:</strong> ${esc(rt.lastSteamError)}</div>`:''}${rt.lastPanelError?`<div class="span2 warning"><strong>Discord Panel:</strong> ${esc(rt.lastPanelError)}</div>`:''}${rt.welcomeWatcherLastPollError?`<div class="span2 warning"><strong>Welcome Watcher:</strong> ${esc(rt.welcomeWatcherLastPollError)}</div>`:''}${rt.lastWelcomeWhisperError?`<div class="span2 warning"><strong>Welcome Whisper:</strong> ${esc(rt.lastWelcomeWhisperError)}</div>`:''}
  </form>
  <section class="panel managed-config-block"><div class="row between"><strong>${tr(lang,'Config Export / Import','Config export / import')}</strong><a class="button ghost smallbtn" href="/managed-bots/${esc(bot.id)}/config/export">${tr(lang,'Config exportieren','Export config')}</a></div><form method="post" enctype="multipart/form-data" action="/managed-bots/${esc(bot.id)}/config/import" class="managed-add-row"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><input type="file" name="config" accept="application/json,.json" required><button class="button ghost smallbtn">${tr(lang,'Config importieren','Import config')}</button></form></section>
  <script src="/managed.js?v=3.12.45" defer></script>`;
}


function trackedDuration(seconds) {
  const total=Math.max(0,Math.floor(Number(seconds)||0)),hours=Math.floor(total/3600),minutes=Math.floor((total%3600)/60);
  return `${hours.toLocaleString('de-DE')}h ${minutes}m`;
}
function managedServerRowHtml(req,row,index,bot){
  const lang=langOf(req),configured=Boolean(row?.killFeedConfiguredAt),live=Boolean(row?.killFeedLastEventAt);
  return `<div class="managed-config-block managed-server-row" data-managed-server-row>
    <input type="hidden" name="managedServerPresent_${index}" value="1"><input type="hidden" name="managedServerId_${index}" value="${esc(row?.id||'')}">
    <div class="row between"><strong>${tr(lang,'Gameserver','Game server')} ${index+1}</strong><div class="actions wrap"><span class="badge ${live?'online':configured?'neutral':'error'}">${live?tr(lang,'Feed aktiv','feed active'):configured?tr(lang,'Feed konfiguriert','feed configured'):tr(lang,'Feed aus','feed off')}</span><button type="button" class="button danger smallbtn" data-remove-managed-server>×</button></div></div>
    <div class="formgrid compact">
      <label>${tr(lang,'Server-Name im Panel','Server label')}<input name="managedServerLabel_${index}" maxlength="80" value="${esc(row?.label||`Server ${index+1}`)}" placeholder="EU1"></label>
      <label>WARDOGS API / RCON URL<input name="managedServerUrl_${index}" required value="${esc(row?.baseUrl||'')}" placeholder="http://server.example.com:7776"></label>
      <label>WARDOGS RCON / Bearer Password<input name="managedServerSecret_${index}" type="password" autocomplete="new-password" placeholder="${row?.secretEnc?tr(lang,'Leer lassen = unverändert','Leave blank = unchanged'):tr(lang,'Pflichtfeld','Required')}"></label>
      <label>Discord Alert Channel ID<input name="managedServerAlertChannelId_${index}" inputmode="numeric" required value="${esc(row?.alertChannelId||'')}" placeholder="123456789012345678"></label>
      <label class="check"><input type="checkbox" name="managedServerControlPanelEnabled_${index}" value="1" ${row?.controlPanelEnabled===true?'checked':''}> <strong>${tr(lang,'Discord Management Panel für diesen Server','Discord management panel for this server')}</strong></label>
      <label>Discord Management Panel Channel ID<input name="managedServerControlPanelChannelId_${index}" inputmode="numeric" value="${esc(row?.controlPanelChannelId||'')}" placeholder="123456789012345678"></label>
    </div>
    <p class="muted small">${tr(lang,'Alerts und das feste Discord-Management-Panel dieses Gameservers werden ausschließlich in den hier eingetragenen Channels verwendet.','Alerts and the fixed Discord management panel for this game server use only the channels configured here.')}</p>
    ${bot?.id?`<button class="button ghost smallbtn" type="submit" formaction="/managed-bots/${esc(bot.id)}/management-feed/setup/${encodeURIComponent(row?.id||'')}" formmethod="post">${configured?tr(lang,'Server Feed erneut konfigurieren','Configure server feed again'):tr(lang,'Server Feed konfigurieren','Configure server feed')}</button>`:''}
    ${row?.killFeedNeedsGameRestart?`<div class="warning small"><strong>${tr(lang,'Gameserver-Neustart nötig','Game-server restart required')}</strong> · ${tr(lang,'für den WARDOGS Server Feed.','for the WARDOGS Server Feed.')}</div>`:''}
  </div>`;
}

function managedServersFromBody(req,bot) {
  const existing=normalizeManagedServers(bot),byId=new Map(existing.map((row)=>[row.id,row])),byUrl=new Map(existing.map((row)=>[String(row.baseUrl||'').toLowerCase(),row]));
  const indexes=[...new Set(Object.keys(req.body||{}).map((key)=>{const m=key.match(/^managedServerPresent_(\d+)$/);return m?Number(m[1]):null;}).filter((x)=>Number.isInteger(x)))].sort((a,b)=>a-b).slice(0,12);
  if(!indexes.length)throw new Error(l(req,'Mindestens ein WARDOGS Gameserver ist erforderlich.','At least one WARDOGS game server is required.'));
  const rows=[]; const usedChannels=new Set();
  for(const [position,i] of indexes.entries()){
    const rawId=String(req.body[`managedServerId_${i}`]||'').trim();
    const label=String(req.body[`managedServerLabel_${i}`]||'').trim().slice(0,80)||`Server ${position+1}`;
    const base=String(req.body[`managedServerUrl_${i}`]||'').trim().replace(/\/+$/,'');
    if(!/^https?:\/\//i.test(base))throw new Error(l(req,`${label}: WARDOGS URL muss mit http:// oder https:// beginnen.`,`${label}: WARDOGS URL must start with http:// or https://.`));
    const previous=byId.get(rawId)||byUrl.get(base.toLowerCase())||null;
    const id=previous?.id||crypto.randomUUID();
    const secret=String(req.body[`managedServerSecret_${i}`]||'').trim();
    const secretEnc=secret?encryptSecret(secret):String(previous?.secretEnc||'');
    if(!secretEnc)throw new Error(l(req,`${label}: RCON/API Passwort fehlt.`,`${label}: RCON/API password is required.`));
    const alertChannelId=String(req.body[`managedServerAlertChannelId_${i}`]||'').trim();
    if(!validSnowflake(alertChannelId))throw new Error(l(req,`${label}: Discord Alert Channel ID ist ungültig.`,`${label}: Discord alert channel ID is invalid.`));
    const controlPanelEnabled=req.body[`managedServerControlPanelEnabled_${i}`]==='1';
    const controlPanelChannelId=String(req.body[`managedServerControlPanelChannelId_${i}`]||'').trim();
    if(controlPanelChannelId&&!validSnowflake(controlPanelChannelId))throw new Error(l(req,`${label}: Discord Management Panel Channel ID ist ungültig.`,`${label}: Discord management panel channel ID is invalid.`));
    if(controlPanelEnabled&&!controlPanelChannelId)throw new Error(l(req,`${label}: Für das Discord Management Panel muss eine Channel ID eingetragen sein.`,`${label}: A channel ID is required when the Discord management panel is enabled.`));
    for(const channel of [alertChannelId,controlPanelEnabled?controlPanelChannelId:''].filter(Boolean)){
      if(usedChannels.has(channel))throw new Error(l(req,`${label}: Jeder Alert-/Management-Channel darf nur einem Gameserver dieses Bots zugeordnet sein.`,`${label}: Every alert/management channel must belong to only one game server in this bot.`));
      usedChannels.add(channel);
    }
    if(rows.some((row)=>row.baseUrl.toLowerCase()===base.toLowerCase()))throw new Error(l(req,`${label}: Dieser WARDOGS Server wurde doppelt eingetragen.`,`${label}: This WARDOGS server was added twice.`));
    const sameTarget=Boolean(previous&&String(previous.baseUrl||'').toLowerCase()===base.toLowerCase());
    rows.push({
      id,label,baseUrl:base,secretEnc,alertChannelId,controlPanelEnabled,controlPanelChannelId,
      controlPanelMessageId:sameTarget?String(previous?.controlPanelMessageId||''):'',controlPanelMessageChannelId:sameTarget?String(previous?.controlPanelMessageChannelId||''):'',
      dynamicNameOriginalName:sameTarget?String(previous?.dynamicNameOriginalName||''):'',dynamicNameLastAppliedName:sameTarget?String(previous?.dynamicNameLastAppliedName||''):'',
      killFeedTokenEnc:sameTarget?String(previous?.killFeedTokenEnc||''):'',killFeedConfiguredAt:sameTarget?(previous?.killFeedConfiguredAt||null):null,killFeedPublicUrl:sameTarget?String(previous?.killFeedPublicUrl||''):'',
      killFeedNeedsGameRestart:sameTarget&&previous?.killFeedNeedsGameRestart===true,killFeedLastEventAt:sameTarget?(previous?.killFeedLastEventAt||null):null,killFeedEvents:sameTarget&&Array.isArray(previous?.killFeedEvents)?previous.killFeedEvents.slice(-150):[]
    });
  }
  return rows;
}

function playtimeServersFromBody(req,bot) {
  const existing=playtimeTrackerServers(bot),byId=new Map(existing.map((row)=>[row.id,row])),byUrl=new Map(existing.map((row)=>[String(row.baseUrl||'').toLowerCase(),row]));
  const indexes=[...new Set(Object.keys(req.body||{}).map((key)=>{const m=key.match(/^trackerServerPresent_(\d+)$/);return m?Number(m[1]):null;}).filter((x)=>Number.isInteger(x)))].sort((a,b)=>a-b).slice(0,12);
  if(!indexes.length)throw new Error(l(req,'Mindestens ein WARDOGS Server ist erforderlich.','At least one WARDOGS server is required.'));
  const rows=[];
  for(const [position,i] of indexes.entries()){
    const rawId=String(req.body[`trackerServerId_${i}`]||'').trim();
    const label=String(req.body[`trackerServerLabel_${i}`]||'').trim().slice(0,80)||`Server ${position+1}`;
    const base=String(req.body[`trackerServerUrl_${i}`]||'').trim().replace(/\/+$/,'');
    if(!/^https?:\/\//i.test(base))throw new Error(l(req,`${label}: WARDOGS URL muss mit http:// oder https:// beginnen.`,`${label}: WARDOGS URL must start with http:// or https://.`));
    const previous=byId.get(rawId)||byUrl.get(base.toLowerCase())||null;
    const id=previous?.id||crypto.randomUUID();
    const secret=String(req.body[`trackerServerSecret_${i}`]||'').trim();
    const secretEnc=secret?encryptSecret(secret):String(previous?.secretEnc||'');
    if(!secretEnc)throw new Error(l(req,`${label}: RCON/API Passwort fehlt.`,`${label}: RCON/API password is required.`));
    const killFeedChannelId=String(req.body[`trackerServerKillFeedChannelId_${i}`]||'').trim();
    if(killFeedChannelId&&!validSnowflake(killFeedChannelId))throw new Error(l(req,`${label}: Discord Killfeed Channel ID ist ungültig.`,`${label}: Discord killfeed channel ID is invalid.`));
    if(rows.some((row)=>row.baseUrl.toLowerCase()===base.toLowerCase()))throw new Error(l(req,`${label}: Dieser Server wurde doppelt eingetragen.`,`${label}: This server was added twice.`));
    rows.push({
      id,label,baseUrl:base,secretEnc,killFeedChannelId,
      killFeedMessageId:String(previous?.killFeedMessageId||''),killFeedTokenEnc:String(previous?.killFeedTokenEnc||''),
      killFeedConfiguredAt:previous?.killFeedConfiguredAt||null,killFeedPublicUrl:String(previous?.killFeedPublicUrl||''),
      killFeedNeedsGameRestart:previous?.killFeedNeedsGameRestart===true,killFeedLastEventAt:previous?.killFeedLastEventAt||null,
      killFeedLastPublishedAt:previous?.killFeedLastPublishedAt||null,killFeedEvents:Array.isArray(previous?.killFeedEvents)?previous.killFeedEvents.slice(-150):[]
    });
  }
  return rows;
}

function playtimeTrackerServerRow(req,row,index,botId='') {
  const lang=langOf(req),hasSecret=Boolean(row?.secretEnc),configured=Boolean(row?.killFeedTokenEnc&&row?.killFeedConfiguredAt);
  const lastEvent=row?.killFeedLastEventAt?new Date(row.killFeedLastEventAt).toLocaleString(localeCode(lang)):'—';
  return `<div class="managed-config-block playtime-server-row" data-playtime-server-row>
    <input type="hidden" name="trackerServerPresent_${index}" value="1"><input type="hidden" name="trackerServerId_${index}" value="${esc(row?.id||'')}">
    <div class="row between"><strong>${tr(lang,'WARDOGS Server','WARDOGS server')} ${index+1} · ${esc(row?.label||`Server ${index+1}`)}</strong><div class="chips"><span class="badge ${configured?'online':'neutral'}">${configured?tr(lang,'Killfeed konfiguriert','killfeed configured'):tr(lang,'Killfeed aus','killfeed off')}</span><button type="button" class="button danger smallbtn" data-remove-playtime-server>×</button></div></div>
    <div class="formgrid inner">
      <label>${tr(lang,'Name','Name')}<input name="trackerServerLabel_${index}" maxlength="80" required value="${esc(row?.label||`Server ${index+1}`)}" placeholder="EU1"></label>
      <label>WARDOGS API / RCON URL<input name="trackerServerUrl_${index}" required value="${esc(row?.baseUrl||'')}" placeholder="http://server.example.com:7776"></label>
      <label class="span2">WARDOGS RCON / Bearer Password<input name="trackerServerSecret_${index}" type="password" autocomplete="new-password" placeholder="${hasSecret?tr(lang,'Leer lassen = unverändert','Leave blank = unchanged'):tr(lang,'Pflichtfeld','Required')}"></label>
      <label class="span2">${tr(lang,'Discord Killfeed Channel ID','Discord killfeed channel ID')} (${tr(lang,'optional','optional')})<input name="trackerServerKillFeedChannelId_${index}" inputmode="numeric" maxlength="20" value="${esc(row?.killFeedChannelId||'')}" placeholder="123456789012345678"><span class="muted small">${tr(lang,'Dieser Server bekommt genau ein festes Discord-Killfeed-Panel mit den letzten 15 Kills.','This server gets exactly one fixed Discord killfeed panel showing its latest 15 kills.')}</span></label>
    </div>
    <div class="row between wrap"><span class="muted small">${tr(lang,'Letztes Kill-Event','Last kill event')}: ${esc(lastEvent)}${row?.killFeedNeedsGameRestart?` · <strong>${tr(lang,'Gameserver-Neustart nötig','game-server restart required')}</strong>`:''}</span>${row?.id?`<button class="button ghost smallbtn" type="submit" formaction="/managed-bots/${esc(botId)}/killfeed/setup/${esc(row.id)}">${configured?tr(lang,'Kill Feed neu konfigurieren','Reconfigure Kill Feed'):tr(lang,'Kill Feed konfigurieren','Configure Kill Feed')}</button>`:''}</div>
  </div>`;
}
function playtimeTrackerForm(req,service,bot) {
  const lang=langOf(req),u=currentUser(req),rt=playtimeBotRuntime(bot.id);
  const servers=playtimeTrackerServers(bot); if(!servers.length)servers.push({id:'',label:'Server 1',baseUrl:'',secretEnc:''});
  const serverRows=servers.map((row,i)=>playtimeTrackerServerRow(req,row,i,bot.id)).join('');
  return `<form method="post" action="/bot-services/${encodeURIComponent(service.id)}/manage" class="panel formgrid" id="playtime-tracker-config">
    <input type="hidden" name="_csrf" value="${esc(csrf(req))}"><input type="hidden" name="botId" value="${esc(bot.id)}">
    <label>${tr(lang,'Bot-Name','Bot name')}<input name="name" maxlength="80" required value="${esc(bot.name||service.nameDe||service.nameEn||'WARDOGS Status Bot')}"></label>
    <label>Discord Bot Token <span class="required">*</span><input name="botToken" type="password" autocomplete="new-password" placeholder="${bot.botTokenEnc?tr(lang,'Leer lassen = unverändert','Leave blank = unchanged'):tr(lang,'Pflicht für Discord Killfeed, Slash Commands und Top-15 Leaderboard','Required for Discord killfeed, slash commands and Top-15 leaderboard')}"></label>
    <div class="span2 help"><strong>WARDOGS Status Bot:</strong> ${tr(lang,'Jeder eingetragene Gameserver hat seinen eigenen festen Discord-Killfeed mit den letzten 15 Kills. Discord↔Game-Verknüpfung per /linkgame, /status, /whois, /whoisplayer und /playerstats laufen über denselben Bot. /leaderboard zeigt die Top 15 pro Kategorie als Webpanel-ähnliche Grafik mit Spielersuche und exakter Platzierung; optional kann dieselbe Grafik als feste Nachricht in einem Channel stehen.','Every configured game server has its own fixed Discord killfeed with the latest 15 kills. Discord↔game linking via /linkgame, /status, /whois, /whoisplayer and /playerstats run through the same bot. /leaderboard shows the Top 15 per category as a web-panel-style graphic with player search and exact ranking; optionally the same graphic can stay as a fixed channel message.')}</div>
    <div class="span2 managed-config-block"><div class="row between"><strong>${tr(lang,'WARDOGS Server · Status, Killfeed & Stats','WARDOGS servers · status, killfeed & stats')}</strong><button type="button" class="button ghost smallbtn" id="add-playtime-server">+ ${tr(lang,'Server','Server')}</button></div><div id="playtime-servers" data-next-index="${servers.length}">${serverRows}</div></div>
    <label>${tr(lang,'Prüfintervall','Poll interval')}<input name="pollSeconds" type="number" min="10" max="300" value="${esc(bot.pollSeconds||30)}"><span class="muted small">10–300 s</span></label>
    <label>${tr(lang,'Statistik-Zeitzone','Statistics timezone')}<input name="statsTimezone" maxlength="80" value="${esc(bot.statsTimezone||'Europe/Vienna')}" placeholder="Europe/Vienna"></label>
    <label class="span2">Discord Top-15 Leaderboard Channel ID (${tr(lang,'optional','optional')})<input name="leaderboardChannelId" inputmode="numeric" value="${esc(bot.leaderboardChannelId||'')}" placeholder="123456789012345678"></label>
    <label class="check"><input type="checkbox" name="enabled" value="1" ${bot.enabled?'checked':''}> ${tr(lang,'WARDOGS Status Bot aktiv / gehostet','WARDOGS Status Bot enabled / hosted')}</label>
    <label class="check"><input type="checkbox" name="autoRecoveryEnabled" value="1" ${bot.autoRecoveryEnabled!==false?'checked':''}> ${tr(lang,'Auto-Recovery','Auto recovery')}</label>
    ${u.role==='admin'?`<label class="check span2"><input type="checkbox" name="allowPrivateTarget" value="1" ${bot.allowPrivateTarget?'checked':''}> ${tr(lang,'Private/LAN WARDOGS-Ziele erlauben (Admin)','Allow private/LAN WARDOGS targets (admin)')}</label>`:''}
    <div class="span2 actions wrap"><button class="button primary" type="submit">${tr(lang,'Speichern','Save')}</button><button class="button ghost" type="submit" formaction="/bot-services/${encodeURIComponent(service.id)}/test">${tr(lang,'Verbindung testen','Test connection')}</button>${bot.enabled?`<button class="button ghost" type="submit" formaction="/managed-bots/${esc(bot.id)}/restart">${tr(lang,'Neu starten','Restart')}</button><button class="button danger" type="submit" formaction="/managed-bots/${esc(bot.id)}/stop">Stop</button>`:`<button class="button success" type="submit" formaction="/managed-bots/${esc(bot.id)}/restart">${tr(lang,'Starten','Start')}</button>`}<span class="badge ${rt.state==='online'?'online':['error','auth-locked'].includes(rt.state)?'error':'neutral'}">${esc(rt.state||'stopped')}</span></div>
    ${!bot.botTokenEnc?`<div class="span2 warning"><strong>Discord:</strong> ${tr(lang,'Für /linkgame, /status, /whois, /whoisplayer, /playerstats, /leaderboard und das feste Discord-Leaderboard einen Discord Bot Token hinterlegen.','Add a Discord Bot Token for /linkgame, /status, /whois, /whoisplayer, /playerstats, /leaderboard and the fixed Discord leaderboard.')}</div>`:''}${rt.lastError?`<div class="span2 warning"><strong>Runtime:</strong> ${esc(rt.lastError)}</div>`:''}${rt.lastLeaderboardError?`<div class="span2 warning"><strong>Discord Leaderboard:</strong> ${esc(rt.lastLeaderboardError)}</div>`:''}${rt.slashCommandError?`<div class="span2 warning"><strong>Discord Slash Commands:</strong> ${esc(rt.slashCommandError)}</div>`:''}
  </form><section class="panel managed-config-block"><div class="row between"><strong>${tr(lang,'Config Export / Import','Config export / import')}</strong><a class="button ghost smallbtn" href="/managed-bots/${esc(bot.id)}/config/export">${tr(lang,'Config exportieren','Export config')}</a></div><form method="post" enctype="multipart/form-data" action="/managed-bots/${esc(bot.id)}/config/import" class="managed-add-row"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><input type="file" name="config" accept="application/json,.json" required><button class="button ghost smallbtn">${tr(lang,'Config importieren','Import config')}</button></form></section>
  <script>(()=>{const box=document.getElementById('playtime-servers'),add=document.getElementById('add-playtime-server');if(!box||!add)return;const remove=(b)=>{if(box.querySelectorAll('[data-playtime-server-row]').length<=1)return;b.closest('[data-playtime-server-row]')?.remove()};box.querySelectorAll('[data-remove-playtime-server]').forEach(b=>b.addEventListener('click',()=>remove(b)));add.addEventListener('click',()=>{const i=Number(box.dataset.nextIndex||0);if(box.querySelectorAll('[data-playtime-server-row]').length>=12)return;box.dataset.nextIndex=String(i+1);const wrap=document.createElement('div');wrap.innerHTML=${JSON.stringify(playtimeTrackerServerRow(req,{id:'',label:'',baseUrl:'',secretEnc:''},999,bot.id))}.replaceAll('_999','_'+i).replace('WARDOGS Server 1000','WARDOGS Server '+(i+1)).replace('WARDOGS server 1000','WARDOGS server '+(i+1)).replace('value="Server 1000"','value="Server '+(i+1)+'"');const row=wrap.firstElementChild;box.append(row);row.querySelector('[data-remove-playtime-server]')?.addEventListener('click',()=>remove(row.querySelector('[data-remove-playtime-server]')));});})();</script>`;
}
function playtimeStatsPanel(req,bot) {
  const snap=playtimeTrackerSnapshot(bot),token=esc(csrf(req));
  const combined=combinedStatsSnapshot(bot);
  const query=String(req.query.playerq||'').trim().slice(0,100);
  const selectedSteamId=normalizeSteamId64(String(req.query.playerid||''));
  const searchMatches=query?searchCombinedPlayers(combined,query):[];
  const selectedPlayer=selectedSteamId
    ? combined.players.find((row)=>row.steamId===selectedSteamId)
    : (searchMatches.length===1?searchMatches[0]:null);
  const ranks=selectedPlayer?leaderboardPositions(combined,selectedPlayer.steamId):{};
  const discordLink=selectedPlayer?(Array.isArray(bot.discordPlayerLinks)?bot.discordPlayerLinks:[]).find((row)=>String(row?.steamId||'')===selectedPlayer.steamId):null;
  const manageBase=`/bot-services/${encodeURIComponent(bot.serviceId)}/manage?bot=${encodeURIComponent(bot.id)}`;
  const medals=['🥇','🥈','🥉'];
  const leaderboardCards=(combined.categories||[]).map((category)=>{
    const rows=category.rows.slice(0,15).map((p,i)=>`<div class="leaderboard-entry"><span class="leaderboard-rank-badge ${i<3?'medal':''}">${medals[i]||`${i+1}.`}</span><a class="leaderboard-player" href="${manageBase}&playerid=${encodeURIComponent(p.steamId)}#leaderboard-player">${esc(p.name||p.steamId)}</a><strong class="leaderboard-value">${esc(category.format(p))}</strong></div>`).join('');
    return `<article class="leaderboard-category"><div class="leaderboard-category-head"><h3>${esc(category.label)}</h3><span>TOP 15</span></div><div class="leaderboard-entries">${rows||`<div class="leaderboard-empty">${l(req,'Noch keine Daten erfasst.','No data tracked yet.')}</div>`}</div></article>`;
  }).join('');
  const leaderboardSince=combined.startedAt?new Date(combined.startedAt).toLocaleDateString(localeCode(langOf(req)),{day:'numeric',month:'long',year:'numeric'}):l(req,'Start der Erfassung','tracking start');
  const rankLabels={kills:'Kills',deaths:l(req,'Tode','Deaths'),kd:'K/D',playtime:l(req,'Spielzeit','Playtime'),killrecord:l(req,'Kill-Rekord','Kill record'),headshots:'Headshot-Rate',wins:l(req,'Siege','Wins'),matches:'Matches',seeding:l(req,'Seeding-Zeit','Seeding time')};
  const rankChips=selectedPlayer?(combined.categories||[]).map((category)=>`<span class="badge neutral">${esc(rankLabels[category.id]||category.label)}: <strong>${ranks[category.id]?`#${esc(ranks[category.id])}`:'—'}</strong></span>`).join(''):'';
  const selectedHeadshotRate=selectedPlayer&&Number(selectedPlayer.kills||0)>=HEADSHOT_RATE_MIN_KILLS?`${esc((Number(selectedPlayer.headshotRate||0)*100).toLocaleString('de-DE',{minimumFractionDigits:1,maximumFractionDigits:1}))}%`:`<span class="leaderboard-locked">${l(req,`ab ${HEADSHOT_RATE_MIN_KILLS} Kills`,`from ${HEADSHOT_RATE_MIN_KILLS} kills`)} · ${esc(selectedPlayer?.kills||0)}/${HEADSHOT_RATE_MIN_KILLS}</span>`;
  const playerDetail=selectedPlayer?`<section class="panel leaderboard-player-detail status-stat-card" id="leaderboard-player"><div class="row between wrap"><div><span class="eyebrow">${l(req,'Spielerprofil & Leaderboard-Position','Player profile & leaderboard position')}</span><h2>${esc(selectedPlayer.name||selectedPlayer.steamId)}</h2><p class="muted small"><a href="https://steamcommunity.com/profiles/${esc(selectedPlayer.steamId)}" target="_blank" rel="noopener">${esc(selectedPlayer.steamId)}</a>${discordLink?` · Discord ID ${esc(discordLink.discordUserId)}`:''}</p></div><a class="button ghost smallbtn" href="${manageBase}#alltime-leaderboard">${l(req,'Auswahl schließen','Close selection')}</a></div><section class="leaderboard-player-stats"><article><span>Kills</span><strong>${esc(selectedPlayer.kills)}</strong></article><article><span>${l(req,'Tode','Deaths')}</span><strong>${esc(selectedPlayer.deaths)}</strong></article><article><span>K/D</span><strong>${esc(Number(selectedPlayer.kd||0).toLocaleString('de-DE',{minimumFractionDigits:2,maximumFractionDigits:2}))}</strong></article><article><span>${l(req,'Matches','Matches')}</span><strong>${esc(selectedPlayer.matchesPlayed||0)}</strong></article><article><span>${l(req,'Siege','Wins')}</span><strong>${esc(selectedPlayer.matchWins||0)} (${esc((Number(selectedPlayer.winRate||0)*100).toLocaleString('de-DE',{maximumFractionDigits:0}))}%)</strong></article><article><span>${l(req,'Kill-Rekord','Kill record')}</span><strong>${esc(selectedPlayer.killRecord||0)}</strong></article><article><span>${l(req,'Spielzeit','Playtime')}</span><strong>${esc(trackedDuration(selectedPlayer.totalSeconds))}</strong></article><article><span>${l(req,'Seeding','Seeding')}</span><strong>${esc(trackedDuration(selectedPlayer.seedingSeconds))}</strong></article><article><span>${l(req,'Fraktion','Faction')}</span><strong>${esc(selectedPlayer.lastFaction||'—')}</strong></article><article><span>Headshot-Rate</span><strong>${selectedHeadshotRate}</strong></article><article><span>${l(req,'Zuletzt gesehen','Last seen')}</span><strong class="compact-value">${selectedPlayer.lastSeenAt?esc(new Date(selectedPlayer.lastSeenAt).toLocaleString(localeCode(langOf(req)))):'—'}</strong></article></section><div class="chips leaderboard-ranks">${rankChips}</div></section>`:'';
  const candidateRows=query&&!selectedPlayer&&searchMatches.length>1?searchMatches.map((p)=>`<tr><td><strong>${esc(p.name||p.steamId)}</strong><div class="muted small">${esc(p.steamId)}${p.aliases?.length?` · ${l(req,'Aliase','aliases')}: ${esc(p.aliases.slice(0,3).join(', '))}`:''}</div></td><td>${esc(p.kills)}</td><td>${esc(Number(p.kd||0).toLocaleString('de-DE',{minimumFractionDigits:2,maximumFractionDigits:2}))}</td><td>${esc(trackedDuration(p.totalSeconds))}</td><td><a class="button primary smallbtn" href="${manageBase}&playerq=${encodeURIComponent(query)}&playerid=${encodeURIComponent(p.steamId)}#leaderboard-player">${l(req,'Auswählen','Select')}</a></td></tr>`).join(''):'';
  const searchResult=query&&!selectedPlayer&&searchMatches.length===0?`<div class="padded muted">${l(req,'Kein passender Spieler gefunden. Suche nach Name, Alias oder Steam64ID.','No matching player found. Search by name, alias or Steam64ID.')}</div>`:candidateRows?`<div class="padded warning"><strong>${l(req,'Mehrere Spieler gefunden.','Multiple players found.')}</strong> ${l(req,'Bitte zuerst den richtigen Spieler auswählen; es wird nicht automatisch irgendein Treffer angezeigt.','Select the correct player first; no arbitrary match is displayed automatically.')}</div><table><thead><tr><th>${l(req,'Spieler','Player')}</th><th>Kills</th><th>K/D</th><th>${l(req,'Spielzeit','Playtime')}</th><th></th></tr></thead><tbody>${candidateRows}</tbody></table>`:'';
  const hourRows=snap.hours.map((h)=>`<tr><td>${String(h.hour).padStart(2,'0')}:00–${String((h.hour+1)%24).padStart(2,'0')}:00</td><td>${h.samples?Number(h.averagePlayers).toFixed(1):'0.0'}</td><td>${esc(h.maxPlayers)}</td></tr>`).join('');
  const clanRows=snap.clans.slice(0,15).map((c,i)=>`<tr><td>${i+1}</td><td><strong>${esc(c.tag)}</strong></td><td>${esc(c.players)}</td><td>${esc(trackedDuration(c.totalSeconds))}</td></tr>`).join('');
  const serverRows=(snap.servers||[]).map((s)=>`<tr><td><strong>${esc(s.label)}</strong></td><td>${esc(s.onlinePlayers)}</td><td>${esc(s.uniquePlayers)}</td><td>${esc(trackedDuration(s.totalSeconds))}</td><td>${s.lastPollAt?esc(new Date(s.lastPollAt).toLocaleString(localeCode(langOf(req)))):'—'}</td></tr>`).join('');
  const killServerPanels=playtimeTrackerServers(bot).map((server)=>{
    const rows=(Array.isArray(server.killFeedEvents)?server.killFeedEvents:[]).slice(-150).reverse().map((e)=>{const flags=[e.headshot?'Headshot':'',e.penetration?'Penetration':'',e.ricochet?'Ricochet':'',e.melee?'Melee':'',e.roadKill?'Roadkill':'',e.vehicleExplosion?'Vehicle':'',e.suicide?'Suicide':''].filter(Boolean).join(', ')||'—';return `<tr><td>${e.receivedAt?esc(new Date(e.receivedAt).toLocaleString(localeCode(langOf(req)))):'—'}</td><td><strong>${esc(e.killerName||e.killerSteamId||'Environment')}</strong><div class="muted small">${esc(e.killerSteamId||'')}</div></td><td><strong>${esc(e.victimName||e.victimSteamId||'—')}</strong><div class="muted small">${esc(e.victimSteamId||'')}</div></td><td>${esc(prettyCause(e.cause))}</td><td>${Number(e.distanceMeters||0)>0?`${esc(Number(e.distanceMeters).toFixed(1))} m`:'—'}</td><td>${esc(flags)}</td><td>${esc(e.mapName||'—')}</td></tr>`;}).join('');
    return `<details class="panel tablewrap"><summary><strong>${esc(server.label)}</strong> · ${l(req,'letzte 150 Kills/Tode','latest 150 kills/deaths')} · ${server.killFeedChannelId?`Discord #${esc(server.killFeedChannelId)}`:l(req,'kein Discord Killfeed','no Discord killfeed')}</summary><table><thead><tr><th>${l(req,'Zeit','Time')}</th><th>Killer</th><th>Victim</th><th>${l(req,'Waffe/Ursache','Weapon/cause')}</th><th>${l(req,'Distanz','Distance')}</th><th>Tags</th><th>Map</th></tr></thead><tbody>${rows||`<tr><td colspan="7">${l(req,'Noch keine Kill-Events für diesen Server.','No kill events for this server yet.')}</td></tr>`}</tbody></table></details>`;
  }).join('');
  const rt=playtimeBotRuntime(bot.id);
  const discordReady=Boolean(bot.botTokenEnc)&&bot.enabled&&['connected','online'].includes(String(rt.state||''));
  return `<section class="playtime-dashboard">
    <div class="pagehead compact"><div><span class="eyebrow">WARDOGS Status Bot</span><h2>${l(req,'Server-, Playtime- & Spielerstatistiken','Server, playtime & player statistics')}</h2><p class="muted small">${l(req,'Das All-Time Leaderboard unten zeigt Top 15 pro Kategorie. Discord rendert dieselbe Ansicht über /leaderboard und optional als feste Leaderboard-Grafik.','The all-time leaderboard below shows the Top 15 per category. Discord renders the same view through /leaderboard and optionally as a fixed leaderboard graphic.')}</p></div><div class="actions wrap"><a class="button ghost" href="/managed-bots/${esc(bot.id)}/stats/export.docx">${l(req,'Stats als DOCX exportieren','Export stats as DOCX')}</a><form method="post" action="/managed-bots/${esc(bot.id)}/playtime/refresh" class="inline"><input type="hidden" name="_csrf" value="${token}"><input type="hidden" name="publish" value="0"><button class="button primary">${l(req,'Jetzt aktualisieren','Refresh now')}</button></form>${bot.leaderboardChannelId?`<form method="post" action="/managed-bots/${esc(bot.id)}/playtime/refresh" class="inline"><input type="hidden" name="_csrf" value="${token}"><input type="hidden" name="publish" value="1"><button class="button ghost">${l(req,'Discord Leaderboard senden/aktualisieren','Send/refresh Discord leaderboard')}</button></form>`:''}</div></div>
    <section class="admin-stats"><article class="panel"><span class="eyebrow">${l(req,'Online','Online')}</span><strong>${esc(snap.onlinePlayers)}</strong></article><article class="panel"><span class="eyebrow">${l(req,'Getrackte Spieler','Tracked players')}</span><strong>${esc(combined.players.length)}</strong></article><article class="panel"><span class="eyebrow">${l(req,'Gesamtspielzeit','Total playtime')}</span><strong>${esc(trackedDuration(snap.totalSeconds))}</strong></article><article class="panel"><span class="eyebrow">Discord</span><strong class="smallstat">${discordReady?l(req,'Commands aktiv','commands active'):l(req,'nicht aktiv','not active')}</strong><div class="muted small">/linkgame · /status · /whois · /whoisplayer · /playerstats · /leaderboard</div></article></section>
    <section id="alltime-leaderboard" class="leaderboard-section screenshot-leaderboard"><div class="leaderboard-screen-title">LEADERBOARD</div><div class="leaderboard-board"><div class="leaderboard-board-head"><div><span class="leaderboard-kicker">🏆 ${l(req,'All-Time Leaderboard','All-Time Leaderboard')}</span><h2>${l(req,'TOP 15 PRO KATEGORIE','TOP 15 PER CATEGORY')}</h2><p>${esc(combined.players.length)} ${l(req,'Spieler erfasst seit','players tracked since')} <strong>${esc(leaderboardSince)}</strong></p></div><div class="leaderboard-rules"><span>K/D: ${l(req,'ab 100 Kills','from 100 kills')}</span><span>Headshot-Rate: ${l(req,`ab ${HEADSHOT_RATE_MIN_KILLS} Kills`,`from ${HEADSHOT_RATE_MIN_KILLS} kills`)}</span></div></div><div class="leaderboard-grid">${leaderboardCards}</div></div></section>
    <div class="panel tablewrap leaderboard-search"><div class="managed-heading padded"><div><span class="eyebrow">${l(req,'Leaderboard-Suche','Leaderboard search')}</span><h2>${l(req,'Spieler suchen & genaue Position anzeigen','Find player & show exact position')}</h2></div></div><form method="get" action="/bot-services/${encodeURIComponent(bot.serviceId)}/manage" class="managed-add-row"><input type="hidden" name="bot" value="${esc(bot.id)}"><input name="playerq" maxlength="100" value="${esc(query)}" placeholder="${l(req,'Name, Alias oder Steam64ID','Name, alias or Steam64ID')}"><button class="button primary smallbtn">${l(req,'Suchen','Search')}</button></form>${searchResult}${playerDetail}</div>
    <div class="panel tablewrap"><div class="managed-heading padded"><div><span class="eyebrow">${l(req,'Server','Servers')}</span><h2>${l(req,'Server-Übersicht','Server overview')}</h2></div></div><table><thead><tr><th>${l(req,'Server','Server')}</th><th>${l(req,'Online','Online')}</th><th>${l(req,'Spieler','Players')}</th><th>${l(req,'Spielzeit','Playtime')}</th><th>${l(req,'Letzter Poll','Last poll')}</th></tr></thead><tbody>${serverRows}</tbody></table></div>
    <div class="managed-heading padded"><div><span class="eyebrow">Moderation</span><h2>${l(req,'Killfeed pro Server · letzte 150 Events','Killfeed per server · latest 150 events')}</h2></div></div>${killServerPanels}
    <div class="managed-live-grid"><div class="panel tablewrap"><div class="managed-heading padded"><div><span class="eyebrow">${l(req,'Aktivität','Activity')}</span><h2>${l(req,'Stärkste Tageszeiten','Peak hours')}</h2></div></div><table><thead><tr><th>${l(req,'Stunde','Hour')}</th><th>Ø ${l(req,'Spieler','Players')}</th><th>Max</th></tr></thead><tbody>${hourRows}</tbody></table></div><div class="panel tablewrap"><div class="managed-heading padded"><div><span class="eyebrow">Clan Tags</span><h2>${l(req,'Meistgenutzte Tags','Most used tags')}</h2></div></div><table><thead><tr><th>#</th><th>Tag</th><th>${l(req,'Spieler','Players')}</th><th>${l(req,'Spielzeit','Playtime')}</th></tr></thead><tbody>${clanRows||`<tr><td colspan="4">${l(req,'Noch keine Clan-Tags erkannt.','No clan tags detected yet.')}</td></tr>`}</tbody></table></div></div>
  </section>`;
}

function killFlagText(event){return [event.headshot?'HS':'',event.penetration?'PEN':'',event.ricochet?'RICO':'',event.melee?'MELEE':'',event.vehicleExplosion?'VEH':'',event.roadKill?'ROAD':'',event.falling?'FALL':'',event.suicide?'SUICIDE':''].filter(Boolean).join(' · ')||'—';}
function killStatsForm(req,service,bot){
  const lang=langOf(req),u=currentUser(req),rt=killStatsBotRuntime(bot.id);
  return `<form method="post" action="/bot-services/${encodeURIComponent(service.id)}/manage" class="panel formgrid">
    <input type="hidden" name="_csrf" value="${esc(csrf(req))}"><input type="hidden" name="botId" value="${esc(bot.id)}">
    <label>${tr(lang,'Bot-Name','Bot name')}<input name="name" maxlength="80" required value="${esc(bot.name||service.nameDe||service.nameEn||'WARDOGS Killfeed & Stats Bot')}"></label>
    <label>Discord Bot Token (${tr(lang,'optional','optional')})<input name="botToken" type="password" autocomplete="new-password" placeholder="${bot.botTokenEnc?tr(lang,'Leer lassen = unverändert','Leave blank = unchanged'):tr(lang,'Nur für Discord Killfeed nötig','Only needed for Discord killfeed')}"></label>
    <label class="span2">WARDOGS API / RCON URL<input name="wardogsBaseUrl" required value="${esc(bot.wardogsBaseUrl||'')}" placeholder="http://server.example.com:7776"></label>
    <label class="span2">WARDOGS RCON / Bearer Password<input name="wardogsSecret" type="password" autocomplete="new-password" placeholder="${bot.wardogsSecretEnc?tr(lang,'Leer lassen = unverändert','Leave blank = unchanged'):tr(lang,'Pflichtfeld','Required')}"></label>
    <label class="span2">Discord Killfeed Channel ID (${tr(lang,'optional','optional')})<input name="killFeedChannelId" inputmode="numeric" value="${esc(bot.killFeedChannelId||'')}" placeholder="123456789012345678"><span class="muted small">${tr(lang,'Eine feste Nachricht wird immer wieder editiert und zeigt die letzten 15 Kills.','One fixed message is edited in place and always shows the latest 15 kills.')}</span></label>
    <label class="check"><input type="checkbox" name="enabled" value="1" ${bot.enabled?'checked':''}> ${tr(lang,'Stats Bot aktiv / gehostet','Stats bot enabled / hosted')}</label>
    <label class="check"><input type="checkbox" name="autoRecoveryEnabled" value="1" ${bot.autoRecoveryEnabled!==false?'checked':''}> ${tr(lang,'Auto-Recovery','Auto recovery')}</label>
    ${u.role==='admin'?`<label class="check span2"><input type="checkbox" name="allowPrivateTarget" value="1" ${bot.allowPrivateTarget?'checked':''}> ${tr(lang,'Private/LAN WARDOGS-Ziele erlauben (Admin)','Allow private/LAN WARDOGS targets (admin)')}</label>`:''}
    <div class="span2 actions wrap"><button class="button primary" type="submit">${tr(lang,'Speichern','Save')}</button><button class="button ghost" type="submit" formaction="/bot-services/${encodeURIComponent(service.id)}/test">${tr(lang,'Verbindung testen','Test connection')}</button>${bot.enabled?`<button class="button ghost" type="submit" formaction="/managed-bots/${esc(bot.id)}/restart">${tr(lang,'Neu starten','Restart')}</button><button class="button danger" type="submit" formaction="/managed-bots/${esc(bot.id)}/stop">Stop</button>`:`<button class="button success" type="submit" formaction="/managed-bots/${esc(bot.id)}/restart">${tr(lang,'Starten','Start')}</button>`}<span class="badge ${rt.state==='online'?'online':rt.state==='error'?'error':'neutral'}">${esc(rt.state||'stopped')}</span></div>
    ${rt.lastError?`<div class="span2 warning"><strong>Runtime:</strong> ${esc(rt.lastError)}</div>`:''}${rt.lastPublishError?`<div class="span2 warning"><strong>Discord Killfeed:</strong> ${esc(rt.lastPublishError)}</div>`:''}
  </form>${killFeedSetupPanel(req,bot)}<section class="panel managed-config-block"><div class="row between"><strong>${tr(lang,'Config Export / Import','Config export / import')}</strong><a class="button ghost smallbtn" href="/managed-bots/${esc(bot.id)}/config/export">${tr(lang,'Config exportieren','Export config')}</a></div><form method="post" enctype="multipart/form-data" action="/managed-bots/${esc(bot.id)}/config/import" class="managed-add-row"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><input type="file" name="config" accept="application/json,.json" required><button class="button ghost smallbtn">${tr(lang,'Config importieren','Import config')}</button></form></section>`;
}
function killFeedSetupPanel(req,bot){
  const configured=Boolean(bot.killFeedConfiguredAt),live=Boolean(bot.killFeedLastEventAt);
  return `<section class="panel"><div class="row between"><div><span class="eyebrow">WARDOGS Server Feed</span><h2>${l(req,'Killfeed-Empfang','Killfeed ingest')}</h2></div><span class="badge ${live?'online':configured?'neutral':'error'}">${live?l(req,'Events kommen an','receiving events'):configured?l(req,'konfiguriert','configured'):l(req,'nicht konfiguriert','not configured')}</span></div><p class="muted small">${l(req,'Für Distanz, Headshots und Kill-Tags muss WARDOGS seinen Server Feed an dieses Panel senden. Das Setup schreibt Url + Token in [WDServerFeed]. Diese WARDOGS-Einstellung wird erst nach einem Neustart des Gameservers aktiv.','For distance, headshots and kill tags WARDOGS must push its Server Feed to this panel. Setup writes Url + Token into [WDServerFeed]. This WARDOGS setting only becomes active after a game-server restart.')}</p><form method="post" action="/managed-bots/${esc(bot.id)}/killfeed/setup"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button primary">${configured?l(req,'Server Feed erneut konfigurieren','Configure Server Feed again'):l(req,'Server Feed konfigurieren','Configure Server Feed')}</button></form>${bot.killFeedNeedsGameRestart?`<div class="warning"><strong>${l(req,'Gameserver-Neustart nötig','Game-server restart required')}</strong> · ${l(req,'WARDOGS liest WDServerFeed erst beim Serverstart ein.','WARDOGS reads WDServerFeed only at game-server startup.')}</div>`:''}${bot.killFeedLastEventAt?`<p class="muted small">${l(req,'Letztes Event','Last event')}: ${esc(new Date(bot.killFeedLastEventAt).toLocaleString(localeCode(langOf(req))))}</p>`:''}</section>`;
}
function killStatsPanel(req,bot){
  const snap=killStatsSnapshot(bot),query=String(req.query.playerq||'').trim().slice(0,100),matches=query?searchKillStatsPlayer(bot,query):[];
  const top=snap.top25.map((p,i)=>`<tr><td>${i+1}</td><td><strong>${esc(p.name)}</strong><div class="muted small"><a target="_blank" rel="noopener" href="https://steamcommunity.com/profiles/${esc(p.steamId)}">${esc(p.steamId)}</a></div></td><td><strong>${esc(p.kills)}</strong></td><td>${esc(p.deaths)}</td><td>${esc((p.deaths?p.kills/p.deaths:p.kills).toFixed(2))}</td><td>${esc(p.headshots)}</td><td>${esc(Number(p.longestKillMeters||0).toFixed(1))} m</td></tr>`).join('');
  const search=matches.map((p)=>`<tr><td><strong>${esc(p.name)}</strong><div class="muted small">${esc(p.steamId)}${p.aliases?.length?` · ${l(req,'früher','aliases')}: ${esc(p.aliases.join(', '))}`:''}</div></td><td>${esc(p.kills)}</td><td>${esc(p.deaths)}</td><td>${esc((p.deaths?p.kills/p.deaths:p.kills).toFixed(2))}</td><td>${esc(p.headshots)}</td><td>${esc(Number(p.longestKillMeters||0).toFixed(1))} m</td><td>${(p.topCauses||[]).slice(0,3).map(([c,n])=>`${esc(prettyCause(c))}: ${esc(n)}`).join('<br>')||'—'}</td></tr>`).join('');
  const feed=snap.recentEvents.slice(0,50).map((e)=>`<tr><td>${esc(new Date(e.receivedAt).toLocaleString(localeCode(langOf(req))))}</td><td>${e.killerSteamId?`<strong>${esc(e.killerName||e.killerSteamId)}</strong><div class="muted small">${esc(e.killerSteamId)}</div>`:esc(e.suicide?'Suicide':'Environment')}</td><td><strong>${esc(e.victimName||e.victimSteamId)}</strong><div class="muted small">${esc(e.victimSteamId)}</div></td><td>${esc(prettyCause(e.cause))}</td><td>${e.distanceMeters?`${esc(Number(e.distanceMeters).toFixed(1))} m`:'—'}</td><td>${esc(killFlagText(e))}</td><td>${esc(e.mapName||'—')}</td></tr>`).join('');
  return `<section class="playtime-dashboard"><div class="pagehead compact"><div><span class="eyebrow">WARDOGS Kill Stats</span><h2>${l(req,'All-Time Statistiken','All-time statistics')}</h2></div>${bot.killFeedChannelId?`<form method="post" action="/managed-bots/${esc(bot.id)}/killstats/refresh"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button ghost">${l(req,'Discord Killfeed aktualisieren','Refresh Discord killfeed')}</button></form>`:''}</div>
    <section class="admin-stats"><article class="panel"><span class="eyebrow">${l(req,'Kills/Tode-Events','Kill/death events')}</span><strong>${esc(snap.totalEvents)}</strong></article><article class="panel"><span class="eyebrow">${l(req,'Spieler','Players')}</span><strong>${esc(snap.players.length)}</strong></article><article class="panel"><span class="eyebrow">${l(req,'Top Killer','Top killer')}</span><strong>${esc(snap.top25[0]?.name||'—')}</strong></article><article class="panel"><span class="eyebrow">${l(req,'Letztes Event','Last event')}</span><strong class="small">${snap.lastEventAt?esc(new Date(snap.lastEventAt).toLocaleString(localeCode(langOf(req)))):'—'}</strong></article></section>
    <div class="panel tablewrap"><div class="managed-heading padded"><div><span class="eyebrow">${l(req,'Spielersuche','Player search')}</span><h2>${l(req,'Spielerstatistik suchen','Search player stats')}</h2></div></div><form method="get" action="/bot-services/${encodeURIComponent(bot.serviceId)}/manage" class="managed-add-row"><input type="hidden" name="bot" value="${esc(bot.id)}"><input name="playerq" maxlength="100" value="${esc(query)}" placeholder="${l(req,'Name oder Steam64ID','Name or Steam64ID')}"><button class="button primary smallbtn">${l(req,'Suchen','Search')}</button></form>${query?`<table><thead><tr><th>${l(req,'Spieler','Player')}</th><th>Kills</th><th>${l(req,'Tode','Deaths')}</th><th>K/D</th><th>Headshots</th><th>${l(req,'Längster Kill','Longest kill')}</th><th>${l(req,'Top Ursachen','Top causes')}</th></tr></thead><tbody>${search||`<tr><td colspan="7">${l(req,'Kein Spieler gefunden.','No player found.')}</td></tr>`}</tbody></table>`:''}</div>
    <div class="panel tablewrap"><div class="managed-heading padded"><div><span class="eyebrow">Leaderboard</span><h2>Top 25 · ${l(req,'alle Matches','all matches')}</h2></div></div><table><thead><tr><th>#</th><th>${l(req,'Spieler','Player')}</th><th>Kills</th><th>${l(req,'Tode','Deaths')}</th><th>K/D</th><th>Headshots</th><th>${l(req,'Längster Kill','Longest kill')}</th></tr></thead><tbody>${top||`<tr><td colspan="7">${l(req,'Noch keine Kill-Events empfangen.','No kill events received yet.')}</td></tr>`}</tbody></table></div>
    <div class="panel tablewrap"><div class="managed-heading padded"><div><span class="eyebrow">Live Killfeed</span><h2>${l(req,'Letzte 50 Events','Latest 50 events')}</h2></div></div><table><thead><tr><th>${l(req,'Zeit','Time')}</th><th>Killer</th><th>${l(req,'Opfer','Victim')}</th><th>${l(req,'Waffe/Ursache','Weapon/cause')}</th><th>${l(req,'Distanz','Distance')}</th><th>Tags</th><th>Map</th></tr></thead><tbody>${feed||`<tr><td colspan="7">${l(req,'Noch keine Kill-Events empfangen.','No kill events received yet.')}</td></tr>`}</tbody></table></div>
    <div class="panel muted small">${l(req,'Hinweis: Die aktuelle WARDOGS API/der Kill-Feed liefert Kills, Tode, Distanz und Kill-Kontext-Tags. Assists und Revives werden derzeit nicht als auswertbare Events bereitgestellt und deshalb nicht erfunden.','Note: the current WARDOGS API/kill feed exposes kills, deaths, distance and kill-context tags. Assists and revives are not currently exposed as usable events, so they are not fabricated.')}</div>
  </section>`;
}
function managedKillFeedPanel(req,bot){
  const events=managementKillFeed(bot),rows=events.map((e)=>`<tr><td>${esc(new Date(e.receivedAt).toLocaleString(localeCode(langOf(req))))}</td><td>${e.killerSteamId?`<strong>${esc(e.killerName||e.killerSteamId)}</strong><div class="muted small">${esc(e.killerSteamId)}</div>`:esc(e.suicide?'Suicide':'Environment')}</td><td><strong>${esc(e.victimName||e.victimSteamId)}</strong><div class="muted small">${esc(e.victimSteamId)}</div></td><td>${esc(prettyCause(e.cause))}</td><td>${e.distanceMeters?`${esc(Number(e.distanceMeters).toFixed(1))} m`:'—'}</td><td>${esc(killFlagText(e))}</td><td>${esc(e.mapName||'—')}</td></tr>`).join('');
  const configured=Boolean(bot.killFeedConfiguredAt),live=Boolean(bot.killFeedLastEventAt);
  const status=`<div class="help"><strong>WARDOGS Server Feed:</strong> <span class="badge ${live?'online':configured?'neutral':'error'}">${live?l(req,'aktiv','active'):configured?l(req,'konfiguriert · Gameserver ggf. neu starten','configured · restart game server if needed'):l(req,'nicht konfiguriert','not configured')}</span>${bot.killFeedLastEventAt?` · ${l(req,'letztes Event','last event')}: ${esc(new Date(bot.killFeedLastEventAt).toLocaleString(localeCode(langOf(req))))}`:''}</div>`;
  return `<section class="panel tablewrap managed-section"><div class="managed-heading padded"><div><span class="eyebrow">Moderation Killfeed · ${esc(bot._managedServerLabel||'Server')}</span><h2>${l(req,'Letzte 150 Kills/Tode','Latest 150 kills/deaths')}</h2><p>${l(req,'Persistenter Moderationsverlauf mit SteamIDs, Ursache/Waffe, Distanz und WARDOGS-Kill-Tags.','Persistent moderation history with SteamIDs, cause/weapon, distance and WARDOGS kill tags.')}</p></div></div><div class="padded">${status}</div><table><thead><tr><th>${l(req,'Zeit','Time')}</th><th>Killer</th><th>${l(req,'Opfer','Victim')}</th><th>${l(req,'Waffe/Ursache','Weapon/cause')}</th><th>${l(req,'Distanz','Distance')}</th><th>Tags</th><th>Map</th></tr></thead><tbody>${rows||`<tr><td colspan="7">${l(req,'Noch keine Kill-Events empfangen.','No kill events received yet.')}</td></tr>`}</tbody></table></section>`;
}

function managedChatHistoryPanel(req,bot){
  const serverId=String(bot?._managedServerId||'');
  return `<section class="panel managed-section"><div class="row between wrap"><div><span class="eyebrow">Chat History · ${esc(bot?._managedServerLabel||'Server')}</span><h2>${l(req,'Gespeicherte Server-Nachrichten','Stored server messages')}</h2><p class="muted small">${l(req,'Zeigt 50 Nachrichten pro Seite. Gesendete Broadcasts/Whispers werden immer gespeichert; eingehender Spielerchat wird gespeichert, sobald WARDOGS solche Chat-Events im Server Feed liefert.','Shows 50 messages per page. Outgoing broadcasts/whispers are always stored; incoming player chat is stored when WARDOGS provides chat events in its Server Feed.')}</p></div><button class="button primary" type="button" data-managed-chat-open data-chat-url="/managed-bots/${esc(bot.id)}/chat-history?serverId=${encodeURIComponent(serverId)}">${l(req,'Chat History öffnen','Open chat history')}</button></div></section>`;
}
function managedChatModalHtml(req,parent,bot){
  if(!bot)return '';
  return `<div class="modal-backdrop managed-chat-modal" data-managed-chat-modal hidden><div class="modal-card panel managed-chat-dialog" role="dialog" aria-modal="true" aria-labelledby="managed-chat-title"><button class="modal-close" type="button" aria-label="${l(req,'Schließen','Close')}" data-managed-chat-close>×</button><span class="eyebrow">${esc(bot._managedServerLabel||'WARDOGS')}</span><h2 id="managed-chat-title">Chat History</h2><p class="muted small" data-managed-chat-summary>—</p><div class="tablewrap"><table><thead><tr><th>${l(req,'Zeit','Time')}</th><th>${l(req,'Richtung','Direction')}</th><th>${l(req,'Spieler/Admin','Player/Admin')}</th><th>${l(req,'Channel/Typ','Channel/type')}</th><th>${l(req,'Nachricht','Message')}</th></tr></thead><tbody data-managed-chat-body><tr><td colspan="5">${l(req,'Lädt…','Loading…')}</td></tr></tbody></table></div><div class="row between wrap"><button class="button ghost" type="button" data-managed-chat-prev>${l(req,'← Zurück','← Previous')}</button><span class="muted small" data-managed-chat-page>1 / 1</span><button class="button ghost" type="button" data-managed-chat-next>${l(req,'Weiter →','Next →')}</button></div></div></div>`;
}

function managedIgnoredPlayersPanel(req, bot) {
  const rows=(Array.isArray(bot.ignoredPlayers)?bot.ignoredPlayers:[]).filter((entry)=>/^\d{17}$/.test(String(entry?.steamId||''))).slice().sort((a,b)=>String(b.ignoredAt||'').localeCompare(String(a.ignoredAt||'')));
  const token=esc(csrf(req));
  const body=rows.map((entry)=>`<tr><td><strong>${esc(entry.name||l(req,'Unbekannter Spieler','Unknown player'))}</strong><div class="muted small"><a target="_blank" rel="noopener" href="https://steamcommunity.com/profiles/${esc(entry.steamId)}">${esc(entry.steamId)}</a></div></td><td>${entry.ignoredAt?esc(new Date(entry.ignoredAt).toLocaleString(localeCode(langOf(req)))):'—'}</td><td>${esc(entry.ignoredBy||'—')}</td><td><form method="post" action="/managed-bots/${esc(bot.id)}/ignore/${esc(entry.steamId)}/remove" onsubmit="return confirm('${l(req,'Spieler wieder für Detection-Warnungen aktivieren?','Enable detection alerts for this player again?')}')"><input type="hidden" name="_csrf" value="${token}"><button class="button ghost smallbtn">${l(req,'Ignore entfernen','Remove ignore')}</button></form></td></tr>`).join('');
  return `<div class="panel tablewrap managed-section"><div class="managed-heading padded"><div><span class="eyebrow">Detection Ignore List</span><h2>${l(req,'Ignorierte Spieler','Ignored players')}</h2><p>${l(req,'Diese Spieler erzeugen keine Detection-Warnungen und keinen Auto-Ban.','These players do not generate detection alerts or auto-bans.')}</p></div></div><form method="post" action="/managed-bots/${esc(bot.id)}/ignore/add" class="managed-add-row"><input type="hidden" name="_csrf" value="${token}"><input name="steamId" pattern="[0-9]{17}" maxlength="17" required placeholder="SteamID64"><input name="name" maxlength="100" placeholder="${l(req,'Name (optional)','Name (optional)')}"><button class="button primary smallbtn">Ignore</button></form><table><thead><tr><th>Player</th><th>${l(req,'Ignoriert seit','Ignored since')}</th><th>Discord ID</th><th></th></tr></thead><tbody>${body||`<tr><td colspan="4">${l(req,'Keine Spieler ignoriert.','No ignored players.')}</td></tr>`}</tbody></table></div>`;
}


function managedBanSyncPanel(req, bot) {
  const token=esc(csrf(req));
  const current=bot.banSyncServerId?getBanSyncServer(String(bot.banSyncServerId)):null;
  const all=listBanSyncServers().slice().sort((a,b)=>String(a.name||'').localeCompare(String(b.name||''),langOf(req)));
  if(current&&Array.isArray(current.members)&&current.members.map(String).includes(String(bot.id))){
    const members=current.members.map((id)=>getManagedBot(String(id))).filter(Boolean);
    const memberRows=members.map((member)=>`<tr><td><strong>${esc(member.name||'WARDOGS Management Bot')}</strong><div class="muted small">${esc(member.id)}</div></td><td>${member.id===current.ownerBotId?`<span class="badge online">${l(req,'Ersteller','Owner')}</span>`:`<span class="badge neutral">${l(req,'Mitglied','Member')}</span>`}</td></tr>`).join('');
    const activeBans=(Array.isArray(current.sharedBans)?current.sharedBans:[]).filter((row)=>String(row?.mode||'')==='permanent'||Date.parse(row?.expiresAt||'')>Date.now()).length;
    return `<section class="panel managed-section"><div class="managed-heading padded"><div><span class="eyebrow">Ban Sync Community</span><h2>${esc(current.name)}</h2><p>${l(req,'Alle Bans und Unbans, die ein Mitglied über den Management Bot ausführt, werden auf alle verbundenen Bots gespiegelt. Temporäre und Dynamic Bans behalten exakt ihre ursprüngliche Ablaufzeit. Die Dynamic-Ban-Regeln werden zentral vom Community-Owner festgelegt.','All bans and unbans made through a member management bot are mirrored to every connected bot. Temporary and Dynamic Bans keep their exact original expiry. Dynamic Ban policy is centrally controlled by the community owner.')}</p></div><div class="actions wrap"><form method="post" action="/managed-bots/${esc(bot.id)}/ban-sync-server/resync"><input type="hidden" name="_csrf" value="${token}"><button class="button ghost smallbtn">${l(req,'Jetzt synchronisieren','Sync now')}</button></form><form method="post" action="/managed-bots/${esc(bot.id)}/ban-sync-server/leave" onsubmit="return confirm('${l(req,'Ban-Sync-Community wirklich verlassen? Bereits synchronisierte Bans bleiben auf diesem Gameserver bestehen, nur zukünftige Änderungen werden nicht mehr gespiegelt.','Really leave the Ban Sync Community? Already synchronized bans remain on this game server; only future changes stop syncing.')}')"><input type="hidden" name="_csrf" value="${token}"><button class="button danger smallbtn">${l(req,'Verlassen','Leave')}</button></form></div></div><div class="padded"><div class="managed-live-grid"><article class="panel"><span class="eyebrow">Community ID</span><strong class="small">${esc(current.id)}</strong></article><article class="panel"><span class="eyebrow">${l(req,'Mitglieder','Members')}</span><strong>${esc(members.length)}</strong></article><article class="panel"><span class="eyebrow">${l(req,'Geteilte Bans','Shared bans')}</span><strong>${esc(activeBans)}</strong></article><article class="panel"><span class="eyebrow">Dynamic Ban</span><strong>${current.dynamicBanEnabled===true?l(req,'Aktiv','Enabled'):l(req,'Aus','Off')}</strong><div class="muted small">${esc(Math.max(2,Math.min(20,Math.floor(Number(current.dynamicBanEscalateJoins)||3))))} ${l(req,'Joins','joins')} / ${esc(Math.max(1,Math.min(1440,Math.floor(Number(current.dynamicBanEscalateWindowMinutes)||5))))} min · ${l(req,'Owner-gesteuert','owner controlled')}</div></article></div><p class="muted small">${l(req,'Das Passwort wird niemals angezeigt. Neue Bots treten über den Community Browser mit Community-Passwort bei.','The password is never displayed. New bots join from the Community Browser using the community password.')}</p></div><div class="tablewrap"><table><thead><tr><th>Management Bot</th><th>Status</th></tr></thead><tbody>${memberRows}</tbody></table></div></section>`;
  }
  const browserRows=all.map((room)=>{
    const members=(Array.isArray(room.members)?room.members:[]).length;
    const bans=(Array.isArray(room.sharedBans)?room.sharedBans:[]).filter((row)=>String(row?.mode||'')==='permanent'||Date.parse(row?.expiresAt||'')>Date.now()).length;
    return `<tr><td><strong>${esc(room.name)}</strong><div class="muted small">${esc(room.id)}</div></td><td>${esc(members)}</td><td>${esc(bans)}</td><td><form method="post" action="/managed-bots/${esc(bot.id)}/ban-sync-server/join" class="actions wrap"><input type="hidden" name="_csrf" value="${token}"><input type="hidden" name="serverId" value="${esc(room.id)}"><input name="password" type="password" autocomplete="current-password" minlength="4" maxlength="64" required placeholder="${l(req,'Community-Passwort','Community password')}"><button class="button primary smallbtn">${l(req,'Beitreten','Join')}</button></form></td></tr>`;
  }).join('');
  return `<section class="panel managed-section"><div class="managed-heading padded"><div><span class="eyebrow">Ban Sync</span><h2>${l(req,'Community Browser','Community Browser')}</h2><p>${l(req,'Erstelle eine passwortgeschützte Ban-Sync-Community oder tritt einer bestehenden bei. Bis zu 100 Management Bots können verbunden werden. Bestehende Bans werden beim Erstellen/Beitreten zusammengeführt; danach werden Bans und Unbans an alle Mitglieder verteilt. Die Dynamic-Ban-Einstellungen werden vom Community-Owner zentral vorgegeben.','Create a password-protected Ban Sync Community or join an existing one. Up to 100 management bots can be connected. Existing bans are merged when creating/joining; afterwards bans and unbans are distributed to all members. Dynamic Ban settings are centrally controlled by the community owner.')}</p></div></div><div class="padded"><form method="post" action="/managed-bots/${esc(bot.id)}/ban-sync-server/create" class="managed-add-row"><input type="hidden" name="_csrf" value="${token}"><input name="name" minlength="3" maxlength="80" required placeholder="${l(req,'Community-Name','Community name')}"><input name="password" type="password" autocomplete="new-password" minlength="4" maxlength="64" required placeholder="${l(req,'Passwort (mind. 4 Zeichen)','Password (min. 4 chars)')}"><button class="button success smallbtn">${l(req,'Community erstellen','Create community')}</button></form></div><div class="tablewrap"><table><thead><tr><th>Community</th><th>${l(req,'Mitglieder','Members')}</th><th>Bans</th><th>${l(req,'Beitreten','Join')}</th></tr></thead><tbody>${browserRows||`<tr><td colspan="4">${l(req,'Noch keine Ban-Sync-Community vorhanden. Erstelle oben die erste.','No Ban Sync Community exists yet. Create the first one above.')}</td></tr>`}</tbody></table></div></section>`;
}

function managedAuditLogPanel(req, bot) {
  const rows=(Array.isArray(bot.auditLog)?bot.auditLog:[]).slice().sort((a,b)=>String(b.at||'').localeCompare(String(a.at||''))).slice(0,120);
  const body=rows.map((row)=>`<tr><td>${row.at?esc(new Date(row.at).toLocaleString(localeCode(langOf(req)))):'—'}</td><td><strong>${esc(row.action||'—')}</strong>${row.status&&row.status!=='ok'?` <span class="badge error">${esc(row.status)}</span>`:''}</td><td>${esc(row.actor||'system')}</td><td>${esc(row.target||'—')}</td><td>${esc(row.detail||'—')}</td></tr>`).join('');
  return `<details class="panel managed-details" ${rows.length?'':'open'}><summary>${l(req,'Panel Audit Log','Panel audit log')} (${rows.length})</summary><p class="muted small">${l(req,'Protokolliert Management-Aktionen wie Bans, Dynamic-Ban-Kicks/Eskalationen, Ban-Sync, Whispers, Team-/Map-/Lighting-Aktionen und Konfigurationsänderungen. Maximal die letzten 500 Einträge werden gespeichert.','Records management actions such as bans, Dynamic Ban kicks/escalations, ban sync, whispers, team/map/lighting actions and configuration changes. Up to the latest 500 entries are stored.')}</p><div class="tablewrap"><table><thead><tr><th>${l(req,'Zeit','Time')}</th><th>Action</th><th>Actor</th><th>Target</th><th>Detail</th></tr></thead><tbody>${body||`<tr><td colspan="5">${l(req,'Noch keine Audit-Einträge.','No audit entries yet.')}</td></tr>`}</tbody></table></div></details>`;
}


function managedOperationsPanel(req, bot, live) {
  const lang=langOf(req), token=esc(csrf(req));
  if(!bot.wardogsBaseUrl||!bot.wardogsSecretEnc)return `<div class="panel empty">${l(req,'Speichere zuerst WARDOGS URL und RCON-Passwort, danach erscheinen die Live-Management-Funktionen.','Save the WARDOGS URL and RCON password first, then the live management tools will appear.')}</div>`;
  if(!live)return `<div class="panel empty">${l(req,'Live-Daten konnten nicht geladen werden.','Live data could not be loaded.')}</div>`;
  const status=live.status||{},health=live.health||{},players=Array.isArray(live.players?.players)?live.players.players:[],bans=Array.isArray(live.bans?.bans)?live.bans.bans:[],reservedIds=Array.isArray(live.reserved?.reservedSlots)?live.reserved.reservedSlots.map(String):[];
  const capRoutes=Array.isArray(live.capabilities?.routes)?live.capabilities.routes.map(String):[];
  const normalizeRoute=(value)=>String(value||'').replace(/\{(?:steamId|id)\}/g,'{id}');
  const supports=(method,path)=>!capRoutes.length||capRoutes.some((x)=>normalizeRoute(x)===`${method} ${normalizeRoute(path)}`);
  const mapRows=Array.isArray(live.maps?.maps)?live.maps.maps:[];
  const lightingRows=Array.isArray(live.lightings?.lightings)?live.lightings.lightings:[];
  const expRows=Array.isArray(live.experiences?.experiences)?live.experiences.experiences:[];
  const rotationRows=Array.isArray(live.rotation?.entries)?live.rotation.entries:[];
  const factions=[...new Set((Array.isArray(status.factionScores)?status.factionScores:[]).map((x)=>String(x?.name||'').trim()).filter(Boolean))];
  const fmtUptime=(seconds)=>{const n=Number(seconds);if(!Number.isFinite(n)||n<0)return '—';const d=Math.floor(n/86400),h=Math.floor((n%86400)/3600),m=Math.floor((n%3600)/60);return `${d?`${d}d `:''}${h}h ${m}m`;};
  const templates=managedBanTemplates(bot);
  const temporaryBanMap=new Map((Array.isArray(bot.temporaryBans)?bot.temporaryBans:[]).map((entry)=>[String(entry?.steamId||''),entry]));
  const dynamicBanRows=(Array.isArray(bot.dynamicBans)?bot.dynamicBans:[]).filter((entry)=>/^\d{17}$/.test(String(entry?.steamId||''))&&Number.isFinite(Date.parse(entry?.expiresAt||''))).slice().sort((a,b)=>String(a.expiresAt||'').localeCompare(String(b.expiresAt||'')));
  const dynamicBanHtml=dynamicBanRows.map((entry)=>`<tr><td><a target="_blank" rel="noopener" href="https://steamcommunity.com/profiles/${esc(entry.steamId)}">${esc(entry.steamId)}</a></td><td>${esc(entry.reason||'—')}</td><td>${entry.expiresAt?esc(new Date(entry.expiresAt).toLocaleString(localeCode(langOf(req)))):'—'}</td><td>${entry.escalated?`<span class="badge error">${l(req,'eskaliert: normaler Ban','escalated: normal ban')}</span>`:`<span class="badge neutral">${l(req,'Kick bei Rejoin','kick on rejoin')}</span>`}</td><td>${esc((Array.isArray(entry.joinAttempts)?entry.joinAttempts:[]).length)}</td><td><form method="post" action="/managed-bots/${esc(bot.id)}/ban/remove" onsubmit="return confirm('${l(req,'Dynamic Ban wirklich entfernen?','Really remove this Dynamic Ban?')}')"><input type="hidden" name="_csrf" value="${token}"><input type="hidden" name="steamId" value="${esc(entry.steamId)}"><button class="button ghost smallbtn">${l(req,'Entfernen','Remove')}</button></form></td></tr>`).join('');
  const templateOptions=`<option value="">${l(req,'Benutzerdefiniert','Custom')}</option>${templates.map((tpl)=>{const parts=managedDurationParts(tpl.durationMinutes,false);return `<option value="${esc(tpl.id)}" data-ban-reason="${esc(tpl.reason)}" data-ban-unit="${esc(parts.unit)}" data-ban-value="${esc(parts.value)}">${esc(tpl.label)} · ${tpl.durationMinutes?esc(formatManagedBanDuration(tpl.durationMinutes)):l(req,'permanent','permanent')}</option>`;}).join('')}`;
  const playerRows=players.map((p)=>{
    const steam=normalizeSteamId64(p.steamId64||p.steamId||p.steamID64||p.steamID||p.playerSteamId||p.playerId),valid=Boolean(steam),name=String(p.name||'Unknown'),faction=String(p.faction||'—');
    const actionBase=valid?`<div class="managed-player-actions">
      <form method="post" action="/managed-bots/${esc(bot.id)}/player/message"><input type="hidden" name="_csrf" value="${token}"><input type="hidden" name="steamId" value="${esc(steam)}"><input name="message" maxlength="200" required placeholder="${l(req,'Whisper…','Whisper…')}"><button class="button ghost smallbtn">${l(req,'Senden','Send')}</button></form>
      <form method="post" action="/managed-bots/${esc(bot.id)}/player/kick"><input type="hidden" name="_csrf" value="${token}"><input type="hidden" name="steamId" value="${esc(steam)}"><input name="reason" maxlength="180" placeholder="${l(req,'Kick-Grund','Kick reason')}"><button class="button ghost smallbtn">Kick</button></form>
      <button class="button danger smallbtn" type="button" data-open-managed-ban data-steam-id="${esc(steam)}" data-player-name="${esc(name)}">Ban</button>
      ${supports('POST','/v1/players/{steamId}/kill')?`<form method="post" action="/managed-bots/${esc(bot.id)}/player/kill" onsubmit="return confirm('${l(req,'Spieler töten/respawnen?','Kill/respawn this player?')}')"><input type="hidden" name="_csrf" value="${token}"><input type="hidden" name="steamId" value="${esc(steam)}"><button class="button ghost smallbtn">Kill</button></form>`:''}
      ${supports('PATCH','/v1/players/{steamId}')&&factions.length?`<form method="post" action="/managed-bots/${esc(bot.id)}/player/faction"><input type="hidden" name="_csrf" value="${token}"><input type="hidden" name="steamId" value="${esc(steam)}"><select name="faction" required><option value="">${l(req,'Team wählen…','Choose team…')}</option>${factions.map((team)=>`<option value="${esc(team)}" ${team===faction?'selected':''}>${esc(team)}</option>`).join('')}</select><button class="button ghost smallbtn">${l(req,'Team setzen','Set team')}</button></form>`:''}
      <a class="button ghost smallbtn" target="_blank" rel="noopener" href="https://steamcommunity.com/profiles/${esc(steam)}">Steam</a>
    </div>`:'';
    const searchKey=`${name} ${steam||''}`.toLowerCase();
    return `<tr data-managed-player-row data-player-search="${esc(searchKey)}"><td><strong>${esc(name)}</strong><div class="muted small">${esc(steam||'—')}</div></td><td>${esc(faction)}</td><td>${esc(p.kills??'—')} / ${esc(p.deaths??'—')}</td><td>${esc(p.cash??'—')}</td><td>${esc(p.pingMs??p.ping??'—')} ms</td><td>${actionBase||'—'}</td></tr>`;
  }).join('');
  const banRows=bans.map((b)=>{const steam=String(b.steamId||''),temporary=temporaryBanMap.get(steam);const expiry=temporary?.expiresAt?new Date(temporary.expiresAt):null;return `<tr><td><a target="_blank" rel="noopener" href="https://steamcommunity.com/profiles/${esc(steam)}">${esc(steam)}</a></td><td>${esc(b.reason||temporary?.reason||'—')}</td><td>${esc(b.bannedBy||temporary?.createdBy||'—')}</td><td>${b.bannedAtUtc&&String(b.bannedAtUtc).startsWith('0001-')?'—':esc(b.bannedAtUtc||temporary?.createdAt||'—')}</td><td>${expiry&&!Number.isNaN(expiry.getTime())?`<span class="badge neutral">${esc(expiry.toLocaleString(localeCode(langOf(req))))}</span>`:`<span class="badge error">${l(req,'Permanent','Permanent')}</span>`}</td><td><form method="post" action="/managed-bots/${esc(bot.id)}/ban/remove" onsubmit="return confirm('${l(req,'Ban wirklich entfernen?','Really remove this ban?')}')"><input type="hidden" name="_csrf" value="${token}"><input type="hidden" name="steamId" value="${esc(steam)}"><button class="button ghost smallbtn">Unban</button></form></td></tr>`;}).join('');
  const canWriteReserved=supports('POST','/v1/reserved-slots')&&supports('DELETE','/v1/reserved-slots/{steamId}');
  const reservedRows=reservedIds.map((steam)=>`<tr><td><a target="_blank" rel="noopener" href="https://steamcommunity.com/profiles/${esc(steam)}">${esc(steam)}</a></td><td>${canWriteReserved?`<form method="post" action="/managed-bots/${esc(bot.id)}/reserved/remove" onsubmit="return confirm('${l(req,'Reserved Slot entfernen?','Remove reserved slot?')}')"><input type="hidden" name="_csrf" value="${token}"><input type="hidden" name="steamId" value="${esc(steam)}"><button class="button ghost smallbtn">${l(req,'Entfernen','Remove')}</button></form>`:`<span class="muted small">${l(req,'Dieser Server-Build erlaubt Änderungen nur über die Server-Konfiguration.','This server build only allows changes through the server config.')}</span>`}</td></tr>`).join('');
  const mapOptions=mapRows.map((m)=>{const id=String(m.id||m.name||'');return `<option value="${esc(id)}" ${id===String(status.map||'')?'selected':''}>${esc(m.displayName||id)}</option>`;}).join('');
  const lightingOptions=lightingRows.map((x)=>`<option value="${esc(x.id||x.name||'')}">${esc(x.displayName||x.id||x.name||'')}</option>`).join('');
  const rotationHtml=rotationRows.length?`<div class="panel tablewrap managed-section"><div class="managed-heading"><div><span class="eyebrow">Rotation</span><h2>${l(req,'Map-Rotation','Map rotation')}</h2></div></div><table><thead><tr><th>#</th><th>Map</th><th>Experience</th><th>Lighting</th><th>Status</th></tr></thead><tbody>${rotationRows.map((r)=>`<tr><td>${esc(r.index??'—')}</td><td>${esc(r.map||'—')}</td><td>${esc(Array.isArray(r.experiences)?r.experiences.join(', '):(r.experiences||'—'))}</td><td>${esc(r.lighting||'—')}</td><td>${esc(r.status||'—')}</td></tr>`).join('')}</tbody></table></div>`:'';
  const auditEntries=Array.isArray(live.audit?.entries)?live.audit.entries:[];
  const auditHtml=auditEntries.length?`<details class="panel managed-details"><summary>${l(req,'WARDOGS Audit Log anzeigen','Show WARDOGS audit log')} (${auditEntries.length})</summary><div class="tablewrap"><table><thead><tr><th>${l(req,'Zeit','Time')}</th><th>Event</th><th>Detail</th><th>Peer</th></tr></thead><tbody>${auditEntries.map((a)=>`<tr><td>${esc(a.timestampUtc||'—')}</td><td>${esc(a.event||'—')}</td><td>${esc(a.detail||'—')}</td><td>${esc(a.peer||'—')}</td></tr>`).join('')}</tbody></table></div></details>`:'';
  const errors=Object.entries(live.errors||{}).filter(([k])=>!['audit','rotation','maps','lightings','experiences','health','capabilities','reserved','serverId'].includes(k)).map(([k,v])=>`${k}: ${v}`);
  let html = `<div class="managed-live">
    <div class="pagehead compact managed-live-head"><div><h2>${l(req,'Live Server Management','Live server management')}</h2></div><a class="button ghost" href="${esc(managedManageUrl(bot.serviceId,bot.id))}">${l(req,'Aktualisieren','Refresh')}</a></div>
    ${errors.length?`<div class="warning">${esc(errors.join(' · '))}</div>`:''}
    <section class="managed-stats">
      <article class="panel"><span class="eyebrow">Server</span><strong>${esc(status.serverName||'—')}</strong><span>${esc(status.map||'—')}${live.serverId?.serverId?` · ${l(req,'Join Code','Join code')}: ${esc(live.serverId.serverId)}`:''}</span></article>
      <article class="panel"><span class="eyebrow">Players</span><strong>${esc(status.players?.current??players.length)} / ${esc(status.players?.max??'—')}</strong><span>${l(req,'online','online')}</span></article>
      <article class="panel"><span class="eyebrow">Health</span><strong>${esc(health.status|| (live.status?'ok':'—'))}</strong><span>Uptime ${esc(fmtUptime(health.uptimeSeconds))}</span></article>
      <article class="panel"><span class="eyebrow">Build</span><strong>${esc(live.capabilities?.build||'—')}</strong><span>API ${esc(live.capabilities?.apiVersion||'—')}</span></article>
    </section>
    <section class="managed-grid">
      <form method="post" action="/managed-bots/${esc(bot.id)}/broadcast" class="panel formgrid managed-section"><div class="span2 managed-heading"><div><span class="eyebrow">Broadcast</span><h2>${l(req,'Server Announcement','Server announcement')}</h2></div></div><input type="hidden" name="_csrf" value="${token}"><label class="span2">${l(req,'Nachricht an alle Spieler','Message to all players')}<textarea name="message" rows="3" maxlength="200" required placeholder="${l(req,'Server restart in 10 minutes…','Server restart in 10 minutes…')}"></textarea><span class="muted small">1–200 ${l(req,'Zeichen','characters')}</span></label><div class="span2 actions"><button class="button primary">${l(req,'Announcement senden','Send announcement')}</button></div></form>
      ${factions.length?`<form method="post" action="/managed-bots/${esc(bot.id)}/faction/message" class="panel formgrid managed-section"><div class="span2 managed-heading"><div><span class="eyebrow">Whisper</span><h2>${l(req,'Fraktion anschreiben','Whisper faction')}</h2></div></div><input type="hidden" name="_csrf" value="${token}"><label>${l(req,'Fraktion','Faction')}<select name="faction" required><option value="">${l(req,'Fraktion wählen…','Choose faction…')}</option>${factions.map((team)=>`<option value="${esc(team)}">${esc(team)}</option>`).join('')}</select></label><label class="span2">${l(req,'Nachricht','Message')}<textarea name="message" rows="4" maxlength="200" required placeholder="${l(req,'Nachricht an alle Spieler dieser Fraktion…','Message to all players in this faction…')}"></textarea></label><div class="span2 actions"><button class="button primary">${l(req,'An Fraktion wispern','Whisper faction')}</button></div></form>`:''}
      <div class="panel formgrid managed-section"><div class="span2 managed-heading"><div><span class="eyebrow">Match</span><h2>${l(req,'Server Controls','Server controls')}</h2></div></div><div class="span2 actions wrap"><form method="post" action="/managed-bots/${esc(bot.id)}/match/restart" onsubmit="return confirm('${l(req,'Aktuelles Match neu starten?','Restart the current match?')}')"><input type="hidden" name="_csrf" value="${token}"><button class="button ghost">${l(req,'Match neu starten','Restart match')}</button></form><form method="post" action="/managed-bots/${esc(bot.id)}/match/end" onsubmit="return confirm('${l(req,'Aktuelles Match beenden?','End the current match?')}')"><input type="hidden" name="_csrf" value="${token}"><button class="button danger">${l(req,'Match beenden','End match')}</button></form></div></div>
    </section>
    <div class="panel tablewrap managed-section" data-managed-player-list><div class="managed-heading padded managed-player-list-head"><div><span class="eyebrow">Players</span><h2>${l(req,'Live-Spielerliste','Live player list')}</h2><p><span data-managed-player-visible>${players.length}</span> / ${players.length} ${l(req,'Spieler','players')}</p></div><label class="managed-player-search"><span>${l(req,'Spieler suchen','Search players')}</span><input type="search" data-managed-player-search autocomplete="off" placeholder="${l(req,'Name oder SteamID…','Name or SteamID…')}"></label></div><table><thead><tr><th>Player</th><th>Faction</th><th>K/D</th><th>Cash</th><th>Ping</th><th>${l(req,'Aktionen','Actions')}</th></tr></thead><tbody>${playerRows||`<tr><td colspan="6">${l(req,'Keine Spieler online.','No players online.')}</td></tr>`}<tr data-managed-player-empty hidden><td colspan="6">${l(req,'Kein Spieler passt zur Suche.','No player matches the search.')}</td></tr></tbody></table></div>
    <section class="managed-grid">
      <div class="panel formgrid managed-section"><div class="span2 managed-heading"><div><span class="eyebrow">Ban</span><h2>${l(req,'Spieler bannen','Ban player')}</h2></div></div><div class="span2 actions"><button class="button danger" type="button" data-open-managed-ban data-steam-id="" data-player-name="">${l(req,'BAN-Dialog öffnen','Open BAN dialog')}</button></div></div>
      ${mapOptions?`<form method="post" action="/managed-bots/${esc(bot.id)}/match/map" class="panel formgrid managed-section" data-managed-map-form data-lang="${esc(lang)}" data-options-url="/managed-bots/${esc(bot.id)}/map-options"><div class="span2 managed-heading"><div><span class="eyebrow">Map</span><h2>${l(req,'Map wechseln','Change map')}</h2></div></div><input type="hidden" name="_csrf" value="${token}"><label>Map<select name="map" required data-map-select>${mapOptions}</select></label><label>Lighting<select name="lighting"><option value="">${l(req,'Server-Standard','Server default')}</option>${lightingOptions}</select></label><div class="span2"><label>Experiences</label><details class="managed-multi-dropdown"><summary data-experience-summary>${l(req,'Experiences auswählen…','Choose experiences…')}</summary><div class="managed-multi-options" data-experience-options>${expRows.slice(0,100).map((x)=>{const id=String(x.id||x.name||'');return id?`<label class="check"><input type="checkbox" name="experiences" value="${esc(id)}"> ${esc(x.displayName||id)}</label>`:'';}).join('')}</div></details><span class="muted small">${l(req,'Mehrere Einträge können angehakt werden. Die Liste wird beim Mapwechsel automatisch auf die Map gefiltert.','Multiple entries can be checked. The list is automatically filtered for the selected map.')}</span></div><label class="span2">Zone Alternator<select name="zoneAlternator" data-alternator-select><option value="">${l(req,'Server-Standard','Server default')}</option></select></label><div class="span2 actions"><button class="button primary">${l(req,'Mapwechsel senden','Send map change')}</button></div></form>`:''}
      ${lightingOptions?`<form method="post" action="/managed-bots/${esc(bot.id)}/lighting" class="panel formgrid managed-section"><div class="span2 managed-heading"><div><span class="eyebrow">World</span><h2>${l(req,'Lighting ändern','Change lighting')}</h2></div></div><input type="hidden" name="_csrf" value="${token}"><label class="span2">Lighting<select name="lighting" required>${lightingOptions}</select></label><div class="span2 actions"><button class="button ghost">${l(req,'Lighting anwenden','Apply lighting')}</button></div></form>`:''}
    </section>
    <div class="panel tablewrap managed-section"><div class="managed-heading padded"><div><span class="eyebrow">Bans</span><h2>${l(req,'Server-Banliste','Server ban list')}</h2><p>${bans.length} ${l(req,'Einträge','entries')}</p></div></div><table><thead><tr><th>SteamID64</th><th>${l(req,'Grund','Reason')}</th><th>${l(req,'Von','By')}</th><th>${l(req,'Zeit','Time')}</th><th>${l(req,'Läuft ab','Expires')}</th><th></th></tr></thead><tbody>${banRows||`<tr><td colspan="6">${l(req,'Keine Bans.','No bans.')}</td></tr>`}</tbody></table></div>
    ${dynamicBanRows.length?`<div class="panel tablewrap managed-section"><div class="managed-heading padded"><div><span class="eyebrow">Dynamic Ban</span><h2>${l(req,'Aktive Dynamic Bans','Active Dynamic Bans')}</h2><p>${l(req,'Diese Spieler werden bei jedem neuen Join gekickt. Bei zu vielen Rejoins wird nur bis zur ursprünglichen Ablaufzeit auf einen normalen Ban eskaliert.','These players are kicked on every new join. Too many rejoins escalate to a normal ban only until the original expiry.')}</p></div></div><table><thead><tr><th>SteamID64</th><th>${l(req,'Grund','Reason')}</th><th>${l(req,'Läuft ab','Expires')}</th><th>Status</th><th>Rejoins</th><th></th></tr></thead><tbody>${dynamicBanHtml}</tbody></table></div>`:''}
    ${live.reserved?`<div class="panel tablewrap managed-section"><div class="managed-heading padded"><div><span class="eyebrow">Reserved Slots</span><h2>${l(req,'Reservierte Spieler','Reserved players')}</h2><p>${reservedIds.length} ${l(req,'Einträge','entries')}</p></div></div>${canWriteReserved?`<form method="post" action="/managed-bots/${esc(bot.id)}/reserved/add" class="managed-add-row"><input type="hidden" name="_csrf" value="${token}"><input name="steamId" pattern="[0-9]{17}" maxlength="17" required placeholder="SteamID64"><button class="button primary smallbtn">${l(req,'Hinzufügen','Add')}</button></form>`:`<div class="help managed-cap-note">${l(req,'Reserved Slots werden angezeigt. Dieser WARDOGS-Build bietet aber keine direkten POST/DELETE-Routen; deshalb schreibt das Panel nicht automatisch in die komplette ServerSettings.ini.','Reserved slots are shown. This WARDOGS build does not expose direct POST/DELETE routes, so the panel does not rewrite the full ServerSettings.ini automatically.')}</div>`}<table><thead><tr><th>SteamID64</th><th></th></tr></thead><tbody>${reservedRows||`<tr><td colspan="2">${l(req,'Keine reservierten Spieler.','No reserved players.')}</td></tr>`}</tbody></table></div>`:''}
    ${rotationHtml}${auditHtml}
    <div class="modal-backdrop managed-ban-modal" data-managed-ban-modal hidden>
      <div class="modal-card panel managed-ban-dialog" role="dialog" aria-modal="true" aria-labelledby="managed-ban-title">
        <button class="modal-close" type="button" aria-label="${l(req,'Schließen','Close')}" data-close-managed-ban>×</button>
        <span class="eyebrow">WARDOGS</span><h2 id="managed-ban-title">BAN</h2>
        <div class="managed-ban-target" data-ban-target-label>${l(req,'Spieler auswählen','Choose player')}</div>
        <form method="post" action="/managed-bots/${esc(bot.id)}/ban/add" class="managed-ban-dialog-form" data-managed-ban-form>
          <input type="hidden" name="_csrf" value="${token}">
          <label>SteamID64<input name="steamId" data-ban-steam-id inputmode="numeric" pattern="[0-9]{17}" maxlength="17" required placeholder="7656119…"></label>
          ${templates.length?`<label>${l(req,'Ban Template','Ban template')}<select name="templateId" data-ban-template>${templateOptions}</select></label>`:''}
          <label class="span2 managed-ban-reason-label">${l(req,'Ban-Grund','Ban reason')}<textarea name="reason" data-ban-reason rows="6" maxlength="180" placeholder="${l(req,'Ban-Grund eingeben…','Enter ban reason…')}"></textarea><span class="muted small"><span data-ban-reason-count>0</span>/180</span></label>
          <label class="span2">${l(req,'Ban-Dauer','Ban duration')}${managedDurationControlsHtml(req,'duration',0)}</label>
          ${bot.dynamicBanEnabled===true?`<div class="span2 help"><strong>Dynamic Ban:</strong> ${l(req,'Bei temporärer Dauer wird zuerst nur bei jedem Rejoin gekickt. Eine Eskalation auf normalen WARDOGS-Ban endet trotzdem exakt zur ursprünglich gewählten Ablaufzeit. Permanente Bans bleiben normale Bans.','For temporary durations the player is initially kicked on every rejoin. Any escalation to a normal WARDOGS ban still ends exactly at the originally selected expiry. Permanent bans remain normal bans.')}</div>`:''}
          <div class="span2 actions managed-ban-dialog-actions"><button class="button ghost" type="button" data-close-managed-ban>${l(req,'Abbrechen','Cancel')}</button><button class="button danger managed-ban-confirm" type="submit">BAN</button></div>
        </form>
      </div>
    </div>
  </div>`;
  const serverHidden=bot?._managedServerId?`<input type="hidden" name="serverId" value="${esc(bot._managedServerId)}">`:'';
  if(serverHidden)html=html.replace(/(<form\b[^>]*method="post"[^>]*>)/gi,`$1${serverHidden}`);
  if(bot?._managedServerId)html=html.replace(/data-options-url="([^"]+)"/g,(all,url)=>`data-options-url="${url}${url.includes('?')?'&':'?'}serverId=${encodeURIComponent(bot._managedServerId)}"`);
  return html;
}

function managedInstancesPanel(req,service,bots,selectedBot,subscriptions){
  const user=currentUser(req),settings=getSiteSettings(),lang=langOf(req);
  const pending=(subscriptions||[]).filter((x)=>['CREATING','APPROVAL_PENDING','APPROVED','ACTIVE_PENDING_PAYMENT'].includes(String(x.status||'').toUpperCase())&&!x.cancelledAt);
  const cards=(bots||[]).map((item,index)=>{
    const shared=item.ownerDiscordId!==user.discordId&&user.role!=='admin';
    const sub=shared?null:serviceSubscriptionForBot(item),state=String(sub?.status||'').toUpperCase();
    const active=managedAccessActive(item)||user.role==='admin';
    const label=item.name||`${service.nameDe||service.nameEn||'Managed Bot'} #${index+1}`;
    const access=item.adminGrant?l(req,'Admin gratis','Admin free'):active?l(req,'Aktiv','Active'):l(req,'Abgelaufen','Expired');
    const badge=item.adminGrant?'online':active?'online':'offline';
    const owner=shared?findUser(item.ownerDiscordId):null;
    const detail=shared?`${l(req,'Geteilter Zugriff','Shared access')} · ${esc(owner?.globalName||owner?.username||item.ownerDiscordId)}`:item.adminGrant?l(req,'Kostenlose Admin-Instanz','Free admin instance'):state?`PayPal · ${esc(state)}`:l(req,'Eigene Bot-Instanz','Dedicated bot instance');
    return `<a class="panel managed-instance-card ${selectedBot?.id===item.id?'selected':''}" href="${esc(managedManageUrl(service.id,item.id))}"><div class="row between"><strong>${esc(label)}</strong><span class="badge ${badge}">${esc(access)}</span></div><div class="muted small">${detail}</div></a>`;
  }).join('');
  const pendingRows=pending.map((record)=>`<div class="panel managed-pending-instance"><div><span class="eyebrow">PayPal</span><strong>${l(req,'Neue Instanz wird aktiviert','New instance is being activated')}</strong><div class="muted small">${esc(String(record.status||'').toUpperCase())}</div></div>${record.subscriptionId?`<form method="post" action="/bot-services/${esc(service.id)}/subscription/cancel" class="inline" onsubmit="return confirm('${l(req,'Offenen Aboabschluss wirklich abbrechen?','Cancel this pending subscription checkout?')}')"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><input type="hidden" name="recordId" value="${esc(record.id)}"><button class="button danger smallbtn">${l(req,'Aboabschluss abbrechen','Cancel checkout')}</button></form>`:''}</div>`).join('');
  let add='';
  if(user.role==='admin') add=`<form method="post" action="/bot-services/${esc(service.id)}/admin-activate" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button success">+ ${l(req,'Weitere Gratis-Instanz','Add free instance')}</button></form>`;
  else if(pending.length) add=`<span class="button ghost disabled">${l(req,'PayPal-Abo wird verarbeitet','PayPal subscription pending')}</span>`;
  else if(normalizedMoney(service.monthlyAmount)) add=`<a class="button primary" href="/bot-services/${esc(service.id)}/checkout">+ ${l(req,'Weiteren Bot holen','Add another bot')} · ${esc(normalizedMoney(service.monthlyAmount))} ${esc(service.currency||'EUR')} / ${l(req,'Monat','month')}</a>`;
  return `<section class="managed-instances"><div class="pagehead compact"><div><span class="eyebrow">${l(req,'Deine Instanzen','Your instances')}</span><h2>${l(req,'Managed Bots','Managed bots')}</h2></div><div class="actions wrap">${add}</div></div>${cards?`<div class="managed-instance-grid">${cards}</div>`:`<div class="panel empty">${l(req,'Noch keine Bot-Instanz aktiv.','No bot instance active yet.')}</div>`}${pendingRows?`<div class="managed-pending-list">${pendingRows}</div>`:''}</section>`;
}

app.post('/bot-services/:id/admin-activate', requireAdmin, checkCsrf, (req,res)=>{
  const service=getBotService(req.params.id),user=currentUser(req); if(!supportedManagedService(service))return res.status(404).send('Service not found');
  const existing=managedOwnedServicesForUser(user.discordId,service.id);
  const bot=upsertManagedBot({ownerDiscordId:user.discordId,serviceId:service.id,name:`${service.nameDe||service.nameEn||'WARDOGS Bot'} #${existing.length+1}`,enabled:false,autoBanEnabled:false,welcomeWhisperEnabled:false,welcomeWhisperMessage:'Hello {player}, welcome to the server! Join our Discord.',pollSeconds:service.id===PLAYTIME_SERVICE_ID?30:20,rulesText:'',statsTimezone:'Europe/Vienna',adminGrant:true,accessSource:'admin',accessRecordId:'',accessUntil:null});
  rebalanceAssignments();
  flash(req,'ok',l(req,'Neue Managed-Bot-Instanz wurde für deinen Admin-Account kostenlos angelegt.','A new managed-bot instance was created free for your admin account.'));
  res.redirect(managedManageUrl(service.id,bot.id));
});

app.post('/managed-bots/:id/panel-users/add', requireLogin, checkCsrf, (req,res)=>{
  const bot=managedOwner(req,req.params.id);if(!bot)return res.status(404).send('Managed bot not found');
  const discordId=String(req.body.discordId||'').trim();
  const target=findUser(discordId);
  if(!target||target.discordId===bot.ownerDiscordId){flash(req,'err',l(req,'Panel-User nicht gefunden. Der User muss sich zuerst im Panel angemeldet haben.','Panel user not found. The user must have logged in to the panel first.'));return res.redirect(managedManageUrl(bot.serviceId,bot.id));}
  const ids=[...new Set([...(Array.isArray(bot.sharedPanelUserIds)?bot.sharedPanelUserIds:[]).map(String),discordId])].filter((id)=>/^\d{17,20}$/.test(id)&&id!==String(bot.ownerDiscordId||'')).slice(0,20);
  upsertManagedBot({id:bot.id,sharedPanelUserIds:ids});
  appendManagedAudit(bot.id,{actor:`web:${currentUser(req)?.discordId||'unknown'}`,action:'panel-user-added',target:discordId,detail:target.globalName||target.username||discordId});
  flash(req,'ok',l(req,'Panel-User wurde zum Service-BOT hinzugefügt.','Panel user was added to the service bot.'));
  res.redirect(managedManageUrl(bot.serviceId,bot.id));
});

app.post('/managed-bots/:id/panel-users/:discordId/remove', requireLogin, checkCsrf, (req,res)=>{
  const bot=managedOwner(req,req.params.id);if(!bot)return res.status(404).send('Managed bot not found');
  const discordId=String(req.params.discordId||'').trim();
  const ids=(Array.isArray(bot.sharedPanelUserIds)?bot.sharedPanelUserIds:[]).map(String).filter((id)=>id!==discordId&&/^\d{17,20}$/.test(id));
  upsertManagedBot({id:bot.id,sharedPanelUserIds:ids});
  appendManagedAudit(bot.id,{actor:`web:${currentUser(req)?.discordId||'unknown'}`,action:'panel-user-removed',target:discordId});
  flash(req,'ok',l(req,'Panel-User wurde entfernt.','Panel user was removed.'));
  res.redirect(managedManageUrl(bot.serviceId,bot.id));
});

function managedDeletePanel(req, service, bot, sub) {
  const token=esc(csrf(req));
  const hasPaidSubscription=Boolean(sub?.subscriptionId);
  const warning=hasPaidSubscription
    ? l(req,'Beim Löschen wird das zugehörige PayPal-Abo beendet. Es gibt KEINE Rückerstattung; bereits bezahlte Restlaufzeit verfällt. Konfiguration, Statistiken und gespeicherte Daten dieser Instanz werden dauerhaft gelöscht.','Deleting this instance also cancels its linked PayPal subscription. There is NO refund; any remaining paid time is forfeited. Configuration, statistics and stored data for this instance are permanently deleted.')
    : l(req,'Diese Service-Bot-Instanz wird dauerhaft gelöscht. Konfiguration, Statistiken und gespeicherte Daten gehen verloren. Diese Aktion kann nicht rückgängig gemacht werden.','This service-bot instance will be permanently deleted. Configuration, statistics and stored data will be lost. This action cannot be undone.');
  const confirmText=hasPaidSubscription
    ? l(req,'WIRKLICH löschen? Das PayPal-Abo wird gekündigt, es gibt KEINEN REFUND und die verbleibende Laufzeit verfällt. Alle Daten dieser Bot-Instanz werden gelöscht.','DELETE this instance? The PayPal subscription will be cancelled, there is NO REFUND, remaining paid time is forfeited, and all data for this bot instance will be deleted.')
    : l(req,'WIRKLICH löschen? Alle Daten dieser Bot-Instanz werden dauerhaft gelöscht.','DELETE this instance? All data for this bot instance will be permanently deleted.');
  return `<section class="panel danger-zone"><span class="eyebrow">${l(req,'Danger Zone','Danger zone')}</span><h2>${l(req,'Service Bot löschen','Delete service bot')}</h2><p class="warning"><strong>${l(req,'Wichtig: Kein Refund','Important: No refund')}</strong><br>${esc(warning)}</p><form method="post" action="/bot-services/${esc(service.id)}/instances/${esc(bot.id)}/delete" onsubmit="return confirm('${confirmText.replace(/'/g,"\\'")}')"><input type="hidden" name="_csrf" value="${token}"><button class="button danger" type="submit">${hasPaidSubscription?l(req,'Abo kündigen & Bot endgültig löschen','Cancel subscription & permanently delete bot'):l(req,'Bot endgültig löschen','Permanently delete bot')}</button></form></section>`;
}

function managedPanelUsersPanel(req, bot) {
  const user=currentUser(req);
  if(!isManagedOwnerUser(user,bot))return '';
  const db=readDb();
  const ids=[...new Set((Array.isArray(bot.sharedPanelUserIds)?bot.sharedPanelUserIds:[]).map(String).filter((id)=>/^\d{17,20}$/.test(id)&&id!==String(bot.ownerDiscordId||'')))].slice(0,20);
  const members=ids.map((id)=>db.users.find((row)=>row.discordId===id)).filter(Boolean);
  const candidates=db.users.filter((row)=>row.discordId!==bot.ownerDiscordId&&!ids.includes(row.discordId)).sort((a,b)=>String(a.globalName||a.username||a.discordId).localeCompare(String(b.globalName||b.username||b.discordId)));
  const rows=members.map((member)=>`<div class="row between wrap"><div><strong>${esc(member.globalName||member.username||member.discordId)}</strong><div class="muted small">${esc(member.username?`@${member.username} · ${member.discordId}`:member.discordId)}</div></div><form method="post" action="/managed-bots/${esc(bot.id)}/panel-users/${esc(member.discordId)}/remove" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button danger smallbtn" type="submit">${l(req,'Entfernen','Remove')}</button></form></div>`).join('');
  const add=candidates.length&&ids.length<20?`<form method="post" action="/managed-bots/${esc(bot.id)}/panel-users/add" class="formgrid"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><label class="span2">${l(req,'Panel-User hinzufügen','Add panel user')}<select name="discordId" required><option value="">${l(req,'User auswählen…','Choose user…')}</option>${candidates.map((member)=>`<option value="${esc(member.discordId)}">${esc(member.globalName||member.username||member.discordId)}${member.username?` (@${esc(member.username)})`:''}</option>`).join('')}</select></label><div class="span2 actions"><button class="button primary" type="submit">+ ${l(req,'Zugriff geben','Grant access')}</button></div></form>`:ids.length>=20?`<div class="help">${l(req,'Maximal 20 Panel-User pro Service-BOT.','A maximum of 20 panel users can be assigned per service bot.')}</div>`:`<div class="help">${l(req,'Es gibt aktuell keinen weiteren registrierten Panel-User zum Hinzufügen. Der User muss sich zuerst einmal im Panel anmelden.','There is currently no other registered panel user to add. The user must log in to the panel at least once first.')}</div>`;
  return `<section class="panel"><span class="eyebrow">Panel Access</span><h2>${l(req,'Service-BOT mit Panel-Usern teilen','Share service bot with panel users')}</h2><p>${l(req,'Mitbenutzer können diesen Service-BOT konfigurieren, starten, stoppen und bedienen. Abo, Löschen und die Benutzerfreigaben bleiben beim Eigentümer.','Shared users can configure, start, stop and operate this service bot. Subscription, deletion and user sharing remain with the owner.')}</p>${rows?`<div class="managed-pending-list">${rows}</div>`:`<p class="muted">${l(req,'Noch keine zusätzlichen Panel-User.','No additional panel users yet.')}</p>`}${add}</section>`;
}

app.get('/bot-services/:id/manage', requireLogin, async(req,res)=>{
  const service=getBotService(req.params.id),user=currentUser(req); if(!supportedManagedService(service))return res.status(404).send('Service not found');
  const bots=managedServicesForUser(user.discordId,service.id),subscriptions=listPaypalServiceSubscriptionsForUser(user.discordId,service.id);
  const requested=String(req.query.bot||'');
  const bot=bots.find((x)=>x.id===requested)||(requested?'':bots.find((x)=>managedAccessActive(x)))||bots[0]||null;
  const selected=typeof bot==='object'?bot:null;
  const overview=managedInstancesPanel(req,service,bots,selected,subscriptions);
  if(!selected){
    return render(req,res,service.nameDe||service.nameEn,`<div class="pagehead"><div><h1>${esc(service.nameDe||service.nameEn)}</h1></div><a class="button ghost" href="/bot-services">${l(req,'Zurück','Back')}</a></div>${overview}`);
  }
  const ownerAccess=isManagedOwnerUser(user,selected);
  const sub=ownerAccess?serviceSubscriptionForBot(selected):null,state=String(sub?.status||'').toUpperCase();
  const deleteHtml=ownerAccess?managedDeletePanel(req,service,selected,sub):'';
  const panelUsersHtml=managedPanelUsersPanel(req,selected);
  const authLockHtml=selected.wardogsAuthLockedAt?`<div class="panel warning"><strong>${l(req,'WARDOGS Login-Schutz aktiv','WARDOGS login protection active')}</strong><p>${l(req,'Nach 2 fehlgeschlagenen WARDOGS-Loginversuchen wurde der Bot automatisch offline geschaltet. Prüfe URL/Passwort und starte den Bot danach manuell neu.','After 2 failed WARDOGS login attempts, the bot was automatically taken offline. Check the URL/password, then start the bot manually again.')}</p>${selected.wardogsAuthLockedReason?`<div class="muted small">${esc(selected.wardogsAuthLockedReason)}</div>`:''}</div>`:'';
  const access=managedAccessActive(selected);
  if(!access&&user.role!=='admin'){
    return render(req,res,service.nameDe||service.nameEn,`<div class="pagehead"><div><h1>${esc(service.nameDe||service.nameEn)}</h1><p>${l(req,'Diese Bot-Instanz hat aktuell keinen aktiven Zugang.','This bot instance currently has no active access.')}</p></div><a class="button ghost" href="/bot-services">${l(req,'Zurück','Back')}</a></div>${overview}${authLockHtml}<div class="panel warning"><strong>${l(req,'Zugang abgelaufen','Access expired')}</strong><p>${l(req,'Du kannst oben eine neue Instanz buchen. Bestehende andere Instanzen bleiben davon unabhängig.','You can purchase a new instance above. Any other existing instances remain independent.')}</p></div>${panelUsersHtml}${deleteHtml}`);
  }
  const subHtml=!ownerAccess?`<article class="panel"><span class="eyebrow">Panel Access</span><h2>${l(req,'Geteilter Service-BOT','Shared service bot')}</h2><p>${l(req,'Du wurdest vom Eigentümer als Panel-User hinzugefügt. Abo, Löschen und Benutzerfreigaben bleiben beim Eigentümer.','The owner added you as a panel user. Subscription, deletion and user sharing remain with the owner.')}</p></article>`:sub?`<article class="panel"><span class="eyebrow">PayPal Service Abo</span><h2>${esc(selected.name||service.nameDe||service.nameEn)}</h2><p>Status: <strong>${esc(state||'—')}</strong></p>${selected.accessUntil?`<p>${l(req,'Zugang bis','Access until')}: ${esc(new Date(selected.accessUntil).toLocaleString(localeCode(langOf(req))))}</p>`:''}${sub.subscriptionId&&!sub.cancelledAt&&['ACTIVE','SUSPENDED','APPROVAL_PENDING','APPROVED','ACTIVE_PENDING_PAYMENT'].includes(state)?`<div class="warning small"><strong>${l(req,'Keine Rückerstattung','No refund')}:</strong> ${l(req,'Eine Kündigung stoppt nur zukünftige Abbuchungen. Bereits gezahlte Beträge werden nicht automatisch erstattet.','Cancellation only stops future billing. Amounts already paid are not automatically refunded.')}</div><form method="post" action="/bot-services/${esc(service.id)}/subscription/cancel" onsubmit="return confirm('${l(req,'Dieses Bot-Service-Abo wirklich kündigen? Es gibt keinen automatischen Refund. Nur diese Instanz ist betroffen.','Cancel this bot-service subscription? There is no automatic refund. Only this instance is affected.')}')"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><input type="hidden" name="recordId" value="${esc(sub.id)}"><button class="button danger">${l(req,'Service-Abo kündigen','Cancel service subscription')}</button></form>`:''}</article>`:`<article class="panel"><span class="eyebrow">Access</span><h2>${esc(selected.name||l(req,'Managed Bot','Managed bot'))}</h2><p>${selected.adminGrant?l(req,'Für Admins kostenlos aktiviert.','Activated free for admins.'):l(req,'Servicezugang aktiv.','Service access active.')}</p></article>`;
  if(service.id===PLAYTIME_SERVICE_ID){
    const rt=playtimeBotRuntime(selected.id);
    return render(req,res,service.nameDe||service.nameEn,`<div class="pagehead"><div><h1>${esc(selected.name||service.nameDe||service.nameEn)}</h1></div><a class="button ghost" href="/bot-services">${l(req,'Zurück','Back')}</a></div>${overview}${authLockHtml}<section class="account-grid">${subHtml}<article class="panel"><span class="eyebrow">WARDOGS Status Bot</span><h2>${esc(rt.state||'stopped')}</h2><p>${l(req,'Mehrere Server, Playtime, eigener Killfeed je Server und globale Kill-Stats.','Multiple servers, playtime, one killfeed per server and global kill stats.')}</p></article></section>${panelUsersHtml}${playtimeTrackerForm(req,service,selected)}${playtimeStatsPanel(req,selected)}${deleteHtml}`);
  }
  if(service.id===KILL_STATS_SERVICE_ID){
    const rt=killStatsBotRuntime(selected.id);
    return render(req,res,service.nameDe||service.nameEn,`<div class="pagehead"><div><h1>${esc(selected.name||service.nameDe||service.nameEn)}</h1></div><a class="button ghost" href="/bot-services">${l(req,'Zurück','Back')}</a></div>${overview}${authLockHtml}<section class="account-grid">${subHtml}<article class="panel"><span class="eyebrow">Killfeed & Stats</span><h2>${esc(rt.state||'stopped')}</h2><p>${l(req,'All-Time Killstatistiken und ein Discord-Killfeed, der als feste Nachricht im Channel bleibt.','All-time kill statistics and a Discord killfeed that stays in place as one fixed message.')}</p></article></section>${panelUsersHtml}${killStatsForm(req,service,selected)}${killStatsPanel(req,selected)}${deleteHtml}`);
  }
  const managementServers=normalizeManagedServers(selected);
  const selectedServerId=String(req.query.server||managementServers[0]?.id||'');
  const selectedServer=managedServerContext(selected,selectedServerId)||managedServerContext(selected,managementServers[0]);
  let live=null;
  if(selectedServer?.wardogsBaseUrl&&selectedServer?.wardogsSecretEnc){try{live=await managedDashboard(selectedServer);}catch(error){live={errors:{dashboard:error.message}};}}
  const serverTabs=managementServers.length?`<section class="panel"><div class="row between wrap"><div><span class="eyebrow">${l(req,'Gameserver auswählen','Choose game server')}</span><h2>${esc(selectedServer?._managedServerLabel||'Server')}</h2></div><div class="actions wrap">${managementServers.map((row)=>`<a class="button ${String(row.id)===String(selectedServer?._managedServerId)?'primary':'ghost'} smallbtn" href="${esc(managedManageUrl(service.id,selected.id))}&server=${encodeURIComponent(row.id)}">${esc(row.label)}</a>`).join('')}</div></div></section>`:'';
  const freshParent=getManagedBot(selected.id)||selected;
  const freshSelected=selectedServer?managedServerContext(freshParent,selectedServer._managedServerId):null;
  render(req,res,service.nameDe||service.nameEn,`<div class="pagehead"><div><h1>${esc(selected.name||service.nameDe||service.nameEn)}</h1></div><a class="button ghost" href="/bot-services">${l(req,'Zurück','Back')}</a></div>${overview}${authLockHtml}<section class="account-grid">${subHtml}<article class="panel"><span class="eyebrow">Auto-Ban</span><h2>${selected.autoBanEnabled?l(req,'AKTIV','ENABLED'):l(req,'AUS','OFF')}</h2><p>${l(req,'Auto-Ban ist standardmäßig AUS und muss ausdrücklich aktiviert werden.','Auto-ban is OFF by default and must be explicitly enabled.')}</p></article></section>${panelUsersHtml}${managedBotForm(req,service,freshParent)}${managedBanSyncPanel(req,freshParent)}${managedIgnoredPlayersPanel(req,freshParent)}${serverTabs}${freshSelected?managedOperationsPanel(req,freshSelected,live):''}${freshSelected?managedChatHistoryPanel(req,freshSelected):''}${freshSelected?managedKillFeedPanel(req,freshSelected):''}${managedAuditLogPanel(req,freshParent)}${deleteHtml}${managedChatModalHtml(req,freshParent,freshSelected)}`);
});

app.post('/bot-services/:id/instances/:botId/delete', requireLogin, checkCsrf, rateLimit({windowMs:60_000,limit:5}), async(req,res)=>{
  const user=currentUser(req),service=getBotService(req.params.id);
  try{
    if(!service||!supportedManagedService(service))throw new Error(l(req,'Bot-Service nicht gefunden.','Bot service not found.'));
    const bot=getManagedBot(String(req.params.botId||''));
    if(!bot||bot.ownerDiscordId!==user.discordId||bot.serviceId!==service.id)throw new Error(l(req,'Bot-Instanz nicht gefunden.','Bot instance not found.'));
    const sub=serviceSubscriptionForBot(bot),now=new Date().toISOString();
    if(sub?.subscriptionId&&!sub.cancelledAt){
      let details=null;
      try{details=await getSubscription(sub.subscriptionId);}catch(error){
        const localState=String(sub.status||'').toUpperCase();
        if(!['CANCELLED','EXPIRED','CANCELLED_BEFORE_APPROVAL'].includes(localState))throw new Error(`${l(req,'PayPal-Abo konnte nicht geprüft werden','PayPal subscription could not be checked')}: ${error.message}`);
      }
      const remoteState=String(details?.status||'').toUpperCase(),localState=String(sub.status||'').toUpperCase(),effectiveState=remoteState||localState;
      if(!['CANCELLED','EXPIRED','CANCELLED_BEFORE_APPROVAL'].includes(effectiveState)){
        await cancelSubscription(sub.subscriptionId,'Customer permanently deleted bot service instance');
      }
      updatePaypalServiceSubscriptionRecord(sub.id,{status:'CANCELLED',cancelledAt:now,deletedAt:now,deletedBotId:bot.id,nextBillingAt:null,remoteStatus:remoteState||null,remoteCancelError:null,lastSyncAt:now});
    }else if(sub){
      updatePaypalServiceSubscriptionRecord(sub.id,{deletedAt:now,deletedBotId:bot.id,cancelledAt:sub.cancelledAt||now,status:sub.cancelledAt?sub.status:'CANCELLED',nextBillingAt:null,lastSyncAt:now});
    }
    if(service.id==='wardogs-warning-bot'){
      // Leave the shared Ban Sync Server before local cleanup. Deleting one bot
      // must never turn its cleanup into a global unban for the other members.
      if(bot.banSyncServerId){try{await leaveManagedBanSyncServer(bot,`web:${user.discordId}`);}catch{}}
      // Clean both classic temporary bans and Dynamic Bans only on this bot.
      // Escalated Dynamic Bans are real WARDOGS bans and must not survive deleting the service.
      const cleanupIds=[...new Set([
        ...(Array.isArray(bot.temporaryBans)?bot.temporaryBans:[]),
        ...(Array.isArray(bot.dynamicBans)?bot.dynamicBans:[])
      ].map((entry)=>String(entry?.steamId||'')).filter((id)=>/^\d{17}$/.test(id)))];
      for(const steamId of cleanupIds){try{await unbanManagedPlayer({...bot,banSyncServerId:''},steamId,{actor:`web:${user.discordId}`,skipSync:true,tolerateMissing:true});}catch{}}
    }
    try{upsertManagedBot({id:bot.id,enabled:false});await stopServiceBot({...bot,enabled:false});}catch{}
    deleteManagedBot(bot.id);
    rebalanceAssignments();
    await syncAllServiceBots();
    flash(req,'ok',l(req,'Service Bot endgültig gelöscht. Ein verknüpftes PayPal-Abo wurde beendet. Es erfolgt keine Rückerstattung; verbleibende Laufzeit verfällt.','Service bot permanently deleted. Any linked PayPal subscription was cancelled. No refund is issued and any remaining paid time is forfeited.'));
  }catch(error){flash(req,'err',error.message);}
  res.redirect(service?managedManageUrl(service.id):'/bot-services');
});

app.post('/bot-services/:id/manage', requireLogin, checkCsrf, async(req,res)=>{
  const service=getBotService(req.params.id),user=currentUser(req); if(!supportedManagedService(service))return res.status(404).send('Service not found');
  let bot=ownedManaged(req,String(req.body.botId||''));
  if(!bot||bot.serviceId!==service.id)return res.status(404).send('Managed bot instance not found');
  if(!managedAccessActive(bot)&&user.role!=='admin')return res.status(403).send('Service access required');
  if(service.id===PLAYTIME_SERVICE_ID){
    try{
      const name=String(req.body.name||'').trim().slice(0,80); if(!name)throw new Error(l(req,'Bot-Name fehlt.','Bot name is required.'));
      const playtimeServers=playtimeServersFromBody(req,bot);
      const leaderboardChannelId=String(req.body.leaderboardChannelId||'').trim(); if(leaderboardChannelId&&!validSnowflake(leaderboardChannelId))throw new Error(l(req,'Discord Top-15 Leaderboard Channel ID ist ungültig.','Discord Top-15 leaderboard channel ID is invalid.'));
      const statsTimezone=String(req.body.statsTimezone||'Europe/Vienna').trim().slice(0,80)||'Europe/Vienna'; try{new Intl.DateTimeFormat('en-US',{timeZone:statsTimezone}).format(new Date());}catch{throw new Error(l(req,'Ungültige IANA-Zeitzone, z. B. Europe/Vienna.','Invalid IANA timezone, e.g. Europe/Vienna.'));}
      const primary=playtimeServers[0];
      const patch={id:bot.id,name,playtimeServers,wardogsBaseUrl:primary.baseUrl,wardogsSecretEnc:primary.secretEnc,leaderboardChannelId,statsTimezone,pollSeconds:Math.max(10,Math.min(300,Number(req.body.pollSeconds)||30)),autoRecoveryEnabled:req.body.autoRecoveryEnabled==='1',enabled:req.body.enabled==='1',allowPrivateTarget:user.role==='admin'?req.body.allowPrivateTarget==='1':Boolean(bot.allowPrivateTarget),restartNonce:Date.now(),wardogsAuthLockedAt:null,wardogsAuthLockedReason:'',wardogsAuthFailureCount:0};
      const needsDiscord=Boolean(leaderboardChannelId||playtimeServers.some((row)=>row.killFeedChannelId));
      const token=String(req.body.botToken||'').trim(); if(token){const discordBot=await validateBotToken(token);if(readDb().servers.some((x)=>x.botId===discordBot.id)||readDb().managedBots.some((x)=>x.id!==bot.id&&x.botId===discordBot.id))throw new Error(l(req,'Dieser Discord Bot Token wird bereits von einem anderen Bot verwendet.','This Discord bot token is already used by another bot.'));patch.botTokenEnc=encryptSecret(token);patch.botId=discordBot.id;} else if(needsDiscord&&!bot.botTokenEnc)throw new Error(l(req,'Für Discord Killfeeds, Slash Commands oder das Top-15-Leaderboard ist ein Discord Bot Token erforderlich.','A Discord bot token is required for Discord killfeeds, slash commands or the Top-15 leaderboard.'));
      bot=upsertManagedBot(patch); rebalanceAssignments(); await syncAllServiceBots();
      flash(req,'ok',l(req,'WARDOGS Status Bot gespeichert.','WARDOGS Status Bot saved.'));
    }catch(error){flash(req,'err',error.message);}
    return res.redirect(managedManageUrl(service.id,bot.id));
  }
  if(service.id===KILL_STATS_SERVICE_ID){
    try{
      const name=String(req.body.name||'').trim().slice(0,80); if(!name)throw new Error(l(req,'Bot-Name fehlt.','Bot name is required.'));
      const wardogsBaseUrl=String(req.body.wardogsBaseUrl||bot.wardogsBaseUrl||'').trim().replace(/\/+$/,''); if(!/^https?:\/\//i.test(wardogsBaseUrl))throw new Error(l(req,'WARDOGS API / RCON URL ist ungültig.','WARDOGS API / RCON URL is invalid.'));
      const killFeedChannelId=String(req.body.killFeedChannelId||'').trim(); if(killFeedChannelId&&!validSnowflake(killFeedChannelId))throw new Error(l(req,'Discord Killfeed Channel ID ist ungültig.','Discord killfeed channel ID is invalid.'));
      const patch={id:bot.id,name,wardogsBaseUrl,killFeedChannelId,autoRecoveryEnabled:req.body.autoRecoveryEnabled==='1',enabled:req.body.enabled==='1',allowPrivateTarget:user.role==='admin'?req.body.allowPrivateTarget==='1':Boolean(bot.allowPrivateTarget),restartNonce:Date.now(),wardogsAuthLockedAt:null,wardogsAuthLockedReason:'',wardogsAuthFailureCount:0};
      const token=String(req.body.botToken||'').trim(); if(token){const discordBot=await validateBotToken(token);if(readDb().servers.some((x)=>x.botId===discordBot.id)||readDb().managedBots.some((x)=>x.id!==bot.id&&x.botId===discordBot.id))throw new Error(l(req,'Dieser Discord Bot Token wird bereits von einem anderen Bot verwendet.','This Discord bot token is already used by another bot.'));patch.botTokenEnc=encryptSecret(token);patch.botId=discordBot.id;} else if(killFeedChannelId&&!bot.botTokenEnc)throw new Error(l(req,'Für den Discord Killfeed ist ein Discord Bot Token erforderlich.','A Discord bot token is required for the Discord killfeed.'));
      const secret=String(req.body.wardogsSecret||'').trim(); if(secret)patch.wardogsSecretEnc=encryptSecret(secret); else if(!bot.wardogsSecretEnc)throw new Error(l(req,'WARDOGS RCON/API Passwort fehlt.','WARDOGS RCON/API password is required.'));
      bot=upsertManagedBot(patch); rebalanceAssignments(); await syncAllServiceBots();
      flash(req,'ok',l(req,'Killfeed & Stats Bot gespeichert. Konfiguriere danach einmal den WARDOGS Server Feed.','Killfeed & Stats bot saved. Configure the WARDOGS Server Feed once afterwards.'));
    }catch(error){flash(req,'err',error.message);}
    return res.redirect(managedManageUrl(service.id,bot.id));
  }
  try{
    const name=String(req.body.name||'').trim().slice(0,80); if(!name)throw new Error(l(req,'Bot-Name fehlt.','Bot name is required.'));
    const managedServers=managedServersFromBody(req,bot),primary=managedServers[0];
    const mentionRoleId=String(req.body.mentionRoleId||'').trim(); if(mentionRoleId&&!validSnowflake(mentionRoleId))throw new Error(l(req,'Discord Rollen-ID ist ungültig.','Discord role ID is invalid.'));
    const discordGrants=managedGrantsFromBody(req);
    const banTemplates=managedBanTemplatesFromBody(req);
    const banSyncCommunity=bot.banSyncServerId?getBanSyncServer(String(bot.banSyncServerId)):null;
    const isCommunityOwner=Boolean(banSyncCommunity&&String(banSyncCommunity.ownerBotId||'')===String(bot.id));
    const isCommunityMember=Boolean(banSyncCommunity&&Array.isArray(banSyncCommunity.members)&&banSyncCommunity.members.map(String).includes(String(bot.id)));
    let dynamicBanEnabled=req.body.dynamicBanEnabled==='1';
    let dynamicBanEscalateJoins=Math.max(2,Math.min(20,Math.floor(Number(req.body.dynamicBanEscalateJoins)||3)));
    let dynamicBanEscalateWindowMinutes=Math.max(1,Math.min(1440,Math.floor(Number(req.body.dynamicBanEscalateWindowMinutes)||5)));
    if(isCommunityMember&&!isCommunityOwner){
      dynamicBanEnabled=banSyncCommunity.dynamicBanEnabled===true;
      dynamicBanEscalateJoins=Math.max(2,Math.min(20,Math.floor(Number(banSyncCommunity.dynamicBanEscalateJoins)||3)));
      dynamicBanEscalateWindowMinutes=Math.max(1,Math.min(1440,Math.floor(Number(banSyncCommunity.dynamicBanEscalateWindowMinutes)||5)));
    }
    const rawBanDiscordLink=String(req.body.banDiscordLink||'').trim();
    const banDiscordLink=normalizeManagedBanDiscordLink(rawBanDiscordLink);
    if(rawBanDiscordLink&&!banDiscordLink)throw new Error(l(req,'Discord-Link ist ungültig. Erlaubt sind discord.gg/... oder discord.com/invite/...','Discord link is invalid. Use discord.gg/... or discord.com/invite/....'));
    const rulesText=managedRulesFromBody(req); parseManagedRules(rulesText);
    const steamAppId='1867240';
    const announcementMessages=String(req.body.announcementMessages||'').split(/\r?\n/).map((x)=>x.trim()).filter(Boolean);
    if(announcementMessages.length>50)throw new Error(l(req,'Maximal 50 automatische Announcements sind erlaubt.','A maximum of 50 scheduled announcements is allowed.'));
    if(announcementMessages.some((x)=>x.length>200))throw new Error(l(req,'Jedes Announcement darf maximal 200 Zeichen lang sein.','Each announcement may contain at most 200 characters.'));
    const welcomeWhisperEnabled=req.body.welcomeWhisperEnabled==='1';
    const welcomeWhisperMessage=String(req.body.welcomeWhisperMessage||'').trim();
    if(welcomeWhisperMessage.length>200)throw new Error(l(req,'Der Welcome-Whisper darf maximal 200 Zeichen lang sein.','The welcome whisper may contain at most 200 characters.'));
    if(welcomeWhisperEnabled&&!welcomeWhisperMessage)throw new Error(l(req,'Für den Join-Welcome-Whisper muss eine Nachricht eingetragen sein.','A message is required when the join welcome whisper is enabled.'));
    const dynamicNameEnabled=req.body.dynamicNameEnabled==='1';
    const dynamicNameStatsEnabled=req.body.dynamicNameStatsEnabled==='1';
    const dynamicNameStatsTemplate=String(req.body.dynamicNameStatsTemplate||'{base} | {score1} | {score2} | {score3}').replace(/[\r\n\0]/g,' ').trim().slice(0,96);
    const dynamicNameSeedingEnabled=req.body.dynamicNameSeedingEnabled==='1';
    const dynamicNameSeedingMinPlayers=Math.max(1,Math.min(512,Math.floor(Number(req.body.dynamicNameSeedingMinPlayers)||1)));
    const dynamicNameSeedingMaxPlayers=Math.max(0,Math.min(512,Math.floor(Number(req.body.dynamicNameSeedingMaxPlayers)||20)));
    const dynamicNameSeedingTemplate=String(req.body.dynamicNameSeedingTemplate||'JOIN SEEDING').replace(/[\r\n\0]/g,' ').trim().slice(0,96);
    const dynamicNameRotationEnabled=req.body.dynamicNameRotationEnabled==='1';
    const dynamicNameRotationNameA=String(req.body.dynamicNameRotationNameA||'').replace(/[\r\n\0]/g,' ').trim().slice(0,96);
    const dynamicNameRotationNameB=String(req.body.dynamicNameRotationNameB||'').replace(/[\r\n\0]/g,' ').trim().slice(0,96);
    const dynamicNameRotationMinutes=Math.max(1,Math.min(1440,Math.floor(Number(req.body.dynamicNameRotationMinutes)||5)));
    if(dynamicNameEnabled&&!dynamicNameStatsEnabled&&!dynamicNameSeedingEnabled&&!dynamicNameRotationEnabled)throw new Error(l(req,'Dynamic Name ist aktiv, aber kein Modus wurde ausgewählt.','Dynamic Name is enabled, but no mode is selected.'));
    if(dynamicNameStatsEnabled&&!dynamicNameStatsTemplate)throw new Error(l(req,'Für den Stats-Modus fehlt das Namensformat.','The stats mode requires a name format.'));
    if(dynamicNameSeedingEnabled&&dynamicNameSeedingMinPlayers>dynamicNameSeedingMaxPlayers)throw new Error(l(req,'Beim Seeding-Modus muss „Ab Spieler“ kleiner/gleich „Bis Spieler“ sein.','For seeding, min players must be less than or equal to max players.'));
    if(dynamicNameSeedingEnabled&&!dynamicNameSeedingTemplate)throw new Error(l(req,'Für den Seeding-Modus fehlt der Servername.','The seeding mode requires a server name.'));
    if(dynamicNameRotationEnabled&&(!dynamicNameRotationNameA||!dynamicNameRotationNameB))throw new Error(l(req,'Für die 2-Namen-Rotation müssen Name A und Name B gesetzt sein.','Both Name A and Name B are required for two-name rotation.'));
    const patch={id:bot.id,name,managedServers,wardogsBaseUrl:primary.baseUrl,wardogsSecretEnc:primary.secretEnc,alertChannelId:primary.alertChannelId,controlPanelEnabled:primary.controlPanelEnabled,controlPanelChannelId:primary.controlPanelChannelId,mentionRoleId,discordGrants,banTemplates,banDiscordLink,dynamicBanEnabled,dynamicBanEscalateJoins,dynamicBanEscalateWindowMinutes,pollSeconds:Math.max(10,Math.min(300,Number(req.body.pollSeconds)||20)),rulesText,steamAppId,autoBanEnabled:req.body.autoBanEnabled==='1',autoRecoveryEnabled:req.body.autoRecoveryEnabled==='1',announcementEnabled:req.body.announcementEnabled==='1',announcementIntervalMinutes:Math.max(1,Math.min(1440,Number(req.body.announcementIntervalMinutes)||15)),announcementMessages:announcementMessages.join('\n'),welcomeWhisperEnabled,welcomeWhisperMessage,dynamicNameEnabled,dynamicNameStatsEnabled,dynamicNameStatsTemplate,dynamicNameSeedingEnabled,dynamicNameSeedingMinPlayers,dynamicNameSeedingMaxPlayers,dynamicNameSeedingTemplate,dynamicNameRotationEnabled,dynamicNameRotationNameA,dynamicNameRotationNameB,dynamicNameRotationMinutes,enabled:req.body.enabled==='1',allowPrivateTarget:user.role==='admin'?req.body.allowPrivateTarget==='1':Boolean(bot.allowPrivateTarget),restartNonce:Date.now(),wardogsAuthLockedAt:null,wardogsAuthLockedReason:'',wardogsAuthFailureCount:0};
    if(patch.announcementEnabled&&!announcementMessages.length)throw new Error(l(req,'Für automatische Announcements muss mindestens eine Nachricht eingetragen sein.','At least one message is required when scheduled announcements are enabled.'));
    const token=String(req.body.botToken||'').trim(); if(token){const discordBot=await validateBotToken(token);if(readDb().servers.some((x)=>x.botId===discordBot.id)||readDb().managedBots.some((x)=>x.id!==bot.id&&x.botId===discordBot.id))throw new Error(l(req,'Dieser Discord Bot Token wird bereits von einem anderen Bot verwendet.','This Discord bot token is already used by another bot.'));patch.botTokenEnc=encryptSecret(token);patch.botId=discordBot.id;} else if(!bot.botTokenEnc)throw new Error(l(req,'Discord Bot Token fehlt.','Discord bot token is required.'));
    const steamKey=String(req.body.steamWebApiKey||'').trim(); if(steamKey)patch.steamWebApiKeyEnc=encryptSecret(steamKey);
    const nextById=new Map(managedServers.map((row)=>[String(row.id),row]));
    for(const oldServer of managedServerContexts(bot)){
      const next=nextById.get(String(oldServer._managedServerId));
      if(oldServer.dynamicNameOriginalName&&(!next||String(next.baseUrl||'').toLowerCase()!==String(oldServer.wardogsBaseUrl||'').toLowerCase())){try{await restoreManagedDynamicServerName(oldServer);}catch{}}
    }
    bot=upsertManagedBot(patch);
    if(!dynamicNameEnabled){for(const server of managedServerContexts(bot)){if(!server.dynamicNameOriginalName)continue;try{await restoreManagedDynamicServerName(server);}catch(error){appendManagedAudit(bot.id,{actor:`web:${user.discordId}`,action:'dynamic-name-restore-failed',detail:`${server._managedServerLabel}: ${String(error?.message||error).slice(0,260)}`,status:'error'});}}bot=getManagedBot(bot.id)||bot;}
    if(isCommunityMember&&isCommunityOwner){
      await updateManagedBanSyncCommunitySettings(bot,{dynamicBanEnabled,dynamicBanEscalateJoins,dynamicBanEscalateWindowMinutes},`web:${user.discordId}`);
      bot=getManagedBot(bot.id)||bot;
    }
    appendManagedAudit(bot.id,{actor:`web:${user.discordId}`,action:'config-saved',detail:`Dynamic Ban: ${dynamicBanEnabled?'on':'off'} · Dynamic Name: ${dynamicNameEnabled?'on':'off'} · Ban Sync Community: ${bot.banSyncServerId||'off'}`});
    await syncAllServiceBots();
    flash(req,'ok',patch.autoBanEnabled?l(req,'Gespeichert. Auto-Ban ist AKTIV und greift nur bei deinen Regeln.','Saved. Auto-ban is ENABLED and only triggers on your rules.'):l(req,'Gespeichert. Auto-Ban ist AUS.','Saved. Auto-ban is OFF.'));
  }catch(error){flash(req,'err',error.message);}res.redirect(managedManageUrl(service.id,bot.id));
});

app.post('/bot-services/:id/test', requireLogin, checkCsrf, async(req,res)=>{
  const service=getBotService(req.params.id),user=currentUser(req); if(!supportedManagedService(service))return res.status(404).send('Service not found');
  const old=ownedManaged(req,String(req.body.botId||'')); if(!old||old.serviceId!==service.id)return res.status(404).send('Managed bot instance not found'); if(!managedAccessActive(old)&&user.role!=='admin')return res.status(403).send('Service access required');
  try{
    let test={...old,allowPrivateTarget:user.role==='admin'?req.body.allowPrivateTarget==='1':Boolean(old.allowPrivateTarget)};
    if(service.id===PLAYTIME_SERVICE_ID){
      const playtimeServers=playtimeServersFromBody(req,old),primary=playtimeServers[0];
      test={...test,playtimeServers,wardogsBaseUrl:primary.baseUrl,wardogsSecretEnc:primary.secretEnc};
    }else if(service.id==='wardogs-warning-bot'){
      const managedServers=managedServersFromBody(req,old),primary=managedServers[0];
      test={...test,managedServers,wardogsBaseUrl:primary.baseUrl,wardogsSecretEnc:primary.secretEnc};
    }else{
      test.wardogsBaseUrl=String(req.body.wardogsBaseUrl||old.wardogsBaseUrl||'').trim().replace(/\/+$/,'');
      const secret=String(req.body.wardogsSecret||'').trim(); if(secret)test.wardogsSecretEnc=encryptSecret(secret);
    }
    const token=String(req.body.botToken||'').trim(); if(token)await validateBotToken(token); else if(service.id==='wardogs-warning-bot'&&!old.botTokenEnc)throw new Error(l(req,'Discord Bot Token fehlt.','Discord bot token is required.')); else if(service.id===PLAYTIME_SERVICE_ID&&test.playtimeServers?.some((row)=>row.killFeedChannelId)&&!old.botTokenEnc)throw new Error(l(req,'Für den Discord Killfeed ist ein Discord Bot Token erforderlich.','A Discord bot token is required for the Discord killfeed.')); else if(service.id===KILL_STATS_SERVICE_ID&&String(req.body.killFeedChannelId||old.killFeedChannelId||'').trim()&&!old.botTokenEnc)throw new Error(l(req,'Für den Discord Killfeed ist ein Discord Bot Token erforderlich.','A Discord bot token is required for the Discord killfeed.'));
    if(service.id==='wardogs-warning-bot'){
      const contexts=managedServerContexts(test);const results=[];
      for(const server of contexts)results.push({server,result:await testManagedWardogs(server)});
      const players=results.reduce((sum,row)=>sum+Number(row.result?.playerCount||0),0);
      flash(req,'ok',l(req,`WARDOGS Verbindung OK · ${results.length} Server · ${players} Spieler insgesamt.`,`WARDOGS connection OK · ${results.length} servers · ${players} players total.`));
    }else{
      const result=service.id===PLAYTIME_SERVICE_ID?await testPlaytimeWardogs(test):await testKillStatsWardogs(test); flash(req,'ok',service.id===PLAYTIME_SERVICE_ID?l(req,`WARDOGS Verbindung OK · ${result.serverCount} Server · ${result.playerCount} Spieler.`,`WARDOGS connection OK · ${result.serverCount} servers · ${result.playerCount} players.`):l(req,`WARDOGS Verbindung OK · ${result.playerCount} Spieler über /v1/players.`,`WARDOGS connection OK · ${result.playerCount} players via /v1/players.`));
    }
  }catch(error){flash(req,'err',`${l(req,'Test fehlgeschlagen','Test failed')}: ${error.message}`);}res.redirect(managedManageUrl(service.id,old.id));
});

app.get('/managed-bots/:id/stats/export.docx', requireLogin, (req,res)=>{
  const bot=ownedManaged(req,req.params.id); if(!bot||bot.serviceId!==PLAYTIME_SERVICE_ID)return res.status(404).send('Not found');
  try{
    const playtimeSnapshot=playtimeTrackerSnapshot(bot);
    const killSnapshot=killStatsSnapshotFromStats(bot.killStats);
    const buffer=createStatusStatsDocx({bot,playtimeSnapshot,killSnapshot,lang:langOf(req),exportedAt:new Date()});
    const stamp=new Date().toISOString().slice(0,10);
    const safeName=String(bot.name||'WARDOGS-Status-Bot').replace(/[^a-zA-Z0-9._-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,60)||'WARDOGS-Status-Bot';
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition',`attachment; filename="${safeName}-Stats-${stamp}.docx"`);
    res.setHeader('Cache-Control','private, no-store');
    return res.send(buffer);
  }catch(error){
    flash(req,'err',`${l(req,'DOCX-Export fehlgeschlagen','DOCX export failed')}: ${String(error?.message||error).slice(0,220)}`);
    return res.redirect(managedManageUrl(bot.serviceId,bot.id));
  }
});

app.post('/managed-bots/:id/playtime/refresh', requireLogin, checkCsrf, async(req,res)=>{
  const bot=ownedManaged(req,req.params.id); if(!bot||bot.serviceId!==PLAYTIME_SERVICE_ID)return res.status(404).send('Not found'); if(!managedAccessActive(bot)&&!isAdmin(req))return res.status(403).send('Access expired');
  try{await refreshPlaytimeTracker(bot,{publish:req.body.publish==='1'});flash(req,'ok',req.body.publish==='1'?l(req,'Statistiken und Discord Top-15 Leaderboard wurden aktualisiert.','Statistics and Discord Top-15 leaderboard were refreshed.'):l(req,'Statistiken wurden aktualisiert.','Statistics refreshed.'));}
  catch(error){flash(req,'err',error.message);}res.redirect(managedManageUrl(bot.serviceId,bot.id));
});

app.post('/managed-bots/:id/killfeed/setup/:serverId', requireLogin, checkCsrf, async(req,res)=>{
  let bot=ownedManaged(req,req.params.id);if(!bot||bot.serviceId!==PLAYTIME_SERVICE_ID)return res.status(404).send('Not found');if(!managedAccessActive(bot)&&!isAdmin(req))return res.status(403).send('Access expired');
  try{
    // The button lives inside the settings form: persist the current server rows first
    // so URL/password/channel edits cannot be lost before configuring WDServerFeed.
    const playtimeServers=playtimeServersFromBody(req,bot),primary=playtimeServers[0];
    bot=upsertManagedBot({id:bot.id,playtimeServers,wardogsBaseUrl:primary.baseUrl,wardogsSecretEnc:primary.secretEnc});
    await configureWardogsPlaytimeKillFeed(bot,req.params.serverId,baseUrl);
    await syncAllServiceBots();
    flash(req,'ok',l(req,'Kill Feed für diesen Server konfiguriert. Starte jetzt genau diesen GAMESERVER einmal neu.','Kill Feed configured for this server. Restart this GAME SERVER once now.'));
  }catch(error){flash(req,'err',error.message);}
  res.redirect(managedManageUrl(bot.serviceId,bot.id));
});

app.post('/managed-bots/:id/management-feed/setup/:serverId', requireLogin, checkCsrf, async(req,res)=>{
  let bot=ownedManaged(req,req.params.id);if(!bot||bot.serviceId!=='wardogs-warning-bot')return res.status(404).send('Not found');if(!managedAccessActive(bot)&&!isAdmin(req))return res.status(403).send('Access expired');
  try{
    const managedServers=managedServersFromBody(req,bot),primary=managedServers[0];
    bot=upsertManagedBot({id:bot.id,managedServers,wardogsBaseUrl:primary.baseUrl,wardogsSecretEnc:primary.secretEnc,alertChannelId:primary.alertChannelId,controlPanelEnabled:primary.controlPanelEnabled,controlPanelChannelId:primary.controlPanelChannelId});
    await configureWardogsManagementFeed(bot,req.params.serverId,baseUrl);await syncAllServiceBots();
    appendManagedAudit(bot.id,{actor:`web:${currentUser(req)?.discordId||'unknown'}`,action:'server-feed-configured',detail:`Server ${req.params.serverId}: WDServerFeed Url + Token written; game-server restart required`});
    flash(req,'ok',l(req,'WARDOGS Server Feed für diesen Gameserver konfiguriert. Der Gameserver muss einmal neu gestartet werden.','WARDOGS Server Feed configured for this game server. Restart the game server once.'));
  }catch(error){flash(req,'err',error.message);}
  res.redirect(`${managedManageUrl(bot.serviceId,bot.id)}&server=${encodeURIComponent(req.params.serverId)}`);
});

app.post('/managed-bots/:id/killfeed/setup', requireLogin, checkCsrf, async(req,res)=>{
  const bot=ownedManaged(req,req.params.id);if(!bot||bot.serviceId!==KILL_STATS_SERVICE_ID)return res.status(404).send('Not found');if(!managedAccessActive(bot)&&!isAdmin(req))return res.status(403).send('Access expired');
  try{await configureWardogsKillFeed(bot,baseUrl);appendManagedAudit(bot.id,{actor:`web:${currentUser(req)?.discordId||'unknown'}`,action:'killfeed-configured',detail:'WDServerFeed Url + Token written; game-server restart required'});flash(req,'ok',l(req,'WARDOGS Server Feed konfiguriert. Starte jetzt den GAMESERVER einmal neu, damit WDServerFeed aktiv wird.','WARDOGS Server Feed configured. Restart the GAME SERVER once so WDServerFeed becomes active.'));}
  catch(error){flash(req,'err',error.message);}res.redirect(managedManageUrl(bot.serviceId,bot.id));
});
app.post('/managed-bots/:id/killstats/refresh', requireLogin, checkCsrf, async(req,res)=>{
  const bot=ownedManaged(req,req.params.id);if(!bot||bot.serviceId!==KILL_STATS_SERVICE_ID)return res.status(404).send('Not found');if(!managedAccessActive(bot)&&!isAdmin(req))return res.status(403).send('Access expired');
  try{await refreshKillStatsDiscord(bot);flash(req,'ok',l(req,'Discord Killfeed aktualisiert.','Discord killfeed refreshed.'));}catch(error){flash(req,'err',error.message);}res.redirect(managedManageUrl(bot.serviceId,bot.id));
});

app.post('/managed-bots/:id/ignore/add', requireLogin, checkCsrf, async(req,res)=>{
  const bot=ownedManaged(req,req.params.id);if(!bot)return res.status(404).send('Not found');if(!managedAccessActive(bot)&&!isAdmin(req))return res.status(403).send('Access expired');
  const steamId=normalizeSteamId64(req.body.steamId);if(!steamId){flash(req,'err',l(req,'Ungültige SteamID64.','Invalid SteamID64.'));return res.redirect(managedManageUrl(bot.serviceId,bot.id));}
  const existing=(Array.isArray(bot.ignoredPlayers)?bot.ignoredPlayers:[]).filter((entry)=>String(entry?.steamId||'')!==steamId);
  upsertManagedBot({id:bot.id,ignoredPlayers:[...existing,{steamId,name:String(req.body.name||'').trim().slice(0,100),ignoredAt:new Date().toISOString(),ignoredBy:String(currentUser(req)?.discordId||'web')}].slice(-500)});
  appendManagedAudit(bot.id,{actor:`web:${currentUser(req)?.discordId||'unknown'}`,action:'detection-ignore-add',target:steamId,detail:String(req.body.name||'').trim().slice(0,100)});
  await syncAllServiceBots();flash(req,'ok',l(req,'Spieler wird ab jetzt von Detection-Warnungen und Auto-Ban ignoriert.','Player is now ignored by detection alerts and auto-ban.'));res.redirect(managedManageUrl(bot.serviceId,bot.id));
});
app.post('/managed-bots/:id/ignore/:steamId/remove', requireLogin, checkCsrf, async(req,res)=>{
  const bot=ownedManaged(req,req.params.id);if(!bot)return res.status(404).send('Not found');if(!managedAccessActive(bot)&&!isAdmin(req))return res.status(403).send('Access expired');
  const steamId=normalizeSteamId64(req.params.steamId);if(!steamId)return res.status(400).send('Invalid SteamID64');
  upsertManagedBot({id:bot.id,ignoredPlayers:(Array.isArray(bot.ignoredPlayers)?bot.ignoredPlayers:[]).filter((entry)=>String(entry?.steamId||'')!==steamId)});
  appendManagedAudit(bot.id,{actor:`web:${currentUser(req)?.discordId||'unknown'}`,action:'detection-ignore-remove',target:steamId});
  await syncAllServiceBots();flash(req,'ok',l(req,'Ignore entfernt. Der Spieler wird wieder geprüft.','Ignore removed. The player will be screened again.'));res.redirect(managedManageUrl(bot.serviceId,bot.id));
});

app.post('/managed-bots/:id/restart', requireLogin, checkCsrf, async(req,res)=>{const bot=ownedManaged(req,req.params.id);if(!bot)return res.status(404).send('Not found');const fromAdmin=isAdmin(req)&&String(req.get('referer')||'').includes('/admin'),wasEnabled=bot.enabled===true;if(!managedAccessActive(bot)&&!isAdmin(req))return res.status(403).send('Access expired');try{const fresh=upsertManagedBot({id:bot.id,enabled:true,restartNonce:Date.now(),wardogsAuthLockedAt:null,wardogsAuthLockedReason:'',wardogsAuthFailureCount:0});rebalanceAssignments();await restartServiceBot(fresh);appendManagedAudit(bot.id,{actor:`web:${currentUser(req)?.discordId||'unknown'}`,action:wasEnabled?'bot-restart':'bot-start'});flash(req,'ok',wasEnabled?l(req,'Managed Bot neu gestartet.','Managed bot restarted.'):l(req,'Managed Bot gestartet.','Managed bot started.'));}catch(error){const latest=getManagedBot(bot.id)||bot;const authLocked=Boolean(latest.wardogsAuthLockedAt)||error?.wardogsAuthLocked===true;if(!authLocked&&latest.autoRecoveryEnabled===false)upsertManagedBot({id:bot.id,enabled:false});appendManagedAudit(bot.id,{actor:`web:${currentUser(req)?.discordId||'unknown'}`,action:wasEnabled?'bot-restart-failed':'bot-start-failed',detail:String(error.message||error).slice(0,300),status:'error'});flash(req,'err',authLocked?String(error.message||wardogsAuthLockedMessage(latest.wardogsAuthLockedReason)):latest.autoRecoveryEnabled===false?error.message:l(req,`${error.message} · Auto-Recovery versucht den Start automatisch erneut.`,`${error.message} · Auto recovery will retry automatically.`));}res.redirect(fromAdmin?'/admin?tab=bots#bots':managedManageUrl(bot.serviceId,bot.id));});
app.post('/managed-bots/:id/stop', requireLogin, checkCsrf, async(req,res)=>{const bot=ownedManaged(req,req.params.id);if(!bot)return res.status(404).send('Not found');const fromAdmin=isAdmin(req)&&String(req.get('referer')||'').includes('/admin');try{upsertManagedBot({id:bot.id,enabled:false});rebalanceAssignments();await stopServiceBot(bot);appendManagedAudit(bot.id,{actor:`web:${currentUser(req)?.discordId||'unknown'}`,action:'bot-stop'});flash(req,'ok',l(req,'Managed Bot gestoppt.','Managed bot stopped.'));}catch(error){appendManagedAudit(bot.id,{actor:`web:${currentUser(req)?.discordId||'unknown'}`,action:'bot-stop-failed',detail:String(error.message||error).slice(0,300),status:'error'});flash(req,'err',error.message);}res.redirect(fromAdmin?'/admin?tab=bots#bots':managedManageUrl(bot.serviceId,bot.id));});

function managedConfigPayload(bot){
  const base={format:'status-hub-managed-bot-config',version:1,serviceId:String(bot.serviceId||''),name:String(bot.name||''),pollSeconds:Number(bot.pollSeconds||20),autoRecoveryEnabled:bot.autoRecoveryEnabled!==false,wardogsBaseUrl:String(bot.wardogsBaseUrl||'')};
  if(bot.serviceId===PLAYTIME_SERVICE_ID)return {...base,playtimeServers:playtimeTrackerServers(bot).map((row)=>({id:row.id,label:row.label,baseUrl:row.baseUrl,killFeedChannelId:String(row.killFeedChannelId||'')})),leaderboardChannelId:String(bot.leaderboardChannelId||''),statsTimezone:String(bot.statsTimezone||'Europe/Vienna')};
  if(bot.serviceId===KILL_STATS_SERVICE_ID)return {...base,killFeedChannelId:String(bot.killFeedChannelId||'')};
  return {...base,managedServers:normalizeManagedServers(bot).map((row)=>({id:row.id,label:row.label,baseUrl:row.baseUrl,alertChannelId:String(row.alertChannelId||''),controlPanelEnabled:row.controlPanelEnabled===true,controlPanelChannelId:String(row.controlPanelChannelId||'')})),alertChannelId:String(bot.alertChannelId||''),mentionRoleId:String(bot.mentionRoleId||''),controlPanelEnabled:bot.controlPanelEnabled===true,controlPanelChannelId:String(bot.controlPanelChannelId||''),discordGrants:managedGrantRows(bot),banTemplates:managedBanTemplates(bot),banDiscordLink:String(bot.banDiscordLink||''),dynamicBanEnabled:bot.dynamicBanEnabled===true,dynamicBanEscalateJoins:Number(bot.dynamicBanEscalateJoins||3),dynamicBanEscalateWindowMinutes:Number(bot.dynamicBanEscalateWindowMinutes||5),rulesText:String(bot.rulesText||''),autoBanEnabled:bot.autoBanEnabled===true,announcementEnabled:bot.announcementEnabled===true,announcementIntervalMinutes:Number(bot.announcementIntervalMinutes||15),announcementMessages:String(bot.announcementMessages||''),welcomeWhisperEnabled:bot.welcomeWhisperEnabled===true,welcomeWhisperMessage:String(bot.welcomeWhisperMessage||''),dynamicNameEnabled:bot.dynamicNameEnabled===true,dynamicNameStatsEnabled:bot.dynamicNameStatsEnabled===true,dynamicNameStatsTemplate:String(bot.dynamicNameStatsTemplate||'{base} | {score1} | {score2} | {score3}'),dynamicNameSeedingEnabled:bot.dynamicNameSeedingEnabled===true,dynamicNameSeedingMinPlayers:Number(bot.dynamicNameSeedingMinPlayers??1),dynamicNameSeedingMaxPlayers:Number(bot.dynamicNameSeedingMaxPlayers??20),dynamicNameSeedingTemplate:String(bot.dynamicNameSeedingTemplate||'JOIN SEEDING'),dynamicNameRotationEnabled:bot.dynamicNameRotationEnabled===true,dynamicNameRotationNameA:String(bot.dynamicNameRotationNameA||''),dynamicNameRotationNameB:String(bot.dynamicNameRotationNameB||''),dynamicNameRotationMinutes:Number(bot.dynamicNameRotationMinutes||5)};
}
app.get('/managed-bots/:id/config/export',requireLogin,(req,res)=>{
  const bot=ownedManaged(req,req.params.id);if(!bot)return res.status(404).send('Not found');
  const payload=managedConfigPayload(bot);
  const safeName=String(bot.name||'managed-bot').replace(/[^a-zA-Z0-9_-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,60)||'managed-bot';
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Content-Disposition',`attachment; filename="${safeName}-config.json"`);
  res.send(JSON.stringify(payload,null,2));
});
app.post('/managed-bots/:id/config/import',requireLogin,managedConfigFile,checkCsrf,async(req,res)=>{
  const bot=ownedManaged(req,req.params.id);if(!bot)return res.status(404).send('Not found');
  try{
    if(!req.file?.buffer?.length)throw new Error(l(req,'Keine JSON-Config ausgewählt.','No JSON config selected.'));
    const data=JSON.parse(req.file.buffer.toString('utf8'));
    if(data?.format!=='status-hub-managed-bot-config'||Number(data?.version)!==1)throw new Error(l(req,'Ungültiges Config-Format.','Invalid config format.'));
    if(String(data.serviceId||'')!==String(bot.serviceId||''))throw new Error(l(req,'Die Config gehört zu einem anderen Service Bot.','This config belongs to a different service bot.'));
    const patch={id:bot.id,restartNonce:Date.now(),wardogsAuthLockedAt:null,wardogsAuthLockedReason:'',wardogsAuthFailureCount:0};
    if(String(data.name||'').trim())patch.name=String(data.name).trim().slice(0,80);
    patch.pollSeconds=Math.max(10,Math.min(300,Number(data.pollSeconds)||Number(bot.pollSeconds)||20));
    patch.autoRecoveryEnabled=data.autoRecoveryEnabled!==false;
    const url=String(data.wardogsBaseUrl||'').trim().replace(/\/+$/,'');if(url&&/^https?:\/\//i.test(url))patch.wardogsBaseUrl=url;
    if(bot.serviceId===PLAYTIME_SERVICE_ID){
      const channel=String(data.leaderboardChannelId||'').trim();if(channel&&!validSnowflake(channel))throw new Error(l(req,'Discord Top-15 Leaderboard Channel ID in der Config ist ungültig.','Discord Top-15 leaderboard channel ID in config is invalid.'));
      patch.leaderboardChannelId=channel;
      const tz=String(data.statsTimezone||'Europe/Vienna').trim().slice(0,80)||'Europe/Vienna';new Intl.DateTimeFormat('en-US',{timeZone:tz}).format(new Date());patch.statsTimezone=tz;
      if(Array.isArray(data.playtimeServers)&&data.playtimeServers.length){
        const existing=playtimeTrackerServers(bot),byId=new Map(existing.map((row)=>[row.id,row])),byUrl=new Map(existing.map((row)=>[String(row.baseUrl||'').toLowerCase(),row]));
        patch.playtimeServers=data.playtimeServers.slice(0,12).map((row,index)=>{const url=String(row?.baseUrl||'').trim().replace(/\/+$/,'');if(!/^https?:\/\//i.test(url))throw new Error(l(req,`Server ${index+1}: ungültige WARDOGS URL in der Config.`,`Server ${index+1}: invalid WARDOGS URL in config.`));const id=String(row?.id||'').trim(),old=byId.get(id)||byUrl.get(url.toLowerCase())||null;const killFeedChannelId=String(row?.killFeedChannelId||'').trim();if(killFeedChannelId&&!validSnowflake(killFeedChannelId))throw new Error(l(req,`Server ${index+1}: ungültige Discord Killfeed Channel ID.`,`Server ${index+1}: invalid Discord killfeed channel ID.`));return{id:old?.id||crypto.randomUUID(),label:String(row?.label||`Server ${index+1}`).trim().slice(0,80)||`Server ${index+1}`,baseUrl:url,secretEnc:String(old?.secretEnc||''),killFeedChannelId,killFeedMessageId:String(old?.killFeedMessageId||''),killFeedTokenEnc:String(old?.killFeedTokenEnc||''),killFeedConfiguredAt:old?.killFeedConfiguredAt||null,killFeedPublicUrl:String(old?.killFeedPublicUrl||''),killFeedNeedsGameRestart:old?.killFeedNeedsGameRestart===true,killFeedLastEventAt:old?.killFeedLastEventAt||null,killFeedLastPublishedAt:old?.killFeedLastPublishedAt||null,killFeedEvents:Array.isArray(old?.killFeedEvents)?old.killFeedEvents.slice(-150):[]};});
        const primary=patch.playtimeServers[0];patch.wardogsBaseUrl=primary.baseUrl;if(primary.secretEnc)patch.wardogsSecretEnc=primary.secretEnc;
        if(patch.playtimeServers.some((row)=>!row.secretEnc))patch.enabled=false;
      }
    }else if(bot.serviceId===KILL_STATS_SERVICE_ID){
      const channel=String(data.killFeedChannelId||'').trim();if(channel&&!validSnowflake(channel))throw new Error(l(req,'Discord Killfeed Channel ID in der Config ist ungültig.','Discord killfeed channel ID in config is invalid.'));patch.killFeedChannelId=channel;
    }else{
      if(Array.isArray(data.managedServers)&&data.managedServers.length){
        const existing=normalizeManagedServers(bot),byId=new Map(existing.map((row)=>[String(row.id),row])),byUrl=new Map(existing.map((row)=>[String(row.baseUrl||'').toLowerCase(),row]));
        const usedChannels=new Set();
        patch.managedServers=data.managedServers.slice(0,12).map((row,index)=>{
          const baseUrl=String(row?.baseUrl||'').trim().replace(/\/+$/,'');
          if(!/^https?:\/\//i.test(baseUrl))throw new Error(l(req,`Server ${index+1}: ungültige WARDOGS URL in der Config.`,`Server ${index+1}: invalid WARDOGS URL in config.`));
          const old=byId.get(String(row?.id||''))||byUrl.get(baseUrl.toLowerCase())||null;
          if(!old?.secretEnc)throw new Error(l(req,`Server ${index+1}: Für neue Server werden Passwörter nicht aus Config-Dateien importiert. Lege den Server zuerst im Formular an und importiere danach erneut.`,`Server ${index+1}: passwords for new servers are not imported from config files. Add the server in the form first, then import again.`));
          const alertChannelId=String(row?.alertChannelId||'').trim();if(!validSnowflake(alertChannelId))throw new Error(l(req,`Server ${index+1}: ungültige Discord Alert Channel ID.`,`Server ${index+1}: invalid Discord alert channel ID.`));
          const controlPanelEnabled=row?.controlPanelEnabled===true;const controlPanelChannelId=String(row?.controlPanelChannelId||'').trim();
          if(controlPanelChannelId&&!validSnowflake(controlPanelChannelId))throw new Error(l(req,`Server ${index+1}: ungültige Discord Management Panel Channel ID.`,`Server ${index+1}: invalid Discord management panel channel ID.`));
          if(controlPanelEnabled&&!controlPanelChannelId)throw new Error(l(req,`Server ${index+1}: Management Panel ist aktiviert, aber keine Channel ID gesetzt.`,`Server ${index+1}: management panel is enabled but no channel ID is configured.`));
          for(const channelId of [alertChannelId,controlPanelEnabled?controlPanelChannelId:''].filter(Boolean)){if(usedChannels.has(channelId))throw new Error(l(req,`Server ${index+1}: Discord Channels dürfen innerhalb eines Management Bots nicht doppelt verwendet werden.`,`Server ${index+1}: Discord channels cannot be reused inside one management bot.`));usedChannels.add(channelId);}
          const sameTarget=String(old.baseUrl||'').toLowerCase()===baseUrl.toLowerCase();
          return{id:old.id,label:String(row?.label||`Server ${index+1}`).trim().slice(0,80)||`Server ${index+1}`,baseUrl,secretEnc:old.secretEnc,alertChannelId,controlPanelEnabled,controlPanelChannelId,controlPanelMessageId:sameTarget&&String(old.controlPanelChannelId||'')===controlPanelChannelId?String(old.controlPanelMessageId||''):'',controlPanelMessageChannelId:sameTarget&&String(old.controlPanelChannelId||'')===controlPanelChannelId?String(old.controlPanelMessageChannelId||''):'',dynamicNameOriginalName:sameTarget?String(old.dynamicNameOriginalName||''):'',dynamicNameLastAppliedName:sameTarget?String(old.dynamicNameLastAppliedName||''):'',killFeedTokenEnc:sameTarget?String(old.killFeedTokenEnc||''):'',killFeedConfiguredAt:sameTarget?(old.killFeedConfiguredAt||null):null,killFeedPublicUrl:sameTarget?String(old.killFeedPublicUrl||''):'',killFeedNeedsGameRestart:sameTarget&&old.killFeedNeedsGameRestart===true,killFeedLastEventAt:sameTarget?(old.killFeedLastEventAt||null):null,killFeedEvents:sameTarget&&Array.isArray(old.killFeedEvents)?old.killFeedEvents.slice(-150):[]};
        });
        const primary=patch.managedServers[0];patch.wardogsBaseUrl=primary.baseUrl;patch.wardogsSecretEnc=primary.secretEnc;patch.alertChannelId=primary.alertChannelId;patch.controlPanelEnabled=primary.controlPanelEnabled;patch.controlPanelChannelId=primary.controlPanelChannelId;
      }
      const alert=String(data.alertChannelId||'').trim();if(!patch.managedServers&&alert&&!validSnowflake(alert))throw new Error(l(req,'Alert Channel ID in der Config ist ungültig.','Alert channel ID in config is invalid.'));if(!patch.managedServers&&alert)patch.alertChannelId=alert;
      const mention=String(data.mentionRoleId||'').trim();if(mention&&!validSnowflake(mention))throw new Error(l(req,'Rollen-ID in der Config ist ungültig.','Role ID in config is invalid.'));patch.mentionRoleId=mention;
      const panel=String(data.controlPanelChannelId||'').trim();if(!patch.managedServers&&panel&&!validSnowflake(panel))throw new Error(l(req,'Management Panel Channel ID in der Config ist ungültig.','Management panel channel ID in config is invalid.'));if(!patch.managedServers){patch.controlPanelChannelId=panel;patch.controlPanelEnabled=data.controlPanelEnabled===true&&Boolean(panel);}
      patch.discordGrants=(Array.isArray(data.discordGrants)?data.discordGrants:[]).map((g)=>({type:g?.type==='user'?'user':'role',id:String(g?.id||''),permissions:Array.isArray(g?.permissions)?g.permissions.map(String).filter((x)=>MANAGED_DISCORD_PERMISSION_KEYS.includes(x)):[]})).filter((g)=>validSnowflake(g.id)&&g.permissions.length).slice(0,20);
      patch.banTemplates=(Array.isArray(data.banTemplates)?data.banTemplates:[]).map((t,i)=>({id:`template-${i+1}`,label:String(t?.label||'').trim().slice(0,60),reason:String(t?.reason||'').trim().slice(0,180),durationMinutes:Math.max(0,Math.min(525600,Math.floor(Number(t?.durationMinutes)||0)))})).filter((t)=>t.label&&t.reason).slice(0,12);
      const rawBanDiscordLink=String(data.banDiscordLink||'').trim();patch.banDiscordLink=normalizeManagedBanDiscordLink(rawBanDiscordLink);if(rawBanDiscordLink&&!patch.banDiscordLink)throw new Error(l(req,'Discord-Link in der Config ist ungültig.','Discord link in config is invalid.'));
      const importCommunity=bot.banSyncServerId?getBanSyncServer(String(bot.banSyncServerId)):null;
      const importCommunityMember=Boolean(importCommunity&&Array.isArray(importCommunity.members)&&importCommunity.members.map(String).includes(String(bot.id)));
      const importCommunityOwner=importCommunityMember&&String(importCommunity.ownerBotId||'')===String(bot.id);
      if(importCommunityMember&&!importCommunityOwner){
        patch.dynamicBanEnabled=importCommunity.dynamicBanEnabled===true;patch.dynamicBanEscalateJoins=Math.max(2,Math.min(20,Math.floor(Number(importCommunity.dynamicBanEscalateJoins)||3)));patch.dynamicBanEscalateWindowMinutes=Math.max(1,Math.min(1440,Math.floor(Number(importCommunity.dynamicBanEscalateWindowMinutes)||5)));
      }else{
        patch.dynamicBanEnabled=data.dynamicBanEnabled===true;patch.dynamicBanEscalateJoins=Math.max(2,Math.min(20,Math.floor(Number(data.dynamicBanEscalateJoins)||3)));patch.dynamicBanEscalateWindowMinutes=Math.max(1,Math.min(1440,Math.floor(Number(data.dynamicBanEscalateWindowMinutes)||5)));
      }
      patch.rulesText=String(data.rulesText||'').slice(0,50000);parseManagedRules(patch.rulesText);
      patch.autoBanEnabled=data.autoBanEnabled===true;
      patch.announcementEnabled=data.announcementEnabled===true;patch.announcementIntervalMinutes=Math.max(1,Math.min(1440,Number(data.announcementIntervalMinutes)||15));patch.announcementMessages=String(data.announcementMessages||'').split(/\r?\n/).map((x)=>x.trim()).filter(Boolean).slice(0,50).map((x)=>x.slice(0,200)).join('\n');
      patch.welcomeWhisperEnabled=data.welcomeWhisperEnabled===true;patch.welcomeWhisperMessage=String(data.welcomeWhisperMessage||'').trim().slice(0,200);
      patch.dynamicNameEnabled=data.dynamicNameEnabled===true;patch.dynamicNameStatsEnabled=data.dynamicNameStatsEnabled===true;patch.dynamicNameStatsTemplate=String(data.dynamicNameStatsTemplate||'{base} | {score1} | {score2} | {score3}').replace(/[\r\n\0]/g,' ').trim().slice(0,96);patch.dynamicNameSeedingEnabled=data.dynamicNameSeedingEnabled===true;patch.dynamicNameSeedingMinPlayers=Math.max(1,Math.min(512,Math.floor(Number(data.dynamicNameSeedingMinPlayers)||1)));patch.dynamicNameSeedingMaxPlayers=Math.max(patch.dynamicNameSeedingMinPlayers,Math.min(512,Math.floor(Number(data.dynamicNameSeedingMaxPlayers)||20)));patch.dynamicNameSeedingTemplate=String(data.dynamicNameSeedingTemplate||'JOIN SEEDING').replace(/[\r\n\0]/g,' ').trim().slice(0,96);patch.dynamicNameRotationEnabled=data.dynamicNameRotationEnabled===true;patch.dynamicNameRotationNameA=String(data.dynamicNameRotationNameA||'').replace(/[\r\n\0]/g,' ').trim().slice(0,96);patch.dynamicNameRotationNameB=String(data.dynamicNameRotationNameB||'').replace(/[\r\n\0]/g,' ').trim().slice(0,96);patch.dynamicNameRotationMinutes=Math.max(1,Math.min(1440,Math.floor(Number(data.dynamicNameRotationMinutes)||5)));
    }
    const imported=upsertManagedBot(patch);
    if(bot.serviceId==='wardogs-warning-bot'){
      const room=imported.banSyncServerId?getBanSyncServer(String(imported.banSyncServerId)):null;
      if(room&&String(room.ownerBotId||'')===String(imported.id)) await updateManagedBanSyncCommunitySettings(imported,{dynamicBanEnabled:imported.dynamicBanEnabled===true,dynamicBanEscalateJoins:imported.dynamicBanEscalateJoins,dynamicBanEscalateWindowMinutes:imported.dynamicBanEscalateWindowMinutes},`web:${currentUser(req)?.discordId||'unknown'}`);
    }
    appendManagedAudit(bot.id,{actor:`web:${currentUser(req)?.discordId||'unknown'}`,action:'config-imported'});await syncAllServiceBots();flash(req,'ok',l(req,'Config importiert. Tokens, Passwörter, Abo-/Besitzdaten und Laufzeitstatistiken wurden nicht überschrieben.','Config imported. Tokens, passwords, subscription/ownership data and runtime statistics were not overwritten.'));
  }catch(error){flash(req,'err',`${l(req,'Config-Import fehlgeschlagen','Config import failed')}: ${error.message}`);}
  res.redirect(managedManageUrl(bot.serviceId,bot.id));
});

function managedActionContext(req,res){
  const parent=ownedManaged(req,req.params.id);
  if(!parent){res.status(404).send('Managed bot not found');return null;}
  if(!managedAccessActive(parent)&&!isAdmin(req)){res.status(403).send('Service access expired');return null;}
  const requested=String(req.body?.serverId||req.query?.serverId||req.query?.server||'').trim();
  const bot=requested?managedServerContext(parent,requested):(managedServerContext(parent,normalizeManagedServers(parent)[0])||parent);
  if(!bot?.wardogsBaseUrl||!bot?.wardogsSecretEnc){flash(req,'err',l(req,'Für diesen Gameserver müssen WARDOGS URL und RCON-Passwort zuerst gespeichert werden.','WARDOGS URL and RCON password must be saved for this game server first.'));res.redirect(managedManageUrl(parent.serviceId,parent.id));return null;}
  return bot;
}
function managedBack(res,bot){const base=managedManageUrl(bot.serviceId,bot._managedParentBotId||bot.id);return res.redirect(bot?._managedServerId?`${base}&server=${encodeURIComponent(bot._managedServerId)}`:base);}
function managedSteamId(req){const id=String(req.body.steamId||'').trim();if(!/^\d{17}$/.test(id))throw new Error(l(req,'Ungültige SteamID64.','Invalid SteamID64.'));return id;}
function managedBanSpec(req,bot,defaultReason='Manual panel ban'){
  const templateId=String(req.body.templateId||'').trim();
  const template=managedBanTemplates(bot).find((x)=>x.id===templateId)||null;
  if(template)return {reason:template.reason,durationMinutes:template.durationMinutes,templateId:template.id};
  return {reason:String(req.body.reason||defaultReason).trim().slice(0,180)||defaultReason,durationMinutes:managedDurationMinutesFromBody(req,'durationValue','durationUnit',Math.max(0,Math.min(525600,Math.floor(Number(req.body.durationMinutes)||0))),false),templateId:''};
}
async function applyManagedBanSpec(bot,steamId,spec,createdBy='web'){
  if(Number(spec?.durationMinutes)>0)return temporaryBanManagedPlayer(bot,steamId,spec.reason,Number(spec.durationMinutes),{createdBy,templateId:spec.templateId||''});
  await banManagedPlayer(bot,steamId,spec.reason,{actor:createdBy});return null;
}
const managedActionRate=rateLimit({windowMs:60_000,limit:80,standardHeaders:'draft-8',legacyHeaders:false});
const banSyncJoinRate=rateLimit({windowMs:5*60_000,limit:15,standardHeaders:'draft-8',legacyHeaders:false});

app.post('/managed-bots/:id/ban-sync-server/create',requireLogin,managedActionRate,checkCsrf,async(req,res)=>{
  const bot=managedActionContext(req,res);if(!bot)return;
  try{
    const result=await createManagedBanSyncServer(bot,String(req.body.name||''),String(req.body.password||''),`web:${currentUser(req)?.discordId||'unknown'}`);
    flash(req,'ok',l(req,`Ban-Sync-Community „${result.name}“ erstellt. Bestehende Bans dieses Bots wurden als Startbestand übernommen. Die Dynamic-Ban-Einstellungen dieses Bots sind jetzt die Community-Vorgabe.`,`Ban Sync Community “${result.name}” created. Existing bans from this bot were imported as the initial shared set. This bot’s Dynamic Ban settings are now the community policy.`));
  }catch(error){flash(req,'err',error.message);}
  return managedBack(res,bot);
});
app.post('/managed-bots/:id/ban-sync-server/join',requireLogin,banSyncJoinRate,checkCsrf,async(req,res)=>{
  const bot=managedActionContext(req,res);if(!bot)return;
  try{
    const result=await joinManagedBanSyncServer(bot,String(req.body.serverId||''),String(req.body.password||''),`web:${currentUser(req)?.discordId||'unknown'}`);
    const first=result.errors?.[0]?` ${l(req,'Erster Fehler','First error')}: ${result.errors[0]}`:'';
    const pending=result.pending?l(req,` · ${result.pending} warten auf den nächsten Spieler-Join`,` · ${result.pending} pending until the player next joins`):'';
    const suffix=result.failed?l(req,` ${result.failed} Sync-Aktionen sind fehlgeschlagen; Details stehen im Audit Log.${first}`,` ${result.failed} sync operations failed; details are in the audit log.${first}`):'';
    flash(req,result.failed?'err':'ok',l(req,`Ban-Sync-Community „${result.room.name}“ beigetreten. ${result.applied} angewendet · ${result.skipped||0} bereits synchron${pending}. Dynamic-Ban-Einstellungen wurden vom Community-Owner übernommen.${suffix}`,`Joined Ban Sync Community “${result.room.name}”. ${result.applied} applied · ${result.skipped||0} already synchronized${pending}. Dynamic Ban settings were inherited from the community owner.${suffix}`));
  }catch(error){flash(req,'err',error.message);}
  return managedBack(res,bot);
});
app.post('/managed-bots/:id/ban-sync-server/leave',requireLogin,managedActionRate,checkCsrf,async(req,res)=>{
  const bot=ownedManaged(req,req.params.id);if(!bot)return res.status(404).send('Managed bot not found');if(!managedAccessActive(bot)&&!isAdmin(req))return res.status(403).send('Service access expired');
  try{const result=await leaveManagedBanSyncServer(bot,`web:${currentUser(req)?.discordId||'unknown'}`);flash(req,'ok',result.deleted?l(req,'Ban-Sync-Community verlassen und gelöscht, weil keine weiteren Mitglieder vorhanden waren.','Left and deleted the Ban Sync Community because no members remained.'):l(req,'Ban-Sync-Community verlassen. Bereits vorhandene Bans bleiben lokal bestehen; neue Änderungen werden nicht mehr synchronisiert.','Left the Ban Sync Community. Existing bans remain local; new changes will no longer be synchronized.'));}catch(error){flash(req,'err',error.message);}return managedBack(res,bot);
});
app.post('/managed-bots/:id/ban-sync-server/resync',requireLogin,managedActionRate,checkCsrf,async(req,res)=>{
  const bot=managedActionContext(req,res);if(!bot)return;
  try{const result=await resyncManagedBanSyncServer(bot,`web:${currentUser(req)?.discordId||'unknown'}`);const first=result.errors?.[0]?` · ${l(req,'Erster Fehler','First error')}: ${result.errors[0]}`:'';const pending=result.pending?` · ${result.pending} ${l(req,'ausstehend bis Spieler joint','pending until player joins')}`:'';const removed=result.removed?` · ${result.removed} ${l(req,'veraltete entfernt','stale removed')}`:'';flash(req,result.failed?'err':'ok',l(req,`Ban-Sync-Community synchronisiert: ${result.bans} Bans · ${result.members} Bots · ${result.applied} angewendet · ${result.skipped||0} bereits synchron${pending}${removed}${result.failed?` · ${result.failed} Fehler${first}`:''}.`,`Ban Sync Community synchronized: ${result.bans} bans · ${result.members} bots · ${result.applied} applied · ${result.skipped||0} already synchronized${pending}${removed}${result.failed?` · ${result.failed} errors${first}`:''}.`));}catch(error){flash(req,'err',error.message);}return managedBack(res,bot);
});

app.post('/managed-bots/:id/ban-sync/:sourceId/accept',requireLogin,managedActionRate,checkCsrf,async(req,res)=>{
  const bot=ownedManaged(req,req.params.id);if(!bot)return res.status(404).send('Managed bot not found');if(!managedAccessActive(bot)&&!isAdmin(req))return res.status(403).send('Service access expired');
  try{const result=await acceptManagedBanSync(bot,String(req.params.sourceId||''),`web:${currentUser(req)?.discordId||'unknown'}`);flash(req,'ok',l(req,`Ban-Sync angenommen. ${result.source.name||result.source.id} darf Bans auf diesen Bot spiegeln. Bestehende Bans wurden synchronisiert.`,`Ban sync accepted. ${result.source.name||result.source.id} may mirror bans to this bot. Existing bans were synchronized.`));}catch(error){flash(req,'err',error.message);}return managedBack(res,bot);
});
app.post('/managed-bots/:id/ban-sync/:sourceId/reject',requireLogin,managedActionRate,checkCsrf,async(req,res)=>{
  const bot=ownedManaged(req,req.params.id);if(!bot)return res.status(404).send('Managed bot not found');if(!managedAccessActive(bot)&&!isAdmin(req))return res.status(403).send('Service access expired');
  try{await rejectManagedBanSync(bot,String(req.params.sourceId||''),`web:${currentUser(req)?.discordId||'unknown'}`);flash(req,'ok',l(req,'Ban-Sync Anfrage/Verbindung wurde entfernt.','Ban sync request/connection removed.'));}catch(error){flash(req,'err',error.message);}return managedBack(res,bot);
});
app.post('/managed-bots/:id/ban-sync/resync',requireLogin,managedActionRate,checkCsrf,async(req,res)=>{
  const bot=ownedManaged(req,req.params.id);if(!bot)return res.status(404).send('Managed bot not found');if(!managedAccessActive(bot)&&!isAdmin(req))return res.status(403).send('Service access expired');
  try{const result=await syncManagedBanSnapshot(bot,null,{actor:`web:${currentUser(req)?.discordId||'unknown'}`});flash(req,'ok',l(req,`Ban-Sync abgeschlossen: ${result.synced} gespiegelt, ${result.removed} entfernt.`,`Ban sync complete: ${result.synced} mirrored, ${result.removed} removed.`));}catch(error){flash(req,'err',error.message);}return managedBack(res,bot);
});

app.get('/managed-bots/:id/chat-history',requireLogin,managedActionRate,(req,res)=>{
  const parent=ownedManaged(req,req.params.id);if(!parent||parent.serviceId!=='wardogs-warning-bot')return res.status(404).json({error:'Managed bot not found'});
  if(!managedAccessActive(parent)&&!isAdmin(req))return res.status(403).json({error:'Service access expired'});
  const serverId=String(req.query.serverId||'').trim();const server=normalizeManagedServers(parent).find((row)=>String(row.id)===serverId);
  if(!server)return res.status(404).json({error:'Managed server not found'});
  try{return res.json(readManagedChatPage(parent.id,server.id,Number(req.query.page||0),50));}catch(error){return res.status(500).json({error:String(error?.message||error).slice(0,300)});}
});

app.get('/managed-bots/:id/map-options',requireLogin,managedActionRate,async(req,res)=>{
  const parent=ownedManaged(req,req.params.id);if(!parent)return res.status(404).json({error:'Managed bot not found'});
  if(!managedAccessActive(parent)&&!isAdmin(req))return res.status(403).json({error:'Service access expired'});
  const bot=managedServerContext(parent,String(req.query.serverId||req.query.server||''))||managedServerContext(parent,normalizeManagedServers(parent)[0]);
  if(!bot?.wardogsBaseUrl||!bot?.wardogsSecretEnc)return res.status(400).json({error:'WARDOGS connection is not configured'});
  try{return res.json(await managedMapOptions(bot,String(req.query.map||'')));}catch(error){return res.status(400).json({error:String(error.message||error).slice(0,300)});}
});

app.post('/managed-bots/:id/broadcast',requireLogin,managedActionRate,checkCsrf,async(req,res)=>{const bot=managedActionContext(req,res);if(!bot)return;try{await broadcastManaged(bot,String(req.body.message||''),{actor:`web:${currentUser(req)?.discordId||'unknown'}`});flash(req,'ok',l(req,'Server-Announcement gesendet.','Server announcement sent.'));}catch(error){flash(req,'err',error.message);}return managedBack(res,bot);});
app.post('/managed-bots/:id/player/message',requireLogin,managedActionRate,checkCsrf,async(req,res)=>{const bot=managedActionContext(req,res);if(!bot)return;try{await whisperManagedPlayer(bot,managedSteamId(req),String(req.body.message||''),{actor:`web:${currentUser(req)?.discordId||'unknown'}`});flash(req,'ok',l(req,'Whisper gesendet.','Whisper sent.'));}catch(error){flash(req,'err',error.message);}return managedBack(res,bot);});
app.post('/managed-bots/:id/faction/message',requireLogin,managedActionRate,checkCsrf,async(req,res)=>{const bot=managedActionContext(req,res);if(!bot)return;try{const result=await whisperManagedFaction(bot,String(req.body.faction||''),String(req.body.message||''),{actor:`web:${currentUser(req)?.discordId||'unknown'}`});if(!result.matched)flash(req,'err',l(req,'In dieser Fraktion sind aktuell keine Spieler online.','No players from this faction are currently online.'));else if(result.failed){const detail=String(result.failures?.[0]?.error||'').slice(0,180);flash(req,'err',l(req,`${result.sent}/${result.matched} Spieler erreicht, ${result.failed} Whisper fehlgeschlagen.${detail?` Erster Fehler: ${detail}`:''}`,`${result.sent}/${result.matched} players reached, ${result.failed} whispers failed.${detail?` First error: ${detail}`:''}`));}else flash(req,'ok',l(req,`${result.sent} Spieler der Fraktion wurden angeschrieben.`,`${result.sent} faction players were whispered.`));}catch(error){flash(req,'err',error.message);}return managedBack(res,bot);});
app.post('/managed-bots/:id/player/kick',requireLogin,managedActionRate,checkCsrf,async(req,res)=>{const bot=managedActionContext(req,res);if(!bot)return;try{await kickManagedPlayer(bot,managedSteamId(req),String(req.body.reason||'Manual panel kick').trim().slice(0,180)||'Manual panel kick',{actor:`web:${currentUser(req)?.discordId||'unknown'}`});flash(req,'ok',l(req,'Kick wurde gesendet.','Kick sent.'));}catch(error){flash(req,'err',error.message);}return managedBack(res,bot);});
app.post('/managed-bots/:id/player/ban',requireLogin,managedActionRate,checkCsrf,async(req,res)=>{const bot=managedActionContext(req,res);if(!bot)return;try{const steamId=managedSteamId(req),spec=managedBanSpec(req,bot,'Manual panel ban');const temp=await applyManagedBanSpec(bot,steamId,spec,String(currentUser(req)?.discordId||'web'));flash(req,'ok',temp?l(req,`${temp.dynamic?'Dynamic Ban':'Temporärer Ban'} bis ${new Date(temp.expiresAt).toLocaleString(localeCode(langOf(req)))} aktiv.`,`${temp.dynamic?'Dynamic Ban':'Temporary ban'} active until ${new Date(temp.expiresAt).toLocaleString(localeCode(langOf(req)))}.`):l(req,'Spieler permanent gebannt.','Player permanently banned.'));}catch(error){flash(req,'err',error.message);}return managedBack(res,bot);});
app.post('/managed-bots/:id/player/kill',requireLogin,managedActionRate,checkCsrf,async(req,res)=>{const bot=managedActionContext(req,res);if(!bot)return;try{await killManagedPlayer(bot,managedSteamId(req),{actor:`web:${currentUser(req)?.discordId||'unknown'}`});flash(req,'ok',l(req,'Kill/Respawn wurde gesendet.','Kill/respawn sent.'));}catch(error){flash(req,'err',error.message);}return managedBack(res,bot);});
app.post('/managed-bots/:id/player/faction',requireLogin,managedActionRate,checkCsrf,async(req,res)=>{const bot=managedActionContext(req,res);if(!bot)return;try{await moveManagedPlayer(bot,managedSteamId(req),String(req.body.faction||''),{actor:`web:${currentUser(req)?.discordId||'unknown'}`});flash(req,'ok',l(req,'Teamwechsel wurde gesendet.','Team change sent.'));}catch(error){flash(req,'err',error.message);}return managedBack(res,bot);});
app.post('/managed-bots/:id/ban/add',requireLogin,managedActionRate,checkCsrf,async(req,res)=>{const bot=managedActionContext(req,res);if(!bot)return;try{const steamId=managedSteamId(req),spec=managedBanSpec(req,bot,'Manual panel ban');const temp=await applyManagedBanSpec(bot,steamId,spec,String(currentUser(req)?.discordId||'web'));flash(req,'ok',temp?l(req,`${temp.dynamic?'Dynamic Ban':'Temporärer Ban'} bis ${new Date(temp.expiresAt).toLocaleString(localeCode(langOf(req)))} aktiv.`,`${temp.dynamic?'Dynamic Ban':'Temporary ban'} active until ${new Date(temp.expiresAt).toLocaleString(localeCode(langOf(req)))}.`):l(req,'SteamID permanent gebannt.','SteamID permanently banned.'));}catch(error){flash(req,'err',error.message);}return managedBack(res,bot);});
app.post('/managed-bots/:id/ban/remove',requireLogin,managedActionRate,checkCsrf,async(req,res)=>{const bot=managedActionContext(req,res);if(!bot)return;try{await unbanManagedPlayer(bot,managedSteamId(req),{actor:`web:${currentUser(req)?.discordId||'unknown'}`});flash(req,'ok',l(req,'Ban entfernt.','Ban removed.'));}catch(error){flash(req,'err',error.message);}return managedBack(res,bot);});
app.post('/managed-bots/:id/reserved/add',requireLogin,managedActionRate,checkCsrf,async(req,res)=>{const bot=managedActionContext(req,res);if(!bot)return;try{await addManagedReservedSlot(bot,managedSteamId(req),{actor:`web:${currentUser(req)?.discordId||'unknown'}`});flash(req,'ok',l(req,'Reserved Slot hinzugefügt. Je nach WARDOGS-Build kann ein Server-Neustart nötig sein.','Reserved slot added. Depending on the WARDOGS build, a server restart may be required.'));}catch(error){flash(req,'err',error.message);}return managedBack(res,bot);});
app.post('/managed-bots/:id/reserved/remove',requireLogin,managedActionRate,checkCsrf,async(req,res)=>{const bot=managedActionContext(req,res);if(!bot)return;try{await removeManagedReservedSlot(bot,managedSteamId(req),{actor:`web:${currentUser(req)?.discordId||'unknown'}`});flash(req,'ok',l(req,'Reserved Slot entfernt. Je nach WARDOGS-Build kann ein Server-Neustart nötig sein.','Reserved slot removed. Depending on the WARDOGS build, a server restart may be required.'));}catch(error){flash(req,'err',error.message);}return managedBack(res,bot);});
app.post('/managed-bots/:id/match/restart',requireLogin,managedActionRate,checkCsrf,async(req,res)=>{const bot=managedActionContext(req,res);if(!bot)return;try{await restartManagedMatch(bot,{actor:`web:${currentUser(req)?.discordId||'unknown'}`});flash(req,'ok',l(req,'Match-Neustart wurde gesendet.','Match restart sent.'));}catch(error){flash(req,'err',error.message);}return managedBack(res,bot);});
app.post('/managed-bots/:id/match/end',requireLogin,managedActionRate,checkCsrf,async(req,res)=>{const bot=managedActionContext(req,res);if(!bot)return;try{await endManagedMatch(bot,{actor:`web:${currentUser(req)?.discordId||'unknown'}`});flash(req,'ok',l(req,'Match-Ende wurde gesendet.','Match end sent.'));}catch(error){flash(req,'err',error.message);}return managedBack(res,bot);});
app.post('/managed-bots/:id/match/map',requireLogin,managedActionRate,checkCsrf,async(req,res)=>{const bot=managedActionContext(req,res);if(!bot)return;try{const rawExp=Array.isArray(req.body.experiences)?req.body.experiences:String(req.body.experiences||'').split(',');await changeManagedMap(bot,{map:String(req.body.map||''),experiences:rawExp.map((x)=>String(x||'').trim()).filter(Boolean),lighting:String(req.body.lighting||''),zoneAlternator:String(req.body.zoneAlternator||'')},{actor:`web:${currentUser(req)?.discordId||'unknown'}`});flash(req,'ok',l(req,'Mapwechsel wurde gesendet.','Map change sent.'));}catch(error){flash(req,'err',error.message);}return managedBack(res,bot);});
app.post('/managed-bots/:id/lighting',requireLogin,managedActionRate,checkCsrf,async(req,res)=>{const bot=managedActionContext(req,res);if(!bot)return;try{const result=await setManagedLighting(bot,String(req.body.lighting||''),{actor:`web:${currentUser(req)?.discordId||'unknown'}`});flash(req,'ok',l(req,`Lighting wurde geändert und als ${result.lighting||result.requested} bestätigt.`,`Lighting changed and was confirmed as ${result.lighting||result.requested}.`));}catch(error){flash(req,'err',error.message);}return managedBack(res,bot);});

app.post('/bot-services/:id/paypal/subscribe', requireLogin, rateLimit({windowMs:60_000,limit:10}), checkCsrf, async(req,res)=>{
  const user=currentUser(req),service=getBotService(req.params.id); if(!supportedManagedService(service)||service.status!=='available')return res.status(404).send('Service not found');
  if(user.role==='admin')return res.redirect(`/bot-services/${encodeURIComponent(service.id)}/manage`);
  const amount=normalizedMoney(service.monthlyAmount),currency=/^[A-Z]{3}$/.test(String(service.currency||'').toUpperCase())?String(service.currency).toUpperCase():'EUR';
  if(!amount||!paypalConfigured()) {flash(req,'err',l(req,'PayPal ist für diesen Bot Service noch nicht eingerichtet.','PayPal is not configured for this bot service yet.'));return res.redirect(`/bot-services/${encodeURIComponent(service.id)}/checkout`);}
  const existing=pendingServiceSubscription(user.discordId,service.id);
  if(existing){flash(req,'err',l(req,'Ein neuer Bot-Service-Aboabschluss wird bereits verarbeitet. Schließe oder brich ihn zuerst ab. Bereits aktive Instanzen blockieren keinen weiteren Kauf.','A new bot-service subscription checkout is already pending. Complete or cancel it first. Existing active instances do not block another purchase.'));return res.redirect(managedManageUrl(service.id));}
  try{
    let settings=getSiteSettings();
    const auto=paypalAutoConfig(settings);
    if(!auto.webhookId){
      const webhook=await ensureWebhook('',`${baseUrl}/webhooks/paypal`,settings);
      settings=updateSiteSettings({premiumSales:{paypalAuto:{...auto,webhookId:webhook.id}}});
    }
    const catalog=await ensureManagedServiceSubscriptionPlan({productId:service.paypalProductId,planId:service.paypalPlanId,planMeta:service.paypalPlanMeta,name:`status-hub.lol ${service.nameEn||service.nameDe}`,description:service.descriptionEn||service.descriptionDe,amount,currency,homeUrl:`${baseUrl}/bot-services`,settings});
    const updatedService=upsertBotService({id:service.id,paypalProductId:catalog.productId,paypalPlanId:catalog.planId,paypalPlanMeta:catalog.planMeta,monthlyAmount:amount,currency});
    const record=createPaypalServiceSubscriptionRecord({id:crypto.randomUUID(),provider:'paypal_service_subscription',userDiscordId:user.discordId,serviceId:service.id,amount,currency,paypalPlanId:updatedService.paypalPlanId,status:'creating'});
    const result=await createSubscription({recordId:record.id,paypalPlanId:updatedService.paypalPlanId,returnUrl:`${baseUrl}/bot-services/${encodeURIComponent(service.id)}/paypal/return?record=${encodeURIComponent(record.id)}`,cancelUrl:`${baseUrl}/bot-services/${encodeURIComponent(service.id)}/paypal/cancel?record=${encodeURIComponent(record.id)}`,settings});
    updatePaypalServiceSubscriptionRecord(record.id,{subscriptionId:result.subscriptionId,status:result.status||'APPROVAL_PENDING'});return res.redirect(result.approvalUrl);
  }catch(error){flash(req,'err',`PayPal: ${error.message}`);return res.redirect(`/bot-services/${encodeURIComponent(service.id)}/checkout`);}
});

app.get('/bot-services/:id/paypal/return', requireLogin, rateLimit({windowMs:60_000,limit:20}), async(req,res)=>{
  const user=currentUser(req),service=getBotService(req.params.id); let target='';
  try{
    if(!service)throw new Error('Service not found');
    const record=getPaypalServiceSubscriptionRecord(String(req.query.record||''));
    if(!record||record.userDiscordId!==user.discordId||record.serviceId!==service.id)throw new Error('PayPal bot-service subscription not found');
    const subscriptionId=String(req.query.subscription_id||record.subscriptionId||''); if(!subscriptionId)throw new Error('PayPal subscription ID missing');
    const details=await getSubscription(subscriptionId);
    if(record.cancelledAt){await stopCancelledPaypalServiceSubscription({...record,subscriptionId},details);flash(req,'err',l(req,'Dieser Aboabschluss wurde bereits abgebrochen.','This subscription checkout was already cancelled.'));return res.redirect(managedManageUrl(service.id));}
    updatePaypalServiceSubscriptionRecord(record.id,{subscriptionId,status:String(details.status||record.status||'').toUpperCase(),nextBillingAt:details?.billing_info?.next_billing_time||null,lastSyncAt:new Date().toISOString()});
    if(String(details.status||'').toUpperCase()==='ACTIVE'&&details?.billing_info?.last_payment?.time){
      applyPaypalServiceSubscription({...record,subscriptionId},details,'approved');
      const bot=getManagedBotByAccessRecord(record.id); target=bot?.id||'';
      flash(req,'ok',l(req,'Neue Bot-Service-Instanz ist aktiv. Du kannst genau diesen Bot jetzt konfigurieren.','Your new bot-service instance is active. You can now configure this specific bot.'));
    } else flash(req,'ok',l(req,'PayPal verarbeitet die erste Zahlung noch. Die neue Instanz wird erst nach bestätigter Zahlung freigeschaltet.','PayPal is still processing the first payment. The new instance is unlocked after payment confirmation.'));
  }catch(error){flash(req,'err',`PayPal: ${error.message}`);}
  res.redirect(service?managedManageUrl(service.id,target):'/bot-services');
});

app.get('/bot-services/:id/paypal/cancel', requireLogin, (req,res)=>{
  const user=currentUser(req),service=getBotService(req.params.id),record=getPaypalServiceSubscriptionRecord(String(req.query.record||''));
  if(record&&record.userDiscordId===user.discordId&&record.serviceId===req.params.id&&!record.activatedAt)updatePaypalServiceSubscriptionRecord(record.id,{status:'CANCELLED_BEFORE_APPROVAL',cancelledAt:new Date().toISOString()});
  flash(req,'err',l(req,'PayPal-Aboabschluss für die neue Bot-Instanz abgebrochen.','PayPal subscription checkout for the new bot instance was cancelled.'));
  res.redirect(service?managedManageUrl(service.id):'/bot-services');
});

app.post('/bot-services/:id/subscription/cancel', requireLogin, checkCsrf, rateLimit({windowMs:60_000,limit:5}), async(req,res)=>{
  const user=currentUser(req),service=getBotService(req.params.id); let target='';
  try{
    if(!service)throw new Error('Service not found');
    const record=getPaypalServiceSubscriptionRecord(String(req.body.recordId||''));
    if(!record||record.userDiscordId!==user.discordId||record.serviceId!==service.id||!record.subscriptionId)throw new Error(l(req,'Service-Abo nicht gefunden.','Service subscription not found.'));
    const linkedBot=getManagedBotByAccessRecord(record.id); target=linkedBot?.id||'';
    if(record.cancelledAt){flash(req,'ok',l(req,'Dieses Service-Abo wurde bereits beendet.','This service subscription has already been ended.'));return res.redirect(managedManageUrl(service.id,target));}
    let details=null,lookupError=null;try{details=await getSubscription(record.subscriptionId);}catch(error){lookupError=error;}
    const localState=String(record.status||'').toUpperCase(),remoteState=String(details?.status||'').toUpperCase(),effectiveState=remoteState||localState,now=new Date().toISOString();
    if(['CANCELLED','EXPIRED'].includes(effectiveState)){
      updatePaypalServiceSubscriptionRecord(record.id,{status:effectiveState,cancelledAt:record.cancelledAt||now,nextBillingAt:null,remoteStatus:remoteState||null,lastSyncAt:now});
      flash(req,'ok',l(req,'Dieses Service-Abo ist bereits beendet.','This service subscription is already ended.'));
      return res.redirect(managedManageUrl(service.id,target));
    }
    if(effectiveState==='APPROVAL_PENDING'){
      try{await cancelSubscription(record.subscriptionId,'Cancelled before approval by customer');updatePaypalServiceSubscriptionRecord(record.id,{status:'CANCELLED',cancelledAt:now,nextBillingAt:null,remoteStatus:remoteState||'APPROVAL_PENDING',remoteCancelError:null,lastSyncAt:now});}
      catch(error){if(!details||remoteState!=='APPROVAL_PENDING')throw lookupError||error;updatePaypalServiceSubscriptionRecord(record.id,{status:'CANCELLED_BEFORE_APPROVAL',cancelledAt:now,nextBillingAt:null,remoteStatus:remoteState,remoteCancelError:String(error.message||error).slice(0,500),lastSyncAt:now});}
      flash(req,'ok',l(req,'Offener Bot-Service-Aboabschluss abgebrochen.','Pending bot-service subscription checkout cancelled.'));
      return res.redirect(managedManageUrl(service.id));
    }
    await cancelSubscription(record.subscriptionId,'Cancelled bot service by customer');
    updatePaypalServiceSubscriptionRecord(record.id,{status:'CANCELLED',cancelledAt:now,entitlementExpiresAt:record.entitlementExpiresAt||null,nextBillingAt:null,remoteStatus:remoteState||effectiveState,remoteCancelError:null,lastSyncAt:now});
    flash(req,'ok',record.entitlementExpiresAt?l(req,'Abo dieser Bot-Instanz gekündigt. Nur diese Instanz bleibt bis zum Ende des bereits bezahlten Zeitraums verfügbar.','This bot instance subscription was cancelled. Only this instance remains available until the end of the paid period.'):l(req,'Abo dieser Bot-Instanz gekündigt.','This bot instance subscription was cancelled.'));
  }catch(error){flash(req,'err',`PayPal: ${error.message}`);}
  res.redirect(service?managedManageUrl(service.id,target):'/bot-services');
});

app.post('/stripe/checkout/:planId', requireLogin, rateLimit({ windowMs: 60_000, limit: 10 }), checkCsrf, async (req, res) => {
  const user=currentUser(req); const planId=String(req.params.planId||'');
  if(!PLANS[planId]||planId==='free') return res.status(400).send('Invalid premium plan');
  const activeStripe=listStripeSubscriptionsForUser(user.discordId).find((x)=>['ACTIVE','TRIALING'].includes(String(x.status||'').toUpperCase())&&!x.cancelledAt);
  const activePaypal=listPaypalSubscriptionsForUser(user.discordId).find((x)=>String(x.status||'').toUpperCase()==='ACTIVE'&&!x.cancelledAt);
  if(activeStripe||activePaypal){flash(req,'err',l(req,'Du hast bereits ein aktives monatliches Abo. Verwalte es zuerst unter „Your Account“.','You already have an active monthly subscription. Manage it under “Your Account” first.'));return res.redirect('/account');}
  const settings=getSiteSettings(), cfg=stripeAutoConfig(settings);
  if(!stripeAutoReady(settings,planId)){flash(req,'err',l(req,'Stripe Einmalzahlung ist für diesen Plan noch nicht eingerichtet.','Stripe one-time payment is not configured for this plan yet.'));return res.redirect(`/checkout/${planId}`);}
  const record=createStripePurchase({id:crypto.randomUUID(),provider:'stripe',userDiscordId:user.discordId,planId,amount:cfg.amounts[planId],currency:cfg.currency,accessDays:cfg.accessDays,status:'creating'});
  try{
    const session=await createStripeCheckout({recordId:record.id,userDiscordId:user.discordId,planId,amount:record.amount,currency:record.currency,accessDays:record.accessDays,recurring:false,successUrl:`${baseUrl}/stripe/return?record=${encodeURIComponent(record.id)}`,cancelUrl:`${baseUrl}/stripe/cancel?record=${encodeURIComponent(record.id)}`,settings});
    updateStripePurchase(record.id,{sessionId:session.id,status:'approval_pending'}); return res.redirect(session.url);
  }catch(error){updateStripePurchase(record.id,{status:'failed',error:String(error.message||error).slice(0,500)});flash(req,'err',`Stripe: ${error.message}`);return res.redirect(`/checkout/${planId}`);}
});

app.get('/stripe/return', requireLogin, rateLimit({ windowMs:60_000, limit:20 }), async (req,res)=>{
  try{
    const user=currentUser(req), record=getStripePurchase(String(req.query.record||''))||getStripePurchaseBySession(String(req.query.session_id||''));
    if(!record||record.userDiscordId!==user.discordId) throw new Error('Stripe purchase not found');
    const sessionId=String(req.query.session_id||record.sessionId||''); if(!sessionId) throw new Error('Stripe session ID missing');
    const session=await retrieveStripeCheckout(sessionId); applyStripePurchase(record,session);
    flash(req,'ok',l(req,`Stripe-Zahlung erfolgreich. ${PLANS[record.planId].label} wurde automatisch freigeschaltet.`,`Stripe payment successful. ${PLANS[record.planId].label} was activated automatically.`));
  }catch(error){flash(req,'err',`Stripe: ${error.message}`);} res.redirect('/plans');
});
app.get('/stripe/cancel', requireLogin, (req,res)=>{const user=currentUser(req),record=getStripePurchase(String(req.query.record||''));if(record&&record.userDiscordId===user.discordId&&!record.appliedAt)updateStripePurchase(record.id,{status:'cancelled'});flash(req,'err',l(req,'Stripe-Zahlung abgebrochen.','Stripe payment cancelled.'));res.redirect(record?.planId?`/checkout/${record.planId}`:'/plans');});

app.post('/stripe/subscribe/:planId', requireLogin, rateLimit({ windowMs:60_000, limit:10 }), checkCsrf, async (req,res)=>{
  const user=currentUser(req),planId=String(req.params.planId||''); if(!PLANS[planId]||planId==='free')return res.status(400).send('Invalid premium plan');
  const settings=getSiteSettings(),cfg=stripeSubscriptionConfig(settings);
  if(!stripeSubscriptionReady(settings,planId)){flash(req,'err',l(req,'Stripe-Abo ist für diesen Plan noch nicht eingerichtet.','Stripe subscription is not configured for this plan yet.'));return res.redirect(`/checkout/${planId}`);}
  const existingStripe=listStripeSubscriptionsForUser(user.discordId).find((x)=>['ACTIVE','TRIALING','CREATING','APPROVAL_PENDING'].includes(String(x.status||'').toUpperCase())&&!x.cancelledAt);
  const existingPaypal=listPaypalSubscriptionsForUser(user.discordId).find((x)=>['ACTIVE','APPROVAL_PENDING','CREATING'].includes(String(x.status||'').toUpperCase())&&!x.cancelledAt);
  if(existingStripe||existingPaypal){flash(req,'err',l(req,'Du hast bereits ein aktives oder offenes Abo. Verwalte es zuerst unter „Your Account“.','You already have an active or pending subscription. Manage it under “Your Account” first.'));return res.redirect('/account');}
  const record=createStripeSubscriptionRecord({id:crypto.randomUUID(),provider:'stripe_subscription',userDiscordId:user.discordId,planId,amount:cfg.amounts[planId],currency:cfg.currency,status:'creating'});
  try{
    const session=await createStripeCheckout({recordId:record.id,userDiscordId:user.discordId,planId,amount:record.amount,currency:record.currency,recurring:true,successUrl:`${baseUrl}/stripe/subscription/return?record=${encodeURIComponent(record.id)}`,cancelUrl:`${baseUrl}/stripe/subscription/cancel?record=${encodeURIComponent(record.id)}`,settings});
    updateStripeSubscriptionRecord(record.id,{sessionId:session.id,status:'APPROVAL_PENDING'});return res.redirect(session.url);
  }catch(error){updateStripeSubscriptionRecord(record.id,{status:'FAILED',error:String(error.message||error).slice(0,500)});flash(req,'err',`Stripe: ${error.message}`);return res.redirect(`/checkout/${planId}`);}
});
app.get('/stripe/subscription/return', requireLogin, rateLimit({windowMs:60_000,limit:20}), async(req,res)=>{
  try{const user=currentUser(req),record=getStripeSubscriptionRecord(String(req.query.record||''))||getStripeSubscriptionBySession(String(req.query.session_id||''));if(!record||record.userDiscordId!==user.discordId)throw new Error('Stripe subscription not found');const session=await retrieveStripeCheckout(String(req.query.session_id||record.sessionId||''));updateStripeSubscriptionRecord(record.id,{sessionId:session.id,subscriptionId:typeof session.subscription==='string'?session.subscription:session.subscription?.id||'',customerId:typeof session.customer==='string'?session.customer:session.customer?.id||'',status:'CHECKOUT_COMPLETED'});await applyStripeSubscription(record,session,'checkout');flash(req,'ok',l(req,'Stripe-Abo aktiviert.','Stripe subscription activated.'));}catch(error){flash(req,'err',`Stripe: ${error.message}`);}res.redirect('/account');
});
app.get('/stripe/subscription/cancel', requireLogin, (req,res)=>{const user=currentUser(req),record=getStripeSubscriptionRecord(String(req.query.record||''));if(record&&record.userDiscordId===user.discordId&&!record.activatedAt)updateStripeSubscriptionRecord(record.id,{status:'CANCELLED_BEFORE_APPROVAL',cancelledAt:new Date().toISOString()});flash(req,'err',l(req,'Stripe-Aboabschluss abgebrochen.','Stripe subscription checkout cancelled.'));res.redirect(record?.planId?`/checkout/${record.planId}`:'/plans');});

app.post('/paypal/checkout/:planId', requireLogin, rateLimit({ windowMs: 60_000, limit: 10 }), checkCsrf, async (req, res) => {
  const user = currentUser(req);
  const planId = String(req.params.planId || '');
  if (!PLANS[planId] || planId === 'free') return res.status(400).send('Invalid premium plan');
  const activeSubscription = listPaypalSubscriptionsForUser(user.discordId).find((x) => String(x.status || '').toUpperCase() === 'ACTIVE' && !x.cancelledAt) || listStripeSubscriptionsForUser(user.discordId).find((x)=>['ACTIVE','TRIALING'].includes(String(x.status||'').toUpperCase())&&!x.cancelAtPeriodEnd&&!x.cancelledAt);
  if (activeSubscription) { flash(req,'err',l(req,'Du hast bereits ein aktives monatliches Abo. Kündige oder verwalte es zuerst unter „Your Account“.','You already have an active monthly subscription. Cancel or manage it under “Your Account” first.')); return res.redirect('/account'); }
  const settings = getSiteSettings();
  const auto = paypalAutoConfig(settings);
  if (!paypalAutoReady(settings)) { flash(req,'err',l(req,'Automatischer PayPal-Checkout ist noch nicht eingerichtet.','Automatic PayPal checkout is not configured yet.')); return res.redirect(`/checkout/${planId}`); }
  const amount = auto.amounts[planId];
  if (!amount) { flash(req,'err',l(req,'Für diesen Plan ist kein gültiger PayPal-Preis hinterlegt.','No valid PayPal price is configured for this plan.')); return res.redirect(`/checkout/${planId}`); }
  const purchase = createPaypalPurchase({ id: crypto.randomUUID(), provider: 'paypal', userDiscordId: user.discordId, planId, amount, currency: auto.currency, accessDays: auto.accessDays, status: 'creating' });
  try {
    const order = await createCheckoutOrder({ purchaseId: purchase.id, planId, amount, currency: auto.currency, returnUrl: `${baseUrl}/paypal/return?purchase=${encodeURIComponent(purchase.id)}`, cancelUrl: `${baseUrl}/paypal/cancel?purchase=${encodeURIComponent(purchase.id)}` });
    updatePaypalPurchase(purchase.id, { orderId: order.orderId, status: 'approval_pending' });
    return res.redirect(order.approvalUrl);
  } catch (error) {
    updatePaypalPurchase(purchase.id, { status: 'failed', error: String(error.message || error).slice(0,500) });
    flash(req,'err',`PayPal: ${error.message}`); return res.redirect(`/checkout/${planId}`);
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
  res.redirect(purchase?.planId?`/checkout/${purchase.planId}`:'/plans');
});

app.post('/paypal/subscribe/:planId', requireLogin, rateLimit({ windowMs: 60_000, limit: 10 }), checkCsrf, async (req, res) => {
  const user = currentUser(req);
  const planId = String(req.params.planId || '');
  if (!PLANS[planId] || planId === 'free') return res.status(400).send('Invalid premium plan');
  const settings = getSiteSettings();
  const sub = paypalSubscriptionConfig(settings);
  if (!paypalSubscriptionReady(settings, planId)) { flash(req,'err',l(req,'PayPal-Abo ist für diesen Plan noch nicht eingerichtet.','PayPal subscription is not configured for this plan yet.')); return res.redirect(`/checkout/${planId}`); }
  const existing = listPaypalSubscriptionsForUser(user.discordId).find((x) => ['ACTIVE','SUSPENDED','APPROVAL_PENDING','APPROVED','ACTIVE_PENDING_PAYMENT','CREATING'].includes(String(x.status || '').toUpperCase()) && !x.cancelledAt) || listStripeSubscriptionsForUser(user.discordId).find((x)=>['ACTIVE','TRIALING','APPROVAL_PENDING','CREATING'].includes(String(x.status||'').toUpperCase())&&!x.cancelledAt);
  if (existing) { flash(req,'err',l(req,'Du hast bereits ein aktives oder offenes PayPal-Abo. Verwalte es zuerst unter „Your Account“.','You already have an active or pending PayPal subscription. Manage it under “Your Account” first.')); return res.redirect('/account'); }
  const record = createPaypalSubscriptionRecord({ id: crypto.randomUUID(), provider: 'paypal_subscription', userDiscordId: user.discordId, planId, amount: sub.amounts[planId], currency: sub.currency, paypalPlanId: sub.planIds[planId], status: 'creating' });
  try {
    const result = await createSubscription({ recordId: record.id, paypalPlanId: sub.planIds[planId], returnUrl: `${baseUrl}/paypal/subscription/return?record=${encodeURIComponent(record.id)}`, cancelUrl: `${baseUrl}/paypal/subscription/cancel?record=${encodeURIComponent(record.id)}`, settings });
    updatePaypalSubscriptionRecord(record.id, { subscriptionId: result.subscriptionId, status: result.status || 'APPROVAL_PENDING' });
    return res.redirect(result.approvalUrl);
  } catch (error) {
    updatePaypalSubscriptionRecord(record.id, { status: 'FAILED', error: String(error.message || error).slice(0,500) });
    flash(req,'err',`PayPal: ${error.message}`); return res.redirect(`/checkout/${planId}`);
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
    if (record.cancelledAt) {
      await stopCancelledPaypalSubscription({ ...record, subscriptionId }, details);
      flash(req,'err',l(req,'Dieser PayPal-Aboabschluss wurde bereits abgebrochen. Ein später bestätigter PayPal-Vorgang wird automatisch wieder gekündigt.','This PayPal subscription checkout was already cancelled. If PayPal later approves it, it is automatically cancelled again.'));
      return res.redirect('/account');
    }
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
  res.redirect(record?.planId?`/checkout/${record.planId}`:'/plans');
});

app.get('/account', requireLogin, async (req, res) => {
  const lang = langOf(req); const user = currentUser(req); const plan = effectivePlan(user);
  const paypalSubscriptions = listPaypalSubscriptionsForUser(user.discordId);
  const activePaypal = paypalSubscriptions.find((x) => ['ACTIVE','SUSPENDED','APPROVAL_PENDING','APPROVED','ACTIVE_PENDING_PAYMENT'].includes(String(x.status || '').toUpperCase()) && !x.cancelledAt) || paypalSubscriptions[0] || null;
  const stripeSubscriptions = listStripeSubscriptionsForUser(user.discordId);
  const activeStripe = stripeSubscriptions.find((x) => ['ACTIVE','TRIALING','APPROVAL_PENDING','CHECKOUT_COMPLETED'].includes(String(x.status || '').toUpperCase())) || stripeSubscriptions[0] || null;
  const billingCards = [];
  if (activePaypal) {
    const state = String(activePaypal.status || '').toUpperCase(); const end = activePaypal.entitlementExpiresAt || user.planExpiresAt || ''; const pendingCancel = ['APPROVAL_PENDING','APPROVED','ACTIVE_PENDING_PAYMENT'].includes(state); const canCancel = ['ACTIVE','SUSPENDED','APPROVAL_PENDING','APPROVED','ACTIVE_PENDING_PAYMENT'].includes(state) && activePaypal.subscriptionId && !activePaypal.cancelledAt;
    const cancelConfirm = pendingCancel ? tr(lang,'Diesen offenen PayPal-Aboabschluss wirklich abbrechen? Solange keine Zahlung bestätigt wurde, wird kein Premium-Zeitraum angerechnet.','Cancel this pending PayPal subscription checkout? No Premium period is granted until a payment has been confirmed.') : tr(lang,'Monatliches PayPal-Abo wirklich kündigen? Premium bleibt bis zum Ende des bereits bezahlten Zeitraums aktiv.','Cancel the monthly PayPal subscription? Premium remains active until the end of the already paid period.');
    const cancelLabel = pendingCancel ? tr(lang,'Aboabschluss abbrechen','Cancel checkout') : tr(lang,'Abo kündigen','Cancel subscription');
    billingCards.push(`<div class="account-billing"><div><span class="eyebrow">PayPal</span><h3>${esc(PLANS[activePaypal.planId]?.label || activePaypal.planId)}</h3><p>${tr(lang,'Status','Status')}: <strong>${esc(state)}</strong></p>${activePaypal.nextBillingAt ? `<p>${tr(lang,'Nächste Zahlung','Next payment')}: ${esc(new Date(activePaypal.nextBillingAt).toLocaleString(localeCode(lang)))}</p>` : ''}${activePaypal.cancelledAt && end ? `<p>${tr(lang,'Gekündigt. Premium bleibt bis','Cancelled. Premium remains until')} ${esc(new Date(end).toLocaleString(localeCode(lang)))}</p>` : ''}</div>${canCancel ? `<form method="post" action="/account/subscription/cancel" onsubmit="return confirm('${cancelConfirm}')"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><input type="hidden" name="recordId" value="${esc(activePaypal.id)}"><button class="button danger" type="submit">${cancelLabel}</button></form>` : ''}</div>`);
  }
  if (activeStripe) {
    const state=String(activeStripe.status||'').toUpperCase(); const end=activeStripe.entitlementExpiresAt||user.planExpiresAt||''; const canCancel=['ACTIVE','TRIALING'].includes(state)&&activeStripe.subscriptionId&&!activeStripe.cancelAtPeriodEnd&&!activeStripe.cancelledAt;
    billingCards.push(`<div class="account-billing"><div><span class="eyebrow">Stripe</span><h3>${esc(PLANS[activeStripe.planId]?.label || activeStripe.planId)}</h3><p>${tr(lang,'Status','Status')}: <strong>${esc(state)}</strong></p>${end?`<p>${tr(lang,'Aktueller Zeitraum bis','Current period until')}: ${esc(new Date(end).toLocaleString(localeCode(lang)))}</p>`:''}${activeStripe.cancelAtPeriodEnd?`<p>${tr(lang,'Gekündigt. Das Abo endet zum Periodenende.','Cancelled. The subscription ends at the period end.')}</p>`:''}</div>${canCancel?`<form method="post" action="/account/stripe-subscription/cancel" onsubmit="return confirm('${tr(lang,'Monatliches Stripe-Abo zum Periodenende kündigen?','Cancel the monthly Stripe subscription at the period end?')}')"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><input type="hidden" name="recordId" value="${esc(activeStripe.id)}"><button class="button danger" type="submit">${tr(lang,'Abo kündigen','Cancel subscription')}</button></form>`:''}</div>`);
  }
  const subscriptionHtml=billingCards.length?billingCards.join(''):`<p class="muted">${tr(lang,'Kein monatliches Abo vorhanden.','No monthly subscription.')}</p>`;
  const expiry = plan.expiresAt ? new Date(plan.expiresAt).toLocaleString(localeCode(lang)) : (plan.id === 'free' && !plan.premiumGrace ? '' : tr(lang,'Dauerhaft / kein Ablauf','Permanent / no expiry'));
  const source = user.premiumSource?.provider === 'paypal_subscription' ? tr(lang,'Monatliches PayPal-Abo','Monthly PayPal subscription') : user.premiumSource?.provider === 'paypal' ? tr(lang,'PayPal Einmalzahlung','PayPal one-time payment') : user.premiumSource?.provider === 'stripe_subscription' ? tr(lang,'Monatliches Stripe-Abo','Monthly Stripe subscription') : user.premiumSource?.provider === 'stripe' ? tr(lang,'Stripe Einmalzahlung','Stripe one-time payment') : tr(lang,'Manuell / Free','Manual / Free');
  const renew=freeRenewState(user); const renewDue=renew.dueAt?new Date(renew.dueAt).toLocaleString(localeCode(lang)):''; const deleteAt=renew.deleteAt?new Date(renew.deleteAt).toLocaleString(localeCode(lang)):'';
  const renewHtml=user.role==='admin'||user.freeRenewExempt?`<article class="panel"><span class="eyebrow">Free Renew</span><h2>${tr(lang,'Nicht erforderlich','Not required')}</h2><p>${tr(lang,'Ein Admin hat die 14-Tage-Verlängerung für diesen Account deaktiviert.','An admin disabled the 14-day renewal requirement for this account.')}</p></article>`:plan.id!=='free'&&!plan.premiumGrace?`<article class="panel"><span class="eyebrow">Free Renew</span><h2>${tr(lang,'In Premium enthalten','Included with Premium')}</h2><p>${tr(lang,'Solange Premium aktiv ist, ist keine Free-Verlängerung nötig.','No free renewal is required while Premium is active.')}</p></article>`:`<article class="panel ${renew.required?'renew-alert':'renew-card'}"><span class="eyebrow">Free Renew</span><h2>${renew.required?tr(lang,'Verlängerung erforderlich','Renewal required'):tr(lang,'14-Tage-Verlängerung','14-day renewal')}</h2><p>${renew.required?tr(lang,'Deine Status-Bots sind pausiert. Verlängere jetzt, damit sie wieder online gehen.','Your status bots are paused. Renew now to bring them back online.'):`${tr(lang,'Nächste Verlängerung spätestens','Renew by')}: ${esc(renewDue)}`}</p>${deleteAt?`<p class="lifecycle-note"><strong>${tr(lang,'Löschung am','Deletion at')}:</strong> ${esc(deleteAt)}</p>`:''}<form method="post" action="/account/renew-free"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button success" type="submit">${tr(lang,`Gratis-Bot für ${FREE_RENEW_DAYS} Tage verlängern`,`Renew free bot for ${FREE_RENEW_DAYS} days`)}</button></form></article>`;
  render(req,res,tr(lang,'Dein Account','Your Account'),`<div class="pagehead"><div><h1>${tr(lang,'Dein Account','Your Account')}</h1><p>${esc(user.globalName || user.username || user.discordId)}</p></div></div><section class="account-grid"><article class="panel"><span class="eyebrow">Plan</span><h2>${esc(plan.label)}</h2><p>${tr(lang,'Status-Bot-Limit','Status bot limit')}: <strong>${esc(plan.statusBotLimit)}</strong></p><p>${tr(lang,'Abrechnung','Billing')}: <strong>${source}</strong></p>${plan.id === 'free' && !plan.premiumGrace ? `<p>${tr(lang,'Premium','Premium')}: <strong>${tr(lang,'Nicht aktiv','Not active')}</strong></p>` : `<p>${tr(lang,'Premium bis','Premium until')}: <strong>${esc(expiry)}</strong></p>`}${plan.premiumGrace?`<p class="lifecycle-note"><strong>${tr(lang,'7-Tage-Wiederherstellung aktiv','7-day restore window active')}</strong></p>`:''}<a class="button primary" href="/plans">${tr(lang,'Premium verwalten','Manage Premium')}</a></article><article class="panel"><span class="eyebrow">${tr(lang,'Monatliches Abo','Monthly subscription')}</span>${subscriptionHtml}</article>${renewHtml}</section>`);
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
    if (record.cancelledAt) { flash(req,'ok',l(req,'Dieses PayPal-Abo wurde bereits beendet.','This PayPal subscription has already been ended.')); return res.redirect('/account'); }

    let details = null; let lookupError = null;
    try { details = await getSubscription(record.subscriptionId); } catch (error) { lookupError = error; }
    const localState = String(record.status || '').toUpperCase();
    const remoteState = String(details?.status || '').toUpperCase();
    const effectiveState = remoteState || localState;
    const now = new Date().toISOString();

    if (['CANCELLED','EXPIRED'].includes(effectiveState)) {
      updatePaypalSubscriptionRecord(record.id, { status: effectiveState, cancelledAt: record.cancelledAt || now, nextBillingAt: null, remoteStatus: remoteState || null, lastSyncAt: now });
      flash(req,'ok',l(req,'Dieses PayPal-Abo ist bereits beendet.','This PayPal subscription is already ended.'));
      return res.redirect('/account');
    }

    if (effectiveState === 'APPROVAL_PENDING') {
      try {
        await cancelSubscription(record.subscriptionId, 'Cancelled before approval by customer from status-hub.lol');
        updatePaypalSubscriptionRecord(record.id, { status: 'CANCELLED', cancelledAt: now, nextBillingAt: null, remoteStatus: remoteState || 'APPROVAL_PENDING', remoteCancelError: null, lastSyncAt: now });
      } catch (error) {
        if (!details || remoteState !== 'APPROVAL_PENDING') throw lookupError || error;
        updatePaypalSubscriptionRecord(record.id, { status: 'CANCELLED_BEFORE_APPROVAL', cancelledAt: now, nextBillingAt: null, remoteStatus: remoteState, remoteCancelError: String(error.message || error).slice(0,500), lastSyncAt: now });
      }
      flash(req,'ok',l(req,'Offener PayPal-Aboabschluss abgebrochen. Du kannst jetzt ein neues Abo starten.','Pending PayPal subscription checkout cancelled. You can now start a new subscription.'));
      return res.redirect('/account');
    }

    await cancelSubscription(record.subscriptionId, 'Cancelled by customer from status-hub.lol');
    const ownsPremium = user.premiumSource?.provider === 'paypal_subscription' && user.premiumSource?.recordId === record.id;
    const end = record.entitlementExpiresAt || (ownsPremium ? user.planExpiresAt : null) || null;
    updatePaypalSubscriptionRecord(record.id, { status: 'CANCELLED', cancelledAt: now, entitlementExpiresAt: end, nextBillingAt: null, remoteStatus: remoteState || effectiveState, remoteCancelError: null, lastSyncAt: now });
    if (ownsPremium && end) upsertUser({ discordId: user.discordId, planExpiresAt: end });
    flash(req,'ok',end ? l(req,'Abo gekündigt. Premium bleibt bis zum Ende des bereits bezahlten Zeitraums aktiv.','Subscription cancelled. Premium remains active until the end of the already paid period.') : l(req,'PayPal-Abo gekündigt. Es wurde noch kein bezahlter Premium-Zeitraum erkannt.','PayPal subscription cancelled. No paid Premium period was detected yet.'));
  } catch (error) { flash(req,'err',`PayPal: ${error.message}`); }
  res.redirect('/account');
});

app.post('/account/stripe-subscription/cancel', requireLogin, checkCsrf, rateLimit({ windowMs:60_000, limit:5 }), async(req,res)=>{
  try{
    const user=currentUser(req),record=getStripeSubscriptionRecord(String(req.body.recordId||''));
    if(!record||record.userDiscordId!==user.discordId||!record.subscriptionId)throw new Error(l(req,'Abo nicht gefunden.','Subscription not found.'));
    const details=await cancelStripeSubscriptionAtPeriodEnd(record.subscriptionId);
    const end=stripeExpiryFromSubscription(details);
    updateStripeSubscriptionRecord(record.id,{status:String(details.status||'ACTIVE').toUpperCase(),cancelAtPeriodEnd:true,cancelRequestedAt:new Date().toISOString(),entitlementExpiresAt:end,currentPeriodEnd:details.current_period_end||null});
    if(user.premiumSource?.provider==='stripe_subscription'&&user.premiumSource?.recordId===record.id)upsertUser({discordId:user.discordId,planExpiresAt:end});
    flash(req,'ok',l(req,'Stripe-Abo gekündigt. Premium bleibt bis zum Ende des bereits bezahlten Zeitraums aktiv.','Stripe subscription cancelled. Premium remains active until the end of the already paid period.'));
  }catch(error){flash(req,'err',`Stripe: ${error.message}`);}res.redirect('/account');
});

app.post('/webhooks/stripe', rateLimit({ windowMs:60_000, limit:120 }), async(req,res)=>{
  try{
    const settings=getSiteSettings(), sig=String(req.headers['stripe-signature']||'');
    if(!stripeConfigured(settings)) return res.status(503).send('Stripe not configured');
    const event=verifyStripeWebhook(req.rawBody||Buffer.from(''),sig,settings);
    if(stripeWebhookEventSeen(event.id)) return res.status(200).send('OK');
    const obj=event.data?.object||{};
    if(event.type==='checkout.session.completed'){
      const recordId=String(obj.metadata?.recordId||obj.client_reference_id||'');
      if(obj.mode==='payment'){
        const record=getStripePurchase(recordId)||getStripePurchaseBySession(String(obj.id||'')); if(record) applyStripePurchase(record,obj);
      }else if(obj.mode==='subscription'){
        const record=getStripeSubscriptionRecord(recordId)||getStripeSubscriptionBySession(String(obj.id||''));
        if(record){updateStripeSubscriptionRecord(record.id,{sessionId:obj.id||record.sessionId,subscriptionId:typeof obj.subscription==='string'?obj.subscription:obj.subscription?.id||'',customerId:typeof obj.customer==='string'?obj.customer:obj.customer?.id||'',status:'CHECKOUT_COMPLETED'});await applyStripeSubscription(record,obj,'checkout_webhook');}
      }
    }else if(event.type==='invoice.paid'){
      const sid=stripeInvoiceSubscriptionId(obj), record=getStripeSubscriptionByStripeId(sid); if(record){const details=await retrieveStripeSubscription(sid,settings);await applyStripeSubscription(record,details,'recurring_payment');updateStripeSubscriptionRecord(record.id,{lastInvoiceId:String(obj.id||''),lastPaymentAt:new Date().toISOString(),lastPaymentAmount:obj.amount_paid!=null?(Number(obj.amount_paid)/100).toFixed(2):''});}
    }else if(event.type==='invoice.payment_failed'){
      const sid=stripeInvoiceSubscriptionId(obj),record=getStripeSubscriptionByStripeId(sid);if(record)updateStripeSubscriptionRecord(record.id,{status:'PAST_DUE',lastInvoiceId:String(obj.id||''),lastSyncAt:new Date().toISOString()});
    }else if(event.type==='customer.subscription.updated'){
      const record=getStripeSubscriptionByStripeId(String(obj.id||''));if(record){if(['active','trialing'].includes(String(obj.status||'').toLowerCase()))await applyStripeSubscription(record,obj,'subscription_updated');else updateStripeSubscriptionRecord(record.id,{status:String(obj.status||'').toUpperCase(),cancelAtPeriodEnd:Boolean(obj.cancel_at_period_end),currentPeriodEnd:obj.current_period_end||null,lastSyncAt:new Date().toISOString()});}
    }else if(event.type==='customer.subscription.deleted'){
      const record=getStripeSubscriptionByStripeId(String(obj.id||''));if(record){const end=stripeExpiryFromSubscription(obj,0);updateStripeSubscriptionRecord(record.id,{status:'CANCELLED',cancelledAt:new Date().toISOString(),entitlementExpiresAt:end,cancelAtPeriodEnd:true,lastSyncAt:new Date().toISOString()});const user=findUser(record.userDiscordId);if(user?.premiumSource?.provider==='stripe_subscription'&&user.premiumSource.recordId===record.id)upsertUser({discordId:user.discordId,planExpiresAt:end});}
    }
    rememberStripeWebhookEvent(event.id,event.type);res.status(200).send('OK');
  }catch(error){console.error('Stripe webhook:',error.message);res.status(400).send('Webhook processing failed');}
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
    const serviceSubscription = serviceSubscriptionFromPaypalEvent(event);
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
      const serviceRecord = serviceSubscription || getPaypalServiceSubscriptionByPaypalId(String(event.resource?.id || '')) || getPaypalServiceSubscriptionRecord(String(event.resource?.custom_id || ''));
      if (serviceRecord) {
        const details = event.resource?.billing_info ? event.resource : await getSubscription(serviceRecord.subscriptionId || event.resource?.id, settings);
        if (!await stopCancelledPaypalServiceSubscription(serviceRecord, details, settings)) applyPaypalServiceSubscription(serviceRecord, details, 'webhook');
      } else {
        const record = subscription || getPaypalSubscriptionByPaypalId(String(event.resource?.id || '')) || getPaypalSubscriptionRecord(String(event.resource?.custom_id || ''));
        if (!record) { rememberPaypalWebhookEvent(event.id, event.event_type); return res.status(200).send('OK'); }
        const details = event.resource?.billing_info ? event.resource : await getSubscription(record.subscriptionId || event.resource?.id, settings);
        if (!await stopCancelledPaypalSubscription(record, details, settings)) applyPaypalSubscription(record, details, 'webhook');
      }
    } else if (type === 'PAYMENT.SALE.COMPLETED') {
      const serviceRecord = serviceSubscription || getPaypalServiceSubscriptionByPaypalId(String(event.resource?.billing_agreement_id || ''));
      if (serviceRecord) {
        const details = await getSubscription(serviceRecord.subscriptionId, settings);
        if (!await stopCancelledPaypalServiceSubscription(serviceRecord, details, settings)) {
          applyPaypalServiceSubscription(serviceRecord, details, 'recurring_payment');
          updatePaypalServiceSubscriptionRecord(serviceRecord.id, { lastPaymentId: String(event.resource?.id || ''), lastPaymentAt: event.resource?.create_time || new Date().toISOString(), lastPaymentAmount: event.resource?.amount?.total || event.resource?.amount?.value || '' });
        }
      } else {
        const record = subscription || getPaypalSubscriptionByPaypalId(String(event.resource?.billing_agreement_id || ''));
        if (!record) { rememberPaypalWebhookEvent(event.id, event.event_type); return res.status(200).send('OK'); }
        const details = await getSubscription(record.subscriptionId, settings);
        if (!await stopCancelledPaypalSubscription(record, details, settings)) {
          applyPaypalSubscription(record, details, 'recurring_payment');
          updatePaypalSubscriptionRecord(record.id, { lastPaymentId: String(event.resource?.id || ''), lastPaymentAt: event.resource?.create_time || new Date().toISOString(), lastPaymentAmount: event.resource?.amount?.total || event.resource?.amount?.value || '' });
        }
      }
    } else if (['BILLING.SUBSCRIPTION.CANCELLED','BILLING.SUBSCRIPTION.EXPIRED','BILLING.SUBSCRIPTION.SUSPENDED','BILLING.SUBSCRIPTION.PAYMENT.FAILED'].includes(type)) {
      const serviceRecord = serviceSubscription || getPaypalServiceSubscriptionByPaypalId(String(event.resource?.id || event.resource?.billing_agreement_id || ''));
      if (serviceRecord) {
        updatePaypalServiceSubscriptionRecord(serviceRecord.id, { status: type.split('.').pop(), statusEvent: type, cancelledAt: type === 'BILLING.SUBSCRIPTION.CANCELLED' ? (serviceRecord.cancelledAt || new Date().toISOString()) : serviceRecord.cancelledAt, lastSyncAt: new Date().toISOString() });
        syncAllServiceBots().catch(()=>{});
      } else {
        const record = subscription || getPaypalSubscriptionByPaypalId(String(event.resource?.id || event.resource?.billing_agreement_id || ''));
        if (record) updatePaypalSubscriptionRecord(record.id, { status: type.split('.').pop(), statusEvent: type, cancelledAt: type === 'BILLING.SUBSCRIPTION.CANCELLED' ? (record.cancelledAt || new Date().toISOString()) : record.cancelledAt, lastSyncAt: new Date().toISOString() });
      }
    }
    rememberPaypalWebhookEvent(event.id, event.event_type);
    res.status(200).send('OK');
  } catch (error) {
    console.error('PayPal webhook:', error.message);
    res.status(500).send('Webhook processing failed');
  }
});

app.get('/checkout/:planId', (req,res)=>{
  const lang=langOf(req), planId=String(req.params.planId||''), plan=PLANS[planId], settings=getSiteSettings(), sales=settings.premiumSales||{}, u=currentUser(req);
  if(!plan||planId==='free')return res.status(404).send('Plan not found');
  const auto=paypalAutoConfig(settings), sub=paypalSubscriptionConfig(settings), stripeAuto=stripeAutoConfig(settings), stripeSub=stripeSubscriptionConfig(settings);
  const oneTime=[]; const monthly=[];
  const form=(action,provider,label,price,primary=false)=>u
    ? `<form method="post" action="${action}" class="checkout-option"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><div><span class="eyebrow">${esc(provider)}</span><h3>${esc(label)}</h3><p>${esc(price)}</p></div><button class="button ${primary?'primary':'ghost'}" type="submit">${tr(lang,'Weiter','Continue')} · ${esc(provider)}</button></form>`
    : `<div class="checkout-option"><div><span class="eyebrow">${esc(provider)}</span><h3>${esc(label)}</h3><p>${esc(price)}</p></div><a class="button ${primary?'primary':'ghost'}" href="/auth/discord?returnTo=${encodeURIComponent(`/checkout/${planId}`)}">${tr(lang,'Einloggen & weiter','Login & continue')}</a></div>`;
  if(paypalAutoReady(settings)&&auto.amounts[planId])oneTime.push(form(`/paypal/checkout/${esc(planId)}`,'PayPal',tr(lang,'Einmalzahlung','One-time payment'),`${auto.amounts[planId]} ${auto.currency} · ${auto.accessDays} ${tr(lang,'Tage Premium','days Premium')}`));
  if(stripeAutoReady(settings,planId))oneTime.push(form(`/stripe/checkout/${esc(planId)}`,'Stripe',tr(lang,'Einmalzahlung','One-time payment'),`${stripeAuto.amounts[planId]} ${stripeAuto.currency} · ${stripeAuto.accessDays} ${tr(lang,'Tage Premium','days Premium')}`));
  if(paypalSubscriptionReady(settings,planId))monthly.push(form(`/paypal/subscribe/${esc(planId)}`,'PayPal',tr(lang,'Monatliches Abo','Monthly subscription'),`${sub.amounts[planId]} ${sub.currency} / ${tr(lang,'Monat','month')}`,true));
  if(stripeSubscriptionReady(settings,planId))monthly.push(form(`/stripe/subscribe/${esc(planId)}`,'Stripe',tr(lang,'Monatliches Abo','Monthly subscription'),`${stripeSub.amounts[planId]} ${stripeSub.currency} / ${tr(lang,'Monat','month')}`,true));
  let manual='';
  const discordContact=sales.discordUserId&&validSnowflake(sales.discordUserId)?`https://discord.com/users/${encodeURIComponent(sales.discordUserId)}`:'';
  if(!oneTime.length&&!monthly.length){
    if(/^https?:\/\//i.test(String(sales.paypalUrl||'')))manual=`<a class="button primary" href="${esc(sales.paypalUrl)}" target="_blank" rel="noopener">PayPal</a>`;
    else if(discordContact)manual=`<a class="button primary" href="${esc(discordContact)}" target="_blank" rel="noopener">Discord</a>`;
    else if(settings.supportUrl)manual=`<a class="button primary" href="${esc(settings.supportUrl)}" target="_blank" rel="noopener">${tr(lang,'Support kontaktieren','Contact support')}</a>`;
  }
  const body=`<div class="pagehead"><div><span class="eyebrow">Checkout</span><h1>${esc(plan.label)}</h1><p>${plan.statusBotLimit} Status Bots · ${tr(lang,'kein Service-Branding','no service branding')}</p></div><a class="button ghost" href="/plans">${tr(lang,'Zurück zu Premium','Back to Premium')}</a></div>
  <section class="panel checkout-summary"><div><span class="eyebrow">${tr(lang,'Ausgewählter Plan','Selected plan')}</span><h2>${esc(plan.label)}</h2><div class="plan-number">${esc(plan.statusBotLimit)}</div><p>Status Bots</p></div></section>
  ${oneTime.length?`<section class="checkout-section"><div class="pagehead compact"><div><h2>${tr(lang,'Einmalig kaufen','Buy once')}</h2></div></div><div class="checkout-grid">${oneTime.join('')}</div></section>`:''}
  ${monthly.length?`<section class="checkout-section"><div class="pagehead compact"><div><h2>${tr(lang,'Monatliches Abo','Monthly subscription')}</h2></div></div><div class="checkout-grid">${monthly.join('')}</div></section>`:''}
  ${!oneTime.length&&!monthly.length?`<section class="panel empty"><h2>${tr(lang,'Checkout noch nicht verfügbar','Checkout not available yet')}</h2><p>${tr(lang,'Für diesen Plan ist aktuell keine automatische Zahlungsart eingerichtet.','No automatic payment method is currently configured for this plan.')}</p><div class="actions">${manual||''}</div></section>`:''}`;
  render(req,res,'Checkout',body);
});

app.get('/plans', (req, res) => {
  const lang=langOf(req),u=currentUser(req),current=effectivePlan(u),settings=getSiteSettings(),sales=settings.premiumSales||{};
  const auto=paypalAutoConfig(settings),sub=paypalSubscriptionConfig(settings),stripeAuto=stripeAutoConfig(settings),stripeSub=stripeSubscriptionConfig(settings);
  const cards=Object.values(PLANS).map((p)=>{
    const paypalOne=p.id!=='free'&&auto.amounts[p.id]?`${auto.amounts[p.id]} ${auto.currency} / ${auto.accessDays} ${tr(lang,'Tage','days')}`:'';
    const stripeOne=p.id!=='free'&&stripeAuto.amounts[p.id]?`${stripeAuto.amounts[p.id]} ${stripeAuto.currency} / ${stripeAuto.accessDays} ${tr(lang,'Tage','days')}`:'';
    const paypalMonth=p.id!=='free'&&sub.amounts[p.id]?`${sub.amounts[p.id]} ${sub.currency} / ${tr(lang,'Monat','month')}`:'';
    const stripeMonth=p.id!=='free'&&stripeSub.amounts[p.id]?`${stripeSub.amounts[p.id]} ${stripeSub.currency} / ${tr(lang,'Monat','month')}`:'';
    const displayPrice=p.id==='free'?tr(lang,'Kostenlos','Free'):(paypalOne||stripeOne||paypalMonth||stripeMonth||String(sales.prices?.[p.id]||tr(lang,'Preis im Checkout','Price in checkout')));
    const action=p.id==='free'?'':`<a class="button primary" href="/checkout/${esc(p.id)}">${tr(lang,'Kaufen','Buy')}</a>`;
    return `<article class="panel plan-card ${u&&current.id===p.id?'current-plan':''}"><span class="eyebrow">${p.id==='free'?tr(lang,'Kostenlos','Free'):'Premium'}</span><h2>${esc(p.label)}</h2><div class="plan-number">${p.statusBotLimit}</div><p>Status Bot${p.statusBotLimit===1?'':'s'}</p><div class="plan-price">${esc(displayPrice)}</div><ul><li>${tr(lang,'Alle unterstützten Games','All supported games')}</li><li>${tr(lang,'Status-Rotation, Map & Spieler je nach Game','Status rotation, map & players depending on the game')}</li><li>${p.branded?tr(lang,'Powered by status-hub.lol im Free-Status','Powered by status-hub.lol on Free status bots'):tr(lang,'Kein Service-Branding','No service branding')}</li></ul>${u&&current.id===p.id?`<div class="actions wrap"><span class="badge online">${tr(lang,'Aktueller Plan','Current plan')}</span></div>`:''}${action}</article>`;
  }).join('');
  render(req,res,'Premium',`<div class="pagehead"><div><h1>Premium</h1></div>${u?`<a class="button ghost" href="/account">${tr(lang,'Your Account','Your Account')}</a>`:''}</div><section class="plan-grid">${cards}</section>`);
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
    return `<article class="servercard panel"><div class="row between"><div><h2>${esc(s.name)}</h2><div class="chips"><span class="badge ${esc(state)}">${esc(stateLabel(state,r,s))}</span><span class="badge neutral">${esc(s.gameType === 'wardogs' ? 'WARDOGS Status Bot' : s.gameType === 'gamedig' ? (gameDigMeta(s.queryConfig?.gameId)?.name || `GameDig: ${s.queryConfig?.gameId || '?'}`) : gameTypeLabel(s.gameType))}</span></div></div><div class="dot ${esc(state)}"></div></div>${u.role === 'admin' ? `<p class="muted small">Owner: ${esc(owner?.globalName || owner?.username || s.ownerDiscordId || 'Legacy')} · Node: ${esc(r.nodeName || s.assignedNodeId || tr(lang,'nicht zugewiesen','unassigned'))}</p>` : ''}<dl><div><dt>Bot</dt><dd>${esc(r.botTag || tr(lang,'noch nicht verbunden','not connected yet'))}</dd></div><div><dt>Presence</dt><dd>${esc(r.presence || '—')}</dd></div>${s.gameType === 'text_only' ? '' : `<div><dt>Map</dt><dd>${esc(r.map || '—')}</dd></div><div><dt>Ping</dt><dd>${esc(r.ping == null ? '—' : `${r.ping} ms`)}</dd></div>`}</dl>${r.lastError ? `<div class="errorbox">${esc(r.lastError)}</div>` : ''}<div class="actions wrap">${invite ? `<a class="button ghost" href="${invite}" target="_blank" rel="noopener">${tr(lang,'Bot einladen','Invite bot')}</a>` : ''}<a class="button ghost" href="/servers/${esc(s.id)}/edit">${tr(lang,'Bearbeiten','Edit')}</a>${s.gameType==='wardogs'?`<a class="button ghost" href="/servers/${esc(s.id)}/stats">Killfeed & Stats</a>`:''}<form method="post" action="/servers/${esc(s.id)}/test" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button ghost">${tr(lang,'Status testen','Test status')}</button></form>${s.enabled?`<form method="post" action="/servers/${esc(s.id)}/stop" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button ghost">${tr(lang,'Offline schalten','Take offline')}</button></form><form method="post" action="/servers/${esc(s.id)}/restart" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button ghost">${tr(lang,'Neu starten','Restart')}</button></form>`:`<form method="post" action="/servers/${esc(s.id)}/restart" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button success">${tr(lang,'Bot starten','Start bot')}</button></form>`}<form method="post" action="/servers/${esc(s.id)}/delete" class="inline" onsubmit="return confirm('${tr(lang,'Status Bot wirklich löschen?','Delete this status bot?')}')"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button danger">${tr(lang,'Löschen','Delete')}</button></form></div></article>`;
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
  const createTitle=requestedType==='wardogs'?'WARDOGS Status Bot':l(req,'Status Bot erstellen','Create status bot');
  render(req, res, createTitle, `<div class="pagehead"><div><span class="eyebrow">${requestedType==='wardogs'?'WARDOGS Status Bot':'Status Bot'}</span><h1>${requestedType==='wardogs'?'WARDOGS Status Bot':l(req,'Status Bot erstellen','Create status bot')}</h1><p>${requestedType==='wardogs'?l(req,'Discord-Serverstatus für WARDOGS. Killfeed und globale Spieler-Stats gehören ausschließlich zum WARDOGS Status Bot unter Bot Services (ehemaliger Playtime Tracker).','Discord server status for WARDOGS. Killfeed and global player stats belong exclusively to the WARDOGS Status Bot under Bot Services (formerly Playtime Tracker).'):l(req,'Serverstatus oder reine Text-Rotation. Beides zählt als ein Status-Bot.','Server status or text-only rotation. Both count as one status bot.')}</p></div><a class="button ghost" href="/games">Games & FAQ</a></div>${serverForm({ server: initial, csrf: csrf(req), isAdmin: u.role === 'admin', lang: langOf(req) })}`);
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
      onlineTemplates: parseTemplates(req.body.onlineTemplates, q.gameType), offlineTemplate: String(req.body.offlineTemplate || 'Server offline').slice(0, 128), wardogsSeedingEnabled: q.gameType === 'wardogs' && req.body.wardogsSeedingEnabled === '1', wardogsScoreEnabled: q.gameType === 'wardogs' && req.body.wardogsScoreEnabled === '1',
      enabled: req.body.enabled === '1', restartNonce: Date.now()
    });
    rebalanceAssignments(); flash(req, 'ok', q.gameType==='wardogs'?l(req,`WARDOGS Status Bot „${entry.name}“ wurde erstellt.`,`WARDOGS Status Bot “${entry.name}” was created.`):`Status Bot „${entry.name}“ wurde erstellt und einem freien Status-Node zugewiesen.`); res.redirect(q.gameType==='wardogs'?`/servers/${encodeURIComponent(entry.id)}/edit`:'/');
  } catch (error) { flash(req, /limit/i.test(String(error.message)) ? 'status-limit' : 'err', error.message); res.redirect('/servers/new'); }
});

app.get('/servers/:id/edit', requireLogin, (req, res) => {
  const server = ownedServer(req, req.params.id); if (!server) return res.status(404).send('Server nicht gefunden');
  const title=server.gameType==='wardogs'?'WARDOGS Status Bot':l(req,'Status Bot bearbeiten','Edit status bot');
  const authLockHtml=server.gameType==='wardogs'&&server.wardogsAuthLockedAt?`<div class="panel warning"><strong>${l(req,'WARDOGS Login-Schutz aktiv','WARDOGS login protection active')}</strong><p>${l(req,'Der Bot wurde nach zwei fehlgeschlagenen WARDOGS-Logins automatisch offline geschaltet. Prüfe URL/Passwort und speichere oder starte den Bot danach händisch neu. Bis dahin werden keine weiteren WARDOGS-Loginversuche gesendet.','The bot was automatically taken offline after two failed WARDOGS logins. Check the URL/password, then save or manually restart the bot. No further WARDOGS login attempts are sent until then.')}</p></div>`:'';
  render(req, res, title, `<div class="pagehead"><div><span class="eyebrow">${server.gameType==='wardogs'?'WARDOGS Status Bot':'Status Bot'}</span><h1>${esc(server.name)}</h1><p>${l(req,'Leere Secret-Felder behalten vorhandene Werte.','Empty secret fields keep their current values.')}</p></div></div>${authLockHtml}${serverForm({ server, csrf: csrf(req), isEdit: true, isAdmin: isAdmin(req), lang: langOf(req) })}`);
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
      onlineTemplates: parseTemplates(req.body.onlineTemplates, q.gameType), offlineTemplate: String(req.body.offlineTemplate || 'Server offline').slice(0, 128), wardogsSeedingEnabled: q.gameType === 'wardogs' && req.body.wardogsSeedingEnabled === '1', wardogsScoreEnabled: q.gameType === 'wardogs' && req.body.wardogsScoreEnabled === '1', enabled: req.body.enabled === '1'
    };
    if (req.body.botToken) { const bot = await validateBotToken(String(req.body.botToken).trim()); if (readDb().servers.some((x) => x.id !== old.id && x.botId === bot.id)) throw new Error('Dieser Discord Bot wird bereits von einem anderen Status-Eintrag verwendet'); patch.botTokenEnc = encryptSecret(String(req.body.botToken).trim()); patch.botId = bot.id; }
    if (q.newSecret) patch.querySecretEnc = encryptSecret(q.newSecret);
    else if (q.clearSecret) patch.querySecretEnc = null;
    const entry = upsertServer({ ...patch, restartNonce: Date.now(), wardogsAuthLockedAt: null, wardogsAuthLockedReason: '', wardogsAuthFailureCount: 0 }); rebalanceAssignments(); flash(req, 'ok', l(req,'Gespeichert und Neustart ausgelöst. Der Status-Node übernimmt die Änderung.','Saved and restart triggered. The status node will apply the change.')); res.redirect(entry.gameType==='wardogs'?`/servers/${encodeURIComponent(entry.id)}/edit`:'/');
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
    upsertServer({ id: s.id, enabled: true, restartNonce: Date.now(), wardogsAuthLockedAt: null, wardogsAuthLockedReason: '', wardogsAuthFailureCount: 0 });
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
    return `<article class="servercard panel"><div class="row between"><div><h2>${esc(b.name)}</h2><div class="chips"><span class="badge ${b.approvalState==='approved'?'online':b.approvalState==='rejected'?'error':'neutral'}">${esc(approval)}</span><span class="badge ${rt.running?'online':'neutral'}">${rt.running?tr(lang,'läuft','running'):tr(lang,'gestoppt','stopped')}</span></div></div></div><p class="muted small">${esc(b.runtime)} · ${esc(b.entrypoint)}${u.role==='admin'?` · Owner: ${esc(owner?.globalName||owner?.username||b.ownerDiscordId)}`:''}</p>${b.reviewNote?`<div class="help">Admin: ${esc(b.reviewNote)}</div>`:''}<div class="actions wrap"><a class="button ghost" href="/custom-bots/${esc(b.id)}/files">${tr(lang,'Dateien','Files')}</a><a class="button ghost" href="/custom-bots/${esc(b.id)}/source">Source ZIP</a><a class="button ghost" href="/custom-bots/${esc(b.id)}/logs">Logs</a>${b.approvalState==='approved'?`<form method="post" action="/custom-bots/${esc(b.id)}/start" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button ghost">${tr(lang,'Start/Neu bauen','Start/rebuild')}</button></form><form method="post" action="/custom-bots/${esc(b.id)}/stop" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button ghost">Stop</button></form>`:''}${u.role==='admin'&&b.approvalState!=='approved'?`<form method="post" action="/custom-bots/${esc(b.id)}/approve" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button primary">${tr(lang,'Freigeben','Approve')}</button></form>`:''}${u.role==='admin'&&b.approvalState==='approved'?`<form method="post" action="/custom-bots/${esc(b.id)}/revoke" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button danger">${tr(lang,'Freigabe entziehen','Revoke approval')}</button></form>`:''}<form method="post" action="/custom-bots/${esc(b.id)}/delete" class="inline" onsubmit="return confirm('${tr(lang,'Custom Bot löschen?','Delete custom bot?')}')"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button danger">${tr(lang,'Löschen','Delete')}</button></form></div></article>`;
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

app.post('/custom-bots/new', requireLogin, securityRateLimit('custom-upload-burst', 60_000, 3), securityRateLimit('custom-upload', 60 * 60_000, 12), customBotUpload, checkCsrf, async (req,res)=>{
  let preparedId='';
  try{
    const u=currentUser(req); const count=readDb().customBots.filter((b)=>b.ownerDiscordId===u.discordId).length;
    if(count>=customLimit(u))throw new Error(l(req,'Keine freien Custom-Bot-Slots','No free custom bot slots'));
    if(!req.file)throw new Error(l(req,'ZIP-Datei fehlt','ZIP file is missing'));
    const name=String(req.body.name||'').trim(); if(!name)throw new Error(l(req,'Name fehlt','Name is required')); if(name.length>80)throw new Error(l(req,'Name ist zu lang (maximal 80 Zeichen)','Name is too long (maximum 80 characters)'));
    const env=parseEnvText(req.body.envText);
    const runtime=String(req.body.runtime||'node22');
    const prep=prepareCustomBot({buffer:req.file.buffer,runtime,entrypoint:req.body.entrypoint}); preparedId=prep.id;
    const adminUpload=u.role==='admin';
    let bot=upsertCustomBot({id:prep.id,ownerDiscordId:u.discordId,name,runtime:prep.runtime,entrypoint:prep.entrypoint,envEnc:encryptSecret(JSON.stringify(env)),approvalState:adminUpload?'approved':'pending',enabled:false,fileCount:prep.fileCount,unpackedBytes:prep.unpackedBytes,reviewNote:''});
    preparedId='';
    if(!adminUpload){flash(req,'ok',prep.strippedWrapper?l(req,`Upload gespeichert. ZIP-Projektordner „${prep.strippedWrapper}“ wurde automatisch erkannt. Ein Admin muss den Bot noch freigeben.`,`Upload saved. ZIP project folder “${prep.strippedWrapper}” was detected automatically. An admin still needs to approve the bot.`):l(req,'Upload gespeichert. Ein Admin muss ihn vor dem Start freigeben.','Upload saved. An admin must approve it before it can start.'));return res.redirect('/custom-bots');}
    try{
      bot=upsertCustomBot({id:bot.id,enabled:true});
      await ensureCustomBot(bot);
      flash(req,'ok',l(req,'Custom Bot hochgeladen, gebaut und gestartet.','Custom bot uploaded, built and started.'));
    }catch(startError){
      upsertCustomBot({id:bot.id,enabled:false,reviewNote:l(req,`Upload erfolgreich, Start fehlgeschlagen: ${String(startError.message||startError).slice(0,300)}`,`Upload succeeded, start failed: ${String(startError.message||startError).slice(0,300)}`)});
      flash(req,'err',l(req,`Upload wurde gespeichert, aber der Bot konnte noch nicht gestartet werden: ${startError.message}`,`Upload was saved, but the bot could not be started yet: ${startError.message}`));
    }
    res.redirect('/custom-bots');
  }catch(error){if(preparedId)deleteCustomBotFiles(preparedId);flash(req,/slots|limit/i.test(String(error.message))?'limit':'err',error.message);res.redirect('/custom-bots/new');}
});

app.post('/custom-bots/:id/approve', requireAdmin, checkCsrf, async (req,res)=>{let b=null;try{b=getCustomBot(req.params.id);if(!b)return res.status(404).send('Not found');const bot=upsertCustomBot({id:b.id,approvalState:'approved',enabled:true,reviewNote:l(req,'Von Admin freigegeben','Approved by admin')});rebalanceAssignments();await ensureCustomBot(bot);flash(req,'ok',l(req,'Custom Bot freigegeben und gestartet.','Custom bot approved and started.'));}catch(e){if(b)upsertCustomBot({id:b.id,approvalState:'approved',enabled:false,reviewNote:l(req,`Freigegeben, Start fehlgeschlagen: ${String(e.message||e).slice(0,300)}`,`Approved, start failed: ${String(e.message||e).slice(0,300)}`)});flash(req,'err',e.message);}res.redirect('/admin?tab=bots#bots');});
app.post('/custom-bots/:id/revoke', requireAdmin, checkCsrf, async (req,res)=>{const b=getCustomBot(req.params.id);if(!b)return res.status(404).send('Not found');await stopCustomBot(b).catch(()=>{});upsertCustomBot({id:b.id,approvalState:'rejected',enabled:false,reviewNote:l(req,'Freigabe entzogen','Approval revoked')});rebalanceAssignments();flash(req,'ok',l(req,'Freigabe entzogen.','Approval revoked.'));res.redirect('/admin?tab=bots#bots');});

function customFileSizeLabel(bytes) {
  const n=Math.max(0,Number(bytes)||0); if(n<1024)return `${n} B`; if(n<1024*1024)return `${(n/1024).toFixed(n>=10*1024?0:1)} KB`; return `${(n/(1024*1024)).toFixed(n>=10*1024*1024?0:1)} MB`;
}
async function afterCustomBotSourceChange(req, bot, result) {
  const user=currentUser(req); const admin=user?.role==='admin';
  const patch={id:bot.id,fileCount:Number(result?.fileCount||0),unpackedBytes:Number(result?.unpackedBytes||0)};
  if(!admin){
    await stopCustomBot(bot).catch(()=>{});
    patch.approvalState='pending'; patch.enabled=false;
    patch.reviewNote=l(req,'Source-Dateien geändert – erneute Admin-Freigabe erforderlich.','Source files changed – admin approval is required again.');
  } else {
    patch.reviewNote=bot.approvalState==='approved'?l(req,'Source-Dateien geändert – für die neue Version Start/Neu bauen ausführen.','Source files changed – use Start/rebuild to deploy the new version.'):String(bot.reviewNote||'');
  }
  upsertCustomBot(patch); rebalanceAssignments();
}
app.get('/custom-bots/:id/files', requireLogin, (req,res)=>{
  const bot=ownedCustom(req,req.params.id); if(!bot)return res.status(404).send('Not found');
  try{
    const rows=listCustomBotFiles(bot.id); const token=esc(csrf(req));
    const body=rows.map((file)=>`<tr><td><code>${esc(file.path)}</code></td><td>${esc(customFileSizeLabel(file.size))}</td><td>${esc(new Date(file.modifiedAt).toLocaleString(localeCode(langOf(req))))}</td><td><a class="button ghost smallbtn" href="/custom-bots/${esc(bot.id)}/files/download?path=${encodeURIComponent(file.path)}">${l(req,'Download','Download')}</a></td></tr>`).join('');
    const approvalNote=currentUser(req)?.role==='admin'
      ? l(req,'Änderungen überschreiben vorhandene Dateien mit demselben Pfad. Laufende Container verwenden die neue Version erst nach „Start/Neu bauen“.','Changes overwrite existing files with the same path. Running containers use the new version only after “Start/rebuild”.')
      : l(req,'Änderungen überschreiben vorhandene Dateien mit demselben Pfad. Aus Sicherheitsgründen wird die Freigabe nach einer Source-Änderung auf „wartet auf Freigabe“ gesetzt und der Bot gestoppt.','Changes overwrite existing files with the same path. For security, source changes reset approval to pending and stop the bot.');
    render(req,res,`${bot.name} · ${l(req,'Dateien','Files')}`,`<div class="pagehead"><div><h1>${esc(bot.name)} · ${l(req,'Dateien','Files')}</h1><p>${esc(bot.runtime)} · ${esc(bot.entrypoint)} · ${rows.length} ${l(req,'Dateien','files')}</p></div><div class="actions"><a class="button ghost" href="/custom-bots">${l(req,'Zurück','Back')}</a><a class="button ghost" href="/custom-bots/${esc(bot.id)}/source">Source ZIP</a></div></div><div class="panel help">${esc(approvalNote)}</div><section class="account-grid"><article class="panel"><span class="eyebrow">${l(req,'Lose Dateien','Loose files')}</span><h2>${l(req,'Dateien hochladen / überschreiben','Upload / overwrite files')}</h2><form method="post" enctype="multipart/form-data" action="/custom-bots/${esc(bot.id)}/files/upload" class="formgrid"><input type="hidden" name="_csrf" value="${token}"><label class="span2">${l(req,'Dateien (max. 20)','Files (max. 20)')}<input type="file" name="files" multiple required></label><label class="span2">${l(req,'Zielordner im Projekt (optional)','Target folder in project (optional)')}<input name="targetDir" maxlength="240" placeholder="utils oder src/modules"></label><div class="span2 help">${l(req,'Der Dateiname bleibt erhalten. Beispiel: Zielordner „utils“ + helper.js → utils/helper.js. Existiert der Pfad bereits, wird er überschrieben.','The filename is preserved. Example: target folder “utils” + helper.js → utils/helper.js. If the path already exists, it is overwritten.')}</div><button class="button primary" type="submit">${l(req,'Dateien hochladen','Upload files')}</button></form></article><article class="panel"><span class="eyebrow">ZIP Overlay</span><h2>${l(req,'ZIP über Projekt legen','Overlay ZIP onto project')}</h2><form method="post" enctype="multipart/form-data" action="/custom-bots/${esc(bot.id)}/files/upload-zip" class="formgrid"><input type="hidden" name="_csrf" value="${token}"><label class="span2">ZIP<input type="file" name="archive" accept=".zip,application/zip" required></label><label class="span2">${l(req,'Zielordner im Projekt (optional)','Target folder in project (optional)')}<input name="targetDir" maxlength="240" placeholder="${l(req,'leer = Projektwurzel','empty = project root')}"></label><div class="span2 help">${l(req,'ZIP-Dateien werden zusammengeführt: gleiche Pfade werden überschrieben, neue Dateien ergänzt, andere vorhandene Dateien bleiben bestehen. Ein einzelner äußerer ZIP-Projektordner wird automatisch entfernt.','ZIP files are merged: matching paths are overwritten, new files are added, and other existing files stay untouched. A single outer ZIP project folder is stripped automatically.')}</div><button class="button primary" type="submit">${l(req,'ZIP hochladen','Upload ZIP')}</button></form></article></section><div class="panel tablewrap"><table><thead><tr><th>${l(req,'Pfad','Path')}</th><th>${l(req,'Größe','Size')}</th><th>${l(req,'Geändert','Modified')}</th><th></th></tr></thead><tbody>${body||`<tr><td colspan="4">${l(req,'Keine Projektdateien gefunden.','No project files found.')}</td></tr>`}</tbody></table></div>`);
  }catch(error){flash(req,'err',error.message);res.redirect('/custom-bots');}
});
app.get('/custom-bots/:id/files/download', requireLogin, (req,res)=>{
  const bot=ownedCustom(req,req.params.id); if(!bot)return res.status(404).send('Not found');
  try{const file=resolveCustomBotFile(bot.id,String(req.query.path||''));return res.download(file.absolute,file.rel.replace(/\//g,'__'));}catch(error){return res.status(404).send(String(error.message||error));}
});
app.post('/custom-bots/:id/files/upload', requireLogin, securityRateLimit('custom-file-upload',60*60_000,60), customBotLooseFilesUpload, checkCsrf, async(req,res)=>{
  const bot=ownedCustom(req,req.params.id);if(!bot)return res.status(404).send('Not found');
  try{const result=overlayCustomBotFiles({id:bot.id,runtime:bot.runtime,entrypoint:bot.entrypoint,files:req.files||[],targetDir:req.body.targetDir||''});await afterCustomBotSourceChange(req,bot,result);flash(req,'ok',l(req,`${result.overwrittenOrAdded} Datei(en) gespeichert/überschrieben. Source ZIP wurde aktualisiert.`,`Saved/overwrote ${result.overwrittenOrAdded} file(s). Source ZIP was updated.`));}catch(error){flash(req,'err',error.message);}res.redirect(`/custom-bots/${encodeURIComponent(bot.id)}/files`);
});
app.post('/custom-bots/:id/files/upload-zip', requireLogin, securityRateLimit('custom-file-upload',60*60_000,60), customBotOverlayZipUpload, checkCsrf, async(req,res)=>{
  const bot=ownedCustom(req,req.params.id);if(!bot)return res.status(404).send('Not found');
  try{if(!req.file?.buffer?.length)throw new Error(l(req,'ZIP-Datei fehlt.','ZIP file is missing.'));const result=overlayCustomBotFiles({id:bot.id,runtime:bot.runtime,entrypoint:bot.entrypoint,archiveBuffer:req.file.buffer,targetDir:req.body.targetDir||''});await afterCustomBotSourceChange(req,bot,result);flash(req,'ok',result.strippedWrapper?l(req,`${result.overwrittenOrAdded} Datei(en) aus ZIP gespeichert/überschrieben. Äußerer Ordner „${result.strippedWrapper}“ wurde entfernt.`,`Saved/overwrote ${result.overwrittenOrAdded} file(s) from ZIP. Outer folder “${result.strippedWrapper}” was stripped.`):l(req,`${result.overwrittenOrAdded} Datei(en) aus ZIP gespeichert/überschrieben.`,`Saved/overwrote ${result.overwrittenOrAdded} file(s) from ZIP.`));}catch(error){flash(req,'err',error.message);}res.redirect(`/custom-bots/${encodeURIComponent(bot.id)}/files`);
});
app.post('/custom-bots/:id/start', requireLogin, securityRateLimit('custom-rebuild', 60 * 60_000, 30), checkCsrf, async (req,res)=>{let b=null;const fromAdmin=isAdmin(req)&&String(req.get('referer')||'').includes('/admin');try{b=ownedCustom(req,req.params.id);if(!b)return res.status(404).send('Not found');if(b.approvalState!=='approved')throw new Error(l(req,'Bot ist nicht freigegeben','Bot is not approved'));const bot=upsertCustomBot({id:b.id,enabled:true});rebalanceAssignments();await restartCustomBot(bot);upsertCustomBot({id:b.id,reviewNote:''});flash(req,'ok',l(req,'Custom Bot neu gebaut und gestartet.','Custom bot rebuilt and started.'));}catch(e){if(b)upsertCustomBot({id:b.id,enabled:false,reviewNote:l(req,`Start fehlgeschlagen: ${String(e.message||e).slice(0,300)}`,`Start failed: ${String(e.message||e).slice(0,300)}`)});flash(req,'err',e.message);}res.redirect(fromAdmin?'/admin?tab=bots#bots':'/custom-bots');});
app.post('/custom-bots/:id/stop', requireLogin, checkCsrf, async (req,res)=>{const fromAdmin=isAdmin(req)&&String(req.get('referer')||'').includes('/admin');const b=ownedCustom(req,req.params.id);if(!b)return res.status(404).send('Not found');await stopCustomBot(b).catch(()=>{});upsertCustomBot({id:b.id,enabled:false});rebalanceAssignments();flash(req,'ok',l(req,'Custom Bot gestoppt.','Custom bot stopped.'));res.redirect(fromAdmin?'/admin?tab=bots#bots':'/custom-bots');});
app.get('/custom-bots/:id/source', requireLogin, (req,res)=>{const b=ownedCustom(req,req.params.id);if(!b)return res.status(404).send('Not found');const file=`custom-bots/${b.id}/source.zip`;res.download(file,`${String(b.name||'custom-bot').replace(/[^A-Za-z0-9._-]+/g,'_')}.zip`);});
app.get('/custom-bots/:id/logs', requireLogin, async (req,res)=>{const b=ownedCustom(req,req.params.id);if(!b)return res.status(404).send('Not found');let logs='';try{logs=(await customBotLogs(b)).logs||'';}catch(e){logs=`Logs unavailable: ${e.message}`;}render(req,res,'Custom Bot Logs',`<div class="pagehead"><div><h1>${esc(b.name)} · Logs</h1></div><a class="button ghost" href="/custom-bots">${l(req,'Zurück','Back')}</a></div><pre class="panel logbox">${esc(logs)}</pre>`);});
app.post('/custom-bots/:id/delete', requireLogin, checkCsrf, async (req,res)=>{const fromAdmin=isAdmin(req)&&String(req.get('referer')||'').includes('/admin');const b=ownedCustom(req,req.params.id);if(!b)return res.status(404).send('Not found');await deleteCustomBotRuntime(b).catch(()=>{});deleteCustomBotFiles(b.id);deleteCustomBot(b.id);rebalanceAssignments();flash(req,'ok',l(req,'Custom Bot gelöscht.','Custom bot deleted.'));res.redirect(fromAdmin?'/admin?tab=bots#bots':'/custom-bots');});

function adminShell(req, active, content) {
  const lang=langOf(req);
  const items=[['overview',tr(lang,'Übersicht','Overview')],['bots',tr(lang,'Alle Bots','All bots')],['nodes',tr(lang,'Nodes','Nodes')],['users',tr(lang,'Benutzer & Pläne','Users & plans')],['services',tr(lang,'Bot Services','Bot services')],['settings',tr(lang,'Einstellungen','Settings')]];
  const nav=items.map(([id,label])=>`<a class="${active===id?'active':''}" href="/admin?tab=${id}#${id}">${esc(label)}</a>`).join('');
  return `<div class="admin-shell"><aside class="admin-sidebar panel"><span class="eyebrow">Admin</span><h2>Control Center</h2><nav>${nav}</nav></aside><section class="admin-content" id="${esc(active)}">${content}</section></div>`;
}

function adminNodesContent(req) {
  rebalanceAssignments();
  const lang=langOf(req),db=readDb(),nodes=listStatusNodes();
  const rows=nodes.map((n)=>{const healthy=nodeIsHealthy(n),statusAssigned=db.servers.filter((s)=>s.assignedNodeId===n.id).length,managedAssigned=(db.managedBots||[]).filter((b)=>b.assignedNodeId===n.id).length,customAssigned=(db.customBots||[]).filter((b)=>b.assignedNodeId===n.id).length,assigned=statusAssigned+managedAssigned+customAssigned,m=n.metrics||{},mode=n.disabled?tr(lang,'Deaktiviert','Disabled'):n.acceptNewBots===false?tr(lang,'Keine neuen Bots','No new bots'):tr(lang,'Nimmt Bots an','Accepting bots');return `<tr><td><strong>${esc(n.name||n.id)}</strong><div class="muted small">${esc(n.id)} · ${esc(n.hostname||'')}</div></td><td><span class="badge ${healthy?'online':'error'}">${healthy?'online':'offline'}</span><div class="muted small">${esc(mode)}</div></td><td><strong>${assigned}/${esc(n.capacity||0)}</strong><div class="muted small">${statusAssigned} Status · ${managedAssigned} Service · ${customAssigned} Custom</div></td><td>${esc(m.rssMb??'—')} MB RSS<div class="muted small">${tr(lang,'frei','free')} ${esc(m.freeMemMb??'—')} MB / ${esc(m.totalMemMb??'—')} MB</div></td><td><form method="post" action="/nodes/${esc(n.id)}" class="nodeform"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><input name="name" maxlength="100" value="${esc(n.name||'')}"><input name="capacity" type="number" min="1" max="1000" value="${esc(n.capacity||50)}"><label class="check"><input type="checkbox" name="acceptNewBots" value="1" ${n.acceptNewBots!==false?'checked':''}> ${tr(lang,'Neue Bots','New bots')}</label><label class="check"><input type="checkbox" name="disabled" value="1" ${n.disabled?'checked':''}> ${tr(lang,'Deaktiviert','Disabled')}</label><button class="button ghost smallbtn">${tr(lang,'Speichern','Save')}</button></form><div class="actions wrap"><a class="button ghost smallbtn" href="/nodes/${esc(n.id)}/details">${tr(lang,'Bots verwalten','Manage bots')}</a><form method="post" action="/nodes/${esc(n.id)}/restart-all" class="inline" onsubmit="return confirm('${tr(lang,'Alle aktiven Bots auf diesem Node neu starten?','Restart all active bots on this node?')}')"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button primary smallbtn">${tr(lang,'Alle Bots neu starten','Restart all bots')}</button></form><form method="post" action="/nodes/${esc(n.id)}/drain"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button ghost smallbtn">Drain</button></form></div></td></tr>`}).join('');
  const installer=String(process.env.NODE_INSTALL_SCRIPT_URL||'https://raw.githubusercontent.com/testererrewr/wardogs-status-panel/main/install-node.sh');
  const deploy=`curl -fsSL ${installer} | bash -s -- ${baseUrl} ${process.env.STATUS_NODE_JOIN_SECRET} 50 "Worker VPS"`;
  return `<div class="pagehead"><div><h1>${tr(lang,'Node Manager','Node Manager')}</h1></div></div><div class="panel node-deploy"><h2>${tr(lang,'Neuen VPS hinzufügen','Add a new VPS')}</h2><pre class="logbox">${esc(deploy)}</pre></div><div class="panel tablewrap"><table><thead><tr><th>Node</th><th>Status</th><th>${tr(lang,'Belegung','Load')}</th><th>RAM</th><th>${tr(lang,'Verwaltung','Management')}</th></tr></thead><tbody>${rows||`<tr><td colspan="5">${tr(lang,'Keine Nodes','No nodes')}</td></tr>`}</tbody></table></div>`;
}

function adminBotsContent(req) {
  const lang=langOf(req),db=readDb();
  const statusRows=db.servers.map((server)=>{
    const owner=db.users.find((u)=>u.discordId===server.ownerDiscordId); const runtime=clusterRuntime(server.id); const state=runtime.state||'stopped';
    const game=server.gameType==='gamedig'?(gameDigMeta(server.queryConfig?.gameId)?.name||server.queryConfig?.gameId||'GameDig'):gameTypeLabel(server.gameType);
    return `<tr><td><strong>${esc(server.name)}</strong><div class="muted small">${esc(server.id)}</div></td><td>${esc(owner?.globalName||owner?.username||server.ownerDiscordId||'—')}<div class="muted small">${esc(server.ownerDiscordId||'')}</div></td><td>${esc(game)}</td><td><span class="badge ${state==='online'?'online':state==='error'?'error':'neutral'}">${esc(state)}</span></td><td>${esc(runtime.nodeName||server.assignedNodeId||'—')}</td><td><div class="actions wrap"><a class="button ghost smallbtn" href="/servers/${esc(server.id)}/edit">${tr(lang,'Bearbeiten','Edit')}</a>${server.enabled?`<form method="post" action="/servers/${esc(server.id)}/stop" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button ghost smallbtn">${tr(lang,'Offline','Offline')}</button></form>`:''}<form method="post" action="/servers/${esc(server.id)}/restart" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button ghost smallbtn">${server.enabled?tr(lang,'Neustart','Restart'):tr(lang,'Starten','Start')}</button></form></div></td></tr>`;
  }).join('');
  const customRows=db.customBots.map((bot)=>{
    const owner=db.users.find((u)=>u.discordId===bot.ownerDiscordId),approval=bot.approvalState||'pending';
    const runButtons=approval==='approved'?`${bot.enabled?`<form method="post" action="/custom-bots/${esc(bot.id)}/stop" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button ghost smallbtn">Stop</button></form>`:''}<form method="post" action="/custom-bots/${esc(bot.id)}/start" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button ${bot.enabled?'ghost':'success'} smallbtn">${bot.enabled?tr(lang,'Neu bauen / Neustart','Rebuild / restart'):tr(lang,'Starten','Start')}</button></form>`:'';
    return `<tr><td><strong>${esc(bot.name)}</strong><div class="muted small">${esc(bot.id)}</div></td><td>${esc(owner?.globalName||owner?.username||bot.ownerDiscordId||'—')}</td><td>${esc(bot.runtime||'—')}</td><td><span class="badge ${approval==='approved'?'online':approval==='rejected'?'error':'neutral'}">${esc(approval)}</span><div class="muted small">${bot.enabled?tr(lang,'enabled','enabled'):tr(lang,'stopped','stopped')}</div></td><td><div class="actions wrap"><a class="button ghost smallbtn" href="/custom-bots/${esc(bot.id)}/files">${tr(lang,'Dateien','Files')}</a><a class="button ghost smallbtn" href="/custom-bots/${esc(bot.id)}/logs">Logs</a><a class="button ghost smallbtn" href="/custom-bots/${esc(bot.id)}/source">Source</a>${runButtons}${approval!=='approved'?`<form method="post" action="/custom-bots/${esc(bot.id)}/approve" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button primary smallbtn">${tr(lang,'Freigeben','Approve')}</button></form>`:`<form method="post" action="/custom-bots/${esc(bot.id)}/revoke" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button danger smallbtn">${tr(lang,'Freigabe entziehen','Revoke approval')}</button></form>`}<form method="post" action="/custom-bots/${esc(bot.id)}/delete" class="inline" onsubmit="return confirm('${tr(lang,'Custom Bot wirklich löschen?','Delete this custom bot?')}')"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button danger smallbtn">${tr(lang,'Löschen','Delete')}</button></form></div></td></tr>`;
  }).join('');
  const managedRows=(db.managedBots||[]).map((bot)=>{
    const owner=db.users.find((u)=>u.discordId===bot.ownerDiscordId),service=db.botServices.find((x)=>x.id===bot.serviceId),rt=serviceBotRuntime(bot),access=managedAccessActive(bot);
    return `<tr><td><strong>${esc(bot.name||service?.nameDe||'Managed Bot')}</strong><div class="muted small">${esc(bot.id)}</div></td><td>${esc(owner?.globalName||owner?.username||bot.ownerDiscordId||'—')}</td><td>${esc(service?.nameDe||service?.nameEn||bot.serviceId)}</td><td><span class="badge ${rt.state==='online'?'online':rt.state==='error'?'error':'neutral'}">${esc(rt.state||'stopped')}</span><div class="muted small">${access?(bot.adminGrant?tr(lang,'Admin gratis','Admin free'):tr(lang,'bezahlt','paid')):tr(lang,'Zugang abgelaufen','access expired')}</div></td><td><div class="actions wrap">${access?(bot.enabled?`<form method="post" action="/managed-bots/${esc(bot.id)}/stop" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button ghost smallbtn">Stop</button></form><form method="post" action="/managed-bots/${esc(bot.id)}/restart" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button primary smallbtn">${tr(lang,'Neustart','Restart')}</button></form>`:`<form method="post" action="/managed-bots/${esc(bot.id)}/restart" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button success smallbtn">${tr(lang,'Starten','Start')}</button></form>`):''}</div></td></tr>`;
  }).join('');
  return `<div class="pagehead"><div><h1>${tr(lang,'Alle Bots','All bots')}</h1></div></div><div class="admin-subhead"><h2>Status Bots</h2></div><div class="panel tablewrap"><table><thead><tr><th>Bot</th><th>Owner</th><th>Game</th><th>Status</th><th>Node</th><th>${tr(lang,'Aktionen','Actions')}</th></tr></thead><tbody>${statusRows||`<tr><td colspan="6">${tr(lang,'Keine Status Bots','No status bots')}</td></tr>`}</tbody></table></div><div class="admin-subhead subsection"><h2>Custom Bots</h2></div><div class="panel tablewrap"><table><thead><tr><th>Bot</th><th>Owner</th><th>Runtime</th><th>${tr(lang,'Freigabe / Status','Approval / status')}</th><th>${tr(lang,'Admin Controls','Admin controls')}</th></tr></thead><tbody>${customRows||`<tr><td colspan="5">${tr(lang,'Keine Custom Bots','No custom bots')}</td></tr>`}</tbody></table></div><div class="admin-subhead subsection"><h2>Managed Bot Services</h2></div><div class="panel tablewrap"><table><thead><tr><th>Bot</th><th>Owner</th><th>Service</th><th>Status</th><th>${tr(lang,'Admin Controls','Admin controls')}</th></tr></thead><tbody>${managedRows||`<tr><td colspan="5">${tr(lang,'Keine Managed Bots','No managed bots')}</td></tr>`}</tbody></table></div>`;
}

function adminUsersContent(req) {
  const lang=langOf(req),db=readDb();
  const baseOptions=Object.values(PLANS).map((p)=>`<option value="${esc(p.id)}">${esc(p.label)} (${p.statusBotLimit})</option>`).join('');
  const rows=db.users.map((u)=>{const count=db.servers.filter((s)=>s.ownerDiscordId===u.discordId).length,custom=db.customBots.filter((b)=>b.ownerDiscordId===u.discordId).length,plan=effectivePlan(u),opts=baseOptions.replace(`value="${esc(u.planId||'free')}"`,`value="${esc(u.planId||'free')}" selected`);return `<tr><td><strong>${esc(u.globalName||u.username||u.discordId)}</strong><div class="muted small">${esc(u.discordId)}</div></td><td>${count}/${plan.statusBotLimit===Infinity?'∞':esc(plan.statusBotLimit)}<div class="muted small">${esc(plan.label)}</div></td><td>${custom}/${esc(u.customBotLimit||0)}</td><td><form method="post" action="/users/${esc(u.discordId)}" class="userform"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><select name="role"><option value="user" ${u.role==='user'?'selected':''}>user</option><option value="admin" ${u.role==='admin'?'selected':''}>admin</option></select><select name="planId">${opts}</select><input name="planDuration" type="number" min="0" max="87600" placeholder="${tr(lang,'Dauer','Duration')}"><select name="planDurationUnit"><option value="hours">${tr(lang,'Stunden','Hours')}</option><option value="days" selected>${tr(lang,'Tage','Days')}</option><option value="months">${tr(lang,'Monate','Months')}</option></select><input name="statusBotLimitOverride" type="number" min="0" max="500" value="${u.statusBotLimitOverride??''}" placeholder="Bot override"><input name="customBotLimit" type="number" min="0" max="50" value="${esc(u.customBotLimit??0)}" placeholder="Custom"><label class="check compact"><input type="checkbox" name="freeRenewExempt" value="1" ${u.freeRenewExempt?'checked':''}> ${tr(lang,'Kein 14-Tage-Renew','No 14-day renew')}</label><button class="button ghost smallbtn">${tr(lang,'Speichern','Save')}</button></form></td></tr>`}).join('');
  return `<div class="pagehead"><div><h1>${tr(lang,'Benutzer & Pläne','Users & plans')}</h1></div></div><div class="panel tablewrap"><table><thead><tr><th>User</th><th>Status Bots</th><th>Custom Bots</th><th>${tr(lang,'Freigaben','Permissions')}</th></tr></thead><tbody>${rows||`<tr><td colspan="4">${tr(lang,'Keine Benutzer','No users')}</td></tr>`}</tbody></table></div>`;
}

function adminServicesContent(req) {
  const lang=langOf(req),services=listBotServices(false),editId=String(req.query.edit||''),edit=editId?getBotService(editId):null,f=edit||{};
  const rows=services.map((x)=>`<tr><td><strong>${esc(x.nameDe||x.nameEn)}</strong><div class="muted small">${esc(String(x.category||'wardogs').toUpperCase())}</div></td><td>${esc(x.priceLabel||'—')}</td><td>${esc(x.status)}</td><td><div class="actions wrap"><a class="button ghost smallbtn" href="/admin?tab=services&edit=${encodeURIComponent(x.id)}#services">${tr(lang,'Bearbeiten','Edit')}</a><form method="post" action="/admin/bot-services/${esc(x.id)}/delete" class="inline" onsubmit="return confirm('${tr(lang,'Bot Service löschen?','Delete bot service?')}')"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button danger smallbtn">${tr(lang,'Löschen','Delete')}</button></form></div></td></tr>`).join('');
  return `<div class="pagehead"><div><h1>${tr(lang,'Bot Services','Bot services')}</h1></div><a class="button ghost" href="/bot-services" target="_blank">${tr(lang,'Öffentliche Seite','Public page')}</a></div><form method="post" action="/admin/bot-services" class="panel formgrid"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><input type="hidden" name="id" value="${esc(f.id||'')}"><label>${tr(lang,'Name Deutsch','Name German')}<input name="nameDe" required value="${esc(f.nameDe||'')}"></label><label>${tr(lang,'Name Englisch','Name English')}<input name="nameEn" required value="${esc(f.nameEn||'')}"></label><label class="span2">${tr(lang,'Beschreibung Deutsch','Description German')}<textarea name="descriptionDe" rows="3" required>${esc(f.descriptionDe||'')}</textarea></label><label class="span2">${tr(lang,'Beschreibung Englisch','Description English')}<textarea name="descriptionEn" rows="3" required>${esc(f.descriptionEn||'')}</textarea></label><label>${tr(lang,'Preis-Anzeige','Price label')}<input name="priceLabel" value="${esc(f.priceLabel||'')}"></label><label>${tr(lang,'Kategorie','Category')}<input name="category" value="${esc(f.category||'wardogs')}" placeholder="wardogs"></label><label>Status<select name="status"><option value="coming_soon" ${f.status==='coming_soon'||!f.status?'selected':''}>Coming soon</option><option value="available" ${f.status==='available'?'selected':''}>Available</option><option value="paused" ${f.status==='paused'?'selected':''}>Paused</option></select></label><label>${tr(lang,'Monatspreis PayPal','PayPal monthly price')}<input name="monthlyAmount" inputmode="decimal" value="${esc(f.monthlyAmount||'')}"></label><label>${tr(lang,'Währung','Currency')}<input name="currency" maxlength="3" value="${esc(f.currency||'EUR')}"></label><label>${tr(lang,'Kauf-Link','Purchase URL')}<input name="purchaseUrl" value="${esc(f.purchaseUrl||'')}"></label><label>${tr(lang,'Support-Link','Support URL')}<input name="supportUrl" value="${esc(f.supportUrl||'')}"></label><label class="check"><input type="checkbox" name="visible" value="1" ${f.visible!==false?'checked':''}> ${tr(lang,'Sichtbar','Visible')}</label><label class="check"><input type="checkbox" name="featured" value="1" ${f.featured?'checked':''}> Featured</label><label class="span2">${tr(lang,'Features Deutsch','Features German')}<textarea name="featuresDe" rows="5">${esc((f.featuresDe||[]).join('\n'))}</textarea></label><label class="span2">${tr(lang,'Features Englisch','Features English')}<textarea name="featuresEn" rows="5">${esc((f.featuresEn||[]).join('\n'))}</textarea></label><div class="span2 actions"><button class="button primary">${edit?tr(lang,'Speichern','Save'):tr(lang,'Hinzufügen','Add')}</button></div></form><div class="panel tablewrap"><table><thead><tr><th>Service</th><th>${tr(lang,'Preis','Price')}</th><th>Status</th><th></th></tr></thead><tbody>${rows||`<tr><td colspan="4">${tr(lang,'Keine Services','No services')}</td></tr>`}</tbody></table></div>`;
}

function adminSettingsContent(req) {
  const lang=langOf(req),settings=getSiteSettings(),supporters=listSupporters(false),tiers=settings.freeBoost?.tiers||[],teamIds=(settings.teamDiscordIds||[]).join(', '),sales=settings.premiumSales||{},prices=sales.prices||{},auto=paypalAutoConfig(settings),sub=paypalSubscriptionConfig(settings),apiState=paypalCredentialState(settings),stripeAuto=stripeAutoConfig(settings),stripeSub=stripeSubscriptionConfig(settings),stripeState=stripeCredentialState(settings),discordAuth=discordOAuthConfig(settings);
  const paypalSubConfiguredIds=['premium5','premium10','premium15','premium20'].filter((id)=>sub.amounts[id]);
  const paypalSubReadyCount=paypalSubConfiguredIds.filter((id)=>sub.planIds[id]).length;
  const paypalSubSetupState=!sub.enabled?'disabled':paypalSubConfiguredIds.length===0?'no-prices':(sub.productId&&paypalSubReadyCount===paypalSubConfiguredIds.length?'ready':'incomplete');
  const paypalSubSetupHtml=paypalSubSetupState==='disabled'?`<span class="badge neutral">${tr(lang,'Deaktiviert','Disabled')}</span>`:paypalSubSetupState==='no-prices'?`<span class="badge neutral">${tr(lang,'Keine Monatspreise gespeichert','No monthly prices saved')}</span>`:`<span class="badge online">${tr(lang,'Preise gespeichert','Prices saved')} · ${paypalSubConfiguredIds.length}/4</span><span class="badge ${paypalSubSetupState==='ready'?'online':'starting'}">${tr(lang,'PayPal-Pläne','PayPal plans')} · ${paypalSubReadyCount}/${paypalSubConfiguredIds.length}</span>`;
  const paypalSubSetupText=paypalSubSetupState==='disabled'?tr(lang,'Monatliche PayPal-Abos sind aktuell deaktiviert.','Monthly PayPal subscriptions are currently disabled.'):paypalSubSetupState==='no-prices'?tr(lang,'Trage mindestens einen Monatspreis ein.','Enter at least one monthly price.'):paypalSubSetupState==='ready'?tr(lang,'Die gespeicherten Monatspreise sind vollständig als PayPal-Abo-Pläne eingerichtet.','The saved monthly prices are fully configured as PayPal subscription plans.'):tr(lang,'Die Monatspreise sind gespeichert. Klicke auf „Speichern & PayPal automatisch einrichten / testen“, um die fehlenden PayPal-Abo-Pläne zu erstellen.','The monthly prices are saved. Click “Save & automatically set up / test PayPal” to create the missing PayPal subscription plans.');
  const tierValue=(limit,fallback)=>tiers.find((x)=>Number(x.limit)===limit)?.members??fallback;
  const rows=supporters.map((x)=>`<tr><td><strong>${esc(x.displayName)}</strong></td><td>${esc(x.amountLabel||'—')}</td><td><form method="post" action="/admin/supporters/${esc(x.id)}/delete"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button danger smallbtn">${tr(lang,'Entfernen','Remove')}</button></form></td></tr>`).join('');
  const paypalCredentialStateHtml=apiState.configured?`<span class="badge online">${tr(lang,'PayPal API bereit','PayPal API ready')}</span><span class="badge ${apiState.storedInPanel?'online':'neutral'}">${apiState.storedInPanel?tr(lang,'Im Panel gespeichert','Stored in panel'):tr(lang,'Legacy .env Fallback','Legacy .env fallback')}</span>`:`<span class="badge error">${tr(lang,'PayPal API Zugangsdaten fehlen','PayPal API credentials missing')}</span>`;
  const webhookState=auto.webhookId?`<span class="badge online">Webhook ${esc(auto.webhookId)}</span>`:`<span class="badge neutral">${tr(lang,'Webhook nicht eingerichtet','Webhook not configured')}</span>`;
  return `<div class="pagehead"><div><h1>${tr(lang,'Einstellungen','Settings')}</h1></div></div>
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
    <div class="span2 help"><strong>${tr(lang,'Abo-Setup','Subscription setup')}:</strong> <span class="chips">${paypalSubSetupHtml}</span> <span class="muted small">${paypalSubSetupText}</span></div>
    <div class="span2 help"><div class="actions wrap">${paypalCredentialStateHtml}${webhookState}<span class="badge neutral">${esc(apiState.mode)}</span><button class="button primary" type="submit" formaction="/admin/paypal/setup" formmethod="post">${tr(lang,'Speichern & PayPal automatisch einrichten / testen','Save & automatically set up / test PayPal')}</button></div><p class="muted small">${tr(lang,'Client Secret wird verschlüsselt in der Panel-Datenbank gespeichert. Für PayPal ist danach keine SSH- oder .env-Änderung nötig.','The client secret is encrypted in the panel database. No SSH or .env changes are needed for PayPal afterwards.')}</p></div>
    <div class="span2 admin-subhead"><h3>Premium & Stripe</h3></div>
    <label>${tr(lang,'Stripe Modus','Stripe mode')}<select name="stripeMode"><option value="test" ${stripeState.mode==='test'?'selected':''}>Test</option><option value="live" ${stripeState.mode==='live'?'selected':''}>Live</option></select></label>
    <label>Stripe Secret Key<input name="stripeSecretKey" type="password" autocomplete="new-password" placeholder="${stripeState.hasSecret?tr(lang,'Leer lassen = vorhandenen Key behalten','Leave empty to keep current key'):'sk_test_... / sk_live_...'}"></label>
    <label class="check span2"><input type="checkbox" name="stripeClearCredentials" value="1"> ${tr(lang,'Gespeicherte Stripe Zugangsdaten löschen','Clear stored Stripe credentials')}</label>
    <label class="check span2"><input type="checkbox" name="stripeAutoEnabled" value="1" ${stripeAuto.enabled?'checked':''}> ${tr(lang,'Automatische Stripe-Freischaltung aktivieren','Enable automatic Stripe activation')}</label>
    <label>${tr(lang,'Währung','Currency')}<input name="stripeCurrency" maxlength="3" value="${esc(stripeAuto.currency)}" placeholder="EUR"></label><label>${tr(lang,'Premium-Dauer pro Einmalkauf (Tage)','Premium duration per one-time purchase (days)')}<input name="stripeAccessDays" type="number" min="1" max="3650" value="${esc(stripeAuto.accessDays)}"></label>
    <label>Premium 5 Stripe<input name="stripeAmountPremium5" inputmode="decimal" value="${esc(stripeAuto.amounts.premium5||'')}"></label><label>Premium 10 Stripe<input name="stripeAmountPremium10" inputmode="decimal" value="${esc(stripeAuto.amounts.premium10||'')}"></label><label>Premium 15 Stripe<input name="stripeAmountPremium15" inputmode="decimal" value="${esc(stripeAuto.amounts.premium15||'')}"></label><label>Premium 20 Stripe<input name="stripeAmountPremium20" inputmode="decimal" value="${esc(stripeAuto.amounts.premium20||'')}"></label>
    <div class="span2 admin-subhead"><h3>${tr(lang,'Monatliche Stripe-Abos','Monthly Stripe subscriptions')}</h3></div>
    <label class="check span2"><input type="checkbox" name="stripeSubscriptionEnabled" value="1" ${stripeSub.enabled?'checked':''}> ${tr(lang,'Monatliche Stripe-Abos anbieten','Offer monthly Stripe subscriptions')}</label>
    <label>Premium 5 / ${tr(lang,'Monat','month')}<input name="stripeSubAmountPremium5" inputmode="decimal" value="${esc(stripeSub.amounts.premium5||'')}"></label><label>Premium 10 / ${tr(lang,'Monat','month')}<input name="stripeSubAmountPremium10" inputmode="decimal" value="${esc(stripeSub.amounts.premium10||'')}"></label><label>Premium 15 / ${tr(lang,'Monat','month')}<input name="stripeSubAmountPremium15" inputmode="decimal" value="${esc(stripeSub.amounts.premium15||'')}"></label><label>Premium 20 / ${tr(lang,'Monat','month')}<input name="stripeSubAmountPremium20" inputmode="decimal" value="${esc(stripeSub.amounts.premium20||'')}"></label>
    <div class="span2 help"><div class="actions wrap"><span class="badge ${stripeState.configured?'online':'error'}">${stripeState.configured?tr(lang,'Stripe API bereit','Stripe API ready'):tr(lang,'Stripe Secret Key fehlt','Stripe Secret Key missing')}</span><span class="badge ${stripeState.hasWebhookSecret?'online':'neutral'}">${stripeState.hasWebhookSecret?tr(lang,'Webhook bereit','Webhook ready'):tr(lang,'Webhook nicht eingerichtet','Webhook not configured')}</span><span class="badge neutral">${esc(stripeState.mode)}</span><button class="button primary" type="submit" formaction="/admin/stripe/setup" formmethod="post">${tr(lang,'Speichern & Stripe automatisch einrichten / testen','Save & automatically set up / test Stripe')}</button></div><p class="muted small">${tr(lang,'Stripe Secret Key und Webhook Secret werden verschlüsselt gespeichert. Der Setup-Button erstellt den Webhook automatisch.','Stripe secret key and webhook secret are stored encrypted. The setup button creates the webhook automatically.')}</p></div>
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
  if(tab==='bots')content=adminBotsContent(req); else if(tab==='nodes')content=adminNodesContent(req); else if(tab==='users')content=adminUsersContent(req); else if(tab==='services')content=adminServicesContent(req); else if(tab==='settings')content=adminSettingsContent(req); else { const healthy=listStatusNodes().filter((n)=>nodeIsHealthy(n)).length; content=`<div class="pagehead"><div><h1>Admin Control Center</h1></div></div><section class="admin-stats"><article class="panel"><span class="eyebrow">Users</span><strong>${db.users.length}</strong></article><article class="panel"><span class="eyebrow">Status Bots</span><strong>${db.servers.length}</strong></article><article class="panel"><span class="eyebrow">Nodes online</span><strong>${healthy}/${db.statusNodes.length}</strong></article><article class="panel"><span class="eyebrow">Custom Bots</span><strong>${db.customBots.length}</strong></article></section>`; }
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
  const assignedStatus=db.servers.filter((s)=>s.assignedNodeId===node.id),assignedManaged=(db.managedBots||[]).filter((b)=>b.assignedNodeId===node.id),assignedCustom=(db.customBots||[]).filter((b)=>b.assignedNodeId===node.id),assigned=[...assignedStatus,...assignedManaged,...assignedCustom]; const targets=db.statusNodes.filter((n)=>n.id!==node.id && nodeIsHealthy(n));
  const targetLoad=(id)=>[...db.servers,...(db.managedBots||[]),...(db.customBots||[])].filter((s)=>s.assignedNodeId===id).length;
  const targetOptions=targets.map((n)=>`<option value="${esc(n.id)}">${esc(n.name||n.id)} · ${targetLoad(n.id)}/${esc(n.capacity||0)}</option>`).join('');
  const statusRows=assignedStatus.map((s)=>{const owner=db.users.find((u)=>u.discordId===s.ownerDiscordId);return `<tr><td><strong>${esc(s.name)}</strong><div class="muted small">${esc(owner?.globalName||owner?.username||s.ownerDiscordId||'')}</div></td><td>Status Bot · ${esc(s.gameType==='gamedig'?(gameDigMeta(s.queryConfig?.gameId)?.name||s.queryConfig?.gameId):gameTypeLabel(s.gameType))}</td><td><form method="post" action="/servers/${esc(s.id)}/move-node" class="moveform"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><select name="targetNodeId" required><option value="">${tr(lang,'Ziel auswählen','Select target')}</option>${targetOptions}</select><button class="button ghost smallbtn">${tr(lang,'Verschieben','Move')}</button></form></td></tr>`;}).join('');
  const managedRows=assignedManaged.map((b)=>{const owner=db.users.find((u)=>u.discordId===b.ownerDiscordId),service=db.botServices.find((x)=>x.id===b.serviceId);return `<tr><td><strong>${esc(b.name||service?.nameDe||b.id)}</strong><div class="muted small">${esc(owner?.globalName||owner?.username||b.ownerDiscordId||'')}</div></td><td>Service Bot · ${esc(service?.nameDe||service?.nameEn||b.serviceId)}</td><td><span class="badge neutral">${tr(lang,'Node-Kapazität','Node capacity')}</span></td></tr>`;}).join('');
  const customRows=assignedCustom.map((b)=>{const owner=db.users.find((u)=>u.discordId===b.ownerDiscordId);return `<tr><td><strong>${esc(b.name||b.id)}</strong><div class="muted small">${esc(owner?.globalName||owner?.username||b.ownerDiscordId||'')}</div></td><td>Custom Bot · ${esc(b.runtime||'custom')}</td><td><span class="badge neutral">${tr(lang,'Node-Kapazität','Node capacity')}</span></td></tr>`;}).join('');
  const rows=statusRows+managedRows+customRows;
  render(req,res,`${node.name||node.id} · ${tr(lang,'Bots','Bots')}`,`<div class="pagehead"><div><h1>${esc(node.name||node.id)}</h1><p>${assigned.length} ${tr(lang,'zugewiesene Bots insgesamt','assigned bots total')} · ${assignedStatus.length} Status · ${assignedManaged.length} Service · ${assignedCustom.length} Custom</p></div><a class="button ghost" href="/nodes">${tr(lang,'Zurück','Back')}</a></div><div class="panel node-actions"><div class="actions wrap"><form method="post" action="/nodes/${esc(node.id)}/restart-all" class="inline" onsubmit="return confirm('${tr(lang,'Alle aktiven Bots auf diesem Node neu starten?','Restart all active bots on this node?')}')"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button primary">${tr(lang,'Alle Bots neu starten','Restart all bots')}</button></form></div><form method="post" action="/nodes/${esc(node.id)}/move-all" class="actions wrap"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><select name="targetNodeId" required><option value="">${tr(lang,'Alle Bots auf Node verschieben …','Move all bots to node …')}</option>${targetOptions}</select><button class="button primary">${tr(lang,'Alle verschieben','Move all')}</button></form></div><div class="panel tablewrap"><table><thead><tr><th>Bot</th><th>Game</th><th>${tr(lang,'Aktion','Action')}</th></tr></thead><tbody>${rows||`<tr><td colspan="3">${tr(lang,'Keine Bots auf diesem Node.','No bots on this node.')}</td></tr>`}</tbody></table></div>`);
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
  const monthlyAmount=normalizedMoney(req.body.monthlyAmount); const currency=/^[A-Za-z]{3}$/.test(String(req.body.currency||''))?String(req.body.currency).toUpperCase():(old?.currency||'EUR');
  const priceChanged=Boolean(old)&&(monthlyAmount!==String(old.monthlyAmount||'')||currency!==String(old.currency||'EUR').toUpperCase());
  const category=String(req.body.category||old?.category||'wardogs').trim().toLowerCase().replace(/[^a-z0-9_-]+/g,'-').slice(0,50)||'wardogs';
  upsertBotService({id:old?.id,slug,category,nameDe:nameDe.slice(0,100),nameEn:nameEn.slice(0,100),descriptionDe:String(req.body.descriptionDe||'').trim().slice(0,800),descriptionEn:String(req.body.descriptionEn||'').trim().slice(0,800),featuresDe:lines(req.body.featuresDe),featuresEn:lines(req.body.featuresEn),priceLabel:String(req.body.priceLabel||'').trim().slice(0,60),monthlyAmount,currency,paypalPlanId:priceChanged?'':(old?.paypalPlanId||''),paypalPlanMeta:priceChanged?{}:(old?.paypalPlanMeta||{}),paypalProductId:old?.paypalProductId||'',status,purchaseUrl:url(req.body.purchaseUrl),supportUrl:url(req.body.supportUrl),visible:req.body.visible==='1',featured:req.body.featured==='1',sortOrder:Math.max(0,Math.min(9999,Number(req.body.sortOrder)||10))});
  flash(req,'ok',l(req,'Bot Service gespeichert.','Bot service saved.')); res.redirect('/admin?tab=services#services');
});

app.post('/admin/bot-services/:id/delete', requireAdmin, checkCsrf, (req,res) => { deleteBotService(req.params.id); flash(req,'ok',l(req,'Bot Service gelöscht.','Bot service deleted.')); res.redirect('/admin?tab=services#services'); });

app.get('/admin/settings', requireAdmin, (req,res) => res.redirect('/admin?tab=settings'));

function saveAdminSettingsFromBody(req) {
  const current=getSiteSettings();
  const cleanDomain=String(req.body.serviceDomain||'status-hub.lol').trim().replace(/^https?:\/\//i,'').replace(/\/+$/,'').slice(0,120)||'status-hub.lol';
  const oldDiscord=current.discordOAuth||{};
  let discordClientId=String(req.body.discordClientId??oldDiscord.clientId??process.env.DISCORD_OAUTH_CLIENT_ID??'').trim().slice(0,100);
  let discordClientSecretEnc=String(oldDiscord.clientSecretEnc||''); const discordNewSecret=String(req.body.discordClientSecret||'').trim();
  if(req.body.discordClearCredentials==='1'){discordClientId='';discordClientSecretEnc='';} else if(discordNewSecret)discordClientSecretEnc=encryptSecret(discordNewSecret.slice(0,500));
  const discordOAuth={enabled:req.body.discordOAuthEnabled==='1',allowRegistration:req.body.discordAllowRegistration==='1',clientId:discordClientId,clientSecretEnc:discordClientSecretEnc};
  const defaults={2:50,3:100,4:250,5:500};
  const values=[2,3,4,5].map((limit)=>({limit,members:Math.max(1,Number(req.body[`tier${limit}`])||defaults[limit])})).sort((a,b)=>a.members-b.members);
  const teamDiscordIds=String(req.body.teamDiscordIds||'').split(',').map((x)=>x.trim()).filter((x)=>validSnowflake(x)).slice(0,25);
  const currency=/^[A-Za-z]{3}$/.test(String(req.body.paypalCurrency||''))?String(req.body.paypalCurrency).toUpperCase():'EUR';
  const oldAuto=paypalAutoConfig(current),oldSub=paypalSubscriptionConfig(current),oldApi=current.premiumSales?.paypalApi||{};
  const mode=String(req.body.paypalMode||oldApi.mode||'sandbox').toLowerCase()==='live'?'live':'sandbox';
  let clientId=String(req.body.paypalClientId??oldApi.clientId??'').trim().slice(0,300),clientSecretEnc=String(oldApi.clientSecretEnc||'');
  const newSecret=String(req.body.paypalClientSecret||'').trim(),clearCredentials=req.body.paypalClearCredentials==='1';
  if(clearCredentials){clientId='';clientSecretEnc='';}else if(newSecret)clientSecretEnc=encryptSecret(newSecret.slice(0,500));
  const credentialsChanged=clearCredentials||Boolean(newSecret)||mode!==String(oldApi.mode||'sandbox')||clientId!==String(oldApi.clientId||'');

  const oldStripeApi=current.premiumSales?.stripeApi||{},oldStripeAuto=stripeAutoConfig(current),oldStripeSub=stripeSubscriptionConfig(current);
  const stripeMode=String(req.body.stripeMode||oldStripeApi.mode||'test').toLowerCase()==='live'?'live':'test';
  let stripeSecretKeyEnc=String(oldStripeApi.secretKeyEnc||''),stripeWebhookSecretEnc=String(oldStripeApi.webhookSecretEnc||''),stripeEndpointId=String(oldStripeApi.endpointId||'');
  const stripeNewKey=String(req.body.stripeSecretKey||'').trim(),stripeClear=req.body.stripeClearCredentials==='1';
  const stripeCredentialsChanged=stripeClear||Boolean(stripeNewKey)||stripeMode!==String(oldStripeApi.mode||'test');
  if(stripeClear){stripeSecretKeyEnc='';stripeWebhookSecretEnc='';stripeEndpointId='';}
  else if(stripeNewKey){stripeSecretKeyEnc=encryptSecret(stripeNewKey.slice(0,500));stripeWebhookSecretEnc='';stripeEndpointId='';}
  if(stripeCredentialsChanged&&!stripeNewKey&&!stripeClear){stripeWebhookSecretEnc='';stripeEndpointId='';}
  const stripeCurrency=/^[A-Za-z]{3}$/.test(String(req.body.stripeCurrency||''))?String(req.body.stripeCurrency).toUpperCase():'EUR';

  const updated=updateSiteSettings({
    serviceDomain:cleanDomain,discordOAuth,supportUrl:String(req.body.supportUrl||'').trim().slice(0,500),teamDiscordIds,
    donationLinks:{paypal:String(req.body.paypal||'').trim().slice(0,500),kofi:String(req.body.kofi||'').trim().slice(0,500),stripe:String(req.body.stripe||'').trim().slice(0,500),customUrl:String(req.body.customUrl||'').trim().slice(0,500),customLabel:String(req.body.customLabel||'').trim().slice(0,80)},
    premiumSales:{
      paypalUrl:String(req.body.premiumPaypalUrl||'').trim().slice(0,500),discordUserId:validSnowflake(req.body.salesDiscordUserId)?String(req.body.salesDiscordUserId).trim():'',discordUsername:String(req.body.salesDiscordUsername||'').trim().slice(0,80),
      prices:{premium5:String(req.body.pricePremium5||'').trim().slice(0,60),premium10:String(req.body.pricePremium10||'').trim().slice(0,60),premium15:String(req.body.pricePremium15||'').trim().slice(0,60),premium20:String(req.body.pricePremium20||'').trim().slice(0,60)},
      paypalApi:{mode,clientId,clientSecretEnc},
      paypalAuto:{enabled:req.body.paypalAutoEnabled==='1',currency,accessDays:Math.max(1,Math.min(3650,Number(req.body.paypalAccessDays)||30)),webhookId:credentialsChanged?'':(oldAuto.webhookId||''),amounts:{premium5:normalizedMoney(req.body.paypalAmountPremium5),premium10:normalizedMoney(req.body.paypalAmountPremium10),premium15:normalizedMoney(req.body.paypalAmountPremium15),premium20:normalizedMoney(req.body.paypalAmountPremium20)}},
      paypalSubscription:{enabled:req.body.paypalSubscriptionEnabled==='1',productId:credentialsChanged?'':(oldSub.productId||''),planIds:credentialsChanged?{}:(oldSub.planIds||{}),planMeta:credentialsChanged?{}:(oldSub.planMeta||{}),amounts:{premium5:normalizedMoney(req.body.paypalSubAmountPremium5),premium10:normalizedMoney(req.body.paypalSubAmountPremium10),premium15:normalizedMoney(req.body.paypalSubAmountPremium15),premium20:normalizedMoney(req.body.paypalSubAmountPremium20)}},
      stripeApi:{mode:stripeMode,secretKeyEnc:stripeSecretKeyEnc,webhookSecretEnc:stripeWebhookSecretEnc,endpointId:stripeEndpointId},
      stripeAuto:{enabled:req.body.stripeAutoEnabled==='1',currency:stripeCurrency,accessDays:Math.max(1,Math.min(3650,Number(req.body.stripeAccessDays)||30)),amounts:{premium5:normalizedMoney(req.body.stripeAmountPremium5),premium10:normalizedMoney(req.body.stripeAmountPremium10),premium15:normalizedMoney(req.body.stripeAmountPremium15),premium20:normalizedMoney(req.body.stripeAmountPremium20)}},
      stripeSubscription:{enabled:req.body.stripeSubscriptionEnabled==='1',amounts:{premium5:normalizedMoney(req.body.stripeSubAmountPremium5),premium10:normalizedMoney(req.body.stripeSubAmountPremium10),premium15:normalizedMoney(req.body.stripeSubAmountPremium15),premium20:normalizedMoney(req.body.stripeSubAmountPremium20)}}
    },
    freeBoost:{categoryName:String(req.body.categoryName||'Powered by status-hub.lol').trim().slice(0,100),verifyHours:Math.max(1,Math.min(48,Number(req.body.verifyHours)||6)),tiers:values}
  });
  recalculateStoredFreeBoostLimits(updated);rebalanceAssignments();return updated;
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
    let settings=saveAdminSettingsFromBody(req);
    if (!paypalConfigured(settings)) throw new Error(l(req,'PayPal Client ID oder Client Secret fehlen in den Admin-Einstellungen.','PayPal Client ID or Client Secret is missing in the admin settings.'));
    let auto=paypalAutoConfig(settings);
    let sub=paypalSubscriptionConfig(settings);
    let subscriptionPlansCreated=false;
    if(sub.enabled){
      const configuredSubPrices=['premium5','premium10','premium15','premium20'].filter((id)=>sub.amounts[id]);
      if(configuredSubPrices.length===0) throw new Error(l(req,'Monatliche PayPal-Abos sind aktiviert, aber es ist kein Monatspreis eingetragen.','Monthly PayPal subscriptions are enabled, but no monthly price is configured.'));
      const catalog=await ensureSubscriptionCatalog({productId:sub.productId,planIds:sub.planIds,planMeta:sub.planMeta,amounts:sub.amounts,currency:sub.currency,settings});
      settings=updateSiteSettings({premiumSales:{paypalSubscription:{...sub,...catalog}}});
      sub=paypalSubscriptionConfig(settings);
      subscriptionPlansCreated=true;
    }
    auto=paypalAutoConfig(settings);
    try{
      const webhook=await ensureWebhook(auto.webhookId,`${baseUrl}/webhooks/paypal`,settings);
      settings=updateSiteSettings({premiumSales:{paypalAuto:{...auto,enabled:true,webhookId:webhook.id}}});
    }catch(webhookError){
      const planCount=['premium5','premium10','premium15','premium20'].filter((id)=>sub.amounts[id]&&sub.planIds[id]).length;
      if(subscriptionPlansCreated&&planCount>0){
        flash(req,'err',l(req,`PayPal-Abo-Pläne wurden gespeichert (${planCount}), aber der Webhook konnte nicht eingerichtet werden: ${webhookError.message}`,`PayPal subscription plans were saved (${planCount}), but the webhook could not be configured: ${webhookError.message}`));
        return res.redirect('/admin?tab=settings#settings');
      }
      throw webhookError;
    }
    flash(req,'ok',subscriptionPlansCreated?l(req,`PayPal ${paypalEnvironment(settings)} verbunden. Monatliche Abo-Pläne und Webhook sind bereit.`,`PayPal ${paypalEnvironment(settings)} connected. Monthly subscription plans and webhook are ready.`):l(req,`PayPal ${paypalEnvironment(settings)} verbunden. Webhook ist bereit; monatliche Abos sind deaktiviert.`,`PayPal ${paypalEnvironment(settings)} connected. Webhook is ready; monthly subscriptions are disabled.`));
  } catch(error) { flash(req,'err',`PayPal: ${error.message}`); }
  res.redirect('/admin?tab=settings#settings');
});

app.post('/admin/stripe/setup', requireAdmin, checkCsrf, rateLimit({ windowMs:60_000, limit:5 }), async(req,res)=>{
  try{
    let settings=saveAdminSettingsFromBody(req);
    if(!stripeConfigured(settings))throw new Error(l(req,'Stripe Secret Key fehlt in den Admin-Einstellungen.','Stripe Secret Key is missing in the admin settings.'));
    const state=stripeCredentialState(settings);
    await testStripeConnection(settings);
    const useExisting=state.endpointId&&state.hasWebhookSecret?state.endpointId:'';
    const result=await ensureStripeWebhook({endpointId:useExisting,url:`${baseUrl}/webhooks/stripe`,settings});
    const patch={premiumSales:{stripeApi:{endpointId:result.endpoint.id}}};
    if(result.secret)patch.premiumSales.stripeApi.webhookSecretEnc=encryptSecret(result.secret);
    settings=updateSiteSettings(patch);
    flash(req,'ok',l(req,`Stripe ${stripeCredentialState(settings).mode} verbunden. Webhook wurde eingerichtet und Checkout ist bereit.`,`Stripe ${stripeCredentialState(settings).mode} connected. Webhook was configured and Checkout is ready.`));
  }catch(error){flash(req,'err',`Stripe: ${error.message}`);}
  res.redirect('/admin?tab=settings#settings');
});

app.post('/admin/supporters', requireAdmin, checkCsrf, (req,res) => {
  const name=String(req.body.displayName||'').trim(); if(!name){flash(req,'err',l(req,'Anzeigename fehlt.','Display name is required.'));return res.redirect('/admin?tab=settings#settings');}
  upsertSupporter({displayName:name.slice(0,80),amountLabel:String(req.body.amountLabel||'').trim().slice(0,40),message:'',link:String(req.body.link||'').trim().slice(0,500),featured:req.body.featured==='1',visible:req.body.visible==='1'});
  flash(req,'ok',l(req,'Supporter hinzugefügt.','Supporter added.')); res.redirect('/admin?tab=settings#settings');
});

app.post('/admin/supporters/:id/delete', requireAdmin, checkCsrf, (req,res) => { deleteSupporter(req.params.id); flash(req,'ok',l(req,'Supporter entfernt.','Supporter removed.')); res.redirect('/admin?tab=settings#settings'); });

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const message=err.code==='LIMIT_FILE_SIZE'?l(req,`Upload zu groß. Maximal ${uploadMaxMb} MB ZIP erlaubt.`,`Upload too large. Maximum ZIP size is ${uploadMaxMb} MB.`):l(req,`Upload fehlgeschlagen: ${err.message}`,`Upload failed: ${err.message}`);
    flash(req,'err',message); return res.redirect('/custom-bots/new');
  }
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
  setTimeout(() => { syncAllServiceBots().catch((e) => console.error('Managed bot startup:', e.message)); }, 3500).unref();
  setInterval(() => { syncAllServiceBots().catch((e) => console.error('Managed bot sync:', e.message)); }, 15_000).unref();
  setInterval(() => { try { rebalanceAssignments(); } catch (e) { console.error('Status-Node-Rebalance:', e.message); } }, 10_000).unref();
  setInterval(() => { try { const r=runLifecycleSweep(); if(r.premiumDeleted||r.renewDeleted||r.premiumGraceStarted||r.renewGraceStarted) rebalanceAssignments(); } catch (e) { console.error('Lifecycle:', e.message); } }, 60_000).unref();
  setTimeout(() => { refreshDueFreeBoosts().then(()=>rebalanceAssignments()).catch(()=>{}); }, 5000).unref();
  setInterval(() => { refreshDueFreeBoosts().then(()=>rebalanceAssignments()).catch(()=>{}); }, 15 * 60_000).unref();
});
httpServer.headersTimeout = 15_000;
// ZIP uploads are capped by Multer (25 MB by default), but the complete request
// can legitimately take longer than 30 seconds on slower uplinks. Keep the
// strict header timeout while allowing enough time for a bounded upload body.
httpServer.requestTimeout = 5 * 60_000;
httpServer.keepAliveTimeout = 5_000;
httpServer.maxRequestsPerSocket = 1000;
httpServer.maxHeadersCount = 100;
async function shutdown(signal){console.log(`\n${signal}: fahre herunter...`);try{await Promise.all([shutdownManagedBots(),shutdownPlaytimeBots(),shutdownKillStatsBots()]);}catch(error){console.error('Managed bot shutdown:',error.message);}httpServer.close(()=>process.exit(0));setTimeout(()=>process.exit(1),5000).unref();}
process.on('SIGINT',()=>shutdown('SIGINT')); process.on('SIGTERM',()=>shutdown('SIGTERM'));
