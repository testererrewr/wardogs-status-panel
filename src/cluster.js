import crypto from 'node:crypto';
import { readDb, updateDb, getStatusNode, upsertStatusNode } from './db.js';
import { decryptSecret } from './crypto.js';
import { effectivePlan, isServerEntitled, brandedTemplates } from './plans.js';
import { newNodeToken, hashNodeToken, safeTokenEqual } from './status-node-auth.js';

const deadSeconds = Math.max(20, Number(process.env.STATUS_NODE_DEAD_SECONDS || 45));
const minFreeMb = Math.max(0, Number(process.env.STATUS_NODE_MIN_FREE_MB || 150));
export const leaseSeconds = Math.max(15, Math.min(deadSeconds - 5, Number(process.env.STATUS_NODE_LEASE_SECONDS || 30)));

export function nodeIsHealthy(node, now = Date.now()) {
  if (!node || node.disabled) return false;
  const t = Date.parse(node.lastSeenAt || '');
  return Number.isFinite(t) && now - t < deadSeconds * 1000;
}

export function registerStatusNode({ nodeId, name, capacity, version, hostname, joinSecret }) {
  const expected = String(process.env.STATUS_NODE_JOIN_SECRET || '');
  const supplied = String(joinSecret || '');
  if (!expected || !supplied || expected.length !== supplied.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))) throw new Error('Invalid node join secret');
  const id = String(nodeId || crypto.randomUUID()).trim().slice(0, 80) || crypto.randomUUID();
  const existing = getStatusNode(id);
  const token = newNodeToken();
  upsertStatusNode({
    id,
    name: String(name || hostname || id).slice(0, 100),
    hostname: String(hostname || '').slice(0, 120),
    capacity: Math.max(1, Math.min(1000, Number(capacity) || 50)),
    version: String(version || '').slice(0, 40),
    tokenHash: hashNodeToken(token),
    disabled: existing?.disabled || false,
    acceptNewBots: existing?.acceptNewBots !== false,
    lastSeenAt: new Date().toISOString(),
    registeredAt: existing?.registeredAt || new Date().toISOString(),
    runtimes: {},
    metrics: {}
  });
  return { id, token };
}

export function authenticateStatusNode(id, token) {
  const node = getStatusNode(String(id || ''));
  if (!node || !safeTokenEqual(token, node.tokenHash)) return null;
  return node;
}

export function heartbeatStatusNode(node, payload = {}) {
  const runtimes = payload.runtimes && typeof payload.runtimes === 'object' ? payload.runtimes : {};
  const metrics = payload.metrics && typeof payload.metrics === 'object' ? payload.metrics : {};
  const updated = upsertStatusNode({ id: node.id, lastSeenAt: new Date().toISOString(), runtimes, metrics, version: String(payload.version || node.version || '').slice(0, 40) });
  // Persist the fixed Discord killfeed message IDs reported by Status Nodes.
  // That lets a bot restart without creating a second panel in the channel.
  updateDb((db) => {
    for (const [serverId, rt] of Object.entries(runtimes)) {
      const server = db.servers.find((row) => row.id === serverId && row.assignedNodeId === node.id);
      if (!server || server.gameType !== 'wardogs') continue;
      const messageId = /^\d{17,20}$/.test(String(rt?.killFeedMessageId || '')) ? String(rt.killFeedMessageId) : '';
      if (messageId && messageId !== String(server.killFeedMessageId || '')) server.killFeedMessageId = messageId;
      if (rt?.killFeedLastPublishedAt) server.killFeedLastPublishedAt = String(rt.killFeedLastPublishedAt);
    }
  });
  return updated;
}

export function rebalanceAssignments() {
  const now = Date.now();
  return updateDb((db) => {
    if (!Array.isArray(db.statusNodes)) db.statusNodes = [];
    if (!Array.isArray(db.managedBots)) db.managedBots = [];
    if (!Array.isArray(db.customBots)) db.customBots = [];
    const healthy = db.statusNodes.filter((n) => nodeIsHealthy(n, now));
    const capacities = new Map(healthy.map((n) => [n.id, Math.max(1, Number(n.capacity) || 1)]));
    const load = new Map(healthy.map((n) => [n.id, 0]));
    const managedActive = (b) => Boolean(b?.enabled) && (Boolean(b?.adminGrant) || (Number.isFinite(Date.parse(b?.accessUntil || '')) && Date.parse(b.accessUntil) > now));
    const customActive = (b) => Boolean(b?.enabled) && String(b?.approvalState || '') === 'approved';
    const work = [
      ...db.servers.map((item) => ({ item, kind: 'status', eligible: Boolean(item.enabled) && isServerEntitled(item, db, now) })),
      ...db.managedBots.map((item) => ({ item, kind: 'managed', eligible: managedActive(item) })),
      ...db.customBots.map((item) => ({ item, kind: 'custom', eligible: customActive(item) }))
    ];

    for (const entry of work) {
      const item = entry.item;
      if (!entry.eligible) { item.assignedNodeId = null; continue; }
      if (item.assignedNodeId && capacities.has(item.assignedNodeId)) {
        const current = load.get(item.assignedNodeId) || 0;
        if (current < capacities.get(item.assignedNodeId)) load.set(item.assignedNodeId, current + 1);
        else item.assignedNodeId = null;
      } else item.assignedNodeId = null;
    }

    for (const entry of work) {
      const item = entry.item;
      if (!entry.eligible || item.assignedNodeId) continue;
      const candidates = healthy.filter((n) => {
        const hasCapacity = (load.get(n.id) || 0) < capacities.get(n.id);
        const free = Number(n.metrics?.freeMemMb);
        const hasMemory = !Number.isFinite(free) || free >= minFreeMb;
        return n.acceptNewBots !== false && hasCapacity && hasMemory;
      });
      candidates.sort((a, b) => ((load.get(a.id) || 0) / capacities.get(a.id)) - ((load.get(b.id) || 0) / capacities.get(b.id)) || String(a.id).localeCompare(String(b.id)));
      const node = candidates[0];
      if (node) { item.assignedNodeId = node.id; load.set(node.id, (load.get(node.id) || 0) + 1); }
    }
    return {
      healthy: healthy.length,
      assigned: work.filter((x) => x.item.assignedNodeId).length,
      status: db.servers.filter((x) => x.assignedNodeId).length,
      managed: db.managedBots.filter((x) => x.assignedNodeId).length,
      custom: db.customBots.filter((x) => x.assignedNodeId).length
    };
  });
}

function validateTarget(db, targetNodeId, excludeServerIds = []) {
  const now = Date.now();
  const target = db.statusNodes.find((n) => n.id === targetNodeId);
  if (!target) throw new Error('Target node not found');
  if (!nodeIsHealthy(target, now)) throw new Error('Target node is offline or disabled');
  const excluded = new Set(excludeServerIds);
  const capacity = Math.max(1, Number(target.capacity) || 1);
  const assigned = [...db.servers, ...(db.managedBots || []), ...(db.customBots || [])].filter((s) => s.assignedNodeId === target.id && !excluded.has(s.id)).length;
  const free = Number(target.metrics?.freeMemMb);
  if (Number.isFinite(free) && free < minFreeMb) throw new Error(`Target node has less than ${minFreeMb} MB free RAM`);
  return { target, capacity, assigned };
}

export function moveServerToNode(serverId, targetNodeId) {
  return updateDb((db) => {
    const server = db.servers.find((s) => s.id === serverId);
    if (!server) throw new Error('Status bot not found');
    const { target, capacity, assigned } = validateTarget(db, targetNodeId, [server.id]);
    if (assigned >= capacity) throw new Error('Target node has no free bot capacity');
    const fromNodeId = server.assignedNodeId || null;
    server.assignedNodeId = target.id;
    server.lastManualMoveAt = new Date().toISOString();
    return { serverId: server.id, fromNodeId, toNodeId: target.id };
  });
}

export function moveAllFromNode(sourceNodeId, targetNodeId) {
  return updateDb((db) => {
    if (sourceNodeId === targetNodeId) throw new Error('Source and target node are identical');
    const bots = [...db.servers, ...(db.managedBots || []), ...(db.customBots || [])].filter((s) => s.assignedNodeId === sourceNodeId);
    const { target, capacity, assigned } = validateTarget(db, targetNodeId, bots.map((s) => s.id));
    if (assigned + bots.length > capacity) throw new Error('Target node does not have enough capacity for all bots');
    for (const bot of bots) {
      bot.assignedNodeId = target.id;
      bot.lastManualMoveAt = new Date().toISOString();
    }
    return { moved: bots.length, sourceNodeId, targetNodeId: target.id };
  });
}

export function restartAllBotsOnNode(nodeId) {
  return updateDb((db) => {
    const node = db.statusNodes.find((n) => n.id === nodeId);
    if (!node) throw new Error('Node not found');
    const now = Date.now();
    let restarted = 0;
    for (const bot of [...db.servers, ...(db.managedBots || []), ...(db.customBots || [])]) {
      if (bot.assignedNodeId === nodeId && bot.enabled) {
        bot.restartNonce = now + restarted;
        bot.updatedAt = new Date(now).toISOString();
        restarted += 1;
      }
    }
    return { nodeId, restarted };
  });
}

export function drainStatusNode(nodeId) {
  const result = updateDb((db) => {
    const node = db.statusNodes.find((n) => n.id === nodeId);
    if (!node) throw new Error('Node not found');
    node.acceptNewBots = false;
    let released = 0;
    for (const bot of [...db.servers, ...(db.managedBots || []), ...(db.customBots || [])]) {
      if (bot.assignedNodeId === nodeId) { bot.assignedNodeId = null; released += 1; }
    }
    return { nodeId, released };
  });
  rebalanceAssignments();
  return result;
}

export function nodeAssignmentSummary() {
  const db = readDb();
  return (db.statusNodes || []).map((node) => ({ ...node, healthy: nodeIsHealthy(node), assigned: [...db.servers, ...(db.managedBots || []), ...(db.customBots || [])].filter((s) => s.assignedNodeId === node.id).length }));
}

export function materializeWorkForNode(nodeId) {
  rebalanceAssignments();
  const db = readDb();
  const serviceDomain = String(db.siteSettings?.serviceDomain || process.env.SERVICE_DOMAIN || 'status-hub.lol').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  return db.servers.filter((s) => s.enabled && s.assignedNodeId === nodeId && isServerEntitled(s, db)).map((s) => {
    const owner = db.users.find((u) => u.discordId === s.ownerDiscordId);
    const plan = effectivePlan(owner);
    const offline = String(s.offlineTemplate || 'Server offline');
    const domain = String(serviceDomain).slice(0, 100);
    const brandedOffline = plan.branded && domain ? `${offline.slice(0, Math.max(0, 112 - domain.length))} · Powered by ${domain}`.slice(0, 128) : offline.slice(0, 128);
    return {
      ...s,
      botTokenEnc: null,
      querySecretEnc: null,
      botTokenPlain: decryptSecret(s.botTokenEnc),
      querySecretPlain: s.querySecretEnc ? decryptSecret(s.querySecretEnc) : '',
      onlineTemplates: brandedTemplates(s, owner, serviceDomain),
      offlineTemplate: brandedOffline,
      plan: plan.id
    };
  });
}

export function clusterRuntime(serverId) {
  const db = readDb();
  const server = db.servers.find((s) => s.id === serverId);
  if (server?.enabled && !isServerEntitled(server, db)) return { state: 'plan-paused', lastError: 'This bot is currently above the account plan limit.' };
  if (!server?.assignedNodeId) return { state: server?.enabled ? 'waiting-node' : 'stopped' };
  const node = db.statusNodes.find((n) => n.id === server.assignedNodeId);
  if (!nodeIsHealthy(node)) return { state: 'node-offline', nodeId: server.assignedNodeId };
  return { ...(node?.runtimes?.[serverId] || { state: 'assigned' }), nodeId: server.assignedNodeId, nodeName: node?.name || server.assignedNodeId };
}
