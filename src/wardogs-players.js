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

const PLAYER_ID_KEYS = ['steamId','steamId64','steamID','steamID64','playerSteamId','playerId','id'];

export function playerSteamId(player) {
  for (const key of PLAYER_ID_KEYS) {
    const normalized = normalizeSteamId64(player?.[key]);
    if (normalized) return normalized;
  }
  return '';
}

// Some WARDOGS builds/wrappers are stricter about the identifier used in the
// /v1/players/{id}/... path than they are about the value exposed to callers.
// Keep the exact roster identifier available, while playerSteamId() remains the
// canonical SteamID64 used for comparisons and persistence in the panel.
export function playerWardogsApiId(player) {
  const canonical = playerSteamId(player);
  for (const key of PLAYER_ID_KEYS) {
    const raw = String(player?.[key] ?? '').trim();
    if (!raw) continue;
    if (!canonical || normalizeSteamId64(raw) === canonical) return raw;
  }
  return canonical;
}

export function playerFaction(player) {
  // Official WARDOGS uses `faction`; accept a few wrapper aliases as well so a
  // proxy cannot make team-ready players look permanently unassigned.
  const raw = player?.faction ?? player?.team ?? player?.side ?? player?.factionName ?? player?.teamName;
  if (raw && typeof raw === 'object') return String(raw.name ?? raw.label ?? raw.id ?? raw.tag ?? raw.value ?? '').trim();
  return String(raw ?? '').trim();
}

export function normalizeFactionKey(value) {
  let raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return '';
  // Accept both display names ("Valkyra") and tag-like values such as
  // "Faction.Valkyra" / "Id.Faction.Valkyra" that some builds/wrappers emit.
  raw = raw.replace(/^id[.:/_-]+/i, '').replace(/^faction[.:/_-]+/i, '');
  const tail = raw.split(/[.:/\\]+/).filter(Boolean).pop() || raw;
  return tail.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '');
}

export function factionMatches(a, b) {
  const left = normalizeFactionKey(a);
  const right = normalizeFactionKey(b);
  return Boolean(left && right && left === right);
}

export function playerHasFaction(player) {
  const faction = playerFaction(player);
  const key = normalizeFactionKey(faction);
  if (!key) return false;
  return !new Set([
    'none','null','undefined','unassigned','nofaction','noteam','spectator','spectate','spectating','neutral',
    'invalid','invalidfaction','unknown','unset','pending','lobby','prematch','waiting','waitingforteam','teamselect','teamselection','faction'
  ]).has(key);
}

// For welcome delivery, a merely non-empty faction string is not sufficient.
// Some WARDOGS builds briefly expose placeholder/stale faction values while the
// player is still in the team-selection UI. When the server status exposes the
// real faction catalog, only a value matching one of those factions counts as a
// playable team.
export function playerHasPlayableFaction(player, validFactions = []) {
  if (!playerHasFaction(player)) return false;
  const names = Array.isArray(validFactions) ? validFactions.map((x) => String(x || '').trim()).filter(Boolean) : [];
  if (!names.length) return false;
  const faction = playerFaction(player);
  return names.some((name) => factionMatches(faction, name));
}

// Current WARDOGS builds return { players:[...] }, while a few wrappers/mocks
// expose the list directly. Accept both so roster tracking cannot silently turn
// a valid response into an empty player list.
export function wardogsPlayerRows(data) {
  if (Array.isArray(data?.players)) return data.players;
  if (Array.isArray(data)) return data;
  return [];
}
