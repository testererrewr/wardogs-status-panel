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
  createPaypalPurchase, getPaypalPurchase, getPaypalPurchaseByOrder, updatePaypalPurchase, rememberPaypalWebhookEvent, paypalWebhookEventSeen
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
import { registerStatusNode, authenticateStatusNode, heartbeatStatusNode, materializeWorkForNode, rebalanceAssignments, clusterRuntime, nodeIsHealthy, leaseSeconds, moveServerToNode, moveAllFromNode, drainStatusNode } from './cluster.js';
import { verifyFreeBoostForUser, refreshDueFreeBoosts, freeBoostRanges, recalculateStoredFreeBoostLimits } from './free-boost.js';
import { paypalConfigured, paypalEnvironment, paypalCredentialState, createCheckoutOrder, getCheckoutOrder, captureCheckoutOrder, extractCompletedCapture, verifyWebhook, ensureWebhook } from './paypal.js';

const required = ['SESSION_SECRET', 'APP_ENCRYPTION_KEY', 'DISCORD_OAUTH_CLIENT_ID', 'DISCORD_OAUTH_CLIENT_SECRET', 'STATUS_NODE_JOIN_SECRET'];
for (const key of required) if (!process.env[key]) throw new Error(`${key} fehlt in .env`);

const app = express();
const port = Number(process.env.PORT || 3000);
const baseUrl = String(process.env.PUBLIC_URL || '').replace(/\/+$/, '');
if (!/^https?:\/\//i.test(baseUrl)) throw new Error('PUBLIC_URL muss mit http:// oder https:// beginnen');
const redirectUri = `${baseUrl}/auth/discord/callback`;
const secureCookie = process.env.COOKIE_SECURE === 'true' || baseUrl.startsWith('https://');
const bootstrapAdmins = new Set((process.env.ADMIN_DISCORD_IDS || '').split(',').map((x) => x.trim()).filter(Boolean));
const firstAdmin = [...bootstrapAdmins][0] || '';
const publicRegistration = process.env.ALLOW_PUBLIC_REGISTRATION !== 'false';
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
function render(req, res, title, body) { const settings=getSiteSettings(); res.send(layout({ title, body, user: currentUser(req), csrf: csrf(req), flash: takeFlash(req), lang: langOf(req), serviceDomain: settings.serviceDomain || 'status-hub.lol' })); }
function requireLogin(req, res, next) { if (!currentUser(req)) return res.redirect('/login'); next(); }
function requireAdmin(req, res, next) { const u = currentUser(req); if (!u) return res.redirect('/login'); if (u.role !== 'admin') return res.status(403).send('Keine Berechtigung'); next(); }
function validSnowflake(value) { return /^\d{17,20}$/.test(String(value || '').trim()); }
function isAdmin(req) { return currentUser(req)?.role === 'admin'; }
function statusLimit(user) { return effectivePlan(user).statusBotLimit; }
function customLimit(user) { return user?.role === 'admin' ? Infinity : Math.max(0, Number(user?.customBotLimit || 0)); }

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
  return Boolean(auto.enabled && paypalConfigured(settings) && auto.webhookId);
}
function moneyMatches(a, b) { return normalizedMoney(a) === normalizedMoney(b); }
function applyPaypalPurchase(purchase, capture) {
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
  upsertUser({ discordId: user.discordId, planId: fresh.planId, planExpiresAt: expiresAt, premiumSource: { provider: 'paypal', purchaseId: fresh.id, captureId: capture.captureId || fresh.captureId || '' } });
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
  const bot = await discordApi('/users/@me', { headers: { Authorization: `Bot ${token}` } });
  if (!bot.bot) throw new Error('Der Discord Token gehört nicht zu einem Bot-Account');
  return bot;
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
  render(req, res, 'status-hub.lol', `<section class="landing-hero"><div class="landing-copy"><span class="eyebrow">status-hub.lol</span><h1>${tr(lang,'Deine Discord Status-Bots. Einfach gehostet.','Your Discord status bots. Hosted simply.')}</h1><p>${tr(lang,'Erstelle Status-Bots für WARDOGS, FiveM, GameDig, JSON-APIs oder reine Text-Rotation. Ein kostenloser Bot ist inklusive.','Create status bots for WARDOGS, FiveM, GameDig, JSON APIs or text-only rotation. One free bot is included.')}</p><div class="actions wrap"><a class="button discord landing-cta" href="/auth/discord">${tr(lang,'Kostenlos mit Discord starten','Start free with Discord')}</a><a class="button ghost" href="/games">${tr(lang,'Unterstützte Games','Supported games')}</a></div><div class="landing-points"><span>✓ ${tr(lang,'1 Bot kostenlos','1 bot free')}</span><span>✓ ${tr(lang,'Deutsch & Englisch','German & English')}</span><span>✓ ${tr(lang,'Automatisch gehostet','Fully hosted')}</span></div></div><div class="landing-preview panel"><div class="preview-status"><span class="dot online"></span><div><strong>EU Server #1</strong><span>42/100 ${tr(lang,'Spieler online','players online')}</span></div></div><div class="preview-status"><span class="dot online"></span><div><strong>Minecraft</strong><span>Map: survival</span></div></div><div class="preview-status"><span class="dot starting"></span><div><strong>${tr(lang,'Text-Rotation','Text rotation')}</strong><span>Powered by status-hub.lol</span></div></div></div></section><section class="landing-features"><article class="panel"><span class="eyebrow">Games</span><h2>320+</h2><p>${tr(lang,'GameDig plus direkte WARDOGS- und FiveM-Anbindungen.','GameDig plus direct WARDOGS and FiveM integrations.')}</p></article><article class="panel"><span class="eyebrow">Free</span><h2>1–5</h2><p>${tr(lang,'Ein Bot gratis. Mit der Branding-Kategorie sind je nach Servergröße bis zu 5 möglich.','One bot free. With the branding category, server size can unlock up to 5.')}</p></article><article class="panel"><span class="eyebrow">Premium</span><h2>5–20</h2><p>${tr(lang,'Mehr Bots und kein Powered-by-Branding.','More bots and no Powered-by branding.')}</p></article></section><section class="landing-bottom panel"><div><h2>${tr(lang,'In wenigen Minuten online','Online in minutes')}</h2><p>${tr(lang,'Discord Bot Token eintragen, Game auswählen und Status konfigurieren. Hosting und Updates übernimmt der Hub.','Enter a Discord bot token, choose a game and configure the status. The Hub handles hosting and updates.')}</p></div><a class="button primary" href="/auth/discord">${tr(lang,'Jetzt starten','Get started')}</a></section>`);
});

app.get('/auth/discord', rateLimit({ windowMs: 60_000, limit: 20 }), (req, res) => {
  const state = crypto.randomBytes(24).toString('base64url'); req.session.oauthState = state;
  const params = new URLSearchParams({ client_id: process.env.DISCORD_OAUTH_CLIENT_ID, response_type: 'code', redirect_uri: redirectUri, scope: 'identify', state });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

app.get('/auth/discord/callback', rateLimit({ windowMs: 60_000, limit: 30 }), async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state || state !== req.session.oauthState) throw new Error('OAuth state ungültig');
    delete req.session.oauthState;
    const form = new URLSearchParams({ client_id: process.env.DISCORD_OAUTH_CLIENT_ID, client_secret: process.env.DISCORD_OAUTH_CLIENT_SECRET, grant_type: 'authorization_code', code: String(code), redirect_uri: redirectUri });
    const tokenResponse = await fetch('https://discord.com/api/v10/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
    if (!tokenResponse.ok) throw new Error(`OAuth Token Exchange fehlgeschlagen (${tokenResponse.status})`);
    const token = await tokenResponse.json();
    const profile = await discordApi('/users/@me', { headers: { Authorization: `Bearer ${token.access_token}` } });

    let user = findUser(profile.id);
    const bootstrap = bootstrapAdmins.has(profile.id);
    if (!user && !publicRegistration && !bootstrap) return res.status(403).send('Registrierung ist derzeit deaktiviert.');
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
      req.session.csrf = crypto.randomBytes(24).toString('base64url'); res.redirect('/');
    });
  } catch (error) { res.status(500).send(`Discord Login fehlgeschlagen: ${esc(error.message)}`); }
});

app.post('/logout', requireLogin, checkCsrf, (req, res) => req.session.destroy(() => res.redirect('/login')));

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

app.post('/webhooks/paypal', rateLimit({ windowMs: 60_000, limit: 120 }), async (req, res) => {
  try {
    const settings = getSiteSettings();
    const auto = paypalAutoConfig(settings);
    if (!paypalConfigured() || !auto.webhookId) return res.status(503).send('PayPal webhook not configured');
    const event = req.body || {};
    if (!event.id || !event.event_type) return res.status(400).send('Invalid webhook');
    if (paypalWebhookEventSeen(event.id)) return res.status(200).send('OK');
    if (!await verifyWebhook(req.headers, event, auto.webhookId)) return res.status(400).send('Invalid PayPal signature');
    const purchase = purchaseFromPaypalEvent(event);
    if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
      if (!purchase) throw new Error('PayPal purchase not found for completed capture');
      const resource = event.resource || {};
      applyPaypalPurchase(purchase, { status: resource.status || 'COMPLETED', captureId: resource.id || '', customId: resource.custom_id || purchase.id, amount: resource.amount?.value || '', currency: resource.amount?.currency_code || '' });
    } else if (event.event_type === 'PAYMENT.CAPTURE.DENIED') {
      if (purchase) updatePaypalPurchase(purchase.id, { status: 'denied', error: event.summary || 'PayPal capture denied' });
    } else if (event.event_type === 'PAYMENT.CAPTURE.REFUNDED') {
      if (purchase) {
        const refundAmount = event.resource?.amount?.value || '';
        if (!refundAmount || moneyMatches(refundAmount, purchase.amount)) revokePaypalPurchase(purchase, 'refunded');
        else updatePaypalPurchase(purchase.id, { status: 'partial_refund', lastRefundAt: new Date().toISOString() });
      }
    } else if (event.event_type === 'PAYMENT.CAPTURE.REVERSED') {
      if (purchase) revokePaypalPurchase(purchase, 'reversed');
    }
    rememberPaypalWebhookEvent(event.id, event.event_type);
    res.status(200).send('OK');
  } catch (error) {
    console.error('PayPal webhook:', error.message);
    res.status(500).send('Webhook processing failed');
  }
});

app.get('/plans', (req, res) => {
  const lang = langOf(req); const u = currentUser(req); const current = effectivePlan(u); const settings = getSiteSettings(); const sales = settings.premiumSales || {}; const auto = paypalAutoConfig(settings); const automatic = paypalAutoReady(settings);
  const discordContact = sales.discordUserId && validSnowflake(sales.discordUserId) ? `https://discord.com/users/${encodeURIComponent(sales.discordUserId)}` : '';
  const cards = Object.values(PLANS).map((p) => {
    const automaticPrice = p.id !== 'free' && auto.amounts[p.id] ? `${auto.amounts[p.id]} ${auto.currency} / ${auto.accessDays} ${tr(lang,'Tage','days')}` : '';
    const price = p.id === 'free' ? tr(lang,'Kostenlos','Free') : (automaticPrice || String(sales.prices?.[p.id] || tr(lang,'Preis auf Anfrage','Price on request')));
    let action = '';
    if (p.id !== 'free') {
      if (automatic && auto.amounts[p.id]) action = u ? `<form method="post" action="/paypal/checkout/${esc(p.id)}"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button primary" type="submit">${tr(lang,'Jetzt mit PayPal kaufen','Buy now with PayPal')}</button></form>` : `<a class="button primary" href="/login">${tr(lang,'Einloggen & mit PayPal kaufen','Login & buy with PayPal')}</a>`;
      else if (/^https?:\/\//i.test(String(sales.paypalUrl || ''))) action = `<a class="button primary" href="${esc(sales.paypalUrl)}" target="_blank" rel="noopener">${tr(lang,'Jetzt mit PayPal kaufen','Buy now with PayPal')}</a>`;
      else if (discordContact) action = `<a class="button primary" href="${esc(discordContact)}" target="_blank" rel="noopener">${tr(lang,'Auf Discord kaufen','Buy via Discord')}</a>`;
      else if (sales.discordUsername) action = `<div class="plan-contact">${tr(lang,'Zum Kaufen auf Discord anschreiben','Message on Discord to buy')}: <strong>${esc(sales.discordUsername)}</strong></div>`;
      else if (settings.supportUrl) action = `<a class="button primary" href="${esc(settings.supportUrl)}" target="_blank" rel="noopener">${tr(lang,'Kaufen / Support','Buy / support')}</a>`;
    }
    return `<article class="panel plan-card ${u && current.id===p.id?'current-plan':''}"><span class="eyebrow">${p.id==='free'?tr(lang,'Kostenlos','Free'):'Premium'}</span><h2>${esc(p.label)}</h2><div class="plan-number">${p.statusBotLimit}</div><p>Status Bot${p.statusBotLimit===1?'':'s'}</p><div class="plan-price">${esc(price)}</div><ul><li>${tr(lang,'Alle unterstützten Games','All supported games')}</li><li>${tr(lang,'Status-Rotation, Map & Spieler je nach Game','Status rotation, map & players depending on the game')}</li><li>${p.branded?tr(lang,'Powered by status-hub.lol im Free-Status','Powered by status-hub.lol on Free status bots'):tr(lang,'Kein Service-Branding','No service branding')}</li></ul>${u && current.id===p.id?`<div class="actions wrap"><span class="badge online">${tr(lang,'Aktueller Plan','Current plan')}</span>${action}</div>`:action}</article>`;
  }).join('');
  const purchaseNote = automatic ? tr(lang,`PayPal ist automatisch angebunden. Nach erfolgreicher Zahlung wird Premium sofort für ${auto.accessDays} Tage freigeschaltet.`,`PayPal is connected automatically. After successful payment, Premium is activated immediately for ${auto.accessDays} days.`) : sales.paypalUrl ? tr(lang,'PayPal-Link ist hinterlegt; Freischaltung erfolgt noch manuell.','A PayPal link is configured; activation is still manual.') : sales.discordUsername ? `${tr(lang,'Aktueller Kaufkontakt','Current purchase contact')}: ${esc(sales.discordUsername)}` : tr(lang,'Kaufkontakt wird noch eingerichtet.','Purchase contact is not configured yet.');
  render(req,res,'Premium',`<div class="pagehead"><div><h1>Premium</h1><p>${tr(lang,'Free startet mit 1 Bot und kann über Server-Branding auf bis zu 5 Gratis-Bots wachsen. Premium entfernt Branding.','Free starts with 1 bot and can grow to up to 5 free bots through server branding. Premium removes branding.')}</p></div></div><section class="plan-grid">${cards}</section><div class="panel help"><strong>${tr(lang,'Kaufen','Purchase')}:</strong> ${purchaseNote}<br><strong>Custom Bots:</strong> ${tr(lang,'bleiben unabhängig und werden nur manuell im Backend freigeschaltet.','remain separate and are enabled manually in the backend only.')}</div>`);
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
    return `<article class="servercard panel"><div class="row between"><div><h2>${esc(s.name)}</h2><div class="chips"><span class="badge ${esc(state)}">${esc(stateLabel(state,r,s))}</span><span class="badge neutral">${esc(s.gameType === 'gamedig' ? (gameDigMeta(s.queryConfig?.gameId)?.name || `GameDig: ${s.queryConfig?.gameId || '?'}`) : gameTypeLabel(s.gameType))}</span></div></div><div class="dot ${esc(state)}"></div></div>${u.role === 'admin' ? `<p class="muted small">Owner: ${esc(owner?.globalName || owner?.username || s.ownerDiscordId || 'Legacy')} · Node: ${esc(r.nodeName || s.assignedNodeId || tr(lang,'nicht zugewiesen','unassigned'))}</p>` : ''}<dl><div><dt>Bot</dt><dd>${esc(r.botTag || tr(lang,'noch nicht verbunden','not connected yet'))}</dd></div><div><dt>Presence</dt><dd>${esc(r.presence || '—')}</dd></div>${s.gameType === 'text_only' ? '' : `<div><dt>Map</dt><dd>${esc(r.map || '—')}</dd></div><div><dt>Ping</dt><dd>${esc(r.ping == null ? '—' : `${r.ping} ms`)}</dd></div>`}</dl>${r.lastError ? `<div class="errorbox">${esc(r.lastError)}</div>` : ''}<div class="actions wrap">${invite ? `<a class="button ghost" href="${invite}" target="_blank" rel="noopener">${tr(lang,'Bot einladen','Invite bot')}</a>` : ''}<a class="button ghost" href="/servers/${esc(s.id)}/edit">${tr(lang,'Bearbeiten','Edit')}</a><form method="post" action="/servers/${esc(s.id)}/test" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button ghost">${tr(lang,'Status testen','Test status')}</button></form><form method="post" action="/servers/${esc(s.id)}/restart" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button ghost">${tr(lang,'Neu starten','Restart')}</button></form><form method="post" action="/servers/${esc(s.id)}/delete" class="inline" onsubmit="return confirm('${tr(lang,'Status Bot wirklich löschen?','Delete this status bot?')}')"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button danger">${tr(lang,'Löschen','Delete')}</button></form></div></article>`;
  }).join('');
  const canAdd = ownCount < limit;
  const expiry = plan.expiresAt && !plan.expired ? ` · ${tr(lang,'bis','until')} ${new Date(plan.expiresAt).toLocaleString(localeCode(lang))}` : '';
  const quota = u.role === 'admin' ? tr(lang,'Admin: unbegrenzt','Admin: unlimited') : `${ownCount}/${limit} Status Bots · ${plan.label}${expiry}`;
  const branding = u.role !== 'admin' && plan.branded ? `<div class="panel help"><strong>Free:</strong> ${tr(lang,'Alle Free-Status-Bots zeigen automatisch','All Free status bots automatically show')} <code>Powered by ${esc(settings.serviceDomain || 'status-hub.lol')}</code>. <a href="/get-more">${tr(lang,'Bis zu 5 gratis bekommen','Get up to 5 for free')}</a>.</div>` : '';
  render(req,res,'Status Bots',`<div class="pagehead"><div><h1>Status Bots</h1><p>${esc(quota)} · WARDOGS, FiveM, GameDig, JSON & Text Rotation</p></div>${canAdd ? `<a class="button primary" href="/servers/new">+ Status Bot</a>` : `<a class="button ghost" href="/plans">${tr(lang,'Limit erreicht · Premium ansehen','Limit reached · View Premium')}</a>`}</div>${branding}<section class="grid">${cards || `<div class="empty panel">${tr(lang,'Noch keine Status Bots angelegt.','No status bots yet.')}</div>`}</section>`);
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
      onlineTemplates: parseTemplates(req.body.onlineTemplates, q.gameType), offlineTemplate: String(req.body.offlineTemplate || 'Server offline').slice(0, 128), enabled: req.body.enabled === '1', restartNonce: Date.now()
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
      onlineTemplates: parseTemplates(req.body.onlineTemplates, q.gameType), offlineTemplate: String(req.body.offlineTemplate || 'Server offline').slice(0, 128), enabled: req.body.enabled === '1'
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
app.post('/servers/:id/restart', requireLogin, checkCsrf, async (req, res) => { const s = ownedServer(req, req.params.id); if (!s) return res.status(404).send('Nicht gefunden'); upsertServer({ id: s.id, enabled: true, restartNonce: Date.now() }); rebalanceAssignments(); flash(req,'ok',l(req,'Bot wird gestartet bzw. neu gestartet.','Bot is being started or restarted.')); const fromAdmin=currentUser(req)?.role==='admin' && String(req.get('referer')||'').includes('/admin'); res.redirect(fromAdmin?'/admin?tab=bots#bots':'/'); });
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
  const rows=nodes.map((n)=>{const healthy=nodeIsHealthy(n),assigned=db.servers.filter((s)=>s.assignedNodeId===n.id).length,m=n.metrics||{},mode=n.disabled?tr(lang,'Deaktiviert','Disabled'):n.acceptNewBots===false?tr(lang,'Keine neuen Bots','No new bots'):tr(lang,'Nimmt Bots an','Accepting bots');return `<tr><td><strong>${esc(n.name||n.id)}</strong><div class="muted small">${esc(n.id)} · ${esc(n.hostname||'')}</div></td><td><span class="badge ${healthy?'online':'error'}">${healthy?'online':'offline'}</span><div class="muted small">${esc(mode)}</div></td><td>${assigned}/${esc(n.capacity||0)}</td><td>${esc(m.rssMb??'—')} MB RSS<div class="muted small">${tr(lang,'frei','free')} ${esc(m.freeMemMb??'—')} MB / ${esc(m.totalMemMb??'—')} MB</div></td><td><form method="post" action="/nodes/${esc(n.id)}" class="nodeform"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><input name="name" maxlength="100" value="${esc(n.name||'')}"><input name="capacity" type="number" min="1" max="1000" value="${esc(n.capacity||50)}"><label class="check"><input type="checkbox" name="acceptNewBots" value="1" ${n.acceptNewBots!==false?'checked':''}> ${tr(lang,'Neue Bots','New bots')}</label><label class="check"><input type="checkbox" name="disabled" value="1" ${n.disabled?'checked':''}> ${tr(lang,'Deaktiviert','Disabled')}</label><button class="button ghost smallbtn">${tr(lang,'Speichern','Save')}</button></form><div class="actions wrap"><a class="button ghost smallbtn" href="/nodes/${esc(n.id)}/details">${tr(lang,'Bots verwalten','Manage bots')}</a><form method="post" action="/nodes/${esc(n.id)}/drain"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button ghost smallbtn">Drain</button></form></div></td></tr>`}).join('');
  const installer=String(process.env.NODE_INSTALL_SCRIPT_URL||'https://raw.githubusercontent.com/testererrewr/wardogs-status-panel/main/install-node.sh');
  const deploy=`curl -fsSL ${installer} | bash -s -- ${baseUrl} ${process.env.STATUS_NODE_JOIN_SECRET} 50 "Worker VPS"`;
  return `<div class="pagehead"><div><h1>${tr(lang,'Node Manager','Node Manager')}</h1><p>${tr(lang,'Neue Bots sperren, Nodes drainen, Kapazitäten setzen und Bots verschieben.','Block new bots, drain nodes, set capacity and move bots.')}</p></div></div><div class="panel node-deploy"><h2>${tr(lang,'Neuen VPS hinzufügen','Add a new VPS')}</h2><pre class="logbox">${esc(deploy)}</pre></div><div class="panel tablewrap"><table><thead><tr><th>Node</th><th>Status</th><th>${tr(lang,'Belegung','Load')}</th><th>RAM</th><th>${tr(lang,'Verwaltung','Management')}</th></tr></thead><tbody>${rows||`<tr><td colspan="5">${tr(lang,'Keine Nodes','No nodes')}</td></tr>`}</tbody></table></div>`;
}

function adminBotsContent(req) {
  const lang=langOf(req),db=readDb();
  const statusRows=db.servers.map((server)=>{
    const owner=db.users.find((u)=>u.discordId===server.ownerDiscordId); const runtime=clusterRuntime(server.id); const state=runtime.state||'stopped';
    const game=server.gameType==='gamedig'?(gameDigMeta(server.queryConfig?.gameId)?.name||server.queryConfig?.gameId||'GameDig'):gameTypeLabel(server.gameType);
    return `<tr><td><strong>${esc(server.name)}</strong><div class="muted small">${esc(server.id)}</div></td><td>${esc(owner?.globalName||owner?.username||server.ownerDiscordId||'—')}<div class="muted small">${esc(server.ownerDiscordId||'')}</div></td><td>${esc(game)}</td><td><span class="badge ${state==='online'?'online':state==='error'?'error':'neutral'}">${esc(state)}</span></td><td>${esc(runtime.nodeName||server.assignedNodeId||'—')}</td><td><div class="actions wrap"><a class="button ghost smallbtn" href="/servers/${esc(server.id)}/edit">${tr(lang,'Bearbeiten','Edit')}</a><form method="post" action="/servers/${esc(server.id)}/restart" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button ghost smallbtn">${tr(lang,'Neustart','Restart')}</button></form></div></td></tr>`;
  }).join('');
  const customRows=db.customBots.map((bot)=>{const owner=db.users.find((u)=>u.discordId===bot.ownerDiscordId);const approval=bot.approvalState||'pending';return `<tr><td><strong>${esc(bot.name)}</strong><div class="muted small">${esc(bot.id)}</div></td><td>${esc(owner?.globalName||owner?.username||bot.ownerDiscordId||'—')}</td><td>${esc(bot.runtime||'—')}</td><td>${esc(approval)}</td><td><div class="actions wrap"><a class="button ghost smallbtn" href="/custom-bots/${esc(bot.id)}/logs">Logs</a><a class="button ghost smallbtn" href="/custom-bots/${esc(bot.id)}/source">Source</a>${approval!=='approved'?`<form method="post" action="/custom-bots/${esc(bot.id)}/approve" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button primary smallbtn">${tr(lang,'Freigeben','Approve')}</button></form>`:`<form method="post" action="/custom-bots/${esc(bot.id)}/revoke" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button danger smallbtn">${tr(lang,'Entziehen','Revoke')}</button></form>`}</div></td></tr>`;}).join('');
  return `<div class="pagehead"><div><h1>${tr(lang,'Alle Bots','All bots')}</h1><p>${tr(lang,'Bots anderer Benutzer werden nur hier im Adminbereich angezeigt.','Bots owned by other users are shown only here in the admin area.')}</p></div></div><div class="admin-subhead"><h2>Status Bots</h2></div><div class="panel tablewrap"><table><thead><tr><th>Bot</th><th>Owner</th><th>Game</th><th>Status</th><th>Node</th><th>${tr(lang,'Aktionen','Actions')}</th></tr></thead><tbody>${statusRows||`<tr><td colspan="6">${tr(lang,'Keine Status Bots','No status bots')}</td></tr>`}</tbody></table></div><div class="admin-subhead subsection"><h2>Custom Bots</h2></div><div class="panel tablewrap"><table><thead><tr><th>Bot</th><th>Owner</th><th>Runtime</th><th>${tr(lang,'Freigabe','Approval')}</th><th>${tr(lang,'Aktionen','Actions')}</th></tr></thead><tbody>${customRows||`<tr><td colspan="5">${tr(lang,'Keine Custom Bots','No custom bots')}</td></tr>`}</tbody></table></div>`;
}

function adminUsersContent(req) {
  const lang=langOf(req),db=readDb();
  const baseOptions=Object.values(PLANS).map((p)=>`<option value="${esc(p.id)}">${esc(p.label)} (${p.statusBotLimit})</option>`).join('');
  const rows=db.users.map((u)=>{const count=db.servers.filter((s)=>s.ownerDiscordId===u.discordId).length,custom=db.customBots.filter((b)=>b.ownerDiscordId===u.discordId).length,plan=effectivePlan(u),opts=baseOptions.replace(`value="${esc(u.planId||'free')}"`,`value="${esc(u.planId||'free')}" selected`);return `<tr><td><strong>${esc(u.globalName||u.username||u.discordId)}</strong><div class="muted small">${esc(u.discordId)}</div></td><td>${count}/${plan.statusBotLimit===Infinity?'∞':esc(plan.statusBotLimit)}<div class="muted small">${esc(plan.label)}</div></td><td>${custom}/${esc(u.customBotLimit||0)}</td><td><form method="post" action="/users/${esc(u.discordId)}" class="userform"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><select name="role"><option value="user" ${u.role==='user'?'selected':''}>user</option><option value="admin" ${u.role==='admin'?'selected':''}>admin</option></select><select name="planId">${opts}</select><input name="planDuration" type="number" min="0" max="87600" placeholder="${tr(lang,'Dauer','Duration')}"><select name="planDurationUnit"><option value="hours">${tr(lang,'Stunden','Hours')}</option><option value="days" selected>${tr(lang,'Tage','Days')}</option><option value="months">${tr(lang,'Monate','Months')}</option></select><input name="statusBotLimitOverride" type="number" min="0" max="500" value="${u.statusBotLimitOverride??''}" placeholder="Bot override"><input name="customBotLimit" type="number" min="0" max="50" value="${esc(u.customBotLimit??0)}" placeholder="Custom"><button class="button ghost smallbtn">${tr(lang,'Speichern','Save')}</button></form></td></tr>`}).join('');
  return `<div class="pagehead"><div><h1>${tr(lang,'Benutzer & Pläne','Users & plans')}</h1><p>${tr(lang,'Premium zeitlich oder dauerhaft freischalten. Custom Bots bleiben separat.','Enable Premium temporarily or permanently. Custom bots remain separate.')}</p></div></div><div class="panel tablewrap"><table><thead><tr><th>User</th><th>Status Bots</th><th>Custom Bots</th><th>${tr(lang,'Freigaben','Permissions')}</th></tr></thead><tbody>${rows||`<tr><td colspan="4">${tr(lang,'Keine Benutzer','No users')}</td></tr>`}</tbody></table></div>`;
}

function adminServicesContent(req) {
  const lang=langOf(req),services=listBotServices(false),editId=String(req.query.edit||''),edit=editId?getBotService(editId):null,f=edit||{};
  const rows=services.map((x)=>`<tr><td><strong>${esc(x.nameDe||x.nameEn)}</strong></td><td>${esc(x.priceLabel||'—')}</td><td>${esc(x.status)}</td><td><div class="actions wrap"><a class="button ghost smallbtn" href="/admin?tab=services&edit=${encodeURIComponent(x.id)}#services">${tr(lang,'Bearbeiten','Edit')}</a><form method="post" action="/admin/bot-services/${esc(x.id)}/delete" class="inline" onsubmit="return confirm('${tr(lang,'Bot Service löschen?','Delete bot service?')}')"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button danger smallbtn">${tr(lang,'Löschen','Delete')}</button></form></div></td></tr>`).join('');
  return `<div class="pagehead"><div><h1>${tr(lang,'Bot Services','Bot services')}</h1><p>${tr(lang,'Einzeln kaufbare Managed Bots verwalten.','Manage individually purchasable managed bots.')}</p></div><a class="button ghost" href="/bot-services" target="_blank">${tr(lang,'Öffentliche Seite','Public page')}</a></div><form method="post" action="/admin/bot-services" class="panel formgrid"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><input type="hidden" name="id" value="${esc(f.id||'')}"><label>${tr(lang,'Name Deutsch','Name German')}<input name="nameDe" required value="${esc(f.nameDe||'')}"></label><label>${tr(lang,'Name Englisch','Name English')}<input name="nameEn" required value="${esc(f.nameEn||'')}"></label><label class="span2">${tr(lang,'Beschreibung Deutsch','Description German')}<textarea name="descriptionDe" rows="3" required>${esc(f.descriptionDe||'')}</textarea></label><label class="span2">${tr(lang,'Beschreibung Englisch','Description English')}<textarea name="descriptionEn" rows="3" required>${esc(f.descriptionEn||'')}</textarea></label><label>${tr(lang,'Preis','Price')}<input name="priceLabel" value="${esc(f.priceLabel||'')}"></label><label>Status<select name="status"><option value="coming_soon" ${f.status==='coming_soon'||!f.status?'selected':''}>Coming soon</option><option value="available" ${f.status==='available'?'selected':''}>Available</option><option value="paused" ${f.status==='paused'?'selected':''}>Paused</option></select></label><label>${tr(lang,'Kauf-Link','Purchase URL')}<input name="purchaseUrl" value="${esc(f.purchaseUrl||'')}"></label><label>${tr(lang,'Support-Link','Support URL')}<input name="supportUrl" value="${esc(f.supportUrl||'')}"></label><label class="check"><input type="checkbox" name="visible" value="1" ${f.visible!==false?'checked':''}> ${tr(lang,'Sichtbar','Visible')}</label><label class="check"><input type="checkbox" name="featured" value="1" ${f.featured?'checked':''}> Featured</label><label class="span2">${tr(lang,'Features Deutsch','Features German')}<textarea name="featuresDe" rows="5">${esc((f.featuresDe||[]).join('\n'))}</textarea></label><label class="span2">${tr(lang,'Features Englisch','Features English')}<textarea name="featuresEn" rows="5">${esc((f.featuresEn||[]).join('\n'))}</textarea></label><div class="span2 actions"><button class="button primary">${edit?tr(lang,'Speichern','Save'):tr(lang,'Hinzufügen','Add')}</button></div></form><div class="panel tablewrap"><table><thead><tr><th>Service</th><th>${tr(lang,'Preis','Price')}</th><th>Status</th><th></th></tr></thead><tbody>${rows||`<tr><td colspan="4">${tr(lang,'Keine Services','No services')}</td></tr>`}</tbody></table></div>`;
}

function adminSettingsContent(req) {
  const lang=langOf(req),settings=getSiteSettings(),supporters=listSupporters(false),tiers=settings.freeBoost?.tiers||[],teamIds=(settings.teamDiscordIds||[]).join(', '),sales=settings.premiumSales||{},prices=sales.prices||{},auto=paypalAutoConfig(settings),apiState=paypalCredentialState(settings);
  const tierValue=(limit,fallback)=>tiers.find((x)=>Number(x.limit)===limit)?.members??fallback;
  const rows=supporters.map((x)=>`<tr><td><strong>${esc(x.displayName)}</strong></td><td>${esc(x.amountLabel||'—')}</td><td><form method="post" action="/admin/supporters/${esc(x.id)}/delete"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button danger smallbtn">${tr(lang,'Entfernen','Remove')}</button></form></td></tr>`).join('');
  const paypalCredentialStateHtml=apiState.configured?`<span class="badge online">${tr(lang,'PayPal API bereit','PayPal API ready')}</span><span class="badge ${apiState.storedInPanel?'online':'neutral'}">${apiState.storedInPanel?tr(lang,'Im Panel gespeichert','Stored in panel'):tr(lang,'Legacy .env Fallback','Legacy .env fallback')}</span>`:`<span class="badge error">${tr(lang,'PayPal API Zugangsdaten fehlen','PayPal API credentials missing')}</span>`;
  const webhookState=auto.webhookId?`<span class="badge online">Webhook ${esc(auto.webhookId)}</span>`:`<span class="badge neutral">${tr(lang,'Webhook nicht eingerichtet','Webhook not configured')}</span>`;
  return `<div class="pagehead"><div><h1>${tr(lang,'Einstellungen','Settings')}</h1><p>${tr(lang,'Branding, Premium-Verkauf, Free-Boost und öffentliche Links.','Branding, Premium sales, free boost and public links.')}</p></div></div>
  <form method="post" action="/admin/settings" class="panel formgrid"><input type="hidden" name="_csrf" value="${esc(csrf(req))}">
    <label>${tr(lang,'Service-Domain','Service domain')}<input name="serviceDomain" required value="${esc(settings.serviceDomain||'status-hub.lol')}"></label><label>Support URL<input name="supportUrl" value="${esc(settings.supportUrl||'')}"></label><label class="span2">${tr(lang,'Team Discord IDs','Team Discord IDs')}<input name="teamDiscordIds" value="${esc(teamIds)}"></label>
    <div class="span2 admin-subhead"><h3>Premium & PayPal</h3></div>
    <label>${tr(lang,'PayPal Modus','PayPal mode')}<select name="paypalMode"><option value="sandbox" ${apiState.mode==='sandbox'?'selected':''}>Sandbox</option><option value="live" ${apiState.mode==='live'?'selected':''}>Live</option></select></label>
    <label>PayPal Client ID<input name="paypalClientId" value="${esc(apiState.clientId||'')}" autocomplete="off" placeholder="Client ID"></label>
    <label class="span2">PayPal Client Secret<input name="paypalClientSecret" type="password" autocomplete="new-password" placeholder="${apiState.hasSecret?tr(lang,'Leer lassen = vorhandenes Secret behalten','Leave empty to keep current secret'):'Client Secret'}"></label>
    <label class="check span2"><input type="checkbox" name="paypalClearCredentials" value="1"> ${tr(lang,'Gespeicherte PayPal API-Zugangsdaten löschen','Clear stored PayPal API credentials')}</label>
    <label class="check span2"><input type="checkbox" name="paypalAutoEnabled" value="1" ${auto.enabled?'checked':''}> ${tr(lang,'Automatische PayPal-Freischaltung aktivieren','Enable automatic PayPal activation')}</label>
    <label>${tr(lang,'Währung','Currency')}<input name="paypalCurrency" maxlength="3" value="${esc(auto.currency)}" placeholder="EUR"></label><label>${tr(lang,'Premium-Dauer pro Kauf (Tage)','Premium duration per purchase (days)')}<input name="paypalAccessDays" type="number" min="1" max="3650" value="${esc(auto.accessDays)}"></label>
    <label>Premium 5 PayPal<input name="paypalAmountPremium5" inputmode="decimal" value="${esc(auto.amounts.premium5||'')}"></label><label>Premium 10 PayPal<input name="paypalAmountPremium10" inputmode="decimal" value="${esc(auto.amounts.premium10||'')}"></label><label>Premium 15 PayPal<input name="paypalAmountPremium15" inputmode="decimal" value="${esc(auto.amounts.premium15||'')}"></label><label>Premium 20 PayPal<input name="paypalAmountPremium20" inputmode="decimal" value="${esc(auto.amounts.premium20||'')}"></label>
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

app.post('/nodes/:id/drain', requireAdmin, checkCsrf, (req,res) => {
  try { const result=drainStatusNode(req.params.id); flash(req,'ok',l(req,`Node wird gedraint. ${result.released} Bots wurden zur Neuverteilung freigegeben.`,`Node is draining. ${result.released} bots were released for redistribution.`)); }
  catch(e){flash(req,'err',e.message);} res.redirect('/admin?tab=nodes#nodes');
});

app.get('/nodes/:id/details', requireAdmin, (req,res) => {
  const lang=langOf(req); const node=getStatusNode(req.params.id); if(!node)return res.status(404).send('Not found'); const db=readDb();
  const assigned=db.servers.filter((s)=>s.assignedNodeId===node.id); const targets=db.statusNodes.filter((n)=>n.id!==node.id && nodeIsHealthy(n));
  const targetOptions=targets.map((n)=>`<option value="${esc(n.id)}">${esc(n.name||n.id)} · ${db.servers.filter((s)=>s.assignedNodeId===n.id).length}/${esc(n.capacity||0)}</option>`).join('');
  const rows=assigned.map((s)=>{const owner=db.users.find((u)=>u.discordId===s.ownerDiscordId);return `<tr><td><strong>${esc(s.name)}</strong><div class="muted small">${esc(owner?.globalName||owner?.username||s.ownerDiscordId||'')}</div></td><td>${esc(s.gameType==='gamedig'?(gameDigMeta(s.queryConfig?.gameId)?.name||s.queryConfig?.gameId):gameTypeLabel(s.gameType))}</td><td><form method="post" action="/servers/${esc(s.id)}/move-node" class="moveform"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><select name="targetNodeId" required><option value="">${tr(lang,'Ziel auswählen','Select target')}</option>${targetOptions}</select><button class="button ghost smallbtn">${tr(lang,'Verschieben','Move')}</button></form></td></tr>`;}).join('');
  render(req,res,`${node.name||node.id} · ${tr(lang,'Bots','Bots')}`,`<div class="pagehead"><div><h1>${esc(node.name||node.id)}</h1><p>${assigned.length} ${tr(lang,'zugewiesene Status-Bots','assigned status bots')}</p></div><a class="button ghost" href="/nodes">${tr(lang,'Zurück','Back')}</a></div><div class="panel node-actions"><form method="post" action="/nodes/${esc(node.id)}/move-all" class="actions wrap"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><select name="targetNodeId" required><option value="">${tr(lang,'Alle Bots auf Node verschieben …','Move all bots to node …')}</option>${targetOptions}</select><button class="button primary">${tr(lang,'Alle verschieben','Move all')}</button></form></div><div class="panel tablewrap"><table><thead><tr><th>Bot</th><th>Game</th><th>${tr(lang,'Aktion','Action')}</th></tr></thead><tbody>${rows||`<tr><td colspan="3">${tr(lang,'Keine Bots auf diesem Node.','No bots on this node.')}</td></tr>`}</tbody></table></div>`);
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
  upsertUser({discordId:old.discordId,role:protectedAdmin?'admin':(req.body.role==='admin'?'admin':'user'),planId,planExpiresAt,statusBotLimitOverride,customBotLimit:Math.min(50,Math.max(0,Number(req.body.customBotLimit)||0)),premiumSource:null}); rebalanceAssignments(); flash(req,'ok',l(req,'Benutzerplan und Freigaben gespeichert.','User plan and permissions saved.')); res.redirect('/admin?tab=users#users');
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
  const defaults={2:50,3:100,4:250,5:500};
  const values=[2,3,4,5].map((limit)=>({limit,members:Math.max(1,Number(req.body[`tier${limit}`])||defaults[limit])})).sort((a,b)=>a.members-b.members);
  const teamDiscordIds=String(req.body.teamDiscordIds||'').split(',').map((x)=>x.trim()).filter((x)=>validSnowflake(x)).slice(0,25);
  const currency=/^[A-Za-z]{3}$/.test(String(req.body.paypalCurrency||''))?String(req.body.paypalCurrency).toUpperCase():'EUR';
  const oldAuto=paypalAutoConfig(current); const oldApi=current.premiumSales?.paypalApi||{};
  const mode=String(req.body.paypalMode||oldApi.mode||'sandbox').toLowerCase()==='live'?'live':'sandbox';
  let clientId=String(req.body.paypalClientId??oldApi.clientId??'').trim().slice(0,300);
  let clientSecretEnc=String(oldApi.clientSecretEnc||'');
  const newSecret=String(req.body.paypalClientSecret||'').trim(); const clearCredentials=req.body.paypalClearCredentials==='1';
  if(clearCredentials){clientId='';clientSecretEnc='';}
  else if(newSecret) clientSecretEnc=encryptSecret(newSecret.slice(0,500));
  const credentialsChanged=clearCredentials||Boolean(newSecret)||mode!==String(oldApi.mode||'sandbox')||clientId!==String(oldApi.clientId||'');
  const updated=updateSiteSettings({serviceDomain:cleanDomain,supportUrl:String(req.body.supportUrl||'').trim().slice(0,500),teamDiscordIds,donationLinks:{paypal:String(req.body.paypal||'').trim().slice(0,500),kofi:String(req.body.kofi||'').trim().slice(0,500),stripe:String(req.body.stripe||'').trim().slice(0,500),customUrl:String(req.body.customUrl||'').trim().slice(0,500),customLabel:String(req.body.customLabel||'').trim().slice(0,80)},premiumSales:{paypalUrl:String(req.body.premiumPaypalUrl||'').trim().slice(0,500),discordUserId:validSnowflake(req.body.salesDiscordUserId)?String(req.body.salesDiscordUserId).trim():'',discordUsername:String(req.body.salesDiscordUsername||'').trim().slice(0,80),prices:{premium5:String(req.body.pricePremium5||'').trim().slice(0,60),premium10:String(req.body.pricePremium10||'').trim().slice(0,60),premium15:String(req.body.pricePremium15||'').trim().slice(0,60),premium20:String(req.body.pricePremium20||'').trim().slice(0,60)},paypalApi:{mode,clientId,clientSecretEnc},paypalAuto:{enabled:req.body.paypalAutoEnabled==='1',currency,accessDays:Math.max(1,Math.min(3650,Number(req.body.paypalAccessDays)||30)),webhookId:credentialsChanged?'':(oldAuto.webhookId||''),amounts:{premium5:normalizedMoney(req.body.paypalAmountPremium5),premium10:normalizedMoney(req.body.paypalAmountPremium10),premium15:normalizedMoney(req.body.paypalAmountPremium15),premium20:normalizedMoney(req.body.paypalAmountPremium20)}}},freeBoost:{categoryName:String(req.body.categoryName||'Powered by status-hub.lol').trim().slice(0,100),verifyHours:Math.max(1,Math.min(48,Number(req.body.verifyHours)||6)),tiers:values}});
  recalculateStoredFreeBoostLimits(updated);
  rebalanceAssignments();
  return updated;
}

app.post('/admin/settings', requireAdmin, checkCsrf, (req,res) => {
  saveAdminSettingsFromBody(req);
  flash(req,'ok',l(req,'Einstellungen gespeichert.','Settings saved.'));
  res.redirect('/admin?tab=settings#settings');
});

app.post('/admin/paypal/setup', requireAdmin, checkCsrf, rateLimit({ windowMs: 60_000, limit: 5 }), async (req,res) => {
  try {
    const settings=saveAdminSettingsFromBody(req);
    if (!paypalConfigured(settings)) throw new Error(l(req,'PayPal Client ID oder Client Secret fehlen in den Admin-Einstellungen.','PayPal Client ID or Client Secret is missing in the admin settings.'));
    const auto=paypalAutoConfig(settings);
    const webhook=await ensureWebhook(auto.webhookId,`${baseUrl}/webhooks/paypal`,settings);
    updateSiteSettings({premiumSales:{paypalAuto:{enabled:true,webhookId:webhook.id}}});
    flash(req,'ok',l(req,`PayPal ${paypalEnvironment(settings)} verbunden. Einstellungen gespeichert und Webhook aktiviert.`,`PayPal ${paypalEnvironment(settings)} connected. Settings saved and webhook activated.`));
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
  try { rebalanceAssignments(); } catch (e) { console.error('Status-Node-Zuweisung:',e); }
  setTimeout(async () => {
    for (const b of readDb().customBots.filter((x)=>x.approvalState==='approved' && x.enabled)) {
      try { await ensureCustomBot(b); } catch (e) { console.error(`Custom Bot ${b.id}:`, e.message); }
    }
  }, 3000).unref();
  setInterval(() => { try { rebalanceAssignments(); } catch (e) { console.error('Status-Node-Rebalance:', e.message); } }, 10_000).unref();
  setTimeout(() => { refreshDueFreeBoosts().then(()=>rebalanceAssignments()).catch(()=>{}); }, 5000).unref();
  setInterval(() => { refreshDueFreeBoosts().then(()=>rebalanceAssignments()).catch(()=>{}); }, 15 * 60_000).unref();
});
async function shutdown(signal){console.log(`\n${signal}: fahre herunter...`);httpServer.close(()=>process.exit(0));setTimeout(()=>process.exit(1),5000).unref();}
process.on('SIGINT',()=>shutdown('SIGINT')); process.on('SIGTERM',()=>shutdown('SIGTERM'));
