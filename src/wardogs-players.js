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

export function playerSteamId(player) {
  for (const key of ['steamId64','steamId','steamID64','steamID','playerSteamId','playerId','id']) {
    const normalized = normalizeSteamId64(player?.[key]);
    if (normalized) return normalized;
  }
  return '';
}

export function playerFaction(player) {
  const raw = player?.faction;
  if (raw && typeof raw === 'object') return String(raw.name ?? raw.label ?? raw.id ?? '').trim();
  return String(raw ?? '').trim();
}

// Current WARDOGS builds return { players:[...] }, while a few wrappers/mocks
// expose the list directly. Accept both so roster tracking cannot silently turn
// a valid response into an empty player list.
export function wardogsPlayerRows(data) {
  if (Array.isArray(data?.players)) return data.players;
  if (Array.isArray(data)) return data;
  return [];
}
