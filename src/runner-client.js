import { decryptSecret } from './crypto.js';

const base = String(process.env.RUNNER_URL || 'http://runner:4000').replace(/\/+$/, '');
const secret = process.env.RUNNER_SHARED_SECRET || '';

async function call(path, body = {}, timeoutMs = 10000) {
  if (!secret) throw new Error('RUNNER_SHARED_SECRET fehlt');
  const response = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Runner-Secret': secret },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Runner HTTP ${response.status}`);
  return data;
}
function envFor(bot) {
  if (!bot.envEnc) return {};
  const raw = decryptSecret(bot.envEnc);
  try { return JSON.parse(raw); } catch { throw new Error('Custom-Bot ENV konnte nicht entschlüsselt werden'); }
}
export function ensureCustomBot(bot) { return call('/ensure', { id: bot.id, env: envFor(bot) }, 190000); }
export function restartCustomBot(bot) { return call('/restart', { id: bot.id, env: envFor(bot) }, 190000); }
export function stopCustomBot(bot) { return call('/stop', { id: bot.id }, 30000); }
export function deleteCustomBotRuntime(bot) { return call('/delete', { id: bot.id }, 45000); }
export function customBotStatus(bot) { return call('/status', { id: bot.id }, 7000); }
export function customBotLogs(bot) { const env = envFor(bot); return call('/logs', { id: bot.id, redact: Object.values(env).map(String).filter((x) => x.length >= 6).slice(0, 50) }, 15000); }
