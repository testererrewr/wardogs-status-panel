import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import { decryptSecret } from './crypto.js';
import { getManagedBot, upsertManagedBot } from './db.js';
import { assertSafeUrl } from './target-safety.js';
import { normalizeSteamId64 } from './managed-bots.js';

export const PLAYTIME_SERVICE_ID = 'wardogs-playtime-tracker';
const instances = new Map();
const runtime = new Map();
const locks = new Map();
const recoveryState = new Map();
const LEADERBOARD_MS = 6 * 60 * 60 * 1000;
const SAVE_MS = 60 * 1000;

function nowIso() { return new Date().toISOString(); }
function accessActive(bot) {
  if (!bot) return false;
  if (bot.adminGrant) return true;
  const until = Date.parse(bot.accessUntil || '');
  return Number.isFinite(until) && until > Date.now();
}
function baseUrl(value) { return String(value || '').trim().replace(/\/+$/, ''); }
function validSnowflake(value) { return /^\d{17,20}$/.test(String(value || '').trim()); }
function setRuntime(id, patch) { runtime.set(id, { ...(runtime.get(id) || {}), ...patch, updatedAt: nowIso() }); }
export function playtimeBotRuntime(id) { return runtime.get(id) || { state: 'stopped' }; }
function recoveryDelayMs(attempts) { return Math.min(5 * 60_000, 15_000 * (2 ** Math.max(0, Math.min(5, Number(attempts || 1) - 1)))); }
function clearRecovery(id) { recoveryState.delete(id); setRuntime(id, { needsRecovery: false, recoveryAttempts: 0, nextRecoveryAt: null, disconnectedAt: null }); }
function markRecoveryFailure(id, error) {
  const previous = recoveryState.get(id) || { attempts: 0 };
  const attempts = Number(previous.attempts || 0) + 1;
  const nextAttemptAt = Date.now() + recoveryDelayMs(attempts);
  const lastError = String(error?.message || error || 'Runtime error').slice(0, 300);
  recoveryState.set(id, { attempts, nextAttemptAt, lastError });
  setRuntime(id, { state: 'recovering', lastError, needsRecovery: true, recoveryAttempts: attempts, nextRecoveryAt: new Date(nextAttemptAt).toISOString(), lastCheck: nowIso() });
}

async function withLock(id, fn) {
  const previous = locks.get(id) || Promise.resolve();
  const next = previous.catch(() => {}).then(fn);
  let tracked;
  tracked = next.finally(() => { if (locks.get(id) === tracked) locks.delete(id); });
  locks.set(id, tracked);
  return tracked;
}

async function wardogsRequest(bot, pathname) {
  const root = baseUrl(bot?.wardogsBaseUrl);
  if (!root) throw new Error('WARDOGS base URL is missing');
  const url = await assertSafeUrl(`${root}${pathname}`, { allowPrivate: Boolean(bot?.allowPrivateTarget) });
  let secret = '';
  try { secret = decryptSecret(bot?.wardogsSecretEnc); } catch { secret = ''; }
  if (!secret) throw new Error('WARDOGS RCON/API password is missing');
  const response = await fetch(url, {
    redirect: 'manual',
    headers: { Accept: 'application/json', Authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(8000)
  });
  if (response.status >= 300 && response.status < 400) throw new Error('WARDOGS API redirects are not allowed');
  const text = (await response.text()).slice(0, 1024 * 1024);
  let data = {};
  if (text) { try { data = JSON.parse(text); } catch { data = { message: text.slice(0, 300) }; } }
  if (!response.ok) throw new Error(`WARDOGS API ${response.status}: ${String(data?.error?.message || data?.message || data?.error || 'Error').slice(0, 240)}`);
  return data;
}

function playerSteamId(player) {
  const candidates = [player?.steamId64, player?.steamId, player?.steamID64, player?.steamID, player?.playerId, player?.id];
  for (const candidate of candidates) {
    const normalized = normalizeSteamId64(candidate);
    if (normalized) return normalized;
  }
  return '';
}
function extractClanTag(name) {
  const match = String(name || '').match(/^\s*(\[[^\]\r\n]{2,12}\])/);
  return match ? match[1].toUpperCase() : '';
}
function emptyHours() { return Array.from({ length: 24 }, (_, hour) => ({ hour, samples: 0, playerSum: 0, maxPlayers: 0 })); }
function normalizeStats(input) {
  const stats = input && typeof input === 'object' ? structuredClone(input) : {};
  stats.players = stats.players && typeof stats.players === 'object' && !Array.isArray(stats.players) ? stats.players : {};
  const sourceHours = Array.isArray(stats.hours) ? stats.hours : [];
  stats.hours = emptyHours().map((base, hour) => {
    const row = sourceHours.find((x) => Number(x?.hour) === hour) || sourceHours[hour] || {};
    return { hour, samples: Math.max(0, Number(row.samples) || 0), playerSum: Math.max(0, Number(row.playerSum) || 0), maxPlayers: Math.max(0, Number(row.maxPlayers) || 0) };
  });
  stats.startedAt = stats.startedAt || nowIso();
  stats.lastPollAt = stats.lastPollAt || null;
  return stats;
}
function timeZone(bot) {
  const value = String(bot?.statsTimezone || 'Europe/Vienna').trim();
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date()); return value; } catch { return 'UTC'; }
}
function hourInZone(date, zone) {
  try { return Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: zone }).format(date)); } catch { return date.getUTCHours(); }
}
function listPlayers(data) { return Array.isArray(data?.players) ? data.players : Array.isArray(data) ? data : []; }
function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return `${hours.toLocaleString('en-US')}h ${minutes}m`;
}

function snapshotFromStats(stats, online = new Map()) {
  const rows = Object.entries(stats.players || {}).map(([steamId, p]) => ({
    steamId,
    name: String(p?.name || steamId),
    clanTag: String(p?.clanTag || ''),
    totalSeconds: Math.max(0, Number(p?.totalSeconds) || 0),
    lastSeenAt: p?.lastSeenAt || null,
    online: online.has(steamId)
  })).sort((a, b) => b.totalSeconds - a.totalSeconds || a.name.localeCompare(b.name));
  const totalSeconds = rows.reduce((sum, p) => sum + p.totalSeconds, 0);
  const clanMap = new Map();
  for (const row of rows) {
    if (!row.clanTag) continue;
    const current = clanMap.get(row.clanTag) || { tag: row.clanTag, players: 0, totalSeconds: 0 };
    current.players += 1;
    current.totalSeconds += row.totalSeconds;
    clanMap.set(row.clanTag, current);
  }
  const clans = [...clanMap.values()].sort((a, b) => b.totalSeconds - a.totalSeconds || b.players - a.players || a.tag.localeCompare(b.tag));
  const hours = (stats.hours || []).map((row) => ({
    hour: Number(row.hour) || 0,
    samples: Number(row.samples) || 0,
    averagePlayers: Number(row.samples) ? Number(row.playerSum || 0) / Number(row.samples) : 0,
    maxPlayers: Number(row.maxPlayers) || 0
  })).sort((a, b) => a.hour - b.hour);
  return { rows, top25: rows.slice(0, 25), totalSeconds, uniquePlayers: rows.length, onlinePlayers: online.size, clans, hours, startedAt: stats.startedAt, lastPollAt: stats.lastPollAt };
}

function signature(bot) {
  return JSON.stringify({
    enabled: Boolean(bot.enabled), botTokenEnc: bot.botTokenEnc || '', leaderboardChannelId: bot.leaderboardChannelId || '',
    wardogsBaseUrl: bot.wardogsBaseUrl || '', wardogsSecretEnc: bot.wardogsSecretEnc || '', allowPrivateTarget: Boolean(bot.allowPrivateTarget),
    pollSeconds: Number(bot.pollSeconds || 30), statsTimezone: timeZone(bot), accessUntil: bot.accessUntil || null, adminGrant: Boolean(bot.adminGrant), restartNonce: bot.restartNonce || 0
  });
}

async function saveState(botId, state, force = false) {
  if (!state?.stats) return;
  const now = Date.now();
  if (!force && now - Number(state.lastSavedAt || 0) < SAVE_MS) return;
  state.lastSavedAt = now;
  upsertManagedBot({ id: botId, playtimeStats: state.stats });
}

async function buildLeaderboardPayload(bot, state) {
  const snapshot = snapshotFromStats(state.stats, state.online || new Map());
  const lines = snapshot.top25.length ? snapshot.top25.map((p, index) => `**${index + 1}.** ${String(p.name).slice(0, 45)} — **${formatDuration(p.totalSeconds)}**`).join('\n') : 'No tracked players yet.';
  const embed = new EmbedBuilder()
    .setTitle('WARDOGS Playtime · Top 25')
    .setDescription(lines.slice(0, 3900))
    .addFields(
      { name: 'Total tracked playtime', value: formatDuration(snapshot.totalSeconds), inline: true },
      { name: 'Tracked players', value: String(snapshot.uniquePlayers), inline: true },
      { name: 'Online now', value: String(snapshot.onlinePlayers), inline: true }
    )
    .setFooter({ text: 'status-hub.lol · updates every 6 hours' })
    .setTimestamp(new Date());
  return { embeds: [embed], allowedMentions: { parse: [] } };
}

async function publishLeaderboard(bot, state) {
  if (!validSnowflake(bot?.leaderboardChannelId)) return { skipped: true };
  const client = state?.client;
  if (!client?.isReady?.()) throw new Error('Discord bot is not connected');
  const channel = await client.channels.fetch(String(bot.leaderboardChannelId));
  if (!channel?.isTextBased?.() || typeof channel.send !== 'function') throw new Error('Leaderboard channel was not found or is not writable');
  const payload = await buildLeaderboardPayload(bot, state);
  let message = null;
  const storedId = String(bot.leaderboardMessageId || state.leaderboardMessageId || '');
  if (storedId) {
    try { message = await channel.messages.fetch(storedId); await message.edit(payload); } catch { message = null; }
  }
  if (!message) message = await channel.send(payload);
  const at = nowIso();
  state.leaderboardMessageId = message.id;
  upsertManagedBot({ id: bot.id, leaderboardMessageId: message.id, lastLeaderboardAt: at });
  return { ok: true, messageId: message.id, at };
}

async function pollOne(bot, state, { forceLeaderboard = false } = {}) {
  if (state.pollInFlight) return;
  state.pollInFlight = true;
  try {
    const data = await wardogsRequest(bot, '/v1/players');
    const rawPlayers = listPlayers(data);
    const now = Date.now();
    const current = new Map();
    for (const player of rawPlayers) {
      const steamId = playerSteamId(player);
      if (!steamId) continue;
      current.set(steamId, player);
    }
    const previous = state.online || new Map();
    const elapsed = state.lastTick ? Math.max(0, Math.min(300, (now - state.lastTick) / 1000)) : 0;
    if (elapsed > 0) {
      for (const [steamId] of previous) {
        if (!current.has(steamId)) continue;
        const record = state.stats.players[steamId] || { totalSeconds: 0 };
        record.totalSeconds = Math.max(0, Number(record.totalSeconds) || 0) + elapsed;
        state.stats.players[steamId] = record;
      }
    }
    for (const [steamId, player] of current) {
      const name = String(player?.name || player?.playerName || steamId).trim().slice(0, 100) || steamId;
      const record = state.stats.players[steamId] || { totalSeconds: 0, firstSeenAt: nowIso() };
      record.name = name;
      record.clanTag = extractClanTag(name);
      record.lastSeenAt = nowIso();
      if (!record.firstSeenAt) record.firstSeenAt = nowIso();
      state.stats.players[steamId] = record;
    }
    const zone = timeZone(bot);
    const hour = hourInZone(new Date(now), zone);
    const bucket = state.stats.hours[hour] || { hour, samples: 0, playerSum: 0, maxPlayers: 0 };
    bucket.samples += 1;
    bucket.playerSum += current.size;
    bucket.maxPlayers = Math.max(bucket.maxPlayers, current.size);
    state.stats.hours[hour] = bucket;
    state.stats.lastPollAt = nowIso();
    state.online = current;
    state.lastTick = now;
    setRuntime(bot.id, { state: 'online', players: current.size, lastCheck: nowIso(), lastError: null });
    await saveState(bot.id, state);

    const fresh = getManagedBot(bot.id) || bot;
    const lastLeaderboard = Date.parse(fresh.lastLeaderboardAt || '') || 0;
    if (validSnowflake(fresh.leaderboardChannelId) && (forceLeaderboard || !lastLeaderboard || now - lastLeaderboard >= LEADERBOARD_MS)) {
      try { await publishLeaderboard(fresh, state); setRuntime(bot.id, { lastLeaderboardAt: nowIso(), lastLeaderboardError: null }); }
      catch (error) { setRuntime(bot.id, { lastLeaderboardError: String(error.message || error).slice(0, 300) }); }
    }
  } catch (error) {
    setRuntime(bot.id, { state: 'error', lastError: String(error.message || error).slice(0, 300), lastCheck: nowIso() });
    throw error;
  } finally { state.pollInFlight = false; }
}

async function stopOne(id, keepRuntime = true) {
  const active = instances.get(id);
  if (active) instances.delete(id);
  if (active) {
    clearInterval(active.timer);
    try { await saveState(id, active.state, true); } catch {}
    try { await active.client?.destroy?.(); } catch {}
  }
  if (keepRuntime) setRuntime(id, { state: 'stopped', botTag: null, players: null, lastError: null });
  else runtime.delete(id);
}

async function startOne(bot) {
  await stopOne(bot.id, false);
  if (bot.serviceId !== PLAYTIME_SERVICE_ID) return;
  if (!bot.enabled || !accessActive(bot)) { setRuntime(bot.id, { state: accessActive(bot) ? 'stopped' : 'access-expired' }); return; }
  if (!bot.wardogsBaseUrl || !bot.wardogsSecretEnc) throw new Error('WARDOGS URL and RCON password are required');
  const wantsDiscord = validSnowflake(bot.leaderboardChannelId);
  let token = '';
  if (bot.botTokenEnc) { try { token = decryptSecret(bot.botTokenEnc); } catch {} }
  if (wantsDiscord && !token) throw new Error('Discord bot token is required when a leaderboard channel is configured');
  const client = wantsDiscord ? new Client({ intents: [GatewayIntentBits.Guilds] }) : null;
  if (client) {
    client.on('shardDisconnect', () => setRuntime(bot.id, { state: 'disconnected', needsRecovery: true, disconnectedAt: Date.now() }));
    client.on('shardError', (error) => setRuntime(bot.id, { state: 'error', lastError: String(error?.message || error).slice(0, 300), needsRecovery: true, disconnectedAt: Date.now() }));
    client.on('invalidated', () => setRuntime(bot.id, { state: 'disconnected', needsRecovery: true, disconnectedAt: Date.now() }));
    client.on('shardResume', () => clearRecovery(bot.id));
  }
  const state = { stats: normalizeStats(bot.playtimeStats), online: new Map(), lastTick: 0, pollInFlight: false, client, lastSavedAt: 0, leaderboardMessageId: String(bot.leaderboardMessageId || '') };
  try {
    if (client) {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Discord login timeout')), 20000);
        client.once('clientReady', () => { clearTimeout(timeout); resolve(); });
        client.login(token).catch((error) => { clearTimeout(timeout); reject(error); });
      });
    }
    const fresh = getManagedBot(bot.id) || bot;
    if (!fresh.enabled || !accessActive(fresh)) { if (client) await client.destroy(); setRuntime(bot.id, { state: accessActive(fresh) ? 'stopped' : 'access-expired' }); return; }
    setRuntime(bot.id, { state: client ? 'connected' : 'online', botTag: client?.user?.tag || null, botId: client?.user?.id || null, lastError: null });
    await pollOne(fresh, state);
    const timer = setInterval(() => {
      const latest = getManagedBot(bot.id);
      if (!latest?.enabled || !accessActive(latest)) return;
      pollOne(latest, state).catch(() => {});
    }, Math.max(10, Math.min(300, Number(fresh.pollSeconds) || 30)) * 1000);
    timer.unref?.();
    instances.set(bot.id, { client, timer, signature: signature(fresh), state });
    clearRecovery(bot.id);
  } catch (error) {
    try { await client.destroy(); } catch {}
    throw error;
  }
}

export async function syncPlaytimeBots(bots) {
  const filtered = (bots || []).filter((bot) => bot?.serviceId === PLAYTIME_SERVICE_ID);
  const snapshots = new Map(filtered.map((bot) => [bot.id, bot]));
  const ids = new Set([...instances.keys(), ...snapshots.keys()]);
  for (const id of ids) {
    await withLock(id, async () => {
      const fresh = getManagedBot(id) || snapshots.get(id);
      if (!fresh || fresh.serviceId !== PLAYTIME_SERVICE_ID || !fresh.enabled || !accessActive(fresh)) {
        if (instances.has(id)) await stopOne(id);
        recoveryState.delete(id);
        setRuntime(id, { state: fresh?.enabled && !accessActive(fresh) ? 'access-expired' : 'stopped', botTag: null, players: null, needsRecovery: false, nextRecoveryAt: null });
        return;
      }
      const existing = instances.get(id);
      const sig = signature(fresh);
      const rt = playtimeBotRuntime(id);
      if (existing?.signature === sig) {
        if (!existing.client) return;
        const ready = typeof existing.client.isReady === 'function' ? existing.client.isReady() : true;
        const needsRecovery = !ready || rt.needsRecovery === true;
        const disconnectedAt = Number(rt.disconnectedAt || 0);
        if (!needsRecovery || fresh.autoRecoveryEnabled === false || (disconnectedAt && Date.now() - disconnectedAt < 10_000)) return;
        try { await startOne(fresh); }
        catch (error) { await stopOne(id, false); markRecoveryFailure(id, error); }
        return;
      }
      const recovery = recoveryState.get(id);
      if (!existing && recovery) {
        if (fresh.autoRecoveryEnabled === false) {
          setRuntime(id, { state: 'error', lastError: recovery.lastError, recoveryAttempts: recovery.attempts, nextRecoveryAt: null, needsRecovery: false });
          return;
        }
        if (Number(recovery.nextAttemptAt || 0) > Date.now()) {
          setRuntime(id, { state: 'recovering', recoveryAttempts: recovery.attempts, nextRecoveryAt: new Date(recovery.nextAttemptAt).toISOString(), needsRecovery: true });
          return;
        }
      }
      try { await startOne(fresh); }
      catch (error) { await stopOne(id, false); markRecoveryFailure(id, error); }
    });
  }
}
export async function restartPlaytimeBot(bot) {
  return withLock(bot.id, async () => {
    clearRecovery(bot.id);
    try { await startOne(getManagedBot(bot.id) || bot); return playtimeBotRuntime(bot.id); }
    catch (error) { await stopOne(bot.id, false); markRecoveryFailure(bot.id, error); throw error; }
  });
}
export async function stopPlaytimeBot(id) { return withLock(id, () => stopOne(id)); }
export async function shutdownPlaytimeBots() { for (const id of [...instances.keys()]) await withLock(id, () => stopOne(id, false)); }
export async function testPlaytimeWardogs(bot) { const data = await wardogsRequest(bot, '/v1/players'); return { playerCount: listPlayers(data).length }; }
export async function refreshPlaytimeTracker(bot, { publish = false } = {}) {
  const active = instances.get(bot.id);
  if (!active) throw new Error('Playtime tracker is not running');
  await pollOne(getManagedBot(bot.id) || bot, active.state, { forceLeaderboard: publish });
  if (publish && !validSnowflake((getManagedBot(bot.id) || bot).leaderboardChannelId)) throw new Error('Discord leaderboard channel ID is not configured');
  return playtimeTrackerSnapshot(getManagedBot(bot.id) || bot);
}
export function playtimeTrackerSnapshot(bot) {
  const active = instances.get(bot?.id);
  const stats = active?.state?.stats || normalizeStats(bot?.playtimeStats);
  return { ...snapshotFromStats(stats, active?.state?.online || new Map()), runtime: playtimeBotRuntime(bot?.id), timezone: timeZone(bot) };
}
