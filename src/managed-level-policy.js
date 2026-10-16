// WARDOGS ServerMaxPlayerLevel=0 means no level restriction.
export const LEVEL_CAP_WAIT_MS = 30 * 60_000;
export function levelCapDecision(previous = {}, playerCount, now = Date.now(), enabled = false) {
  const state = { lowSince: Number(previous.lowSince) || 0, capped: previous.capped === true };
  if (!enabled) return { ...state, lowSince: 0, action: state.capped ? 'restore' : null };
  if (!Number.isInteger(playerCount) || playerCount < 0) return { ...state, lowSince: 0, action: null };
  if (playerCount < 20) {
    if (!state.lowSince) state.lowSince = now;
    return { ...state, action: !state.capped && now - state.lowSince >= LEVEL_CAP_WAIT_MS ? 'cap' : null };
  }
  state.lowSince = 0;
  return { ...state, action: state.capped && playerCount >= 25 ? 'uncap' : null };
}
export function configMaxPlayerLevel(text) {
  const section = String(text || '').match(/(?:^|\r?\n)\s*\[\/Script\/WDGame\.WDGameSession\]([^]*?)(?=\r?\n\s*\[|$)/i);
  const key = section?.[1]?.match(/(?:^|\r?\n)\s*ServerMaxPlayerLevel\s*=\s*(\d+)/i);
  return key ? Number(key[1]) : 0;
}
export function patchMaxPlayerLevel(text, level) {
  if (!Number.isInteger(level) || level < 0 || level > 600) throw new Error('Unsupported max level');
  const source = String(text || '');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  let begin = lines.findIndex(x => /^\s*\[\/Script\/WDGame\.WDGameSession\]\s*$/i.test(x));
  if (begin < 0) { lines.push('[/Script/WDGame.WDGameSession]'); begin = lines.length - 1; }
  let end = lines.findIndex((x, i) => i > begin && /^\s*\[.*\]\s*$/.test(x));
  if (end < 0) end = lines.length;
  for (let i = begin + 1; i < end; i++) {
    if (/^\s*ServerMaxPlayerLevel\s*=/i.test(lines[i])) { lines[i] = lines[i].replace(/^(\s*ServerMaxPlayerLevel\s*=).*$/, `$1${level}`); return lines.join(newline); }
  }
  lines.splice(begin + 1, 0, `ServerMaxPlayerLevel=${level}`);
  return lines.join(newline);
}
