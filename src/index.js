import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { readDb, findUser, upsertUser, deleteUser, getServer, upsertServer, deleteServer } from './db.js';
import { encryptSecret, decryptSecret } from './crypto.js';
import { startServerBot, stopServerBot, syncBots, getRuntime, shutdownBots } from './bot-manager.js';
import { fetchWardogsStatus } from './wardogs.js';
import { esc, layout, serverForm } from './html.js';
import { FileSessionStore } from './file-session-store.js';

const required = ['SESSION_SECRET', 'APP_ENCRYPTION_KEY', 'DISCORD_OAUTH_CLIENT_ID', 'DISCORD_OAUTH_CLIENT_SECRET'];
for (const key of required) if (!process.env[key]) throw new Error(`${key} fehlt in .env`);

const app = express();
const port = Number(process.env.PORT || 3000);
const baseUrl = String(process.env.PUBLIC_URL || process.env.BASE_URL || '').replace(/\/+$/, '');
if (!baseUrl) throw new Error('PUBLIC_URL fehlt in .env');
if (!/^https?:\/\//i.test(baseUrl)) throw new Error('PUBLIC_URL muss mit http:// oder https:// beginnen');
const redirectUri = `${baseUrl}/auth/discord/callback`;
const secureCookie = process.env.COOKIE_SECURE === 'true' || baseUrl.startsWith('https://');
const bootstrapAdmins = new Set((process.env.ADMIN_DISCORD_IDS || '').split(',').map((x) => x.trim()).filter(Boolean));

if (process.env.TRUST_PROXY !== 'false') app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use(express.static('public', { maxAge: '1h' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 400, standardHeaders: 'draft-8', legacyHeaders: false }));
app.use(session({
  store: new FileSessionStore({ file: 'data/sessions.json' }),
  name: 'wardogs.sid',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: secureCookie, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

function csrf(req) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('base64url');
  return req.session.csrf;
}
function checkCsrf(req, res, next) {
  const a = Buffer.from(String(req.body?._csrf || ''));
  const b = Buffer.from(String(req.session.csrf || ''));
  if (!a.length || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(403).send('Ungültiges CSRF-Token. Seite neu laden.');
  next();
}
function flash(req, type, message) { req.session.flash = { type, message }; }
function takeFlash(req) { const f = req.session.flash; delete req.session.flash; return f; }
function currentUser(req) { return req.session.user || null; }
function render(req, res, title, body) { res.send(layout({ title, body, user: currentUser(req), csrf: csrf(req), flash: takeFlash(req) })); }
function requireLogin(req, res, next) { if (!currentUser(req)) return res.redirect('/login'); next(); }
function requireAdmin(req, res, next) { if (!currentUser(req)) return res.redirect('/login'); if (currentUser(req).role !== 'admin') return res.status(403).send('Keine Berechtigung'); next(); }
function validSnowflake(value) { return /^\d{17,20}$/.test(String(value || '').trim()); }

async function discordApi(path, options = {}) {
  const response = await fetch(`https://discord.com/api/v10${path}`, options);
  if (!response.ok) throw new Error(`Discord API ${response.status}: ${(await response.text()).slice(0, 250)}`);
  return response.json();
}

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.get('/login', (req, res) => {
  if (currentUser(req)) return res.redirect('/');
  render(req, res, 'Login', `<section class="loginbox panel"><h1>WARDOGS Status Panel</h1><p>Login ausschließlich über Discord.</p><a class="button discord" href="/auth/discord">Mit Discord anmelden</a><p class="muted small">Nur freigeschaltete Discord-User erhalten Zugriff.</p></section>`);
});

app.get('/auth/discord', rateLimit({ windowMs: 60_000, limit: 20 }), (req, res) => {
  const state = crypto.randomBytes(24).toString('base64url');
  req.session.oauthState = state;
  const params = new URLSearchParams({ client_id: process.env.DISCORD_OAUTH_CLIENT_ID, response_type: 'code', redirect_uri: redirectUri, scope: 'identify', state });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

app.get('/auth/discord/callback', rateLimit({ windowMs: 60_000, limit: 30 }), async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state || state !== req.session.oauthState) throw new Error('OAuth state ungültig');
    delete req.session.oauthState;

    const form = new URLSearchParams({
      client_id: process.env.DISCORD_OAUTH_CLIENT_ID,
      client_secret: process.env.DISCORD_OAUTH_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code: String(code),
      redirect_uri: redirectUri
    });
    const tokenResponse = await fetch('https://discord.com/api/v10/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
    if (!tokenResponse.ok) throw new Error(`OAuth Token Exchange fehlgeschlagen (${tokenResponse.status})`);
    const token = await tokenResponse.json();
    const profile = await discordApi('/users/@me', { headers: { Authorization: `Bearer ${token.access_token}` } });

    let allowed = findUser(profile.id);
    if (bootstrapAdmins.has(profile.id)) {
      allowed = upsertUser({ ...(allowed || {}), discordId: profile.id, role: 'admin', username: profile.username, globalName: profile.global_name || '', avatar: profile.avatar || '', lastLoginAt: new Date().toISOString() });
    }
    if (!allowed) return res.status(403).send('Dieser Discord-Account ist für das Panel nicht freigeschaltet.');

    allowed = upsertUser({ ...allowed, username: profile.username, globalName: profile.global_name || '', avatar: profile.avatar || '', lastLoginAt: new Date().toISOString() });
    const avatarUrl = profile.avatar ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png?size=64` : '';
    req.session.regenerate((err) => {
      if (err) return res.status(500).send('Session-Fehler');
      req.session.user = { discordId: allowed.discordId, role: allowed.role, username: allowed.username, globalName: allowed.globalName, avatarUrl };
      req.session.csrf = crypto.randomBytes(24).toString('base64url');
      res.redirect('/');
    });
  } catch (error) {
    res.status(500).send(`Discord Login fehlgeschlagen: ${esc(error.message)}`);
  }
});

app.post('/logout', requireLogin, checkCsrf, (req, res) => req.session.destroy(() => res.redirect('/login')));

app.get('/', requireLogin, (req, res) => {
  const db = readDb();
  const cards = db.servers.map((s) => {
    const r = getRuntime(s.id);
    const state = r.state || 'stopped';
    const statusText = state === 'online' ? `${r.players}/${r.maxPlayers} Spieler` : state === 'offline' ? 'Gameserver offline' : state === 'error' ? 'Bot-Fehler' : state;
    const invite = r.botId ? `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(r.botId)}&scope=bot&permissions=0` : null;
    return `<article class="servercard panel">
      <div class="row between"><div><h2>${esc(s.name)}</h2><span class="badge ${esc(state)}">${esc(statusText)}</span></div><div class="dot ${esc(state)}"></div></div>
      <dl><div><dt>Bot</dt><dd>${esc(r.botTag || 'noch nicht verbunden')}</dd></div><div><dt>Presence</dt><dd>${esc(r.presence || '—')}</dd></div><div><dt>Map</dt><dd>${esc(r.map || '—')}</dd></div><div><dt>Letzter Check</dt><dd>${esc(r.lastCheck ? new Date(r.lastCheck).toLocaleString('de-AT') : '—')}</dd></div></dl>
      ${r.lastError ? `<div class="errorbox">${esc(r.lastError)}</div>` : ''}
      <div class="actions wrap">
        ${invite ? `<a class="button ghost" href="${invite}" target="_blank" rel="noopener">Bot einladen</a>` : ''}
        ${currentUser(req).role === 'admin' ? `<a class="button ghost" href="/servers/${esc(s.id)}/edit">Bearbeiten</a>
        <form method="post" action="/servers/${esc(s.id)}/test-rcon" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button ghost">RCON testen</button></form>
        <form method="post" action="/servers/${esc(s.id)}/restart" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button ghost">Neu starten</button></form>
        <form method="post" action="/servers/${esc(s.id)}/delete" class="inline" onsubmit="return confirm('Server wirklich löschen?')"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button danger">Löschen</button></form>` : ''}
      </div>
    </article>`;
  }).join('');

  const body = `<div class="pagehead"><div><h1>Status-Bots</h1><p>${db.servers.length} konfigurierte Server · ein eigener Discord-Bot pro Eintrag</p></div>${currentUser(req).role === 'admin' ? '<a class="button primary" href="/servers/new">+ Server hinzufügen</a>' : ''}</div>
  <section class="grid">${cards || '<div class="empty panel">Noch keine Server angelegt.</div>'}</section>`;
  render(req, res, 'Server', body);
});

app.get('/servers/new', requireAdmin, (req, res) => render(req, res, 'Server hinzufügen', `<div class="pagehead"><div><h1>Server hinzufügen</h1><p>Jeder Eintrag verwendet einen eigenen Discord Bot Token.</p></div></div>${serverForm({ csrf: csrf(req) })}`));

app.post('/servers/new', requireAdmin, checkCsrf, async (req, res) => {
  try {
    const { name, botToken, rconUrl, rconPassword, intervalSeconds, switchSeconds, onlineTemplates, offlineTemplate, enabled } = req.body;
    if (!name || !botToken || !rconUrl || !rconPassword) throw new Error('Pflichtfelder fehlen');
    const bot = await discordApi('/users/@me', { headers: { Authorization: `Bot ${botToken}` } });
    if (!bot.bot) throw new Error('Der Discord Token gehört nicht zu einem Bot-Account');
    const entry = upsertServer({
      name: String(name).trim(), botTokenEnc: encryptSecret(botToken.trim()), botId: bot.id,
      rconUrl: String(rconUrl).trim().replace(/\/+$/, ''), rconPasswordEnc: encryptSecret(rconPassword),
      intervalSeconds: Math.min(3600, Math.max(10, Number(intervalSeconds) || 30)),
      switchSeconds: Math.min(3600, Math.max(5, Number(switchSeconds) || 15)),
      onlineTemplates: String(onlineTemplates || '{players}/{max} Spieler online\nMap: {map}').split(/\r?\n/).map((x) => x.trim().slice(0, 128)).filter(Boolean).slice(0, 10),
      offlineTemplate: String(offlineTemplate || 'Server offline').slice(0, 128), enabled: enabled === '1'
    });
    await startServerBot(entry);
    flash(req, 'ok', `Server „${entry.name}“ wurde angelegt.`);
    res.redirect('/');
  } catch (error) {
    flash(req, 'err', error.message);
    res.redirect('/servers/new');
  }
});

app.get('/servers/:id/edit', requireAdmin, (req, res) => {
  const server = getServer(req.params.id);
  if (!server) return res.status(404).send('Server nicht gefunden');
  render(req, res, 'Server bearbeiten', `<div class="pagehead"><div><h1>${esc(server.name)}</h1><p>Leere Passwortfelder behalten die vorhandenen Secrets.</p></div></div>${serverForm({ server, csrf: csrf(req), isEdit: true })}`);
});

app.post('/servers/:id/edit', requireAdmin, checkCsrf, async (req, res) => {
  try {
    const old = getServer(req.params.id);
    if (!old) return res.status(404).send('Server nicht gefunden');
    const patch = {
      id: old.id, name: String(req.body.name || '').trim(), rconUrl: String(req.body.rconUrl || '').trim().replace(/\/+$/, ''),
      intervalSeconds: Math.min(3600, Math.max(10, Number(req.body.intervalSeconds) || 30)),
      switchSeconds: Math.min(3600, Math.max(5, Number(req.body.switchSeconds) || 15)),
      onlineTemplates: String(req.body.onlineTemplates || '{players}/{max} Spieler online\nMap: {map}').split(/\r?\n/).map((x) => x.trim().slice(0, 128)).filter(Boolean).slice(0, 10),
      offlineTemplate: String(req.body.offlineTemplate || 'Server offline').slice(0, 128), enabled: req.body.enabled === '1'
    };
    if (!patch.name || !patch.rconUrl) throw new Error('Name und RCON URL sind Pflicht');
    if (req.body.botToken) {
      const bot = await discordApi('/users/@me', { headers: { Authorization: `Bot ${req.body.botToken}` } });
      if (!bot.bot) throw new Error('Der Discord Token gehört nicht zu einem Bot-Account');
      patch.botTokenEnc = encryptSecret(req.body.botToken.trim()); patch.botId = bot.id;
    }
    if (req.body.rconPassword) patch.rconPasswordEnc = encryptSecret(req.body.rconPassword);
    const entry = upsertServer(patch);
    await startServerBot(entry);
    flash(req, 'ok', 'Server gespeichert; Bot wurde neu gestartet.');
    res.redirect('/');
  } catch (error) {
    flash(req, 'err', error.message);
    res.redirect(`/servers/${encodeURIComponent(req.params.id)}/edit`);
  }
});

app.post('/servers/:id/test-rcon', requireAdmin, checkCsrf, async (req, res) => {
  try {
    const server = getServer(req.params.id);
    if (!server) return res.status(404).send('Server nicht gefunden');
    const status = await fetchWardogsStatus(server.rconUrl, decryptSecret(server.rconPasswordEnc));
    flash(req, 'ok', `RCON OK: ${status.current}/${status.max} Spieler${status.map ? ` · Map: ${status.map}` : ''}`);
  } catch (error) {
    flash(req, 'err', `RCON Test fehlgeschlagen: ${error.message}`);
  }
  res.redirect('/');
});

app.post('/servers/:id/restart', requireAdmin, checkCsrf, async (req, res) => {
  const server = getServer(req.params.id);
  if (server) await startServerBot(server);
  flash(req, 'ok', 'Bot-Neustart ausgelöst.');
  res.redirect('/');
});

app.post('/servers/:id/delete', requireAdmin, checkCsrf, async (req, res) => {
  await stopServerBot(req.params.id); deleteServer(req.params.id); flash(req, 'ok', 'Server gelöscht.'); res.redirect('/');
});

app.get('/users', requireAdmin, (req, res) => {
  const users = readDb().users;
  const rows = users.map((u) => `<tr><td><strong>${esc(u.globalName || u.username || 'Noch nie eingeloggt')}</strong><div class="muted small">${esc(u.discordId)}</div></td><td>${esc(u.role)}</td><td>${esc(u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('de-AT') : 'Noch nie')}</td><td>${bootstrapAdmins.has(u.discordId) ? '<span class="muted">.env Admin</span>' : `<form method="post" action="/users/${esc(u.discordId)}/delete" onsubmit="return confirm('Benutzer entfernen?')"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><button class="button danger smallbtn">Entfernen</button></form>`}</td></tr>`).join('');
  const body = `<div class="pagehead"><div><h1>Panel-Benutzer</h1><p>Nur freigeschaltete Discord IDs können sich anmelden.</p></div></div>
  <form method="post" action="/users" class="panel adduser"><input type="hidden" name="_csrf" value="${esc(csrf(req))}"><label>Discord User ID<input name="discordId" required pattern="[0-9]{17,20}" placeholder="123456789012345678"></label><label>Rolle<select name="role"><option value="viewer">viewer</option><option value="admin">admin</option></select></label><button class="button primary">Freischalten</button></form>
  <div class="panel tablewrap"><table><thead><tr><th>Benutzer</th><th>Rolle</th><th>Letzter Login</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="4">Noch keine Benutzer.</td></tr>'}</tbody></table></div>`;
  render(req, res, 'Benutzer', body);
});

app.post('/users', requireAdmin, checkCsrf, (req, res) => {
  const discordId = String(req.body.discordId || '').trim(); const role = req.body.role === 'admin' ? 'admin' : 'viewer';
  if (!validSnowflake(discordId)) { flash(req, 'err', 'Ungültige Discord User ID.'); return res.redirect('/users'); }
  upsertUser({ discordId, role }); flash(req, 'ok', `Discord User ${discordId} wurde freigeschaltet.`); res.redirect('/users');
});

app.post('/users/:id/delete', requireAdmin, checkCsrf, (req, res) => {
  if (bootstrapAdmins.has(req.params.id)) { flash(req, 'err', 'Dieser Benutzer ist über ADMIN_DISCORD_IDS geschützt.'); return res.redirect('/users'); }
  if (req.params.id === currentUser(req).discordId) { flash(req, 'err', 'Du kannst deinen eigenen aktuellen Account nicht entfernen.'); return res.redirect('/users'); }
  deleteUser(req.params.id); flash(req, 'ok', 'Benutzer entfernt.'); res.redirect('/users');
});

app.get('/api/servers/:id/test-rcon', requireAdmin, async (req, res) => {
  try {
    const server = getServer(req.params.id); if (!server) return res.status(404).json({ ok: false, error: 'not found' });
    const status = await fetchWardogsStatus(server.rconUrl, decryptSecret(server.rconPasswordEnc));
    res.json({ ok: true, players: status.current, maxPlayers: status.max, serverName: status.serverName, map: status.map });
  } catch (error) { res.status(502).json({ ok: false, error: error.message }); }
});

app.use((req, res) => res.status(404).send('Nicht gefunden'));

const server = app.listen(port, async () => {
  console.log(`WARDOGS Status Panel: ${baseUrl}`);
  console.log(`Discord OAuth Redirect URI: ${redirectUri}`);
  try { await syncBots(readDb().servers); } catch (error) { console.error('Bot-Sync Fehler:', error); }
});

async function shutdown(signal) {
  console.log(`\n${signal}: fahre herunter...`);
  await shutdownBots();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
