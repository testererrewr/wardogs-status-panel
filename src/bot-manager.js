import { Client, ActivityType } from 'discord.js';
import { decryptSecret } from './crypto.js';
import { fetchServerStatus } from './server-query.js';

const instances = new Map();
const runtime = new Map();

function serverSignature(server) {
  return JSON.stringify({
    id: server.id, enabled: server.enabled, botTokenEnc: server.botTokenEnc || null, botTokenPlain: server.botTokenPlain || null,
    gameType: server.gameType, queryConfig: server.queryConfig || {}, querySecretEnc: server.querySecretEnc || null, querySecretPlain: server.querySecretPlain || null,
    allowPrivateTarget: Boolean(server.allowPrivateTarget), intervalSeconds: server.intervalSeconds, switchSeconds: server.switchSeconds,
    onlineTemplates: server.onlineTemplates || [], offlineTemplate: server.offlineTemplate || 'Server offline', wardogsSeedingEnabled: Boolean(server.wardogsSeedingEnabled), restartNonce: server.restartNonce || 0, name: server.name
  });
}

function setRuntime(id, patch) {
  runtime.set(id, { ...(runtime.get(id) || {}), ...patch, updatedAt: new Date().toISOString() });
}
export function getRuntime(id) { return runtime.get(id) || { state: 'stopped' }; }

function render(template, values) {
  return String(template)
    .replaceAll('{players}', String(values.current ?? 0))
    .replaceAll('{max}', String(values.max ?? 0))
    .replaceAll('{server}', String(values.serverName || values.name || 'Server'))
    .replaceAll('{map}', String(values.map || 'Unbekannt'))
    .replaceAll('{game}', String(values.game || 'Game'))
    .replaceAll('{ping}', values.ping == null ? '—' : `${values.ping}ms`)
    .slice(0, 128);
}

function templates(server) {
  const list = Array.isArray(server.onlineTemplates) ? server.onlineTemplates.map((x) => String(x).trim()).filter(Boolean).slice(0, 10) : [];
  return list.length ? list : (server.gameType === 'text_only' ? ['status-hub.lol'] : ['{players}/{max} Spieler online', 'Map: {map}']);
}

function onlinePresence(server, client, state, advance = false) {
  if (!client.user || !state.latestStatus) return;
  const list = templates(server);
  if (server.gameType === 'wardogs' && server.wardogsSeedingEnabled && Number(state.latestStatus.current || 0) >= 1 && !list.some((x) => String(x).trim().toLowerCase() === 'seeding')) list.push('Seeding');
  if (advance && list.length > 1) state.rotationIndex = (state.rotationIndex + 1) % list.length;
  const text = render(list[state.rotationIndex || 0], { ...state.latestStatus, name: server.name });
  client.user.setPresence({ status: 'online', activities: [{ name: text, type: ActivityType.Watching }] });
  setRuntime(server.id, { presence: text, rotationIndex: (state.rotationIndex || 0) + 1, rotationCount: list.length });
}

function textOnlyPresence(server, client, state, advance = false) {
  if (!client.user) return;
  const list = templates(server);
  if (advance && list.length > 1) state.rotationIndex = (state.rotationIndex + 1) % list.length;
  const text = String(list[state.rotationIndex || 0] || server.name || 'status-hub.lol').slice(0, 128);
  client.user.setPresence({ status: 'online', activities: [{ name: text, type: ActivityType.Watching }] });
  setRuntime(server.id, { state: 'online', presence: text, rotationIndex: (state.rotationIndex || 0) + 1, rotationCount: list.length, botTag: client.user.tag, botId: client.user.id, players: null, maxPlayers: null, map: null, ping: null, game: 'Text Rotation', lastCheck: null, lastError: null });
}

function offlinePresence(server, client) {
  const text = String(server.offlineTemplate || 'Server offline').slice(0, 128);
  if (client.user) client.user.setPresence({ status: 'idle', activities: [{ name: text, type: ActivityType.Watching }] });
  setRuntime(server.id, { presence: text, rotationIndex: null, rotationCount: 0 });
}

async function refresh(server, client, state) {
  try {
    const status = await fetchServerStatus(server);
    const wasOnline = Boolean(state.latestStatus);
    state.latestStatus = status;
    setRuntime(server.id, {
      state: 'online', botTag: client.user?.tag || null, botId: client.user?.id || null,
      players: status.current, maxPlayers: status.max, map: status.map, ping: status.ping,
      queryServerName: status.serverName, game: status.game, lastCheck: new Date().toISOString(), lastError: null
    });
    if (!wasOnline) { state.rotationIndex = 0; onlinePresence(server, client, state, false); }
  } catch (error) {
    state.latestStatus = null;
    offlinePresence(server, client);
    setRuntime(server.id, {
      state: 'offline', botTag: client.user?.tag || null, botId: client.user?.id || null,
      players: null, maxPlayers: null, map: null, ping: null, lastCheck: new Date().toISOString(), lastError: error.message
    });
  }
}

export async function stopServerBot(id) {
  const existing = instances.get(id);
  if (existing) {
    clearInterval(existing.pollTimer); clearInterval(existing.rotateTimer);
    try { existing.client.destroy(); } catch {}
    instances.delete(id);
  }
  setRuntime(id, { state: 'stopped', lastError: null });
}

export async function startServerBot(server) {
  await stopServerBot(server.id);
  if (!server.enabled) return;
  const client = new Client({ intents: [] });
  const pollMs = Math.max(10, Number(server.intervalSeconds) || 30) * 1000;
  const rotateMs = Math.max(5, Number(server.switchSeconds) || 15) * 1000;
  const state = { latestStatus: null, rotationIndex: 0 };
  setRuntime(server.id, { state: 'starting', lastError: null });
  try {
    const token = typeof server.botTokenPlain === 'string' ? server.botTokenPlain : decryptSecret(server.botTokenEnc);
    client.once('clientReady', async () => {
      setRuntime(server.id, { state: 'connected', botTag: client.user.tag, botId: client.user.id, lastError: null });
      if (server.gameType === 'text_only') textOnlyPresence(server, client, state, false);
      else await refresh(server, client, state);
    });
    client.on('error', (error) => setRuntime(server.id, { lastError: error.message }));
    await client.login(token);
    const pollTimer = server.gameType === 'text_only' ? null : setInterval(() => refresh(server, client, state), pollMs);
    const rotateTimer = setInterval(() => {
      if (server.gameType === 'text_only') textOnlyPresence(server, client, state, true);
      else if (state.latestStatus) onlinePresence(server, client, state, true);
    }, rotateMs);
    pollTimer?.unref?.(); rotateTimer.unref?.();
    instances.set(server.id, { client, pollTimer, rotateTimer, state, signature: serverSignature(server) });
  } catch (error) {
    try { client.destroy(); } catch {}
    setRuntime(server.id, { state: 'error', lastError: error.message, lastCheck: new Date().toISOString() });
  }
}

export async function syncBots(servers) {
  const wanted = new Set(servers.filter((s) => s.enabled).map((s) => s.id));
  for (const id of [...instances.keys()]) if (!wanted.has(id)) { await stopServerBot(id); runtime.delete(id); }
  for (const id of [...runtime.keys()]) if (!wanted.has(id)) runtime.delete(id);
  const changes = [];
  for (const server of servers) {
    if (!server.enabled) { await stopServerBot(server.id); continue; }
    const existing = instances.get(server.id);
    const sig = serverSignature(server);
    if (!existing || existing.signature !== sig) changes.push(server);
  }
  const concurrency = Math.max(1, Math.min(20, Number(process.env.STATUS_NODE_START_CONCURRENCY || 8)));
  for (let i = 0; i < changes.length; i += concurrency) {
    await Promise.all(changes.slice(i, i + concurrency).map((server) => startServerBot(server)));
  }
}
export async function shutdownBots() { for (const id of [...instances.keys()]) await stopServerBot(id); }
export function runtimeSnapshot() { return Object.fromEntries([...runtime.entries()]); }
export function runningBotCount() { return instances.size; }
