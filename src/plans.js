export const PLANS = Object.freeze({
  free: { id: 'free', label: 'Free', statusBotLimit: 1, branded: true },
  premium5: { id: 'premium5', label: 'Premium 5', statusBotLimit: 5, branded: false },
  premium10: { id: 'premium10', label: 'Premium 10', statusBotLimit: 10, branded: false },
  premium15: { id: 'premium15', label: 'Premium 15', statusBotLimit: 15, branded: false },
  premium20: { id: 'premium20', label: 'Premium 20', statusBotLimit: 20, branded: false }
});

export function planById(id) { return PLANS[id] || PLANS.free; }

function validBoostLimit(user, now) {
  const boost = user?.freeBoost;
  const until = Date.parse(boost?.validUntil || '');
  if (boost?.state !== 'verified' || !Number.isFinite(until) || until <= now) return 1;
  return Math.min(5, Math.max(1, Number(boost.freeBotLimit || 1)));
}

export function effectivePlan(user, now = Date.now()) {
  if (user?.role === 'admin') return { id: 'admin', label: 'Admin', statusBotLimit: Infinity, branded: false, expiresAt: null, expired: false, freeBoostLimit: 1, renewalRequired: false, premiumGrace: false };
  if (!user) return { ...PLANS.free, expiresAt: null, expired: false, freeBoostLimit: 1, renewalRequired: false, premiumGrace: false };
  const configured = planById(user.planId || 'free');
  const expiresAt = user.planExpiresAt ? Date.parse(user.planExpiresAt) : NaN;
  const expired = configured.id !== 'free' && Number.isFinite(expiresAt) && expiresAt <= now;
  const graceUntil = Date.parse(user.premiumDowngradeUntil || '');
  const premiumGrace = expired || (Number.isFinite(graceUntil) && graceUntil > now);
  let raw = expired ? PLANS.free : configured;
  const boostLimit = raw.id === 'free' && !premiumGrace ? validBoostLimit(user, now) : 1;
  let statusBotLimit = premiumGrace ? 1 : (raw.id === 'free' ? Math.max(raw.statusBotLimit, boostLimit) : raw.statusBotLimit);
  const renewedAt = Date.parse(user.freeRenewedAt || '');
  const renewalRequired = raw.id === 'free' && !premiumGrace && !user.freeRenewExempt && Number.isFinite(renewedAt) && now >= renewedAt + 14 * 86400_000;
  const hasOverride = user.statusBotLimitOverride !== null && user.statusBotLimitOverride !== undefined && String(user.statusBotLimitOverride).trim() !== '';
  const override = hasOverride ? Number(user.statusBotLimitOverride) : NaN;
  if (!renewalRequired && !premiumGrace && Number.isFinite(override) && override >= 0) statusBotLimit = override;
  if (renewalRequired) statusBotLimit = 0;
  return {
    ...raw,
    label: premiumGrace ? 'Free · 7 day grace' : raw.id === 'free' && boostLimit > 1 ? `Free + Boost (${boostLimit})` : raw.label,
    statusBotLimit,
    expiresAt: user.planExpiresAt || null,
    expired,
    freeBoostLimit: boostLimit,
    renewalRequired,
    premiumGrace
  };
}

export function isServerEntitled(server, db, now = Date.now()) {
  const owner = db.users.find((u) => u.discordId === server.ownerDiscordId);
  if (owner?.role === 'admin') return true;
  const plan = effectivePlan(owner, now);
  if (plan.premiumGrace && owner?.premiumDowngradeKeepServerId) return server.id === owner.premiumDowngradeKeepServerId;
  const limit = plan.statusBotLimit;
  const owned = db.servers.filter((s) => s.ownerDiscordId === server.ownerDiscordId).sort((a, b) => Number(Boolean(b.enabled)) - Number(Boolean(a.enabled)) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.id).localeCompare(String(b.id)));
  const index = owned.findIndex((s) => s.id === server.id);
  return index >= 0 && index < limit;
}

export function brandedTemplates(server, owner, serviceDomain) {
  const list = Array.isArray(server.onlineTemplates) && server.onlineTemplates.length ? server.onlineTemplates.map((x) => String(x).trim()).filter(Boolean).slice(0, 10) : ['{players}/{max} Players online', 'Map: {map}'];
  const plan = effectivePlan(owner);
  if (!plan.branded || !serviceDomain) return list;
  const brand = String(serviceDomain).replace(/^https?:\/\//i, '').replace(/\/+$/, '').slice(0, 100);
  return [...list.slice(0, 9), `Powered by ${brand}`];
}
