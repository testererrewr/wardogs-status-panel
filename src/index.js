import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import multer from 'multer';
import { rateLimit } from 'express-rate-limit';
import {
  readDb, findUser, upsertUser, deleteUser, getServer, listServersFor, upsertServer, deleteServer,
  getCustomBot, listCustomBotsFor, upsertCustomBot, deleteCustomBot, assignLegacyOwnership
} from './db.js';
import { encryptSecret } from './crypto.js';
import { startServerBot, stopServerBot, syncBots, getRuntime, shutdownBots } from './bot-manager.js';
import { fetchServerStatus, gameTypeLabel } from './server-query.js';
import { esc, layout, serverForm, customBotForm } from './html.js';
import { FileSessionStore } from './file-session-store.js';
import { prepareCustomBot, parseEnvText, deleteCustomBotFiles } from './custom-bots.js';
import { ensureCustomBot, restartCustomBot, stopCustomBot, deleteCustomBotRuntime, customBotStatus, customBotLogs } from './runner-client.js';

const required = ['SESSION_SECRET', 'APP_ENCRYPTION_KEY', 'DISCORD_OAUTH_CLIENT_ID', 'DISCORD_OAUTH_CLIENT_SECRET'];
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
const defaultStatusLimit = Math.max(0, Number(process.env.DEFAULT_STATUS_BOT_LIMIT || 1));
const uploadMaxMb = Math.min(25, Math.max(1, Number(process.env.CUSTOM_UPLOAD_MAX_MB || 5)));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: uploadMaxMb * 1024 * 1024, files: 1 } });

assignLegacyOwnership(firstAdmin);

if (process.env.TRUST_PROXY !== 'false') app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.urlencoded({ extended: false, limit: '128kb' }));
app.use(express.static('public', { maxAge: '1h' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 600, standardHeaders: 'draft-8', legacyHeaders: false }));
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
function render(req, res, title, body) { res.send(layout({ title, body, user: currentUser(req), csrf: csrf(req), flash: takeFlash(req) })); }
function requireLogin(req, res, next) { if (!currentUser(req)) return res.redirect('/login'); next(); }
function requireAdmin(req, res, next) { const u = currentUser(req); if (!u) return res.redirect('/login'); if (u.role !== 'admin') return res.status(403).send('Keine Berechtigung'); next(); }
function validSnowflake(value) { return /^\d{17,20}$/.test(String(value || '').trim()); }
function isAdmin(req) { return currentUser(req)?.role === 'admin'; }
function statusLimit(user) { return user?.role === 'admin' ? Infinity : Math.max(0, Number(user?.statusBotLimit ?? defaultStatusLimit)); }
function customLimit(user) { return user?.role === 'admin' ? Infinity : Math.max(0, Number(user?.customBotLimit || 0)); }

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

function parseTemplates(value) {
  return String(value || '{players}/{max} Spieler online\nMap: {map}').split(/\r?\n/).map((x) => x.trim().slice(0, 128)).filter(Boolean).slice(0, 10);
}
function buildQuery(req, old = null) {
  const gameType = ['wardogs','fivem','gamedig','generic_json'].includes(req.body.gameType) ? req.body.gameType : 'fivem';
  let queryConfig = {};
  let newSecret = null;
  let clearSecret = false;
  if (gameType === 'wardogs') {
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
    const host = String(req.body.queryHost || '').trim(); const gameId = String(req.body.gameId || '').trim();
    if (!host || !gameId) throw new Error('GameDig Host und Game-ID fehlen');
    const p = req.body.queryPort ? Number(req.body.queryPort) : null;
    if (p && (p < 1 || p > 65535)) throw new Error('Ungültiger Port');
    queryConfig = { host, gameId, port: p || null };
    clearSecret = true;
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

app.get('/login', (req, res) => {
  if (currentUser(req)) return res.redirect('/');
  render(req, res, 'Login', `<section class="loginbox panel"><h1>Server Status Hub</h1><p>Mit Discord anmelden oder kostenlos registrieren.</p><a class="button discord" href="/auth/discord">Mit Discord fortfahren</a><p class="muted small">Neue Accounts erhalten standardmäßig ${defaultStatusLimit} kostenlosen Status-Bot. Kein Passwort-Login.</p></section>`);
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
      statusBotLimit: user?.statusBotLimit ?? defaultStatusLimit,
      customBotLimit: user?.customBotLimit ?? 0,
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

app.get('/', requireLogin, (req, res) => {
  const u = currentUser(req); const servers = listServersFor(u.discordId, u.role === 'admin');
  const ownCount = readDb().servers.filter((s) => s.ownerDiscordId === u.discordId).length;
  const limit = statusLimit(u);
  const cards = servers.map((s) => {
    const r = getRuntime(s.id); const state = r.state || 'stopped';
    const statusText = state === 'online' ? `${r.players}/${r.maxPlayers} Spieler` : state === 'offline' ? 'Gameserver offline' : state === 'error' ? 'Bot-Fehler' : state;
    const invite = (r.botId || s.botId) ? `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(r.botId || s.botId)}&scope=bot&permissions=0` : null;
    const owner = s.ownerDiscordId ? findUser(s.ownerDiscordId) : null;
    return `<article class="servercard panel"><div class="row between"><div><h2>${esc(s.name)}</h2><div class="chips"><span class="badge ${esc(state)}">${esc(statusText)}</span><span class="badge neutral">${esc(gameTypeLabel(s.gameType))}</span></div></div><div class="dot ${esc(state)}"></div></div>
      ${u.role === 'admin' ? `<p class="muted small">Owner: ${esc(owner?.globalName || owner?.username || s.ownerDiscordId || 'Legacy')}</p>` : ''}
      <dl><div><dt>Bot</dt><dd>${esc(r.botTag || 'noch nicht verbunden')}</dd></div><div><dt>Presence</dt><dd>${esc(r.presence || '—')}</dd></div><div><dt>Map</dt><dd>${esc(r.map || '—')}</dd></div><div><dt>Ping</dt><dd>${esc(r.ping == null ? '—' : `${r.ping} ms`)}</dd></div></dl>
      ${r.lastError ? `<div class="errorbox">${esc(r.lastError)}</div>` : ''}<div class="actions wrap">
      ${invite ? `<a class="button ghost" href="${invite}" target="_blank" rel="noopener">Bot einladen</a>` : ''}<a class="button ghost" href="/servers/${esc(s.id)}/edit">Bearbeiten</a>
      <form method="post" action="/servers/${esc(s.id)}/test" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button ghost">Status testen</button></form>
      <form method="post" action="/servers/${esc(s.id)}/restart" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button ghost">Neu starten</button></form>
      <form method="post" action="/servers/${esc(s.id)}/delete" class="inline" onsubmit="return confirm('Status Bot wirklich löschen?')"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button danger">Löschen</button></form></div></article>`;
  }).join('');
  const canAdd = ownCount < limit;
  const quota = u.role === 'admin' ? 'Admin: unbegrenzt' : `${ownCount}/${limit} Status-Bots verwendet`;
  const body = `<div class="pagehead"><div><h1>Status Bots</h1><p>${esc(quota)} · WARDOGS, FiveM, GameDig und JSON</p></div>${canAdd ? '<a class="button primary" href="/servers/new">+ Status Bot</a>' : '<span class="badge neutral">Limit erreicht</span>'}</div><section class="grid">${cards || '<div class="empty panel">Noch keine Status Bots angelegt.</div>'}</section>`;
  render(req, res, 'Status Bots', body);
});

app.get('/servers/new', requireLogin, (req, res) => {
  const u = currentUser(req); const count = readDb().servers.filter((s) => s.ownerDiscordId === u.discordId).length;
  if (count >= statusLimit(u)) return res.status(403).send('Dein Status-Bot-Limit ist erreicht. Ein Admin kann dein Limit erhöhen.');
  render(req, res, 'Status Bot erstellen', `<div class="pagehead"><div><h1>Status Bot erstellen</h1><p>Ein Discord Bot Account pro Serverstatus.</p></div></div>${serverForm({ csrf: csrf(req), isAdmin: u.role === 'admin' })}`);
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
      onlineTemplates: parseTemplates(req.body.onlineTemplates), offlineTemplate: String(req.body.offlineTemplate || 'Server offline').slice(0, 128), enabled: req.body.enabled === '1'
    });
    await startServerBot(entry); flash(req, 'ok', `Status Bot „${entry.name}“ wurde erstellt.`); res.redirect('/');
  } catch (error) { flash(req, 'err', error.message); res.redirect('/servers/new'); }
});

app.get('/servers/:id/edit', requireLogin, (req, res) => {
  const server = ownedServer(req, req.params.id); if (!server) return res.status(404).send('Server nicht gefunden');
  render(req, res, 'Status Bot bearbeiten', `<div class="pagehead"><div><h1>${esc(server.name)}</h1><p>Leere Secret-Felder behalten vorhandene Werte.</p></div></div>${serverForm({ server, csrf: csrf(req), isEdit: true, isAdmin: isAdmin(req) })}`);
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
      onlineTemplates: parseTemplates(req.body.onlineTemplates), offlineTemplate: String(req.body.offlineTemplate || 'Server offline').slice(0, 128), enabled: req.body.enabled === '1'
    };
    if (req.body.botToken) { const bot = await validateBotToken(String(req.body.botToken).trim()); if (readDb().servers.some((x) => x.id !== old.id && x.botId === bot.id)) throw new Error('Dieser Discord Bot wird bereits von einem anderen Status-Eintrag verwendet'); patch.botTokenEnc = encryptSecret(String(req.body.botToken).trim()); patch.botId = bot.id; }
    if (q.newSecret) patch.querySecretEnc = encryptSecret(q.newSecret);
    else if (q.clearSecret) patch.querySecretEnc = null;
    const entry = upsertServer(patch); await startServerBot(entry); flash(req, 'ok', 'Gespeichert und Bot neu gestartet.'); res.redirect('/');
  } catch (error) { flash(req, 'err', error.message); res.redirect(`/servers/${encodeURIComponent(req.params.id)}/edit`); }
});

app.post('/servers/:id/test', requireLogin, checkCsrf, async (req, res) => {
  try { const server = ownedServer(req, req.params.id); if (!server) return res.status(404).send('Nicht gefunden'); const s = await fetchServerStatus(server); flash(req, 'ok', `Status OK: ${s.current}/${s.max} Spieler${s.map ? ` · Map: ${s.map}` : ''}`); }
  catch (error) { flash(req, 'err', `Status-Test fehlgeschlagen: ${error.message}`); }
  res.redirect('/');
});
app.post('/servers/:id/restart', requireLogin, checkCsrf, async (req, res) => { const s = ownedServer(req, req.params.id); if (!s) return res.status(404).send('Nicht gefunden'); await startServerBot(s); flash(req,'ok','Bot-Neustart ausgelöst.'); res.redirect('/'); });
app.post('/servers/:id/delete', requireLogin, checkCsrf, async (req, res) => { const s = ownedServer(req, req.params.id); if (!s) return res.status(404).send('Nicht gefunden'); await stopServerBot(s.id); deleteServer(s.id); flash(req,'ok','Status Bot gelöscht.'); res.redirect('/'); });

app.get('/custom-bots', requireLogin, async (req, res) => {
  const u = currentUser(req); const bots = listCustomBotsFor(u.discordId, u.role === 'admin');
  const ownCount = readDb().customBots.filter((b) => b.ownerDiscordId === u.discordId).length; const limit = customLimit(u);
  const rows = await Promise.all(bots.map(async (b) => {
    let rt = { running: false, exists: false }; try { rt = await customBotStatus(b); } catch {}
    const owner = findUser(b.ownerDiscordId);
    return `<article class="servercard panel"><div class="row between"><div><h2>${esc(b.name)}</h2><div class="chips"><span class="badge ${b.approvalState === 'approved' ? 'online' : b.approvalState === 'rejected' ? 'error' : 'neutral'}">${esc(b.approvalState || 'pending')}</span><span class="badge ${rt.running ? 'online' : 'neutral'}">${rt.running ? 'läuft' : 'gestoppt'}</span></div></div></div>
    <p class="muted small">${esc(b.runtime)} · ${esc(b.entrypoint)}${u.role === 'admin' ? ` · Owner: ${esc(owner?.globalName || owner?.username || b.ownerDiscordId)}` : ''}</p>
    ${b.reviewNote ? `<div class="help">Admin: ${esc(b.reviewNote)}</div>` : ''}
    <div class="actions wrap"><a class="button ghost" href="/custom-bots/${esc(b.id)}/source">Source ZIP</a><a class="button ghost" href="/custom-bots/${esc(b.id)}/logs">Logs</a>
    ${b.approvalState === 'approved' ? `<form method="post" action="/custom-bots/${esc(b.id)}/start" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button ghost">Start/Neu bauen</button></form><form method="post" action="/custom-bots/${esc(b.id)}/stop" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button ghost">Stop</button></form>` : ''}
    ${u.role === 'admin' && b.approvalState !== 'approved' ? `<form method="post" action="/custom-bots/${esc(b.id)}/approve" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button primary">Freigeben</button></form>` : ''}
    ${u.role === 'admin' && b.approvalState === 'approved' ? `<form method="post" action="/custom-bots/${esc(b.id)}/revoke" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button danger">Freigabe entziehen</button></form>` : ''}
    <form method="post" action="/custom-bots/${esc(b.id)}/delete" class="inline" onsubmit="return confirm('Custom Bot löschen?')"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button danger">Löschen</button></form></div></article>`;
  }));
  const canUpload = ownCount < limit;
  const quota = u.role === 'admin' ? 'Admin: unbegrenzt' : limit > 0 ? `${ownCount}/${limit} Upload-Slots` : 'Custom-Bot-Uploads nicht freigeschaltet';
  render(req, res, 'Custom Bots', `<div class="pagehead"><div><h1>Custom Bots</h1><p>${esc(quota)} · Node.js/Python Uploads laufen isoliert</p></div>${canUpload ? '<a class="button primary" href="/custom-bots/new">+ Bot hochladen</a>' : ''}</div>${limit === 0 && u.role !== 'admin' ? '<div class="panel warning">Ein Admin muss deinen Account zuerst für Custom-Bot-Uploads freischalten.</div>' : ''}<section class="grid">${rows.join('') || '<div class="empty panel">Keine Custom Bots.</div>'}</section>`);
});

app.get('/custom-bots/new', requireLogin, (req, res) => {
  const u = currentUser(req); const count = readDb().customBots.filter((b) => b.ownerDiscordId === u.discordId).length;
  if (count >= customLimit(u)) return res.status(403).send('Keine freien Custom-Bot-Slots.');
  render(req, res, 'Custom Bot hochladen', `<div class="pagehead"><div><h1>Custom Bot hochladen</h1><p>ZIP mit Sourcecode; jeder Upload benötigt Admin-Freigabe.</p></div></div>${customBotForm({ csrf: csrf(req) })}`);
});

app.post('/custom-bots/new', requireLogin, upload.single('archive'), checkCsrf, async (req, res) => {
  try {
    const u = currentUser(req); const count = readDb().customBots.filter((b) => b.ownerDiscordId === u.discordId).length;
    if (count >= customLimit(u)) throw new Error('Keine freien Custom-Bot-Slots');
    if (!req.file) throw new Error('ZIP-Datei fehlt');
    const name = String(req.body.name || '').trim(); if (!name) throw new Error('Name fehlt');
    const runtime = String(req.body.runtime || 'node22'); const prep = prepareCustomBot({ buffer: req.file.buffer, runtime, entrypoint: req.body.entrypoint });
    const env = parseEnvText(req.body.envText); const adminUpload = u.role === 'admin';
    const bot = upsertCustomBot({ id: prep.id, ownerDiscordId: u.discordId, name, runtime: prep.runtime, entrypoint: prep.entrypoint, envEnc: encryptSecret(JSON.stringify(env)), approvalState: adminUpload ? 'approved' : 'pending', enabled: adminUpload, fileCount: prep.fileCount, unpackedBytes: prep.unpackedBytes, reviewNote: '' });
    if (adminUpload) await ensureCustomBot(bot);
    flash(req, 'ok', adminUpload ? 'Custom Bot hochgeladen und gestartet.' : 'Upload gespeichert. Ein Admin muss ihn vor dem Start freigeben.'); res.redirect('/custom-bots');
  } catch (error) { flash(req, 'err', error.message); res.redirect('/custom-bots/new'); }
});

app.post('/custom-bots/:id/approve', requireAdmin, checkCsrf, async (req, res) => {
  try { const b = getCustomBot(req.params.id); if (!b) return res.status(404).send('Nicht gefunden'); const bot = upsertCustomBot({ id: b.id, approvalState: 'approved', enabled: true, reviewNote: 'Von Admin freigegeben' }); await ensureCustomBot(bot); flash(req,'ok','Custom Bot freigegeben und gestartet.'); }
  catch (e) { flash(req,'err',e.message); } res.redirect('/custom-bots');
});
app.post('/custom-bots/:id/revoke', requireAdmin, checkCsrf, async (req, res) => { const b=getCustomBot(req.params.id); if(!b)return res.status(404).send('Nicht gefunden'); await stopCustomBot(b).catch(()=>{}); upsertCustomBot({id:b.id,approvalState:'rejected',enabled:false,reviewNote:'Freigabe entzogen'}); flash(req,'ok','Freigabe entzogen.'); res.redirect('/custom-bots'); });
app.post('/custom-bots/:id/start', requireLogin, checkCsrf, async (req, res) => { try { const b=ownedCustom(req,req.params.id); if(!b)return res.status(404).send('Nicht gefunden'); if(b.approvalState!=='approved')throw new Error('Bot ist nicht freigegeben'); const bot=upsertCustomBot({id:b.id,enabled:true}); await restartCustomBot(bot); flash(req,'ok','Custom Bot neu gebaut und gestartet.'); } catch(e){flash(req,'err',e.message);} res.redirect('/custom-bots'); });
app.post('/custom-bots/:id/stop', requireLogin, checkCsrf, async (req, res) => { const b=ownedCustom(req,req.params.id); if(!b)return res.status(404).send('Nicht gefunden'); await stopCustomBot(b).catch(()=>{}); upsertCustomBot({id:b.id,enabled:false}); flash(req,'ok','Custom Bot gestoppt.'); res.redirect('/custom-bots'); });
app.get('/custom-bots/:id/source', requireLogin, (req, res) => { const b=ownedCustom(req,req.params.id); if(!b)return res.status(404).send('Nicht gefunden'); const file=`custom-bots/${b.id}/source.zip`; res.download(file, `${String(b.name||'custom-bot').replace(/[^A-Za-z0-9._-]+/g,'_')}.zip`); });
app.get('/custom-bots/:id/logs', requireLogin, async (req, res) => { const b=ownedCustom(req,req.params.id); if(!b)return res.status(404).send('Nicht gefunden'); let logs=''; try{logs=(await customBotLogs(b)).logs||'';}catch(e){logs=`Logs nicht verfügbar: ${e.message}`;} render(req,res,'Custom Bot Logs',`<div class="pagehead"><div><h1>${esc(b.name)} · Logs</h1></div><a class="button ghost" href="/custom-bots">Zurück</a></div><pre class="panel logbox">${esc(logs)}</pre>`); });
app.post('/custom-bots/:id/delete', requireLogin, checkCsrf, async (req, res) => { const b=ownedCustom(req,req.params.id); if(!b)return res.status(404).send('Nicht gefunden'); await deleteCustomBotRuntime(b).catch(()=>{}); deleteCustomBotFiles(b.id); deleteCustomBot(b.id); flash(req,'ok','Custom Bot gelöscht.'); res.redirect('/custom-bots'); });

app.get('/users', requireAdmin, (req, res) => {
  const db = readDb();
  const rows = db.users.map((u) => {
    const serverCount = db.servers.filter((s) => s.ownerDiscordId === u.discordId).length; const customCount = db.customBots.filter((b) => b.ownerDiscordId === u.discordId).length;
    return `<tr><td><strong>${esc(u.globalName || u.username || u.discordId)}</strong><div class="muted small">${esc(u.discordId)}</div></td><td>${esc(u.role)}</td><td>${serverCount}/${esc(u.statusBotLimit)}</td><td>${customCount}/${esc(u.customBotLimit)}</td><td><form method="post" action="/users/${esc(u.discordId)}" class="userform"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><select name="role"><option value="user" ${u.role==='user'?'selected':''}>user</option><option value="admin" ${u.role==='admin'?'selected':''}>admin</option></select><input name="statusBotLimit" type="number" min="0" max="100" value="${esc(u.statusBotLimit ?? 1)}" title="Status Bot Limit"><input name="customBotLimit" type="number" min="0" max="20" value="${esc(u.customBotLimit ?? 0)}" title="Custom Bot Limit"><button class="button ghost smallbtn">Speichern</button></form></td><td>${bootstrapAdmins.has(u.discordId)?'<span class="muted">.env Admin</span>':`<form method="post" action="/users/${esc(u.discordId)}/delete" onsubmit="return confirm('User aus Panel entfernen? Seine Bots bleiben dem Account zugeordnet.')"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button danger smallbtn">Entfernen</button></form>`}</td></tr>`;
  }).join('');
  render(req,res,'Benutzer',`<div class="pagehead"><div><h1>Benutzer & Limits</h1><p>Registrierung erfolgt automatisch beim ersten Discord-Login. Standard: ${defaultStatusLimit} Status Bot, 0 Custom Bots.</p></div></div><div class="panel tablewrap"><table><thead><tr><th>User</th><th>Rolle</th><th>Status Bots</th><th>Custom Bots</th><th>Freigaben/Limits</th><th></th></tr></thead><tbody>${rows||'<tr><td colspan="6">Keine User</td></tr>'}</tbody></table></div>`);
});
app.post('/users/:id', requireAdmin, checkCsrf, (req,res) => { const old=findUser(req.params.id); if(!old)return res.status(404).send('Nicht gefunden'); const protectedAdmin=bootstrapAdmins.has(old.discordId); upsertUser({discordId:old.discordId,role:protectedAdmin?'admin':(req.body.role==='admin'?'admin':'user'),statusBotLimit:Math.min(100,Math.max(0,Number(req.body.statusBotLimit)||0)),customBotLimit:Math.min(20,Math.max(0,Number(req.body.customBotLimit)||0))}); flash(req,'ok','Benutzerlimits gespeichert.'); res.redirect('/users'); });
app.post('/users/:id/delete', requireAdmin, checkCsrf, (req,res) => { if(bootstrapAdmins.has(req.params.id)){flash(req,'err','.env Admin kann nicht entfernt werden.');return res.redirect('/users');} if(req.params.id===currentUser(req).discordId){flash(req,'err','Eigenen Account nicht entfernen.');return res.redirect('/users');} deleteUser(req.params.id); flash(req,'ok','Benutzer entfernt.'); res.redirect('/users'); });

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) { flash(req,'err',`Upload fehlgeschlagen: ${err.message}`); return res.redirect('/custom-bots/new'); }
  console.error(err); res.status(500).send('Interner Fehler');
});
app.use((req,res)=>res.status(404).send('Nicht gefunden'));

const httpServer = app.listen(port, async () => {
  console.log(`Server Status Hub: ${baseUrl}`); console.log(`Discord OAuth Redirect URI: ${redirectUri}`);
  try { await syncBots(readDb().servers); } catch (e) { console.error('Status-Bot-Sync Fehler:',e); }
  setTimeout(async () => {
    for (const b of readDb().customBots.filter((x)=>x.approvalState==='approved' && x.enabled)) {
      try { await ensureCustomBot(b); } catch (e) { console.error(`Custom Bot ${b.id}:`, e.message); }
    }
  }, 3000).unref();
});
async function shutdown(signal){console.log(`\n${signal}: fahre herunter...`);await shutdownBots();httpServer.close(()=>process.exit(0));setTimeout(()=>process.exit(1),5000).unref();}
process.on('SIGINT',()=>shutdown('SIGINT')); process.on('SIGTERM',()=>shutdown('SIGTERM'));
