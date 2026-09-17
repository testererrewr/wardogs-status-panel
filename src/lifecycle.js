import { updateDb, upsertUser } from './db.js';

export const FREE_RENEW_DAYS = 14;
export const GRACE_DAYS = 7;
const DAY = 86400_000;

function iso(ms) { return new Date(ms).toISOString(); }
function time(value) { const t = Date.parse(value || ''); return Number.isFinite(t) ? t : NaN; }
function activePremium(user, now = Date.now()) {
  if (!user || user.role === 'admin' || (user.planId || 'free') === 'free') return false;
  const expires = time(user.planExpiresAt);
  return !Number.isFinite(expires) || expires > now;
}
function runtimeState(db, server) {
  const node = db.statusNodes.find((n) => n.id === server.assignedNodeId);
  return String(node?.runtimes?.[server.id]?.state || '');
}
function keepScore(db, server) {
  const state = runtimeState(db, server);
  const online = ['online','connected','starting','assigned'].includes(state) ? 100 : 0;
  return online + (server.enabled ? 10 : 0);
}
function orderedServers(db, discordId) {
  return db.servers.filter((s) => s.ownerDiscordId === discordId).sort((a,b) => keepScore(db,b)-keepScore(db,a) || String(a.createdAt||'').localeCompare(String(b.createdAt||'')) || String(a.id).localeCompare(String(b.id)));
}

export function freeRenewState(user, now = Date.now()) {
  if (!user || user.role === 'admin' || user.freeRenewExempt || activePremium(user, now)) return { required: false, exempt: Boolean(user?.freeRenewExempt), dueAt: null, deleteAt: null };
  const renewed = time(user.freeRenewedAt);
  const base = Number.isFinite(renewed) ? renewed : now;
  const due = base + FREE_RENEW_DAYS * DAY;
  const graceStart = time(user.freeRenewGraceStartedAt);
  return { required: now >= due, exempt: false, dueAt: iso(due), deleteAt: Number.isFinite(graceStart) ? iso(graceStart + GRACE_DAYS * DAY) : null };
}

export function renewFreeAccess(discordId) {
  const now = new Date().toISOString();
  return upsertUser({ discordId, freeRenewedAt: now, freeRenewGraceStartedAt: null });
}

export function runLifecycleSweep(now = Date.now()) {
  return updateDb((db) => {
    const result = { premiumGraceStarted: 0, premiumDeleted: 0, renewGraceStarted: 0, renewDeleted: 0 };
    for (const user of db.users) {
      if (user.role === 'admin') continue;
      const rawPlan = String(user.planId || 'free');
      const expiry = time(user.planExpiresAt);
      const premiumExpired = rawPlan !== 'free' && Number.isFinite(expiry) && expiry <= now;
      const premiumLive = rawPlan !== 'free' && (!Number.isFinite(expiry) || expiry > now);
      let premiumGraceUntil = time(user.premiumDowngradeUntil);

      if (premiumLive) {
        user.premiumDowngradeStartedAt = null;
        user.premiumDowngradeUntil = null;
        user.premiumDowngradeKeepServerId = null;
        user.freeRenewGraceStartedAt = null;
        continue;
      }

      if (premiumExpired && !Number.isFinite(premiumGraceUntil)) {
        const owned = orderedServers(db, user.discordId);
        const keep = owned[0] || null;
        if (keep) keep.enabled = true;
        user.premiumDowngradeStartedAt = iso(now);
        user.premiumDowngradeUntil = iso(now + GRACE_DAYS * DAY);
        user.premiumDowngradeKeepServerId = keep?.id || null;
        premiumGraceUntil = now + GRACE_DAYS * DAY;
        result.premiumGraceStarted += 1;
      }

      if (Number.isFinite(premiumGraceUntil)) {
        if (premiumGraceUntil <= now) {
          const owned = orderedServers(db, user.discordId);
          const keepId = user.premiumDowngradeKeepServerId && owned.some((s) => s.id === user.premiumDowngradeKeepServerId) ? user.premiumDowngradeKeepServerId : owned[0]?.id;
          const remove = new Set(owned.filter((s) => s.id !== keepId).map((s) => s.id));
          result.premiumDeleted += remove.size;
          db.servers = db.servers.filter((s) => !remove.has(s.id));
          const keep = db.servers.find((s) => s.id === keepId);
          if (keep) keep.enabled = true;
          user.planId = 'free';
          user.planExpiresAt = null;
          user.premiumSource = null;
          user.premiumDowngradeStartedAt = null;
          user.premiumDowngradeUntil = null;
          user.premiumDowngradeKeepServerId = null;
          user.freeRenewedAt = iso(now);
          user.freeRenewGraceStartedAt = null;
        }
        continue;
      }

      if (rawPlan === 'free' && !user.freeRenewExempt) {
        const renewed = time(user.freeRenewedAt);
        const due = (Number.isFinite(renewed) ? renewed : now) + FREE_RENEW_DAYS * DAY;
        if (now >= due) {
          if (!user.freeRenewGraceStartedAt) {
            user.freeRenewGraceStartedAt = iso(now);
            result.renewGraceStarted += 1;
          }
          const deleteAt = time(user.freeRenewGraceStartedAt) + GRACE_DAYS * DAY;
          if (Number.isFinite(deleteAt) && deleteAt <= now) {
            const before = db.servers.length;
            db.servers = db.servers.filter((s) => s.ownerDiscordId !== user.discordId);
            result.renewDeleted += before - db.servers.length;
          }
        } else if (user.freeRenewGraceStartedAt) user.freeRenewGraceStartedAt = null;
      } else if (user.freeRenewExempt) user.freeRenewGraceStartedAt = null;
    }
    return result;
  });
}

export function markPremiumDowngrade(discordId) {
  return updateDb((db) => {
    const user = db.users.find((u) => u.discordId === discordId);
    if (!user || user.role === 'admin') return null;
    const owned = orderedServers(db, discordId);
    const keep = owned[0] || null;
    if (keep) keep.enabled = true;
    const now = Date.now();
    user.premiumDowngradeStartedAt = iso(now);
    user.premiumDowngradeUntil = iso(now + GRACE_DAYS * DAY);
    user.premiumDowngradeKeepServerId = keep?.id || null;
    user.updatedAt = iso(now);
    return { discordId, keepServerId: keep?.id || null, until: user.premiumDowngradeUntil };
  });
}
