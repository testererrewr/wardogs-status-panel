import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, EmbedBuilder, GatewayIntentBits, PermissionsBitField } from 'discord.js';
import { decryptSecret } from './crypto.js';
import { assertSafeUrl } from './target-safety.js';
import { getManagedBot } from './db.js';
import { parseManagedRules, evaluateManagedRules } from './managed-rules.js';
export { parseManagedRules, evaluateManagedRules } from './managed-rules.js';

const instances = new Map();
const runtime = new Map();

function nowIso() { return new Date().toISOString(); }
function baseUrl(value) { return String(value || '').trim().replace(/\/+$/, ''); }
function accessActive(bot) {
  if (bot?.adminGrant) return true;
  const until = Date.parse(bot?.accessUntil || '');
  return Number.isFinite(until) && until > Date.now();
}
function validSteamId(value) { return /^\d{17}$/.test(String(value || '').trim()); }
function setRuntime(id, patch) { runtime.set(id, { ...(runtime.get(id) || {}), ...patch, updatedAt: nowIso() }); }
export function managedBotRuntime(id) { return runtime.get(id) || { state: 'stopped' }; }

async function wardogsRequest(bot, pathname, { method = 'GET', body } = {}) {
  const root = baseUrl(bot?.wardogsBaseUrl);
  if (!root) throw new Error('WARDOGS Basis-URL fehlt');
  const url = await assertSafeUrl(`${root}${pathname}`, { allowPrivate: Boolean(bot?.allowPrivateTarget) });
  let secret = '';
  try { secret = decryptSecret(bot?.wardogsSecretEnc); } catch { secret = ''; }
  if (!secret) throw new Error('WARDOGS RCON/API Passwort fehlt');
  const response = await fetch(url, {
    method,
    redirect: 'manual',
    headers: { Accept: 'application/json', Authorization: `Bearer ${secret}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000)
  });
  if (response.status >= 300 && response.status < 400) throw new Error('WARDOGS API Redirects sind nicht erlaubt');
  const text = (await response.text()).slice(0, 1024 * 1024);
  let data = {};
  if (text) { try { data = JSON.parse(text); } catch { data = { message: text.slice(0, 300) }; } }
  if (!response.ok) throw new Error(`WARDOGS API ${response.status}: ${String(data?.message || data?.error || 'Fehler').slice(0, 240)}`);
  return data;
}

export async function testManagedWardogs(bot) {
  const [status, players] = await Promise.all([wardogsRequest(bot, '/v1/status'), wardogsRequest(bot, '/v1/players')]);
  return { status, playerCount: Array.isArray(players?.players) ? players.players.length : Number(players?.count || 0) };
}

export async function banManagedPlayer(bot, steamId, reason = 'WARDOGS rule violation') {
  if (!validSteamId(steamId)) throw new Error('Ungültige SteamID64');
  return wardogsRequest(bot, '/v1/bans', { method: 'POST', body: { steamId: String(steamId), reason: String(reason || '').slice(0, 180) } });
}
export async function kickManagedPlayer(bot, steamId, reason = 'WARDOGS rule violation') {
  if (!validSteamId(steamId)) throw new Error('Ungültige SteamID64');
  return wardogsRequest(bot, `/v1/players/${encodeURIComponent(steamId)}/kick`, { method: 'POST', body: { reason: String(reason || '').slice(0, 180) } });
}

function signature(bot) {
  return JSON.stringify({
    enabled: Boolean(bot.enabled), botTokenEnc: bot.botTokenEnc || '', alertChannelId: bot.alertChannelId || '', mentionRoleId: bot.mentionRoleId || '',
    wardogsBaseUrl: bot.wardogsBaseUrl || '', wardogsSecretEnc: bot.wardogsSecretEnc || '', allowPrivateTarget: Boolean(bot.allowPrivateTarget),
    pollSeconds: Number(bot.pollSeconds || 20), rulesText: bot.rulesText || '', autoBanEnabled: bot.autoBanEnabled === true,
    accessUntil: bot.accessUntil || null, adminGrant: Boolean(bot.adminGrant), restartNonce: bot.restartNonce || 0
  });
}

function alertComponents(bot, player) {
  const steamId = String(player?.steamId || player?.steamId64 || '').trim();
  if (!validSteamId(steamId)) return [];
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`wdban:${bot.id}:${steamId}`).setLabel('Ban').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`wdkick:${bot.id}:${steamId}`).setLabel('Kick').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setLabel('Steam Profile').setStyle(ButtonStyle.Link).setURL(`https://steamcommunity.com/profiles/${steamId}`)
  )];
}

async function postAlert(bot, client, player, reasons, autoResult = null) {
  const channel = await client.channels.fetch(String(bot.alertChannelId || ''));
  if (!channel?.isTextBased?.() || typeof channel.send !== 'function') throw new Error('Discord Alert-Channel wurde nicht gefunden oder ist nicht beschreibbar');
  const steamId = String(player?.steamId || player?.steamId64 || '—');
  const ping = Number(player?.pingMs ?? player?.ping);
  const embed = new EmbedBuilder()
    .setTitle('WARDOGS Player Warning')
    .setDescription(reasons.map((x) => `• ${x}`).join('\n').slice(0, 3900))
    .addFields(
      { name: 'Player', value: String(player?.name || 'Unknown').slice(0, 1024), inline: true },
      { name: 'SteamID64', value: steamId.slice(0, 1024), inline: true },
      { name: 'Faction', value: String(player?.faction || '—').slice(0, 1024), inline: true },
      { name: 'Ping', value: Number.isFinite(ping) ? `${ping} ms` : '—', inline: true },
      { name: 'Auto-Ban', value: bot.autoBanEnabled ? (autoResult?.ok ? 'Executed' : `Enabled${autoResult?.error ? ` · failed: ${String(autoResult.error).slice(0, 160)}` : ''}`) : 'OFF', inline: false }
    )
    .setTimestamp(new Date());
  const content = /^\d{17,20}$/.test(String(bot.mentionRoleId || '')) ? `<@&${bot.mentionRoleId}>` : '';
  await channel.send({ content, embeds: [embed], components: alertComponents(bot, player), allowedMentions: content ? { roles: [String(bot.mentionRoleId)] } : { parse: [] } });
}

async function pollPlayers(bot, state, client) {
  try {
    const data = await wardogsRequest(bot, '/v1/players');
    const players = Array.isArray(data?.players) ? data.players : [];
    const current = new Set(players.map((p) => String(p?.steamId || p?.steamId64 || '')).filter(validSteamId));
    if (!state.initialized) {
      state.seen = current;
      state.initialized = true;
      setRuntime(bot.id, { state: 'online', botTag: client.user?.tag || '', players: players.length, lastCheck: nowIso(), lastError: null });
      return;
    }
    const rules = parseManagedRules(bot.rulesText || '');
    const joins = players.filter((p) => { const id = String(p?.steamId || p?.steamId64 || ''); return validSteamId(id) && !state.seen.has(id); });
    state.seen = current;
    for (const player of joins) {
      const reasons = evaluateManagedRules(player, rules);
      if (!reasons.length) continue;
      const steamId = String(player?.steamId || player?.steamId64 || '');
      let autoResult = null;
      if (bot.autoBanEnabled === true) {
        try { await banManagedPlayer(bot, steamId, reasons.join('; ').slice(0, 180)); autoResult = { ok: true }; }
        catch (error) { autoResult = { ok: false, error: error.message }; }
      }
      try { await postAlert(bot, client, player, reasons, autoResult); }
      catch (error) { setRuntime(bot.id, { lastError: `Discord Alert: ${error.message}` }); }
    }
    setRuntime(bot.id, { state: 'online', botTag: client.user?.tag || '', players: players.length, lastCheck: nowIso(), lastError: null });
  } catch (error) {
    setRuntime(bot.id, { state: 'error', lastCheck: nowIso(), lastError: error.message });
  }
}

async function handleButton(interaction) {
  if (!interaction.isButton?.()) return;
  const match = String(interaction.customId || '').match(/^(wdban|wdkick):([0-9a-f-]{36}):(\d{17})$/i);
  if (!match) return;
  const [, action, botId, steamId] = match;
  const bot = getManagedBot(botId);
  if (!bot || !bot.enabled || !accessActive(bot)) return interaction.reply({ content: 'Dieser Managed Bot ist nicht aktiv.', ephemeral: true }).catch(() => {});
  const permission = action === 'wdban' ? PermissionsBitField.Flags.BanMembers : PermissionsBitField.Flags.KickMembers;
  if (!interaction.memberPermissions?.has(permission)) return interaction.reply({ content: 'Dir fehlt die Discord-Berechtigung für diese Aktion.', ephemeral: true }).catch(() => {});
  await interaction.deferReply({ ephemeral: true }).catch(() => {});
  try {
    if (action === 'wdban') await banManagedPlayer(bot, steamId, `Manual Discord action by ${interaction.user?.tag || interaction.user?.id || 'admin'}`);
    else await kickManagedPlayer(bot, steamId, `Manual Discord action by ${interaction.user?.tag || interaction.user?.id || 'admin'}`);
    await interaction.editReply(`${action === 'wdban' ? 'Ban' : 'Kick'} für ${steamId} wurde an den WARDOGS-Server gesendet.`).catch(() => {});
  } catch (error) {
    await interaction.editReply(`Aktion fehlgeschlagen: ${String(error.message || error).slice(0, 300)}`).catch(() => {});
  }
}

async function stopOne(id, keepRuntime = true) {
  const active = instances.get(id);
  if (active) {
    clearInterval(active.timer);
    try { active.client.destroy(); } catch {}
    instances.delete(id);
  }
  if (keepRuntime) setRuntime(id, { state: 'stopped', botTag: null, players: null });
  else runtime.delete(id);
}

async function startOne(bot) {
  await stopOne(bot.id, false);
  if (!bot.enabled || !accessActive(bot)) { setRuntime(bot.id, { state: accessActive(bot) ? 'stopped' : 'access-expired' }); return; }
  parseManagedRules(bot.rulesText || '');
  if (!bot.botTokenEnc) throw new Error('Discord Bot Token fehlt');
  if (!bot.alertChannelId) throw new Error('Discord Alert-Channel ID fehlt');
  const token = decryptSecret(bot.botTokenEnc);
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const state = { initialized: false, seen: new Set() };
  client.on('interactionCreate', (interaction) => handleButton(interaction).catch((error) => console.error(`Managed bot interaction ${bot.id}:`, error.message)));
  client.on('error', (error) => setRuntime(bot.id, { lastError: error.message }));
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Discord Login Timeout')), 20000);
    client.once('clientReady', () => { clearTimeout(timeout); resolve(); });
    client.login(token).catch((error) => { clearTimeout(timeout); reject(error); });
  });
  setRuntime(bot.id, { state: 'connected', botTag: client.user?.tag || '', botId: client.user?.id || '', lastError: null });
  await pollPlayers(bot, state, client);
  const timer = setInterval(() => pollPlayers(getManagedBot(bot.id) || bot, state, client), Math.max(10, Math.min(300, Number(bot.pollSeconds) || 20)) * 1000);
  timer.unref?.();
  instances.set(bot.id, { client, timer, signature: signature(bot), state });
}

export async function syncManagedBots(bots) {
  const wanted = new Set((bots || []).filter((b) => b.enabled && accessActive(b)).map((b) => b.id));
  for (const id of [...instances.keys()]) if (!wanted.has(id)) await stopOne(id);
  for (const bot of bots || []) {
    if (!bot.enabled || !accessActive(bot)) { if (!instances.has(bot.id)) setRuntime(bot.id, { state: bot.enabled && !accessActive(bot) ? 'access-expired' : 'stopped' }); continue; }
    const existing = instances.get(bot.id);
    const sig = signature(bot);
    if (existing?.signature === sig) continue;
    try { await startOne(bot); } catch (error) { await stopOne(bot.id, false); setRuntime(bot.id, { state: 'error', lastError: error.message, lastCheck: nowIso() }); }
  }
}

export async function stopManagedBot(id) { await stopOne(id); }
export async function restartManagedBot(bot) { await startOne(bot); return managedBotRuntime(bot.id); }
export async function shutdownManagedBots() { for (const id of [...instances.keys()]) await stopOne(id, false); }
