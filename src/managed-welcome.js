import { normalizeFactionKey, normalizeSteamId64, playerFaction, playerHasPlayableFaction, playerSteamId } from './wardogs-players.js';

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

function ensureWelcomeState(state) {
  if (!(state.welcomePending instanceof Set)) state.welcomePending = new Set();
  if (!(state.welcomeDelivered instanceof Set)) state.welcomeDelivered = new Set();
  if (!(state.welcomeFailed instanceof Set)) state.welcomeFailed = new Set();
  if (!(state.welcomeAttempts instanceof Map)) state.welcomeAttempts = new Map();
  if (!(state.welcomeReadyAt instanceof Map)) state.welcomeReadyAt = new Map();
  if (!(state.welcomeInitialFactionKey instanceof Map)) state.welcomeInitialFactionKey = new Map();
  if (!(state.welcomeSawPreTeam instanceof Set)) state.welcomeSawPreTeam = new Set();
  if (!(state.welcomeTeamChoiceConfirmed instanceof Set)) state.welcomeTeamChoiceConfirmed = new Set();
  if (!(state.welcomeFactionStableKey instanceof Map)) state.welcomeFactionStableKey = new Map();
  if (!(state.welcomeFactionStablePolls instanceof Map)) state.welcomeFactionStablePolls = new Map();
}

function clearWelcomeSessionState(state, id) {
  state.welcomePending?.delete?.(id);
  state.welcomeDelivered?.delete?.(id);
  state.welcomeFailed?.delete?.(id);
  state.welcomeAttempts?.delete?.(id);
  state.welcomeReadyAt?.delete?.(id);
  state.welcomeInitialFactionKey?.delete?.(id);
  state.welcomeSawPreTeam?.delete?.(id);
  state.welcomeTeamChoiceConfirmed?.delete?.(id);
  state.welcomeFactionStableKey?.delete?.(id);
  state.welcomeFactionStablePolls?.delete?.(id);
}

// A welcome must follow an observed team-selection transition, not merely a
// non-empty faction value. Some WARDOGS builds can expose a placeholder or stale
// faction as soon as the connection enters /v1/players. We therefore remember
// the join-time value and require one of these post-join signals:
//   1) the player was observed without a playable faction and later gets one, or
//   2) the playable faction changes after the join snapshot.
// The chosen faction must also match /v1/status.factionScores and remain stable
// for multiple polls before a short spawn-settle delay begins. This is independent
// of match state, so it works during seeding / Waiting for Players too.
export function managedWelcomeTargets(state, players, joinedPlayers, {
  spawnSettleMs = 5_000,
  teamStablePolls = 2,
  maxAttempts = 24,
  validFactions = [],
  nowMs = Date.now()
} = {}) {
  ensureWelcomeState(state);
  const tracker = state.welcomeJoinTracker || state.joinTracker;
  const activeIds = tracker?.active instanceof Set ? tracker.active : new Set();

  // Only clear a session after the join tracker has confirmed the player absent.
  const knownIds = new Set([
    ...state.welcomePending, ...state.welcomeDelivered, ...state.welcomeFailed,
    ...state.welcomeAttempts.keys(), ...state.welcomeReadyAt.keys(),
    ...state.welcomeInitialFactionKey.keys(), ...state.welcomeSawPreTeam,
    ...state.welcomeTeamChoiceConfirmed, ...state.welcomeFactionStableKey.keys(),
    ...state.welcomeFactionStablePolls.keys()
  ]);
  for (const id of knownIds) if (!activeIds.has(id)) clearWelcomeSessionState(state, id);

  for (const player of Array.isArray(joinedPlayers) ? joinedPlayers : []) {
    const steamId = playerSteamId(player);
    if (!steamId) continue;
    clearWelcomeSessionState(state, steamId);
    state.welcomePending.add(steamId);
    const initialKey = normalizeFactionKey(playerFaction(player));
    state.welcomeInitialFactionKey.set(steamId, initialKey);
    if (!playerHasPlayableFaction(player, validFactions)) state.welcomeSawPreTeam.add(steamId);
  }

  const bySteamId = new Map((Array.isArray(players) ? players : []).map((player) => [playerSteamId(player), player]).filter(([id]) => id));
  const targets = [];
  const requiredStablePolls = Math.max(2, Math.min(6, Number(teamStablePolls) || 2));

  for (const steamId of [...state.welcomePending]) {
    const player = bySteamId.get(steamId);
    if (!player || state.welcomeDelivered.has(steamId) || state.welcomeFailed.has(steamId)) continue;

    const playable = playerHasPlayableFaction(player, validFactions);
    const currentKey = normalizeFactionKey(playerFaction(player));
    if (!playable) {
      // Seeing the player in the menu is the strongest signal that a later valid
      // faction really came from their team choice. Any previous readiness is reset.
      state.welcomeSawPreTeam.add(steamId);
      state.welcomeTeamChoiceConfirmed.delete(steamId);
      state.welcomeFactionStableKey.delete(steamId);
      state.welcomeFactionStablePolls.delete(steamId);
      state.welcomeReadyAt.delete(steamId);
      continue;
    }

    if (!state.welcomeTeamChoiceConfirmed.has(steamId)) {
      const initialKey = String(state.welcomeInitialFactionKey.get(steamId) || '');
      const sawPreTeam = state.welcomeSawPreTeam.has(steamId);
      const changedAfterJoin = Boolean(initialKey && currentKey && initialKey !== currentKey);
      if (!sawPreTeam && !changedAfterJoin) {
        // Do NOT treat a faction that was already present in the join snapshot as
        // proof of team selection. This was the cause of premature welcomes.
        continue;
      }
      state.welcomeTeamChoiceConfirmed.add(steamId);
      state.welcomeFactionStableKey.delete(steamId);
      state.welcomeFactionStablePolls.delete(steamId);
      state.welcomeReadyAt.delete(steamId);
    }

    const previousKey = String(state.welcomeFactionStableKey.get(steamId) || '');
    let stablePolls = Number(state.welcomeFactionStablePolls.get(steamId) || 0);
    if (previousKey === currentKey) stablePolls += 1;
    else {
      stablePolls = 1;
      state.welcomeFactionStableKey.set(steamId, currentKey);
      state.welcomeReadyAt.delete(steamId);
    }
    state.welcomeFactionStablePolls.set(steamId, stablePolls);
    if (stablePolls < requiredStablePolls) continue;

    let readyAt = Number(state.welcomeReadyAt.get(steamId) || 0);
    if (!readyAt) {
      readyAt = Number(nowMs) + Math.max(0, Number(spawnSettleMs) || 0);
      state.welcomeReadyAt.set(steamId, readyAt);
    }
    if (readyAt > Number(nowMs)) continue;
    if (Number(state.welcomeAttempts.get(steamId) || 0) >= Number(maxAttempts || 24)) continue;
    targets.push({ ...player, steamId });
  }
  return targets;
}

export function managedWelcomeSucceeded(state, steamId) {
  const id = normalizeSteamId64(steamId);
  if (!id) return;
  ensureWelcomeState(state);
  state.welcomePending.delete(id);
  state.welcomeAttempts.delete(id);
  state.welcomeReadyAt.delete(id);
  state.welcomeInitialFactionKey.delete(id);
  state.welcomeSawPreTeam.delete(id);
  state.welcomeTeamChoiceConfirmed.delete(id);
  state.welcomeFactionStableKey.delete(id);
  state.welcomeFactionStablePolls.delete(id);
  state.welcomeDelivered.add(id);
}

export function managedWelcomeFailed(state, steamId, { retryable = true, maxAttempts = 24 } = {}) {
  const id = normalizeSteamId64(steamId);
  if (!id) return { retry: false, attempts: 0 };
  ensureWelcomeState(state);
  const attempts = Number(state.welcomeAttempts.get(id) || 0) + 1;
  state.welcomeAttempts.set(id, attempts);
  const retry = Boolean(retryable) && attempts < Number(maxAttempts || 24);
  if (!retry) {
    state.welcomePending.delete(id);
    state.welcomeReadyAt.delete(id);
    state.welcomeInitialFactionKey.delete(id);
    state.welcomeSawPreTeam.delete(id);
    state.welcomeTeamChoiceConfirmed.delete(id);
    state.welcomeFactionStableKey.delete(id);
    state.welcomeFactionStablePolls.delete(id);
    state.welcomeFailed.add(id);
  }
  return { retry, attempts };
}
