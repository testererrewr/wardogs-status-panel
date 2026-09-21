import crypto from 'node:crypto';
import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { decryptSecret } from './crypto.js';
import { getManagedBot, upsertManagedBot } from './db.js';
import { safeHttpText } from './target-safety.js';
import { normalizeFactionKey, normalizeSteamId64, playerFaction, playerSteamId as canonicalPlayerSteamId, playerWardogsApiId } from './wardogs-players.js';
import { managedMatchBoundary } from './managed-welcome.js';
import { killStatsSnapshotFromStats, prettyCause } from './kill-stats.js';
import { WARDOGS_AUTH_MAX_FAILURES, createWardogsAuthLockedError, isWardogsAuthFailure, wardogsAuthLockedMessage } from './wardogs-auth.js';

export const PLAYTIME_SERVICE_ID = 'wardogs-playtime-tracker';
const instances = new Map();
const runtime = new Map();
const locks = new Map();
const recoveryState = new Map();
const wardogsAuthFailures = new Map();
const linkRequestCooldowns = new Map();
const LEADERBOARD_MS = 6 * 60 * 60 * 1000;
const SAVE_MS = 60 * 1000;
const LINK_CODE_TTL_MS = 10 * 60 * 1000;
const LEADERBOARD_TOP = 15;

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

function playtimeAuthKey(bot, server) { return `${String(bot?.id||'')}:${baseUrl(server?.baseUrl).toLowerCase()}`; }
function assertPlaytimeWardogsAuthAllowed(bot, server) {
  const fresh=getManagedBot(bot?.id)||bot;
  if(fresh?.wardogsAuthLockedAt)throw createWardogsAuthLockedError(fresh.wardogsAuthLockedReason||'WARDOGS authentication is locked');
  const key=playtimeAuthKey(bot,server),previous=wardogsAuthFailures.get(key);
  if(previous&&String(previous.restartNonce||0)!==String(fresh?.restartNonce||bot?.restartNonce||0))wardogsAuthFailures.delete(key);
}
function recordPlaytimeWardogsAuthFailure(bot, server, error) {
  if(!isWardogsAuthFailure(error))return error;
  const fresh=getManagedBot(bot?.id)||bot,key=playtimeAuthKey(bot,server),restartNonce=fresh?.restartNonce||bot?.restartNonce||0;
  const previous=wardogsAuthFailures.get(key);
  const attempts=String(previous?.restartNonce||0)===String(restartNonce)?Number(previous?.attempts||0)+1:1;
  const reason=String(error?.message||error||'WARDOGS authentication failed').slice(0,300);
  wardogsAuthFailures.set(key,{attempts,restartNonce,reason});
  setRuntime(bot.id,{authFailureCount:attempts,lastError:`${reason} · Loginversuch ${attempts}/${WARDOGS_AUTH_MAX_FAILURES}`});
  if(attempts<WARDOGS_AUTH_MAX_FAILURES)return error;
  const lockedAt=nowIso();
  upsertManagedBot({id:bot.id,enabled:false,wardogsAuthLockedAt:lockedAt,wardogsAuthLockedReason:reason,wardogsAuthFailureCount:attempts});
  recoveryState.delete(bot.id);
  setRuntime(bot.id,{state:'auth-locked',lastError:wardogsAuthLockedMessage(reason),authFailureCount:attempts,authLockedAt:lockedAt,requiresManualRestart:true,needsRecovery:false,nextRecoveryAt:null});
  return createWardogsAuthLockedError(reason);
}

async function wardogsRequest(bot, server, pathname, { method = 'GET', body = undefined } = {}) {
  assertPlaytimeWardogsAuthAllowed(bot,server);
  const root = baseUrl(server?.baseUrl);
  if (!root) throw new Error(`${server?.label || 'WARDOGS server'}: base URL is missing`);
  let secret = '';
  try { secret = decryptSecret(server?.secretEnc); } catch { secret = ''; }
  if (!secret) throw new Error(`${server?.label || 'WARDOGS server'}: RCON/API password is missing`);
  const response = await safeHttpText(`${root}${pathname}`, {
    allowPrivate: Boolean(bot?.allowPrivateTarget),
    method,
    headers: { Accept: 'application/json', Authorization: `Bearer ${secret}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    timeoutMs: 8000, maxBytes: 1024 * 1024
  });
  if (response.status >= 300 && response.status < 400) throw new Error(`${server?.label || 'WARDOGS server'}: API redirects are not allowed`);
  const text = response.text;
  let data = {};
  if (text) { try { data = JSON.parse(text); } catch { data = { message: text.slice(0, 300) }; } }
  if (!response.ok) {
    const error=new Error(`${server?.label || 'WARDOGS server'}: WARDOGS API ${response.status}: ${String(data?.error?.message || data?.message || data?.error || 'Error').slice(0, 220)}`);
    error.status=response.status;
    throw recordPlaytimeWardogsAuthFailure(bot,server,error);
  }
  wardogsAuthFailures.delete(playtimeAuthKey(bot,server));
  return data;
}

function playerSteamId(player) {
  return canonicalPlayerSteamId(player);
}
function playerDisplayName(player, fallback = '') {
  for (const value of [player?.name, player?.playerName, player?.displayName, player?.steamName, player?.username, fallback]) {
    const clean = String(value ?? '').trim();
    if (clean) return clean.slice(0, 100);
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
      seedingSeconds: Math.max(0, Number(row?.seedingSeconds) || 0),
      sessionCount: Math.max(0, Math.floor(Number(row?.sessionCount) || 0)),
      matchesPlayed: Math.max(0, Math.floor(Number(row?.matchesPlayed) || 0)),
      matchWins: Math.max(0, Math.floor(Number(row?.matchWins) || 0)),
      lastFaction: String(row?.lastFaction || '').slice(0, 80),
      firstSeenAt: row?.firstSeenAt || null,
      lastSeenAt: row?.lastSeenAt || null
    };
  }
  const match = stats.matchTracker && typeof stats.matchTracker === 'object' ? stats.matchTracker : {};
  const participants = match.participants && typeof match.participants === 'object' && !Array.isArray(match.participants) ? match.participants : {};
  stats.matchTracker = {
    snapshot: match.snapshot && typeof match.snapshot === 'object' ? match.snapshot : null,
    startedAt: match.startedAt || null,
    participants: Object.fromEntries(Object.entries(participants).map(([steamId, row]) => [steamId, {
      name: String(row?.name || steamId).slice(0, 100),
      faction: String(row?.faction || '').slice(0, 80)
    }]).filter(([steamId]) => normalizeSteamId64(steamId)))
  };
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
    seedingSeconds: Math.max(0, Number(p?.seedingSeconds) || 0),
    sessionCount: Math.max(0, Number(p?.sessionCount) || 0),
    matchesPlayed: Math.max(0, Number(p?.matchesPlayed) || 0),
    matchWins: Math.max(0, Number(p?.matchWins) || 0),
    lastFaction: String(p?.lastFaction || ''),
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
      const current = players.get(row.steamId) || { steamId: row.steamId, name: row.name, clanTag: row.clanTag, totalSeconds: 0, seedingSeconds: 0, sessionCount: 0, matchesPlayed: 0, matchWins: 0, lastFaction: '', firstSeenAt: row.firstSeenAt, lastSeenAt: row.lastSeenAt, online: false, servers: [] };
      current.name = row.name || current.name;
      current.clanTag = row.clanTag || current.clanTag;
      current.totalSeconds += row.totalSeconds;
      current.seedingSeconds += row.seedingSeconds;
      current.sessionCount += row.sessionCount;
      current.matchesPlayed += row.matchesPlayed;
      current.matchWins += row.matchWins;
      current.lastFaction = row.lastFaction || current.lastFaction;
      current.online ||= row.online;
      if (!current.firstSeenAt || (row.firstSeenAt && String(row.firstSeenAt) < String(current.firstSeenAt))) current.firstSeenAt = row.firstSeenAt;
      if (!current.lastSeenAt || (row.lastSeenAt && String(row.lastSeenAt) > String(current.lastSeenAt))) current.lastSeenAt = row.lastSeenAt;
      current.servers.push({ id: server.id, label: server.label, totalSeconds: row.totalSeconds, seedingSeconds: row.seedingSeconds, sessionCount: row.sessionCount, matchesPlayed: row.matchesPlayed, matchWins: row.matchWins, online: row.online, lastSeenAt: row.lastSeenAt });
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

function cleanDisplayName(value, fallback = 'Unbekannt') {
  return String(value || fallback).replace(/[\r\n`*_~|>]/g, '').trim().slice(0, 42) || fallback;
}
function formatNumber(value, digits = 0) {
  const n = Number(value || 0);
  return n.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function formatHoursCompact(seconds) {
  return `${formatNumber(Math.max(0, Number(seconds) || 0) / 3600, 1)} Std`;
}
export function combinedStatsSnapshot(bot, state = null) {
  const servers = playtimeTrackerServers(bot);
  const playStats = state?.stats || normalizeStats(bot?.playtimeStats, servers);
  const play = snapshotFromStats(playStats, servers, state?.onlineByServer || new Map());
  const kill = killStatsSnapshotFromStats(bot?.killStats);
  const byId = new Map();
  for (const row of play.rows) byId.set(row.steamId, {
    steamId: row.steamId, name: row.name, aliases: [], totalSeconds: row.totalSeconds, seedingSeconds: row.seedingSeconds,
    matchesPlayed: row.matchesPlayed, matchWins: row.matchWins, lastFaction: row.lastFaction, online: row.online,
    firstSeenAt: row.firstSeenAt, lastSeenAt: row.lastSeenAt, kills: 0, deaths: 0, kd: 0, headshots: 0, headshotRate: 0,
    killRecord: 0, longestKillMeters: 0, topCauses: []
  });
  for (const row of kill.players) {
    const current = byId.get(row.steamId) || {
      steamId: row.steamId, name: row.name, aliases: [], totalSeconds: 0, seedingSeconds: 0, matchesPlayed: 0, matchWins: 0,
      lastFaction: '', online: false, firstSeenAt: row.firstSeenAt, lastSeenAt: row.lastSeenAt
    };
    current.name = row.name || current.name;
    current.aliases = Array.isArray(row.aliases) ? row.aliases : [];
    current.kills = Math.max(0, Number(row.kills) || 0);
    current.deaths = Math.max(0, Number(row.deaths) || 0);
    current.kd = current.deaths > 0 ? current.kills / current.deaths : current.kills;
    current.headshots = Math.max(0, Number(row.headshots) || 0);
    current.headshotRate = current.kills > 0 ? current.headshots / current.kills : 0;
    current.killRecord = Math.max(0, Number(row.killRecord) || 0);
    current.longestKillMeters = Math.max(0, Number(row.longestKillMeters) || 0);
    current.topCauses = Array.isArray(row.topCauses) ? row.topCauses : [];
    if (!current.firstSeenAt || (row.firstSeenAt && String(row.firstSeenAt) < String(current.firstSeenAt))) current.firstSeenAt = row.firstSeenAt;
    if (!current.lastSeenAt || (row.lastSeenAt && String(row.lastSeenAt) > String(current.lastSeenAt))) current.lastSeenAt = row.lastSeenAt;
    byId.set(row.steamId, current);
  }
  const players = [...byId.values()].map((row) => ({
    ...row,
    winRate: Number(row.matchesPlayed || 0) > 0 ? Number(row.matchWins || 0) / Number(row.matchesPlayed || 0) : 0
  }));
  const sorter = (metric, secondary = 'kills') => (a, b) => Number(b?.[metric] || 0) - Number(a?.[metric] || 0)
    || Number(b?.[secondary] || 0) - Number(a?.[secondary] || 0)
    || cleanDisplayName(a?.name).localeCompare(cleanDisplayName(b?.name), 'de');
  const categories = [
    { id: 'kills', label: '🗡️ Kills', rows: players.slice().sort(sorter('kills')), format: (p) => formatNumber(p.kills) },
    { id: 'deaths', label: '☠️ Tode', rows: players.slice().sort(sorter('deaths')), format: (p) => formatNumber(p.deaths) },
    { id: 'kd', label: '🎯 K/D (ab 100 Kills)', rows: players.filter((p) => p.kills >= 100).sort(sorter('kd')), format: (p) => formatNumber(p.kd, 2) },
    { id: 'playtime', label: '⏱️ Spielzeit', rows: players.slice().sort(sorter('totalSeconds')), format: (p) => formatHoursCompact(p.totalSeconds) },
    { id: 'killrecord', label: '💥 Kill-Rekord / Match', rows: players.slice().sort(sorter('killRecord')), format: (p) => formatNumber(p.killRecord) },
    { id: 'headshots', label: '🎯 Headshot-Rate', rows: players.filter((p) => p.kills > 0).sort(sorter('headshotRate')), format: (p) => `${formatNumber(p.headshotRate * 100, 1)}%` },
    { id: 'wins', label: '🏆 Match-Siege', rows: players.slice().sort(sorter('matchWins')), format: (p) => `${formatNumber(p.matchWins)} (${formatNumber(p.winRate * 100, 0)}%)` },
    { id: 'matches', label: '🎮 Matches gespielt', rows: players.slice().sort(sorter('matchesPlayed')), format: (p) => formatNumber(p.matchesPlayed) },
    { id: 'seeding', label: '🌱 Seeding-Zeit (1–20)', rows: players.slice().sort(sorter('seedingSeconds')), format: (p) => formatHoursCompact(p.seedingSeconds) }
  ];
  return { players, play, kill, categories, startedAt: play.startedAt || kill.startedAt || null };
}
export function searchCombinedPlayers(snapshot, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const exactSteam = normalizeSteamId64(q);
  const rows = snapshot?.players || [];
  return rows.filter((p) => {
    if (exactSteam && p.steamId === exactSteam) return true;
    if (String(p.steamId || '').includes(q)) return true;
    if (String(p.name || '').toLowerCase().includes(q)) return true;
    return (p.aliases || []).some((name) => String(name || '').toLowerCase().includes(q));
  }).sort((a, b) => {
    const ae = String(a.name || '').toLowerCase() === q ? 0 : 1;
    const be = String(b.name || '').toLowerCase() === q ? 0 : 1;
    return ae - be || Number(b.kills || 0) - Number(a.kills || 0) || Number(b.totalSeconds || 0) - Number(a.totalSeconds || 0);
  }).slice(0, 25);
}
export function leaderboardPositions(snapshot, steamId) {
  const out = {};
  for (const category of snapshot.categories || []) {
    const index = category.rows.findIndex((row) => row.steamId === steamId);
    out[category.id] = index >= 0 ? index + 1 : null;
  }
  return out;
}
function playerStatsEmbed(bot, player, snapshot, { showIdentity = false, discordUser = null } = {}) {
  const ranks = leaderboardPositions(snapshot, player?.steamId);
  const lastSeen = player?.lastSeenAt ? `<t:${Math.floor(Date.parse(player.lastSeenAt) / 1000)}:R>` : '—';
  const titleName = cleanDisplayName(player?.name || player?.steamId);
  const identity = [discordUser ? `Discord: <@${discordUser.id}>` : '', showIdentity ? `Ingame: **${titleName}**` : '', showIdentity ? `SteamID64: \`${player?.steamId || '—'}\`` : ''].filter(Boolean).join('\n');
  const rankText = [
    ['Kills', ranks.kills], ['Tode', ranks.deaths], ['K/D', ranks.kd], ['Spielzeit', ranks.playtime],
    ['Kill-Rekord', ranks.killrecord], ['Headshots', ranks.headshots], ['Siege', ranks.wins],
    ['Matches', ranks.matches], ['Seeding', ranks.seeding]
  ].map(([label, rank]) => `${label}: ${rank ? `#${rank}` : '—'}`).join(' · ');
  const embed = new EmbedBuilder()
    .setTitle(`📊 ${titleName}`)
    .setDescription(identity || `Zuletzt gesehen: ${lastSeen}`)
    .addFields(
      { name: 'Kills', value: formatNumber(player?.kills), inline: true },
      { name: 'Tode', value: formatNumber(player?.deaths), inline: true },
      { name: 'K/D', value: formatNumber(player?.kd, 2), inline: true },
      { name: 'Spielzeit', value: formatHoursCompact(player?.totalSeconds), inline: true },
      { name: 'Kill-Rekord / Match', value: formatNumber(player?.killRecord), inline: true },
      { name: 'Headshot-Rate', value: `${formatNumber(Number(player?.headshotRate || 0) * 100, 1)}%`, inline: true },
      { name: 'Match-Siege', value: `${formatNumber(player?.matchWins)} (${formatNumber(Number(player?.winRate || 0) * 100, 0)}%)`, inline: true },
      { name: 'Matches gespielt', value: formatNumber(player?.matchesPlayed), inline: true },
      { name: 'Seeding-Zeit', value: formatHoursCompact(player?.seedingSeconds), inline: true },
      { name: 'Leaderboard-Position', value: rankText.slice(0, 1024), inline: false },
      { name: 'Zuletzt gesehen', value: lastSeen, inline: true },
      { name: 'Letzte Fraktion', value: String(player?.lastFaction || '—').slice(0, 80), inline: true }
    )
    .setFooter({ text: 'WARDOGS Status Bot · All-Time Stats über alle verbundenen Server' })
    .setTimestamp(new Date(player?.lastSeenAt || Date.now()));
  return embed;
}
function leaderboardField(category) {
  const medals = ['🥇', '🥈', '🥉'];
  const rows = category.rows.slice(0, LEADERBOARD_TOP);
  const value = rows.length ? rows.map((p, index) => `${medals[index] || `**${index + 1}.**`} ${cleanDisplayName(p.name, p.steamId).slice(0, 18)} — **${category.format(p)}**`).join('\n') : 'Noch keine Daten.';
  return { name: category.label, value: value.slice(0, 1024), inline: true };
}
export async function buildLeaderboardPayload(bot, state) {
  const snapshot = combinedStatsSnapshot(bot, state);
  const fields = snapshot.categories.map(leaderboardField);
  const groups = [];
  for (let i = 0; i < fields.length; i += 2) groups.push(fields.slice(i, i + 2));
  const embeds = groups.map((group, index) => {
    const embed = new EmbedBuilder().addFields(...group);
    if (index === 0) {
      embed.setTitle('🏆 All-Time Leaderboard · Top 15 pro Kategorie')
        .setDescription(`${snapshot.players.length} Spieler erfasst${snapshot.startedAt ? ` seit <t:${Math.floor(Date.parse(snapshot.startedAt) / 1000)}:D>` : ''}. Nutze die Suche darunter für die genaue Position eines Spielers.`);
    }
    if (index === groups.length - 1) embed.setFooter({ text: 'WARDOGS Status Bot · status-hub.lol · automatische Aktualisierung alle 6 Stunden' }).setTimestamp(new Date());
    return embed;
  });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`wdstatus:search:${bot.id}`).setLabel('Spieler suchen').setStyle(ButtonStyle.Primary)
  );
  return { embeds, components: [row], allowedMentions: { parse: [] } };
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
    new ButtonBuilder().setCustomId(`wdstatus:top:${bot.id}`).setLabel('Leaderboard').setStyle(ButtonStyle.Secondary)
  );
  return { embeds: [embed], components: [row], allowedMentions: { parse: [] } };
}
function killStatsSearchModal(botId) {
  return new ModalBuilder().setCustomId(`wdstatus:searchmodal:${botId}`).setTitle('Spieler suchen').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('query').setLabel('Name, Alias oder SteamID64').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100))
  );
}
function linkCodeModal(botId) {
  return new ModalBuilder().setCustomId(`wdstatus:linkcodemodal:${botId}`).setTitle('Game-Account verknüpfen').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('code').setLabel('6-stelliger Code aus dem Ingame-Whisper').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(6).setMaxLength(6).setPlaceholder('123456'))
  );
}
function playerPickRow(botId, matches, customId = `wdstatus:pick:${botId}`) {
  const options = matches.slice(0, 25).map((player) => ({
    label: cleanDisplayName(player?.name || player?.steamId).slice(0, 100),
    description: `${formatNumber(player?.kills)} Kills · ${formatHoursCompact(player?.totalSeconds)} · ${player?.steamId || '—'}`.slice(0, 100),
    value: String(player?.steamId || '').slice(0, 100)
  })).filter((row) => row.value);
  const menu = new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder('Spieler auswählen…').addOptions(options);
  return new ActionRowBuilder().addComponents(menu);
}
function playerLinks(bot) {
  return (Array.isArray(bot?.discordPlayerLinks) ? bot.discordPlayerLinks : []).map((row) => ({
    discordUserId: String(row?.discordUserId || ''), steamId: normalizeSteamId64(row?.steamId), playerName: String(row?.playerName || '').slice(0, 100),
    linkedAt: row?.linkedAt || null, lastVerifiedAt: row?.lastVerifiedAt || row?.linkedAt || null
  })).filter((row) => validSnowflake(row.discordUserId) && row.steamId);
}
function linkForDiscordUser(bot, discordUserId) { return playerLinks(bot).find((row) => row.discordUserId === String(discordUserId || '')) || null; }
function challengeHash(botId, discordUserId, code) { return crypto.createHash('sha256').update(`${botId}:${discordUserId}:${String(code || '').trim()}`).digest('hex'); }
function liveChallenges(bot) {
  const now = Date.now();
  return (Array.isArray(bot?.playerLinkChallenges) ? bot.playerLinkChallenges : []).map((row) => ({
    discordUserId: String(row?.discordUserId || ''), steamId: normalizeSteamId64(row?.steamId), playerName: String(row?.playerName || '').slice(0, 100),
    serverId: String(row?.serverId || '').slice(0, 64), codeHash: String(row?.codeHash || ''), expiresAt: row?.expiresAt || null,
    attempts: Math.max(0, Math.floor(Number(row?.attempts) || 0)), createdAt: row?.createdAt || null
  })).filter((row) => validSnowflake(row.discordUserId) && row.steamId && /^[0-9a-f]{64}$/i.test(row.codeHash) && Date.parse(row.expiresAt || '') > now);
}
async function onlineLinkCandidates(bot, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const exactSteam = normalizeSteamId64(q);
  const out = [];
  for (const server of playtimeTrackerServers(bot)) {
    let data;
    try { data = await wardogsRequest(bot, server, '/v1/players'); }
    catch (error) { if (error?.wardogsAuthLocked || isWardogsAuthFailure(error)) throw error; continue; }
    for (const player of listPlayers(data)) {
      const steamId = playerSteamId(player);
      const name = playerDisplayName(player, steamId);
      if (!steamId) continue;
      if (exactSteam ? steamId !== exactSteam : !name.toLowerCase().includes(q)) continue;
      out.push({ steamId, name, serverId: server.id, serverLabel: server.label });
    }
  }
  const seen = new Set();
  return out.sort((a, b) => (a.name.toLowerCase() === q ? 0 : 1) - (b.name.toLowerCase() === q ? 0 : 1) || a.name.localeCompare(b.name, 'de'))
    .filter((row) => !seen.has(row.steamId) && seen.add(row.steamId)).slice(0, 25);
}
function linkCandidatePickRow(botId, candidates) {
  const options = candidates.map((row) => ({
    label: cleanDisplayName(row.name, row.steamId).slice(0, 100),
    description: `${row.serverLabel} · ${row.steamId}`.slice(0, 100),
    value: `${row.serverId}:${row.steamId}`.slice(0, 100)
  }));
  return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`wdstatus:linkpick:${botId}`).setPlaceholder('Richtigen Ingame-Spieler auswählen…').addOptions(options));
}
function codeButtonRow(botId) {
  return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`wdstatus:linkcode:${botId}`).setLabel('Code eingeben').setStyle(ButtonStyle.Primary));
}
async function sendLinkWhisper(bot, serverId, steamId, code) {
  const server = playtimeTrackerServers(bot).find((row) => String(row.id) === String(serverId));
  if (!server) throw new Error('Der ausgewählte WARDOGS Server wurde nicht gefunden.');
  const data = await wardogsRequest(bot, server, '/v1/players');
  const player = listPlayers(data).find((row) => playerSteamId(row) === steamId);
  if (!player) throw new Error('Der Spieler ist nicht mehr online. Starte /linkgame erneut.');
  const ids = [...new Set([playerWardogsApiId(player), steamId].map((value) => String(value || '').trim()).filter(Boolean))];
  const message = `Discord Verifizierungscode: ${code}. Im Discord-Popup eingeben. Gültig 10 Minuten.`;
  let lastError = null;
  for (let index = 0; index < ids.length; index += 1) {
    try { await wardogsRequest(bot, server, `/v1/players/${encodeURIComponent(ids[index])}/message`, { method: 'POST', body: { message } }); return player; }
    catch (error) {
      lastError = error;
      if (index + 1 < ids.length && [400, 404, 422].includes(Number(error?.status || 0))) continue;
      break;
    }
  }
  throw lastError || new Error('WARDOGS Whisper konnte nicht gesendet werden.');
}
async function beginLinkChallenge(bot, discordUserId, serverId, steamId, playerName = '') {
  const fresh = getManagedBot(bot.id) || bot;
  const existingForSteam = playerLinks(fresh).find((row) => row.steamId === steamId && row.discordUserId !== String(discordUserId));
  if (existingForSteam) throw new Error('Dieser Ingame-Account ist bereits mit einem anderen Discord-Account verknüpft.');
  const cooldownKey = `${bot.id}:${discordUserId}`;
  if (linkRequestCooldowns.size > 5000) for (const [key, until] of linkRequestCooldowns) if (Number(until) <= Date.now()) linkRequestCooldowns.delete(key);
  const retryAt = Number(linkRequestCooldowns.get(cooldownKey) || 0);
  if (retryAt > Date.now()) throw new Error(`Bitte warte noch ${Math.max(1, Math.ceil((retryAt - Date.now()) / 1000))} Sekunden, bevor du einen neuen Whisper-Code anforderst.`);
  const code = String(crypto.randomInt(100000, 1000000));
  const player = await sendLinkWhisper(fresh, serverId, steamId, code);
  linkRequestCooldowns.set(cooldownKey, Date.now() + 60_000);
  const challenges = liveChallenges(getManagedBot(bot.id) || fresh).filter((row) => row.discordUserId !== String(discordUserId));
  challenges.push({
    discordUserId: String(discordUserId), steamId, playerName: playerDisplayName(player, playerName || steamId), serverId: String(serverId),
    codeHash: challengeHash(bot.id, discordUserId, code), expiresAt: new Date(Date.now() + LINK_CODE_TTL_MS).toISOString(), attempts: 0, createdAt: nowIso()
  });
  upsertManagedBot({ id: bot.id, playerLinkChallenges: challenges.slice(-100) });
  return { steamId, playerName: playerDisplayName(player, playerName || steamId) };
}
function verifyLinkCode(bot, discordUserId, code) {
  const fresh = getManagedBot(bot.id) || bot;
  const challenges = liveChallenges(fresh);
  const challenge = challenges.find((row) => row.discordUserId === String(discordUserId));
  if (!challenge) return { ok: false, message: 'Kein aktiver Verifizierungscode gefunden. Starte /linkgame erneut.' };
  const actual = challengeHash(bot.id, discordUserId, code);
  const expected = String(challenge.codeHash || '');
  const equal = expected.length === actual.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
  if (!equal) {
    challenge.attempts += 1;
    const remaining = Math.max(0, 5 - challenge.attempts);
    const next = challenge.attempts >= 5 ? challenges.filter((row) => row !== challenge) : challenges;
    upsertManagedBot({ id: bot.id, playerLinkChallenges: next });
    return { ok: false, message: remaining ? `Code ist falsch. Noch ${remaining} Versuch${remaining === 1 ? '' : 'e'}.` : 'Zu viele falsche Codes. Starte /linkgame erneut.' };
  }
  const links = playerLinks(fresh);
  const other = links.find((row) => row.steamId === challenge.steamId && row.discordUserId !== String(discordUserId));
  if (other) return { ok: false, message: 'Dieser Ingame-Account ist inzwischen mit einem anderen Discord-Account verknüpft.' };
  const nextLinks = links.filter((row) => row.discordUserId !== String(discordUserId) && row.steamId !== challenge.steamId);
  nextLinks.push({ discordUserId: String(discordUserId), steamId: challenge.steamId, playerName: challenge.playerName, linkedAt: nowIso(), lastVerifiedAt: nowIso() });
  upsertManagedBot({ id: bot.id, discordPlayerLinks: nextLinks.slice(-5000), playerLinkChallenges: challenges.filter((row) => row !== challenge) });
  return { ok: true, link: nextLinks.at(-1) };
}
function slashCommands() {
  return [
    { name: 'linkgame', description: 'Verknüpft deinen Discord-Account sicher mit deinem WARDOGS/Steam-Spieler.', options: [{ type: 3, name: 'spieler', description: 'Steam-/Ingame-Name des aktuell online befindlichen Spielers', required: true, maxLength: 100 }] },
    { name: 'status', description: 'Zeigt die Stats eines verknüpften Discord-Accounts.', options: [{ type: 6, name: 'user', description: 'Optional: anderer verknüpfter Discord-User', required: false }] },
    { name: 'whois', description: 'Zeigt Ingame-Account und Stats eines Discord-Users.', options: [{ type: 6, name: 'user', description: 'Discord-User; ohne Auswahl wird dein Account verwendet', required: false }] },
    { name: 'whoisplayer', description: 'Zeigt deinen verknüpften Ingame-Account und deine Stats.', options: [{ type: 6, name: 'user', description: 'Optional: anderer verknüpfter Discord-User', required: false }] },
    { name: 'playerstats', description: 'Sucht Stats zu einem Ingame-Spieler, auch ohne Discord-Verknüpfung.', options: [{ type: 3, name: 'spieler', description: 'Ingame-Name, Alias oder SteamID64', required: true, maxLength: 100 }] }
  ];
}
async function registerSlashCommands(client, botId) {
  const commands = slashCommands();
  const errors = [];
  for (const guild of client.guilds.cache.values()) {
    try { await guild.commands.set(commands); }
    catch (error) { errors.push(`${guild.name}: ${String(error?.message || error).slice(0, 120)}`); }
  }
  setRuntime(botId, { slashCommandsReady: errors.length === 0, slashCommandError: errors.length ? errors.join(' · ').slice(0, 500) : null });
}
async function handleStatusCommand(botId, interaction) {
  const bot = getManagedBot(botId); if (!bot) return;
  const command = String(interaction.commandName || '').toLowerCase();
  if (command === 'linkgame') {
    await interaction.deferReply({ ephemeral: true });
    try {
      const query = interaction.options.getString('spieler', true);
      const matches = await onlineLinkCandidates(bot, query);
      if (!matches.length) return interaction.editReply({ content: `Kein aktuell **online** befindlicher Spieler passt zu **${cleanDisplayName(query)}**. Du musst im WARDOGS Server online sein, damit der Code per Whisper zugestellt werden kann.` });
      if (matches.length > 1) return interaction.editReply({ content: 'Mehrere Spieler passen. Wähle deinen Account aus:', components: [linkCandidatePickRow(botId, matches)] });
      const challenge = await beginLinkChallenge(bot, interaction.user.id, matches[0].serverId, matches[0].steamId, matches[0].name);
      return interaction.editReply({ content: `Whisper an **${cleanDisplayName(challenge.playerName)}** gesendet. Öffne jetzt das Popup und gib den 6-stelligen Code ein.`, components: [codeButtonRow(botId)] });
    } catch (error) { return interaction.editReply({ content: `Verknüpfung fehlgeschlagen: ${String(error?.message || error).slice(0, 300)}` }); }
  }
  if (['status', 'whois', 'whoisplayer'].includes(command)) {
    const target = interaction.options.getUser('user') || interaction.user;
    const link = linkForDiscordUser(bot, target.id);
    if (!link) return interaction.reply({ content: `${target.id === interaction.user.id ? 'Du hast' : `<@${target.id}> hat`} noch keinen WARDOGS Account verknüpft. Nutze **/linkgame**.`, allowedMentions: { users: [target.id] } });
    const snapshot = combinedStatsSnapshot(bot, instances.get(botId)?.state || null);
    const player = snapshot.players.find((row) => row.steamId === link.steamId) || { steamId: link.steamId, name: link.playerName, aliases: [], kills: 0, deaths: 0, kd: 0, totalSeconds: 0, seedingSeconds: 0, killRecord: 0, headshotRate: 0, matchWins: 0, matchesPlayed: 0, winRate: 0 };
    return interaction.reply({ embeds: [playerStatsEmbed(bot, player, snapshot, { showIdentity: command !== 'status', discordUser: command !== 'status' ? target : null })], allowedMentions: { users: [target.id] } });
  }
  if (command === 'playerstats') {
    const query = interaction.options.getString('spieler', true);
    const snapshot = combinedStatsSnapshot(bot, instances.get(botId)?.state || null);
    const matches = searchCombinedPlayers(snapshot, query);
    if (!matches.length) return interaction.reply({ content: `Kein getrackter Spieler für **${cleanDisplayName(query)}** gefunden.`, ephemeral: true });
    const exact = normalizeSteamId64(query);
    const exactPlayer = exact ? matches.find((row) => row.steamId === exact) : null;
    if (exactPlayer || matches.length === 1) return interaction.reply({ embeds: [playerStatsEmbed(bot, exactPlayer || matches[0], snapshot, { showIdentity: true })], allowedMentions: { parse: [] } });
    return interaction.reply({ ephemeral: true, content: `Mehrere Spieler passen zu **${cleanDisplayName(query)}**. Bitte auswählen:`, components: [playerPickRow(botId, matches)], allowedMentions: { parse: [] } });
  }
}
async function handleStatusInteraction(botId, interaction) {
  const bot = getManagedBot(botId); if (!bot) return;
  if (interaction.isChatInputCommand?.()) return handleStatusCommand(botId, interaction);
  const id = String(interaction.customId || '');
  if (id === `wdstatus:search:${botId}` && interaction.isButton()) return interaction.showModal(killStatsSearchModal(botId));
  if (id === `wdstatus:top:${botId}` && interaction.isButton()) {
    const active = instances.get(botId);
    const payload = await buildLeaderboardPayload(bot, active?.state || null);
    return interaction.reply({ ...payload, ephemeral: true });
  }
  if (id === `wdstatus:searchmodal:${botId}` && interaction.isModalSubmit()) {
    const query = interaction.fields.getTextInputValue('query');
    const snapshot = combinedStatsSnapshot(bot, instances.get(botId)?.state || null);
    const matches = searchCombinedPlayers(snapshot, query);
    if (!matches.length) return interaction.reply({ ephemeral: true, content: `Kein getrackter Spieler für \`${String(query).slice(0,80)}\` gefunden.` });
    const exact = normalizeSteamId64(query);
    const exactPlayer = exact ? matches.find((p) => p.steamId === exact) : null;
    if (exactPlayer || matches.length === 1) return interaction.reply({ ephemeral: true, embeds: [playerStatsEmbed(bot, exactPlayer || matches[0], snapshot, { showIdentity: true })], allowedMentions: { parse: [] } });
    return interaction.reply({ ephemeral: true, content: `Mehrere Spieler passen zu **${cleanDisplayName(query)}**. Bitte auswählen:`, components: [playerPickRow(botId, matches)], allowedMentions: { parse: [] } });
  }
  if (id === `wdstatus:pick:${botId}` && interaction.isStringSelectMenu()) {
    const steamId = normalizeSteamId64(interaction.values?.[0]);
    const snapshot = combinedStatsSnapshot(bot, instances.get(botId)?.state || null);
    const player = snapshot.players.find((row) => row.steamId === steamId);
    if (!player) return interaction.update({ content: 'Spieler wurde nicht mehr in den gespeicherten Stats gefunden.', embeds: [], components: [] });
    return interaction.update({ content: null, embeds: [playerStatsEmbed(bot, player, snapshot, { showIdentity: true })], components: [], allowedMentions: { parse: [] } });
  }
  if (id === `wdstatus:linkpick:${botId}` && interaction.isStringSelectMenu()) {
    const raw = String(interaction.values?.[0] || '');
    const split = raw.lastIndexOf(':');
    const serverId = split > 0 ? raw.slice(0, split) : '';
    const steamId = normalizeSteamId64(split > 0 ? raw.slice(split + 1) : '');
    if (!serverId || !steamId) return interaction.update({ content: 'Ungültige Spielerauswahl. Starte /linkgame erneut.', components: [] });
    try {
      const challenge = await beginLinkChallenge(bot, interaction.user.id, serverId, steamId);
      return interaction.update({ content: `Whisper an **${cleanDisplayName(challenge.playerName)}** gesendet. Klicke auf **Code eingeben** und bestätige den 6-stelligen Code.`, components: [codeButtonRow(botId)] });
    } catch (error) { return interaction.update({ content: `Verknüpfung fehlgeschlagen: ${String(error?.message || error).slice(0, 300)}`, components: [] }); }
  }
  if (id === `wdstatus:linkcode:${botId}` && interaction.isButton()) return interaction.showModal(linkCodeModal(botId));
  if (id === `wdstatus:linkcodemodal:${botId}` && interaction.isModalSubmit()) {
    const result = verifyLinkCode(bot, interaction.user.id, interaction.fields.getTextInputValue('code'));
    if (!result.ok) return interaction.reply({ ephemeral: true, content: result.message });
    return interaction.reply({ ephemeral: true, content: `✅ Verknüpft: dein Discord-Account gehört jetzt zu **${cleanDisplayName(result.link.playerName, result.link.steamId)}**. /status zeigt ab sofort deine Stats.` });
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

export function finalizeTrackedMatch(serverStats, tracker) {
  const participants = tracker?.participants && typeof tracker.participants === 'object' ? tracker.participants : {};
  const ids = Object.keys(participants).filter((steamId) => normalizeSteamId64(steamId));
  if (!ids.length) return 0;
  const scoreRows = Object.entries(tracker?.snapshot?.scores || {}).map(([key, value]) => [normalizeFactionKey(key), Number(value)]).filter(([key, value]) => key && Number.isFinite(value));
  let winner = '';
  if (scoreRows.length) {
    const max = Math.max(...scoreRows.map(([, value]) => value));
    const winners = scoreRows.filter(([, value]) => value === max).map(([key]) => key);
    if (max > 0 && winners.length === 1) winner = winners[0];
  }
  let updated = 0;
  for (const steamId of ids) {
    const record = serverStats.players[steamId];
    if (!record) continue;
    record.matchesPlayed = Math.max(0, Number(record.matchesPlayed) || 0) + 1;
    const faction = normalizeFactionKey(participants[steamId]?.faction || record.lastFaction || '');
    if (winner && faction && faction === winner) record.matchWins = Math.max(0, Number(record.matchWins) || 0) + 1;
    updated += 1;
  }
  return updated;
}

function updateMatchTracker(serverStats, current, status) {
  if (!status || typeof status !== 'object') return;
  const tracker = serverStats.matchTracker && typeof serverStats.matchTracker === 'object' ? serverStats.matchTracker : { snapshot: null, participants: {}, startedAt: null };
  const boundary = managedMatchBoundary(tracker.snapshot, status);
  if (boundary.changed) {
    finalizeTrackedMatch(serverStats, tracker);
    tracker.participants = {};
    tracker.startedAt = nowIso();
  } else if (!tracker.startedAt) tracker.startedAt = nowIso();
  tracker.snapshot = boundary.snapshot;
  for (const [steamId, player] of current) {
    tracker.participants[steamId] = {
      name: playerDisplayName(player, steamId) || steamId,
      faction: String(playerFaction(player) || '').trim().slice(0, 80)
    };
  }
  serverStats.matchTracker = tracker;
}

export function updateServerStats(bot, server, serverStats, previous, current, lastTick, now, status = null) {
  const elapsed = lastTick ? Math.max(0, Math.min(300, (now - lastTick) / 1000)) : 0;
  const seedingActive = previous.size >= 1 && previous.size <= 20 && current.size >= 1 && current.size <= 20;
  if (elapsed > 0) {
    for (const [steamId] of previous) {
      if (!current.has(steamId)) continue;
      const record = serverStats.players[steamId] || { totalSeconds: 0 };
      record.totalSeconds = Math.max(0, Number(record.totalSeconds) || 0) + elapsed;
      if (seedingActive) record.seedingSeconds = Math.max(0, Number(record.seedingSeconds) || 0) + elapsed;
      serverStats.players[steamId] = record;
    }
  }
  for (const [steamId, player] of current) {
    const name = playerDisplayName(player, steamId) || steamId;
    const isNewSession = !previous.has(steamId);
    const record = serverStats.players[steamId] || { totalSeconds: 0, seedingSeconds: 0, firstSeenAt: nowIso(), sessionCount: 0, matchesPlayed: 0, matchWins: 0 };
    record.name = name;
    record.clanTag = extractClanTag(name);
    record.lastFaction = String(playerFaction(player) || record.lastFaction || '').trim().slice(0, 80);
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
  updateMatchTracker(serverStats, current, status);
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
    const results = await Promise.allSettled(servers.map(async (server) => {
      const data = await wardogsRequest(bot, server, '/v1/players');
      let status = null; let statusError = null;
      try { status = await wardogsRequest(bot, server, '/v1/status'); }
      catch (error) {
        if (error?.wardogsAuthLocked || isWardogsAuthFailure(error)) throw error;
        statusError = String(error?.message || error).slice(0, 180);
      }
      return { server, data, status, statusError };
    }));
    const now = Date.now();
    const serverErrors = [];
    const serverWarnings = [];
    let successful = 0;
    let onlineTotal = 0;
    for (const result of results) {
      if (result.status !== 'fulfilled') {
        serverErrors.push(String(result.reason?.message || result.reason).slice(0, 240));
        continue;
      }
      successful += 1;
      const { server, data, status, statusError } = result.value;
      if (statusError) serverWarnings.push(`${server.label}: Match-Status nicht verfügbar (${statusError})`);
      const rawPlayers = listPlayers(data);
      const current = new Map();
      for (const player of rawPlayers) {
        const steamId = playerSteamId(player);
        if (!steamId) continue;
        current.set(steamId, player);
      }
      const previous = state.onlineByServer.get(server.id) || new Map();
      const serverStats = state.stats.servers[server.id] || normalizeServerStats(null);
      updateServerStats(bot, server, serverStats, previous, current, state.lastTickByServer.get(server.id) || 0, now, status);
      state.stats.servers[server.id] = serverStats;
      state.onlineByServer.set(server.id, current);
      state.lastTickByServer.set(server.id, now);
      onlineTotal += current.size;
    }
    const authFresh=getManagedBot(bot.id)||bot;
    if(authFresh?.wardogsAuthLockedAt)throw createWardogsAuthLockedError(authFresh.wardogsAuthLockedReason||serverErrors[0]||'WARDOGS authentication is locked');
    if (!successful) throw new Error(serverErrors[0] || 'All WARDOGS servers failed');
    if (successful === servers.length) {
      const zone = timeZone(bot), hour = hourInZone(new Date(now), zone);
      const bucket = state.stats.hours[hour] || { hour, samples: 0, playerSum: 0, maxPlayers: 0 };
      bucket.samples += 1; bucket.playerSum += onlineTotal; bucket.maxPlayers = Math.max(bucket.maxPlayers, onlineTotal); state.stats.hours[hour] = bucket;
    }
    state.stats.lastPollAt = nowIso();
    const runtimeNotices = [
      ...(serverErrors.length ? [`${serverErrors.length}/${servers.length} server(s) failed: ${serverErrors.join(' · ')}`] : []),
      ...serverWarnings
    ];
    setRuntime(bot.id, {
      state: 'online',
      players: onlineTotal,
      trackedServers: servers.length,
      reachableServers: successful,
      lastCheck: nowIso(),
      lastError: runtimeNotices.length ? runtimeNotices.join(' · ').slice(0, 500) : null
    });
    await saveState(bot.id, state);

    const fresh = getManagedBot(bot.id) || bot;
    const lastLeaderboard = Date.parse(fresh.lastLeaderboardAt || '') || 0;
    if (validSnowflake(fresh.leaderboardChannelId) && (forceLeaderboard || !lastLeaderboard || now - lastLeaderboard >= LEADERBOARD_MS)) {
      try { await publishLeaderboard(fresh, state); setRuntime(bot.id, { lastLeaderboardAt: nowIso(), lastLeaderboardError: null }); }
      catch (error) { setRuntime(bot.id, { lastLeaderboardError: String(error.message || error).slice(0, 300) }); }
    }
  } catch (error) {
    if (error?.wardogsAuthLocked) {
      setRuntime(bot.id, { state: 'auth-locked', lastError: String(error.message || error).slice(0, 300), lastCheck: nowIso(), requiresManualRestart: true, needsRecovery: false, nextRecoveryAt: null });
    } else {
      setRuntime(bot.id, { state: 'error', lastError: String(error.message || error).slice(0, 300), lastCheck: nowIso() });
    }
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
  if (!bot.enabled || !accessActive(bot)) { setRuntime(bot.id, { state: bot.wardogsAuthLockedAt ? 'auth-locked' : (accessActive(bot) ? 'stopped' : 'access-expired'), lastError: bot.wardogsAuthLockedAt ? wardogsAuthLockedMessage(bot.wardogsAuthLockedReason) : null, requiresManualRestart: Boolean(bot.wardogsAuthLockedAt) }); return; }
  const servers = playtimeTrackerServers(bot);
  if (!servers.length) throw new Error('At least one WARDOGS server is required');
  if (servers.some((server) => !server.secretEnc)) throw new Error('Every tracked WARDOGS server needs an RCON/API password');
  let token = '';
  if (bot.botTokenEnc) { try { token = decryptSecret(bot.botTokenEnc); } catch {} }
  const discordOutputConfigured = validSnowflake(bot.leaderboardChannelId) || servers.some((server) => validSnowflake(server.killFeedChannelId));
  if (discordOutputConfigured && !token) throw new Error('Discord bot token is required when a leaderboard or killfeed channel is configured');
  // A configured token is enough to connect the bot even without a fixed output
  // channel: slash commands (/status, /whois, /playerstats, /linkgame) still need
  // an active Discord gateway session.
  const wantsDiscord = Boolean(token);
  const client = wantsDiscord ? new Client({ intents: [GatewayIntentBits.Guilds] }) : null;
  if (client) {
    client.on('interactionCreate', (interaction) => {
      const relevant = interaction.isChatInputCommand?.() || String(interaction.customId || '').endsWith(`:${bot.id}`);
      if (relevant) handleStatusInteraction(bot.id, interaction).catch(async(error) => {
        try {
          const payload = { content: `Aktion fehlgeschlagen: ${String(error?.message || error).slice(0, 300)}`, ephemeral: true };
          if (interaction.deferred || interaction.replied) await interaction.followUp(payload); else await interaction.reply(payload);
        } catch {}
      });
    });
    client.on('guildCreate', (guild) => { guild.commands.set(slashCommands()).catch((error) => setRuntime(bot.id, { slashCommandError: String(error?.message || error).slice(0, 300) })); });
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
      await registerSlashCommands(client, bot.id);
    }
    const fresh = getManagedBot(bot.id) || bot;
    if (!fresh.enabled || !accessActive(fresh)) { if (client) await client.destroy(); setRuntime(bot.id, { state: fresh.wardogsAuthLockedAt ? 'auth-locked' : (accessActive(fresh) ? 'stopped' : 'access-expired'), lastError: fresh.wardogsAuthLockedAt ? wardogsAuthLockedMessage(fresh.wardogsAuthLockedReason) : null, requiresManualRestart: Boolean(fresh.wardogsAuthLockedAt) }); return; }
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
        setRuntime(id, { state: fresh?.wardogsAuthLockedAt ? 'auth-locked' : (fresh?.enabled && !accessActive(fresh) ? 'access-expired' : 'stopped'), botTag: null, players: null, needsRecovery: false, nextRecoveryAt: null, requiresManualRestart: Boolean(fresh?.wardogsAuthLockedAt), lastError: fresh?.wardogsAuthLockedAt ? wardogsAuthLockedMessage(fresh.wardogsAuthLockedReason) : null });
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
        catch (error) { await stopOne(id, false); if(error?.wardogsAuthLocked)setRuntime(id,{state:'auth-locked',lastError:error.message,requiresManualRestart:true,needsRecovery:false,nextRecoveryAt:null});else markRecoveryFailure(id, error); }
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
      catch (error) { await stopOne(id, false); if(error?.wardogsAuthLocked)setRuntime(id,{state:'auth-locked',lastError:error.message,requiresManualRestart:true,needsRecovery:false,nextRecoveryAt:null});else markRecoveryFailure(id, error); }
    });
  }
}
export async function restartPlaytimeBot(bot) {
  return withLock(bot.id, async () => {
    clearRecovery(bot.id);
    try { await startOne(getManagedBot(bot.id) || bot); return playtimeBotRuntime(bot.id); }
    catch (error) { await stopOne(bot.id, false); if(error?.wardogsAuthLocked)setRuntime(bot.id,{state:'auth-locked',lastError:error.message,requiresManualRestart:true,needsRecovery:false,nextRecoveryAt:null});else markRecoveryFailure(bot.id, error); throw error; }
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
