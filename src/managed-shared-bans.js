import { managedServerContexts } from './managed-servers.js';

// Shared ban scope is one Management Bot (never all bots owned by an account).
// Records are an authoritative intent for bans issued by this management bot.
const validId = value => /^\d{17}$/.test(String(value || ''));
export function sharedServerBanRows(bot) {
  const rows = Array.isArray(bot?.sharedServerBans) ? bot.sharedServerBans : [];
  const result = new Map();
  for (const entry of rows) {
    if (!validId(entry?.steamId)) continue;
    const mode = entry.mode === 'temporary' ? 'temporary' : 'permanent';
    if (mode === 'temporary' && !(Date.parse(entry.expiresAt || '') > Date.now())) continue;
    result.set(String(entry.steamId), {
      steamId: String(entry.steamId), reason: String(entry.reason || '').slice(0, 180), mode,
      expiresAt: mode === 'temporary' ? entry.expiresAt : null,
      createdAt: entry.createdAt || null
    });
  }
  return [...result.values()].slice(-5000);
}
export function mergeSharedServerBans(bot, entries) {
  const merged = new Map(sharedServerBanRows(bot).map(row => [row.steamId, row]));
  for (const entry of entries || []) {
    if (!validId(entry?.steamId)) continue;
    const mode = entry.mode === 'temporary' ? 'temporary' : 'permanent';
    if (mode === 'temporary' && !(Date.parse(entry.expiresAt || '') > Date.now())) continue;
    const old = merged.get(String(entry.steamId));
    // An already permanent shared ban is not reduced by an unrelated temporary one.
    if (old?.mode === 'permanent' && mode === 'temporary') continue;
    merged.set(String(entry.steamId), {
      steamId: String(entry.steamId), reason: String(entry.reason || old?.reason || '').slice(0, 180),
      mode, expiresAt: mode === 'temporary' ? entry.expiresAt : null,
      createdAt: entry.createdAt || old?.createdAt || new Date().toISOString()
    });
  }
  return [...merged.values()].slice(-5000);
}
export function removeSharedServerBan(bot, steamId) {
  return sharedServerBanRows(bot).filter(row => row.steamId !== String(steamId));
}
export function combinedManagedBanList(liveBans, bot) {
  const merged = new Map();
  for (const row of sharedServerBanRows(bot)) merged.set(row.steamId, {
    steamId: row.steamId, reason: row.reason, bannedBy: 'Management Bot · alle Server',
    bannedAtUtc: row.createdAt, expiresAtUtc: row.expiresAt || '', shared: true
  });
  for (const row of Array.isArray(liveBans) ? liveBans : []) {
    if (!validId(row?.steamId)) continue;
    const current = merged.get(String(row.steamId));
    merged.set(String(row.steamId), { ...row, shared: Boolean(current),
      reason: row.reason || current?.reason || '',
      bannedAtUtc: row.bannedAtUtc || current?.bannedAtUtc || '',
      bannedBy: row.bannedBy || current?.bannedBy || '',
      expiresAtUtc: current?.expiresAtUtc || row.expiresAtUtc || ''
    });
  }
  return [...merged.values()].sort((a,b)=>a.steamId.localeCompare(b.steamId));
}

export function sharedBanActionTargets(bot) { return managedServerContexts(bot); }
