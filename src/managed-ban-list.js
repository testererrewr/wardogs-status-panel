// Normalize the known variants of the WARDOGS ban-list response. An error or
// unknown shape is deliberately NOT interpreted as an empty ban list.
const isObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const extractId = item => String(item?.steamId64 ?? item?.steamID64 ?? item?.steamId ?? item?.steamID ?? item?.SteamID ?? item?.SteamId ?? item?.SteamID64 ?? item?.playerId ?? item?.id ?? '').trim();
const validId = value => /^\d{17}$/.test(String(value || ''));

export function normalizeManagedBans(response) {
  let current = response;
  for (let depth=0; depth<4; depth++) {
    if (Array.isArray(current)) {
      const bans=current.map(item => typeof item === 'string' ? {steamId:item} : item).filter(isObject).map(item => ({
        steamId:extractId(item),
        reason:String(item.reason ?? item.banReason ?? item.message ?? ''),
        bannedBy:String(item.bannedBy ?? item.admin ?? item.createdBy ?? ''),
        bannedAtUtc:String(item.bannedAtUtc ?? item.bannedAt ?? item.createdAt ?? ''),
        expiresAtUtc:String(item.expiresAtUtc ?? item.expiresAt ?? '')
      })).filter(row => validId(row.steamId));
      return { available:current.length===0 || bans.length>0, bans };
    }
    if (!isObject(current)) break;
    const key=['bans','entries','items','results','data','players'].find(k => current[k] !== undefined);
    if (key) { current=current[key]; continue; }
    // Some builds expose the ban map keyed by Steam64 ID.
    const entries=Object.entries(current);
    if (entries.length && entries.every(([id,v])=>validId(id)&&isObject(v))) {
      current=entries.map(([id,record])=>({steamId:id,...record}));continue;
    }
    break;
  }
  return { available:false, bans:[] };
}
