import { Client, ActivityType, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { decryptSecret } from './crypto.js';
import { fetchServerStatus } from './server-query.js';

const instances = new Map();
const runtime = new Map();
const killFeedTimers = new Map();

function serverSignature(server) {
  return JSON.stringify({
    id: server.id, enabled: server.enabled, botTokenEnc: server.botTokenEnc || null, botTokenPlain: server.botTokenPlain || null,
    gameType: server.gameType, queryConfig: server.queryConfig || {}, querySecretEnc: server.querySecretEnc || null, querySecretPlain: server.querySecretPlain || null,
    allowPrivateTarget: Boolean(server.allowPrivateTarget), intervalSeconds: server.intervalSeconds, switchSeconds: server.switchSeconds,
    onlineTemplates: server.onlineTemplates || [], offlineTemplate: server.offlineTemplate || 'Server offline', wardogsSeedingEnabled: Boolean(server.wardogsSeedingEnabled), wardogsScoreEnabled: Boolean(server.wardogsScoreEnabled), killFeedChannelId: server.killFeedChannelId || '', restartNonce: server.restartNonce || 0, name: server.name
  });
}

function setRuntime(id, patch) {
  runtime.set(id, { ...(runtime.get(id) || {}), ...patch, updatedAt: new Date().toISOString() });
}
export function getRuntime(id) { return runtime.get(id) || { state: 'stopped' }; }

function validSnowflake(value) { return /^\d{17,20}$/.test(String(value || '').trim()); }
function prettyCause(value) { return String(value || '').replace(/^Id\.Item\./i, '').replace(/^Id\./i, '').replace(/[._]+/g, ' ').trim() || 'Unknown'; }
function feedLine(event) {
  const killer = event?.suicide ? '☠️ Suicide' : event?.killerSteamId ? String(event.killerName || event.killerSteamId).slice(0, 28) : '🌍 Environment';
  const victim = String(event?.victimName || event?.victimSteamId || 'Unknown').slice(0, 28);
  const cause = prettyCause(event?.cause).slice(0, 24);
  const meters = Math.max(0, Number(event?.distanceMeters) || 0);
  const distance = meters > 0 ? ` · ${meters.toFixed(meters >= 100 ? 0 : 1)}m` : '';
  const flags = [event?.headshot ? '🎯' : '', event?.penetration ? '🧱' : '', event?.ricochet ? '↪' : '', event?.melee ? '🔪' : '', event?.roadKill ? '🚙' : '', event?.vehicleExplosion ? '💥' : ''].filter(Boolean).join('');
  return `${killer} → **${victim}** · ${cause}${distance}${flags ? ` · ${flags}` : ''}`;
}
function globalTop(server) { return Array.isArray(server?.killStatsGlobalSummary?.top10) ? server.killStatsGlobalSummary.top10 : []; }
function killfeedPayload(server) {
  const recent = Array.isArray(server?.killFeedRecent) ? server.killFeedRecent.slice(0, 15) : [];
  const lines = recent.length ? recent.map(feedLine).join('\n') : 'Noch keine Kills erfasst. WARDOGS Kill Feed konfigurieren und den Gameserver einmal neu starten.';
  const summary = server?.killStatsGlobalSummary || {};
  const top = globalTop(server)[0];
  const embed = new EmbedBuilder().setTitle(`WARDOGS · ${String(server?.name || 'Server').slice(0, 120)} · Killfeed`)
    .setDescription(lines.slice(0, 4000))
    .addFields(
      { name: 'Global erfasste Kills/Tode', value: String(Math.max(0, Number(summary.totalEvents) || 0)), inline: true },
      { name: 'Globale Spieler', value: String(Math.max(0, Number(summary.playerCount) || 0)), inline: true },
      { name: 'Global #1', value: top ? `${String(top.name || top.steamId).slice(0, 40)} · ${top.kills} Kills` : '—', inline: true }
    )
    .setFooter({ text: `Feste Nachricht · letzte 15 Kills dieses Servers · Stats über ${Math.max(1, Number(server?.killStatsServerCount) || 1)} Server` })
    .setTimestamp(new Date());
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`statusstats:search:${server.id}`).setLabel('Spieler suchen').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`statusstats:top:${server.id}`).setLabel('Top Kills').setStyle(ButtonStyle.Secondary)
  );
  return { embeds: [embed], components: [row], allowedMentions: { parse: [] } };
}
function playerStatsEmbed(player) {
  const causes = (Array.isArray(player?.topCauses) ? player.topCauses : []).map(([cause,count]) => `${prettyCause(cause)}: ${count}`).join('\n') || '—';
  return new EmbedBuilder().setTitle(`Globale Spieler-Stats · ${String(player?.name || player?.steamId || 'Unknown').slice(0,120)}`)
    .setDescription(`SteamID: \`${String(player?.steamId || '')}\``)
    .addFields(
      { name: 'Kills', value: String(player?.kills || 0), inline: true }, { name: 'Tode', value: String(player?.deaths || 0), inline: true },
      { name: 'K/D', value: Number(player?.kd ?? ((player?.deaths || 0) ? (player?.kills || 0)/(player?.deaths || 1) : (player?.kills || 0))).toFixed(2), inline: true },
      { name: 'Headshots', value: String(player?.headshots || 0), inline: true }, { name: 'Längster Kill', value: `${Number(player?.longestKillMeters || 0).toFixed(1)} m`, inline: true },
      { name: 'Suicides', value: String(player?.suicides || 0), inline: true }, { name: 'Top Kill-Ursachen', value: causes.slice(0,1024), inline: false }
    ).setFooter({ text: 'WARDOGS Status Bot · Stats über alle verbundenen Server' }).setTimestamp(new Date(player?.lastSeenAt || Date.now()));
}
async function controlPlaneStats(server, query = '') {
  if (!server?._controlPlaneUrl || !server?._statusNodeToken || !server?._statusNodeId) throw new Error('Status control plane is unavailable');
  const url = new URL(`/api/status-nodes/stats/${encodeURIComponent(server.id)}`, server._controlPlaneUrl);
  if (query) url.searchParams.set('q', String(query).slice(0,100));
  const response = await fetch(url, { headers: { Accept: 'application/json', Authorization: `Bearer ${server._statusNodeToken}`, 'X-Status-Node-Id': server._statusNodeId }, signal: AbortSignal.timeout(8000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(data?.error || `HTTP ${response.status}`).slice(0,240));
  return data;
}
function searchModal(serverId) {
  return new ModalBuilder().setCustomId(`statusstats:searchmodal:${serverId}`).setTitle('Spieler suchen').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('query').setLabel('Spielername oder SteamID64').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100))
  );
}
async function handleKillfeedInteraction(serverId, interaction) {
  const active = instances.get(serverId); const server = active?.server;
  if (!server) return;
  const id = String(interaction.customId || '');
  if (id === `statusstats:search:${serverId}` && interaction.isButton()) return interaction.showModal(searchModal(serverId));
  if (id === `statusstats:top:${serverId}` && interaction.isButton()) {
    const data = await controlPlaneStats(server);
    const top = Array.isArray(data?.top10) ? data.top10 : [];
    const text = top.length ? top.map((p,i)=>`**${i+1}.** ${String(p.name||p.steamId).slice(0,40)} — **${p.kills}** Kills · ${p.deaths} Tode · K/D ${Number(p.kd||0).toFixed(2)}`).join('\n') : 'Noch keine Stats erfasst.';
    return interaction.reply({ ephemeral:true, embeds:[new EmbedBuilder().setTitle('Global · Top Kills').setDescription(text.slice(0,3900))], allowedMentions:{parse:[]} });
  }
  if (id === `statusstats:searchmodal:${serverId}` && interaction.isModalSubmit()) {
    const query = interaction.fields.getTextInputValue('query'); const data = await controlPlaneStats(server, query);
    const matches = Array.isArray(data?.matches) ? data.matches : [];
    if (!matches.length) return interaction.reply({ ephemeral:true, content:`Kein getrackter Spieler für \`${String(query).slice(0,80)}\` gefunden.` });
    return interaction.reply({ ephemeral:true, embeds:[playerStatsEmbed(matches[0])], allowedMentions:{parse:[]} });
  }
}
async function publishKillfeed(serverId) {
  const active = instances.get(serverId); const server = active?.server; const client = active?.client;
  if (!server || server.gameType !== 'wardogs' || !client?.isReady?.() || !validSnowflake(server.killFeedChannelId)) return;
  const channel = await client.channels.fetch(String(server.killFeedChannelId));
  if (!channel?.isTextBased?.() || typeof channel.send !== 'function') throw new Error('Killfeed Channel wurde nicht gefunden oder ist nicht beschreibbar');
  const payload = killfeedPayload(server); let message = null;
  const storedId = String(server.killFeedMessageId || active.killFeedMessageId || '');
  if (validSnowflake(storedId)) { try { message = await channel.messages.fetch(storedId); await message.edit(payload); } catch { message = null; } }
  if (!message) message = await channel.send(payload);
  active.killFeedMessageId = message.id;
  const publishedAt = new Date().toISOString();
  setRuntime(serverId, { killFeedMessageId: message.id, killFeedLastPublishedAt: publishedAt, killFeedLastPublishError: null });
}
function scheduleKillfeed(serverId, delay = 500) {
  if (killFeedTimers.has(serverId)) return;
  const timer=setTimeout(()=>{killFeedTimers.delete(serverId);publishKillfeed(serverId).catch((error)=>setRuntime(serverId,{killFeedLastPublishError:String(error?.message||error).slice(0,300)}));},delay);
  timer.unref?.(); killFeedTimers.set(serverId,timer);
}
function updateServerSnapshot(active, server) {
  const previous = active.server || {};
  const changed = String(previous.killFeedLastEventAt || '') !== String(server.killFeedLastEventAt || '')
    || JSON.stringify(previous.killStatsGlobalSummary || {}) !== JSON.stringify(server.killStatsGlobalSummary || {})
    || String(previous.killFeedChannelId || '') !== String(server.killFeedChannelId || '');
  active.server = server;
  if (changed && server.gameType === 'wardogs' && validSnowflake(server.killFeedChannelId)) scheduleKillfeed(server.id);
}

function render(template, values) {
  return String(template)
    .replaceAll('{players}', String(values.current ?? 0))
    .replaceAll('{max}', String(values.max ?? 0))
    .replaceAll('{server}', String(values.serverName || values.name || 'Server'))
    .replaceAll('{map}', String(values.map || 'Unbekannt'))
    .replaceAll('{game}', String(values.game || 'Game'))
    .replaceAll('{ping}', values.ping == null ? '—' : `${values.ping}ms`)
    .replaceAll('{score}', String(values.score || '—'))
    .replaceAll('{team1}', String(values.team1 || 'Team 1'))
    .replaceAll('{score1}', String(values.score1 ?? 0))
    .replaceAll('{team2}', String(values.team2 || 'Team 2'))
    .replaceAll('{score2}', String(values.score2 ?? 0))
    .slice(0, 128);
}

function templates(server) {
  const list = Array.isArray(server.onlineTemplates) ? server.onlineTemplates.map((x) => String(x).trim()).filter(Boolean).slice(0, 10) : [];
  return list.length ? list : (server.gameType === 'text_only' ? ['status-hub.lol'] : ['{players}/{max} Spieler online', 'Map: {map}']);
}

export function wardogsSeedingActive(current) {
  const players = Number(current);
  return Number.isFinite(players) && players >= 1 && players <= 20;
}

function onlinePresence(server, client, state, advance = false) {
  if (!client.user || !state.latestStatus) return;
  let list = templates(server);
  if (server.gameType === 'wardogs' && server.wardogsSeedingEnabled) {
    // The automatic WARDOGS Seeding presence is valid only while the server has 1-20 players.
    // Remove an exact Seeding entry first so a previously configured/rotated value cannot leak into 0 or 21+ players.
    list = list.filter((x) => String(x).trim().toLowerCase() !== 'seeding');
    if (wardogsSeedingActive(state.latestStatus.current)) list.push('Seeding');
  }
  if (server.gameType === 'wardogs' && server.wardogsScoreEnabled && state.latestStatus.score && !list.some((x) => /\{(?:score|team1|score1|team2|score2)\}/i.test(String(x)))) list.push('Score: {score}');
  state.rotationIndex = list.length ? (Math.max(0, Number(state.rotationIndex) || 0) % list.length) : 0;
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
    const previousStatus = state.latestStatus;
    const wasOnline = Boolean(previousStatus);
    const seedingRangeChanged = server.gameType === 'wardogs'
      && server.wardogsSeedingEnabled
      && wasOnline
      && wardogsSeedingActive(previousStatus?.current) !== wardogsSeedingActive(status.current);
    state.latestStatus = status;
    setRuntime(server.id, {
      state: 'online', botTag: client.user?.tag || null, botId: client.user?.id || null,
      players: status.current, maxPlayers: status.max, map: status.map, ping: status.ping, score: status.score || null,
      queryServerName: status.serverName, game: status.game, lastCheck: new Date().toISOString(), lastError: null
    });
    if (!wasOnline) state.rotationIndex = 0;
    if (!wasOnline || seedingRangeChanged) onlinePresence(server, client, state, false);
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
  if (killFeedTimers.has(id)) { clearTimeout(killFeedTimers.get(id)); killFeedTimers.delete(id); }
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
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
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
      if (server.gameType === 'wardogs' && validSnowflake(server.killFeedChannelId)) scheduleKillfeed(server.id, 250);
    });
    client.on('interactionCreate', (interaction) => { if (String(interaction.customId || '').endsWith(`:${server.id}`)) handleKillfeedInteraction(server.id, interaction).catch(async (error) => { try { if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) await interaction.reply({ ephemeral:true, content:`Stats-Fehler: ${String(error?.message||error).slice(0,180)}` }); } catch {} }); });
    client.on('error', (error) => setRuntime(server.id, { lastError: error.message }));
    await client.login(token);
    const pollTimer = server.gameType === 'text_only' ? null : setInterval(() => refresh(server, client, state), pollMs);
    const rotateTimer = setInterval(() => {
      if (server.gameType === 'text_only') textOnlyPresence(server, client, state, true);
      else if (state.latestStatus) onlinePresence(server, client, state, true);
    }, rotateMs);
    pollTimer?.unref?.(); rotateTimer.unref?.();
    instances.set(server.id, { client, pollTimer, rotateTimer, state, signature: serverSignature(server), server, killFeedMessageId: String(server.killFeedMessageId || '') });
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
    else updateServerSnapshot(existing, server);
  }
  const concurrency = Math.max(1, Math.min(20, Number(process.env.STATUS_NODE_START_CONCURRENCY || 8)));
  for (let i = 0; i < changes.length; i += concurrency) {
    await Promise.all(changes.slice(i, i + concurrency).map((server) => startServerBot(server)));
  }
}
export async function shutdownBots() { for (const id of [...instances.keys()]) await stopServerBot(id); }
export function runtimeSnapshot() { return Object.fromEntries([...runtime.entries()]); }
export function runningBotCount() { return instances.size; }
