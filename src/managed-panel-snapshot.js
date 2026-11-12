import { wardogsPlayerRows, wardogsReportedPlayerCount } from './wardogs-players.js';

function label(value, fallback = '—') {
  const raw = value && typeof value === 'object' ? (value.name ?? value.label ?? value.id ?? '') : value;
  const clean = String(raw ?? '').trim();
  return clean && clean !== '[object Object]' ? clean : fallback;
}

export function managementPanelSummary(status, roster, serverLabel = 'WARDOGS') {
  const rows = roster === null || roster === undefined ? null : wardogsPlayerRows(roster);
  const canCount = status && (
    status.players?.current !== undefined || status.playerCount !== undefined || status.playersOnline !== undefined
  );
  const count = canCount || (rows && rows.length > 0) ? wardogsReportedPlayerCount(status, roster) : null;
  const limitRaw = status?.players?.max ?? status?.maxPlayers ?? status?.playerLimit;
  const max = Number(limitRaw);
  const capacity = limitRaw !== undefined && limitRaw !== null && limitRaw !== '' && Number.isFinite(max) && max > 0 ? String(max) : '—';
  const scoreRows = Array.isArray(status?.factionScores) ? status.factionScores : [];
  const scores = scoreRows.slice(0, 6).map(row => {
    const n = Number(row?.score);
    return `${label(row?.name, 'Team')}: ${Number.isFinite(n) ? n : '—'}`;
  }).join(' · ');
  return {
    server: label(status?.serverName, serverLabel),
    map: label(status?.map),
    players: `${count === null ? 'Lädt …' : (!canCount ? `${count} gelistet` : count)} / ${capacity}`,
    scores: scores || '—',
    hasStatus: Boolean(status),
    actionablePlayers: rows?.length ?? null
  };
}
