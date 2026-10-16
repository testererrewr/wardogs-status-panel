import crypto from 'node:crypto';

// A server feed may be retried by WARDOGS. Keep an ID repeatable when the
// source has a real game timestamp, without incorrectly merging distinct kills
// that lack both an event ID and a timestamp.
export function stableKillEventId(payload, raw) {
  if (raw?.eventId) return String(raw.eventId);
  if (!Number.isFinite(Number(raw?.eventTime)) || Number(raw.eventTime) <= 0) return crypto.randomUUID();
  const identity = [
    payload?.serverId || '', raw?.matchId || '', raw.eventTime,
    raw?.killerSteamId || '', raw?.victimSteamId || '', raw?.cause || '', raw?.distance || 0,
    Array.isArray(raw?.contextTags) ? raw.contextTags : []
  ];
  return `fallback-${crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 32)}`;
}

export function killEventSeenKey(event) {
  return event?.id ? `${event.serverId || ''}:${event.id}` : '';
}
