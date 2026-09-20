import crypto from 'node:crypto';
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
import { factionMatches, normalizeSteamId64, playerFaction, playerHasPlayableFaction, playerSteamId, playerWardogsApiId, wardogsPlayerRows } from './wardogs-players.js';
import { createManagedJoinTracker, managedJoinCandidates, managedMatchBoundary, markManagedJoinBoundary, managedWelcomeFailed, managedWelcomeSucceeded, managedWelcomeTargets, renderManagedWelcomeMessage } from './managed-welcome.js';
import { desiredDynamicServerName } from './managed-dynamic-name.js';
import { normalizeManagedServers, managedServerContext, managedServerContexts, managedServerByChannel, managedServerPatch } from './managed-servers.js';
import { appendManagedChat } from './managed-chat.js';
export { normalizeSteamId64 } from './wardogs-players.js';
export { createManagedJoinTracker, managedJoinCandidates, managedMatchBoundary, markManagedJoinBoundary, managedWelcomeFailed, managedWelcomeSucceeded, managedWelcomeTargets, renderManagedWelcomeMessage } from './managed-welcome.js';
import { getManagedBot, upsertManagedBot, getBanSyncServer, listBanSyncServers, upsertBanSyncServer, deleteBanSyncServer } from './db.js';
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
const WELCOME_RETRY_MS = 2000;
// Poll quickly enough to observe the team-selection transition, then require the
// selected faction to remain stable and give the spawned pawn a short settle
// window before the private welcome. This also works during seeding.
const WELCOME_SPAWN_SETTLE_MS = 5_000;
const WELCOME_TEAM_STABLE_POLLS = 2;
const WELCOME_LEAVE_CONFIRM_POLLS = 2;
// A new match can temporarily empty /v1/players even though the same people stay
// connected. Give complete-roster outages a short extra grace while explicit
// match-boundary detection handles longer transitions without masking real rejoins.
const WELCOME_EMPTY_ROSTER_CONFIRM_POLLS = 6;
const WELCOME_MATCH_CARRYOVER_MS = 90_000;
const DYNAMIC_BAN_POLL_MS = 2_000;
const DYNAMIC_BAN_LEAVE_CONFIRM_POLLS = 2;

// WARDOGS is most reliable when a single request at a time targets one game
// server. Background polling, the web dashboard and Discord actions used to race
// each other here. Keep one promise lane per managed bot/server.
const wardogsLanes = new Map();
function withWardogsLane(bot, task) {
  const key = String(baseUrl(bot?.wardogsBaseUrl) || bot?.id || 'wardogs');
  const previous = wardogsLanes.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  wardogsLanes.set(key, current);
  return current.finally(() => { if (wardogsLanes.get(key) === current) wardogsLanes.delete(key); });
}

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

function dynamicBans(bot) {
  return (Array.isArray(bot?.dynamicBans) ? bot.dynamicBans : []).map((entry) => ({
    steamId: normalizeSteamId64(entry?.steamId),
    reason: String(entry?.reason || '').slice(0, 180),
    expiresAt: entry?.expiresAt || null,
    createdAt: entry?.createdAt || null,
    createdBy: String(entry?.createdBy || '').slice(0, 100),
    templateId: String(entry?.templateId || '').slice(0, 64),
    escalated: entry?.escalated === true,
    escalatedAt: entry?.escalatedAt || null,
    joinAttempts: (Array.isArray(entry?.joinAttempts) ? entry.joinAttempts : []).map(String).filter((x) => Number.isFinite(Date.parse(x))).slice(-50)
  })).filter((entry) => entry.steamId && Number.isFinite(Date.parse(entry.expiresAt || '')));
}

function banSyncRequests(bot) {
  return (Array.isArray(bot?.banSyncRequests) ? bot.banSyncRequests : []).map((row) => ({
    sourceBotId: String(row?.sourceBotId || '').trim().slice(0, 80),
    sourceOwnerDiscordId: String(row?.sourceOwnerDiscordId || '').trim().slice(0, 20),
    requestedAt: row?.requestedAt || null
  })).filter((row) => row.sourceBotId);
}
function banSyncAcceptedSources(bot) { return [...new Set((Array.isArray(bot?.banSyncAcceptedSources) ? bot.banSyncAcceptedSources : []).map((x) => String(x || '').trim()).filter(Boolean))]; }
function banSyncMirrors(bot) {
  return (Array.isArray(bot?.banSyncMirrors) ? bot.banSyncMirrors : []).map((row) => ({
    sourceBotId: String(row?.sourceBotId || '').trim().slice(0, 80), steamId: normalizeSteamId64(row?.steamId),
    mode: ['permanent','temporary','dynamic'].includes(String(row?.mode || '')) ? String(row.mode) : 'permanent',
    expiresAt: row?.expiresAt || null, reason: String(row?.reason || '').slice(0, 180), createdAt: row?.createdAt || null
  })).filter((row) => row.sourceBotId && row.steamId);
}

export function managedAuditEntries(bot) {
  return (Array.isArray(bot?.auditLog) ? bot.auditLog : []).map((row) => ({
    id: String(row?.id || ''), at: row?.at || null, actor: String(row?.actor || '').slice(0, 100), action: String(row?.action || '').slice(0, 80), target: String(row?.target || '').slice(0, 100), detail: String(row?.detail || '').slice(0, 500), status: String(row?.status || 'ok').slice(0, 20)
  })).filter((row) => row.action && Number.isFinite(Date.parse(row.at || '')));
}
export function appendManagedAudit(botOrId, event = {}) {
  const id = typeof botOrId === 'object' ? String(botOrId?.id || '') : String(botOrId || '');
  if (!id) return null;
  const fresh = getManagedBot(id); if (!fresh) return null;
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    at: nowIso(), actor: String(event?.actor || 'system').slice(0, 100), action: String(event?.action || 'event').slice(0, 80),
    target: String(event?.target || '').slice(0, 100), detail: String(event?.detail || '').slice(0, 500), status: String(event?.status || 'ok').slice(0, 20)
  };
  upsertManagedBot({ id, auditLog: [...managedAuditEntries(fresh), entry].slice(-500) });
  return entry;
}
function setRuntime(id, patch) { runtime.set(id, { ...(runtime.get(id) || {}), ...patch, updatedAt: nowIso() }); }
function serverRuntimeKey(bot) { return bot?._managedServerId ? `${bot.id}:${bot._managedServerId}` : String(bot?.id || ''); }
function setServerRuntime(bot, patch) {
  const parentId = String(bot?.id || '');
  const key = serverRuntimeKey(bot);
  const current = runtime.get(parentId) || {};
  const servers = { ...(current.servers || {}), [key]: { ...((current.servers || {})[key] || {}), ...patch, updatedAt: nowIso(), serverId: bot?._managedServerId || 'primary', label: bot?._managedServerLabel || '' } };
  runtime.set(parentId, { ...current, ...patch, servers, updatedAt: nowIso() });
}
function persistManagedServerState(bot, patch) {
  if (!bot?._managedServerId) return upsertManagedBot({ id: bot.id, ...patch });
  const fresh = getManagedBot(bot.id);
  if (!fresh) return null;
  return upsertManagedBot({ id: fresh.id, managedServers: managedServerPatch(fresh, bot._managedServerId, patch) });
}
function serverStateTemplate(bot) {
  return { joinTracker: createManagedJoinTracker(), baselineReady: false, pollInFlight: false, dynamicPollInFlight: false, dynamicNameRotationStartedAt: Date.now(), dynamicNameBlockedUntil: 0, dynamicNameLastAppliedName: '', dynamicNameLastAppliedAtMs: 0, dynamicJoinTracker: createManagedJoinTracker(), dynamicTimer: null, welcomePending: new Set(), welcomeDelivered: new Set(), welcomeFailed: new Set(), welcomeAttempts: new Map(), welcomeReadyAt: new Map(), welcomeInitialFactionKey: new Map(), welcomeSawPreTeam: new Set(), welcomeTeamChoiceConfirmed: new Set(), welcomeFactionStableKey: new Map(), welcomeFactionStablePolls: new Map(), welcomeValidFactions: [], welcomeMatchSnapshot: null, welcomeInFlight: false, welcomePollInFlight: false, welcomeJoinTracker: createManagedJoinTracker(), welcomeTimer: null, panelMessageId: String(bot?.controlPanelMessageId || ''), panelChannelId: String(bot?.controlPanelMessageChannelId || '') };
}
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
function botUiId(bot) { return bot?._managedServerId ? `${bot.id}@${bot._managedServerId}` : String(bot?.id || ''); }
export function managedBotRuntime(id) { return runtime.get(id) || { state: 'stopped' }; }

export function managedSteamRuleStatus(bot) {
  const rules = parseManagedRules(bot?.rulesText || '');
  return { needsSteam: managedRulesNeedSteam(rules), apiKeyAvailable: steamApiKeyAvailable(bot) };
}

async function wardogsRequestDirect(bot, pathname, { method = 'GET', body } = {}) {
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

async function wardogsRequest(bot, pathname, options = {}) {
  return withWardogsLane(bot, () => wardogsRequestDirect(bot, pathname, options));
}

async function wardogsTextRequestDirect(bot, pathname, { method = 'GET', textBody, headers = {} } = {}) {
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

async function wardogsTextRequest(bot, pathname, options = {}) {
  return withWardogsLane(bot, () => wardogsTextRequestDirect(bot, pathname, options));
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


export async function restoreManagedDynamicServerName(bot) {
  const original = String(bot?.dynamicNameOriginalName || '').trim();
  if (!original) return { changed: false, restored: false };
  const status = await wardogsRequest(bot, '/v1/status');
  const current = String(status?.serverName || '').trim();
  let result = { changed: false, serverName: original };
  if (current !== original) result = await writeManagedServerName(bot, original);
  persistManagedServerState(bot, { dynamicNameOriginalName: '', dynamicNameLastAppliedName: '' });
  setServerRuntime(bot, { dynamicNameActive: false, dynamicNameCurrent: original, dynamicNameLastError: null, dynamicNameLastAppliedAt: nowIso() });
  return { ...result, restored: true };
}

async function syncManagedDynamicServerName(bot, state, status, playerCount) {
  if (bot?.dynamicNameEnabled !== true) return;
  if (Number(state?.dynamicNameBlockedUntil || 0) > Date.now()) return;
  let working = bot;
  let original = String(working?.dynamicNameOriginalName || '').trim();
  const current = String(status?.serverName || '').trim();
  if (!original) {
    original = current;
    if (!original) return;
    persistManagedServerState(bot, { dynamicNameOriginalName: original });
    working = { ...working, dynamicNameOriginalName: original };
  }
  if (!state.dynamicNameRotationStartedAt) state.dynamicNameRotationStartedAt = Date.now();
  const desired = desiredDynamicServerName(working, status, state, Date.now(), playerCount);
  if (!desired) return;
  if (current !== desired && state.dynamicNameLastAppliedName === desired && Date.now() - Number(state.dynamicNameLastAppliedAtMs || 0) < 60_000) return;
  if (current === desired) {
    setServerRuntime(bot, { dynamicNameActive: true, dynamicNameCurrent: desired, dynamicNameOriginal: original, dynamicNameLastError: null });
    return;
  }
  try {
    await writeManagedServerName(working, desired);
    state.dynamicNameLastAppliedName = desired;
    state.dynamicNameLastAppliedAtMs = Date.now();
    persistManagedServerState(bot, { dynamicNameLastAppliedName: desired });
    setServerRuntime(bot, { dynamicNameActive: true, dynamicNameCurrent: desired, dynamicNameOriginal: original, dynamicNameLastError: null, dynamicNameLastAppliedAt: nowIso() });
  } catch (error) {
    state.dynamicNameBlockedUntil = Date.now() + 60_000;
    setServerRuntime(bot, { dynamicNameActive: false, dynamicNameOriginal: original, dynamicNameLastError: String(error?.message || error).slice(0, 300) });
  }
}

export async function testManagedWardogs(bot) {
  const [status, players] = await Promise.all([wardogsRequest(bot, '/v1/status'), wardogsRequest(bot, '/v1/players')]);
  return { status, playerCount: wardogsPlayerRows(players).length || Number(players?.count || 0) };
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

function banSyncServerForBot(bot) {
  const roomId = String(bot?.banSyncServerId || '').trim();
  if (!roomId) return null;
  const room = getBanSyncServer(roomId);
  if (!room || !(Array.isArray(room.members) ? room.members : []).map(String).includes(String(bot?.id || ''))) return null;
  return room;
}

function banSyncPasswordHash(password) {
  const clean = String(password || '');
  if (clean.length < 4 || clean.length > 64) throw new Error('Ban Sync Community password must be 4–64 characters long');
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(clean, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function banSyncPasswordMatches(stored, password) {
  const [kind, saltHex, hashHex] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !/^[0-9a-f]+$/i.test(saltHex || '') || !/^[0-9a-f]+$/i.test(hashHex || '')) return false;
  try {
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(password || ''), Buffer.from(saltHex, 'hex'), expected.length);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch { return false; }
}
function banSyncSharedRows(room) {
  return (Array.isArray(room?.sharedBans) ? room.sharedBans : []).map((row) => ({
    steamId: normalizeSteamId64(row?.steamId),
    mode: ['permanent','temporary','dynamic'].includes(String(row?.mode || '')) ? String(row.mode) : 'permanent',
    reason: String(row?.reason || '').slice(0,180),
    expiresAt: row?.expiresAt || null,
    templateId: String(row?.templateId || '').slice(0,64),
    sourceBotId: String(row?.sourceBotId || '').slice(0,80),
    updatedAt: row?.updatedAt || null
  })).filter((row) => row.steamId && (row.mode === 'permanent' || Date.parse(row.expiresAt || '') > Date.now()));
}
function banSyncMembers(room) {
  return [...new Set((Array.isArray(room?.members) ? room.members : []).map(String).filter(Boolean))]
    .map((id) => getManagedBot(id))
    .filter((bot) => bot && String(bot.serviceId || '') === 'wardogs-warning-bot');
}
function banSyncCommunityPolicy(room) {
  return {
    dynamicBanEnabled: room?.dynamicBanEnabled === true,
    dynamicBanEscalateJoins: Math.max(2, Math.min(20, Math.floor(Number(room?.dynamicBanEscalateJoins) || 3))),
    dynamicBanEscalateWindowMinutes: Math.max(1, Math.min(1440, Math.floor(Number(room?.dynamicBanEscalateWindowMinutes) || 5)))
  };
}
function applyBanSyncCommunityPolicy(room, actor = 'system') {
  const policy = banSyncCommunityPolicy(room);
  let updated = 0;
  for (const member of banSyncMembers(room)) {
    const fresh = getManagedBot(member.id) || member;
    const changed = fresh.dynamicBanEnabled !== policy.dynamicBanEnabled
      || Number(fresh.dynamicBanEscalateJoins || 3) !== policy.dynamicBanEscalateJoins
      || Number(fresh.dynamicBanEscalateWindowMinutes || 5) !== policy.dynamicBanEscalateWindowMinutes;
    if (!changed) continue;
    upsertManagedBot({ id: fresh.id, ...policy });
    appendManagedAudit(fresh.id, {
      actor,
      action: 'ban-sync-community-policy-applied',
      target: String(room?.id || ''),
      detail: `Dynamic Ban ${policy.dynamicBanEnabled ? 'on' : 'off'} · ${policy.dynamicBanEscalateJoins} joins / ${policy.dynamicBanEscalateWindowMinutes} min`
    });
    updated += 1;
  }
  return { ...policy, updated };
}

export async function updateManagedBanSyncCommunitySettings(bot, settings = {}, actor = 'web') {
  const source = getManagedBot(bot?.id) || bot;
  const room = banSyncServerForBot(source);
  if (!source?.id || !room) throw new Error('This bot is not connected to a Ban Sync Community');
  if (String(room.ownerBotId || '') !== String(source.id)) throw new Error('Only the Ban Sync Community owner can change shared Dynamic Ban settings');
  const policy = {
    dynamicBanEnabled: settings?.dynamicBanEnabled === true,
    dynamicBanEscalateJoins: Math.max(2, Math.min(20, Math.floor(Number(settings?.dynamicBanEscalateJoins) || 3))),
    dynamicBanEscalateWindowMinutes: Math.max(1, Math.min(1440, Math.floor(Number(settings?.dynamicBanEscalateWindowMinutes) || 5)))
  };
  const updatedRoom = upsertBanSyncServer({ id: room.id, ...policy });
  const result = applyBanSyncCommunityPolicy(updatedRoom, `ban-sync-community:${room.id}`);
  appendManagedAudit(source.id, {
    actor,
    action: 'ban-sync-community-policy-updated',
    target: room.id,
    detail: `Dynamic Ban ${policy.dynamicBanEnabled ? 'on' : 'off'} · ${policy.dynamicBanEscalateJoins} joins / ${policy.dynamicBanEscalateWindowMinutes} min · propagated to ${result.updated} member(s)`
  });
  return { room: updatedRoom, ...policy, updated: result.updated };
}
function mergeSharedBan(current, incoming) {
  if (!current) return incoming;
  if (current.mode === 'permanent') return current;
  if (incoming.mode === 'permanent') return incoming;
  const currentExpiry = Date.parse(current.expiresAt || '') || 0;
  const incomingExpiry = Date.parse(incoming.expiresAt || '') || 0;
  return incomingExpiry >= currentExpiry ? incoming : current;
}
async function managedCurrentBanRows(bot, options = {}) {
  const contexts = managedServerContexts(bot);
  const targets = contexts.length ? contexts : [bot];
  const liveByServer = [];
  for (const target of targets) {
    const banData = await wardogsRequest(target, '/v1/bans');
    const map = new Map();
    for (const b of (Array.isArray(banData?.bans) ? banData.bans : [])) {
      const id = normalizeSteamId64(b?.steamId); if (id) map.set(id, b);
    }
    liveByServer.push(map);
  }
  const temps = new Map(temporaryBans(bot).map((entry) => [entry.steamId, entry]));
  const dynamics = new Map(dynamicBans(bot).map((entry) => [entry.steamId, entry]));
  const desired = new Map();
  const allIds = new Set(liveByServer.flatMap((map) => [...map.keys()]));
  for (const id of allIds) {
    const presentCount = liveByServer.reduce((count, map) => count + (map.has(id) ? 1 : 0), 0);
    if (options.requireAll === true && presentCount < liveByServer.length) continue;
    const sample = liveByServer.find((map) => map.has(id))?.get(id) || {};
    const d = dynamics.get(id), t = temps.get(id);
    if (d && Date.parse(d.expiresAt) > Date.now()) desired.set(id, { mode: 'dynamic', steamId: id, reason: d.reason || sample.reason, expiresAt: d.expiresAt, templateId: d.templateId });
    else if (t && Date.parse(t.expiresAt) > Date.now()) desired.set(id, { mode: 'temporary', steamId: id, reason: t.reason || sample.reason, expiresAt: t.expiresAt, templateId: t.templateId });
    else desired.set(id, { mode: 'permanent', steamId: id, reason: String(sample?.reason || 'Synced ban') });
  }
  for (const d of dynamics.values()) if (Date.parse(d.expiresAt) > Date.now()) desired.set(d.steamId, { mode: 'dynamic', steamId: d.steamId, reason: d.reason, expiresAt: d.expiresAt, templateId: d.templateId });
  for (const t of temps.values()) if (Date.parse(t.expiresAt) > Date.now() && !desired.has(t.steamId)) {
    if (options.requireAll !== true || liveByServer.every((map) => map.has(t.steamId))) desired.set(t.steamId, { mode: 'temporary', steamId: t.steamId, reason: t.reason, expiresAt: t.expiresAt, templateId: t.templateId });
  }
  return [...desired.values()];
}
function banSyncRowSatisfied(current, desired) {
  if (!current || !desired) return false;
  if (desired.mode === 'permanent') return current.mode === 'permanent';
  // A permanent local ban is at least as restrictive as a shared temporary ban.
  // Do not POST the same SteamID again just to replace it with a weaker entry.
  if (desired.mode === 'temporary' && current.mode === 'permanent') return true;
  if (current.mode !== desired.mode) return false;
  const wanted = Date.parse(desired.expiresAt || '') || 0;
  const actual = Date.parse(current.expiresAt || '') || 0;
  if (!wanted || !actual) return false;
  // Sync runs can be a few seconds apart. Treat an equal/later expiry as already
  // reconciled instead of re-banning the player and provoking duplicate errors.
  return actual >= wanted - 60_000;
}

function banSyncPlayerOfflineError(error) {
  const status = Number(error?.status || 0);
  const code = String(error?.code || '').toLowerCase();
  const detail = String(error?.detail || error?.message || '').toLowerCase();
  // Current WARDOGS live builds only accept POST /v1/bans while that SteamID is
  // connected. A community ban for an offline player is therefore pending, not
  // broken; it is enforced when the player next appears in /v1/players.
  return status === 404 && (code.includes('player') || detail.includes('no player matching') || detail.includes('player matching'));
}

async function reconcileBanSyncCommunitySources(room) {
  const originalRows = banSyncSharedRows(room);
  if (!originalRows.length) return { room, removed: [], errors: [] };
  const members = new Map(banSyncMembers(room).map((bot) => [String(bot.id), bot]));
  const sourceIds = [...new Set(originalRows.map((row) => String(row.sourceBotId || '')).filter((id) => members.has(id)))];
  const snapshots = new Map();
  const errors = [];
  for (const sourceId of sourceIds) {
    try {
      const rows = await managedCurrentBanRows(members.get(sourceId));
      snapshots.set(sourceId, new Map(rows.map((row) => [row.steamId, row])));
    } catch (error) {
      errors.push(`${members.get(sourceId)?.name || sourceId}: ${String(error?.message || error).slice(0, 220)}`);
    }
  }
  const removed = [];
  const kept = [];
  for (const row of originalRows) {
    const sourceMap = snapshots.get(String(row.sourceBotId || ''));
    if (sourceMap && !sourceMap.has(row.steamId)) removed.push(row);
    else kept.push(row);
  }
  if (!removed.length) return { room, removed, errors };
  const updatedRoom = upsertBanSyncServer({ id: room.id, sharedBans: kept });
  // A source-side unban that happened outside the panel is authoritative on a
  // manual resync too. Remove that stale community ban from all peers.
  for (const row of removed) {
    for (const member of banSyncMembers(updatedRoom)) {
      try {
        await unbanManagedPlayer(member, row.steamId, { skipSync: true, tolerateMissing: true, actor: `ban-sync-community:${room.id}:reconcile` });
      } catch (error) {
        errors.push(`${member.name || member.id} · unban ${row.steamId}: ${String(error?.message || error).slice(0, 180)}`);
      }
    }
  }
  return { room: updatedRoom, removed, errors };
}

async function enforceBanSyncCommunityForPlayers(bot, players = []) {
  const fresh = getManagedBot(bot?.id) || bot;
  const room = banSyncServerForBot(fresh);
  if (!room) return { matched: 0, applied: 0, skipped: 0, pending: 0, failed: 0 };
  const shared = new Map(banSyncSharedRows(room).map((row) => [row.steamId, row]));
  const targets = (Array.isArray(players) ? players : []).map((player) => ({ player, steamId: playerSteamId(player) })).filter((row) => row.steamId && shared.has(row.steamId));
  if (!targets.length) return { matched: 0, applied: 0, skipped: 0, pending: 0, failed: 0 };
  let current = new Map();
  try { current = new Map((await managedCurrentBanRows(fresh)).map((row) => [row.steamId, row])); } catch {}
  let applied = 0, skipped = 0, pending = 0, failed = 0;
  for (const target of targets) {
    const row = shared.get(target.steamId);
    if (banSyncRowSatisfied(current.get(target.steamId), row)) { skipped += 1; continue; }
    try {
      if (await applyBanSyncRow(fresh, row, room.id, row.sourceBotId)) {
        applied += 1;
        current.set(target.steamId, row);
      }
    } catch (error) {
      if (banSyncPlayerOfflineError(error)) pending += 1;
      else {
        failed += 1;
        appendManagedAudit(fresh.id, { actor: `ban-sync-community:${room.id}`, action: 'ban-sync-community-join-enforce-failed', target: target.steamId, detail: String(error?.message || error).slice(0, 300), status: 'error' });
      }
    }
  }
  if (applied || failed) setRuntime(fresh.id, { lastBanSyncAt: nowIso(), lastBanSyncError: failed ? `${failed} community ban(s) failed on join` : null });
  return { matched: targets.length, applied, skipped, pending, failed };
}

async function applyBanSyncRow(target, row, roomId, sourceBotId) {
  const normalized = normalizeSteamId64(row?.steamId); if (!normalized) return false;
  const actor = `ban-sync-community:${roomId}`;
  if (row.mode === 'dynamic') {
    const expiresAtMs = Date.parse(row.expiresAt || ''); if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return false;
    // Dynamic bans must remain kick-based. If this member currently has a normal
    // WARDOGS ban for the player, remove it before storing the shared Dynamic Ban.
    for (const server of (managedServerContexts(target).length ? managedServerContexts(target) : [target])) {
      try { await wardogsRequest(server, `/v1/bans/${encodeURIComponent(normalized)}`, { method: 'DELETE' }); }
      catch (error) { if (Number(error?.status || 0) !== 404) throw error; }
    }
    const minutes = Math.max(1, Math.ceil((expiresAtMs - Date.now()) / 60_000));
    await dynamicBanManagedPlayer(target, normalized, row.reason || 'Synced ban', minutes, { createdBy: actor, templateId: row.templateId, forcedExpiresAt: new Date(expiresAtMs).toISOString(), skipSync: true });
  } else if (row.mode === 'temporary') {
    const expiresAtMs = Date.parse(row.expiresAt || ''); if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return false;
    const minutes = Math.max(1, Math.ceil((expiresAtMs - Date.now()) / 60_000));
    await temporaryBanManagedPlayer(target, normalized, row.reason || 'Synced ban', minutes, { createdBy: actor, templateId: row.templateId, forcedExpiresAt: new Date(expiresAtMs).toISOString(), forceNormal: true, skipSync: true, tolerateExisting: true });
  } else {
    await banManagedPlayer(target, normalized, row.reason || 'Synced ban', { skipSync: true, actor, tolerateExisting: true });
  }
  appendManagedAudit(target.id, { actor, action: 'ban-sync-community-applied', target: normalized, detail: `${row.mode} ban from ${sourceBotId || 'community'}${row.expiresAt ? ` until ${row.expiresAt}` : ''}` });
  return true;
}

async function synchronizeBanSyncCommunity(room, auditAction = 'ban-sync-community-resync-failed') {
  const rows = banSyncSharedRows(room);
  const members = banSyncMembers(room);
  let applied = 0, skipped = 0, pending = 0, failed = 0;
  const errors = [];
  for (const member of members) {
    let currentRows;
    try {
      currentRows = await managedCurrentBanRows(member, { requireAll: true });
    } catch (error) {
      failed += 1;
      const message = `${member.name || member.id}: ${String(error?.message || error).slice(0, 260)}`;
      errors.push(message);
      appendManagedAudit(member.id, { actor: `ban-sync-community:${room.id}`, action: auditAction, target: member.id, detail: message, status: 'error' });
      continue;
    }
    const current = new Map(currentRows.map((entry) => [entry.steamId, entry]));
    for (const row of rows) {
      if (banSyncRowSatisfied(current.get(row.steamId), row)) { skipped += 1; continue; }
      try {
        if (await applyBanSyncRow(member, row, room.id, row.sourceBotId)) {
          applied += 1;
          current.set(row.steamId, row);
        }
      } catch (error) {
        if (banSyncPlayerOfflineError(error)) {
          pending += 1;
          appendManagedAudit(member.id, { actor: `ban-sync-community:${room.id}`, action: 'ban-sync-community-pending-player', target: row.steamId, detail: 'WARDOGS can only create this ban while the player is connected; it will be enforced on the next join.' });
          continue;
        }
        failed += 1;
        const message = `${member.name || member.id} · ${row.steamId}: ${String(error?.message || error).slice(0, 240)}`;
        errors.push(message);
        appendManagedAudit(member.id, { actor: `ban-sync-community:${room.id}`, action: auditAction, target: row.steamId, detail: message, status: 'error' });
      }
    }
  }
  return { rows, members, applied, skipped, pending, failed, errors: errors.slice(0, 20) };
}

export async function createManagedBanSyncServer(bot, name, password, actor = 'web') {
  const source = getManagedBot(bot?.id) || bot;
  if (!source?.id || String(source.serviceId || '') !== 'wardogs-warning-bot') throw new Error('Management bot not found');
  if (banSyncServerForBot(source)) throw new Error('This bot is already connected to a Ban Sync Community');
  const cleanName = String(name || '').trim().slice(0,80);
  if (cleanName.length < 3) throw new Error('Ban Sync Community name must be at least 3 characters long');
  if (listBanSyncServers().some((room) => String(room?.name || '').trim().toLowerCase() === cleanName.toLowerCase())) throw new Error('A Ban Sync Community with this name already exists');
  const id = crypto.randomUUID();
  const snapshot = await managedCurrentBanRows(source);
  const sharedBans = snapshot.map((row) => ({ ...row, sourceBotId: source.id, updatedAt: nowIso() }));
  const policy = {
    dynamicBanEnabled: source.dynamicBanEnabled === true,
    dynamicBanEscalateJoins: Math.max(2, Math.min(20, Math.floor(Number(source.dynamicBanEscalateJoins) || 3))),
    dynamicBanEscalateWindowMinutes: Math.max(1, Math.min(1440, Math.floor(Number(source.dynamicBanEscalateWindowMinutes) || 5)))
  };
  const room = upsertBanSyncServer({ id, name: cleanName, ownerBotId: source.id, passwordHash: banSyncPasswordHash(password), members: [source.id], sharedBans, ...policy });
  upsertManagedBot({ id: source.id, banSyncServerId: id, banSyncTargetBotId: '' });
  appendManagedAudit(source.id, { actor, action: 'ban-sync-server-created', target: id, detail: `${cleanName} · ${sharedBans.length} existing bans imported.` });
  return room;
}

export async function joinManagedBanSyncServer(bot, serverId, password, actor = 'web') {
  const source = getManagedBot(bot?.id) || bot;
  if (!source?.id || String(source.serviceId || '') !== 'wardogs-warning-bot') throw new Error('Management bot not found');
  const current = banSyncServerForBot(source);
  if (current && current.id !== String(serverId || '')) throw new Error('Leave the current Ban Sync Community first');
  const room = getBanSyncServer(String(serverId || ''));
  if (!room) throw new Error('Ban Sync Community not found');
  if (!banSyncPasswordMatches(room.passwordHash, password)) throw new Error('Ban Sync Community password is incorrect');
  const existingMembers = [...new Set((Array.isArray(room.members) ? room.members : []).map(String).filter(Boolean))];
  if (!existingMembers.includes(source.id) && existingMembers.length >= 100) throw new Error('This Ban Sync Community already has the maximum of 100 members');
  const localRows = await managedCurrentBanRows(source);
  const merged = new Map(banSyncSharedRows(room).map((row) => [row.steamId, row]));
  for (const row of localRows) merged.set(row.steamId, mergeSharedBan(merged.get(row.steamId), { ...row, sourceBotId: source.id, updatedAt: nowIso() }));
  const members = [...new Set([...(Array.isArray(room.members) ? room.members : []), source.id])].slice(0,100);
  const updated = upsertBanSyncServer({ id: room.id, members, sharedBans: [...merged.values()].slice(0,5000) });
  upsertManagedBot({ id: source.id, banSyncServerId: room.id, banSyncTargetBotId: '' });
  applyBanSyncCommunityPolicy(updated, `ban-sync-community:${room.id}`);
  const sync = await synchronizeBanSyncCommunity(updated, 'ban-sync-community-join-failed');
  appendManagedAudit(source.id, { actor, action: 'ban-sync-community-joined', target: updated.id, detail: `${updated.name} · ${members.length} members · ${sync.applied} applied, ${sync.skipped} already synchronized, ${sync.pending} pending offline, ${sync.failed} failed.` });
  return { room: updated, applied: sync.applied, skipped: sync.skipped, pending: sync.pending, failed: sync.failed, errors: sync.errors };
}

export async function leaveManagedBanSyncServer(bot, actor = 'web') {
  const source = getManagedBot(bot?.id) || bot;
  const room = banSyncServerForBot(source);
  if (!source?.id || !room) { if (source?.id) upsertManagedBot({ id: source.id, banSyncServerId: '' }); return { deleted: false, members: 0 }; }
  const members = (Array.isArray(room.members) ? room.members : []).map(String).filter((id) => id !== source.id);
  upsertManagedBot({ id: source.id, banSyncServerId: '' });
  if (!members.length) {
    deleteBanSyncServer(room.id);
    appendManagedAudit(source.id, { actor, action: 'ban-sync-server-deleted', target: room.id, detail: room.name });
    return { deleted: true, members: 0 };
  }
  const ownerBotId = room.ownerBotId === source.id ? members[0] : room.ownerBotId;
  upsertBanSyncServer({ id: room.id, members, ownerBotId });
  appendManagedAudit(source.id, { actor, action: 'ban-sync-server-left', target: room.id, detail: `${room.name}. Existing bans remain local; only future sync stops.` });
  return { deleted: false, members: members.length };
}

export async function resyncManagedBanSyncServer(bot, actor = 'web') {
  const source = getManagedBot(bot?.id) || bot;
  let room = banSyncServerForBot(source);
  if (!room) throw new Error('This bot is not connected to a Ban Sync Community');
  applyBanSyncCommunityPolicy(room, `ban-sync-community:${room.id}`);
  const reconciled = await reconcileBanSyncCommunitySources(room);
  room = reconciled.room;
  const sync = await synchronizeBanSyncCommunity(room);
  const errors = [...reconciled.errors, ...sync.errors].slice(0, 20);
  appendManagedAudit(source.id, { actor, action: 'ban-sync-community-resync', target: room.id, detail: `${sync.applied} applied, ${sync.skipped} already synchronized, ${sync.pending} pending offline, ${reconciled.removed.length} stale removed, ${sync.failed} failed.` });
  return { room, applied: sync.applied, skipped: sync.skipped, pending: sync.pending, removed: reconciled.removed.length, failed: sync.failed + reconciled.errors.length, errors, bans: sync.rows.length, members: sync.members.length };
}

function managedSyncTarget(sourceBot) {
  const targetId = String(sourceBot?.banSyncTargetBotId || '').trim();
  if (!targetId || targetId === String(sourceBot?.id || '')) return null;
  const target = getManagedBot(targetId);
  if (!target || String(target.serviceId || '') !== 'wardogs-warning-bot') return null;
  if (!banSyncAcceptedSources(target).includes(String(sourceBot?.id || ''))) return null;
  return target;
}

function upsertBanSyncMirror(targetBot, mirror) {
  const fresh = getManagedBot(targetBot?.id) || targetBot;
  const rows = banSyncMirrors(fresh).filter((row) => !(row.sourceBotId === mirror.sourceBotId && row.steamId === mirror.steamId));
  upsertManagedBot({ id: fresh.id, banSyncMirrors: [...rows, mirror].slice(-2000) });
}
function removeBanSyncMirror(targetBot, sourceBotId, steamId) {
  const fresh = getManagedBot(targetBot?.id) || targetBot;
  upsertManagedBot({ id: fresh.id, banSyncMirrors: banSyncMirrors(fresh).filter((row) => !(row.sourceBotId === String(sourceBotId) && row.steamId === String(steamId))) });
}

async function disconnectManagedBanSyncSource(sourceBot, targetBotId, actor = 'system') {
  const source = getManagedBot(sourceBot?.id) || sourceBot;
  const target = getManagedBot(String(targetBotId || ''));
  if (!source?.id || !target?.id) return { removed: 0 };
  const mirrors = banSyncMirrors(target).filter((row) => row.sourceBotId === source.id);
  let removed = 0;
  for (const row of mirrors) {
    try {
      await unbanManagedPlayer(getManagedBot(target.id) || target, row.steamId, { skipSync: true, tolerateMissing: true, actor: `ban-sync-disconnect:${source.id}` });
      removed += 1;
    } catch (error) {
      appendManagedAudit(target.id, { actor, action: 'ban-sync-disconnect-unban-failed', target: row.steamId, detail: String(error?.message || error).slice(0, 300), status: 'error' });
    }
  }
  const freshTarget = getManagedBot(target.id) || target;
  upsertManagedBot({
    id: freshTarget.id,
    banSyncRequests: banSyncRequests(freshTarget).filter((row) => row.sourceBotId !== source.id),
    banSyncAcceptedSources: banSyncAcceptedSources(freshTarget).filter((id) => id !== source.id),
    banSyncMirrors: banSyncMirrors(freshTarget).filter((row) => row.sourceBotId !== source.id)
  });
  appendManagedAudit(target.id, { actor, action: 'ban-sync-disconnected', target: source.id, detail: `${removed}/${mirrors.length} mirrored bans removed.` });
  appendManagedAudit(source.id, { actor, action: 'ban-sync-disconnected', target: target.id, detail: `${removed}/${mirrors.length} mirrored bans removed from old target.` });
  return { removed };
}

async function syncBanToAcceptedTarget(sourceBot, payload) {
  if (payload?.skipSync) return null;
  const room = banSyncServerForBot(sourceBot);
  if (room) {
    const sourceBotId = String(sourceBot.id);
    const normalized = normalizeSteamId64(payload?.steamId); if (!normalized) return null;
    const mode = ['permanent','temporary','dynamic'].includes(payload?.mode) ? payload.mode : 'permanent';
    if (mode !== 'permanent') {
      const expiresAtMs = Date.parse(payload?.expiresAt || '');
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return null;
    }
    const row = { steamId: normalized, mode, reason: String(payload?.reason || 'Synced ban').slice(0,180), expiresAt: mode === 'permanent' ? null : payload.expiresAt, templateId: String(payload?.templateId || '').slice(0,64), sourceBotId, updatedAt: nowIso() };
    const shared = banSyncSharedRows(room).filter((item) => item.steamId !== normalized);
    const updatedRoom = upsertBanSyncServer({ id: room.id, sharedBans: [...shared, row].slice(0,5000) });
    let ok = 0, pending = 0, failed = 0;
    for (const target of banSyncMembers(updatedRoom)) {
      if (target.id === sourceBotId) continue;
      try { if (await applyBanSyncRow(target, row, updatedRoom.id, sourceBotId)) ok += 1; }
      catch (error) {
        if (banSyncPlayerOfflineError(error)) {
          pending += 1;
          appendManagedAudit(target.id, { actor: `ban-sync-community:${updatedRoom.id}`, action: 'ban-sync-community-pending-player', target: normalized, detail: 'Player is offline on this server; ban will be applied on next join.' });
        } else {
          failed += 1;
          appendManagedAudit(sourceBotId, { actor: payload?.actor || 'system', action: 'ban-sync-server-send-failed', target: normalized, detail: `${target.id}: ${String(error?.message || error).slice(0,300)}`, status: 'error' });
        }
      }
    }
    appendManagedAudit(sourceBotId, { actor: payload?.actor || 'system', action: 'ban-sync-server-sent', target: normalized, detail: `${mode} ban sent to ${ok} peer(s)${pending ? `; ${pending} pending until player joins` : ''}${failed ? `; ${failed} failed` : ''}.` });
    setRuntime(sourceBotId, { lastBanSyncAt: nowIso(), lastBanSyncError: failed ? `${failed} peer sync(s) failed` : null });
    return updatedRoom;
  }
  const target = managedSyncTarget(sourceBot);
  if (!target) return null;
  const sourceBotId = String(sourceBot.id);
  const normalized = normalizeSteamId64(payload?.steamId);
  if (!normalized) return null;
  const reason = String(payload?.reason || 'Synced ban').slice(0, 180);
  const mode = ['permanent','temporary','dynamic'].includes(payload?.mode) ? payload.mode : 'permanent';
  const actor = `ban-sync:${sourceBotId}`;
  try {
    if (mode === 'dynamic') {
      const expiresAtMs = Date.parse(payload?.expiresAt || '');
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return null;
      const minutes = Math.max(1, Math.ceil((expiresAtMs - Date.now()) / 60_000));
      await dynamicBanManagedPlayer(target, normalized, reason, minutes, { createdBy: actor, templateId: payload?.templateId, forcedExpiresAt: new Date(expiresAtMs).toISOString(), skipSync: true });
    } else if (mode === 'temporary') {
      const expiresAtMs = Date.parse(payload?.expiresAt || '');
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return null;
      const minutes = Math.max(1, Math.ceil((expiresAtMs - Date.now()) / 60_000));
      await temporaryBanManagedPlayer(target, normalized, reason, minutes, { createdBy: actor, templateId: payload?.templateId, forcedExpiresAt: new Date(expiresAtMs).toISOString(), forceNormal: true, skipSync: true });
    } else {
      await banManagedPlayer(target, normalized, reason, { skipSync: true, actor });
    }
    upsertBanSyncMirror(target, { sourceBotId, steamId: normalized, mode, expiresAt: payload?.expiresAt || null, reason, createdAt: nowIso() });
    appendManagedAudit(target.id, { actor, action: 'ban-sync-applied', target: normalized, detail: `${mode} ban mirrored from ${sourceBotId}${payload?.expiresAt ? ` until ${payload.expiresAt}` : ''}` });
    appendManagedAudit(sourceBot.id, { actor: payload?.actor || 'system', action: 'ban-sync-sent', target: normalized, detail: `${mode} ban mirrored to ${target.id}` });
    return target;
  } catch (error) {
    appendManagedAudit(sourceBot.id, { actor: payload?.actor || 'system', action: 'ban-sync-failed', target: normalized, detail: `${target.id}: ${String(error?.message || error).slice(0, 300)}`, status: 'error' });
    setRuntime(sourceBot.id, { lastBanSyncError: String(error?.message || error).slice(0, 300), lastBanSyncAt: nowIso() });
    return null;
  }
}

async function syncUnbanToAcceptedTarget(sourceBot, steamId, meta = {}) {
  if (meta?.skipSync) return null;
  const room = banSyncServerForBot(sourceBot);
  if (room) {
    const normalized = normalizeSteamId64(steamId); if (!normalized) return null;
    const shared = banSyncSharedRows(room).filter((row) => row.steamId !== normalized);
    const updatedRoom = upsertBanSyncServer({ id: room.id, sharedBans: shared });
    let ok = 0, failed = 0;
    for (const target of banSyncMembers(updatedRoom)) {
      if (target.id === String(sourceBot.id)) continue;
      try { await unbanManagedPlayer(target, normalized, { skipSync: true, actor: `ban-sync-server:${room.id}`, tolerateMissing: true }); ok += 1; }
      catch (error) { failed += 1; appendManagedAudit(sourceBot.id, { actor: meta?.actor || 'system', action: 'ban-sync-server-unban-failed', target: normalized, detail: `${target.id}: ${String(error?.message || error).slice(0,300)}`, status: 'error' }); }
    }
    appendManagedAudit(sourceBot.id, { actor: meta?.actor || 'system', action: 'ban-sync-server-unban', target: normalized, detail: `Global unban sent to ${ok} peer(s)${failed ? `; ${failed} failed` : ''}.` });
    return updatedRoom;
  }
  const target = managedSyncTarget(sourceBot);
  if (!target) return null;
  const normalized = normalizeSteamId64(steamId); if (!normalized) return null;
  const mirrored = banSyncMirrors(target).some((row) => row.sourceBotId === String(sourceBot.id) && row.steamId === normalized);
  if (!mirrored) return null;
  try {
    await unbanManagedPlayer(target, normalized, { skipSync: true, actor: `ban-sync:${sourceBot.id}`, tolerateMissing: true });
    removeBanSyncMirror(target, sourceBot.id, normalized);
    appendManagedAudit(target.id, { actor: `ban-sync:${sourceBot.id}`, action: 'ban-sync-unban', target: normalized, detail: `Mirrored ban removed because source ${sourceBot.id} removed/expired it.` });
  } catch (error) {
    appendManagedAudit(sourceBot.id, { actor: meta?.actor || 'system', action: 'ban-sync-unban-failed', target: normalized, detail: `${target.id}: ${String(error?.message || error).slice(0, 300)}`, status: 'error' });
  }
  return target;
}

export async function requestManagedBanSync(sourceBot, targetBotId, actor = 'web') {
  const source = getManagedBot(sourceBot?.id) || sourceBot;
  const targetId = String(targetBotId || '').trim();
  if (!source?.id) throw new Error('Source bot not found');
  const oldTargetId = String(source.banSyncTargetBotId || '').trim();
  if (oldTargetId && oldTargetId !== targetId) await disconnectManagedBanSyncSource(source, oldTargetId, actor);
  if (!targetId) {
    upsertManagedBot({ id: source.id, banSyncTargetBotId: '' });
    appendManagedAudit(source.id, { actor, action: 'ban-sync-disabled', detail: 'Outgoing ban sync target cleared.' });
    return { status: 'disabled' };
  }
  if (targetId === source.id) throw new Error('A bot cannot sync bans to itself');
  const target = getManagedBot(targetId);
  if (!target || String(target.serviceId || '') !== 'wardogs-warning-bot') throw new Error('Target Bot ID is not a WARDOGS management bot');
  upsertManagedBot({ id: source.id, banSyncTargetBotId: targetId });
  if (banSyncAcceptedSources(target).includes(source.id)) return { status: 'accepted', target };
  const pending = banSyncRequests(target).filter((row) => row.sourceBotId !== source.id);
  pending.push({ sourceBotId: source.id, sourceOwnerDiscordId: String(source.ownerDiscordId || ''), requestedAt: nowIso() });
  upsertManagedBot({ id: target.id, banSyncRequests: pending.slice(-50) });
  appendManagedAudit(source.id, { actor, action: 'ban-sync-requested', target: target.id, detail: 'Ban sync request sent.' });
  appendManagedAudit(target.id, { actor: `bot:${source.id}`, action: 'ban-sync-request-received', target: source.id, detail: `Owner ${source.ownerDiscordId || 'unknown'} requested ban sync.` });
  return { status: 'pending', target };
}

export async function acceptManagedBanSync(targetBot, sourceBotId, actor = 'web') {
  const target = getManagedBot(targetBot?.id) || targetBot;
  const source = getManagedBot(String(sourceBotId || ''));
  if (!target?.id || !source || String(source.serviceId || '') !== 'wardogs-warning-bot') throw new Error('Source bot not found');
  const requests = banSyncRequests(target);
  if (!requests.some((row) => row.sourceBotId === source.id)) throw new Error('No pending sync request from this bot');
  upsertManagedBot({ id: target.id, banSyncRequests: requests.filter((row) => row.sourceBotId !== source.id), banSyncAcceptedSources: [...new Set([...banSyncAcceptedSources(target), source.id])].slice(0, 50) });
  upsertManagedBot({ id: source.id, banSyncTargetBotId: target.id });
  appendManagedAudit(target.id, { actor, action: 'ban-sync-accepted', target: source.id, detail: 'Incoming ban sync accepted.' });
  appendManagedAudit(source.id, { actor: `bot:${target.id}`, action: 'ban-sync-accepted', target: target.id, detail: 'Target accepted ban sync.' });
  await syncManagedBanSnapshot(source, getManagedBot(target.id) || target, { actor });
  return { source, target: getManagedBot(target.id) || target };
}

export async function rejectManagedBanSync(targetBot, sourceBotId, actor = 'web') {
  const target = getManagedBot(targetBot?.id) || targetBot;
  if (!target?.id) throw new Error('Target bot not found');
  const source = getManagedBot(String(sourceBotId || ''));
  if (source) await disconnectManagedBanSyncSource(source, target.id, actor);
  else upsertManagedBot({ id: target.id, banSyncRequests: banSyncRequests(target).filter((row) => row.sourceBotId !== String(sourceBotId)), banSyncAcceptedSources: banSyncAcceptedSources(target).filter((id) => id !== String(sourceBotId)), banSyncMirrors: banSyncMirrors(target).filter((row) => row.sourceBotId !== String(sourceBotId)) });
  if (source && String(source.banSyncTargetBotId || '') === target.id) upsertManagedBot({ id: source.id, banSyncTargetBotId: '' });
  appendManagedAudit(target.id, { actor, action: 'ban-sync-rejected', target: String(sourceBotId || ''), detail: 'Incoming ban sync rejected/disconnected.' });
  return true;
}

export async function syncManagedBanSnapshot(sourceBot, explicitTarget = null, meta = {}) {
  const source = getManagedBot(sourceBot?.id) || sourceBot;
  const room = banSyncServerForBot(source);
  if (room && !explicitTarget) {
    const result = await resyncManagedBanSyncServer(source, meta?.actor || 'system');
    return { synced: result.applied, removed: 0, failed: result.failed, members: result.members, bans: result.bans };
  }
  const target = explicitTarget || managedSyncTarget(source);
  if (!source?.id || !target) return { synced: 0, removed: 0 };
  if (!banSyncAcceptedSources(target).includes(source.id)) return { synced: 0, removed: 0 };
  const [banData] = await Promise.all([wardogsRequest(source, '/v1/bans')]);
  const liveBans = Array.isArray(banData?.bans) ? banData.bans : [];
  const temps = new Map(temporaryBans(source).map((entry) => [entry.steamId, entry]));
  const dynamics = new Map(dynamicBans(source).map((entry) => [entry.steamId, entry]));
  const desired = new Map();
  for (const b of liveBans) {
    const id = normalizeSteamId64(b?.steamId); if (!id) continue;
    const d = dynamics.get(id), t = temps.get(id);
    if (d) desired.set(id, { mode: 'dynamic', steamId: id, reason: d.reason || b.reason, expiresAt: d.expiresAt, templateId: d.templateId });
    else if (t) desired.set(id, { mode: 'temporary', steamId: id, reason: t.reason || b.reason, expiresAt: t.expiresAt, templateId: t.templateId });
    else desired.set(id, { mode: 'permanent', steamId: id, reason: String(b?.reason || 'Synced ban') });
  }
  for (const d of dynamics.values()) if (Date.parse(d.expiresAt) > Date.now()) desired.set(d.steamId, { mode: 'dynamic', steamId: d.steamId, reason: d.reason, expiresAt: d.expiresAt, templateId: d.templateId });
  let synced = 0, removed = 0;
  for (const row of desired.values()) { await syncBanToAcceptedTarget(source, { ...row, actor: meta.actor }); synced += 1; }
  const stale = banSyncMirrors(target).filter((row) => row.sourceBotId === source.id && !desired.has(row.steamId));
  for (const row of stale) { await unbanManagedPlayer(target, row.steamId, { skipSync: true, actor: `ban-sync:${source.id}`, tolerateMissing: true }); removeBanSyncMirror(target, source.id, row.steamId); removed += 1; }
  setRuntime(source.id, { lastBanSyncAt: nowIso(), lastBanSyncError: null });
  return { synced, removed };
}

export async function banManagedPlayer(bot, steamId, reason = 'WARDOGS rule violation', options = {}) {
  const normalized = normalizeSteamId64(steamId);
  if (!normalized) throw new Error('Invalid SteamID64');
  const fanout = !bot?._managedServerId ? managedServerContexts(bot) : [];
  if (fanout.length > 1 && options?._fanout !== true) {
    const results = [], errors = [];
    for (const server of fanout) {
      try { results.push(await banManagedPlayer(server, normalized, reason, { ...options, skipSync: true, _fanout: true, tolerateExisting: true })); }
      catch (error) { errors.push(`${server._managedServerLabel || server._managedServerId}: ${String(error?.message || error).slice(0,180)}`); }
    }
    if (errors.length === fanout.length) throw new Error(`Ban failed on all managed servers: ${errors[0]}`);
    if (!options?.skipSync) await syncBanToAcceptedTarget(getManagedBot(bot.id) || bot, { mode: 'permanent', steamId: normalized, reason, actor: options?.actor });
    return { fanout: true, applied: results.length, failed: errors.length, errors };
  }
  let result;
  try {
    result = await wardogsRequest(bot, '/v1/bans', { method: 'POST', body: { steamId: normalized, reason: formatManagedBanReason(bot, reason, options?.durationMinutes) } });
  } catch (error) {
    if (options?.tolerateExisting !== true) throw error;
    // Different WARDOGS builds/proxies do not consistently use the same status
    // for a duplicate ban. Verify the live list before treating it as a failure.
    try {
      const live = await wardogsRequest(bot, '/v1/bans');
      const present = (Array.isArray(live?.bans) ? live.bans : []).some((entry) => normalizeSteamId64(entry?.steamId) === normalized);
      if (!present) throw error;
      result = { message: 'Ban already present', alreadyPresent: true };
    } catch (verifyError) {
      if (verifyError === error) throw error;
      throw error;
    }
  }
  const fresh = getManagedBot(bot?.id);
  if (fresh && options?.keepLocalTemporary !== true) {
    const nextTemporary = temporaryBans(fresh).filter((entry) => entry.steamId !== normalized);
    const nextDynamic = dynamicBans(fresh).filter((entry) => entry.steamId !== normalized);
    if (nextTemporary.length !== temporaryBans(fresh).length || nextDynamic.length !== dynamicBans(fresh).length) upsertManagedBot({ id: fresh.id, temporaryBans: nextTemporary, dynamicBans: nextDynamic });
  }
  appendManagedAudit(bot.id, { actor: options?.actor || 'system', action: 'ban', target: normalized, detail: String(reason || '').slice(0, 300) });
  if (!options?.skipSync) await syncBanToAcceptedTarget(getManagedBot(bot.id) || bot, { mode: 'permanent', steamId: normalized, reason, actor: options?.actor });
  return result;
}

export async function dynamicBanManagedPlayer(bot, steamId, reason = 'Dynamic ban', durationMinutes = 1440, meta = {}) {
  const normalized = normalizeSteamId64(steamId);
  if (!normalized) throw new Error('Invalid SteamID64');
  const minutes = Math.max(1, Math.min(525600, Math.floor(Number(durationMinutes) || 0)));
  if (!minutes) throw new Error('Dynamic ban duration is invalid');
  const forced = Date.parse(meta?.forcedExpiresAt || '');
  const expiresAt = Number.isFinite(forced) && forced > Date.now() ? new Date(forced).toISOString() : new Date(Date.now() + minutes * 60_000).toISOString();
  const fresh = getManagedBot(bot?.id) || bot;
  const actionBot = bot?._managedServerId ? (managedServerContext(fresh, bot._managedServerId) || bot) : (managedServerContexts(fresh)[0] || fresh);
  const existing = dynamicBans(fresh).filter((entry) => entry.steamId !== normalized);
  const entry = { steamId: normalized, reason: String(reason || '').slice(0,180), expiresAt, createdAt: nowIso(), createdBy: String(meta?.createdBy || 'panel').slice(0,100), templateId: String(meta?.templateId || '').slice(0,64), escalated: false, escalatedAt: null, joinAttempts: [] };
  upsertManagedBot({ id: fresh.id, dynamicBans: [...existing, entry].slice(-1000), temporaryBans: temporaryBans(fresh).filter((x) => x.steamId !== normalized) });
  try { await kickManagedPlayer(actionBot, normalized, formatManagedBanReason(fresh, reason, minutes), { actor: meta?.createdBy || 'dynamic-ban', skipAudit: true }); }
  catch (error) { if (![400,404,409,422].includes(Number(error?.status || 0))) appendManagedAudit(fresh.id, { actor: meta?.createdBy || 'system', action: 'dynamic-ban-initial-kick-failed', target: normalized, detail: String(error?.message || error).slice(0,300), status: 'error' }); }
  appendManagedAudit(fresh.id, { actor: meta?.createdBy || 'system', action: 'dynamic-ban-created', target: normalized, detail: `${reason} · until ${expiresAt}` });
  if (!meta?.skipSync) await syncBanToAcceptedTarget(getManagedBot(fresh.id) || fresh, { mode: 'dynamic', steamId: normalized, reason, expiresAt, templateId: meta?.templateId, actor: meta?.createdBy });
  return { ...entry, dynamic: true };
}

export async function temporaryBanManagedPlayer(bot, steamId, reason = 'Temporary WARDOGS ban', durationMinutes = 1440, meta = {}) {
  if (bot?.dynamicBanEnabled === true && meta?.forceNormal !== true) return dynamicBanManagedPlayer(bot, steamId, reason, durationMinutes, meta);
  const normalized = normalizeSteamId64(steamId);
  if (!normalized) throw new Error('Invalid SteamID64');
  const minutes = Math.max(1, Math.min(525600, Math.floor(Number(durationMinutes) || 0)));
  if (!minutes) throw new Error('Temporary ban duration is invalid');
  await banManagedPlayer(bot, normalized, reason, { durationMinutes: minutes, skipSync: true, actor: meta?.createdBy || 'system', keepLocalTemporary: true, tolerateExisting: meta?.tolerateExisting === true });
  const fresh = getManagedBot(bot?.id) || bot;
  const existing = temporaryBans(fresh).filter((entry) => entry.steamId !== normalized);
  const forced = Date.parse(meta?.forcedExpiresAt || '');
  const expiresAt = Number.isFinite(forced) && forced > Date.now() ? new Date(forced).toISOString() : new Date(Date.now() + minutes * 60_000).toISOString();
  const entry = {
    steamId: normalized, reason: String(reason || '').slice(0, 180), expiresAt,
    createdAt: nowIso(), createdBy: String(meta?.createdBy || 'panel').slice(0, 100), templateId: String(meta?.templateId || '').slice(0, 64)
  };
  upsertManagedBot({ id: fresh.id, temporaryBans: [...existing, entry].slice(-1000), dynamicBans: dynamicBans(fresh).filter((x) => x.steamId !== normalized) });
  appendManagedAudit(fresh.id, { actor: meta?.createdBy || 'system', action: 'temporary-ban-created', target: normalized, detail: `${reason} · until ${expiresAt}` });
  if (!meta?.skipSync) await syncBanToAcceptedTarget(getManagedBot(fresh.id) || fresh, { mode: 'temporary', steamId: normalized, reason, expiresAt, templateId: meta?.templateId, actor: meta?.createdBy });
  return { ...entry, dynamic: false };
}

export async function expireManagedTemporaryBans(bot) {
  const fresh = getManagedBot(bot?.id) || bot;
  const rows = temporaryBans(fresh);
  if (!rows.length) return { expired: 0, pending: 0 };
  const due = rows.filter((entry) => Date.parse(entry.expiresAt) <= Date.now());
  if (!due.length) return { expired: 0, pending: rows.length };
  const targets = managedServerContexts(fresh);
  if (!targets.length) return { expired: 0, pending: rows.length };
  const keep = [...rows]; let expired = 0; let lastError = null;
  for (const entry of due) {
    let hardFailures = 0;
    for (const target of targets) {
      try { await wardogsRequest(target, `/v1/bans/${encodeURIComponent(entry.steamId)}`, { method: 'DELETE' }); }
      catch (error) {
        const code = String(error?.code || '').toLowerCase();
        const detail = String(error?.detail || error?.message || '').toLowerCase();
        const missing = Number(error?.status || 0) === 404 && (code === 'ban_not_found' || detail.includes('not currently banned') || detail.includes('not found'));
        if (!missing) { hardFailures += 1; lastError = `${target._managedServerLabel || 'Server'}: ${String(error?.message || error).slice(0,260)}`; }
      }
    }
    if (hardFailures) continue;
    const index = keep.findIndex((x) => x.steamId === entry.steamId); if (index >= 0) keep.splice(index, 1);
    expired += 1;
    appendManagedAudit(fresh.id, { actor: 'system', action: 'temporary-ban-expired', target: entry.steamId, detail: `Expired at ${entry.expiresAt}` });
    await syncUnbanToAcceptedTarget(fresh, entry.steamId, { actor: 'system' });
  }
  if (expired) upsertManagedBot({ id: fresh.id, temporaryBans: keep });
  if (lastError) setRuntime(fresh.id, { lastTemporaryBanError: lastError });
  else if (expired) setRuntime(fresh.id, { lastTemporaryBanError: null, lastTemporaryBanSweepAt: nowIso() });
  return { expired, pending: keep.length, error: lastError };
}

async function expireManagedDynamicBans(bot) {
  const fresh = getManagedBot(bot?.id) || bot;
  const rows = dynamicBans(fresh);
  const due = rows.filter((entry) => Date.parse(entry.expiresAt) <= Date.now());
  if (!due.length) return { expired: 0, pending: rows.length };
  const targets = managedServerContexts(fresh);
  const keep = [...rows]; let expired = 0;
  for (const entry of due) {
    let failed = false;
    if (entry.escalated) {
      for (const target of targets) {
        try { await wardogsRequest(target, `/v1/bans/${encodeURIComponent(entry.steamId)}`, { method: 'DELETE' }); }
        catch (error) { if (Number(error?.status || 0) !== 404) failed = true; }
      }
    }
    if (failed) continue;
    const index = keep.findIndex((x) => x.steamId === entry.steamId); if (index >= 0) keep.splice(index, 1);
    expired += 1;
    appendManagedAudit(fresh.id, { actor: 'system', action: 'dynamic-ban-expired', target: entry.steamId, detail: `Expired at ${entry.expiresAt}` });
    await syncUnbanToAcceptedTarget(fresh, entry.steamId, { actor: 'system' });
  }
  if (expired) upsertManagedBot({ id: fresh.id, dynamicBans: keep });
  return { expired, pending: keep.length };
}

async function processManagedDynamicBans(bot, joinedPlayers = []) {
  await expireManagedDynamicBans(bot);
  let fresh = getManagedBot(bot?.id) || bot;
  const actionBot = bot?._managedServerId ? (managedServerContext(fresh, bot._managedServerId) || bot) : (managedServerContexts(fresh)[0] || fresh);
  const rows = dynamicBans(fresh); if (!rows.length || !joinedPlayers.length) return;
  const byId = new Map(rows.map((entry) => [entry.steamId, entry]));
  const threshold = Math.max(2, Math.min(20, Math.floor(Number(fresh.dynamicBanEscalateJoins) || 3)));
  const windowMinutes = Math.max(1, Math.min(1440, Math.floor(Number(fresh.dynamicBanEscalateWindowMinutes) || 5)));
  const cutoff = Date.now() - windowMinutes * 60_000;
  let changed = false;
  for (const player of joinedPlayers) {
    const steamId = playerSteamId(player); const entry = byId.get(steamId);
    if (!entry || Date.parse(entry.expiresAt) <= Date.now()) continue;
    try {
      const remainingMinutes = Math.max(1, Math.ceil((Date.parse(entry.expiresAt) - Date.now()) / 60_000));
      await kickManagedPlayer(actionBot, steamId, formatManagedBanReason(fresh, entry.reason, remainingMinutes), { actor: 'dynamic-ban', skipAudit: true });
      appendManagedAudit(fresh.id, { actor: 'dynamic-ban', action: 'dynamic-ban-kick', target: steamId, detail: `Join blocked; expires ${entry.expiresAt}` });
    } catch (error) {
      appendManagedAudit(fresh.id, { actor: 'dynamic-ban', action: 'dynamic-ban-kick-failed', target: steamId, detail: String(error?.message || error).slice(0,300), status: 'error' });
    }
    const attempts = [...entry.joinAttempts.filter((stamp) => Date.parse(stamp) >= cutoff), nowIso()].slice(-50);
    entry.joinAttempts = attempts; changed = true;
    if (!entry.escalated && attempts.length >= threshold) {
      const remainingMinutes = Math.max(1, Math.ceil((Date.parse(entry.expiresAt) - Date.now()) / 60_000));
      try {
        await banManagedPlayer(actionBot, steamId, entry.reason, { durationMinutes: remainingMinutes, skipSync: true, actor: 'dynamic-ban-escalation', keepLocalTemporary: true });
        entry.escalated = true; entry.escalatedAt = nowIso();
        appendManagedAudit(fresh.id, { actor: 'dynamic-ban', action: 'dynamic-ban-escalated', target: steamId, detail: `${attempts.length} joins in ${windowMinutes} min; normal WARDOGS ban only until original expiry ${entry.expiresAt}` });
      } catch (error) {
        appendManagedAudit(fresh.id, { actor: 'dynamic-ban', action: 'dynamic-ban-escalation-failed', target: steamId, detail: String(error?.message || error).slice(0,300), status: 'error' });
      }
    }
  }
  if (changed) upsertManagedBot({ id: fresh.id, dynamicBans: rows });
}
export async function kickManagedPlayer(bot, steamId, reason = 'WARDOGS rule violation', meta = {}) {
  const normalized = normalizeSteamId64(steamId);
  if (!normalized) throw new Error('Invalid SteamID64');
  const result = await wardogsRequest(bot, `/v1/players/${encodeURIComponent(normalized)}/kick`, { method: 'POST', body: { reason: String(reason || '').slice(0, 180) } });
  if (!meta?.skipAudit) appendManagedAudit(bot.id, { actor: meta?.actor || 'system', action: 'kick', target: normalized, detail: String(reason || '').slice(0, 300) });
  return result;
}
export async function killManagedPlayer(bot, steamId, meta = {}) {
  const normalized = normalizeSteamId64(steamId);
  if (!normalized) throw new Error('Invalid SteamID64');
  const result = await wardogsRequest(bot, `/v1/players/${encodeURIComponent(normalized)}/kill`, { method: 'POST' });
  appendManagedAudit(bot.id, { actor: meta?.actor || 'system', action: 'kill-respawn', target: normalized });
  return result;
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
  // Player/faction/pawn readiness can briefly lag behind /v1/players.
  if ([400, 404, 409, 422, 423, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  // Transport resets/timeouts must not permanently kill a queued welcome.
  if (!status && ['econnreset','epipe','etimedout','econnrefused','enetunreach','ehostunreach'].includes(code)) return true;
  if (!status && /socket hang up|timed out|connection reset/i.test(detail)) return true;
  return false;
}

function playerIdFallbackAllowed(error) {
  const status = Number(error?.status || 0);
  const code = String(error?.code || '').toLowerCase();
  const detail = String(error?.detail || error?.message || '').toLowerCase();
  if (![400, 404, 422].includes(status)) return false;
  return code.includes('player') || detail.includes('player') || detail.includes('steam') || detail.includes('not found') || detail.includes('invalid');
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0))); }

function whisperRouteCandidates(playerOrId) {
  const raw = typeof playerOrId === 'object' && playerOrId !== null
    ? playerWardogsApiId(playerOrId)
    : String(playerOrId ?? '').trim();
  const normalized = typeof playerOrId === 'object' && playerOrId !== null
    ? playerSteamId(playerOrId)
    : normalizeSteamId64(playerOrId);
  return [...new Set([raw, normalized].map((value) => String(value || '').trim()).filter(Boolean))];
}

async function whisperManagedRosterPlayer(bot, playerOrId, message, { attempts = 1, retryDelayMs = 750 } = {}) {
  const clean = String(message || '').trim();
  if (!clean || clean.length > 200) throw new Error('Player message must be 1–200 characters long');
  const ids = whisperRouteCandidates(playerOrId);
  if (!ids.length) throw new Error('Invalid WARDOGS player/SteamID64');
  const maxAttempts = Math.max(1, Math.min(10, Number(attempts) || 1));
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    for (let i = 0; i < ids.length; i += 1) {
      try {
        return await wardogsRequest(bot, `/v1/players/${encodeURIComponent(ids[i])}/message`, { method: 'POST', body: { message: clean } });
      } catch (error) {
        lastError = error;
        // Only try an alternate identifier when the server explicitly says the
        // player/id is invalid. A transport failure is ambiguous and retrying a
        // second id immediately could duplicate an already-delivered whisper.
        if (i + 1 < ids.length && playerIdFallbackAllowed(error)) continue;
        break;
      }
    }
    if (attempt >= maxAttempts || !welcomeWhisperRetryable(lastError)) break;
    await sleep(retryDelayMs * attempt);
  }
  throw lastError || new Error('WARDOGS whisper failed');
}

async function sendManagedWelcomeWhisper(bot, state, player, message) {
  const steamId = playerSteamId(player);
  if (!steamId) return { sent: false, retry: false, attempts: 0, error: new Error('Invalid WARDOGS player/SteamID64') };
  const attemptNumber = Number(state.welcomeAttempts?.get?.(steamId) || 0) + 1;
  try {
    // Use the exact identifier returned by the current /v1/players roster first.
    // Some WARDOGS builds are stricter on /players/{id}/message than on other
    // moderation routes; a canonical Steam64 fallback is only used on an explicit
    // player/id rejection.
    await whisperManagedRosterPlayer(bot, player, message, { attempts: 1 });
    managedWelcomeSucceeded(state, steamId);
    return { sent: true, retry: false, attempts: attemptNumber, error: null };
  } catch (error) {
    const outcome = managedWelcomeFailed(state, steamId, { retryable: welcomeWhisperRetryable(error), maxAttempts: WELCOME_MAX_ATTEMPTS });
    return { sent: false, ...outcome, error };
  }
}

async function processManagedWelcomeQueue(bot, state, players = null, validFactions = null) {
  if (bot?.welcomeWhisperEnabled !== true) return;
  if (!(state.welcomePending instanceof Set) || state.welcomePending.size === 0) return;
  if (state.welcomeInFlight) return;
  state.welcomeInFlight = true;
  try {
    let rows = Array.isArray(players) ? players : null;
    if (!rows) {
      const data = await wardogsRequest(bot, '/v1/players');
      rows = wardogsPlayerRows(data);
    }
    const factionCatalog = Array.isArray(validFactions) ? validFactions : (Array.isArray(state.welcomeValidFactions) ? state.welcomeValidFactions : []);
    for (const player of managedWelcomeTargets(state, rows, [], { spawnSettleMs: WELCOME_SPAWN_SETTLE_MS, teamStablePolls: WELCOME_TEAM_STABLE_POLLS, maxAttempts: WELCOME_MAX_ATTEMPTS, validFactions: factionCatalog })) {
      const steamId = playerSteamId(player);
      const message = renderManagedWelcomeMessage(bot.welcomeWhisperMessage, player);
      if (!steamId || !message) continue;
      const result = await sendManagedWelcomeWhisper(bot, state, player, message);
      if (result.sent) {
        setRuntime(bot.id, {
          lastWelcomeWhisperAt: nowIso(),
          lastWelcomeWhisperPlayer: String(player?.name || steamId),
          lastWelcomeWhisperAttemptAt: nowIso(),
          lastWelcomeWhisperAttemptPlayer: String(player?.name || steamId),
          lastWelcomeWhisperError: null,
          lastWelcomeWhisperAttempts: result.attempts
        });
      } else {
        setRuntime(bot.id, {
          lastWelcomeWhisperAttemptAt: nowIso(),
          lastWelcomeWhisperAttemptPlayer: String(player?.name || steamId),
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
    const players = wardogsPlayerRows(data);
    // The status faction catalog is authoritative for what counts as a real team.
    // A non-empty placeholder/stale faction from /v1/players must never unlock a
    // welcome by itself.
    let matchBoundary = null;
    try {
      const status = await wardogsRequest(bot, '/v1/status');
      const factionCatalog = Array.isArray(status?.factionScores)
        ? [...new Set(status.factionScores.map((item) => String(item?.name || '').trim()).filter(Boolean))]
        : [];
      if (factionCatalog.length) state.welcomeValidFactions = factionCatalog;
      matchBoundary = managedMatchBoundary(state.welcomeMatchSnapshot, status);
      state.welcomeMatchSnapshot = matchBoundary.snapshot;
    } catch {}
    const validFactions = Array.isArray(state.welcomeValidFactions) ? state.welcomeValidFactions : [];
    if (!state.welcomeJoinTracker) state.welcomeJoinTracker = createManagedJoinTracker();
    // WARDOGS rebuilds the player roster at round/map boundaries. Preserve all
    // recently-known sessions across that boundary so the same connected players
    // are never welcomed again just because a new match started.
    if (matchBoundary?.changed) {
      markManagedJoinBoundary(state.welcomeJoinTracker, { carryoverMs: WELCOME_MATCH_CARRYOVER_MS });
      setRuntime(bot.id, { lastWelcomeMatchBoundaryAt: nowIso(), lastWelcomeMatchBoundaryReason: matchBoundary.reason || 'match' });
    }
    // Welcome detection is separate from risk/detection joins. Individual leaves
    // still confirm quickly, while a complete roster outage gets a longer grace
    // because that is how WARDOGS behaves during match transitions.
    const joined = managedJoinCandidates(state.welcomeJoinTracker, players, WELCOME_LEAVE_CONFIRM_POLLS, {
      emptyRosterMissingThreshold: WELCOME_EMPTY_ROSTER_CONFIRM_POLLS
    });
    managedWelcomeTargets(state, players, joined, { spawnSettleMs: WELCOME_SPAWN_SETTLE_MS, teamStablePolls: WELCOME_TEAM_STABLE_POLLS, maxAttempts: WELCOME_MAX_ATTEMPTS, validFactions });
    if (joined.length) {
      const last = joined[joined.length - 1];
      setRuntime(bot.id, {
        lastWelcomeJoinDetectedAt: nowIso(),
        lastWelcomeJoinDetectedPlayer: String(last?.name || playerSteamId(last) || 'player')
      });
    }
    await processManagedWelcomeQueue(bot, state, players, validFactions);

    const bySteamId = new Map(players.map((player) => [playerSteamId(player), player]).filter(([id]) => id));
    const pendingIds = state.welcomePending instanceof Set ? [...state.welcomePending] : [];
    let waitingForFaction = 0;
    let spawnReady = 0;
    for (const id of pendingIds) {
      const player = bySteamId.get(id);
      if (!player) continue;
      const teamConfirmed = state.welcomeTeamChoiceConfirmed instanceof Set && state.welcomeTeamChoiceConfirmed.has(id);
      if (teamConfirmed && playerHasPlayableFaction(player, validFactions)) spawnReady += 1;
      else waitingForFaction += 1;
    }
    setRuntime(bot.id, {
      welcomeWatcherLastPollAt: nowIso(),
      welcomeWatcherPlayers: players.length,
      welcomeWatcherActive: state.welcomeJoinTracker?.active?.size || 0,
      welcomeWatcherPending: state.welcomePending?.size || 0,
      welcomeWatcherWaitingForFaction: waitingForFaction,
      welcomeWatcherSpawnReady: spawnReady,
      welcomeWatcherLastPollError: null
    });
  } catch (error) {
    setRuntime(bot.id, {
      welcomeWatcherLastPollAt: nowIso(),
      welcomeWatcherLastPollError: String(error?.message || error).slice(0, 300)
    });
  } finally {
    state.welcomePollInFlight = false;
  }
}

async function cleanupLegacyJoinSeedingServerName(bot) {
  if (bot?.legacyJoinSeedingCleanupDone === true) return;
  try {
    const status = await wardogsRequest(bot, '/v1/status');
    const currentName = String(status?.serverName || '').trim();
    const desired = currentName.replace(/\s+JOIN Seeding$/i, '').trim();
    if (currentName && desired && desired !== currentName) await writeManagedServerName(bot, desired);
    upsertManagedBot({ id: bot.id, legacyJoinSeedingCleanupDone: true });
  } catch (error) {
    console.warn(`Managed bot ${bot?.id || ''}: legacy JOIN Seeding cleanup failed: ${String(error?.message || error).slice(0, 240)}`);
  }
}

export async function whisperManagedPlayer(bot, steamId, message, meta = {}) {
  const normalized = normalizeSteamId64(steamId);
  if (!normalized) throw new Error('Invalid SteamID64');
  const clean = String(message || '').trim();
  if (!clean || clean.length > 200) throw new Error('Player message must be 1–200 characters long');

  // Resolve the current roster row so the per-player endpoint receives exactly
  // the identifier WARDOGS itself returned. Fall back to Steam64 if the player
  // disappears between dashboard render and action click.
  let target = normalized;
  try {
    const payload = await wardogsRequest(bot, '/v1/players');
    target = wardogsPlayerRows(payload).find((player) => playerSteamId(player) === normalized) || normalized;
  } catch {
    target = normalized;
  }
  const result = await whisperManagedRosterPlayer(bot, target, clean, { attempts: 3, retryDelayMs: 600 });
  appendManagedAudit(bot.id, { actor: meta?.actor || 'system', action: 'whisper', target: normalized, detail: clean });
  try { appendManagedChat(bot.id, bot?._managedServerId || 'primary', { direction: 'out', kind: 'whisper', steamId: normalized, playerName: typeof target === 'object' ? String(target?.name || '') : '', message: clean, actor: meta?.actor || 'system' }); } catch {}
  return result;
}

export async function whisperManagedFaction(bot, faction, message, meta = {}) {
  const cleanFaction = String(faction || '').trim();
  const cleanMessage = String(message || '').trim();
  if (!cleanFaction || cleanFaction.length > 80) throw new Error('Faction is invalid');
  if (!cleanMessage || cleanMessage.length > 200) throw new Error('Faction whisper must be 1–200 characters long');

  const payload = await wardogsRequest(bot, '/v1/players');
  const players = wardogsPlayerRows(payload);
  const targets = players.filter((player) => Boolean(playerSteamId(player)) && factionMatches(playerFaction(player), cleanFaction));
  if (!targets.length) return { faction: cleanFaction, matched: 0, sent: 0, failed: 0, failures: [] };

  // Send sequentially. The WARDOGS connection is deliberately single-lane, so
  // parallel workers only created competing requests without improving latency.
  let sent = 0;
  const failures = [];
  for (const player of targets) {
    const steamId = playerSteamId(player);
    const rendered = renderManagedWelcomeMessage(cleanMessage, player) || cleanMessage;
    try {
      await whisperManagedRosterPlayer(bot, player, rendered, { attempts: 3, retryDelayMs: 600 });
      sent += 1;
    } catch (error) {
      failures.push({ steamId, name: String(player?.name || ''), faction: playerFaction(player), error: String(error?.message || error || 'Whisper failed').slice(0, 180) });
    }
  }
  appendManagedAudit(bot.id, { actor: meta?.actor || 'system', action: 'faction-whisper', target: cleanFaction, detail: `${sent}/${targets.length} reached · ${cleanMessage}` });
  if (sent > 0) { try { appendManagedChat(bot.id, bot?._managedServerId || 'primary', { direction: 'out', kind: 'faction-whisper', channel: cleanFaction, message: cleanMessage, actor: meta?.actor || 'system' }); } catch {} }
  return { faction: cleanFaction, matched: targets.length, sent, failed: failures.length, failures: failures.slice(0, 10) };
}
export async function moveManagedPlayer(bot, steamId, faction, meta = {}) {
  const normalized = normalizeSteamId64(steamId);
  if (!normalized) throw new Error('Invalid SteamID64');
  const clean = String(faction || '').trim();
  if (!clean || clean.length > 80) throw new Error('Faction is invalid');
  const moved = await wardogsRequest(bot, `/v1/players/${encodeURIComponent(normalized)}`, { method: 'PATCH', body: { faction: clean } });
  let respawn = null;
  try { respawn = await killManagedPlayer(bot, normalized); } catch {}
  appendManagedAudit(bot.id, { actor: meta?.actor || 'system', action: 'set-team', target: normalized, detail: clean });
  return { moved, respawn };
}
export async function unbanManagedPlayer(bot, steamId, meta = {}) {
  const normalized = normalizeSteamId64(steamId);
  if (!normalized) throw new Error('Invalid SteamID64');
  const freshBefore = getManagedBot(bot?.id) || bot;
  const dynamic = meta?._dynamicSnapshot || dynamicBans(freshBefore).find((entry) => entry.steamId === normalized);
  const fanout = !bot?._managedServerId ? managedServerContexts(freshBefore) : [];
  if (fanout.length > 1 && meta?._fanout !== true) {
    const results = [], errors = [];
    if (!dynamic || dynamic.escalated) {
      for (const server of fanout) {
        try { results.push(await unbanManagedPlayer(server, normalized, { ...meta, skipSync: true, tolerateMissing: true, _fanout: true, _dynamicSnapshot: dynamic || null })); }
        catch (error) { errors.push(`${server._managedServerLabel || server._managedServerId}: ${String(error?.message || error).slice(0,180)}`); }
      }
      if (errors.length === fanout.length) throw new Error(`Unban failed on all managed servers: ${errors[0]}`);
    }
    const latest = getManagedBot(bot.id) || freshBefore;
    upsertManagedBot({ id: latest.id, temporaryBans: temporaryBans(latest).filter((entry) => entry.steamId !== normalized), dynamicBans: dynamicBans(latest).filter((entry) => entry.steamId !== normalized) });
    appendManagedAudit(bot.id, { actor: meta?.actor || 'system', action: 'unban', target: normalized, detail: dynamic && !dynamic.escalated ? 'Dynamic ban removed locally across all managed servers.' : `WARDOGS ban removed across ${results.length}/${fanout.length} managed servers.` });
    if (!meta?.skipSync) await syncUnbanToAcceptedTarget(getManagedBot(bot.id) || bot, normalized, meta);
    return { fanout: true, applied: results.length, failed: errors.length, errors, localOnly: Boolean(dynamic && !dynamic.escalated) };
  }
  let result = { localOnly: Boolean(dynamic && !dynamic.escalated) };
  if (!dynamic || dynamic.escalated) {
    try { result = await wardogsRequest(bot, `/v1/bans/${encodeURIComponent(normalized)}`, { method: 'DELETE' }); }
    catch (error) { if (!(meta?.tolerateMissing && Number(error?.status || 0) === 404)) throw error; }
  }
  const fresh = getManagedBot(bot?.id);
  if (fresh) upsertManagedBot({ id: fresh.id, temporaryBans: temporaryBans(fresh).filter((entry) => entry.steamId !== normalized), dynamicBans: dynamicBans(fresh).filter((entry) => entry.steamId !== normalized) });
  appendManagedAudit(bot.id, { actor: meta?.actor || 'system', action: 'unban', target: normalized, detail: dynamic && !dynamic.escalated ? 'Dynamic ban removed locally.' : 'WARDOGS ban removed.' });
  if (!meta?.skipSync) await syncUnbanToAcceptedTarget(getManagedBot(bot.id) || bot, normalized, meta);
  return result;
}
export async function addManagedReservedSlot(bot, steamId, meta = {}) {
  if (!validSteamId(steamId)) throw new Error('Invalid SteamID64');
  const result = await wardogsRequest(bot, '/v1/reserved-slots', { method: 'POST', body: { steamId: String(steamId) } });
  appendManagedAudit(bot.id, { actor: meta?.actor || 'system', action: 'reserved-slot-add', target: String(steamId) });
  return result;
}
export async function removeManagedReservedSlot(bot, steamId, meta = {}) {
  if (!validSteamId(steamId)) throw new Error('Invalid SteamID64');
  const result = await wardogsRequest(bot, `/v1/reserved-slots/${encodeURIComponent(steamId)}`, { method: 'DELETE' });
  appendManagedAudit(bot.id, { actor: meta?.actor || 'system', action: 'reserved-slot-remove', target: String(steamId) });
  return result;
}
export async function broadcastManaged(bot, message, meta = {}) {
  const clean = String(message || '').trim();
  if (!clean || clean.length > 200) throw new Error('Announcement must be 1–200 characters long');
  const result = await wardogsRequest(bot, '/v1/broadcast', { method: 'POST', body: { message: clean } });
  appendManagedAudit(bot.id, { actor: meta?.actor || 'system', action: 'broadcast', detail: clean });
  try { appendManagedChat(bot.id, bot?._managedServerId || 'primary', { direction: 'out', kind: 'broadcast', channel: 'all', message: clean, actor: meta?.actor || 'system' }); } catch {}
  return result;
}
export async function restartManagedMatch(bot, meta = {}) { const result = await wardogsRequest(bot, '/v1/match/restart', { method: 'POST' }); appendManagedAudit(bot.id, { actor: meta?.actor || 'system', action: 'match-restart' }); return result; }
export async function endManagedMatch(bot, meta = {}) { const result = await wardogsRequest(bot, '/v1/match/end', { method: 'POST' }); appendManagedAudit(bot.id, { actor: meta?.actor || 'system', action: 'match-end' }); return result; }
function managedLightingValue(value) {
  if (value && typeof value === 'object') return String(value.name ?? value.id ?? value.label ?? value.value ?? '').trim();
  return String(value ?? '').trim();
}
function managedLightingMatches(actual, requested) {
  const normalize = (value) => managedLightingValue(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
  return Boolean(normalize(actual) && normalize(actual) === normalize(requested));
}
export async function setManagedLighting(bot, lighting, meta = {}) {
  const clean = String(lighting || '').trim();
  if (!clean || clean.length > 100) throw new Error('Lighting value is invalid');

  // Lighting is an idempotent world setting. Do not report success merely because
  // the PUT returned 2xx: read /v1/status back and retry once if the live world
  // did not adopt the requested value. This turns previously silent no-ops into a
  // useful panel error instead of a false "Lighting changed" message.
  let commandResult = await wardogsRequest(bot, '/v1/world/lighting', { method: 'PUT', body: { lighting: clean } });
  let lastStatus = null;
  let lastReadError = null;
  for (const delayMs of [150, 400, 800, 1400]) {
    await sleep(delayMs);
    try {
      lastStatus = await wardogsRequest(bot, '/v1/status');
      lastReadError = null;
      const live = managedLightingValue(lastStatus?.lighting);
      if (live && managedLightingMatches(live, clean)) { appendManagedAudit(bot.id, { actor: meta?.actor || 'system', action: 'lighting', detail: clean }); return { commandResult, verified: true, requested: clean, lighting: live }; }
    } catch (error) { lastReadError = error; }
  }

  // One safe retry: setting lighting to the same value twice has no cumulative
  // side effect, unlike a kick/whisper where blind retries could duplicate work.
  commandResult = await wardogsRequest(bot, '/v1/world/lighting', { method: 'PUT', body: { lighting: clean } });
  await sleep(700);
  try {
    lastStatus = await wardogsRequest(bot, '/v1/status');
    lastReadError = null;
    const live = managedLightingValue(lastStatus?.lighting);
    if (live && managedLightingMatches(live, clean)) { appendManagedAudit(bot.id, { actor: meta?.actor || 'system', action: 'lighting', detail: clean }); return { commandResult, verified: true, requested: clean, lighting: live }; }
  } catch (error) { lastReadError = error; }

  if (lastReadError && !lastStatus) throw new Error(`Lighting command sent, but live status could not be verified: ${String(lastReadError?.message || lastReadError).slice(0, 180)}`);
  const live = managedLightingValue(lastStatus?.lighting) || 'unknown';
  throw new Error(`WARDOGS accepted lighting "${clean}", but live status still reports "${live}". The current server phase/build did not apply it live.`);
}
export async function changeManagedMap(bot, { map, experiences = [], lighting = '', zoneAlternator = '' } = {}, meta = {}) {
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
  const result = await wardogsRequest(bot, '/v1/match/map', { method: 'POST', body });
  appendManagedAudit(bot.id, { actor: meta?.actor || 'system', action: 'map-change', target: cleanMap, detail: JSON.stringify(body).slice(0, 500) });
  return result;
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
    await kickManagedPlayer(bot, steamId, reason, { actor: 'detection-rule' });
    return { action: 'kick', ok: true, label: 'Kick executed' };
  }
  if (chosen.action === 'tempban') {
    const minutes = chosen.durationMinutes || 1440;
    const entry = await temporaryBanManagedPlayer(bot, steamId, reason, minutes, { createdBy: 'detection-rule' });
    return { action: 'tempban', ok: true, label: `Temporary ban · ${formatManagedBanDuration(minutes)}`, expiresAt: entry.expiresAt };
  }
  await banManagedPlayer(bot, steamId, reason, { actor: 'detection-rule' });
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
  if (interaction?.memberPermissions?.has?.(PermissionsBitField.Flags.Administrator)) return true;
  const grants = normalizeDiscordGrants(bot);
  // v3.12.30: management-panel access is explicit. Bot ownership and ordinary
  // Discord Kick/Ban permissions do not grant access automatically. Only guild
  // Administrators keep the normal Discord admin bypass above; everyone else
  // must be present in the configured user/role grant list.
  if (!grants.length) return false;
  const roleIds = new Set(interactionRoleIds(interaction));
  return grants.some((grant) => {
    const subject = grant.type === 'user' ? grant.id === userId : roleIds.has(grant.id);
    return subject && grant.permissions.includes(key);
  });
}

function signature(bot) {
  return JSON.stringify({
    enabled: Boolean(bot.enabled), botTokenEnc: bot.botTokenEnc || '', mentionRoleId: bot.mentionRoleId || '',
    managedServers: normalizeManagedServers(bot).map((server)=>({id:server.id,label:server.label,baseUrl:server.baseUrl,secretEnc:server.secretEnc,alertChannelId:server.alertChannelId,controlPanelEnabled:server.controlPanelEnabled,controlPanelChannelId:server.controlPanelChannelId})),
    discordGrants: normalizeDiscordGrants(bot), ignoredPlayers: ignoredPlayers(bot), allowPrivateTarget: Boolean(bot.allowPrivateTarget),
    pollSeconds: Number(bot.pollSeconds || 20), rulesText: bot.rulesText || '', autoBanEnabled: bot.autoBanEnabled === true,
    steamWebApiKeyEnc: bot.steamWebApiKeyEnc || '', steamAppId: bot.steamAppId || '',
    announcementEnabled: bot.announcementEnabled === true, announcementIntervalMinutes: Number(bot.announcementIntervalMinutes || 15),
    announcementMessages: bot.announcementMessages || '', welcomeWhisperEnabled: bot.welcomeWhisperEnabled === true,
    welcomeWhisperMessage: bot.welcomeWhisperMessage || '', dynamicNameEnabled: bot.dynamicNameEnabled === true, dynamicNameStatsEnabled: bot.dynamicNameStatsEnabled === true, dynamicNameStatsTemplate: bot.dynamicNameStatsTemplate || '', dynamicNameSeedingEnabled: bot.dynamicNameSeedingEnabled === true, dynamicNameSeedingMinPlayers: Number(bot.dynamicNameSeedingMinPlayers || 1), dynamicNameSeedingMaxPlayers: Number(bot.dynamicNameSeedingMaxPlayers || 20), dynamicNameSeedingTemplate: bot.dynamicNameSeedingTemplate || '', dynamicNameRotationEnabled: bot.dynamicNameRotationEnabled === true, dynamicNameRotationNameA: bot.dynamicNameRotationNameA || '', dynamicNameRotationNameB: bot.dynamicNameRotationNameB || '', dynamicNameRotationMinutes: Number(bot.dynamicNameRotationMinutes || 5), banDiscordLink: normalizeManagedBanDiscordLink(bot.banDiscordLink), dynamicBanEnabled: bot.dynamicBanEnabled === true, dynamicBanEscalateJoins: Number(bot.dynamicBanEscalateJoins || 3), dynamicBanEscalateWindowMinutes: Number(bot.dynamicBanEscalateWindowMinutes || 5), banSyncTargetBotId: bot.banSyncTargetBotId || '', banSyncAcceptedSources: banSyncAcceptedSources(bot), accessUntil: bot.accessUntil || null, adminGrant: Boolean(bot.adminGrant), restartNonce: bot.restartNonce || 0
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
  const playerList = wardogsPlayerRows(players);
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
    try { persistManagedServerState(bot, { controlPanelMessageId: '', controlPanelMessageChannelId: '' }); } catch {}
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
      try { persistManagedServerState(bot, { controlPanelMessageId: String(message.id), controlPanelMessageChannelId: channelId }); } catch {}
    }
    setServerRuntime(bot, { controlPanelMessageId: String(message.id), controlPanelChannelId: channelId });
    return message;
  } finally {
    state.panelPosting = false;
  }
}

function stateForManagedServer(rootState, bot) { return rootState?.serverStates?.get?.(String(bot?._managedServerId || 'primary')) || rootState; }
function scheduleControlPanelBottom(botId, serverId, client, state) {
  clearTimeout(state.panelRepostTimer);
  state.panelRepostTimer = setTimeout(async () => {
    const fresh = getManagedBot(botId);
    if (!fresh?.enabled || !accessActive(fresh)) return;
    const ctx = managedServerContext(fresh, serverId);
    if (!ctx?.controlPanelEnabled) return;
    try { await ensureControlPanel(ctx, client, state, { repost: true }); }
    catch (error) { setServerRuntime(ctx, { lastPanelError: error.message }); }
  }, 750);
  state.panelRepostTimer.unref?.();
}

async function pollManagedDynamicBans(bot, state) {
  if (state.dynamicPollInFlight) return;
  state.dynamicPollInFlight = true;
  try {
    // Expiry is enforced even when nobody is online. If a Dynamic Ban was
    // escalated to a real WARDOGS ban, this is also where that real ban is
    // removed at the ORIGINAL expiry time.
    await processManagedDynamicBans(bot, []);
    const fresh = getManagedBot(bot?.id) || bot;
    const activeBans = dynamicBans(fresh).filter((entry) => Date.parse(entry.expiresAt) > Date.now());
    if (!activeBans.length) {
      state.dynamicJoinTracker = createManagedJoinTracker();
      setRuntime(fresh.id, { dynamicBanWatcherActive: false, dynamicBanWatcherPlayers: 0 });
      return;
    }

    const actionBot = bot?._managedServerId ? (managedServerContext(fresh, bot._managedServerId) || bot) : (managedServerContexts(fresh)[0] || fresh);
    const data = await wardogsRequest(actionBot, '/v1/players');
    const players = wardogsPlayerRows(data);
    const tracker = state.dynamicJoinTracker || (state.dynamicJoinTracker = createManagedJoinTracker());
    const wasInitialized = tracker.initialized === true;
    const joined = managedJoinCandidates(tracker, players, DYNAMIC_BAN_LEAVE_CONFIRM_POLLS);
    const bannedIds = new Set(activeBans.map((entry) => entry.steamId));

    // On a service restart an already connected dynamically-banned player must
    // not get a free pass just because the first roster snapshot is normally
    // baseline-only. Treat matching players in that first snapshot as blocked
    // sessions and enforce the kick immediately.
    const enforce = wasInitialized
      ? joined.filter((player) => bannedIds.has(playerSteamId(player)))
      : players.filter((player) => bannedIds.has(playerSteamId(player)));

    if (enforce.length) await processManagedDynamicBans(fresh, enforce);
    setRuntime(fresh.id, {
      dynamicBanWatcherActive: true,
      dynamicBanWatcherPlayers: activeBans.length,
      lastDynamicBanWatcherAt: nowIso(),
      lastDynamicBanWatcherError: null
    });
  } catch (error) {
    setRuntime(bot.id, { lastDynamicBanWatcherAt: nowIso(), lastDynamicBanWatcherError: String(error?.message || error).slice(0, 300) });
    throw error;
  } finally {
    state.dynamicPollInFlight = false;
  }
}

async function pollPlayers(bot, state, client) {
  // Never allow overlapping poll cycles. Slow Steam/RCON requests must not create
  // a second concurrent detection pass for the same join.
  if (state.pollInFlight) return;
  state.pollInFlight = true;
  try {
    let status = null;
    let data = null;
    if (bot.dynamicNameEnabled === true) {
      [data, status] = await Promise.all([wardogsRequest(bot, '/v1/players'), wardogsRequest(bot, '/v1/status')]);
    } else {
      data = await wardogsRequest(bot, '/v1/players');
    }
    const players = wardogsPlayerRows(data);
    if (bot.dynamicNameEnabled === true && status) await syncManagedDynamicServerName(bot, state, status, players.length);
    const rules = parseManagedRules(bot.rulesText || '');
    const ignored = ignoredSteamIds(bot);

    // The first successful snapshot after start/restart is baseline only. Afterwards
    // a SteamID is screened once when it transitions into a new confirmed session.
    // Three consecutive successful snapshots must miss a player before a later return
    // is treated as another join. This absorbs temporary empty/incomplete API results.
    const joinedPlayers = managedJoinCandidates(state.joinTracker, players, 3);
    // Community bans that could not be installed while a player was offline are
    // enforced the moment that SteamID appears. On the first baseline after a bot
    // restart, check the full roster so an already-connected banned player cannot
    // slip through until their next reconnect.
    try {
      await enforceBanSyncCommunityForPlayers(bot, state.baselineReady ? joinedPlayers : players);
    } catch (error) {
      setRuntime(bot.id, { lastBanSyncAt: nowIso(), lastBanSyncError: String(error?.message || error).slice(0, 300) });
    }
    // Dynamic Ban enforcement has its own fast 2-second watcher. Detection rules
    // keep the slower, conservative tracker to avoid false join events.
    const dynamicBlocked = new Set(dynamicBans(getManagedBot(bot.id) || bot).map((entry) => entry.steamId));
    const candidates = joinedPlayers.filter((player) => {
      const id = playerSteamId(player);
      return id && !ignored.has(id) && !dynamicBlocked.has(id);
    });

    if (!state.baselineReady && state.joinTracker?.initialized) {
      state.baselineReady = true;
      state.lastAnnouncementAt = Date.now();
      state.announcementIndex = 0;
    }

    if (bot.welcomeWhisperEnabled !== true) {
      state.welcomePending?.clear?.();
      state.welcomeDelivered?.clear?.();
      state.welcomeFailed?.clear?.();
      state.welcomeAttempts?.clear?.();
      state.welcomeReadyAt?.clear?.();
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
          await broadcastManaged(bot, message, { actor: 'scheduled-announcement' });
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
  const parent = getManagedBot(botId);
  if (!parent || !parent.enabled || !accessActive(parent)) {
    if (!interaction.replied && !interaction.deferred) interaction.reply({ content: 'This managed bot is not active.', ephemeral: true }).catch(() => {});
    return null;
  }
  if (permission && !discordPermission(parent, interaction, permission)) { deny(interaction, permission); return null; }
  const byChannel = managedServerByChannel(parent, interaction?.channelId);
  return byChannel || managedServerContexts(parent)[0] || parent;
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
  const players = wardogsPlayerRows(data).filter((p) => Boolean(playerSteamId(p)));
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
  const players = wardogsPlayerRows(data);
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
  const state = setUiState(botUiId(bot), interaction.user.id, {
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
      { label: 'Minutes', value: 'minutes', description: 'Temporary ban in minutes' },
      { label: 'Hours', value: 'hours', description: 'Temporary ban in hours' },
      { label: 'Days', value: 'days', description: 'Temporary ban in days' }
    ]);
  return { content: '**Ban duration**', components: [new ActionRowBuilder().addComponents(select)], ephemeral: true };
}

function discordBanDurationMinutes(interaction, mode) {
  const normalized = String(mode || 'permanent').toLowerCase();
  if (normalized === 'permanent') return 0;
  if (!['minutes', 'hours', 'days'].includes(normalized)) throw new Error('Invalid ban duration mode');
  const value = Number(String(interaction.fields.getTextInputValue('durationValue') || '').replace(',', '.'));
  if (!Number.isFinite(value) || value <= 0) throw new Error('Ban duration must be greater than 0');
  const minutes = Math.round(value * (normalized === 'days' ? 1440 : normalized === 'hours' ? 60 : 1));
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
      appendManagedAudit(bot.id, { actor: `discord:${interaction.user?.id || ''}`, action: 'detection-ignore-add', target: steamId });
      await interaction.update({ components: alertComponents(bot, { steamId }, true) }).catch(() => {});
      await interaction.followUp({ content: `SteamID64 ${steamId} is now ignored. No further detection alerts or auto-bans will be generated for this player until the ignore is removed in the web panel.`, ephemeral: true }).catch(() => {});
      return true;
    }
    await interaction.deferReply({ ephemeral: true }).catch(() => {});
    if (action === 'wdban') await banManagedPlayer(bot, steamId, `Discord action by ${interaction.user?.tag || interaction.user?.id || 'admin'}`, { actor: `discord:${interaction.user?.id || ''}` });
    else await kickManagedPlayer(bot, steamId, `Discord action by ${interaction.user?.tag || interaction.user?.id || 'admin'}`, { actor: `discord:${interaction.user?.id || ''}` });
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
      await ensureControlPanel(bot, client, stateForManagedServer(state, bot));
      await interaction.reply({ content: 'Management panel refreshed.', ephemeral: true }); return true;
    }
    if (['pkick','pban','pwhisper','pkill','pteam'].includes(action)) {
      const steamId = parts[3]; if (!validSteamId(steamId)) throw new Error('Invalid SteamID64');
      const permission = ({ pkick: 'kick', pban: 'ban', pwhisper: 'whisper', pkill: 'kill', pteam: 'setteam' })[action];
      const bot = interactionBot(interaction, botId, permission); if (!bot) return true;
      if (action === 'pkick') await interaction.showModal(modal(`wd:mkick:${bot.id}:${steamId}`, 'Kick player', [{ id: 'reason', label: 'Reason', maxLength: 180, required: false, placeholder: 'Rule violation' }]));
      else if (action === 'pban') await interaction.reply(banDurationPicker(bot, steamId));
      else if (action === 'pwhisper') await interaction.showModal(modal(`wd:mwhisper:${bot.id}:${steamId}`, 'Whisper', [{ id: 'message', label: 'Message', style: TextInputStyle.Paragraph, maxLength: 200 }]));
      else if (action === 'pkill') { await killManagedPlayer(bot, steamId, { actor: `discord:${interaction.user?.id || ''}` }); await interaction.reply({ content: `Kill/respawn sent for ${steamId}.`, ephemeral: true }); }
      else await interaction.reply(await teamPicker(bot, steamId));
      return true;
    }
    if (action === 'manualban') {
      const bot = interactionBot(interaction, botId, 'ban'); if (!bot) return true;
      await interaction.reply(banDurationPicker(bot, 'manual')); return true;
    }
    if (action === 'restartmatch' || action === 'endmatch') {
      const bot = interactionBot(interaction, botId, 'match'); if (!bot) return true;
      if (action === 'restartmatch') await restartManagedMatch(bot, { actor: `discord:${interaction.user?.id || ''}` }); else await endManagedMatch(bot, { actor: `discord:${interaction.user?.id || ''}` });
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
      const saved = getUiState(botUiId(bot), interaction.user.id); if (!saved.map) throw new Error('No map selected');
      await changeManagedMap(bot, { map: saved.map, experiences: saved.experiences || [], lighting: saved.lighting || '', zoneAlternator: saved.zoneAlternator || '' }, { actor: `discord:${interaction.user?.id || ''}` });
      discordUiState.delete(uiKey(botUiId(bot), interaction.user.id));
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
      if (!['permanent','minutes','hours','days'].includes(mode)) throw new Error('Invalid ban duration mode');
      const durationField = mode === 'permanent' ? [] : [{ id: 'durationValue', label: mode === 'days' ? 'Duration in days' : mode === 'hours' ? 'Duration in hours' : 'Duration in minutes', maxLength: 7, placeholder: mode === 'days' ? '7' : mode === 'hours' ? '24' : '5' }];
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
      const steamId = String(interaction.values?.[0] || ''); await unbanManagedPlayer(bot, steamId, { actor: `discord:${interaction.user?.id || ''}` });
      await interaction.update({ content: `Ban for ${steamId} removed.`, components: [] }); return true;
    }
    if (action === 'teamset') {
      const steamId = parts[3]; const bot = interactionBot(interaction, botId, 'setteam'); if (!bot) return true;
      const faction = String(interaction.values?.[0] || ''); await moveManagedPlayer(bot, steamId, faction, { actor: `discord:${interaction.user?.id || ''}` });
      await interaction.update({ content: `${steamId} was moved to **${cut(faction, 80)}** and respawned.`, components: [] }); return true;
    }
    if (action === 'mapsel') {
      const bot = interactionBot(interaction, botId, 'map'); if (!bot) return true;
      const map = String(interaction.values?.[0] || ''); { const payload=await setupMapState(bot, interaction, map); delete payload.ephemeral; await interaction.update(payload); } return true;
    }
    if (['mapexp','maplight','mapalt'].includes(action)) {
      const bot = interactionBot(interaction, botId, 'map'); if (!bot) return true;
      const state = getUiState(botUiId(bot), interaction.user.id); if (!state.map) throw new Error('Map selection expired');
      if (action === 'mapexp') state.experiences = interaction.values.includes('__none__') ? [] : interaction.values.slice(0, 10);
      if (action === 'maplight') state.lighting = interaction.values[0] === '__default__' ? '' : String(interaction.values[0] || '');
      if (action === 'mapalt') state.zoneAlternator = interaction.values[0] === '__default__' ? '' : String(interaction.values[0] || '');
      setUiState(botUiId(bot), interaction.user.id, state);
      await interaction.update({ content: `**Map Setup** · ${cut(state.map, 90)}\nChoose experiences, lighting and a zone alternator, then apply the map change.`, components: mapSetupComponents(bot, state) }); return true;
    }
    if (action === 'lightset') {
      const bot = interactionBot(interaction, botId, 'lighting'); if (!bot) return true;
      const lighting = String(interaction.values?.[0] || ''); await setManagedLighting(bot, lighting, { actor: `discord:${interaction.user?.id || ''}` });
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
      const message = interaction.fields.getTextInputValue('message'); await broadcastManaged(bot, message, { actor: `discord:${interaction.user?.id || ''}` });
      await interaction.reply({ content: 'Server announcement sent.', ephemeral: true }); return true;
    }
    if (action === 'mkick') {
      const bot = interactionBot(interaction, botId, 'kick'); if (!bot) return true;
      const reason = interaction.fields.getTextInputValue('reason') || 'Discord panel kick'; await kickManagedPlayer(bot, steamId, reason, { actor: `discord:${interaction.user?.id || ''}` });
      await interaction.reply({ content: `Kick for ${steamId} sent.`, ephemeral: true }); return true;
    }
    if (action === 'mbanplayer') {
      const bot = interactionBot(interaction, botId, 'ban'); if (!bot) return true;
      const reason = interaction.fields.getTextInputValue('reason') || 'Discord panel ban';
      const duration = discordBanDurationMinutes(interaction, durationMode);
      if (duration > 0) {
        const entry = await temporaryBanManagedPlayer(bot, steamId, reason, duration, { createdBy: `discord:${interaction.user?.id || ''}` });
        await interaction.reply({ content: `${entry.dynamic ? 'Dynamic Ban' : 'Temporary ban'} for ${steamId} is active for ${formatManagedBanDuration(duration)} (until ${entry.expiresAt}).`, ephemeral: true });
      } else {
        await banManagedPlayer(bot, steamId, reason, { actor: `discord:${interaction.user?.id || ''}` });
        await interaction.reply({ content: `${steamId} was permanently banned.`, ephemeral: true });
      }
      return true;
    }
    if (action === 'mwhisper') {
      const bot = interactionBot(interaction, botId, 'whisper'); if (!bot) return true;
      const message = interaction.fields.getTextInputValue('message'); await whisperManagedPlayer(bot, steamId, message, { actor: `discord:${interaction.user?.id || ''}` });
      await interaction.reply({ content: `Whisper sent to ${steamId}.`, ephemeral: true }); return true;
    }
    if (action === 'mmanualban') {
      const bot = interactionBot(interaction, botId, 'ban'); if (!bot) return true;
      const id = interaction.fields.getTextInputValue('steamId').trim(); if (!validSteamId(id)) throw new Error('Invalid SteamID64');
      const reason = interaction.fields.getTextInputValue('reason') || 'Discord panel ban';
      const duration = discordBanDurationMinutes(interaction, durationMode);
      if (duration > 0) {
        const entry = await temporaryBanManagedPlayer(bot, id, reason, duration, { createdBy: `discord:${interaction.user?.id || ''}` });
        await interaction.reply({ content: `${entry.dynamic ? 'Dynamic Ban' : 'Temporary ban'} for ${id} is active for ${formatManagedBanDuration(duration)} (until ${entry.expiresAt}).`, ephemeral: true });
      } else {
        await banManagedPlayer(bot, id, reason, { actor: `discord:${interaction.user?.id || ''}` });
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
  if (active) instances.delete(id);
  if (active) {
    clearInterval(active.timer);
    clearInterval(active.dynamicTimer);
    const stored = getManagedBot(id) || { id };
    const contexts = managedServerContexts(stored);
    for (const ctx of contexts) {
      const serverState = active.state?.serverStates?.get?.(String(ctx._managedServerId || 'primary'));
      if (serverState) {
        clearTimeout(serverState.panelRepostTimer);
        clearInterval(serverState.welcomeTimer);
        clearInterval(serverState.dynamicTimer);
      }
      try { await deleteStoredControlPanel(ctx, active.client, serverState || {}); } catch {}
    }
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
  const servers = managedServerContexts(bot);
  if (!servers.length) throw new Error('At least one WARDOGS server is required');
  const channelOwners = new Map();
  for (const server of servers) {
    if (!validSnowflake(server.alertChannelId)) throw new Error(`${server._managedServerLabel || 'Server'}: Discord alert channel ID is missing or invalid`);
    if (server.controlPanelEnabled && !validSnowflake(server.controlPanelChannelId)) throw new Error(`${server._managedServerLabel || 'Server'}: Discord management panel channel ID is missing or invalid`);
    for (const [kind, channelId] of [['alert', server.alertChannelId], ['panel', server.controlPanelEnabled ? server.controlPanelChannelId : '']]) {
      if (!channelId) continue;
      const existing = channelOwners.get(channelId);
      if (existing && existing !== server._managedServerId) throw new Error(`Discord channel ${channelId} is assigned to multiple managed servers. Use separate alert/panel channels per server.`);
      channelOwners.set(channelId, server._managedServerId);
    }
  }
  const token = decryptSecret(bot.botTokenEnc);
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
  const rootState = { serverStates: new Map(), timer: null, dynamicTimer: null };
  for (const server of servers) rootState.serverStates.set(String(server._managedServerId || 'primary'), serverStateTemplate(server));
  try {
    client.on('interactionCreate', (interaction) => handleInteraction(interaction, client, rootState).catch((error) => console.error(`Managed bot interaction ${bot.id}:`, error.message)));
    client.on('messageCreate', (message) => {
      const fresh = getManagedBot(bot.id);
      if (!fresh?.enabled) return;
      const server = managedServerByChannel(fresh, message.channelId);
      if (!server?.controlPanelEnabled || String(message.channelId || '') !== String(server.controlPanelChannelId || '')) return;
      const serverState = rootState.serverStates.get(String(server._managedServerId || 'primary'));
      if (!serverState || serverState.panelPosting || String(message.id || '') === String(serverState.panelMessageId || '')) return;
      scheduleControlPanelBottom(bot.id, server._managedServerId, client, serverState);
    });
    client.on('error', (error) => setRuntime(bot.id, { lastError: error.message }));
    client.on('shardDisconnect', () => setRuntime(bot.id, { state: 'disconnected', needsRecovery: true, disconnectedAt: Date.now(), lastError: 'Discord connection lost' }));
    client.on('shardError', (error) => setRuntime(bot.id, { state: 'disconnected', needsRecovery: true, disconnectedAt: Date.now(), lastError: String(error?.message || 'Discord shard error').slice(0, 300) }));
    client.on('invalidated', () => setRuntime(bot.id, { state: 'disconnected', needsRecovery: true, disconnectedAt: Date.now(), lastError: 'Discord session invalidated' }));
    client.on('shardResume', () => setRuntime(bot.id, { state: 'connected', needsRecovery: false, disconnectedAt: null, lastError: null }));

    // Build a roster baseline for every managed server before Discord login so
    // real joins during Discord startup are not swallowed.
    for (const server of servers) {
      const serverState = rootState.serverStates.get(String(server._managedServerId || 'primary'));
      await pollManagedDynamicBans(server, serverState);
      if (bot.welcomeWhisperEnabled === true) await pollManagedWelcome(server, serverState);
    }
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Discord login timeout')), 20000);
      client.once('clientReady', () => { clearTimeout(timeout); resolve(); });
      client.login(token).catch((error) => { clearTimeout(timeout); reject(error); });
    });
    const freshBeforeRun = getManagedBot(bot.id) || bot;
    if (!freshBeforeRun.enabled || !accessActive(freshBeforeRun)) {
      try { await client.destroy(); } catch {}
      setRuntime(bot.id, { state: accessActive(freshBeforeRun) ? 'stopped' : 'access-expired' });
      return;
    }
    await cleanupLegacySeedingDiscordNickname(freshBeforeRun, client);
    const freshServers = managedServerContexts(freshBeforeRun);
    for (const server of freshServers) {
      const serverState = rootState.serverStates.get(String(server._managedServerId || 'primary')) || serverStateTemplate(server);
      rootState.serverStates.set(String(server._managedServerId || 'primary'), serverState);
      if (!server.controlPanelEnabled && (server.controlPanelMessageId || server.controlPanelMessageChannelId)) await deleteStoredControlPanel(server, client, serverState);
      await cleanupLegacyJoinSeedingServerName(server);
      if (freshBeforeRun.dynamicNameEnabled !== true && server.dynamicNameOriginalName) {
        try { await restoreManagedDynamicServerName(server); }
        catch (error) { setServerRuntime(server, { dynamicNameLastError: String(error?.message || error).slice(0, 300) }); }
      }
    }
    setRuntime(bot.id, { state: 'connected', botTag: client.user?.tag || '', botId: client.user?.id || '', managedServerCount: freshServers.length, lastError: null });
    for (const server of freshServers) {
      const serverState = rootState.serverStates.get(String(server._managedServerId || 'primary'));
      await pollPlayers(server, serverState, client);
      await pollManagedDynamicBans(server, serverState);
      if (freshBeforeRun.welcomeWhisperEnabled === true) await pollManagedWelcome(server, serverState);
    }
    rootState.dynamicTimer = setInterval(() => {
      const fresh = getManagedBot(bot.id);
      if (!fresh?.enabled || !accessActive(fresh)) return;
      for (const server of managedServerContexts(fresh)) {
        const serverState = rootState.serverStates.get(String(server._managedServerId || 'primary')) || serverStateTemplate(server);
        rootState.serverStates.set(String(server._managedServerId || 'primary'), serverState);
        pollManagedDynamicBans(server, serverState).catch(() => {});
        if (fresh.welcomeWhisperEnabled === true) pollManagedWelcome(server, serverState).catch((error) => setServerRuntime(server, { lastWelcomeWhisperError: String(error?.message || error).slice(0, 300) }));
      }
    }, DYNAMIC_BAN_POLL_MS);
    rootState.dynamicTimer.unref?.();
    const timer = setInterval(() => {
      const fresh = getManagedBot(bot.id);
      if (!fresh?.enabled || !accessActive(fresh)) return;
      for (const server of managedServerContexts(fresh)) {
        const serverState = rootState.serverStates.get(String(server._managedServerId || 'primary')) || serverStateTemplate(server);
        rootState.serverStates.set(String(server._managedServerId || 'primary'), serverState);
        pollPlayers(server, serverState, client).catch(() => {});
      }
    }, Math.max(10, Math.min(300, Number(freshBeforeRun.pollSeconds) || 20)) * 1000);
    timer.unref?.();
    instances.set(bot.id, { client, timer, dynamicTimer: rootState.dynamicTimer, signature: signature(freshBeforeRun), state: rootState });
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
      if (fresh && dynamicBans(fresh).length) {
        try { await expireManagedDynamicBans(fresh); } catch (error) { setRuntime(id, { lastDynamicBanWatcherError: String(error?.message || error).slice(0, 300) }); }
        fresh = getManagedBot(id) || fresh;
      }
      if (!fresh || !fresh.enabled || !accessActive(fresh)) {
        if (fresh) {
          for (const server of managedServerContexts(fresh).filter((row) => row.dynamicNameOriginalName)) {
            try { await restoreManagedDynamicServerName(server); }
            catch (error) { setServerRuntime(server, { dynamicNameLastError: String(error?.message || error).slice(0, 300) }); }
          }
          fresh = getManagedBot(id) || fresh;
        }
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
  return withLifecycleLock(id, async () => {
    const fresh = getManagedBot(id);
    for (const server of managedServerContexts(fresh).filter((row) => row.dynamicNameOriginalName)) {
      try { await restoreManagedDynamicServerName(server); }
      catch (error) { setServerRuntime(server, { dynamicNameLastError: String(error?.message || error).slice(0, 300) }); }
    }
    return stopOne(id);
  });
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
