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
    if ((match = expr.match(/^steam\s*:\s*(\d{17})$/i))) {
      rules.push({ type: 'steam', value: match[1], reason: reason || `SteamID ${match[1]} ist gesperrt` });
      continue;
    }
    if ((match = expr.match(/^name\s*:\s*(.+)$/i))) {
      const value = match[1].trim();
      if (!value || value.length > 80) throw new Error(`Regel ${i + 1}: Name-Text ist ungültig`);
      rules.push({ type: 'name', value, reason: reason || `Spielername enthält „${value}“` });
      continue;
    }
    if ((match = expr.match(/^faction\s*:\s*(.+)$/i))) {
      const value = match[1].trim();
      if (!value || value.length > 80) throw new Error(`Regel ${i + 1}: Fraktion ist ungültig`);
      rules.push({ type: 'faction', value, reason: reason || `Fraktion entspricht „${value}“` });
      continue;
    }
    if ((match = expr.match(/^ping\s*(>=|>)\s*(\d{1,5})$/i))) {
      const value = Math.max(1, Math.min(99999, Number(match[2])));
      rules.push({ type: 'ping', op: match[1], value, reason: reason || `Ping ${match[1]} ${value} ms` });
      continue;
    }
    throw new Error(`Regel ${i + 1} ist ungültig. Erlaubt: steam:ID, name:Text, faction:Text, ping>150`);
  }
  return rules;
}

export function evaluateManagedRules(player, rules) {
  const steamId = String(player?.steamId || player?.steamId64 || '').trim();
  const name = String(player?.name || player?.personaName || '').trim();
  const faction = String(player?.faction || '').trim();
  const ping = Number(player?.pingMs ?? player?.ping);
  const matched = [];
  for (const rule of rules || []) {
    let hit = false;
    if (rule.type === 'steam') hit = steamId === rule.value;
    else if (rule.type === 'name') hit = name.toLowerCase().includes(String(rule.value).toLowerCase());
    else if (rule.type === 'faction') hit = faction.toLowerCase() === String(rule.value).toLowerCase();
    else if (rule.type === 'ping' && Number.isFinite(ping)) hit = rule.op === '>=' ? ping >= rule.value : ping > rule.value;
    if (hit) matched.push(rule.reason);
  }
  return [...new Set(matched)].slice(0, 8);
}
