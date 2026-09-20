import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { decryptSecret } from './crypto.js';
import { getManagedBot, upsertManagedBot } from './db.js';
import { safeHttpText } from './target-safety.js';
import { normalizeSteamId64 } from './wardogs-players.js';
import { killStatsSnapshotFromStats, searchKillStatsSnapshot, prettyCause } from './kill-stats.js';

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
function baseUrl(value) {
  let raw = String(value || '').trim();
  if (!raw) return '';
  if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;
  return raw.replace(/\/+$/, '');
}
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

export function playtimeTrackerServers(bot) {
  const rows = Array.isArray(bot?.playtimeServers) ? bot.playtimeServers : [];
  const normalized = rows.map((row, index) => ({
    id: String(row?.id || `server-${index + 1}`).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 64) || `server-${index + 1}`,
    label: String(row?.label || `Server ${index + 1}`).trim().slice(0, 80) || `Server ${index + 1}`,
    baseUrl: baseUrl(row?.baseUrl || row?.wardogsBaseUrl || ''),
    secretEnc: String(row?.secretEnc || row?.wardogsSecretEnc || ''),
    killFeedChannelId: /^\d{17,20}$/.test(String(row?.killFeedChannelId || '')) ? String(row.killFeedChannelId) : '',
    killFeedMessageId: /^\d{17,20}$/.test(String(row?.killFeedMessageId || '')) ? String(row.killFeedMessageId) : '',
    killFeedTokenEnc: String(row?.killFeedTokenEnc || ''), killFeedConfiguredAt: row?.killFeedConfiguredAt || null,
    killFeedPublicUrl: String(row?.killFeedPublicUrl || ''), killFeedNeedsGameRestart: row?.killFeedNeedsGameRestart === true,
    killFeedLastEventAt: row?.killFeedLastEventAt || null, killFeedLastPublishedAt: row?.killFeedLastPublishedAt || null,
    killFeedEvents: Array.isArray(row?.killFeedEvents) ? row.killFeedEvents.slice(-150) : []
  })).filter((row) => row.baseUrl);
  if (normalized.length) return normalized.slice(0, 12);
  const legacyUrl = baseUrl(bot?.wardogsBaseUrl);
  if (!legacyUrl) return [];
  return [{ id: 'primary', label: String(bot?.serverLabel || bot?.name || 'Server 1').trim().slice(0, 80) || 'Server 1', baseUrl: legacyUrl, secretEnc: String(bot?.wardogsSecretEnc || ''), killFeedChannelId:'', killFeedMessageId:'', killFeedTokenEnc:'', killFeedConfiguredAt:null, killFeedPublicUrl:'', killFeedNeedsGameRestart:false, killFeedLastEventAt:null, killFeedLastPublishedAt:null, killFeedEvents:[] }];
}

async function wardogsRequest(bot, server, pathname) {
  const root = baseUrl(server?.baseUrl);
  if (!root) throw new Error(`${server?.label || 'WARDOGS server'}: base URL is missing`);
  let secret = '';
  try { secret = decryptSecret(server?.secretEnc); } catch { secret = ''; }
  if (!secret) throw new Error(`${server?.label || 'WARDOGS server'}: RCON/API password is missing`);
  const response = await safeHttpText(`${root}${pathname}`, {
    allowPrivate: Boolean(bot?.allowPrivateTarget),
    headers: { Accept: 'application/json', Authorization: `Bearer ${secret}` },
    timeoutMs: 8000, maxBytes: 1024 * 1024
  });
  if (response.status >= 300 && response.status < 400) throw new Error(`${server?.label || 'WARDOGS server'}: API redirects are not allowed`);
  const text = response.text;
  let data = {};
  if (text) { try { data = JSON.parse(text); } catch { data = { message: text.slice(0, 300) }; } }
  if (!response.ok) throw new Error(`${server?.label || 'WARDOGS server'}: WARDOGS API ${response.status}: ${String(data?.error?.message || data?.message || data?.error || 'Error').slice(0, 220)}`);
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
function normalizeServerStats(input) {
  const stats = input && typeof input === 'object' ? structuredClone(input) : {};
  stats.players = stats.players && typeof stats.players === 'object' && !Array.isArray(stats.players) ? stats.players : {};
  for (const [steamId, row] of Object.entries(stats.players)) {
    stats.players[steamId] = {
      ...row,
      totalSeconds: Math.max(0, Number(row?.totalSeconds) || 0),
      sessionCount: Math.max(0, Math.floor(Number(row?.sessionCount) || 0)),
      firstSeenAt: row?.firstSeenAt || null,
      lastSeenAt: row?.lastSeenAt || null
    };
  }
  const sourceHours = Array.isArray(stats.hours) ? stats.hours : [];
  stats.hours = emptyHours().map((base, hour) => {
    const row = sourceHours.find((x) => Number(x?.hour) === hour) || sourceHours[hour] || {};
    return { hour, samples: Math.max(0, Number(row.samples) || 0), playerSum: Math.max(0, Number(row.playerSum) || 0), maxPlayers: Math.max(0, Number(row.maxPlayers) || 0) };
  });
  stats.startedAt = stats.startedAt || nowIso();
  stats.lastPollAt = stats.lastPollAt || null;
  return stats;
}
function normalizeStats(input, servers) {
  const source = input && typeof input === 'object' ? structuredClone(input) : {};
  const networkHoursSource = Array.isArray(source.hours) ? source.hours : [];
  const networkHours = emptyHours().map((base, hour) => {
    const row = networkHoursSource.find((x) => Number(x?.hour) === hour) || networkHoursSource[hour] || {};
    return { hour, samples: Math.max(0, Number(row.samples) || 0), playerSum: Math.max(0, Number(row.playerSum) || 0), maxPlayers: Math.max(0, Number(row.maxPlayers) || 0) };
  });
  const out = { startedAt: source.startedAt || nowIso(), lastPollAt: source.lastPollAt || null, hours: networkHours, servers: {} };
  const sourceServers = source.servers && typeof source.servers === 'object' && !Array.isArray(source.servers) ? source.servers : null;
  if (sourceServers) {
    for (const server of servers) out.servers[server.id] = normalizeServerStats(sourceServers[server.id]);
  } else if (servers[0]) {
    // Backward-compatible migration of the old single-server statistics shape.
    out.servers[servers[0].id] = normalizeServerStats(source);
  }
  for (const server of servers) if (!out.servers[server.id]) out.servers[server.id] = normalizeServerStats(null);
  return out;
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

function serverSnapshot(server, stats, online = new Map()) {
  const rows = Object.entries(stats.players || {}).map(([steamId, p]) => ({
    steamId,
    name: String(p?.name || steamId),
    clanTag: String(p?.clanTag || ''),
    totalSeconds: Math.max(0, Number(p?.totalSeconds) || 0),
    sessionCount: Math.max(0, Number(p?.sessionCount) || 0),
    firstSeenAt: p?.firstSeenAt || null,
    lastSeenAt: p?.lastSeenAt || null,
    online: online.has(steamId)
  })).sort((a, b) => b.totalSeconds - a.totalSeconds || a.name.localeCompare(b.name));
  const totalSeconds = rows.reduce((sum, p) => sum + p.totalSeconds, 0);
  const hours = (stats.hours || []).map((row) => ({
    hour: Number(row.hour) || 0,
    samples: Number(row.samples) || 0,
    averagePlayers: Number(row.samples) ? Number(row.playerSum || 0) / Number(row.samples) : 0,
    maxPlayers: Number(row.maxPlayers) || 0
  })).sort((a, b) => a.hour - b.hour);
  return { id: server.id, label: server.label, rows, totalSeconds, uniquePlayers: rows.length, onlinePlayers: online.size, hours, lastPollAt: stats.lastPollAt || null };
}

function snapshotFromStats(stats, servers, onlineByServer = new Map()) {
  const serverSnaps = servers.map((server) => serverSnapshot(server, stats.servers?.[server.id] || normalizeServerStats(null), onlineByServer.get(server.id) || new Map()));
  const players = new Map();
  for (const server of serverSnaps) {
    for (const row of server.rows) {
      const current = players.get(row.steamId) || { steamId: row.steamId, name: row.name, clanTag: row.clanTag, totalSeconds: 0, sessionCount: 0, firstSeenAt: row.firstSeenAt, lastSeenAt: row.lastSeenAt, online: false, servers: [] };
      current.name = row.name || current.name;
      current.clanTag = row.clanTag || current.clanTag;
      current.totalSeconds += row.totalSeconds;
      current.sessionCount += row.sessionCount;
      current.online ||= row.online;
      if (!current.firstSeenAt || (row.firstSeenAt && String(row.firstSeenAt) < String(current.firstSeenAt))) current.firstSeenAt = row.firstSeenAt;
      if (!current.lastSeenAt || (row.lastSeenAt && String(row.lastSeenAt) > String(current.lastSeenAt))) current.lastSeenAt = row.lastSeenAt;
      current.servers.push({ id: server.id, label: server.label, totalSeconds: row.totalSeconds, sessionCount: row.sessionCount, online: row.online, lastSeenAt: row.lastSeenAt });
      players.set(row.steamId, current);
    }
  }
  const rows = [...players.values()].sort((a, b) => b.totalSeconds - a.totalSeconds || a.name.localeCompare(b.name));
  const totalSeconds = serverSnaps.reduce((sum, s) => sum + s.totalSeconds, 0);
  const clanMap = new Map();
  for (const row of rows) {
    if (!row.clanTag) continue;
    const current = clanMap.get(row.clanTag) || { tag: row.clanTag, players: 0, totalSeconds: 0 };
    current.players += 1;
    current.totalSeconds += row.totalSeconds;
    clanMap.set(row.clanTag, current);
  }
  const clans = [...clanMap.values()].sort((a, b) => b.totalSeconds - a.totalSeconds || b.players - a.players || a.tag.localeCompare(b.tag));
  const hours = (Array.isArray(stats.hours) ? stats.hours : emptyHours()).map((row, hour) => ({
    hour,
    samples: Number(row?.samples) || 0,
    averagePlayers: Number(row?.samples) ? Number(row?.playerSum || 0) / Number(row.samples) : 0,
    maxPlayers: Number(row?.maxPlayers) || 0
  }));
  return {
    rows,
    top25: rows.slice(0, 25),
    totalSeconds,
    uniquePlayers: rows.length,
    onlinePlayers: serverSnaps.reduce((sum, s) => sum + s.onlinePlayers, 0),
    clans,
    hours,
    servers: serverSnaps,
    startedAt: stats.startedAt,
    lastPollAt: stats.lastPollAt
  };
}

function signature(bot) {
  return JSON.stringify({
    enabled: Boolean(bot.enabled), botTokenEnc: bot.botTokenEnc || '', leaderboardChannelId: bot.leaderboardChannelId || '',
    playtimeServers: playtimeTrackerServers(bot).map((s) => ({ id: s.id, label: s.label, baseUrl: s.baseUrl, secretEnc: s.secretEnc, killFeedChannelId: s.killFeedChannelId || '' })),
    allowPrivateTarget: Boolean(bot.allowPrivateTarget), pollSeconds: Number(bot.pollSeconds || 30), statsTimezone: timeZone(bot),
    accessUntil: bot.accessUntil || null, adminGrant: Boolean(bot.adminGrant), restartNonce: bot.restartNonce || 0
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
  const servers = playtimeTrackerServers(bot);
  const snapshot = snapshotFromStats(state.stats, servers, state.onlineByServer || new Map());
  const lines = snapshot.top25.length ? snapshot.top25.map((p, index) => `**${index + 1}.** ${String(p.name).slice(0, 45)} — **${formatDuration(p.totalSeconds)}**`).join('\n') : 'No tracked players yet.';
  const embed = new EmbedBuilder()
    .setTitle('WARDOGS Status Bot · Playtime Top 25')
    .setDescription(lines.slice(0, 3900))
    .addFields(
      { name: 'Total tracked playtime', value: formatDuration(snapshot.totalSeconds), inline: true },
      { name: 'Tracked players', value: String(snapshot.uniquePlayers), inline: true },
      { name: 'Online now', value: String(snapshot.onlinePlayers), inline: true },
      { name: 'Tracked servers', value: String(servers.length), inline: true }
    )
    .setFooter({ text: 'WARDOGS Status Bot · status-hub.lol · updates every 6 hours' })
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

function killFlagText(event) {
  return [event?.penetration ? '🧱' : '', event?.ricochet ? '↪️' : ''].filter(Boolean).join(' ');
}
function killFeedLine(event) {
  const killer = event?.suicide ? 'Suicide' : event?.killerSteamId ? String(event.killerName || event.killerSteamId).slice(0, 26) : 'Environment';
  const victim = String(event?.victimName || event?.victimSteamId || 'Unknown').slice(0, 26);
  const cause = prettyCause(event?.cause).replace(/`/g, '').slice(0, 30) || 'Unknown';
  const distance = Number(event?.distanceMeters || 0) > 0 ? ` · **${Number(event.distanceMeters).toFixed(Number(event.distanceMeters) >= 100 ? 0 : 1)} m**` : '';
  const flags = killFlagText(event);
  const lead = event?.suicide ? '☠️' : event?.headshot ? '🎯' : event?.vehicleExplosion ? '💥' : event?.roadKill ? '🚙' : event?.melee ? '🔪' : event?.falling ? '⬇️' : '⚔️';
  return `${lead} **${killer}** → **${victim}** · \`${cause}\`${distance}${flags ? ` · ${flags}` : ''}`;
}
function killStatsPlayerEmbed(player) {
  const causes = (player?.topCauses || Object.entries(player?.causes || {}).sort((a,b)=>b[1]-a[1]).slice(0,5)).map(([cause,count]) => `${prettyCause(cause)}: ${count}`).join('\n') || '—';
  return new EmbedBuilder().setTitle(`Player stats · ${String(player?.name || player?.steamId || 'Unknown').slice(0, 120)}`)
    .setDescription(`SteamID: \`${player?.steamId || '—'}\``)
    .addFields(
      { name: 'Kills', value: String(player?.kills || 0), inline: true }, { name: 'Deaths', value: String(player?.deaths || 0), inline: true },
      { name: 'K/D', value: Number(player?.kd || 0).toFixed(2), inline: true }, { name: 'Headshots', value: String(player?.headshots || 0), inline: true },
      { name: 'Longest kill', value: `${Number(player?.longestKillMeters || 0).toFixed(1)} m`, inline: true }, { name: 'Suicides', value: String(player?.suicides || 0), inline: true },
      { name: 'Top kill causes', value: causes.slice(0, 1024), inline: false }
    ).setFooter({ text: 'WARDOGS Status Bot · global stats across all tracked servers' }).setTimestamp(new Date(player?.lastSeenAt || Date.now()));
}
function killfeedPayload(bot, server) {
  const snapshot = killStatsSnapshotFromStats(bot?.killStats);
  const recent = (Array.isArray(server?.killFeedEvents) ? server.killFeedEvents : []).slice(-15).reverse();
  const lines = recent.length ? recent.map(killFeedLine).join('\n') : 'Noch keine Kills erfasst. WARDOGS Server Feed konfigurieren und den Gameserver einmal neu starten.';
  const top = snapshot.top25[0];
  const footer = `Letzte 15 Kills · ${snapshot.players.length} Spieler global${top ? ` · #1 ${String(top.name || top.steamId).slice(0, 28)} (${top.kills})` : ''}`;
  const embed = new EmbedBuilder()
    .setTitle(`⚔️ ${String(server?.label || 'WARDOGS').slice(0, 80)} · Killfeed`)
    .setDescription(lines.slice(0, 4000))
    .setFooter({ text: footer.slice(0, 2048) })
    .setTimestamp(new Date());
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`wdstatus:search:${bot.id}`).setLabel('Spieler suchen').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`wdstatus:top:${bot.id}`).setLabel('Top Kills').setStyle(ButtonStyle.Secondary)
  );
  return { embeds: [embed], components: [row], allowedMentions: { parse: [] } };
}
function killStatsSearchModal(botId) {
  return new ModalBuilder().setCustomId(`wdstatus:searchmodal:${botId}`).setTitle('Spieler suchen').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('query').setLabel('Name, Alias oder SteamID64').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100))
  );
}
function playerPickRow(botId, matches) {
  const options = matches.slice(0, 25).map((player) => ({
    label: String(player?.name || player?.steamId || 'Unbekannt').slice(0, 100),
    description: `${player?.kills || 0} Kills · ${player?.deaths || 0} Tode · ${player?.steamId || '—'}`.slice(0, 100),
    value: String(player?.steamId || '').slice(0, 100)
  })).filter((row) => row.value);
  const menu = new StringSelectMenuBuilder().setCustomId(`wdstatus:pick:${botId}`).setPlaceholder('Spieler auswählen…').addOptions(options);
  return new ActionRowBuilder().addComponents(menu);
}
async function handleStatusInteraction(botId, interaction) {
  const bot = getManagedBot(botId); if (!bot) return;
  const id = String(interaction.customId || '');
  if (id === `wdstatus:search:${botId}` && interaction.isButton()) return interaction.showModal(killStatsSearchModal(botId));
  if (id === `wdstatus:top:${botId}` && interaction.isButton()) {
    const top = killStatsSnapshotFromStats(bot.killStats).top25.slice(0, 10);
    const text = top.length ? top.map((p,i) => `**${i+1}.** ${String(p.name).slice(0,40)} — **${p.kills}** Kills · ${p.deaths} Tode · K/D ${Number(p.kd||0).toFixed(2)}`).join('\n') : 'Noch keine Kill-Stats erfasst.';
    return interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder().setTitle('Global · Top Kills').setDescription(text.slice(0, 3900))], allowedMentions: { parse: [] } });
  }
  if (id === `wdstatus:searchmodal:${botId}` && interaction.isModalSubmit()) {
    const query = interaction.fields.getTextInputValue('query');
    const snapshot = killStatsSnapshotFromStats(bot.killStats);
    const matches = searchKillStatsSnapshot(snapshot, query);
    if (!matches.length) return interaction.reply({ ephemeral: true, content: `Kein getrackter Spieler für \`${String(query).slice(0,80)}\` gefunden.` });
    const exact = normalizeSteamId64(query);
    const exactPlayer = exact ? matches.find((p) => p.steamId === exact) : null;
    if (exactPlayer || matches.length === 1) return interaction.reply({ ephemeral: true, embeds: [killStatsPlayerEmbed(exactPlayer || matches[0])], allowedMentions: { parse: [] } });
    return interaction.reply({
      ephemeral: true,
      content: `Mehrere Spieler passen zu **${String(query).replace(/[*_~|>]/g, '').slice(0, 80)}**. Bitte auswählen:`,
      components: [playerPickRow(botId, matches)],
      allowedMentions: { parse: [] }
    });
  }
  if (id === `wdstatus:pick:${botId}` && interaction.isStringSelectMenu()) {
    const steamId = normalizeSteamId64(interaction.values?.[0]);
    const player = killStatsSnapshotFromStats(bot.killStats).players.find((row) => row.steamId === steamId);
    if (!player) return interaction.update({ content: 'Spieler wurde nicht mehr in den gespeicherten Stats gefunden.', embeds: [], components: [] });
    return interaction.update({ content: null, embeds: [killStatsPlayerEmbed(player)], components: [], allowedMentions: { parse: [] } });
  }
}
async function publishServerKillfeed(bot, state, server, force = false) {
  if (!state?.client?.isReady?.() || !validSnowflake(server?.killFeedChannelId)) return { skipped: true };
  const lastEvent = Date.parse(server.killFeedLastEventAt || '') || 0;
  const lastPublished = Date.parse(server.killFeedLastPublishedAt || '') || 0;
  if (!force && server.killFeedMessageId && lastEvent <= lastPublished) return { skipped: true };
  const channel = await state.client.channels.fetch(String(server.killFeedChannelId));
  if (!channel?.isTextBased?.() || typeof channel.send !== 'function') throw new Error(`${server.label}: killfeed channel was not found or is not writable`);
  const payload = killfeedPayload(bot, server);
  let message = null;
  if (server.killFeedMessageId) { try { message = await channel.messages.fetch(String(server.killFeedMessageId)); await message.edit(payload); } catch { message = null; } }
  if (!message) message = await channel.send(payload);
  const at = nowIso();
  const fresh = getManagedBot(bot.id) || bot;
  const nextServers = playtimeTrackerServers(fresh).map((row) => String(row.id) === String(server.id) ? { ...row, killFeedMessageId: message.id, killFeedLastPublishedAt: at } : row);
  upsertManagedBot({ id: bot.id, playtimeServers: nextServers });
  return { ok: true, messageId: message.id, at };
}
async function publishAllKillfeeds(bot, state, force = false) {
  const fresh = getManagedBot(bot.id) || bot;
  const errors = [];
  for (const server of playtimeTrackerServers(fresh)) {
    if (!validSnowflake(server.killFeedChannelId)) continue;
    try { await publishServerKillfeed(fresh, state, server, force); }
    catch (error) { errors.push(String(error?.message || error).slice(0, 220)); }
  }
  setRuntime(bot.id, { lastKillfeedError: errors.length ? errors.join(' · ').slice(0, 500) : null, lastKillfeedCheckAt: nowIso() });
}

function updateServerStats(bot, server, serverStats, previous, current, lastTick, now) {
  const elapsed = lastTick ? Math.max(0, Math.min(300, (now - lastTick) / 1000)) : 0;
  if (elapsed > 0) {
    for (const [steamId] of previous) {
      if (!current.has(steamId)) continue;
      const record = serverStats.players[steamId] || { totalSeconds: 0 };
      record.totalSeconds = Math.max(0, Number(record.totalSeconds) || 0) + elapsed;
      serverStats.players[steamId] = record;
    }
  }
  for (const [steamId, player] of current) {
    const name = String(player?.name || player?.playerName || steamId).trim().slice(0, 100) || steamId;
    const isNewSession = !previous.has(steamId);
    const record = serverStats.players[steamId] || { totalSeconds: 0, firstSeenAt: nowIso(), sessionCount: 0 };
    record.name = name;
    record.clanTag = extractClanTag(name);
    record.lastSeenAt = nowIso();
    if (!record.firstSeenAt) record.firstSeenAt = nowIso();
    if (isNewSession) record.sessionCount = Math.max(0, Number(record.sessionCount) || 0) + 1;
    serverStats.players[steamId] = record;
  }
  const zone = timeZone(bot);
  const hour = hourInZone(new Date(now), zone);
  const bucket = serverStats.hours[hour] || { hour, samples: 0, playerSum: 0, maxPlayers: 0 };
  bucket.samples += 1;
  bucket.playerSum += current.size;
  bucket.maxPlayers = Math.max(bucket.maxPlayers, current.size);
  serverStats.hours[hour] = bucket;
  serverStats.lastPollAt = nowIso();
}

async function pollOne(bot, state, { forceLeaderboard = false } = {}) {
  if (state.pollInFlight) return;
  state.pollInFlight = true;
  try {
    const servers = playtimeTrackerServers(bot);
    if (!servers.length) throw new Error('At least one WARDOGS server is required');
    // Keep runtime stats aligned when a server is added/removed without losing the
    // history of the remaining servers.
    state.stats = normalizeStats(state.stats, servers);
    const results = await Promise.allSettled(servers.map(async (server) => ({ server, data: await wardogsRequest(bot, server, '/v1/players') })));
    const now = Date.now();
    const serverErrors = [];
    let successful = 0;
    let onlineTotal = 0;
    for (const result of results) {
      if (result.status !== 'fulfilled') {
        serverErrors.push(String(result.reason?.message || result.reason).slice(0, 240));
        continue;
      }
      successful += 1;
      const { server, data } = result.value;
      const rawPlayers = listPlayers(data);
      const current = new Map();
      for (const player of rawPlayers) {
        const steamId = playerSteamId(player);
        if (!steamId) continue;
        current.set(steamId, player);
      }
      const previous = state.onlineByServer.get(server.id) || new Map();
      const serverStats = state.stats.servers[server.id] || normalizeServerStats(null);
      updateServerStats(bot, server, serverStats, previous, current, state.lastTickByServer.get(server.id) || 0, now);
      state.stats.servers[server.id] = serverStats;
      state.onlineByServer.set(server.id, current);
      state.lastTickByServer.set(server.id, now);
      onlineTotal += current.size;
    }
    if (!successful) throw new Error(serverErrors[0] || 'All WARDOGS servers failed');
    if (successful === servers.length) {
      const zone = timeZone(bot), hour = hourInZone(new Date(now), zone);
      const bucket = state.stats.hours[hour] || { hour, samples: 0, playerSum: 0, maxPlayers: 0 };
      bucket.samples += 1; bucket.playerSum += onlineTotal; bucket.maxPlayers = Math.max(bucket.maxPlayers, onlineTotal); state.stats.hours[hour] = bucket;
    }
    state.stats.lastPollAt = nowIso();
    setRuntime(bot.id, {
      state: serverErrors.length ? 'online' : 'online',
      players: onlineTotal,
      trackedServers: servers.length,
      reachableServers: successful,
      lastCheck: nowIso(),
      lastError: serverErrors.length ? `${serverErrors.length}/${servers.length} server(s) failed: ${serverErrors.join(' · ')}`.slice(0, 500) : null
    });
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
    if (active.feedTimer) clearInterval(active.feedTimer);
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
  const servers = playtimeTrackerServers(bot);
  if (!servers.length) throw new Error('At least one WARDOGS server is required');
  if (servers.some((server) => !server.secretEnc)) throw new Error('Every tracked WARDOGS server needs an RCON/API password');
  const wantsDiscord = validSnowflake(bot.leaderboardChannelId) || servers.some((server) => validSnowflake(server.killFeedChannelId));
  let token = '';
  if (bot.botTokenEnc) { try { token = decryptSecret(bot.botTokenEnc); } catch {} }
  if (wantsDiscord && !token) throw new Error('Discord bot token is required when a leaderboard or killfeed channel is configured');
  const client = wantsDiscord ? new Client({ intents: [GatewayIntentBits.Guilds] }) : null;
  if (client) {
    client.on('interactionCreate', (interaction) => { if (String(interaction.customId || '').endsWith(`:${bot.id}`)) handleStatusInteraction(bot.id, interaction).catch(() => {}); });
    client.on('shardDisconnect', () => setRuntime(bot.id, { state: 'disconnected', needsRecovery: true, disconnectedAt: Date.now() }));
    client.on('shardError', (error) => setRuntime(bot.id, { state: 'error', lastError: String(error?.message || error).slice(0, 300), needsRecovery: true, disconnectedAt: Date.now() }));
    client.on('invalidated', () => setRuntime(bot.id, { state: 'disconnected', needsRecovery: true, disconnectedAt: Date.now() }));
    client.on('shardResume', () => clearRecovery(bot.id));
  }
  const state = {
    stats: normalizeStats(bot.playtimeStats, servers),
    onlineByServer: new Map(),
    lastTickByServer: new Map(),
    pollInFlight: false,
    client,
    lastSavedAt: 0,
    leaderboardMessageId: String(bot.leaderboardMessageId || '')
  };
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
    setRuntime(bot.id, { state: client ? 'connected' : 'online', botTag: client?.user?.tag || null, botId: client?.user?.id || null, lastError: null, trackedServers: servers.length });
    await pollOne(fresh, state);
    if (client) await publishAllKillfeeds(fresh, state, true);
    const timer = setInterval(() => {
      const latest = getManagedBot(bot.id);
      if (!latest?.enabled || !accessActive(latest)) return;
      pollOne(latest, state).catch(() => {});
    }, Math.max(10, Math.min(300, Number(fresh.pollSeconds) || 30)) * 1000);
    timer.unref?.();
    const feedTimer = client ? setInterval(() => {
      const latest = getManagedBot(bot.id);
      if (!latest?.enabled || !accessActive(latest)) return;
      publishAllKillfeeds(latest, state, false).catch(() => {});
    }, 5000) : null;
    feedTimer?.unref?.();
    instances.set(bot.id, { client, timer, feedTimer, signature: signature(fresh), state });
    clearRecovery(bot.id);
  } catch (error) {
    try { await client?.destroy?.(); } catch {}
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
export async function testPlaytimeWardogs(bot) {
  const servers = playtimeTrackerServers(bot);
  if (!servers.length) throw new Error('At least one WARDOGS server is required');
  const results = [];
  for (const server of servers) {
    const data = await wardogsRequest(bot, server, '/v1/players');
    results.push({ id: server.id, label: server.label, playerCount: listPlayers(data).length });
  }
  return { serverCount: results.length, playerCount: results.reduce((sum, row) => sum + row.playerCount, 0), servers: results };
}
export async function refreshPlaytimeTracker(bot, { publish = false } = {}) {
  const active = instances.get(bot.id);
  if (!active) throw new Error('WARDOGS Status Bot is not running');
  await pollOne(getManagedBot(bot.id) || bot, active.state, { forceLeaderboard: publish });
  if (publish && !validSnowflake((getManagedBot(bot.id) || bot).leaderboardChannelId)) throw new Error('Discord leaderboard channel ID is not configured');
  return playtimeTrackerSnapshot(getManagedBot(bot.id) || bot);
}
export function playtimeTrackerSnapshot(bot) {
  const servers = playtimeTrackerServers(bot);
  const active = instances.get(bot?.id);
  const stats = active?.state?.stats || normalizeStats(bot?.playtimeStats, servers);
  return { ...snapshotFromStats(stats, servers, active?.state?.onlineByServer || new Map()), runtime: playtimeBotRuntime(bot?.id), timezone: timeZone(bot) };
}
