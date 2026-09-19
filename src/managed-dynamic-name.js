const MAX_DYNAMIC_SERVER_NAME = 96;

export function cleanDynamicServerName(value, fallback = '') {
  const clean = String(value ?? '').replace(/[\r\n\0\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ').replace(/\s+/g, ' ').trim();
  const out = clean || String(fallback ?? '').replace(/[\r\n\0]/g, ' ').trim();
  return out.slice(0, MAX_DYNAMIC_SERVER_NAME);
}

export function dynamicNameContext(status = {}, { base = '', playerCount } = {}) {
  const scores = Array.isArray(status?.factionScores) ? status.factionScores : [];
  const current = Number.isFinite(Number(playerCount)) ? Number(playerCount) : Number(status?.players?.current || 0);
  const max = Number.isFinite(Number(status?.players?.max)) ? Number(status.players.max) : 0;
  const ctx = {
    base: cleanDynamicServerName(base || status?.serverName || ''),
    server: cleanDynamicServerName(status?.serverName || base || ''),
    players: String(Math.max(0, Math.floor(current || 0))),
    max: String(Math.max(0, Math.floor(max || 0))),
    map: String(status?.map || '').trim(),
    scores: scores.slice(0, 6).map((row) => `${String(row?.name || 'Team').trim()} ${Number.isFinite(Number(row?.score)) ? Number(row.score) : '—'}`).join(' | ')
  };
  for (let i = 0; i < 6; i += 1) {
    const row = scores[i] || {};
    ctx[`team${i + 1}`] = String(row?.name || '').trim();
    ctx[`score${i + 1}`] = Number.isFinite(Number(row?.score)) ? String(Number(row.score)) : '—';
  }
  return ctx;
}

export function renderDynamicNameTemplate(template, context = {}, fallback = '') {
  const text = String(template || '');
  const rendered = text.replace(/\{([a-z0-9_]+)\}/gi, (match, key) => {
    const value = context[String(key).toLowerCase()];
    return value === undefined || value === null ? match : String(value);
  });
  return cleanDynamicServerName(rendered, fallback);
}

export function desiredDynamicServerName(bot = {}, status = {}, state = {}, nowMs = Date.now(), playerCount) {
  const original = cleanDynamicServerName(bot?.dynamicNameOriginalName || status?.serverName || 'WARDOGS Server');
  const players = Number.isFinite(Number(playerCount)) ? Number(playerCount) : Number(status?.players?.current || 0);
  let base = original;

  if (bot?.dynamicNameRotationEnabled === true) {
    const a = cleanDynamicServerName(bot?.dynamicNameRotationNameA || original, original);
    const b = cleanDynamicServerName(bot?.dynamicNameRotationNameB || original, original);
    const minutes = Math.max(1, Math.min(1440, Math.floor(Number(bot?.dynamicNameRotationMinutes) || 5)));
    const start = Number(state?.dynamicNameRotationStartedAt || nowMs);
    const slot = Math.floor(Math.max(0, nowMs - start) / (minutes * 60_000));
    const rotationTemplate = slot % 2 === 0 ? a : b;
    base = renderDynamicNameTemplate(rotationTemplate, dynamicNameContext(status, { base: original, playerCount: players }), original);
  }

  let desired = base;
  if (bot?.dynamicNameStatsEnabled === true) {
    const statsTemplate = String(bot?.dynamicNameStatsTemplate || '{base} | {score1} | {score2} | {score3}');
    desired = renderDynamicNameTemplate(statsTemplate, dynamicNameContext(status, { base, playerCount: players }), base);
  }

  if (bot?.dynamicNameSeedingEnabled === true) {
    const minRaw = Number(bot?.dynamicNameSeedingMinPlayers);
    const min = Math.max(1, Math.min(512, Math.floor(Number.isFinite(minRaw) ? minRaw : 1)));
    const max = Math.max(min, Math.min(512, Math.floor(Number(bot?.dynamicNameSeedingMaxPlayers) || 20)));
    if (players >= min && players <= max) {
      const seedTemplate = String(bot?.dynamicNameSeedingTemplate || 'JOIN SEEDING');
      desired = renderDynamicNameTemplate(seedTemplate, dynamicNameContext(status, { base, playerCount: players }), 'JOIN SEEDING');
    }
  }

  return cleanDynamicServerName(desired, original);
}
