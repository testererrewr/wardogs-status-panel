import { Client, ActivityType } from 'discord.js';
import { decryptSecret } from './crypto.js';
import { fetchWardogsStatus } from './wardogs.js';

const instances = new Map();
const runtime = new Map();

function setRuntime(id, patch) {
  runtime.set(id, { ...(runtime.get(id) || {}), ...patch, updatedAt: new Date().toISOString() });
}

export function getRuntime(id) {
  return runtime.get(id) || { state: 'stopped' };
}

export function getAllRuntime() {
  return Object.fromEntries(runtime.entries());
}

function render(template, values) {
  return String(template)
    .replaceAll('{players}', String(values.current ?? 0))
    .replaceAll('{max}', String(values.max ?? 0))
    .replaceAll('{server}', String(values.serverName || values.name || 'Server'))
    .replaceAll('{map}', String(values.map || 'Unbekannt'))
    .slice(0, 128);
}

function getOnlineTemplates(server) {
  if (Array.isArray(server.onlineTemplates)) {
    const list = server.onlineTemplates.map((x) => String(x).trim()).filter(Boolean).slice(0, 10);
    if (list.length) return list;
  }
  return [String(server.onlineTemplate || '{players}/{max} Spieler online')];
}

function applyOnlinePresence(server, client, state, advance = false) {
  if (!client.user || !state.latestStatus) return;
  const templates = getOnlineTemplates(server);
  if (advance && templates.length > 1) state.rotationIndex = (state.rotationIndex + 1) % templates.length;
  else state.rotationIndex = Math.min(state.rotationIndex || 0, templates.length - 1);

  const text = render(templates[state.rotationIndex], { ...state.latestStatus, name: server.name });
  client.user.setPresence({
    status: 'online',
    activities: [{ name: text, type: ActivityType.Watching }]
  });
  setRuntime(server.id, { presence: text, rotationIndex: state.rotationIndex + 1, rotationCount: templates.length });
}

function applyOfflinePresence(server, client) {
  const text = String(server.offlineTemplate || 'Server offline').slice(0, 128);
  if (client.user) {
    client.user.setPresence({ status: 'idle', activities: [{ name: text, type: ActivityType.Watching }] });
  }
  setRuntime(server.id, { presence: text, rotationIndex: null, rotationCount: 0 });
}

async function refreshServerStatus(server, client, state) {
  try {
    const status = await fetchWardogsStatus(server.rconUrl, decryptSecret(server.rconPasswordEnc));
    const wasOnline = Boolean(state.latestStatus);
    state.latestStatus = status;
    setRuntime(server.id, {
      state: 'online',
      botTag: client.user?.tag || null,
      botId: client.user?.id || null,
      players: status.current,
      maxPlayers: status.max,
      map: status.map,
      rconServerName: status.serverName,
      lastCheck: new Date().toISOString(),
      lastError: null
    });
    if (!wasOnline) {
      state.rotationIndex = 0;
      applyOnlinePresence(server, client, state, false);
    }
  } catch (error) {
    state.latestStatus = null;
    applyOfflinePresence(server, client);
    setRuntime(server.id, {
      state: 'offline',
      botTag: client.user?.tag || null,
      botId: client.user?.id || null,
      players: null,
      maxPlayers: null,
      map: null,
      lastCheck: new Date().toISOString(),
      lastError: error.message
    });
  }
}

export async function stopServerBot(id) {
  const existing = instances.get(id);
  if (existing) {
    clearInterval(existing.pollTimer);
    clearInterval(existing.rotateTimer);
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
  // Discord permits at most five game-status changes per 20 seconds. Keep a safe floor of 5 seconds.
  const rotateMs = Math.max(5, Number(server.switchSeconds) || 15) * 1000;
  const state = { latestStatus: null, rotationIndex: 0 };
  setRuntime(server.id, { state: 'starting', lastError: null });

  try {
    const token = decryptSecret(server.botTokenEnc);
    client.once('clientReady', async () => {
      setRuntime(server.id, { state: 'connected', botTag: client.user.tag, botId: client.user.id, lastError: null });
      await refreshServerStatus(server, client, state);
    });
    client.on('error', (error) => setRuntime(server.id, { lastError: error.message }));
    await client.login(token);

    const pollTimer = setInterval(() => refreshServerStatus(server, client, state), pollMs);
    const rotateTimer = setInterval(() => {
      if (state.latestStatus) applyOnlinePresence(server, client, state, true);
    }, rotateMs);
    pollTimer.unref?.();
    rotateTimer.unref?.();
    instances.set(server.id, { client, pollTimer, rotateTimer, state });
  } catch (error) {
    try { client.destroy(); } catch {}
    setRuntime(server.id, { state: 'error', lastError: error.message, lastCheck: new Date().toISOString() });
  }
}

export async function syncBots(servers) {
  const wanted = new Set(servers.map((s) => s.id));
  for (const id of [...instances.keys()]) if (!wanted.has(id)) await stopServerBot(id);
  for (const server of servers) {
    if (server.enabled) await startServerBot(server);
    else await stopServerBot(server.id);
  }
}

export async function shutdownBots() {
  for (const id of [...instances.keys()]) await stopServerBot(id);
}
