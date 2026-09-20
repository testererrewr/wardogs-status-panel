import crypto from 'node:crypto';
import {
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle
} from 'discord.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { readDb, getManagedBot, upsertManagedBot } from './db.js';
import { safeHttpText } from './target-safety.js';
import { normalizeSteamId64 } from './wardogs-players.js';
import { normalizeManagedServers, managedServerContext, managedServerPatch } from './managed-servers.js';
import { appendManagedChat, extractChatEvents } from './managed-chat.js';

export const KILL_STATS_SERVICE_ID = 'wardogs-kill-stats';
const PLAYTIME_STATUS_SERVICE_ID = 'wardogs-playtime-tracker';
const SUPPORTED_FEED_SERVICES = new Set(['wardogs-warning-bot', KILL_STATS_SERVICE_ID, PLAYTIME_STATUS_SERVICE_ID]);
const instances = new Map();
const runtime = new Map();
const locks = new Map();
const publishTimers = new Map();

function nowIso() { return new Date().toISOString(); }
function baseUrl(value) { return String(value || '').trim().replace(/\/+$/, ''); }
function targetKey(value) { return baseUrl(value).toLowerCase(); }
function validSnowflake(value) { return /^\d{17,20}$/.test(String(value || '').trim()); }
function setRuntime(id, patch) { runtime.set(id, { ...(runtime.get(id) || {}), ...patch, updatedAt: nowIso() }); }
export function killStatsBotRuntime(id) { return runtime.get(id) || { state: 'stopped' }; }
function accessActive(bot) {
  if (!bot) return false;
  if (bot.adminGrant) return true;
  const until = Date.parse(bot.accessUntil || '');
  return Number.isFinite(until) && until > Date.now();
}
function decryptMaybe(value) { try { return value ? decryptSecret(value) : ''; } catch { return ''; } }
function sameSecret(a, b) {
  const aa = decryptMaybe(a?.wardogsSecretEnc), bb = decryptMaybe(b?.wardogsSecretEnc);
  return Boolean(aa && bb && aa === bb);
}
function secureEqual(a, b) {
  const aa = Buffer.from(String(a || '')), bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && aa.length > 0 && crypto.timingSafeEqual(aa, bb);
}
async function withLock(id, fn) {
  const previous = locks.get(id) || Promise.resolve();
  const next = previous.catch(() => {}).then(fn);
  let tracked;
  tracked = next.finally(() => { if (locks.get(id) === tracked) locks.delete(id); });
  locks.set(id, tracked);
  return tracked;
}

function emptyStats(input = null) {
  const source = input && typeof input === 'object' ? structuredClone(input) : {};
  const out = {
    startedAt: source.startedAt || nowIso(),
    lastEventAt: source.lastEventAt || null,
    totalEvents: Math.max(0, Math.floor(Number(source.totalEvents) || 0)),
    players: source.players && typeof source.players === 'object' && !Array.isArray(source.players) ? source.players : {},
    recentEvents: Array.isArray(source.recentEvents) ? source.recentEvents.slice(-500) : [],
    seenEventIds: [...new Set((Array.isArray(source.seenEventIds) ? source.seenEventIds : []).map((x)=>String(x||'')).filter(Boolean))].slice(-5000)
  };
  for (const [steamId, raw] of Object.entries(out.players)) {
    if (!normalizeSteamId64(steamId)) { delete out.players[steamId]; continue; }
    out.players[steamId] = normalizePlayerStat(raw, steamId);
  }
  out.recentEvents = out.recentEvents.map(normalizeStoredEvent).filter(Boolean).slice(-500);
  return out;
}
function normalizePlayerStat(raw, steamId) {
  const aliases = [...new Set((Array.isArray(raw?.aliases) ? raw.aliases : []).map((x) => String(x || '').trim()).filter(Boolean))].slice(-12);
  const causes = raw?.causes && typeof raw.causes === 'object' && !Array.isArray(raw.causes) ? raw.causes : {};
  return {
    steamId,
    name: String(raw?.name || steamId).slice(0, 100), aliases,
    kills: Math.max(0, Math.floor(Number(raw?.kills) || 0)), deaths: Math.max(0, Math.floor(Number(raw?.deaths) || 0)),
    headshots: Math.max(0, Math.floor(Number(raw?.headshots) || 0)), penetrations: Math.max(0, Math.floor(Number(raw?.penetrations) || 0)),
    ricochets: Math.max(0, Math.floor(Number(raw?.ricochets) || 0)), meleeKills: Math.max(0, Math.floor(Number(raw?.meleeKills) || 0)),
    vehicleKills: Math.max(0, Math.floor(Number(raw?.vehicleKills) || 0)), roadKills: Math.max(0, Math.floor(Number(raw?.roadKills) || 0)),
    suicides: Math.max(0, Math.floor(Number(raw?.suicides) || 0)), environmentalDeaths: Math.max(0, Math.floor(Number(raw?.environmentalDeaths) || 0)),
    longestKillMeters: Math.max(0, Number(raw?.longestKillMeters) || 0),
    firstSeenAt: raw?.firstSeenAt || null, lastSeenAt: raw?.lastSeenAt || null,
    causes: Object.fromEntries(Object.entries(causes).map(([key, value]) => [String(key).slice(0, 100), Math.max(0, Math.floor(Number(value) || 0))]).filter(([, value]) => value > 0).slice(0, 100))
  };
}
function normalizeStoredEvent(raw) {
  const victimSteamId = normalizeSteamId64(raw?.victimSteamId);
  if (!victimSteamId) return null;
  const killerSteamId = normalizeSteamId64(raw?.killerSteamId);
  return {
    id: String(raw?.id || raw?.eventId || '').slice(0, 100), receivedAt: raw?.receivedAt || nowIso(),
    serverId: String(raw?.serverId || '').slice(0, 100), serverName: String(raw?.serverName || '').slice(0, 120),
    matchId: String(raw?.matchId || '').slice(0, 100), mapName: String(raw?.mapName || '').slice(0, 100), eventTime: Math.max(0, Number(raw?.eventTime) || 0),
    killerName: String(raw?.killerName || '').slice(0, 100), killerSteamId: killerSteamId || '',
    victimName: String(raw?.victimName || victimSteamId).slice(0, 100), victimSteamId,
    cause: String(raw?.cause || '').slice(0, 120), distanceMeters: Math.max(0, Number(raw?.distanceMeters) || 0),
    tags: (Array.isArray(raw?.tags) ? raw.tags : []).map((x) => String(x || '').slice(0, 160)).filter(Boolean).slice(0, 30),
    headshot: raw?.headshot === true, penetration: raw?.penetration === true, ricochet: raw?.ricochet === true,
    melee: raw?.melee === true, vehicleExplosion: raw?.vehicleExplosion === true, roadKill: raw?.roadKill === true,
    falling: raw?.falling === true, suicide: raw?.suicide === true
  };
}
function tagHas(tags, suffix) { return tags.some((tag) => String(tag).toLowerCase().includes(String(suffix).toLowerCase())); }
function incomingEvent(payload, raw) {
  if (String(raw?.type || '').toLowerCase() !== 'killed') return null;
  const victimSteamId = normalizeSteamId64(raw?.victimSteamId);
  if (!victimSteamId) return null;
  const killerSteamId = normalizeSteamId64(raw?.killerSteamId);
  const tags = (Array.isArray(raw?.contextTags) ? raw.contextTags : []).map(String).filter(Boolean).slice(0, 30);
  const distanceCm = Math.max(0, Number(raw?.distance) || 0);
  const suicide = tagHas(tags, 'Suicide') || Boolean(killerSteamId && killerSteamId === victimSteamId);
  return normalizeStoredEvent({
    id: raw?.eventId || crypto.randomUUID(), receivedAt: nowIso(), serverId: payload?.serverId, serverName: payload?.serverName,
    matchId: raw?.matchId, mapName: raw?.mapName, eventTime: raw?.eventTime,
    killerName: raw?.killerName, killerSteamId, victimName: raw?.victimName, victimSteamId,
    cause: raw?.cause, distanceMeters: distanceCm / 100, tags,
    headshot: tagHas(tags, 'Headshot'), penetration: tagHas(tags, 'Penetration'), ricochet: tagHas(tags, 'Ricochet'),
    melee: tagHas(tags, 'WeaponMelee'), vehicleExplosion: tagHas(tags, 'VehicleExplosion'), roadKill: tagHas(tags, 'RoadKill'),
    falling: tagHas(tags, 'Falling'), suicide
  });
}
function rememberName(player, name) {
  const clean = String(name || '').trim().slice(0, 100);
  if (!clean) return;
  const old = String(player.name || '').trim();
  if (old && old !== clean) player.aliases = [...new Set([...(player.aliases || []), old])].slice(-12);
  player.name = clean;
  if (!player.aliases) player.aliases = [];
}
function ensurePlayer(stats, steamId, name, at) {
  const current = normalizePlayerStat(stats.players[steamId] || {}, steamId);
  rememberName(current, name || steamId);
  current.firstSeenAt ||= at;
  current.lastSeenAt = at;
  stats.players[steamId] = current;
  return current;
}
function applyEventToStats(statsInput, event) {
  const stats = emptyStats(statsInput);
  if (event.id && stats.seenEventIds.includes(event.id)) return { stats, duplicate: true };
  const at = event.receivedAt || nowIso();
  const victim = ensurePlayer(stats, event.victimSteamId, event.victimName, at);
  victim.deaths += 1;
  if (!event.killerSteamId) victim.environmentalDeaths += 1;
  if (event.suicide) victim.suicides += 1;
  if (event.killerSteamId && !event.suicide) {
    const killer = ensurePlayer(stats, event.killerSteamId, event.killerName, at);
    killer.kills += 1;
    if (event.headshot) killer.headshots += 1;
    if (event.penetration) killer.penetrations += 1;
    if (event.ricochet) killer.ricochets += 1;
    if (event.melee) killer.meleeKills += 1;
    if (event.vehicleExplosion) killer.vehicleKills += 1;
    if (event.roadKill) killer.roadKills += 1;
    killer.longestKillMeters = Math.max(killer.longestKillMeters, Number(event.distanceMeters) || 0);
    const cause = String(event.cause || '').trim();
    if (cause) killer.causes[cause] = Math.max(0, Number(killer.causes[cause]) || 0) + 1;
  }
  stats.totalEvents += 1;
  stats.lastEventAt = at;
  stats.recentEvents.push(event);
  stats.recentEvents = stats.recentEvents.slice(-500);
  if (event.id) stats.seenEventIds = [...stats.seenEventIds, event.id].slice(-5000);
  return { stats, duplicate: false };
}

export function killStatsSnapshotFromStats(statsInput) {
  const stats = emptyStats(statsInput);
  const players = Object.values(stats.players).map((p) => ({
    ...p, kd: p.deaths > 0 ? p.kills / p.deaths : p.kills,
    headshotRate: p.kills > 0 ? p.headshots / p.kills : 0,
    topCauses: Object.entries(p.causes || {}).sort((a,b) => b[1]-a[1]).slice(0, 8)
  })).sort((a,b) => b.kills - a.kills || a.deaths - b.deaths || a.name.localeCompare(b.name));
  return { ...stats, players, top25: players.slice(0, 25), recentEvents: stats.recentEvents.slice().reverse() };
}
export function killStatsSnapshot(bot) {
  return { ...killStatsSnapshotFromStats(bot?.killStats), runtime: killStatsBotRuntime(bot?.id) };
}
export function searchKillStatsSnapshot(snapshot, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const exactSteam = normalizeSteamId64(q);
  return (Array.isArray(snapshot?.players) ? snapshot.players : []).filter((p) => {
    if (exactSteam && p.steamId === exactSteam) return true;
    if (String(p.steamId || '').includes(q)) return true;
    if (String(p.name || '').toLowerCase().includes(q)) return true;
    return (p.aliases || []).some((name) => String(name).toLowerCase().includes(q));
  }).slice(0, 25);
}
export function searchKillStatsPlayer(bot, query) { return searchKillStatsSnapshot(killStatsSnapshot(bot), query); }

export function aggregateKillStatsServers(servers = []) {
  const aggregate = emptyStats(null);
  aggregate.startedAt = null; aggregate.lastEventAt = null; aggregate.totalEvents = 0; aggregate.players = {}; aggregate.recentEvents = []; aggregate.seenEventIds = [];
  for (const server of (Array.isArray(servers) ? servers : [])) {
    const stats = emptyStats(server?.killStats);
    if (stats.startedAt && (!aggregate.startedAt || Date.parse(stats.startedAt) < Date.parse(aggregate.startedAt))) aggregate.startedAt = stats.startedAt;
    if (stats.lastEventAt && (!aggregate.lastEventAt || Date.parse(stats.lastEventAt) > Date.parse(aggregate.lastEventAt))) aggregate.lastEventAt = stats.lastEventAt;
    aggregate.totalEvents += Math.max(0, Number(stats.totalEvents) || 0);
    for (const [steamId, raw] of Object.entries(stats.players || {})) {
      const incoming = normalizePlayerStat(raw, steamId);
      const current = aggregate.players[steamId] ? normalizePlayerStat(aggregate.players[steamId], steamId) : normalizePlayerStat({}, steamId);
      const latestIncoming = Date.parse(incoming.lastSeenAt || '') || 0, latestCurrent = Date.parse(current.lastSeenAt || '') || 0;
      if (latestIncoming >= latestCurrent) current.name = incoming.name || current.name;
      current.aliases = [...new Set([...(current.aliases || []), ...(incoming.aliases || []), incoming.name].filter(Boolean))].filter((x)=>x!==current.name).slice(-20);
      for (const key of ['kills','deaths','headshots','penetrations','ricochets','meleeKills','vehicleKills','roadKills','suicides','environmentalDeaths']) current[key] = Math.max(0, Number(current[key]) || 0) + Math.max(0, Number(incoming[key]) || 0);
      current.longestKillMeters = Math.max(Number(current.longestKillMeters)||0, Number(incoming.longestKillMeters)||0);
      current.firstSeenAt = [current.firstSeenAt, incoming.firstSeenAt].filter(Boolean).sort()[0] || null;
      current.lastSeenAt = [current.lastSeenAt, incoming.lastSeenAt].filter(Boolean).sort().at(-1) || null;
      for (const [cause,count] of Object.entries(incoming.causes || {})) current.causes[cause] = Math.max(0, Number(current.causes[cause])||0) + Math.max(0, Number(count)||0);
      aggregate.players[steamId] = current;
    }
    aggregate.recentEvents.push(...stats.recentEvents.map((event)=>normalizeStoredEvent(event)).filter(Boolean));
  }
  const dedupe = new Map();
  for (const event of aggregate.recentEvents) {
    const key = `${event.serverId || ''}:${event.id || `${event.receivedAt}:${event.victimSteamId}:${event.killerSteamId}`}`;
    if (!dedupe.has(key)) dedupe.set(key,event);
  }
  aggregate.recentEvents = [...dedupe.values()].sort((a,b)=>(Date.parse(a.receivedAt||'')||0)-(Date.parse(b.receivedAt||'')||0)).slice(-500);
  return killStatsSnapshotFromStats(aggregate);
}
export function statusOwnerKillStats(ownerDiscordId) {
  const servers=(readDb().servers||[]).filter((server)=>String(server?.ownerDiscordId||'')===String(ownerDiscordId||'')&&server?.gameType==='wardogs');
  return aggregateKillStatsServers(servers);
}
export function statusServerKillFeed(server) {
  return (Array.isArray(server?.killFeedEvents) ? server.killFeedEvents : []).map(normalizeStoredEvent).filter(Boolean).slice(-150).reverse();
}
export function managementKillFeed(bot) {
  return (Array.isArray(bot?.killFeedEvents) ? bot.killFeedEvents : []).map(normalizeStoredEvent).filter(Boolean).slice(-150).reverse();
}

function feedLine(event) {
  const killer = event.suicide ? '☠️ Suicide' : event.killerSteamId ? String(event.killerName || event.killerSteamId).slice(0, 28) : '🌍 Environment';
  const victim = String(event.victimName || event.victimSteamId).slice(0, 28);
  const cause = prettyCause(event.cause).slice(0, 24);
  const distance = event.distanceMeters > 0 ? ` · ${event.distanceMeters.toFixed(event.distanceMeters >= 100 ? 0 : 1)}m` : '';
  const flags = [event.headshot ? '🎯' : '', event.penetration ? '🧱' : '', event.ricochet ? '↪' : '', event.melee ? '🔪' : '', event.roadKill ? '🚙' : '', event.vehicleExplosion ? '💥' : ''].filter(Boolean).join('');
  return `${killer} → **${victim}** · ${cause || 'Unknown'}${distance}${flags ? ` · ${flags}` : ''}`;
}
export function prettyCause(value) {
  let text = String(value || '').trim();
  if (!text) return 'Unknown';
  text = text
    .replace(/^Id\.Item\./i, '')
    .replace(/^Id\./i, '')
    .replace(/^(?:BP|DA|WBP)[._-]+/i, '')
    .replace(/_C$/i, '')
    .replace(/[._-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  const aliases = [
    [/^vehicle variant air rota(?:tor)?$/i, 'Aircraft rotor'],
    [/^vehicle.*air.*rota(?:tor)?$/i, 'Aircraft rotor'],
    [/^vehicle weapon extension$/i, 'Vehicle weapon'],
    [/^vehicle.*weapon.*extension$/i, 'Vehicle weapon'],
    [/^weapon extension$/i, 'Vehicle weapon'],
    [/^vehicle variant air$/i, 'Aircraft'],
    [/^vehicle variant ground$/i, 'Vehicle'],
    [/^vehicle collision$/i, 'Vehicle collision'],
    [/^road kill$/i, 'Roadkill'],
    [/^falling$/i, 'Falling']
  ];
  for (const [pattern, label] of aliases) if (pattern.test(text)) return label;
  return text || 'Unknown';
}
function playerEmbed(player) {
  const causes = (player.topCauses || Object.entries(player.causes || {}).sort((a,b)=>b[1]-a[1]).slice(0,5)).map(([cause,count]) => `${prettyCause(cause)}: ${count}`).join('\n') || '—';
  return new EmbedBuilder().setTitle(`Player stats · ${String(player.name || player.steamId).slice(0, 120)}`)
    .setDescription(`SteamID: \`${player.steamId}\``)
    .addFields(
      { name: 'Kills', value: String(player.kills), inline: true }, { name: 'Deaths', value: String(player.deaths), inline: true },
      { name: 'K/D', value: (player.deaths ? player.kills / player.deaths : player.kills).toFixed(2), inline: true },
      { name: 'Headshots', value: String(player.headshots), inline: true }, { name: 'Longest kill', value: `${Number(player.longestKillMeters || 0).toFixed(1)} m`, inline: true },
      { name: 'Suicides', value: String(player.suicides), inline: true }, { name: 'Top kill causes', value: causes.slice(0, 1024), inline: false }
    ).setFooter({ text: 'WARDOGS Killfeed & Stats · all tracked matches' }).setTimestamp(new Date(player.lastSeenAt || Date.now()));
}
function killfeedPayload(bot) {
  const snapshot = killStatsSnapshot(bot);
  const recent = snapshot.recentEvents.slice(0, 15);
  const lines = recent.length ? recent.map(feedLine).join('\n') : 'No kills tracked yet. Configure the WARDOGS Server Feed and restart the game server once.';
  const embed = new EmbedBuilder().setTitle('WARDOGS · Live Killfeed').setDescription(lines.slice(0, 4000))
    .addFields(
      { name: 'Tracked kills/deaths', value: String(snapshot.totalEvents), inline: true },
      { name: 'Players', value: String(snapshot.players.length), inline: true },
      { name: 'All-time leader', value: snapshot.top25[0] ? `${String(snapshot.top25[0].name).slice(0, 40)} · ${snapshot.top25[0].kills} kills` : '—', inline: true }
    ).setFooter({ text: 'Fixed message · last 15 kills · status-hub.lol' }).setTimestamp(new Date());
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`killstats:search:${bot.id}`).setLabel('Search player').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`killstats:top:${bot.id}`).setLabel('Top kills').setStyle(ButtonStyle.Secondary)
  );
  return { embeds: [embed], components: [row], allowedMentions: { parse: [] } };
}
async function publishKillfeed(botId) {
  const active = instances.get(botId); if (!active?.client?.isReady?.()) return;
  const bot = getManagedBot(botId); if (!bot || bot.serviceId !== KILL_STATS_SERVICE_ID || !validSnowflake(bot.killFeedChannelId)) return;
  const channel = await active.client.channels.fetch(String(bot.killFeedChannelId));
  if (!channel?.isTextBased?.() || typeof channel.send !== 'function') throw new Error('Killfeed channel was not found or is not writable');
  const payload = killfeedPayload(bot);
  let message = null;
  const storedId = String(bot.killFeedMessageId || active.messageId || '');
  if (storedId) { try { message = await channel.messages.fetch(storedId); await message.edit(payload); } catch { message = null; } }
  if (!message) message = await channel.send(payload);
  active.messageId = message.id;
  upsertManagedBot({ id: bot.id, killFeedMessageId: message.id, killFeedLastPublishedAt: nowIso() });
  setRuntime(bot.id, { lastPublishedAt: nowIso(), lastPublishError: null });
}
function schedulePublish(botId, delay = 2500) {
  if (publishTimers.has(botId)) return;
  const timer = setTimeout(() => {
    publishTimers.delete(botId);
    publishKillfeed(botId).catch((error) => setRuntime(botId, { lastPublishError: String(error?.message || error).slice(0, 300) }));
  }, delay);
  timer.unref?.(); publishTimers.set(botId, timer);
}
function searchModal(botId) {
  return new ModalBuilder().setCustomId(`killstats:searchmodal:${botId}`).setTitle('Search player stats').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('query').setLabel('Player name or SteamID64').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100))
  );
}
async function handleInteraction(botId, interaction) {
  const bot = getManagedBot(botId); if (!bot) return;
  const id = String(interaction.customId || '');
  if (id === `killstats:search:${botId}` && interaction.isButton()) return interaction.showModal(searchModal(botId));
  if (id === `killstats:top:${botId}` && interaction.isButton()) {
    const top = killStatsSnapshot(bot).top25.slice(0, 10);
    const text = top.length ? top.map((p,i) => `**${i+1}.** ${String(p.name).slice(0,40)} — **${p.kills}** kills · ${p.deaths} deaths · K/D ${(p.deaths?p.kills/p.deaths:p.kills).toFixed(2)}`).join('\n') : 'No stats tracked yet.';
    return interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder().setTitle('All-time · Top kills').setDescription(text.slice(0, 3900))], allowedMentions: { parse: [] } });
  }
  if (id === `killstats:searchmodal:${botId}` && interaction.isModalSubmit()) {
    const query = interaction.fields.getTextInputValue('query');
    const matches = searchKillStatsPlayer(bot, query);
    if (!matches.length) return interaction.reply({ ephemeral: true, content: `No tracked player found for \`${String(query).slice(0,80)}\`.` });
    const exact = normalizeSteamId64(query);
    const player = exact ? matches.find((p) => p.steamId === exact) || matches[0] : matches[0];
    return interaction.reply({ ephemeral: true, embeds: [playerEmbed(player)], allowedMentions: { parse: [] } });
  }
}
function signature(bot) {
  return JSON.stringify({ enabled:Boolean(bot.enabled), botTokenEnc:bot.botTokenEnc||'', killFeedChannelId:bot.killFeedChannelId||'', accessUntil:bot.accessUntil||null, adminGrant:Boolean(bot.adminGrant), restartNonce:bot.restartNonce||0 });
}
async function stopOne(id, keepRuntime = true) {
  const active = instances.get(id); if (active) instances.delete(id);
  if (publishTimers.has(id)) { clearTimeout(publishTimers.get(id)); publishTimers.delete(id); }
  try { await active?.client?.destroy?.(); } catch {}
  if (keepRuntime) setRuntime(id, { state:'stopped', botTag:null, lastError:null }); else runtime.delete(id);
}
async function startOne(bot) {
  await stopOne(bot.id, false);
  if (bot.serviceId !== KILL_STATS_SERVICE_ID) return;
  if (!bot.enabled || !accessActive(bot)) { setRuntime(bot.id, { state: accessActive(bot)?'stopped':'access-expired' }); return; }
  const wantsDiscord = validSnowflake(bot.killFeedChannelId);
  const token = decryptMaybe(bot.botTokenEnc);
  if (wantsDiscord && !token) throw new Error('Discord bot token is required when a killfeed channel is configured');
  const client = wantsDiscord ? new Client({ intents:[GatewayIntentBits.Guilds] }) : null;
  const active = { client, signature:signature(bot), messageId:String(bot.killFeedMessageId||'') };
  if (client) {
    client.on('interactionCreate', (interaction) => { if (String(interaction.customId||'').endsWith(`:${bot.id}`)) handleInteraction(bot.id, interaction).catch(()=>{}); });
    client.on('shardError', (error) => setRuntime(bot.id, { state:'error', lastError:String(error?.message||error).slice(0,300) }));
    await new Promise((resolve,reject)=>{ const timeout=setTimeout(()=>reject(new Error('Discord login timeout')),20000); client.once('clientReady',()=>{clearTimeout(timeout);resolve();}); client.login(token).catch((error)=>{clearTimeout(timeout);reject(error);}); });
  }
  instances.set(bot.id, active);
  setRuntime(bot.id, { state:'online', botTag:client?.user?.tag||null, lastError:null, trackedEvents:emptyStats(bot.killStats).totalEvents });
  if (client) schedulePublish(bot.id, 250);
}
export async function syncKillStatsBots(bots) {
  const filtered = (bots || []).filter((bot) => bot?.serviceId === KILL_STATS_SERVICE_ID);
  const snapshots = new Map(filtered.map((bot)=>[bot.id,bot]));
  const ids = new Set([...instances.keys(), ...snapshots.keys()]);
  for (const id of ids) await withLock(id, async()=>{
    const fresh = getManagedBot(id) || snapshots.get(id);
    if (!fresh || fresh.serviceId !== KILL_STATS_SERVICE_ID || !fresh.enabled || !accessActive(fresh)) { if (instances.has(id)) await stopOne(id); setRuntime(id,{state:fresh?.enabled&&!accessActive(fresh)?'access-expired':'stopped'}); return; }
    const existing=instances.get(id); if(existing?.signature===signature(fresh)) return;
    try{await startOne(fresh);}catch(error){await stopOne(id,false);setRuntime(id,{state:'error',lastError:String(error?.message||error).slice(0,300)});}
  });
}
export async function restartKillStatsBot(bot){return withLock(bot.id,async()=>{await startOne(getManagedBot(bot.id)||bot);return killStatsBotRuntime(bot.id);});}
export async function stopKillStatsBot(id){return withLock(id,()=>stopOne(id));}
export async function shutdownKillStatsBots(){for(const id of [...instances.keys()])await withLock(id,()=>stopOne(id,false));}
export async function refreshKillStatsDiscord(bot){if(bot.serviceId!==KILL_STATS_SERVICE_ID)throw new Error('Kill stats bot required');await publishKillfeed(bot.id);return killStatsSnapshot(getManagedBot(bot.id)||bot);}

async function wardogsJson(bot, pathname) {
  const root=baseUrl(bot?.wardogsBaseUrl); if(!root)throw new Error('WARDOGS base URL is missing');
  const secret=decryptMaybe(bot?.wardogsSecretEnc); if(!secret)throw new Error('WARDOGS RCON/API password is missing');
  const response=await safeHttpText(`${root}${pathname}`,{allowPrivate:Boolean(bot?.allowPrivateTarget),headers:{Accept:'application/json',Authorization:`Bearer ${secret}`},timeoutMs:8000,maxBytes:1024*1024});
  let data={}; if(response.text){try{data=JSON.parse(response.text);}catch{data={message:response.text.slice(0,300)};}}
  if(!response.ok)throw new Error(`WARDOGS API ${response.status}: ${String(data?.error?.message||data?.message||data?.error||'Error').slice(0,220)}`);
  return {data,headers:response.headers||{}};
}
async function statusWardogsJson(server, pathname) {
  const root=baseUrl(server?.queryConfig?.baseUrl); if(!root)throw new Error('WARDOGS base URL is missing');
  const secret=decryptMaybe(server?.querySecretEnc); if(!secret)throw new Error('WARDOGS RCON/API password is missing');
  const response=await safeHttpText(`${root}${pathname}`,{allowPrivate:Boolean(server?.allowPrivateTarget),headers:{Accept:'application/json',Authorization:`Bearer ${secret}`},timeoutMs:8000,maxBytes:1024*1024});
  let data={}; if(response.text){try{data=JSON.parse(response.text);}catch{data={message:response.text.slice(0,300)};}}
  if(!response.ok)throw new Error(`WARDOGS API ${response.status}: ${String(data?.error?.message||data?.message||data?.error||'Error').slice(0,220)}`);
  return {data,headers:response.headers||{}};
}
async function playtimeWardogsJson(bot, server, pathname) {
  const root=baseUrl(server?.baseUrl); if(!root)throw new Error('WARDOGS base URL is missing');
  const secret=decryptMaybe(server?.secretEnc); if(!secret)throw new Error('WARDOGS RCON/API password is missing');
  const response=await safeHttpText(`${root}${pathname}`,{allowPrivate:Boolean(bot?.allowPrivateTarget),headers:{Accept:'application/json',Authorization:`Bearer ${secret}`},timeoutMs:8000,maxBytes:1024*1024});
  let data={}; if(response.text){try{data=JSON.parse(response.text);}catch{data={message:response.text.slice(0,300)};}}
  if(!response.ok)throw new Error(`WARDOGS API ${response.status}: ${String(data?.error?.message||data?.message||data?.error||'Error').slice(0,220)}`);
  return {data,headers:response.headers||{}};
}
export async function testKillStatsWardogs(bot){const [{data:players},{data:capabilities}]=await Promise.all([wardogsJson(bot,'/v1/players'),wardogsJson(bot,'/v1/capabilities').catch(()=>({data:{routes:[]}}))]);return{playerCount:Array.isArray(players?.players)?players.players.length:0,feedConfigSupported:true,routes:Array.isArray(capabilities?.routes)?capabilities.routes:[]};}
function patchIniKey(lines, sectionName, key, value) {
  let start=-1,end=lines.length;
  for(let i=0;i<lines.length;i+=1){const m=lines[i].match(/^\s*\[([^\]]+)\]\s*$/);if(!m)continue;if(m[1].trim()===sectionName){start=i;for(let j=i+1;j<lines.length;j+=1){if(/^\s*\[[^\]]+\]\s*$/.test(lines[j])){end=j;break;}}break;}}
  const line=`${key}=${value}`;
  if(start<0){if(lines.length&&lines.at(-1)?.trim()!=='')lines.push('');lines.push(`[${sectionName}]`,line);return;}
  for(let i=start+1;i<end;i+=1){if(new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\\]\\]/g,'\\$&')}\\s*=`, 'i').test(lines[i])){lines[i]=line;return;}}
  lines.splice(start+1,0,line);
}
function patchServerFeedConfig(text, origin, token){const newline=String(text||'').includes('\r\n')?'\r\n':'\n';const lines=String(text||'').split(/\r?\n/);patchIniKey(lines,'WDServerFeed','Url',origin);patchIniKey(lines,'WDServerFeed','Token',token);return lines.join(newline);}
export async function configureWardogsKillFeed(bot, publicUrl = process.env.PUBLIC_URL || '') {
  if(!SUPPORTED_FEED_SERVICES.has(String(bot?.serviceId||'')))throw new Error('This service does not use the WARDOGS kill feed');
  const origin=new URL(String(publicUrl||'')).origin;
  const root=baseUrl(bot?.wardogsBaseUrl);if(!root)throw new Error('WARDOGS base URL is missing');
  const secret=decryptMaybe(bot?.wardogsSecretEnc);if(!secret)throw new Error('WARDOGS RCON/API password is missing');
  let token=decryptMaybe(bot.killFeedTokenEnc);if(!token)token=crypto.randomBytes(32).toString('base64url');
  const {data:config}=await wardogsJson(bot,'/v1/config');if(typeof config?.text!=='string')throw new Error('WARDOGS config document is unavailable');
  const patched=patchServerFeedConfig(config.text,origin,token);const revision=String(config?.revision||'').trim();
  const response=await safeHttpText(`${root}/v1/config?fullApply=true`,{allowPrivate:Boolean(bot?.allowPrivateTarget),method:'PUT',headers:{Accept:'application/json',Authorization:`Bearer ${secret}`,'Content-Type':'text/plain; charset=utf-8',...(revision?{'If-Match':`"${revision.replace(/^"|"$/g,'')}"`}:{})},body:patched,timeoutMs:10000,maxBytes:1024*1024});
  let result={};if(response.text){try{result=JSON.parse(response.text);}catch{result={message:response.text.slice(0,300)};}}if(!response.ok)throw new Error(`WARDOGS API ${response.status}: ${String(result?.error?.message||result?.message||result?.error||'Error').slice(0,220)}`);
  const fresh=upsertManagedBot({id:bot.id,killFeedTokenEnc:encryptSecret(token),killFeedConfiguredAt:nowIso(),killFeedPublicUrl:origin,killFeedNeedsGameRestart:true});
  return{bot:fresh,origin,needsGameRestart:true,result};
}

export async function configureWardogsPlaytimeKillFeed(bot, serverId, publicUrl = process.env.PUBLIC_URL || '') {
  if(bot?.serviceId!==PLAYTIME_STATUS_SERVICE_ID)throw new Error('WARDOGS Status Bot required');
  const servers=Array.isArray(bot?.playtimeServers)?bot.playtimeServers:[];
  const index=servers.findIndex((row)=>String(row?.id||'')===String(serverId||''));
  if(index<0)throw new Error('Tracked WARDOGS server not found');
  const server={...servers[index]};
  const origin=new URL(String(publicUrl||'')).origin;
  const root=baseUrl(server.baseUrl);if(!root)throw new Error('WARDOGS base URL is missing');
  const secret=decryptMaybe(server.secretEnc);if(!secret)throw new Error('WARDOGS RCON/API password is missing');
  let token=decryptMaybe(server.killFeedTokenEnc);if(!token)token=crypto.randomBytes(32).toString('base64url');
  const {data:config}=await playtimeWardogsJson(bot,server,'/v1/config');if(typeof config?.text!=='string')throw new Error('WARDOGS config document is unavailable');
  const patched=patchServerFeedConfig(config.text,origin,token);const revision=String(config?.revision||'').trim();
  const response=await safeHttpText(`${root}/v1/config?fullApply=true`,{allowPrivate:Boolean(bot?.allowPrivateTarget),method:'PUT',headers:{Accept:'application/json',Authorization:`Bearer ${secret}`,'Content-Type':'text/plain; charset=utf-8',...(revision?{'If-Match':`"${revision.replace(/^"|"$/g,'')}"`}:{})},body:patched,timeoutMs:10000,maxBytes:1024*1024});
  let result={};if(response.text){try{result=JSON.parse(response.text);}catch{result={message:response.text.slice(0,300)};}}if(!response.ok)throw new Error(`WARDOGS API ${response.status}: ${String(result?.error?.message||result?.message||result?.error||'Error').slice(0,220)}`);
  const next=servers.map((row,i)=>i===index?{...row,killFeedTokenEnc:encryptSecret(token),killFeedConfiguredAt:nowIso(),killFeedPublicUrl:origin,killFeedNeedsGameRestart:true}:row);
  const fresh=upsertManagedBot({id:bot.id,playtimeServers:next});
  return{bot:fresh,server:next[index],origin,needsGameRestart:true,result};
}

export async function configureWardogsManagementFeed(bot, serverId, publicUrl = process.env.PUBLIC_URL || '') {
  if(bot?.serviceId!=='wardogs-warning-bot')throw new Error('WARDOGS Management Bot required');
  const servers=normalizeManagedServers(bot);const index=servers.findIndex((row)=>String(row.id)===String(serverId||''));
  if(index<0)throw new Error('Managed WARDOGS server not found');
  const server={...servers[index]},ctx=managedServerContext(bot,server);
  const origin=new URL(String(publicUrl||'')).origin;
  const root=baseUrl(server.baseUrl);if(!root)throw new Error('WARDOGS base URL is missing');
  const secret=decryptMaybe(server.secretEnc);if(!secret)throw new Error('WARDOGS RCON/API password is missing');
  let token=decryptMaybe(server.killFeedTokenEnc);if(!token)token=crypto.randomBytes(32).toString('base64url');
  const {data:config}=await wardogsJson(ctx,'/v1/config');if(typeof config?.text!=='string')throw new Error('WARDOGS config document is unavailable');
  const patched=patchServerFeedConfig(config.text,origin,token);const revision=String(config?.revision||'').trim();
  const response=await safeHttpText(`${root}/v1/config?fullApply=true`,{allowPrivate:Boolean(bot?.allowPrivateTarget),method:'PUT',headers:{Accept:'application/json',Authorization:`Bearer ${secret}`,'Content-Type':'text/plain; charset=utf-8',...(revision?{'If-Match':`"${revision.replace(/^"|"$/g,'')}"`}:{})},body:patched,timeoutMs:10000,maxBytes:1024*1024});
  let result={};if(response.text){try{result=JSON.parse(response.text);}catch{result={message:response.text.slice(0,300)};}}if(!response.ok)throw new Error(`WARDOGS API ${response.status}: ${String(result?.error?.message||result?.message||result?.error||'Error').slice(0,220)}`);
  const next=managedServerPatch(bot,server.id,{killFeedTokenEnc:encryptSecret(token),killFeedConfiguredAt:nowIso(),killFeedPublicUrl:origin,killFeedNeedsGameRestart:true});
  const primary=next[0]||server;
  const fresh=upsertManagedBot({id:bot.id,managedServers:next,wardogsBaseUrl:primary.baseUrl,wardogsSecretEnc:primary.secretEnc,alertChannelId:primary.alertChannelId,controlPanelEnabled:primary.controlPanelEnabled,controlPanelChannelId:primary.controlPanelChannelId});
  return{bot:fresh,server:next.find((row)=>row.id===server.id),origin,needsGameRestart:true,result};
}

function playtimeSourceForFeedToken(token) {
  const bots=(readDb().managedBots||[]).filter((bot)=>bot?.serviceId===PLAYTIME_STATUS_SERVICE_ID);
  for(const bot of bots){for(const server of (Array.isArray(bot.playtimeServers)?bot.playtimeServers:[])){const candidate=decryptMaybe(server?.killFeedTokenEnc);if(candidate&&secureEqual(candidate,token))return {bot,server};}}
  return null;
}
function managementSourceForFeedToken(token) {
  const bots=(readDb().managedBots||[]).filter((bot)=>bot?.serviceId==='wardogs-warning-bot');
  for(const bot of bots){for(const server of normalizeManagedServers(bot)){const candidate=decryptMaybe(server?.killFeedTokenEnc);if(candidate&&secureEqual(candidate,token))return {bot,server};}}
  return null;
}
function botForFeedToken(token) {
  const bots=(readDb().managedBots||[]).filter((bot)=>SUPPORTED_FEED_SERVICES.has(String(bot?.serviceId||''))&&bot.killFeedTokenEnc);
  for(const bot of bots){const candidate=decryptMaybe(bot.killFeedTokenEnc);if(candidate&&secureEqual(candidate,token))return bot;}
  return null;
}
function sourceTargetKey(source, kind) {
  if(kind==='playtime'||kind==='managementServer')return targetKey(source?.server?.baseUrl);
  return targetKey(source?.wardogsBaseUrl);
}
function sourceSecret(source, kind) {
  if(kind==='playtime'||kind==='managementServer')return decryptMaybe(source?.server?.secretEnc);
  return decryptMaybe(source?.wardogsSecretEnc);
}
function matchesSourceTarget(source, sourceKind, target, targetKind) {
  const a=sourceTargetKey(source,sourceKind), b=sourceTargetKey(target,targetKind);
  if(!a||!b||a!==b)return false;
  const sa=sourceSecret(source,sourceKind), sb=sourceSecret(target,targetKind);
  return Boolean(sa&&sb&&sa===sb);
}
function feedTargets(source, sourceKind) {
  const db=readDb(); const out=[];
  if(sourceKind==='playtime')out.push({kind:'playtime',item:source.bot,serverId:source.server.id});
  else if(sourceKind==='managementServer')out.push({kind:'managementServer',item:source.bot,serverId:source.server.id});
  else if(sourceKind==='managed'&&source?.serviceId==='wardogs-warning-bot')out.push({kind:'managed',item:source});
  for(const bot of (db.managedBots||[])){
    if(bot?.serviceId==='wardogs-warning-bot'&&accessActive(bot)&&bot.enabled){
      for(const server of normalizeManagedServers(bot)){
        if(sourceKind==='managementServer'&&String(source?.bot?.id||'')===String(bot.id)&&String(source?.server?.id||'')===String(server.id))continue;
        const target={bot,server};if(!matchesSourceTarget(source,sourceKind,target,'managementServer'))continue;
        out.push({kind:'managementServer',item:bot,serverId:server.id});
      }
    }
    if(bot?.serviceId!==PLAYTIME_STATUS_SERVICE_ID||!accessActive(bot)||!bot.enabled)continue;
    for(const server of (Array.isArray(bot.playtimeServers)?bot.playtimeServers:[])){
      if(sourceKind==='playtime'&&String(source?.bot?.id||'')===String(bot.id)&&String(source?.server?.id||'')===String(server?.id||''))continue;
      const target={bot,server};if(!matchesSourceTarget(source,sourceKind,target,'playtime'))continue;
      out.push({kind:'playtime',item:bot,serverId:server.id});
    }
  }
  return out;
}

function updatePlaytimeFeedTarget(bot, serverId, events) {
  let stats=emptyStats(bot.killStats);let changed=0;
  for(const event of events){const applied=applyEventToStats(stats,event);stats=applied.stats;if(!applied.duplicate)changed+=1;}
  const servers=(Array.isArray(bot.playtimeServers)?bot.playtimeServers:[]).map((server)=>{
    if(String(server?.id||'')!==String(serverId||''))return server;
    const existing=(Array.isArray(server.killFeedEvents)?server.killFeedEvents:[]).map(normalizeStoredEvent).filter(Boolean);
    const ids=new Set(existing.map((event)=>event.id).filter(Boolean));
    const freshEvents=events.filter((event)=>!event.id||!ids.has(event.id));
    return {...server,killFeedEvents:[...existing,...freshEvents].slice(-150),killFeedLastEventAt:events.length?nowIso():server.killFeedLastEventAt,killFeedNeedsGameRestart:false};
  });
  if(changed||events.length){upsertManagedBot({id:bot.id,killStats:stats,playtimeServers:servers,killFeedLastEventAt:events.length?nowIso():bot.killFeedLastEventAt});}
  return changed;
}
function updateManagementServerFeedTarget(bot, serverId, events) {
  const server=normalizeManagedServers(bot).find((row)=>String(row.id)===String(serverId||''));if(!server)return 0;
  const existing=(Array.isArray(server.killFeedEvents)?server.killFeedEvents:[]).map(normalizeStoredEvent).filter(Boolean);
  const ids=new Set(existing.map((event)=>event.id).filter(Boolean));const freshEvents=events.filter((event)=>!event.id||!ids.has(event.id));
  if(!freshEvents.length)return 0;
  const next=managedServerPatch(bot,server.id,{killFeedEvents:[...existing,...freshEvents].slice(-150),killFeedLastEventAt:nowIso(),killFeedNeedsGameRestart:false});
  upsertManagedBot({id:bot.id,managedServers:next});return freshEvents.length;
}
function updateManagedFeedTarget(bot, events) {
  if(bot.serviceId==='wardogs-warning-bot'){
    const existing=(Array.isArray(bot.killFeedEvents)?bot.killFeedEvents:[]).map(normalizeStoredEvent).filter(Boolean);
    const ids=new Set(existing.map((event)=>event.id).filter(Boolean));const freshEvents=events.filter((event)=>!event.id||!ids.has(event.id));
    if(freshEvents.length){upsertManagedBot({id:bot.id,killFeedEvents:[...existing,...freshEvents].slice(-150),killFeedLastEventAt:nowIso(),killFeedNeedsGameRestart:false});return freshEvents.length;}
    return 0;
  }
  if(bot.serviceId===KILL_STATS_SERVICE_ID){
    let stats=emptyStats(bot.killStats);let changed=0;
    for(const event of events){const applied=applyEventToStats(stats,event);stats=applied.stats;if(!applied.duplicate)changed+=1;}
    if(changed){upsertManagedBot({id:bot.id,killStats:stats,killFeedLastEventAt:nowIso(),killFeedNeedsGameRestart:false});setRuntime(bot.id,{trackedEvents:stats.totalEvents,lastEventAt:stats.lastEventAt});schedulePublish(bot.id);}
    return changed;
  }
  return 0;
}
export async function ingestWardogsKillFeed(token, payload) {
  const playtimeSource=playtimeSourceForFeedToken(token);
  const managementServerSource=playtimeSource?null:managementSourceForFeedToken(token);
  const managedSource=(playtimeSource||managementServerSource)?null:botForFeedToken(token);
  const source=playtimeSource||managementServerSource||managedSource;
  const sourceKind=playtimeSource?'playtime':managementServerSource?'managementServer':managedSource?'managed':'';
  if(!source)throw Object.assign(new Error('Invalid feed token'),{status:401});
  const sourceServer=(sourceKind==='playtime'||sourceKind==='managementServer')?source.server:null;
  const sourceBot=(sourceKind==='playtime'||sourceKind==='managementServer')?source.bot:source;
  const enrichedPayload={...payload,serverId:String(sourceServer?.id||payload?.serverId||sourceBot?.id||''),serverName:String(payload?.serverName||sourceServer?.label||sourceBot?.name||'WARDOGS')};
  const rawEvents=Array.isArray(payload?.events)?payload.events.slice(0,100):[];
  const events=rawEvents.map((raw)=>incomingEvent(enrichedPayload,raw)).filter(Boolean);
  const chats=extractChatEvents(enrichedPayload);
  const targets=feedTargets(source,sourceKind);let accepted=0,chatAccepted=0;
  for(const target of targets){
    if(target.kind==='playtime')accepted+=updatePlaytimeFeedTarget(target.item,target.serverId,events);
    else if(target.kind==='managementServer'){
      accepted+=updateManagementServerFeedTarget(target.item,target.serverId,events);
      for(const chat of chats){try{appendManagedChat(target.item.id,target.serverId,chat);chatAccepted+=1;}catch{}}
    }else accepted+=updateManagedFeedTarget(target.item,events);
  }
  if(events.length&&sourceKind==='managed')upsertManagedBot({id:source.id,killFeedLastEventAt:nowIso(),killFeedNeedsGameRestart:false});
  return{events:events.length,chats:chats.length,chatAccepted,accepted,targets:targets.length};
}
