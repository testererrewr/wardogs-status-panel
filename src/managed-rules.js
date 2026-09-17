const RISK_TYPES = new Set(['vac_bans','game_bans','playtime','account_age','recent_ban','community_ban','economy_ban','private_profile']);
const RULE_ACTIONS = new Set(['alert','kick','ban','tempban']);

export function isSteamRiskRule(rule) {
  return RISK_TYPES.has(String(rule?.type || ''));
}

export function managedRulesNeedSteam(rules) {
  return Array.isArray(rules) && rules.some(isSteamRiskRule);
}

function parseRuleMeta(parts = []) {
  const reasonParts = [];
  let action = '';
  let durationMinutes = 0;
  for (const raw of parts) {
    const part = String(raw || '').trim();
    let match;
    if ((match = part.match(/^@action\s*=\s*(alert|kick|ban|tempban)$/i))) {
      action = String(match[1]).toLowerCase();
      continue;
    }
    if ((match = part.match(/^@duration\s*=\s*(\d{1,7})$/i))) {
      durationMinutes = Math.max(1, Math.min(525600, Math.floor(Number(match[1]) || 0)));
      continue;
    }
    if (part) reasonParts.push(part);
  }
  if (action && !RULE_ACTIONS.has(action)) action = '';
  if (action !== 'tempban') durationMinutes = 0;
  if (action === 'tempban' && !durationMinutes) durationMinutes = 1440;
  return { reason: reasonParts.join(' | ').trim().slice(0, 180), action: action || null, durationMinutes };
}

function withMeta(rule, meta) {
  return { ...rule, action: meta.action, durationMinutes: meta.durationMinutes || 0 };
}

export function parseManagedRules(text) {
  const lines = String(text || '').split(/\r?\n/).map((x) => x.trim()).filter((x) => x && !x.startsWith('#'));
  if (lines.length > 100) throw new Error('Maximal 100 Regeln sind erlaubt');
  const rules = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw.length > 500) throw new Error(`Regel ${i + 1} ist zu lang`);
    const [exprRaw, ...parts] = raw.split('|');
    const expr = String(exprRaw || '').trim();
    const meta = parseRuleMeta(parts);
    const reason = meta.reason;
    let match;

    if ((match = expr.match(/^vac(?:_bans?)?\s*>=\s*(\d{1,3})$/i))) {
      const value = Math.max(1, Math.min(100, Number(match[1])));
      rules.push(withMeta({ type: 'vac_bans', op: '>=', value, reason: reason || `VAC bans: at least ${value}` }, meta)); continue;
    }
    if ((match = expr.match(/^game(?:_?bans?)?\s*>=\s*(\d{1,3})$/i))) {
      const value = Math.max(1, Math.min(100, Number(match[1])));
      rules.push(withMeta({ type: 'game_bans', op: '>=', value, reason: reason || `Game bans: at least ${value}` }, meta)); continue;
    }
    if ((match = expr.match(/^playtime\s*<\s*(\d{1,6}(?:\.\d{1,2})?)$/i))) {
      const value = Math.max(0.1, Math.min(100000, Number(match[1])));
      rules.push(withMeta({ type: 'playtime', op: '<', value, reason: reason || `Playtime below ${value} hours` }, meta)); continue;
    }
    if ((match = expr.match(/^account(?:_?age)?\s*<\s*(\d{1,5})$/i))) {
      const value = Math.max(1, Math.min(36500, Number(match[1])));
      rules.push(withMeta({ type: 'account_age', op: '<', value, reason: reason || `Steam account younger than ${value} days` }, meta)); continue;
    }
    if ((match = expr.match(/^recent(?:_?ban)?\s*<=?\s*(\d{1,5})$/i))) {
      const value = Math.max(0, Math.min(36500, Number(match[1])));
      rules.push(withMeta({ type: 'recent_ban', op: '<=', value, reason: reason || `Steam ban within the last ${value} days` }, meta)); continue;
    }
    if (/^community(?:_?ban)?\s*=\s*(?:1|true|yes|on)$/i.test(expr)) {
      rules.push(withMeta({ type: 'community_ban', op: '=', value: true, reason: reason || 'Steam Community ban active' }, meta)); continue;
    }
    if (/^economy(?:_?ban)?\s*=\s*(?:1|true|yes|on)$/i.test(expr)) {
      rules.push(withMeta({ type: 'economy_ban', op: '=', value: true, reason: reason || 'Steam Economy ban active' }, meta)); continue;
    }
    if (/^private(?:_?profile)?\s*=\s*(?:1|true|yes|on)$/i.test(expr)) {
      rules.push(withMeta({ type: 'private_profile', op: '=', value: true, reason: reason || 'Steam profile is not public' }, meta)); continue;
    }

    if ((match = expr.match(/^steam\s*:\s*(\d{17})$/i))) {
      rules.push(withMeta({ type: 'steam', value: match[1], reason: reason || `SteamID ${match[1]} is blocked`, legacy: true }, meta)); continue;
    }
    if ((match = expr.match(/^name\s*:\s*(.+)$/i))) {
      const value = match[1].trim();
      if (!value || value.length > 80) throw new Error(`Regel ${i + 1}: Name-Text ist ungültig`);
      rules.push(withMeta({ type: 'name', value, reason: reason || `Player name contains "${value}"`, legacy: true }, meta)); continue;
    }
    if ((match = expr.match(/^faction\s*:\s*(.+)$/i))) {
      const value = match[1].trim();
      if (!value || value.length > 80) throw new Error(`Regel ${i + 1}: Fraktion ist ungültig`);
      rules.push(withMeta({ type: 'faction', value, reason: reason || `Faction equals "${value}"`, legacy: true }, meta)); continue;
    }
    if ((match = expr.match(/^ping\s*(>=|>)\s*(\d{1,5})$/i))) {
      const value = Math.max(1, Math.min(99999, Number(match[2])));
      rules.push(withMeta({ type: 'ping', op: match[1], value, reason: reason || `Ping ${match[1]} ${value} ms`, legacy: true }, meta)); continue;
    }
    throw new Error(`Regel ${i + 1} ist ungültig. Unterstützt: VAC-Bans, Game-Bans, Spielzeit, Kontoalter, letzter Ban, Community-/Economy-Ban, privates Profil.`);
  }
  return rules;
}

export function matchManagedRules(player, rules, risk = null) {
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
    if (hit) matched.push(rule);
  }
  return matched.slice(0, 8);
}

export function evaluateManagedRules(player, rules, risk = null) {
  return [...new Set(matchManagedRules(player, rules, risk).map((rule) => rule.reason))].slice(0, 8);
}
