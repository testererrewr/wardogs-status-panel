import fs from 'node:fs';
import path from 'node:path';
import { encryptSecret, decryptSecret } from './crypto.js';

const ROOT = path.resolve('data', 'managed-chat');
function safe(value) { return String(value || '').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 100) || 'unknown'; }
function filePath(botId, serverId) { return path.join(ROOT, safe(botId), `${safe(serverId)}.ndjson`); }
function normalize(row = {}) {
  const at = Number.isFinite(Date.parse(row.at || '')) ? new Date(row.at).toISOString() : new Date().toISOString();
  return {
    id: String(row.id || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`).slice(0, 120),
    at,
    direction: ['in','out'].includes(String(row.direction || '')) ? String(row.direction) : 'in',
    kind: ['chat','broadcast','whisper','faction-whisper'].includes(String(row.kind || '')) ? String(row.kind) : 'chat',
    playerName: String(row.playerName || '').replace(/[\r\n\0]/g, ' ').trim().slice(0, 120),
    steamId: String(row.steamId || '').replace(/[^0-9]/g, '').slice(0, 20),
    channel: String(row.channel || '').replace(/[\r\n\0]/g, ' ').trim().slice(0, 80),
    message: String(row.message || '').replace(/\0/g, '').trim().slice(0, 1000),
    actor: String(row.actor || '').replace(/[\r\n\0]/g, ' ').trim().slice(0, 120),
    rawType: String(row.rawType || '').replace(/[\r\n\0]/g, ' ').trim().slice(0, 80)
  };
}
export function appendManagedChat(botId, serverId, row) {
  const item = normalize(row);
  if (!item.message) return null;
  const target = filePath(botId, serverId || 'primary');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // WARDOGS/proxies may retry the same feed delivery. Avoid duplicating a chat
  // event when its stable event id is already present near the end of history.
  if (item.id && fs.existsSync(target)) {
    try {
      const lines = fs.readFileSync(target, 'utf8').split(/\r?\n/).filter(Boolean).slice(-250);
      for (const line of lines) {
        try {
          const outer = JSON.parse(line);
          const previous = JSON.parse(decryptSecret(outer.data));
          if (String(previous?.id || '') === item.id) return null;
        } catch {}
      }
    } catch {}
  }
  const encrypted = encryptSecret(JSON.stringify(item));
  fs.appendFileSync(target, JSON.stringify({ v: 1, data: encrypted }) + '\n', { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(target, 0o600); } catch {}
  return item;
}
export function readManagedChatPage(botId, serverId, page = 0, pageSize = 50) {
  const target = filePath(botId, serverId || 'primary');
  if (!fs.existsSync(target)) return { rows: [], page: 0, pages: 1, total: 0, pageSize };
  const lines = fs.readFileSync(target, 'utf8').split(/\r?\n/).filter(Boolean);
  const total = lines.length, pages = Math.max(1, Math.ceil(total / pageSize)), safePage = Math.max(0, Math.min(pages - 1, Math.floor(Number(page) || 0)));
  const startFromNewest = safePage * pageSize;
  const selected = lines.slice(Math.max(0, total - startFromNewest - pageSize), total - startFromNewest).reverse();
  const rows = [];
  for (const line of selected) {
    try { const outer = JSON.parse(line); const item = JSON.parse(decryptSecret(outer.data)); rows.push(normalize(item)); } catch {}
  }
  return { rows, page: safePage, pages, total, pageSize };
}
export function extractChatEvents(payload = {}) {
  const rawEvents = Array.isArray(payload?.events) ? payload.events : [];
  const out = [];
  for (const raw of rawEvents.slice(0, 100)) {
    const type = String(raw?.type || raw?.eventType || '').toLowerCase();
    const message = String(raw?.message ?? raw?.text ?? raw?.content ?? raw?.chatMessage ?? '').trim();
    const looksChat = ['chat','chat_message','message','player_chat','playerchat','chatmessage'].includes(type) || (message && !raw?.victimSteamId && !raw?.victimId && (raw?.playerSteamId || raw?.senderSteamId || raw?.steamId || raw?.playerName || raw?.senderName));
    if (!looksChat || !message) continue;
    out.push(normalize({
      id: raw?.eventId || raw?.id,
      at: raw?.timestampUtc || raw?.timestamp || raw?.createdAt || new Date().toISOString(),
      direction: 'in', kind: 'chat',
      playerName: raw?.playerName || raw?.senderName || raw?.name || '',
      steamId: raw?.playerSteamId || raw?.senderSteamId || raw?.steamId || '',
      channel: raw?.channel || raw?.chatChannel || raw?.scope || raw?.team || '',
      message,
      rawType: type
    }));
  }
  return out;
}
