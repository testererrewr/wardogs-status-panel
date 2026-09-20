import crypto from 'node:crypto';

const snowflake = (value) => /^\d{17,20}$/.test(String(value || '').trim()) ? String(value).trim() : '';
const cleanUrl = (value) => {
  let raw = String(value || '').trim();
  if (!raw) return '';
  if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;
  return raw.replace(/\/+$/, '');
};

export function normalizeManagedServers(bot) {
  const raw = Array.isArray(bot?.managedServers) ? bot.managedServers : [];
  const rows = raw.map((row, index) => ({
    id: String(row?.id || `server-${index + 1}`).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 64) || `server-${index + 1}`,
    label: String(row?.label || `Server ${index + 1}`).trim().slice(0, 80) || `Server ${index + 1}`,
    baseUrl: cleanUrl(row?.baseUrl || row?.wardogsBaseUrl),
    secretEnc: String(row?.secretEnc || row?.wardogsSecretEnc || ''),
    alertChannelId: snowflake(row?.alertChannelId),
    controlPanelEnabled: row?.controlPanelEnabled === true,
    controlPanelChannelId: snowflake(row?.controlPanelChannelId),
    controlPanelMessageId: snowflake(row?.controlPanelMessageId),
    controlPanelMessageChannelId: snowflake(row?.controlPanelMessageChannelId),
    dynamicNameOriginalName: String(row?.dynamicNameOriginalName || '').replace(/[\r\n\0]/g, ' ').trim().slice(0, 96),
    dynamicNameLastAppliedName: String(row?.dynamicNameLastAppliedName || '').replace(/[\r\n\0]/g, ' ').trim().slice(0, 96),
    killFeedTokenEnc: String(row?.killFeedTokenEnc || ''),
    killFeedConfiguredAt: row?.killFeedConfiguredAt || null,
    killFeedPublicUrl: String(row?.killFeedPublicUrl || '').slice(0, 300),
    killFeedNeedsGameRestart: row?.killFeedNeedsGameRestart === true,
    killFeedLastEventAt: row?.killFeedLastEventAt || null,
    killFeedEvents: (Array.isArray(row?.killFeedEvents) ? row.killFeedEvents : []).slice(-150)
  })).filter((row) => row.baseUrl && row.secretEnc).slice(0, 12);
  if (rows.length) return rows;
  const legacyUrl = cleanUrl(bot?.wardogsBaseUrl);
  const legacySecret = String(bot?.wardogsSecretEnc || '');
  if (!legacyUrl || !legacySecret) return [];
  return [{
    id: 'primary',
    label: String(bot?.serverLabel || bot?.name || 'Server 1').trim().slice(0, 80) || 'Server 1',
    baseUrl: legacyUrl,
    secretEnc: legacySecret,
    alertChannelId: snowflake(bot?.alertChannelId),
    controlPanelEnabled: bot?.controlPanelEnabled === true,
    controlPanelChannelId: snowflake(bot?.controlPanelChannelId),
    controlPanelMessageId: snowflake(bot?.controlPanelMessageId),
    controlPanelMessageChannelId: snowflake(bot?.controlPanelMessageChannelId),
    dynamicNameOriginalName: String(bot?.dynamicNameOriginalName || '').replace(/[\r\n\0]/g, ' ').trim().slice(0, 96),
    dynamicNameLastAppliedName: String(bot?.dynamicNameLastAppliedName || '').replace(/[\r\n\0]/g, ' ').trim().slice(0, 96),
    killFeedTokenEnc: String(bot?.killFeedTokenEnc || ''),
    killFeedConfiguredAt: bot?.killFeedConfiguredAt || null,
    killFeedPublicUrl: String(bot?.killFeedPublicUrl || '').slice(0, 300),
    killFeedNeedsGameRestart: bot?.killFeedNeedsGameRestart === true,
    killFeedLastEventAt: bot?.killFeedLastEventAt || null,
    killFeedEvents: (Array.isArray(bot?.killFeedEvents) ? bot.killFeedEvents : []).slice(-150)
  }];
}

export function managedServerContext(bot, serverOrId) {
  const servers = normalizeManagedServers(bot);
  const server = typeof serverOrId === 'object'
    ? serverOrId
    : servers.find((row) => String(row.id) === String(serverOrId || '')) || servers[0] || null;
  if (!server) return null;
  return {
    ...bot,
    _managedServerId: server.id,
    _managedServerLabel: server.label,
    _managedParentBotId: bot?.id,
    wardogsBaseUrl: server.baseUrl,
    wardogsSecretEnc: server.secretEnc,
    alertChannelId: server.alertChannelId,
    controlPanelEnabled: server.controlPanelEnabled === true,
    controlPanelChannelId: server.controlPanelChannelId,
    controlPanelMessageId: server.controlPanelMessageId,
    controlPanelMessageChannelId: server.controlPanelMessageChannelId,
    dynamicNameOriginalName: server.dynamicNameOriginalName,
    dynamicNameLastAppliedName: server.dynamicNameLastAppliedName,
    killFeedTokenEnc: server.killFeedTokenEnc,
    killFeedConfiguredAt: server.killFeedConfiguredAt,
    killFeedPublicUrl: server.killFeedPublicUrl,
    killFeedNeedsGameRestart: server.killFeedNeedsGameRestart,
    killFeedLastEventAt: server.killFeedLastEventAt,
    killFeedEvents: server.killFeedEvents
  };
}

export function managedServerContexts(bot) {
  return normalizeManagedServers(bot).map((row) => managedServerContext(bot, row)).filter(Boolean);
}

export function managedServerByChannel(bot, channelId) {
  const id = String(channelId || '');
  const server = normalizeManagedServers(bot).find((row) => (row.controlPanelEnabled && String(row.controlPanelChannelId || '') === id) || String(row.alertChannelId || '') === id);
  return server ? managedServerContext(bot, server) : null;
}

export function managedServerPatch(bot, serverId, patch = {}) {
  const servers = normalizeManagedServers(bot);
  const index = servers.findIndex((row) => String(row.id) === String(serverId || ''));
  if (index < 0) return servers;
  return servers.map((row, i) => i === index ? { ...row, ...patch } : row);
}

export function newManagedServerRow(index = 0) {
  return { id: crypto.randomUUID(), label: `Server ${index + 1}`, baseUrl: '', secretEnc: '', alertChannelId: '', controlPanelEnabled: false, controlPanelChannelId: '', controlPanelMessageId: '', controlPanelMessageChannelId: '', dynamicNameOriginalName: '', dynamicNameLastAppliedName: '', killFeedTokenEnc: '', killFeedConfiguredAt: null, killFeedPublicUrl: '', killFeedNeedsGameRestart: false, killFeedLastEventAt: null, killFeedEvents: [] };
}
