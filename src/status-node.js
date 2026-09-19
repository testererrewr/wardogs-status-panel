import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBots, shutdownBots, runtimeSnapshot, runningBotCount } from './bot-manager.js';

const version = '3.12.39';
const controlUrl = String(process.env.CONTROL_PLANE_URL || '').replace(/\/+$/, '');
const joinSecret = String(process.env.STATUS_NODE_JOIN_SECRET || '');
const nodeId = String(process.env.STATUS_NODE_ID || os.hostname()).trim().slice(0, 80);
const nodeName = String(process.env.STATUS_NODE_NAME || os.hostname()).trim().slice(0, 100);
const capacity = Math.max(1, Math.min(1000, Number(process.env.STATUS_NODE_MAX_BOTS || 50)));
const syncSeconds = Math.max(5, Number(process.env.STATUS_NODE_SYNC_SECONDS || 10));
const tokenFile = path.resolve(process.env.STATUS_NODE_TOKEN_FILE || '/node-data/token');
const allowInsecure = process.env.STATUS_NODE_ALLOW_INSECURE === 'true';

if (!controlUrl) throw new Error('CONTROL_PLANE_URL fehlt');
const parsedControl = new URL(controlUrl);
const localHttp = parsedControl.protocol === 'http:' && ['server-status-hub','localhost','127.0.0.1','::1'].includes(parsedControl.hostname);
if (parsedControl.protocol !== 'https:' && !localHttp && !allowInsecure) {
  throw new Error('Remote Status Nodes benötigen HTTPS. Für Testbetrieb kann STATUS_NODE_ALLOW_INSECURE=true gesetzt werden.');
}

fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
let nodeToken = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
let lastLeaseAt = 0;
let leaseSeconds = 30;
let shuttingDown = false;

async function api(pathname, { method = 'GET', body, auth = true, timeout = 12000 } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth) {
    headers.Authorization = `Bearer ${nodeToken}`;
    headers['X-Status-Node-Id'] = nodeId;
  }
  const response = await fetch(`${controlUrl}${pathname}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout)
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
  if (!response.ok) throw new Error(data.error || data.message || `HTTP ${response.status}`);
  return data;
}

async function ensureRegistered() {
  if (nodeToken) return;
  if (!joinSecret) throw new Error('STATUS_NODE_JOIN_SECRET fehlt für die erste Registrierung');
  const result = await api('/api/status-nodes/register', {
    method: 'POST', auth: false,
    body: { nodeId, name: nodeName, capacity, hostname: os.hostname(), version, joinSecret }
  });
  nodeToken = String(result.token || '');
  if (!nodeToken) throw new Error('Control Plane hat keinen Node Token geliefert');
  fs.writeFileSync(tokenFile, `${nodeToken}\n`, { mode: 0o600 });
  lastLeaseAt = Date.now();
  if (result.leaseSeconds) leaseSeconds = Number(result.leaseSeconds) || leaseSeconds;
  console.log(`Status Node registriert: ${nodeId}`);
}

function metrics() {
  const mem = process.memoryUsage();
  return {
    hostname: os.hostname(), platform: `${os.platform()} ${os.release()}`, cpuCount: os.cpus().length, totalMemMb: Math.round(os.totalmem() / 1024 / 1024), freeMemMb: Math.round(os.freemem() / 1024 / 1024),
    load1: Number(os.loadavg()[0].toFixed(2)), rssMb: Math.round(mem.rss / 1024 / 1024),
    heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024), uptimeSeconds: Math.round(process.uptime()),
    runningBots: runningBotCount(), capacity
  };
}

function dropToken() {
  if (fs.existsSync(tokenFile)) { try { fs.unlinkSync(tokenFile); } catch {} }
  nodeToken = '';
}

async function enforceLease() {
  if (lastLeaseAt && Date.now() - lastLeaseAt > leaseSeconds * 1000) {
    console.error('[status-node] Lease abgelaufen: stoppe alle Status Bots bis die Control Plane wieder erreichbar ist.');
    await shutdownBots();
    lastLeaseAt = 0;
  }
}

async function handleApiError(error) {
  console.error(`[status-node] ${error.message}`);
  if (/Node.*auth|401|403|Ungültig/i.test(error.message)) dropToken();
  await enforceLease();
}

async function heartbeat() {
  if (!nodeToken) return;
  try {
    const result = await api('/api/status-nodes/heartbeat', { method: 'POST', body: { version, metrics: metrics(), runtimes: runtimeSnapshot() } });
    lastLeaseAt = Date.now();
    if (result.leaseSeconds) leaseSeconds = Number(result.leaseSeconds) || leaseSeconds;
  } catch (error) { await handleApiError(error); }
}

async function syncWork() {
  await ensureRegistered();
  const work = await api('/api/status-nodes/work');
  lastLeaseAt = Date.now();
  if (work.leaseSeconds) leaseSeconds = Number(work.leaseSeconds) || leaseSeconds;
  const servers = (Array.isArray(work.servers) ? work.servers.slice(0, capacity) : []).map((server) => ({
    ...server,
    _controlPlaneUrl: controlUrl,
    _statusNodeId: nodeId,
    _statusNodeToken: nodeToken
  }));
  await syncBots(servers);
}

async function restoreBotsAfterStartup() {
  for (let attempt = 1; attempt <= 6 && !shuttingDown; attempt++) {
    try {
      await ensureRegistered();
      await heartbeat();
      await syncWork();
      console.log(`[status-node] Startup restore complete: ${runningBotCount()} bot(s) running`);
      return;
    } catch (error) {
      await handleApiError(error);
      if (attempt < 6) await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

async function loop() {
  await restoreBotsAfterStartup();
  const heartbeatTimer = setInterval(() => { heartbeat().catch((e) => console.error(e)); }, Math.max(5, Math.floor(syncSeconds / 2)) * 1000);
  heartbeatTimer.unref?.();
  while (!shuttingDown) {
    try { await syncWork(); }
    catch (error) { await handleApiError(error); }
    await enforceLease();
    await new Promise((resolve) => setTimeout(resolve, syncSeconds * 1000));
  }
  clearInterval(heartbeatTimer);
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal}: Status Node fährt herunter...`);
  await shutdownBots();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

console.log(`status-hub.lol Node ${version} · ${nodeName} · Kapazität ${capacity}`);
loop().catch((e) => { console.error(e); process.exit(1); });
