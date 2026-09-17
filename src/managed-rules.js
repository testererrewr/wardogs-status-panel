const RISK_TYPES = new Set(['vac_bans','game_bans','playtime','account_age','recent_ban','community_ban','economy_ban','private_profile']);

export function isSteamRiskRule(rule) {
  return RISK_TYPES.has(String(rule?.type || ''));
}

export function managedRulesNeedSteam(rules) {
  return Array.isArray(rules) && rules.some(isSteamRiskRule);
}

export function parseManagedRules(text) {
  const lines = String(text || '').split(/\r?\n/).map((x) => x.trim()).filter((x) => x && !x.startsWith('#'));
  if (lines.length > 100) throw new Error('Maximal 100 Regeln sind erlaubt');
  const rules = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw.length > 300) throw new Error(`Regel ${i + 1} ist zu lang`);
    const [exprRaw, ...reasonParts] = raw.split('|');
    const expr = String(exprRaw || '').trim();
    const reason = reasonParts.join('|').trim().slice(0, 180);
    let match;

    if ((match = expr.match(/^vac(?:_bans?)?\s*>=\s*(\d{1,3})$/i))) {
      const value = Math.max(1, Math.min(100, Number(match[1])));
      rules.push({ type: 'vac_bans', op: '>=', value, reason: reason || `VAC-Bans: mindestens ${value}` });
      continue;
    }
    if ((match = expr.match(/^game(?:_?bans?)?\s*>=\s*(\d{1,3})$/i))) {
      const value = Math.max(1, Math.min(100, Number(match[1])));
      rules.push({ type: 'game_bans', op: '>=', value, reason: reason || `Game-Bans: mindestens ${value}` });
      continue;
    }
    if ((match = expr.match(/^playtime\s*<\s*(\d{1,6}(?:\.\d{1,2})?)$/i))) {
      const value = Math.max(0.1, Math.min(100000, Number(match[1])));
      rules.push({ type: 'playtime', op: '<', value, reason: reason || `Spielzeit unter ${value} Stunden` });
      continue;
    }
    if ((match = expr.match(/^account(?:_?age)?\s*<\s*(\d{1,5})$/i))) {
      const value = Math.max(1, Math.min(36500, Number(match[1])));
      rules.push({ type: 'account_age', op: '<', value, reason: reason || `Steam-Konto jünger als ${value} Tage` });
      continue;
    }
    if ((match = expr.match(/^recent(?:_?ban)?\s*<=?\s*(\d{1,5})$/i))) {
      const value = Math.max(0, Math.min(36500, Number(match[1])));
      rules.push({ type: 'recent_ban', op: '<=', value, reason: reason || `Steam-Ban innerhalb der letzten ${value} Tage` });
      continue;
    }
    if (/^community(?:_?ban)?\s*=\s*(?:1|true|yes|on)$/i.test(expr)) {
      rules.push({ type: 'community_ban', op: '=', value: true, reason: reason || 'Steam Community-Ban aktiv' });
      continue;
    }
    if (/^economy(?:_?ban)?\s*=\s*(?:1|true|yes|on)$/i.test(expr)) {
      rules.push({ type: 'economy_ban', op: '=', value: true, reason: reason || 'Steam Economy-Ban aktiv' });
      continue;
    }
    if (/^private(?:_?profile)?\s*=\s*(?:1|true|yes|on)$/i.test(expr)) {
      rules.push({ type: 'private_profile', op: '=', value: true, reason: reason || 'Steam-Profil ist nicht öffentlich' });
      continue;
    }

    // Legacy rules remain readable so old installations do not break on update.
    if ((match = expr.match(/^steam\s*:\s*(\d{17})$/i))) {
      rules.push({ type: 'steam', value: match[1], reason: reason || `SteamID ${match[1]} ist gesperrt`, legacy: true });
      continue;
    }
    if ((match = expr.match(/^name\s*:\s*(.+)$/i))) {
      const value = match[1].trim();
      if (!value || value.length > 80) throw new Error(`Regel ${i + 1}: Name-Text ist ungültig`);
      rules.push({ type: 'name', value, reason: reason || `Spielername enthält „${value}“`, legacy: true });
      continue;
    }
    if ((match = expr.match(/^faction\s*:\s*(.+)$/i))) {
      const value = match[1].trim();
      if (!value || value.length > 80) throw new Error(`Regel ${i + 1}: Fraktion ist ungültig`);
      rules.push({ type: 'faction', value, reason: reason || `Fraktion entspricht „${value}“`, legacy: true });
      continue;
    }
    if ((match = expr.match(/^ping\s*(>=|>)\s*(\d{1,5})$/i))) {
      const value = Math.max(1, Math.min(99999, Number(match[2])));
      rules.push({ type: 'ping', op: match[1], value, reason: reason || `Ping ${match[1]} ${value} ms`, legacy: true });
      continue;
    }

    throw new Error(`Regel ${i + 1} ist ungültig. Unterstützt: VAC-Bans, Game-Bans, Spielzeit, Kontoalter, letzter Ban, Community-/Economy-Ban, privates Profil.`);
  }
  return rules;
}

export function evaluateManagedRules(player, rules, risk = null) {
  const steamId = String(player?.steamId || player?.steamId64 || '').trim();
  const name = String(player?.name || player?.personaName || '').trim();
  const faction = String(player?.faction || '').trim();
  const ping = Number(player?.pingMs ?? player?.ping);
  const matched = [];
  for (const rule of rules || []) {
    let hit = false;
    if (rule.type === 'vac_bans' && Number.isFinite(Number(risk?.vacBans))) hit = Number(risk.vacBans) >= Number(rule.value);
    else if (rule.type === 'game_bans' && Number.isFinite(Number(risk?.gameBans))) hit = Number(risk.gameBans) >= Number(rule.value);
    else if (rule.type === 'playtime' && Number.isFinite(Number(risk?.playtimeHours))) hit = Number(risk.playtimeHours) < Number(rule.value);
    else if (rule.type === 'account_age' && Number.isFinite(Number(risk?.accountAgeDays))) hit = Number(risk.accountAgeDays) < Number(rule.value);
    else if (rule.type === 'recent_ban' && Number.isFinite(Number(risk?.daysSinceLastBan))) hit = Number(risk.daysSinceLastBan) <= Number(rule.value) && (Number(risk.vacBans) > 0 || Number(risk.gameBans) > 0);
    else if (rule.type === 'community_ban') hit = risk?.communityBanned === true;
    else if (rule.type === 'economy_ban') hit = Boolean(risk?.economyBanned);
    else if (rule.type === 'private_profile') hit = risk?.profilePrivate === true;
    else if (rule.type === 'steam') hit = steamId === rule.value;
    else if (rule.type === 'name') hit = name.toLowerCase().includes(String(rule.value).toLowerCase());
    else if (rule.type === 'faction') hit = faction.toLowerCase() === String(rule.value).toLowerCase();
    else if (rule.type === 'ping' && Number.isFinite(ping)) hit = rule.op === '>=' ? ping >= rule.value : ping > rule.value;
    if (hit) matched.push(rule.reason);
  }
  return [...new Set(matched)].slice(0, 8);
}
