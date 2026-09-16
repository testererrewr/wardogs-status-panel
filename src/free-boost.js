import { decryptSecret } from './crypto.js';
import { readDb, upsertUser, getSiteSettings } from './db.js';

function normalizeChannelName(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s_.]+/g, '-').replace(/-+/g, '-');
}

function activeTopChannel(channels, expected) {
  const root = channels.filter((c) => c && c.parent_id == null && ![10,11,12].includes(Number(c.type))).sort((a,b) => Number(a.position || 0) - Number(b.position || 0) || String(a.id).localeCompare(String(b.id)));
  if (!root.length) return null;
  const firstPosition = Number(root[0].position || 0);
  return root.find((c) => [0,5].includes(Number(c.type)) && Number(c.position || 0) === firstPosition && normalizeChannelName(c.name) === expected) || null;
}


function channelVisibleToEveryone(guildId, channel, roles) {
  const everyone = roles.find((r) => r.id === guildId);
  if (!everyone) return false;
  let permissions = BigInt(everyone.permissions || '0');
  const overwrite = Array.isArray(channel.permission_overwrites) ? channel.permission_overwrites.find((x) => x.id === guildId && Number(x.type) === 0) : null;
  if (overwrite) permissions = (permissions & ~BigInt(overwrite.deny || '0')) | BigInt(overwrite.allow || '0');
  return (permissions & 8n) === 8n || (permissions & 1024n) === 1024n;
}

async function discordBotApi(token, path) {
  const response = await fetch(`https://discord.com/api/v10${path}`, { headers: { Authorization: `Bot ${token}` } });
  if (!response.ok) throw new Error(`Discord API ${response.status}`);
  return response.json();
}

export function freeBoostLimitForMembers(memberCount, settings = getSiteSettings()) {
  const tiers = Array.isArray(settings?.freeBoost?.tiers) ? settings.freeBoost.tiers : [];
  let limit = 1;
  for (const tier of [...tiers].sort((a,b) => Number(a.members) - Number(b.members))) {
    if (Number(memberCount) >= Number(tier.members || 0)) limit = Math.max(limit, Math.min(5, Number(tier.limit || 1)));
  }
  return Math.min(5, Math.max(1, limit));
}

export function freeBoostIsValid(user, now = Date.now()) {
  const boost = user?.freeBoost;
  if (!boost || boost.state !== 'verified') return false;
  const until = Date.parse(boost.validUntil || '');
  return Number.isFinite(until) && until > now && Number(boost.freeBotLimit) > 1;
}

export async function verifyFreeBoostForUser(discordId) {
  const db = readDb();
  const settings = db.siteSettings || getSiteSettings();
  const user = db.users.find((u) => u.discordId === discordId);
  if (!user) throw new Error('User not found');
  const expected = normalizeChannelName(settings?.freeBoost?.channelName || 'Powered by status-hub.lol');
  const servers = db.servers.filter((s) => s.ownerDiscordId === discordId && s.botTokenEnc);
  const seenTokens = new Set();
  let scanned = 0;
  let best = null;
  let firstError = null;

  for (const server of servers) {
    let token = '';
    try { token = decryptSecret(server.botTokenEnc); } catch (error) { firstError ||= error; continue; }
    if (!token || seenTokens.has(token)) continue;
    seenTokens.add(token);
    try {
      const guilds = await discordBotApi(token, '/users/@me/guilds?with_counts=true&limit=200');
      scanned += 1;
      for (const guild of guilds) {
        try {
          const channels = await discordBotApi(token, `/guilds/${guild.id}/channels`);
          const brandChannel = activeTopChannel(channels, expected);
          if (!brandChannel) continue;
          const roles = await discordBotApi(token, `/guilds/${guild.id}/roles`);
          if (!channelVisibleToEveryone(guild.id, brandChannel, roles)) continue;
          let memberCount = Number(guild.approximate_member_count || 0);
          if (!memberCount) {
            const detail = await discordBotApi(token, `/guilds/${guild.id}?with_counts=true`);
            memberCount = Number(detail.approximate_member_count || detail.member_count || 0);
          }
          const freeBotLimit = freeBoostLimitForMembers(memberCount, settings);
          if (!best || freeBotLimit > best.freeBotLimit || (freeBotLimit === best.freeBotLimit && memberCount > best.memberCount)) {
            best = { state: 'verified', guildId: guild.id, guildName: guild.name || guild.id, memberCount, freeBotLimit, sourceServerId: server.id, channelName: brandChannel.name };
          }
        } catch (error) { firstError ||= error; }
      }
    } catch (error) { firstError ||= error; }
  }

  if (!scanned && firstError) throw firstError;
  const now = Date.now();
  const verifyHours = Math.max(1, Math.min(48, Number(settings?.freeBoost?.verifyHours || 6)));
  const result = best ? { ...best, checkedAt: new Date(now).toISOString(), validUntil: new Date(now + verifyHours * 2 * 3600_000).toISOString() } : { state: servers.length ? 'missing-brand' : 'no-bot', guildId: null, guildName: '', memberCount: 0, freeBotLimit: 1, sourceServerId: null, channelName: '', checkedAt: new Date(now).toISOString(), validUntil: null };
  upsertUser({ discordId, freeBoost: result });
  return result;
}

export async function refreshDueFreeBoosts() {
  const db = readDb();
  const verifyHours = Math.max(1, Math.min(48, Number(db.siteSettings?.freeBoost?.verifyHours || 6)));
  const dueBefore = Date.now() - verifyHours * 3600_000;
  for (const user of db.users) {
    if (user.role === 'admin' || (user.planId || 'free') !== 'free') continue;
    const checked = Date.parse(user.freeBoost?.checkedAt || '');
    if (Number.isFinite(checked) && checked > dueBefore) continue;
    try { await verifyFreeBoostForUser(user.discordId); } catch {}
  }
}
