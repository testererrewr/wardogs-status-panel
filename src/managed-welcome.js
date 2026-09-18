import { normalizeSteamId64, playerFaction, playerSteamId } from './wardogs-players.js';

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

export function createManagedJoinTracker() {
  return { initialized: false, active: new Set(), missing: new Map() };
}

// The first successful snapshot is a baseline. Afterwards a player becomes a
// join candidate when it appears after a confirmed absence. missingThreshold
// deliberately requires consecutive successful snapshots so one incomplete
// WARDOGS roster response cannot manufacture a leave/rejoin cycle.
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

export function managedWelcomeTargets(state, players, joinedPlayers, { joinDelayMs = 30_000, maxAttempts = 24, nowMs = Date.now() } = {}) {
  if (!(state.welcomePending instanceof Set)) state.welcomePending = new Set();
  if (!(state.welcomeDelivered instanceof Set)) state.welcomeDelivered = new Set();
  if (!(state.welcomeFailed instanceof Set)) state.welcomeFailed = new Set();
  if (!(state.welcomeAttempts instanceof Map)) state.welcomeAttempts = new Map();
  if (!(state.welcomeReadyAt instanceof Map)) state.welcomeReadyAt = new Map();
  const tracker = state.welcomeJoinTracker || state.joinTracker;
  const activeIds = tracker?.active instanceof Set ? tracker.active : new Set();

  // Only clear a session after the join tracker has confirmed the player absent.
  // With a >=2 snapshot leave threshold this keeps a queued 30-second welcome
  // alive across a single incomplete/empty /v1/players response.
  for (const id of [...state.welcomePending]) if (!activeIds.has(id)) state.welcomePending.delete(id);
  for (const id of [...state.welcomeDelivered]) if (!activeIds.has(id)) state.welcomeDelivered.delete(id);
  for (const id of [...state.welcomeFailed]) if (!activeIds.has(id)) state.welcomeFailed.delete(id);
  for (const id of [...state.welcomeAttempts.keys()]) if (!activeIds.has(id)) state.welcomeAttempts.delete(id);
  for (const id of [...state.welcomeReadyAt.keys()]) if (!activeIds.has(id)) state.welcomeReadyAt.delete(id);

  for (const player of Array.isArray(joinedPlayers) ? joinedPlayers : []) {
    const steamId = playerSteamId(player);
    if (!steamId) continue;
    state.welcomeDelivered.delete(steamId);
    state.welcomeFailed.delete(steamId);
    state.welcomeAttempts.delete(steamId);
    state.welcomeReadyAt.set(steamId, Number(nowMs) + Math.max(0, Number(joinDelayMs) || 0));
    state.welcomePending.add(steamId);
  }

  const bySteamId = new Map((Array.isArray(players) ? players : []).map((player) => [playerSteamId(player), player]).filter(([id]) => id));
  const targets = [];
  for (const steamId of [...state.welcomePending]) {
    const player = bySteamId.get(steamId);
    if (!player || state.welcomeDelivered.has(steamId) || state.welcomeFailed.has(steamId)) continue;
    const readyAt = Number(state.welcomeReadyAt.get(steamId) || 0);
    if (readyAt > Number(nowMs)) continue;
    if (Number(state.welcomeAttempts.get(steamId) || 0) >= Number(maxAttempts || 24)) continue;
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
  if (!(state.welcomeReadyAt instanceof Map)) state.welcomeReadyAt = new Map();
  state.welcomePending.delete(id);
  state.welcomeAttempts.delete(id);
  state.welcomeReadyAt.delete(id);
  state.welcomeDelivered.add(id);
}

export function managedWelcomeFailed(state, steamId, { retryable = true, maxAttempts = 24 } = {}) {
  const id = normalizeSteamId64(steamId);
  if (!id) return { retry: false, attempts: 0 };
  if (!(state.welcomePending instanceof Set)) state.welcomePending = new Set();
  if (!(state.welcomeFailed instanceof Set)) state.welcomeFailed = new Set();
  if (!(state.welcomeAttempts instanceof Map)) state.welcomeAttempts = new Map();
  if (!(state.welcomeReadyAt instanceof Map)) state.welcomeReadyAt = new Map();
  const attempts = Number(state.welcomeAttempts.get(id) || 0) + 1;
  state.welcomeAttempts.set(id, attempts);
  const retry = Boolean(retryable) && attempts < Number(maxAttempts || 24);
  if (!retry) {
    state.welcomePending.delete(id);
    state.welcomeReadyAt.delete(id);
    state.welcomeFailed.add(id);
  }
  return { retry, attempts };
}
