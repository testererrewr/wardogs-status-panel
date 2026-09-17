import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  ModalBuilder,
  PermissionsBitField,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle
} from 'discord.js';
import { decryptSecret } from './crypto.js';
import { safeHttpText } from './target-safety.js';
import { getManagedBot, upsertManagedBot } from './db.js';
import { parseManagedRules, evaluateManagedRules, matchManagedRules, managedRulesNeedSteam } from './managed-rules.js';
import { getSteamRiskProfiles, steamApiKeyAvailable } from './steam-risk.js';
export { parseManagedRules, evaluateManagedRules, matchManagedRules } from './managed-rules.js';

export const MANAGED_DISCORD_PERMISSION_KEYS = Object.freeze([
  'view', 'announce', 'whisper', 'kick', 'ban', 'unban', 'kill', 'setteam', 'match', 'map', 'lighting', 'ignore'
]);

const instances = new Map();
const runtime = new Map();
const discordUiState = new Map();
const lifecycleLocks = new Map();
const recoveryState = new Map();
const WELCOME_MAX_ATTEMPTS = 24;
const WELCOME_RETRY_MS = 5000;
const SEEDING_SUFFIX = 'JOIN Seeding';

function withLifecycleLock(id, task) {
  const key = String(id || '');
  const previous = lifecycleLocks.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  lifecycleLocks.set(key, current);
  return current.finally(() => {
    if (lifecycleLocks.get(key) === current) lifecycleLocks.delete(key);
  });
}

function recoveryDelayMs(attempts) {
  return Math.min(5 * 60_000, 15_000 * (2 ** Math.max(0, Math.min(5, Number(attempts || 1) - 1))));
}
function markRecoveryFailure(id, error) {
  const previous = recoveryState.get(id) || { attempts: 0 };
  const attempts = Number(previous.attempts || 0) + 1;
  const nextAttemptAt = Date.now() + recoveryDelayMs(attempts);
  const item = { attempts, nextAttemptAt, lastError: String(error?.message || error || 'unknown error').slice(0, 300) };
  recoveryState.set(id, item);
  setRuntime(id, { state: 'error', lastError: item.lastError, recoveryAttempts: attempts, nextRecoveryAt: new Date(nextAttemptAt).toISOString(), needsRecovery: true });
  return item;
}
function clearRecovery(id) {
  recoveryState.delete(id);
  setRuntime(id, { recoveryAttempts: 0, nextRecoveryAt: null, needsRecovery: false, disconnectedAt: null });
}

function nowIso() { return new Date().toISOString(); }
function baseUrl(value) { return String(value || '').trim().replace(/\/+$/, ''); }
function accessActive(bot) {
  if (bot?.adminGrant) return true;
  const until = Date.parse(bot?.accessUntil || '');
  return Number.isFinite(until) && until > Date.now();
}
const STEAM64_ACCOUNT_BASE = 76561197960265728n;
export function normalizeSteamId64(value) {
  const raw = String(value ?? '').trim();
  if (/^\d{17}$/.test(raw)) return raw;
  let match = raw.match(/^STEAM_[0-5]:([01]):(\d+)$/i);
  if (match) return (STEAM64_ACCOUNT_BASE + (BigInt(match[2]) * 2n) + BigInt(match[1])).toString();
  match = raw.match(/^\[?U:1:(\d+)\]?$/i);
  if (match) return (STEAM64_ACCOUNT_BASE + BigInt(match[1])).toString();
  return '';
}
function playerSteamId(player) {
  for (const key of ['steamId64','steamId','steamID64','steamID','playerSteamId','playerId']) {
    const normalized = normalizeSteamId64(player?.[key]);
    if (normalized) return normalized;
  }
  return '';
}

function playerWardogsApiId(player) {
  for (const key of ['steamId','steamId64','steamID','steamID64','playerSteamId','playerId']) {
    const raw = String(player?.[key] ?? '').trim();
    if (raw) return raw;
  }
  return playerSteamId(player);
}

function playerFaction(player) {
  const raw = player?.faction;
  if (raw && typeof raw === 'object') return String(raw.name ?? raw.label ?? raw.id ?? '').trim();
  return String(raw ?? '').trim();
}
function playerHasFaction(player) {
  const faction = playerFaction(player);
  if (!faction) return false;
  return !['none', 'null', 'undefined', 'unassigned', 'no faction', 'no team'].includes(faction.toLowerCase());
}

export function renderManagedWelcomeMessage(template, player) {
  const steamId = playerSteamId(player);
  const values = {
    player: String(player?.name || 'player').trim() || 'player',
    name: String(player?.name || 'player').trim() || 'player',
    steamid: steamId,
    faction: playerFaction(player)
  };
  return String(template || '')
    .replace(/\{(player|name|steamid|faction)\}/gi, (_, key) => values[String(key).toLowerCase()] ?? '')
    .trim()
    .slice(0, 200);
}

export function managedWelcomeTargets(state, players, joinedPlayers) {
  if (!(state.welcomePending instanceof Set)) state.welcomePending = new Set();
  if (!(state.welcomeDelivered instanceof Set)) state.welcomeDelivered = new Set();
  if (!(state.welcomeFailed instanceof Set)) state.welcomeFailed = new Set();
  if (!(state.welcomeAttempts instanceof Map)) state.welcomeAttempts = new Map();
  const tracker = state.welcomeJoinTracker || state.joinTracker;
  const activeIds = tracker?.active instanceof Set ? tracker.active : new Set();
  for (const id of [...state.welcomePending]) if (!activeIds.has(id)) state.welcomePending.delete(id);
  for (const id of [...state.welcomeDelivered]) if (!activeIds.has(id)) state.welcomeDelivered.delete(id);
  for (const id of [...state.welcomeFailed]) if (!activeIds.has(id)) state.welcomeFailed.delete(id);
  for (const id of [...state.welcomeAttempts.keys()]) if (!activeIds.has(id)) state.welcomeAttempts.delete(id);

  for (const player of Array.isArray(joinedPlayers) ? joinedPlayers : []) {
    const steamId = playerSteamId(player);
    if (!steamId) continue;
    // managedJoinCandidates only emits a player after a confirmed new join session.
    // Reset any delivery/failure state from the previous session here so a genuine
    // leave + rejoin can receive exactly one fresh welcome.
    state.welcomeDelivered.delete(steamId);
    state.welcomeFailed.delete(steamId);
    state.welcomeAttempts.delete(steamId);
    state.welcomePending.add(steamId);
  }

  const bySteamId = new Map((Array.isArray(players) ? players : []).map((player) => [playerSteamId(player), player]).filter(([id]) => id));
  const targets = [];
  for (const steamId of [...state.welcomePending]) {
    const player = bySteamId.get(steamId);
    if (!player || !playerHasFaction(player) || state.welcomeDelivered.has(steamId) || state.welcomeFailed.has(steamId)) continue;
    if (Number(state.welcomeAttempts.get(steamId) || 0) >= WELCOME_MAX_ATTEMPTS) continue;
    targets.push({ ...player, steamId });
  }
  return targets;
}

export function managedWelcomeSucceeded(state, steamId) {
  const id = normalizeSteamId64(steamId);
  if (!id) return;
  if (!(state.welcomePending instanceof Set)) state.welcomePending = new Set();
  if (!(state.welcomeDelivered instanceof Set)) state.welcomeDelivered = new Set();
  if (!(state.welcomeAttempts instanceof Map)) state.welcomeAttempts = new Map();
  state.welcomePending.delete(id);
  state.welcomeAttempts.delete(id);
  state.welcomeDelivered.add(id);
}

export function managedWelcomeFailed(state, steamId, { retryable = true } = {}) {
  const id = normalizeSteamId64(steamId);
  if (!id) return { retry: false, attempts: 0 };
  if (!(state.welcomePending instanceof Set)) state.welcomePending = new Set();
  if (!(state.welcomeFailed instanceof Set)) state.welcomeFailed = new Set();
  if (!(state.welcomeAttempts instanceof Map)) state.welcomeAttempts = new Map();
  const attempts = Number(state.welcomeAttempts.get(id) || 0) + 1;
  state.welcomeAttempts.set(id, attempts);
  const retry = Boolean(retryable) && attempts < WELCOME_MAX_ATTEMPTS;
  if (!retry) {
    state.welcomePending.delete(id);
    state.welcomeFailed.add(id);
  }
  return { retry, attempts };
}

export function createManagedJoinTracker() {
  return { initialized: false, active: new Set(), missing: new Map() };
}

// Polling APIs can briefly return incomplete/empty player lists. A player is only
// considered to have left after several consecutive successful snapshots miss them.
// That prevents the same live session from being screened and alerted repeatedly.
export function managedJoinCandidates(tracker, players, missingThreshold = 3) {
  const state = tracker || createManagedJoinTracker();
  if (!(state.active instanceof Set)) state.active = new Set();
  if (!(state.missing instanceof Map)) state.missing = new Map();
  const rows = Array.isArray(players) ? players : [];
  const current = new Set(rows.map(playerSteamId).filter(Boolean));
  if (!state.initialized) {
    state.initialized = true;
    state.active = new Set(current);
    state.missing.clear();
    return [];
  }

  const candidates = [];
  for (const player of rows) {
    const id = playerSteamId(player);
    if (!id) continue;
    if (!state.active.has(id)) candidates.push(player);
    // Mark the join immediately, before any Steam/Discord network work starts.
    state.active.add(id);
    state.missing.delete(id);
  }

  const threshold = Math.max(2, Math.min(10, Number(missingThreshold) || 3));
  for (const id of [...state.active]) {
    if (current.has(id)) continue;
    const misses = Number(state.missing.get(id) || 0) + 1;
    if (misses >= threshold) {
      state.active.delete(id);
      state.missing.delete(id);
    } else state.missing.set(id, misses);
  }
  return candidates;
}
function validSteamId(value) { return Boolean(normalizeSteamId64(value)); }
function validSnowflake(value) { return /^\d{17,20}$/.test(String(value || '').trim()); }
function ignoredPlayers(bot) {
  return (Array.isArray(bot?.ignoredPlayers) ? bot.ignoredPlayers : [])
    .map((entry) => typeof entry === 'string' ? { steamId: normalizeSteamId64(entry) } : { ...entry, steamId: normalizeSteamId64(entry?.steamId) })
    .filter((entry) => entry.steamId);
}
function ignoredSteamIds(bot) { return new Set(ignoredPlayers(bot).map((entry) => entry.steamId)); }
function normalizedBanTemplates(bot) {
  return (Array.isArray(bot?.banTemplates) ? bot.banTemplates : []).map((entry, index) => ({
    id: String(entry?.id || `template-${index + 1}`).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 64) || `template-${index + 1}`,
    label: String(entry?.label || '').trim().slice(0, 60),
    reason: String(entry?.reason || '').trim().slice(0, 180),
    durationMinutes: Math.max(0, Math.min(525600, Math.floor(Number(entry?.durationMinutes) || 0)))
  })).filter((entry) => entry.label && entry.reason).slice(0, 12);
}
function temporaryBans(bot) {
  return (Array.isArray(bot?.temporaryBans) ? bot.temporaryBans : []).map((entry) => ({
    steamId: normalizeSteamId64(entry?.steamId),
    reason: String(entry?.reason || '').slice(0, 180),
    expiresAt: entry?.expiresAt || null,
    createdAt: entry?.createdAt || null,
    createdBy: String(entry?.createdBy || '').slice(0, 100),
    templateId: String(entry?.templateId || '').slice(0, 64)
  })).filter((entry) => entry.steamId && Number.isFinite(Date.parse(entry.expiresAt || '')));
}
function setRuntime(id, patch) { runtime.set(id, { ...(runtime.get(id) || {}), ...patch, updatedAt: nowIso() }); }
function cut(value, max = 100) { return String(value ?? '').slice(0, max); }
function uiKey(botId, userId) { return `${botId}:${userId}`; }
function setUiState(botId, userId, patch) {
  const key = uiKey(botId, userId);
  discordUiState.set(key, { ...(discordUiState.get(key) || {}), ...patch, updatedAt: Date.now() });
  if (discordUiState.size > 500) {
    const oldest = [...discordUiState.entries()].sort((a, b) => Number(a[1]?.updatedAt || 0) - Number(b[1]?.updatedAt || 0)).slice(0, 100);
    for (const [oldKey] of oldest) discordUiState.delete(oldKey);
  }
  return discordUiState.get(key);
}
function getUiState(botId, userId) { return discordUiState.get(uiKey(botId, userId)) || {}; }
export function managedBotRuntime(id) { return runtime.get(id) || { state: 'stopped' }; }

export function managedSteamRuleStatus(bot) {
  const rules = parseManagedRules(bot?.rulesText || '');
  return { needsSteam: managedRulesNeedSteam(rules), apiKeyAvailable: steamApiKeyAvailable(bot) };
}

async function wardogsRequest(bot, pathname, { method = 'GET', body } = {}) {
  const root = baseUrl(bot?.wardogsBaseUrl);
  if (!root) throw new Error('WARDOGS base URL is missing');
  let secret = '';
  try { secret = decryptSecret(bot?.wardogsSecretEnc); } catch { secret = ''; }
  if (!secret) throw new Error('WARDOGS RCON/API password is missing');
  const response = await safeHttpText(`${root}${pathname}`, {
    allowPrivate: Boolean(bot?.allowPrivateTarget), method,
    headers: { Accept: 'application/json', Authorization: `Bearer ${secret}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), timeoutMs: 8000, maxBytes: 1024 * 1024
  });
  if (response.status >= 300 && response.status < 400) throw new Error('WARDOGS API redirects are not allowed');
  const text = response.text;
  let data = {};
  if (text) { try { data = JSON.parse(text); } catch { data = { message: text.slice(0, 300) }; } }
  if (!response.ok) {
    const detail = data?.error?.message || data?.message || data?.error || 'Error';
    const error = new Error(`WARDOGS API ${response.status}: ${String(detail).slice(0, 240)}`);
    error.status = response.status;
    error.code = String(data?.error?.code || data?.code || '');
    error.detail = String(detail || '');
    throw error;
  }
  return data;
}


async function wardogsTextRequest(bot, pathname, { method = 'GET', textBody, headers = {} } = {}) {
  const root = baseUrl(bot?.wardogsBaseUrl);
  if (!root) throw new Error('WARDOGS base URL is missing');
  let secret = '';
  try { secret = decryptSecret(bot?.wardogsSecretEnc); } catch { secret = ''; }
  if (!secret) throw new Error('WARDOGS RCON/API password is missing');
  const response = await safeHttpText(`${root}${pathname}`, {
    allowPrivate: Boolean(bot?.allowPrivateTarget),
    method,
    headers: { Accept: 'application/json', Authorization: `Bearer ${secret}`, ...headers },
    body: textBody,
    timeoutMs: 8000,
    maxBytes: 1024 * 1024
  });
  if (response.status >= 300 && response.status < 400) throw new Error('WARDOGS API redirects are not allowed');
  let data = {};
  if (response.text) {
    try { data = JSON.parse(response.text); }
    catch { data = { message: response.text.slice(0, 300) }; }
  }
  if (!response.ok) {
    const detail = data?.error?.message || data?.message || data?.error || 'Error';
    const error = new Error(`WARDOGS API ${response.status}: ${String(detail).slice(0, 240)}`);
    error.status = response.status;
    error.code = String(data?.error?.code || data?.code || '');
    error.detail = String(detail || '');
    throw error;
  }
  return { data, headers: response.headers || {} };
}

function managedServerNameWritable(config) {
  if (config?.writable === false) return { writable: false, lockedBy: 'WARDOGS config is read-only' };
  const sections = Array.isArray(config?.sections) ? config.sections : [];
  const section = sections.find((row) => String(row?.section || '').includes('/Script/WDGame.WDGameSession'));
  const override = Array.isArray(section?.keyOverrides)
    ? section.keyOverrides.find((row) => String(row?.key || '').toLowerCase() === 'servername')
    : null;
  if (override?.writable === false) return { writable: false, lockedBy: String(override?.lockedBy || 'ServerName is fixed by the server host') };
  return { writable: true, lockedBy: '' };
}

export function patchWardogsServerNameConfig(text, serverName) {
  const source = String(text || '');
  const cleanName = String(serverName || '').replace(/[\r\n\0]/g, ' ').trim();
  if (!cleanName) throw new Error('WARDOGS server name is empty');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  const sectionName = '/Script/WDGame.WDGameSession';
  let sectionStart = -1;
  let sectionEnd = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^\s*\[([^\]]+)\]\s*$/);
    if (!m) continue;
    if (m[1].trim() === sectionName) {
      sectionStart = i;
      for (let j = i + 1; j < lines.length; j += 1) {
        if (/^\s*\[[^\]]+\]\s*$/.test(lines[j])) { sectionEnd = j; break; }
      }
      break;
    }
  }
  if (sectionStart < 0) {
    if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
    lines.push(`[${sectionName}]`, `ServerName=${cleanName}`);
    return lines.join(newline);
  }
  for (let i = sectionStart + 1; i < sectionEnd; i += 1) {
    const match = lines[i].match(/^(\s*ServerName\s*=\s*)(.*?)(\s*)$/i);
    if (!match) continue;
    const existing = String(match[2] || '').trim();
    const quoted = existing.length >= 2 && existing.startsWith('"') && existing.endsWith('"');
    const value = quoted ? `"${cleanName.replace(/"/g, '')}"` : cleanName;
    lines[i] = `${match[1]}${value}${match[3]}`;
    return lines.join(newline);
  }
  lines.splice(sectionStart + 1, 0, `ServerName=${cleanName}`);
  return lines.join(newline);
}

async function writeManagedServerName(bot, desiredName) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const config = await wardogsRequest(bot, '/v1/config');
    const writable = managedServerNameWritable(config);
    if (!writable.writable) throw new Error(`ServerName cannot be changed: ${writable.lockedBy}`);
    if (typeof config?.text !== 'string') throw new Error('WARDOGS config document is unavailable');
    const patched = patchWardogsServerNameConfig(config.text, desiredName);
    if (patched === config.text) return { changed: false, serverName: desiredName };
    const revision = String(config?.revision || '').trim();
    const headers = { 'Content-Type': 'text/plain; charset=utf-8' };
    if (revision) headers['If-Match'] = `"${revision.replace(/^"|"$/g, '')}"`;
    try {
      const result = await wardogsTextRequest(bot, '/v1/config?fullApply=true', { method: 'PUT', textBody: patched, headers });
      return { changed: true, serverName: desiredName, result: result.data };
    } catch (error) {
      if (Number(error?.status || 0) === 412 && attempt === 0) continue;
      throw error;
    }
  }
  throw new Error('WARDOGS config changed concurrently; please retry');
}

export async function testManagedWardogs(bot) {
  const [status, players] = await Promise.all([wardogsRequest(bot, '/v1/status'), wardogsRequest(bot, '/v1/players')]);
  return { status, playerCount: Array.isArray(players?.players) ? players.players.length : Number(players?.count || 0) };
}

export function normalizeManagedBanDiscordLink(value) {
  let raw = String(value || '').trim();
  if (!raw) return '';
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw.replace(/^\/+/, '')}`;
  let url;
  try { url = new URL(raw); } catch { return ''; }
  const host = String(url.hostname || '').toLowerCase().replace(/^www\./, '');
  const parts = String(url.pathname || '').split('/').filter(Boolean);
  let code = '';
  if (host === 'discord.gg') code = parts[0] || '';
  else if ((host === 'discord.com' || host === 'discordapp.com') && String(parts[0] || '').toLowerCase() === 'invite') code = parts[1] || '';
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(code)) return '';
  return `https://discord.gg/${code}`;
}

export function formatManagedBanDuration(durationMinutes) {
  const minutes = Math.max(1, Math.min(525600, Math.floor(Number(durationMinutes) || 0)));
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  if (minutes > 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return `${hours}h ${rest}m`;
  }
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

export function formatManagedBanReason(bot, reason, durationMinutes = 0) {
  const minutes = Math.max(0, Math.min(525600, Math.floor(Number(durationMinutes) || 0)));
  const prefix = minutes > 0 ? `Ban duration: ${formatManagedBanDuration(minutes)} | ` : '';
  const invite = normalizeManagedBanDiscordLink(bot?.banDiscordLink);
  const suffix = invite ? ` | Discord: ${invite}` : '';
  let cleanReason = String(reason || (minutes > 0 ? 'Temporary WARDOGS ban' : 'WARDOGS rule violation')).trim();
  cleanReason = cleanReason.replace(/^Ban duration:\s*[^|]{1,80}\|\s*/i, '').replace(/\s*\|\s*Discord:\s*https?:\/\/[^\s|]+\s*$/i, '').trim();
  if (!cleanReason) cleanReason = minutes > 0 ? 'Temporary WARDOGS ban' : 'WARDOGS rule violation';
  const available = Math.max(1, 180 - prefix.length - suffix.length);
  return `${prefix}${cleanReason.slice(0, available)}${suffix}`.slice(0, 180);
}

export async function banManagedPlayer(bot, steamId, reason = 'WARDOGS rule violation', options = {}) {
  const normalized = normalizeSteamId64(steamId);
  if (!normalized) throw new Error('Invalid SteamID64');
  const result = await wardogsRequest(bot, '/v1/bans', { method: 'POST', body: { steamId: normalized, reason: formatManagedBanReason(bot, reason, options?.durationMinutes) } });
  const fresh = getManagedBot(bot?.id);
  if (fresh) {
    const next = temporaryBans(fresh).filter((entry) => entry.steamId !== normalized);
    if (next.length !== temporaryBans(fresh).length) upsertManagedBot({ id: fresh.id, temporaryBans: next });
  }
  return result;
}

export async function temporaryBanManagedPlayer(bot, steamId, reason = 'Temporary WARDOGS ban', durationMinutes = 1440, meta = {}) {
  const normalized = normalizeSteamId64(steamId);
  if (!normalized) throw new Error('Invalid SteamID64');
  const minutes = Math.max(1, Math.min(525600, Math.floor(Number(durationMinutes) || 0)));
  if (!minutes) throw new Error('Temporary ban duration is invalid');
  // WARDOGS only supports persistent bans itself. The panel therefore applies a
  // normal ban and persists the expiry locally, then removes it when the time is due.
  // Put the temporary duration into the actual WARDOGS ban reason so the player-facing
  // ban message also states how long the ban lasts.
  await banManagedPlayer(bot, normalized, reason, { durationMinutes: minutes });
  const fresh = getManagedBot(bot?.id) || bot;
  const existing = temporaryBans(fresh).filter((entry) => entry.steamId !== normalized);
  const entry = {
    steamId: normalized,
    reason: String(reason || '').slice(0, 180),
    expiresAt: new Date(Date.now() + minutes * 60_000).toISOString(),
    createdAt: nowIso(),
    createdBy: String(meta?.createdBy || 'panel').slice(0, 100),
    templateId: String(meta?.templateId || '').slice(0, 64)
  };
  upsertManagedBot({ id: fresh.id, temporaryBans: [...existing, entry].slice(-1000) });
  return entry;
}

export async function expireManagedTemporaryBans(bot) {
  const fresh = getManagedBot(bot?.id) || bot;
  const rows = temporaryBans(fresh);
  if (!rows.length || !fresh?.wardogsBaseUrl || !fresh?.wardogsSecretEnc) return { expired: 0, pending: rows.length };
  const due = rows.filter((entry) => Date.parse(entry.expiresAt) <= Date.now());
  if (!due.length) return { expired: 0, pending: rows.length };
  const keep = [...rows];
  let expired = 0;
  let lastError = null;
  for (const entry of due) {
    try {
      await wardogsRequest(fresh, `/v1/bans/${encodeURIComponent(entry.steamId)}`, { method: 'DELETE' });
      const index = keep.findIndex((x) => x.steamId === entry.steamId);
      if (index >= 0) keep.splice(index, 1);
      expired += 1;
    } catch (error) {
      const code = String(error?.code || '').toLowerCase();
      const detail = String(error?.detail || error?.message || '').toLowerCase();
      if (Number(error?.status || 0) === 404 && (code === 'ban_not_found' || detail.includes('not currently banned'))) {
        const index = keep.findIndex((x) => x.steamId === entry.steamId);
        if (index >= 0) keep.splice(index, 1);
        expired += 1;
      } else lastError = String(error?.message || error).slice(0, 300);
    }
  }
  if (expired) upsertManagedBot({ id: fresh.id, temporaryBans: keep });
  if (lastError) setRuntime(fresh.id, { lastTemporaryBanError: lastError });
  else if (expired) setRuntime(fresh.id, { lastTemporaryBanError: null, lastTemporaryBanSweepAt: nowIso() });
  return { expired, pending: keep.length, error: lastError };
}
export async function kickManagedPlayer(bot, steamId, reason = 'WARDOGS rule violation') {
  const normalized = normalizeSteamId64(steamId);
  if (!normalized) throw new Error('Invalid SteamID64');
  return wardogsRequest(bot, `/v1/players/${encodeURIComponent(normalized)}/kick`, { method: 'POST', body: { reason: String(reason || '').slice(0, 180) } });
}
export async function killManagedPlayer(bot, steamId) {
  const normalized = normalizeSteamId64(steamId);
  if (!normalized) throw new Error('Invalid SteamID64');
  return wardogsRequest(bot, `/v1/players/${encodeURIComponent(normalized)}/kill`, { method: 'POST' });
}
function welcomeWhisperRetryable(error) {
  const status = Number(error?.status || 0);
  const code = String(error?.code || '').toLowerCase();
  const detail = String(error?.detail || error?.message || '').toLowerCase();
  // A build without the route will never recover during this join session.
  if (status === 404 && (detail.includes('no such endpoint') || detail.includes('endpoint') && detail.includes('not'))) return false;
  if (code === 'no_route' || code === 'method_not_allowed') return false;
  // Authentication/configuration errors are not spawn timing problems.
  if ([401, 403, 405].includes(status)) return false;
  // Player/faction/pawn readiness can briefly lag behind /v1/players. Retry only
  // clear upstream HTTP rejections; transport timeouts are ambiguous and are not
  // retried to avoid a duplicate whisper if the server already accepted it.
  if ([400, 404, 409, 422, 423, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  return false;
}

async function sendManagedWelcomeWhisper(bot, state, player, message) {
  const steamId = playerSteamId(player);
  const apiId = playerWardogsApiId(player);
  if (!steamId || !apiId) return { sent: false, retry: false, attempts: 0, error: new Error('Invalid WARDOGS player/SteamID64') };
  try {
    // Use the exact player identifier returned by /v1/players for the whisper route.
    // Some WARDOGS builds are stricter here than the other moderation endpoints.
    await wardogsRequest(bot, `/v1/players/${encodeURIComponent(apiId)}/message`, { method: 'POST', body: { message: String(message || '').slice(0, 200) } });
    managedWelcomeSucceeded(state, steamId);
    return { sent: true, retry: false, attempts: Number(state.welcomeAttempts?.get?.(steamId) || 0) + 1, error: null };
  } catch (error) {
    const outcome = managedWelcomeFailed(state, steamId, { retryable: welcomeWhisperRetryable(error) });
    return { sent: false, ...outcome, error };
  }
}

async function processManagedWelcomeQueue(bot, state, players = null) {
  if (bot?.welcomeWhisperEnabled !== true) return;
  if (!(state.welcomePending instanceof Set) || state.welcomePending.size === 0) return;
  if (state.welcomeInFlight) return;
  state.welcomeInFlight = true;
  try {
    let rows = Array.isArray(players) ? players : null;
    if (!rows) {
      const data = await wardogsRequest(bot, '/v1/players');
      rows = Array.isArray(data?.players) ? data.players : [];
    }
    for (const player of managedWelcomeTargets(state, rows, [])) {
      const steamId = playerSteamId(player);
      const message = renderManagedWelcomeMessage(bot.welcomeWhisperMessage, player);
      if (!steamId || !message) continue;
      const result = await sendManagedWelcomeWhisper(bot, state, player, message);
      if (result.sent) {
        setRuntime(bot.id, {
          lastWelcomeWhisperAt: nowIso(),
          lastWelcomeWhisperPlayer: String(player?.name || steamId),
          lastWelcomeWhisperError: null,
          lastWelcomeWhisperAttempts: result.attempts
        });
      } else {
        setRuntime(bot.id, {
          lastWelcomeWhisperAt: nowIso(),
          lastWelcomeWhisperPlayer: String(player?.name || steamId),
          lastWelcomeWhisperError: `${result.error?.message || 'Whisper failed'}${result.retry ? ` · retry ${result.attempts}/${WELCOME_MAX_ATTEMPTS}` : ''}`,
          lastWelcomeWhisperAttempts: result.attempts
        });
      }
    }
  } finally {
    state.welcomeInFlight = false;
  }
}

async function pollManagedWelcome(bot, state) {
  if (bot?.welcomeWhisperEnabled !== true || state.welcomePollInFlight) return;
  state.welcomePollInFlight = true;
  try {
    const data = await wardogsRequest(bot, '/v1/players');
    const players = Array.isArray(data?.players) ? data.players : [];
    if (!state.welcomeJoinTracker) state.welcomeJoinTracker = createManagedJoinTracker();
    // Welcome detection is intentionally separate from risk/detection joins. It polls
    // faster so a real leave + rejoin does not have to wait for three normal 20s
    // detection snapshots before it can receive the next welcome.
    const joined = managedJoinCandidates(state.welcomeJoinTracker, players, 2);
    managedWelcomeTargets(state, players, joined);
    await processManagedWelcomeQueue(bot, state, players);
  } catch (error) {
    setRuntime(bot.id, { lastWelcomeWhisperError: String(error?.message || error).slice(0, 300) });
  } finally {
    state.welcomePollInFlight = false;
  }
}

export function managedSeedingServerName(currentName, playerCount, enabled = true) {
  const current = String(currentName || '').trim();
  if (!current) return '';
  const suffixPattern = /\s+JOIN Seeding$/i;
  const base = current.replace(suffixPattern, '').trim();
  const seeding = enabled === true && Number(playerCount) >= 1 && Number(playerCount) <= 20;
  return seeding ? `${base} ${SEEDING_SUFFIX}` : base;
}

async function updateManagedSeedingServerName(bot, state, playerCount, { force = false } = {}) {
  const active = bot?.seedingNameEnabled === true && Number(playerCount) >= 1 && Number(playerCount) <= 20;
  const now = Date.now();
  // Re-check periodically as well as on threshold changes. This restores the suffix
  // after a game-server restart without hammering the config endpoint every poll.
  if (!force && state.seedingServerActive === active && now - Number(state.lastSeedingServerCheckAt || 0) < 60_000) return;
  state.lastSeedingServerCheckAt = now;
  const status = await wardogsRequest(bot, '/v1/status');
  const currentName = String(status?.serverName || '').trim();
  if (!currentName) throw new Error('WARDOGS status did not return a server name');
  const desired = managedSeedingServerName(currentName, playerCount, bot?.seedingNameEnabled === true);
  if (desired && desired !== currentName) await writeManagedServerName(bot, desired);
  state.seedingServerActive = active;
  state.seedingServerName = desired || currentName;
  setRuntime(bot.id, { seedingServerName: desired || currentName, lastSeedingNameError: null });
}

export async function whisperManagedPlayer(bot, steamId, message) {
  const normalized = normalizeSteamId64(steamId);
  if (!normalized) throw new Error('Invalid SteamID64');
  const clean = String(message || '').trim();
  if (!clean || clean.length > 200) throw new Error('Player message must be 1–200 characters long');
  return wardogsRequest(bot, `/v1/players/${encodeURIComponent(normalized)}/message`, { method: 'POST', body: { message: clean } });
}
export async function whisperManagedFaction(bot, faction, message) {
  const cleanFaction = String(faction || '').trim();
  const cleanMessage = String(message || '').trim();
  if (!cleanFaction || cleanFaction.length > 80) throw new Error('Faction is invalid');
  if (!cleanMessage || cleanMessage.length > 200) throw new Error('Faction whisper must be 1–200 characters long');

  const payload = await wardogsRequest(bot, '/v1/players');
  const players = Array.isArray(payload?.players) ? payload.players : [];
  const targetFaction = cleanFaction.toLocaleLowerCase('en-US');
  const targets = players.filter((player) => {
    const steamId = playerSteamId(player);
    const currentFaction = playerFaction(player).toLocaleLowerCase('en-US');
    return Boolean(steamId) && currentFaction === targetFaction;
  });
  if (!targets.length) return { faction: cleanFaction, matched: 0, sent: 0, failed: 0, failures: [] };

  let cursor = 0;
  let sent = 0;
  const failures = [];
  const workerCount = Math.min(5, targets.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= targets.length) return;
      const player = targets[index];
      const steamId = playerSteamId(player);
      const rendered = renderManagedWelcomeMessage(cleanMessage, player) || cleanMessage;
      try {
        await whisperManagedPlayer(bot, steamId, rendered);
        sent += 1;
      } catch (error) {
        failures.push({ steamId, name: String(player?.name || ''), error: String(error?.message || error || 'Whisper failed').slice(0, 180) });
      }
    }
  });
  await Promise.all(workers);
  return { faction: cleanFaction, matched: targets.length, sent, failed: failures.length, failures: failures.slice(0, 10) };
}
export async function moveManagedPlayer(bot, steamId, faction) {
  const normalized = normalizeSteamId64(steamId);
  if (!normalized) throw new Error('Invalid SteamID64');
  const clean = String(faction || '').trim();
  if (!clean || clean.length > 80) throw new Error('Faction is invalid');
  const moved = await wardogsRequest(bot, `/v1/players/${encodeURIComponent(normalized)}`, { method: 'PATCH', body: { faction: clean } });
  let respawn = null;
  try { respawn = await killManagedPlayer(bot, normalized); } catch {}
  return { moved, respawn };
}
export async function unbanManagedPlayer(bot, steamId) {
  const normalized = normalizeSteamId64(steamId);
  if (!normalized) throw new Error('Invalid SteamID64');
  const result = await wardogsRequest(bot, `/v1/bans/${encodeURIComponent(normalized)}`, { method: 'DELETE' });
  const fresh = getManagedBot(bot?.id);
  if (fresh) upsertManagedBot({ id: fresh.id, temporaryBans: temporaryBans(fresh).filter((entry) => entry.steamId !== normalized) });
  return result;
}
export async function addManagedReservedSlot(bot, steamId) {
  if (!validSteamId(steamId)) throw new Error('Invalid SteamID64');
  return wardogsRequest(bot, '/v1/reserved-slots', { method: 'POST', body: { steamId: String(steamId) } });
}
export async function removeManagedReservedSlot(bot, steamId) {
  if (!validSteamId(steamId)) throw new Error('Invalid SteamID64');
  return wardogsRequest(bot, `/v1/reserved-slots/${encodeURIComponent(steamId)}`, { method: 'DELETE' });
}
export async function broadcastManaged(bot, message) {
  const clean = String(message || '').trim();
  if (!clean || clean.length > 200) throw new Error('Announcement must be 1–200 characters long');
  return wardogsRequest(bot, '/v1/broadcast', { method: 'POST', body: { message: clean } });
}
export async function restartManagedMatch(bot) { return wardogsRequest(bot, '/v1/match/restart', { method: 'POST' }); }
export async function endManagedMatch(bot) { return wardogsRequest(bot, '/v1/match/end', { method: 'POST' }); }
export async function setManagedLighting(bot, lighting) {
  const clean = String(lighting || '').trim();
  if (!clean || clean.length > 100) throw new Error('Lighting value is invalid');
  return wardogsRequest(bot, '/v1/world/lighting', { method: 'PUT', body: { lighting: clean } });
}
export async function changeManagedMap(bot, { map, experiences = [], lighting = '', zoneAlternator = '' } = {}) {
  const cleanMap = String(map || '').trim();
  if (!cleanMap || cleanMap.length > 100) throw new Error('Map is invalid');
  const body = { map: cleanMap };
  const cleanExperiences = (Array.isArray(experiences) ? experiences : String(experiences || '').split(','))
    .map((x) => String(x || '').trim()).filter(Boolean).slice(0, 20);
  if (cleanExperiences.some((x) => x.length > 100)) throw new Error('Experience is invalid');
  if (cleanExperiences.length) body.experiences = cleanExperiences;
  const cleanLighting = String(lighting || '').trim();
  const cleanAlternator = String(zoneAlternator || '').trim();
  if (cleanLighting) body.lighting = cleanLighting.slice(0, 100);
  if (cleanAlternator) body.zoneAlternator = cleanAlternator.slice(0, 160);
  return wardogsRequest(bot, '/v1/match/map', { method: 'POST', body });
}

export async function managedMapOptions(bot, map) {
  const cleanMap = String(map || '').trim();
  if (!cleanMap || cleanMap.length > 100 || !/^[A-Za-z0-9_.-]+$/.test(cleanMap)) throw new Error('Map is invalid');
  const encoded = encodeURIComponent(cleanMap);
  const [experiences, alternators] = await Promise.allSettled([
    wardogsRequest(bot, `/v1/catalog/maps/${encoded}/experiences`),
    wardogsRequest(bot, `/v1/catalog/maps/${encoded}/alternators`)
  ]);
  return {
    map: cleanMap,
    experiences: experiences.status === 'fulfilled' && Array.isArray(experiences.value?.experiences) ? experiences.value.experiences : [],
    alternators: alternators.status === 'fulfilled' && Array.isArray(alternators.value?.alternators) ? alternators.value.alternators : [],
    errors: {
      ...(experiences.status === 'rejected' ? { experiences: String(experiences.reason?.message || experiences.reason) } : {}),
      ...(alternators.status === 'rejected' ? { alternators: String(alternators.reason?.message || alternators.reason) } : {})
    }
  };
}

export async function managedDashboard(bot) {
  const requests = {
    status: ['/v1/status'],
    health: ['/v1/health'],
    players: ['/v1/players'],
    bans: ['/v1/bans'],
    capabilities: ['/v1/capabilities'],
    serverId: ['/v1/server-id'],
    reserved: ['/v1/reserved-slots'],
    rotation: ['/v1/rotation'],
    maps: ['/v1/catalog/maps'],
    lightings: ['/v1/catalog/lightings'],
    experiences: ['/v1/catalog/experiences'],
    audit: ['/v1/audit?limit=40']
  };
  const keys = Object.keys(requests);
  const settled = await Promise.allSettled(keys.map((key) => wardogsRequest(bot, requests[key][0])));
  const out = { errors: {} };
  settled.forEach((result, index) => {
    const key = keys[index];
    if (result.status === 'fulfilled') out[key] = result.value;
    else { out[key] = null; out.errors[key] = String(result.reason?.message || result.reason || 'Error'); }
  });
  return out;
}

function detectionActionForRules(bot, matchedRules) {
  const explicit = (Array.isArray(matchedRules) ? matchedRules : []).filter((rule) => rule?.action);
  if (!explicit.length) return bot?.autoBanEnabled === true ? { action: 'ban', source: 'legacy-auto-ban', durationMinutes: 0 } : { action: 'alert', source: 'default', durationMinutes: 0 };
  const severity = { alert: 1, kick: 2, tempban: 3, ban: 4 };
  let chosen = explicit[0];
  for (const rule of explicit.slice(1)) {
    const a = severity[String(rule?.action || 'alert')] || 1;
    const b = severity[String(chosen?.action || 'alert')] || 1;
    if (a > b || (a === b && String(rule?.action) === 'tempban' && Number(rule?.durationMinutes || 0) > Number(chosen?.durationMinutes || 0))) chosen = rule;
  }
  return {
    action: ['alert','kick','tempban','ban'].includes(String(chosen?.action)) ? String(chosen.action) : 'alert',
    source: 'rule',
    durationMinutes: Math.max(0, Math.min(525600, Math.floor(Number(chosen?.durationMinutes) || 0)))
  };
}

async function executeDetectionAction(bot, player, reasons, matchedRules) {
  const steamId = playerSteamId(player);
  const chosen = detectionActionForRules(bot, matchedRules);
  if (!steamId || chosen.action === 'alert') return { action: 'alert', ok: true, label: 'Alert only' };
  const reason = reasons.join('; ').slice(0, 180) || 'WARDOGS detection rule';
  if (chosen.action === 'kick') {
    await kickManagedPlayer(bot, steamId, reason);
    return { action: 'kick', ok: true, label: 'Kick executed' };
  }
  if (chosen.action === 'tempban') {
    const minutes = chosen.durationMinutes || 1440;
    const entry = await temporaryBanManagedPlayer(bot, steamId, reason, minutes, { createdBy: 'detection-rule' });
    return { action: 'tempban', ok: true, label: `Temporary ban · ${formatManagedBanDuration(minutes)}`, expiresAt: entry.expiresAt };
  }
  await banManagedPlayer(bot, steamId, reason);
  return { action: 'ban', ok: true, label: 'Permanent ban executed' };
}

function announcementMessages(bot) {
  return String(bot?.announcementMessages || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(0, 50);
}

function normalizeDiscordGrants(bot) {
  const raw = Array.isArray(bot?.discordGrants) ? bot.discordGrants : Array.isArray(bot?.discordRoleGrants) ? bot.discordRoleGrants.map((x) => ({ ...x, type: 'role' })) : [];
  return raw.map((grant) => ({
    type: grant?.type === 'user' ? 'user' : 'role',
    id: String(grant?.id || grant?.roleId || '').trim(),
    permissions: Array.isArray(grant?.permissions) ? [...new Set(grant.permissions.map(String).filter((x) => MANAGED_DISCORD_PERMISSION_KEYS.includes(x)))] : []
  })).filter((grant) => validSnowflake(grant.id) && grant.permissions.length);
}

function interactionRoleIds(interaction) {
  const roles = interaction?.member?.roles;
  if (roles?.cache && typeof roles.cache.keys === 'function') return [...roles.cache.keys()].map(String);
  if (Array.isArray(roles)) return roles.map(String);
  return [];
}

function discordPermission(bot, interaction, key) {
  if (!MANAGED_DISCORD_PERMISSION_KEYS.includes(key)) return false;
  const userId = String(interaction?.user?.id || '');
  if (userId && userId === String(bot?.ownerDiscordId || '')) return true;
  if (interaction?.memberPermissions?.has?.(PermissionsBitField.Flags.Administrator)) return true;
  const grants = normalizeDiscordGrants(bot);
  if (!grants.length) {
    if (key === 'ban' || key === 'ignore') return Boolean(interaction?.memberPermissions?.has?.(PermissionsBitField.Flags.BanMembers));
    if (key === 'kick') return Boolean(interaction?.memberPermissions?.has?.(PermissionsBitField.Flags.KickMembers));
    return false;
  }
  const roleIds = new Set(interactionRoleIds(interaction));
  return grants.some((grant) => {
    const subject = grant.type === 'user' ? grant.id === userId : roleIds.has(grant.id);
    return subject && grant.permissions.includes(key);
  });
}

function signature(bot) {
  return JSON.stringify({
    enabled: Boolean(bot.enabled), botTokenEnc: bot.botTokenEnc || '', alertChannelId: bot.alertChannelId || '', mentionRoleId: bot.mentionRoleId || '',
    controlPanelEnabled: bot.controlPanelEnabled === true, controlPanelChannelId: bot.controlPanelChannelId || '', discordGrants: normalizeDiscordGrants(bot), ignoredPlayers: ignoredPlayers(bot),
    wardogsBaseUrl: bot.wardogsBaseUrl || '', wardogsSecretEnc: bot.wardogsSecretEnc || '', allowPrivateTarget: Boolean(bot.allowPrivateTarget),
    pollSeconds: Number(bot.pollSeconds || 20), rulesText: bot.rulesText || '', autoBanEnabled: bot.autoBanEnabled === true,
    steamWebApiKeyEnc: bot.steamWebApiKeyEnc || '', steamAppId: bot.steamAppId || '',
    announcementEnabled: bot.announcementEnabled === true, announcementIntervalMinutes: Number(bot.announcementIntervalMinutes || 15),
    announcementMessages: bot.announcementMessages || '', welcomeWhisperEnabled: bot.welcomeWhisperEnabled === true,
    welcomeWhisperMessage: bot.welcomeWhisperMessage || '', seedingNameEnabled: bot.seedingNameEnabled === true, banDiscordLink: normalizeManagedBanDiscordLink(bot.banDiscordLink), accessUntil: bot.accessUntil || null, adminGrant: Boolean(bot.adminGrant), restartNonce: bot.restartNonce || 0
  });
}

function alertComponents(bot, player, ignored = false) {
  const steamId = playerSteamId(player);
  if (!steamId) return [];
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`wdban:${bot.id}:${steamId}`).setLabel('Ban').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`wdkick:${bot.id}:${steamId}`).setLabel('Kick').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`wdignore:${bot.id}:${steamId}`).setLabel(ignored ? 'Ignored' : 'Ignore').setStyle(ButtonStyle.Secondary).setDisabled(ignored),
    new ButtonBuilder().setLabel('Steam Profile').setStyle(ButtonStyle.Link).setURL(`https://steamcommunity.com/profiles/${steamId}`)
  )];
}

async function postAlert(bot, client, player, reasons, actionResult = null, risk = null) {
  const channel = await client.channels.fetch(String(bot.alertChannelId || ''));
  if (!channel?.isTextBased?.() || typeof channel.send !== 'function') throw new Error('Discord alert channel was not found or is not writable');
  const steamId = playerSteamId(player) || '—';
  const ping = Number(player?.pingMs ?? player?.ping);
  const embed = new EmbedBuilder()
    .setTitle('WARDOGS Player Warning')
    .setDescription(reasons.map((x) => `• ${x}`).join('\n').slice(0, 3900))
    .addFields(
      { name: 'Player', value: String(player?.name || 'Unknown').slice(0, 1024), inline: true },
      { name: 'SteamID64', value: steamId.slice(0, 1024), inline: true },
      { name: 'Faction', value: String(player?.faction || '—').slice(0, 1024), inline: true },
      { name: 'Ping', value: Number.isFinite(ping) ? `${ping} ms` : '—', inline: true }
    );
  if (risk) {
    const steamFacts = [
      Number.isFinite(Number(risk.vacBans)) ? `VAC: ${risk.vacBans}` : null,
      Number.isFinite(Number(risk.gameBans)) ? `Game bans: ${risk.gameBans}` : null,
      Number.isFinite(Number(risk.playtimeHours)) ? `Playtime: ${risk.playtimeHours} h` : null,
      Number.isFinite(Number(risk.accountAgeDays)) ? `Account: ${risk.accountAgeDays} d` : null,
      risk.profilePrivate === true ? 'Profile: private' : risk.profilePrivate === false ? 'Profile: public' : null
    ].filter(Boolean).join(' · ');
    if (steamFacts) embed.addFields({ name: 'Steam Check', value: steamFacts.slice(0, 1024), inline: false });
  }
  const actionText = actionResult?.ok === false
    ? `${actionResult?.label || actionResult?.action || 'Action'} · failed: ${String(actionResult?.error || 'unknown error').slice(0, 160)}`
    : (actionResult?.label || (bot.autoBanEnabled ? 'Permanent ban executed' : 'Alert only'));
  embed.addFields({ name: 'Detection Action', value: actionText.slice(0, 1024), inline: false }).setTimestamp(new Date());
  const content = validSnowflake(bot.mentionRoleId) ? `<@&${bot.mentionRoleId}>` : '';
  await channel.send({ content, embeds: [embed], components: alertComponents(bot, player), allowedMentions: content ? { roles: [String(bot.mentionRoleId)] } : { parse: [] } });
}

function controlPanelComponents(bot) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`wd:players:${bot.id}`).setLabel('Players').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`wd:announce:${bot.id}`).setLabel('Announcement').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`wd:bans:${bot.id}`).setLabel('Bans').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`wd:server:${bot.id}`).setLabel('Server').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`wd:refresh:${bot.id}`).setLabel('Refresh').setStyle(ButtonStyle.Secondary)
  )];
}

async function controlPanelPayload(bot) {
  let status = null;
  let players = null;
  try {
    [status, players] = await Promise.all([wardogsRequest(bot, '/v1/status'), wardogsRequest(bot, '/v1/players')]);
  } catch {}
  const playerList = Array.isArray(players?.players) ? players.players : [];
  const scores = Array.isArray(status?.factionScores) ? status.factionScores : [];
  const scoreText = scores.length ? scores.slice(0, 6).map((x) => `${cut(x.name, 40)}: ${Number.isFinite(Number(x.score)) ? x.score : '—'}`).join(' · ') : '—';
  const embed = new EmbedBuilder()
    .setTitle('WARDOGS Management Panel')
    .setDescription('Manage the server from Discord. Every action is checked against the permissions configured in the web panel.')
    .addFields(
      { name: 'Server', value: cut(status?.serverName || 'Unreachable', 1024), inline: true },
      { name: 'Map', value: cut(status?.map || '—', 1024), inline: true },
      { name: 'Players', value: `${status?.players?.current ?? playerList.length} / ${status?.players?.max ?? '—'}`, inline: true },
      { name: 'Scores', value: cut(scoreText, 1024), inline: false },
      { name: 'Auto-Ban', value: bot.autoBanEnabled === true ? 'ON' : 'OFF', inline: true },
      { name: 'Auto-Announcements', value: bot.announcementEnabled === true ? 'ON' : 'OFF', inline: true }
    )
    .setFooter({ text: 'status-hub.lol · WARDOGS' })
    .setTimestamp(new Date());
  return { embeds: [embed], components: controlPanelComponents(bot), allowedMentions: { parse: [] } };
}

async function deleteStoredControlPanel(bot, client, state) {
  const messageId = String(state?.panelMessageId || bot?.controlPanelMessageId || '');
  const channelId = String(state?.panelChannelId || bot?.controlPanelMessageChannelId || bot?.controlPanelChannelId || '');
  if (messageId && validSnowflake(channelId)) {
    try {
      const channel = await client.channels.fetch(channelId);
      const message = await channel?.messages?.fetch?.(messageId);
      await message?.delete?.();
    } catch {}
  }
  if (state) { state.panelMessageId = ''; state.panelChannelId = ''; }
  if (bot?.id && (bot.controlPanelMessageId || bot.controlPanelMessageChannelId)) {
    try { upsertManagedBot({ id: bot.id, controlPanelMessageId: '', controlPanelMessageChannelId: '' }); } catch {}
  }
}

async function ensureControlPanel(bot, client, state, { repost = false } = {}) {
  if (!bot?.controlPanelEnabled || !validSnowflake(bot?.controlPanelChannelId)) return null;
  if (state.panelPosting) return null;
  state.panelPosting = true;
  try {
    const channelId = String(bot.controlPanelChannelId);
    const oldChannelId = String(state.panelChannelId || bot.controlPanelMessageChannelId || '');
    const oldMessageId = String(state.panelMessageId || bot.controlPanelMessageId || '');
    if (oldMessageId && oldChannelId && oldChannelId !== channelId) await deleteStoredControlPanel(bot, client, state);
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased?.() || typeof channel.send !== 'function') throw new Error('Discord management panel channel is not writable');
    const payload = await controlPanelPayload(bot);
    let message = null;
    const currentMessageId = String(state.panelMessageId || bot.controlPanelMessageId || '');
    if (currentMessageId) {
      try {
        message = await channel.messages.fetch(currentMessageId);
        if (repost) { await message.delete(); message = null; }
        else await message.edit(payload);
      } catch { message = null; }
    }
    if (!message) message = await channel.send(payload);
    state.panelMessageId = String(message.id);
    state.panelChannelId = channelId;
    state.lastPanelRefreshAt = Date.now();
    if (String(bot.controlPanelMessageId || '') !== String(message.id) || String(bot.controlPanelMessageChannelId || '') !== channelId) {
      try { upsertManagedBot({ id: bot.id, controlPanelMessageId: String(message.id), controlPanelMessageChannelId: channelId }); } catch {}
    }
    setRuntime(bot.id, { controlPanelMessageId: String(message.id), controlPanelChannelId: channelId });
    return message;
  } finally {
    state.panelPosting = false;
  }
}

function scheduleControlPanelBottom(botId, client, state) {
  clearTimeout(state.panelRepostTimer);
  state.panelRepostTimer = setTimeout(async () => {
    const fresh = getManagedBot(botId);
    if (!fresh?.enabled || !accessActive(fresh) || !fresh.controlPanelEnabled) return;
    try { await ensureControlPanel(fresh, client, state, { repost: true }); }
    catch (error) { setRuntime(botId, { lastPanelError: error.message }); }
  }, 750);
  state.panelRepostTimer.unref?.();
}

async function pollPlayers(bot, state, client) {
  // Never allow overlapping poll cycles. Slow Steam/RCON requests must not create
  // a second concurrent detection pass for the same join.
  if (state.pollInFlight) return;
  state.pollInFlight = true;
  try {
    const data = await wardogsRequest(bot, '/v1/players');
    const players = Array.isArray(data?.players) ? data.players : [];
    const rules = parseManagedRules(bot.rulesText || '');
    const ignored = ignoredSteamIds(bot);

    // The first successful snapshot after start/restart is baseline only. Afterwards
    // a SteamID is screened once when it transitions into a new confirmed session.
    // Three consecutive successful snapshots must miss a player before a later return
    // is treated as another join. This absorbs temporary empty/incomplete API results.
    const joinedPlayers = managedJoinCandidates(state.joinTracker, players, 3);
    const candidates = joinedPlayers.filter((player) => {
      const id = playerSteamId(player);
      return id && !ignored.has(id);
    });

    if (!state.baselineReady && state.joinTracker?.initialized) {
      state.baselineReady = true;
      state.lastAnnouncementAt = Date.now();
      state.announcementIndex = 0;
    }

    try { await updateManagedSeedingServerName(bot, state, players.length); }
    catch (error) { setRuntime(bot.id, { lastSeedingNameError: String(error?.message || error).slice(0, 240) }); }

    if (bot.welcomeWhisperEnabled !== true) {
      state.welcomePending?.clear?.();
      state.welcomeDelivered?.clear?.();
      state.welcomeFailed?.clear?.();
      state.welcomeAttempts?.clear?.();
      state.welcomeJoinTracker = createManagedJoinTracker();
    }

    let riskProfiles = new Map();
    if (candidates.length && managedRulesNeedSteam(rules)) {
      try {
        riskProfiles = await getSteamRiskProfiles(bot, candidates.map(playerSteamId), rules);
        setRuntime(bot.id, { lastSteamError: null, lastSteamCheck: nowIso() });
      } catch (error) {
        setRuntime(bot.id, { lastSteamError: error.message, lastSteamCheck: nowIso() });
        // This join has already been consumed by the tracker. A temporary Steam error
        // must not retry/spam the same player every poll.
        riskProfiles = null;
      }
    }

    if (riskProfiles !== null) {
      for (const player of candidates) {
        const steamId = playerSteamId(player);
        if (!steamId || ignored.has(steamId)) continue;
        const risk = managedRulesNeedSteam(rules) ? (riskProfiles.get(steamId) || null) : null;
        const matchedRules = matchManagedRules({ ...player, steamId }, rules, risk);
        const reasons = [...new Set(matchedRules.map((rule) => rule.reason))].slice(0, 8);
        if (!reasons.length) continue;
        const fresh = getManagedBot(bot.id) || bot;
        if (ignoredSteamIds(fresh).has(steamId)) continue;
        let actionResult = { action: 'alert', ok: true, label: 'Alert only' };
        try { actionResult = await executeDetectionAction(fresh, { ...player, steamId }, reasons, matchedRules); }
        catch (error) {
          const selected = detectionActionForRules(fresh, matchedRules);
          actionResult = { action: selected.action, ok: false, label: selected.action, error: error.message };
        }
        try { await postAlert(fresh, client, { ...player, steamId }, reasons, actionResult, risk); }
        catch (error) { setRuntime(bot.id, { lastError: `Discord alert: ${error.message}` }); }
      }
    }

    if (bot.announcementEnabled === true) {
      const messages = announcementMessages(bot);
      const intervalMs = Math.max(1, Math.min(1440, Number(bot.announcementIntervalMinutes) || 15)) * 60_000;
      if (messages.length && Date.now() - Number(state.lastAnnouncementAt || 0) >= intervalMs) {
        const message = messages[state.announcementIndex % messages.length];
        try {
          await broadcastManaged(bot, message);
          state.announcementIndex = (state.announcementIndex + 1) % messages.length;
          state.lastAnnouncementAt = Date.now();
          setRuntime(bot.id, { lastAnnouncementAt: nowIso(), lastAnnouncement: message });
        } catch (error) {
          state.lastAnnouncementAt = Date.now();
          setRuntime(bot.id, { lastAnnouncementError: error.message });
        }
      }
    }
    if (bot.controlPanelEnabled && Date.now() - Number(state.lastPanelRefreshAt || 0) >= 30_000) {
      await ensureControlPanel(bot, client, state).catch((error) => setRuntime(bot.id, { lastPanelError: error.message }));
    }
    setRuntime(bot.id, { state: 'online', botTag: client.user?.tag || '', players: players.length, lastCheck: nowIso(), lastError: null });
  } catch (error) {
    setRuntime(bot.id, { state: 'error', lastCheck: nowIso(), lastError: error.message });
  } finally {
    state.pollInFlight = false;
  }
}

function deny(interaction, key = '') {
  const content = key ? `You do not have the “${key}” permission configured in the web panel.` : 'You are not allowed to use this action.';
  if (interaction.deferred || interaction.replied) return interaction.followUp({ content, ephemeral: true }).catch(() => {});
  return interaction.reply({ content, ephemeral: true }).catch(() => {});
}

function interactionBot(interaction, botId, permission = '') {
  const bot = getManagedBot(botId);
  if (!bot || !bot.enabled || !accessActive(bot)) {
    if (!interaction.replied && !interaction.deferred) interaction.reply({ content: 'This managed bot is not active.', ephemeral: true }).catch(() => {});
    return null;
  }
  if (permission && !discordPermission(bot, interaction, permission)) { deny(interaction, permission); return null; }
  return bot;
}

function modal(customId, title, fields) {
  const builder = new ModalBuilder().setCustomId(customId).setTitle(cut(title, 45));
  for (const field of fields) {
    const input = new TextInputBuilder()
      .setCustomId(field.id)
      .setLabel(cut(field.label, 45))
      .setStyle(field.style || TextInputStyle.Short)
      .setRequired(field.required !== false)
      .setMaxLength(field.maxLength || 200);
    if (field.placeholder) input.setPlaceholder(cut(field.placeholder, 100));
    if (field.value) input.setValue(cut(field.value, field.maxLength || 200));
    builder.addComponents(new ActionRowBuilder().addComponents(input));
  }
  return builder;
}

async function playerPage(bot, page = 0) {
  const data = await wardogsRequest(bot, '/v1/players');
  const players = Array.isArray(data?.players) ? data.players.filter((p) => Boolean(playerSteamId(p))) : [];
  const pages = Math.max(1, Math.ceil(players.length / 25));
  const safePage = Math.max(0, Math.min(pages - 1, Number(page) || 0));
  const slice = players.slice(safePage * 25, safePage * 25 + 25);
  const rows = [];
  if (slice.length) {
    const select = new StringSelectMenuBuilder().setCustomId(`wd:playersel:${bot.id}:${safePage}`).setPlaceholder('Select player').addOptions(slice.map((p) => ({
      label: cut(p?.name || playerSteamId(p) || 'Player', 100),
      value: playerSteamId(p),
      description: cut(`${p?.faction || '—'} · ${p?.pingMs ?? p?.ping ?? '—'} ms`, 100)
    })));
    rows.push(new ActionRowBuilder().addComponents(select));
  }
  if (pages > 1) rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`wd:playerpage:${bot.id}:${safePage - 1}`).setLabel('←').setStyle(ButtonStyle.Secondary).setDisabled(safePage <= 0),
    new ButtonBuilder().setCustomId(`wd:playerpage:${bot.id}:${safePage + 1}`).setLabel('→').setStyle(ButtonStyle.Secondary).setDisabled(safePage >= pages - 1)
  ));
  return { content: `**Live Players** · ${players.length} online · Page ${safePage + 1}/${pages}`, components: rows, ephemeral: true };
}

async function playerControl(bot, steamId) {
  const data = await wardogsRequest(bot, '/v1/players');
  const players = Array.isArray(data?.players) ? data.players : [];
  const player = players.find((p) => playerSteamId(p) === steamId);
  const name = player?.name || steamId;
  const embed = new EmbedBuilder().setTitle(cut(name, 256)).setDescription(`SteamID64: ${steamId}`)
    .addFields(
      { name: 'Faction', value: cut(player?.faction || '—', 1024), inline: true },
      { name: 'K/D', value: `${player?.kills ?? '—'} / ${player?.deaths ?? '—'}`, inline: true },
      { name: 'Ping', value: `${player?.pingMs ?? player?.ping ?? '—'} ms`, inline: true },
      { name: 'Cash', value: String(player?.cash ?? '—'), inline: true }
    );
  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`wd:pkick:${bot.id}:${steamId}`).setLabel('Kick').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`wd:pban:${bot.id}:${steamId}`).setLabel('Ban').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`wd:pwhisper:${bot.id}:${steamId}`).setLabel('Whisper').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`wd:pkill:${bot.id}:${steamId}`).setLabel('Kill').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setLabel('Steam').setStyle(ButtonStyle.Link).setURL(`https://steamcommunity.com/profiles/${steamId}`)
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`wd:pteam:${bot.id}:${steamId}`).setLabel('Set Team').setStyle(ButtonStyle.Primary)
      )
    ],
    ephemeral: true
  };
}

async function bansPanel(bot) {
  const data = await wardogsRequest(bot, '/v1/bans');
  const bans = Array.isArray(data?.bans) ? data.bans.filter((b) => validSteamId(b?.steamId)) : [];
  const rows = [];
  if (bans.length) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(`wd:unban:${bot.id}`).setPlaceholder('Select a ban to remove').addOptions(bans.slice(0, 25).map((b) => ({
        label: cut(b.steamId, 100), value: String(b.steamId), description: cut(b.reason || 'No reason', 100)
      })))
    ));
  }
  rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`wd:manualban:${bot.id}`).setLabel('Ban SteamID').setStyle(ButtonStyle.Danger)));
  return { content: `**Bans** · ${bans.length} entries${bans.length > 25 ? ' · showing the first 25' : ''}`, components: rows, ephemeral: true };
}

async function serverPanel(bot) {
  const status = await wardogsRequest(bot, '/v1/status');
  return {
    content: `**Server Controls** · ${cut(status?.serverName || 'WARDOGS', 80)} · ${cut(status?.map || '—', 80)}`,
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`wd:restartmatch:${bot.id}`).setLabel('Restart Match').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`wd:endmatch:${bot.id}`).setLabel('End Match').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`wd:map:${bot.id}`).setLabel('Change Map').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`wd:light:${bot.id}`).setLabel('Lighting').setStyle(ButtonStyle.Secondary)
    )],
    ephemeral: true
  };
}

async function mapPicker(bot) {
  const data = await wardogsRequest(bot, '/v1/catalog/maps');
  const maps = Array.isArray(data?.maps) ? data.maps : [];
  if (!maps.length) throw new Error('No maps were returned by the server');
  return {
    content: '**Select map**',
    components: [new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(`wd:mapsel:${bot.id}`).setPlaceholder('Select map').addOptions(maps.slice(0, 25).map((m) => ({
        label: cut(m.displayName || m.id || m.name || 'Map', 100), value: cut(m.id || m.name || '', 100)
      })).filter((x) => x.value))
    )],
    ephemeral: true
  };
}

function mapSetupComponents(bot, state) {
  const rows = [];
  const exp = Array.isArray(state.mapExperiences) ? state.mapExperiences.slice(0, 24) : [];
  const expOptions = [{ label: 'Server default / none', value: '__none__', default: !state.experiences?.length }, ...exp.map((id) => ({ label: cut(id, 100), value: cut(id, 100), default: state.experiences?.includes(String(id)) }))];
  rows.push(new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(`wd:mapexp:${bot.id}`).setPlaceholder('Experiences').setMinValues(1).setMaxValues(Math.min(expOptions.length, 10)).addOptions(expOptions)
  ));
  const lighting = Array.isArray(state.lightings) ? state.lightings.slice(0, 24) : [];
  rows.push(new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(`wd:maplight:${bot.id}`).setPlaceholder('Lighting').addOptions([
      { label: 'Server default', value: '__default__', default: !state.lighting },
      ...lighting.map((x) => ({ label: cut(x.displayName || x.id || x.name || 'Lighting', 100), value: cut(x.id || x.name || '', 100), default: state.lighting === String(x.id || x.name || '') })).filter((x) => x.value)
    ])
  ));
  const alternators = Array.isArray(state.alternators) ? state.alternators.slice(0, 24) : [];
  rows.push(new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(`wd:mapalt:${bot.id}`).setPlaceholder('Zone Alternator').addOptions([
      { label: 'Server default', value: '__default__', default: !state.zoneAlternator },
      ...alternators.map((x) => ({ label: cut(x.displayName || x.tag || 'Alternator', 100), value: cut(x.tag || x.id || '', 100), default: state.zoneAlternator === String(x.tag || x.id || '') })).filter((x) => x.value)
    ])
  ));
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`wd:mapapply:${bot.id}`).setLabel('Apply map change').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`wd:mapcancel:${bot.id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
  ));
  return rows;
}

async function setupMapState(bot, interaction, map) {
  const [details, lightingData] = await Promise.all([managedMapOptions(bot, map), wardogsRequest(bot, '/v1/catalog/lightings')]);
  const state = setUiState(bot.id, interaction.user.id, {
    map,
    experiences: [],
    lighting: '',
    zoneAlternator: '',
    mapExperiences: details.experiences.map((x) => String(typeof x === 'string' ? x : (x.id || x.name || ''))).filter(Boolean),
    alternators: details.alternators,
    lightings: Array.isArray(lightingData?.lightings) ? lightingData.lightings : []
  });
  return { content: `**Map Setup** · ${cut(map, 90)}\nChoose experiences, lighting and a zone alternator, then apply the map change.`, components: mapSetupComponents(bot, state), ephemeral: true };
}

async function lightingPicker(bot) {
  const data = await wardogsRequest(bot, '/v1/catalog/lightings');
  const lightings = Array.isArray(data?.lightings) ? data.lightings : [];
  if (!lightings.length) throw new Error('No lighting values were returned by the server');
  return {
    content: '**Select lighting**',
    components: [new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(`wd:lightset:${bot.id}`).setPlaceholder('Select lighting').addOptions(lightings.slice(0, 25).map((x) => ({
        label: cut(x.displayName || x.id || x.name || 'Lighting', 100), value: cut(x.id || x.name || '', 100)
      })).filter((x) => x.value))
    )],
    ephemeral: true
  };
}

function banDurationPicker(bot, target = 'manual') {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`wd:banduration:${bot.id}:${target}`)
    .setPlaceholder('Choose ban duration')
    .addOptions([
      { label: 'Permanent', value: 'permanent', description: 'Permanent ban' },
      { label: 'Hours', value: 'hours', description: 'Temporary ban in hours' },
      { label: 'Days', value: 'days', description: 'Temporary ban in days' }
    ]);
  return { content: '**Ban duration**', components: [new ActionRowBuilder().addComponents(select)], ephemeral: true };
}

function discordBanDurationMinutes(interaction, mode) {
  const normalized = String(mode || 'permanent').toLowerCase();
  if (normalized === 'permanent') return 0;
  if (!['hours', 'days'].includes(normalized)) throw new Error('Invalid ban duration mode');
  const value = Number(String(interaction.fields.getTextInputValue('durationValue') || '').replace(',', '.'));
  if (!Number.isFinite(value) || value <= 0) throw new Error('Ban duration must be greater than 0');
  const minutes = Math.round(value * (normalized === 'days' ? 1440 : 60));
  if (minutes < 1 || minutes > 525600) throw new Error('Ban duration is invalid or too long');
  return minutes;
}

async function teamPicker(bot, steamId) {
  const status = await wardogsRequest(bot, '/v1/status');
  const factions = Array.isArray(status?.factionScores) ? [...new Set(status.factionScores.map((x) => String(x?.name || '').trim()).filter(Boolean))] : [];
  if (!factions.length) throw new Error('No teams/factions were returned by the server');
  return {
    content: `**Set Team** · ${steamId}`,
    components: [new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(`wd:teamset:${bot.id}:${steamId}`).setPlaceholder('Select team').addOptions(factions.slice(0, 25).map((name) => ({ label: cut(name, 100), value: cut(name, 100) })))
    )],
    ephemeral: true
  };
}

async function handleLegacyAlertButton(interaction) {
  if (!interaction.isButton?.()) return false;
  const match = String(interaction.customId || '').match(/^(wdban|wdkick|wdignore):([0-9a-f-]{36}):(\d{17})$/i);
  if (!match) return false;
  const [, action, botId, steamId] = match;
  const permission = action === 'wdban' ? 'ban' : action === 'wdkick' ? 'kick' : 'ignore';
  const bot = interactionBot(interaction, botId, permission);
  if (!bot) return true;
  try {
    if (action === 'wdignore') {
      const existing = ignoredPlayers(bot);
      if (!existing.some((entry) => entry.steamId === steamId)) {
        const playerName = interaction.message?.embeds?.[0]?.fields?.find?.((field) => field.name === 'Player')?.value || '';
        upsertManagedBot({ id: bot.id, ignoredPlayers: [...existing, { steamId, name: cut(playerName, 100), ignoredAt: nowIso(), ignoredBy: String(interaction.user?.id || '') }].slice(-500) });
      }
      await interaction.update({ components: alertComponents(bot, { steamId }, true) }).catch(() => {});
      await interaction.followUp({ content: `SteamID64 ${steamId} is now ignored. No further detection alerts or auto-bans will be generated for this player until the ignore is removed in the web panel.`, ephemeral: true }).catch(() => {});
      return true;
    }
    await interaction.deferReply({ ephemeral: true }).catch(() => {});
    if (action === 'wdban') await banManagedPlayer(bot, steamId, `Discord action by ${interaction.user?.tag || interaction.user?.id || 'admin'}`);
    else await kickManagedPlayer(bot, steamId, `Discord action by ${interaction.user?.tag || interaction.user?.id || 'admin'}`);
    await interaction.editReply(`${action === 'wdban' ? 'Ban' : 'Kick'} for ${steamId} was sent to the WARDOGS server.`).catch(() => {});
  } catch (error) {
    const message = `Action failed: ${cut(error.message || error, 300)}`;
    if (interaction.deferred || interaction.replied) await interaction.followUp({ content: message, ephemeral: true }).catch(() => {});
    else await interaction.reply({ content: message, ephemeral: true }).catch(() => {});
  }
  return true;
}

async function handleButton(interaction, client, state) {
  if (!interaction.isButton?.()) return false;
  if (await handleLegacyAlertButton(interaction)) return true;
  const parts = String(interaction.customId || '').split(':');
  if (parts[0] !== 'wd') return false;
  const action = parts[1];
  const botId = parts[2];
  if (!botId) return false;
  try {
    if (action === 'players') {
      const bot = interactionBot(interaction, botId, 'view'); if (!bot) return true;
      await interaction.reply(await playerPage(bot, 0)); return true;
    }
    if (action === 'playerpage') {
      const bot = interactionBot(interaction, botId, 'view'); if (!bot) return true;
      { const payload=await playerPage(bot, Number(parts[3] || 0)); delete payload.ephemeral; await interaction.update(payload); } return true;
    }
    if (action === 'announce') {
      const bot = interactionBot(interaction, botId, 'announce'); if (!bot) return true;
      await interaction.showModal(modal(`wd:mannounce:${bot.id}`, 'Server Announcement', [{ id: 'message', label: 'Message', style: TextInputStyle.Paragraph, maxLength: 200, placeholder: 'Server restart in 10 minutes…' }])); return true;
    }
    if (action === 'bans') {
      const bot = interactionBot(interaction, botId, 'view'); if (!bot) return true;
      await interaction.reply(await bansPanel(bot)); return true;
    }
    if (action === 'server') {
      const bot = interactionBot(interaction, botId, 'view'); if (!bot) return true;
      await interaction.reply(await serverPanel(bot)); return true;
    }
    if (action === 'refresh') {
      const bot = interactionBot(interaction, botId, 'view'); if (!bot) return true;
      await ensureControlPanel(bot, client, state);
      await interaction.reply({ content: 'Management panel refreshed.', ephemeral: true }); return true;
    }
    if (['pkick','pban','pwhisper','pkill','pteam'].includes(action)) {
      const steamId = parts[3]; if (!validSteamId(steamId)) throw new Error('Invalid SteamID64');
      const permission = ({ pkick: 'kick', pban: 'ban', pwhisper: 'whisper', pkill: 'kill', pteam: 'setteam' })[action];
      const bot = interactionBot(interaction, botId, permission); if (!bot) return true;
      if (action === 'pkick') await interaction.showModal(modal(`wd:mkick:${bot.id}:${steamId}`, 'Kick player', [{ id: 'reason', label: 'Reason', maxLength: 180, required: false, placeholder: 'Rule violation' }]));
      else if (action === 'pban') await interaction.reply(banDurationPicker(bot, steamId));
      else if (action === 'pwhisper') await interaction.showModal(modal(`wd:mwhisper:${bot.id}:${steamId}`, 'Whisper', [{ id: 'message', label: 'Message', style: TextInputStyle.Paragraph, maxLength: 200 }]));
      else if (action === 'pkill') { await killManagedPlayer(bot, steamId); await interaction.reply({ content: `Kill/respawn sent for ${steamId}.`, ephemeral: true }); }
      else await interaction.reply(await teamPicker(bot, steamId));
      return true;
    }
    if (action === 'manualban') {
      const bot = interactionBot(interaction, botId, 'ban'); if (!bot) return true;
      await interaction.reply(banDurationPicker(bot, 'manual')); return true;
    }
    if (action === 'restartmatch' || action === 'endmatch') {
      const bot = interactionBot(interaction, botId, 'match'); if (!bot) return true;
      if (action === 'restartmatch') await restartManagedMatch(bot); else await endManagedMatch(bot);
      await interaction.reply({ content: action === 'restartmatch' ? 'Match restart sent.' : 'Match end sent.', ephemeral: true }); return true;
    }
    if (action === 'map') {
      const bot = interactionBot(interaction, botId, 'map'); if (!bot) return true;
      await interaction.reply(await mapPicker(bot)); return true;
    }
    if (action === 'light') {
      const bot = interactionBot(interaction, botId, 'lighting'); if (!bot) return true;
      await interaction.reply(await lightingPicker(bot)); return true;
    }
    if (action === 'mapapply') {
      const bot = interactionBot(interaction, botId, 'map'); if (!bot) return true;
      const saved = getUiState(bot.id, interaction.user.id); if (!saved.map) throw new Error('No map selected');
      await changeManagedMap(bot, { map: saved.map, experiences: saved.experiences || [], lighting: saved.lighting || '', zoneAlternator: saved.zoneAlternator || '' });
      discordUiState.delete(uiKey(bot.id, interaction.user.id));
      await interaction.update({ content: `Map change to **${cut(saved.map, 90)}** sent.`, components: [] }); return true;
    }
    if (action === 'mapcancel') {
      interactionBot(interaction, botId, 'map');
      discordUiState.delete(uiKey(botId, interaction.user.id));
      await interaction.update({ content: 'Map change cancelled.', components: [] }); return true;
    }
  } catch (error) {
    const payload = { content: `Action failed: ${cut(error.message || error, 300)}`, ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => {}); else await interaction.reply(payload).catch(() => {});
    return true;
  }
  return false;
}

async function handleSelect(interaction) {
  if (!interaction.isStringSelectMenu?.()) return false;
  const parts = String(interaction.customId || '').split(':');
  if (parts[0] !== 'wd') return false;
  const action = parts[1], botId = parts[2];
  try {
    if (action === 'playersel') {
      const bot = interactionBot(interaction, botId, 'view'); if (!bot) return true;
      const steamId = String(interaction.values?.[0] || ''); if (!validSteamId(steamId)) throw new Error('Invalid SteamID64');
      await interaction.reply(await playerControl(bot, steamId)); return true;
    }
    if (action === 'banduration') {
      const bot = interactionBot(interaction, botId, 'ban'); if (!bot) return true;
      const target = String(parts[3] || 'manual');
      const mode = String(interaction.values?.[0] || 'permanent');
      if (!['permanent','hours','days'].includes(mode)) throw new Error('Invalid ban duration mode');
      const durationField = mode === 'permanent' ? [] : [{ id: 'durationValue', label: mode === 'days' ? 'Duration in days' : 'Duration in hours', maxLength: 7, placeholder: mode === 'days' ? '7' : '24' }];
      if (target === 'manual') {
        await interaction.showModal(modal(`wd:mmanualban:${bot.id}:manual:${mode}`, 'Ban SteamID', [
          { id: 'steamId', label: 'SteamID64', maxLength: 17, placeholder: '7656119…' },
          { id: 'reason', label: 'Reason', maxLength: 180, required: false, placeholder: 'Rule violation' },
          ...durationField
        ]));
      } else {
        if (!validSteamId(target)) throw new Error('Invalid SteamID64');
        await interaction.showModal(modal(`wd:mbanplayer:${bot.id}:${target}:${mode}`, 'Ban player', [
          { id: 'reason', label: 'Reason', maxLength: 180, required: false, placeholder: 'Rule violation' },
          ...durationField
        ]));
      }
      return true;
    }
    if (action === 'unban') {
      const bot = interactionBot(interaction, botId, 'unban'); if (!bot) return true;
      const steamId = String(interaction.values?.[0] || ''); await unbanManagedPlayer(bot, steamId);
      await interaction.update({ content: `Ban for ${steamId} removed.`, components: [] }); return true;
    }
    if (action === 'teamset') {
      const steamId = parts[3]; const bot = interactionBot(interaction, botId, 'setteam'); if (!bot) return true;
      const faction = String(interaction.values?.[0] || ''); await moveManagedPlayer(bot, steamId, faction);
      await interaction.update({ content: `${steamId} was moved to **${cut(faction, 80)}** and respawned.`, components: [] }); return true;
    }
    if (action === 'mapsel') {
      const bot = interactionBot(interaction, botId, 'map'); if (!bot) return true;
      const map = String(interaction.values?.[0] || ''); { const payload=await setupMapState(bot, interaction, map); delete payload.ephemeral; await interaction.update(payload); } return true;
    }
    if (['mapexp','maplight','mapalt'].includes(action)) {
      const bot = interactionBot(interaction, botId, 'map'); if (!bot) return true;
      const state = getUiState(bot.id, interaction.user.id); if (!state.map) throw new Error('Map selection expired');
      if (action === 'mapexp') state.experiences = interaction.values.includes('__none__') ? [] : interaction.values.slice(0, 10);
      if (action === 'maplight') state.lighting = interaction.values[0] === '__default__' ? '' : String(interaction.values[0] || '');
      if (action === 'mapalt') state.zoneAlternator = interaction.values[0] === '__default__' ? '' : String(interaction.values[0] || '');
      setUiState(bot.id, interaction.user.id, state);
      await interaction.update({ content: `**Map Setup** · ${cut(state.map, 90)}\nChoose experiences, lighting and a zone alternator, then apply the map change.`, components: mapSetupComponents(bot, state) }); return true;
    }
    if (action === 'lightset') {
      const bot = interactionBot(interaction, botId, 'lighting'); if (!bot) return true;
      const lighting = String(interaction.values?.[0] || ''); await setManagedLighting(bot, lighting);
      await interaction.update({ content: `Lighting **${cut(lighting, 90)}** applied.`, components: [] }); return true;
    }
  } catch (error) {
    const payload = { content: `Action failed: ${cut(error.message || error, 300)}`, components: [], ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => {}); else await interaction.reply(payload).catch(() => {});
    return true;
  }
  return false;
}

async function handleModal(interaction) {
  if (!interaction.isModalSubmit?.()) return false;
  const parts = String(interaction.customId || '').split(':');
  if (parts[0] !== 'wd') return false;
  const action = parts[1], botId = parts[2], steamId = parts[3], durationMode = parts[4] || 'permanent';
  try {
    if (action === 'mannounce') {
      const bot = interactionBot(interaction, botId, 'announce'); if (!bot) return true;
      const message = interaction.fields.getTextInputValue('message'); await broadcastManaged(bot, message);
      await interaction.reply({ content: 'Server announcement sent.', ephemeral: true }); return true;
    }
    if (action === 'mkick') {
      const bot = interactionBot(interaction, botId, 'kick'); if (!bot) return true;
      const reason = interaction.fields.getTextInputValue('reason') || 'Discord panel kick'; await kickManagedPlayer(bot, steamId, reason);
      await interaction.reply({ content: `Kick for ${steamId} sent.`, ephemeral: true }); return true;
    }
    if (action === 'mbanplayer') {
      const bot = interactionBot(interaction, botId, 'ban'); if (!bot) return true;
      const reason = interaction.fields.getTextInputValue('reason') || 'Discord panel ban';
      const duration = discordBanDurationMinutes(interaction, durationMode);
      if (duration > 0) {
        const entry = await temporaryBanManagedPlayer(bot, steamId, reason, duration, { createdBy: `discord:${interaction.user?.id || ''}` });
        await interaction.reply({ content: `${steamId} was temporarily banned for ${formatManagedBanDuration(duration)} (until ${entry.expiresAt}).`, ephemeral: true });
      } else {
        await banManagedPlayer(bot, steamId, reason);
        await interaction.reply({ content: `${steamId} was permanently banned.`, ephemeral: true });
      }
      return true;
    }
    if (action === 'mwhisper') {
      const bot = interactionBot(interaction, botId, 'whisper'); if (!bot) return true;
      const message = interaction.fields.getTextInputValue('message'); await whisperManagedPlayer(bot, steamId, message);
      await interaction.reply({ content: `Whisper sent to ${steamId}.`, ephemeral: true }); return true;
    }
    if (action === 'mmanualban') {
      const bot = interactionBot(interaction, botId, 'ban'); if (!bot) return true;
      const id = interaction.fields.getTextInputValue('steamId').trim(); if (!validSteamId(id)) throw new Error('Invalid SteamID64');
      const reason = interaction.fields.getTextInputValue('reason') || 'Discord panel ban';
      const duration = discordBanDurationMinutes(interaction, durationMode);
      if (duration > 0) {
        const entry = await temporaryBanManagedPlayer(bot, id, reason, duration, { createdBy: `discord:${interaction.user?.id || ''}` });
        await interaction.reply({ content: `${id} was temporarily banned for ${formatManagedBanDuration(duration)} (until ${entry.expiresAt}).`, ephemeral: true });
      } else {
        await banManagedPlayer(bot, id, reason);
        await interaction.reply({ content: `${id} was permanently banned.`, ephemeral: true });
      }
      return true;
    }
  } catch (error) {
    const payload = { content: `Action failed: ${cut(error.message || error, 300)}`, ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => {}); else await interaction.reply(payload).catch(() => {});
    return true;
  }
  return false;
}

async function handleInteraction(interaction, client, state) {
  if (await handleButton(interaction, client, state)) return;
  if (await handleSelect(interaction)) return;
  await handleModal(interaction);
}

async function cleanupLegacySeedingDiscordNickname(bot, client) {
  if (!client?.isReady?.()) return;
  const desired = String(bot?.name || '').trim().slice(0, 32);
  for (const guild of client.guilds.cache.values()) {
    try {
      const member = guild.members.me || await guild.members.fetchMe();
      const current = String(member?.displayName || '');
      if (!/\s+JOIN Seeding$/i.test(current)) continue;
      await member.setNickname(desired || null, 'Remove legacy v3.12.19 seeding nickname');
    } catch {}
  }
}

async function stopOne(id, keepRuntime = true) {
  const active = instances.get(id);
  // Remove it from the registry first so no status path can treat it as live while
  // Discord is being disconnected.
  if (active) instances.delete(id);
  if (active) {
    clearInterval(active.timer);
    clearTimeout(active.state?.panelRepostTimer);
    clearInterval(active.state?.welcomeTimer);
    const stored = getManagedBot(id) || { id };
    try { await updateManagedSeedingServerName({ ...stored, seedingNameEnabled: false }, active.state, 0, { force: true }); } catch {}
    try { await deleteStoredControlPanel(stored, active.client, active.state); } catch {}
    try { await active.client.destroy(); } catch {}
  }
  if (keepRuntime) setRuntime(id, { state: 'stopped', botTag: null, players: null, controlPanelMessageId: null, lastError: null });
  else runtime.delete(id);
}

async function startOne(bot) {
  await stopOne(bot.id, false);
  if (!bot.enabled || !accessActive(bot)) { setRuntime(bot.id, { state: accessActive(bot) ? 'stopped' : 'access-expired' }); return; }
  parseManagedRules(bot.rulesText || '');
  if (!bot.botTokenEnc) throw new Error('Discord bot token is missing');
  if (!bot.alertChannelId) throw new Error('Discord alert channel ID is missing');
  if (bot.controlPanelEnabled && !validSnowflake(bot.controlPanelChannelId)) throw new Error('Discord management panel channel ID is missing or invalid');
  const token = decryptSecret(bot.botTokenEnc);
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
  const state = { joinTracker: createManagedJoinTracker(), baselineReady: false, pollInFlight: false, welcomePending: new Set(), welcomeDelivered: new Set(), welcomeFailed: new Set(), welcomeAttempts: new Map(), welcomeInFlight: false, welcomePollInFlight: false, welcomeJoinTracker: createManagedJoinTracker(), welcomeTimer: null, seedingServerActive: null, seedingServerName: '', lastSeedingServerCheckAt: 0, panelMessageId: String(bot.controlPanelMessageId || ''), panelChannelId: String(bot.controlPanelMessageChannelId || '') };
  try {
    client.on('interactionCreate', (interaction) => handleInteraction(interaction, client, state).catch((error) => console.error(`Managed bot interaction ${bot.id}:`, error.message)));
    client.on('messageCreate', (message) => {
      const fresh = getManagedBot(bot.id);
      if (!fresh?.controlPanelEnabled || !fresh?.enabled || String(message.channelId || '') !== String(fresh.controlPanelChannelId || '')) return;
      if (state.panelPosting || String(message.id || '') === String(state.panelMessageId || '')) return;
      scheduleControlPanelBottom(bot.id, client, state);
    });
    client.on('error', (error) => setRuntime(bot.id, { lastError: error.message }));
    client.on('shardDisconnect', () => setRuntime(bot.id, { state: 'disconnected', needsRecovery: true, disconnectedAt: Date.now(), lastError: 'Discord connection lost' }));
    client.on('shardError', (error) => setRuntime(bot.id, { state: 'disconnected', needsRecovery: true, disconnectedAt: Date.now(), lastError: String(error?.message || 'Discord shard error').slice(0, 300) }));
    client.on('invalidated', () => setRuntime(bot.id, { state: 'disconnected', needsRecovery: true, disconnectedAt: Date.now(), lastError: 'Discord session invalidated' }));
    client.on('shardResume', () => setRuntime(bot.id, { state: 'connected', needsRecovery: false, disconnectedAt: null, lastError: null }));
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Discord login timeout')), 20000);
      client.once('clientReady', () => { clearTimeout(timeout); resolve(); });
      client.login(token).catch((error) => { clearTimeout(timeout); reject(error); });
    });
    // A stop may have been requested while Discord was logging in. Do not publish a
    // live instance if the database has already been disabled.
    const freshBeforeRun = getManagedBot(bot.id) || bot;
    if (!freshBeforeRun.enabled || !accessActive(freshBeforeRun)) {
      try { await client.destroy(); } catch {}
      setRuntime(bot.id, { state: accessActive(freshBeforeRun) ? 'stopped' : 'access-expired' });
      return;
    }
    if (!freshBeforeRun.controlPanelEnabled && (freshBeforeRun.controlPanelMessageId || freshBeforeRun.controlPanelMessageChannelId)) await deleteStoredControlPanel(freshBeforeRun, client, state);
    // v3.12.19 briefly used the Discord guild nickname for JOIN Seeding. Clean that
    // legacy suffix once; seeding now belongs exclusively to the WARDOGS server name.
    await cleanupLegacySeedingDiscordNickname(freshBeforeRun, client);
    setRuntime(bot.id, { state: 'connected', botTag: client.user?.tag || '', botId: client.user?.id || '', lastError: null });
    await pollPlayers(freshBeforeRun, state, client);
    if (freshBeforeRun.welcomeWhisperEnabled === true) await pollManagedWelcome(freshBeforeRun, state);
    state.welcomeTimer = setInterval(() => {
      const fresh = getManagedBot(bot.id);
      if (!fresh?.enabled || !accessActive(fresh) || fresh.welcomeWhisperEnabled !== true) return;
      pollManagedWelcome(fresh, state).catch((error) => setRuntime(bot.id, { lastWelcomeWhisperError: String(error?.message || error).slice(0, 300) }));
    }, WELCOME_RETRY_MS);
    state.welcomeTimer.unref?.();
    const timer = setInterval(() => {
      const fresh = getManagedBot(bot.id);
      if (!fresh?.enabled || !accessActive(fresh)) return;
      pollPlayers(fresh, state, client).catch(() => {});
    }, Math.max(10, Math.min(300, Number(freshBeforeRun.pollSeconds) || 20)) * 1000);
    timer.unref?.();
    instances.set(bot.id, { client, timer, signature: signature(freshBeforeRun), state });
    clearRecovery(bot.id);
  } catch (error) {
    try { await client.destroy(); } catch {}
    throw error;
  }
}

export async function syncManagedBots(bots) {
  const supported = (bots || []).filter((bot) => String(bot?.serviceId || 'wardogs-warning-bot') === 'wardogs-warning-bot');
  const snapshots = new Map(supported.map((bot) => [bot.id, bot]));
  const ids = new Set([...instances.keys(), ...snapshots.keys()]);
  for (const id of ids) {
    await withLifecycleLock(id, async () => {
      let fresh = getManagedBot(id) || snapshots.get(id);
      // Temporary-ban cleanup is independent from the Discord client and still runs
      // while a bot is stopped so an expired local timer cannot leave a player banned.
      if (fresh && temporaryBans(fresh).length) {
        try { await expireManagedTemporaryBans(fresh); } catch (error) { setRuntime(id, { lastTemporaryBanError: String(error?.message || error).slice(0, 300) }); }
        fresh = getManagedBot(id) || fresh;
      }
      if (!fresh || !fresh.enabled || !accessActive(fresh)) {
        if (instances.has(id)) await stopOne(id);
        recoveryState.delete(id);
        setRuntime(id, { state: fresh?.enabled && !accessActive(fresh) ? 'access-expired' : 'stopped', botTag: null, players: null, needsRecovery: false, nextRecoveryAt: null });
        return;
      }
      const existing = instances.get(id);
      const sig = signature(fresh);
      const rt = managedBotRuntime(id);
      if (existing?.signature === sig) {
        const ready = typeof existing.client?.isReady === 'function' ? existing.client.isReady() : true;
        const disconnectedAt = Number(rt?.disconnectedAt || 0);
        const needsRecovery = !ready || rt?.needsRecovery === true;
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

export async function stopManagedBot(id) {
  return withLifecycleLock(id, () => stopOne(id));
}
export async function restartManagedBot(bot) {
  return withLifecycleLock(bot.id, async () => {
    const fresh = getManagedBot(bot.id) || bot;
    recoveryState.delete(bot.id);
    try {
      await startOne(fresh);
      return managedBotRuntime(bot.id);
    } catch (error) {
      await stopOne(bot.id, false);
      markRecoveryFailure(bot.id, error);
      throw error;
    }
  });
}

export async function shutdownManagedBots() { for (const id of [...instances.keys()]) await withLifecycleLock(id, () => stopOne(id, false)); }
