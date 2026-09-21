import { GameDig } from 'gamedig';
import { gameDigMeta, gameDigFieldDefs } from './game-catalog.js';
import { decryptSecret } from './crypto.js';
import { resolveSafeHost, safeHttpText } from './target-safety.js';

function baseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function secretValue(server) {
  if (typeof server.querySecretPlain === 'string') return server.querySecretPlain;
  return decryptSecret(server.querySecretEnc);
}

function num(value, fallback = NaN) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}


async function jsonLimited(response, maxBytes = 1024 * 1024) {
  if (!response.body) return response.json();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { try { await reader.cancel(); } catch {} throw new Error('HTTP JSON Antwort ist größer als 1 MB'); }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(joined));
}

function getPath(obj, path) {
  const parts = String(path || '').split('.').map((x) => x.trim()).filter(Boolean);
  let cur = obj;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object' || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

async function safeJson(url, options = {}, allowPrivate = false, timeoutMs = 7000) {
  const result = await safeHttpText(url, {
    allowPrivate, method: options.method || 'GET', headers: { Accept: 'application/json', ...(options.headers || {}) },
    body: options.body, timeoutMs, maxBytes: 1024 * 1024
  });
  if (result.status >= 300 && result.status < 400) throw new Error('HTTP Redirects sind aus Sicherheitsgründen nicht erlaubt');
  if (!result.ok) {
    const error = new Error(`HTTP ${result.status}${result.text ? `: ${result.text.slice(0, 180)}` : ''}`);
    error.status = result.status;
    throw error;
  }
  return JSON.parse(result.text || '{}');
}



async function queryWardogs(server) {
  const cfg = server.queryConfig || {};
  const url = `${baseUrl(cfg.baseUrl)}/v1/status`;
  const secret = secretValue(server);
  const data = await safeJson(url, { headers: { Authorization: `Bearer ${secret}` } }, Boolean(server.allowPrivateTarget));
  const current = num(data?.players?.current);
  const max = num(data?.players?.max);
  if (!Number.isFinite(current) || !Number.isFinite(max)) throw new Error('WARDOGS-Antwort enthält keine gültige Spielerzahl');
  const factionScores = Array.isArray(data?.factionScores)
    ? data.factionScores.map((item) => ({ name: String(item?.name || '').trim(), score: num(item?.score, 0) })).filter((item) => item.name)
    : [];
  const first = factionScores[0] || { name: '', score: 0 };
  const second = factionScores[1] || { name: '', score: 0 };
  const score = factionScores.length === 2
    ? `${first.name} ${first.score} – ${second.score} ${second.name}`
    : factionScores.length ? factionScores.map((item) => `${item.name} ${item.score}`).join(' · ') : '';
  return {
    current, max, map: data.map || '', serverName: data.serverName || '', ping: null, game: 'WARDOGS',
    factionScores, score, team1: first.name, score1: first.score, team2: second.name, score2: second.score
  };
}

async function queryFiveM(server) {
  const cfg = server.queryConfig || {};
  const base = baseUrl(cfg.baseUrl);
  const [dynamic, players] = await Promise.all([
    safeJson(`${base}/dynamic.json`, {}, Boolean(server.allowPrivateTarget)),
    safeJson(`${base}/players.json`, {}, Boolean(server.allowPrivateTarget)).catch(() => [])
  ]);
  const current = num(dynamic?.clients, Array.isArray(players) ? players.length : NaN);
  const max = num(dynamic?.sv_maxclients);
  if (!Number.isFinite(current) || !Number.isFinite(max)) throw new Error('FiveM dynamic.json enthält keine gültige Spielerzahl');
  return {
    current,
    max,
    map: dynamic?.mapname || dynamic?.gametype || '',
    serverName: dynamic?.hostname || '',
    ping: null,
    game: 'FiveM'
  };
}

async function queryGameDig(server) {
  const cfg = server.queryConfig || {};
  const host = String(cfg.host || '').trim();
  const gameId = String(cfg.gameId || '').trim();
  const meta = gameDigMeta(gameId);
  if (!gameId || !meta) throw new Error('Ungültiges oder nicht unterstütztes GameDig-Spiel');
  if (meta.hostMode === 'required' && !host) throw new Error(`${meta.name}: Host / IP fehlt`);
  const resolvedHost = host ? await resolveSafeHost(host, { allowPrivate: Boolean(server.allowPrivateTarget) }) : [];

  const query = {
    type: gameId,
    maxRetries: 0,
    socketTimeout: Math.min(5000, Math.max(1000, Number(cfg.socketTimeout) || 2500)),
    attemptTimeout: Math.min(10000, Math.max(2000, Number(cfg.attemptTimeout) || 6000))
  };
  if (host) query.host = (resolvedHost.find((x) => x.family === 4) || resolvedHost[0]).address;
  if (cfg.port) query.port = Number(cfg.port);

  const defs = gameDigFieldDefs(gameId);
  const nonSecret = cfg.extraOptions && typeof cfg.extraOptions === 'object' ? cfg.extraOptions : {};
  let secret = {};
  const secretRaw = secretValue(server);
  if (secretRaw) {
    try { secret = JSON.parse(secretRaw); } catch { secret = {}; }
  }
  for (const field of defs) {
    const source = field.secret ? secret : nonSecret;
    let value = source[field.key];
    if (value === '' || value == null || value === false) continue;
    if (field.type === 'number') value = Number(value);
    if (field.type === 'checkbox') value = Boolean(value);
    query[field.key] = value;
  }

  if (meta.hostMode === 'optional' && !host && !query.serverId) throw new Error(`${meta.name}: Host / IP oder Server ID fehlt`);
  const state = await GameDig.query(query);
  return {
    current: num(state.numplayers, Array.isArray(state.players) ? state.players.length : 0),
    max: num(state.maxplayers, 0),
    map: state.map || '',
    serverName: state.name || '',
    ping: Number.isFinite(Number(state.ping)) ? Number(state.ping) : null,
    game: meta.name || gameId
  };
}

async function queryGenericJson(server) {
  const cfg = server.queryConfig || {};
  const headers = {};
  const token = secretValue(server);
  if (token) headers.Authorization = `Bearer ${token}`;
  const data = await safeJson(cfg.url, { headers }, Boolean(server.allowPrivateTarget));
  const current = num(getPath(data, cfg.currentPath || 'players.current'));
  const max = num(getPath(data, cfg.maxPath || 'players.max'));
  if (!Number.isFinite(current) || !Number.isFinite(max)) throw new Error('JSON-Pfade für Spieler/Max liefern keine Zahlen');
  return {
    current,
    max,
    map: String(getPath(data, cfg.mapPath || 'map') ?? ''),
    serverName: String(getPath(data, cfg.namePath || 'serverName') ?? ''),
    ping: null,
    game: String(cfg.label || 'JSON')
  };
}

export async function fetchServerStatus(server) {
  switch (server.gameType) {
    case 'wardogs': return queryWardogs(server);
    case 'fivem': return queryFiveM(server);
    case 'gamedig': return queryGameDig(server);
    case 'generic_json': return queryGenericJson(server);
    default: throw new Error(`Unbekannter Servertyp: ${server.gameType || 'leer'}`);
  }
}

export function gameTypeLabel(type) {
  return ({ wardogs: 'WARDOGS', fivem: 'FiveM', gamedig: 'GameDig', generic_json: 'Generic JSON API', text_only: 'Text Rotation' })[type] || type;
}
