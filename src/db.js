import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = path.resolve('data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const TMP_FILE = path.join(DATA_DIR, 'db.tmp');

function defaultSettings() {
  const configuredDomain = String(process.env.SERVICE_DOMAIN || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const serviceDomain = configuredDomain && !/^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?$/.test(configuredDomain) && configuredDomain !== 'status.example.com' ? configuredDomain : 'status-hub.lol';
  return {
    serviceDomain,
    supportUrl: String(process.env.SUPPORT_URL || ''),
    teamDiscordIds: (process.env.TEAM_DISCORD_IDS || '293104788361576448').split(',').map((x) => x.trim()).filter((x) => /^\d{17,20}$/.test(x)),
    donationLinks: {
      paypal: String(process.env.DONATE_PAYPAL_URL || ''),
      kofi: String(process.env.DONATE_KOFI_URL || ''),
      stripe: String(process.env.DONATE_STRIPE_URL || ''),
      customLabel: '',
      customUrl: ''
    },
    premiumSales: {
      paypalUrl: String(process.env.PREMIUM_PAYPAL_URL || ''),
      discordUserId: String(process.env.SALES_DISCORD_USER_ID || ''),
      discordUsername: String(process.env.SALES_DISCORD_USERNAME || ''),
      prices: {
        premium5: '€4.99 / 30 days',
        premium10: '€8.99 / 30 days',
        premium15: '€12.99 / 30 days',
        premium20: '€16.99 / 30 days'
      },
      paypalAuto: {
        enabled: false,
        currency: 'EUR',
        accessDays: 30,
        webhookId: '',
        amounts: {
          premium5: '4.99',
          premium10: '8.99',
          premium15: '12.99',
          premium20: '16.99'
        }
      }
    },
    freeBoost: {
      channelName: 'Powered by status-hub.lol',
      verifyHours: 6,
      tiers: [
        { members: 50, limit: 2 },
        { members: 100, limit: 3 },
        { members: 250, limit: 4 },
        { members: 500, limit: 5 }
      ]
    }
  };
}


function defaultBotServices() {
  return [{
    id: 'wardogs-warning-bot',
    slug: 'wardogs-warning-bot',
    nameDe: 'WARDOGS Warning Bot',
    nameEn: 'WARDOGS Warning Bot',
    descriptionDe: 'Überwacht Spieler-Joins und sendet Discord-Warnungen, wenn deine Erkennungsregeln einen beitretenden Spieler als auffällig markieren.',
    descriptionEn: 'Monitors player joins and sends Discord alerts when your detection rules flag a joining player as suspicious.',
    featuresDe: ['Join-Überwachung', 'Regelbasierte Warnungen', 'Discord Alert-Channel', 'Konfigurierbare Rollen-Pings', 'Warnungsgrund im Alert'],
    featuresEn: ['Join monitoring', 'Rule-based alerts', 'Discord alert channel', 'Configurable role mentions', 'Alert reason included'],
    priceLabel: '',
    status: 'coming_soon',
    purchaseUrl: '',
    supportUrl: '',
    visible: true,
    featured: true,
    sortOrder: 10
  }];
}

const emptyDb = () => ({ version: 10, users: [], servers: [], customBots: [], statusNodes: [], supporters: [], botServices: defaultBotServices(), paypalPurchases: [], paypalWebhookEvents: [], siteSettings: defaultSettings() });

function mergeSettings(input = {}) {
  const base = defaultSettings();
  return {
    ...base,
    ...input,
    donationLinks: { ...base.donationLinks, ...(input.donationLinks || {}) },
    premiumSales: { ...base.premiumSales, ...(input.premiumSales || {}), prices: { ...base.premiumSales.prices, ...(input.premiumSales?.prices || {}) }, paypalAuto: { ...base.premiumSales.paypalAuto, ...(input.premiumSales?.paypalAuto || {}), amounts: { ...base.premiumSales.paypalAuto.amounts, ...(input.premiumSales?.paypalAuto?.amounts || {}) } } },
    freeBoost: { ...base.freeBoost, ...(input.freeBoost || {}), tiers: Array.isArray(input.freeBoost?.tiers) && input.freeBoost.tiers.length ? input.freeBoost.tiers : base.freeBoost.tiers },
    teamDiscordIds: Array.isArray(input.teamDiscordIds) ? input.teamDiscordIds.filter((x) => /^\d{17,20}$/.test(String(x))) : base.teamDiscordIds
  };
}

function migrate(parsed) {
  const previousVersion = Number(parsed.version || 0);
  parsed.version = 10;
  if (!Array.isArray(parsed.users)) parsed.users = [];
  if (!Array.isArray(parsed.servers)) parsed.servers = [];
  if (!Array.isArray(parsed.customBots)) parsed.customBots = [];
  if (!Array.isArray(parsed.statusNodes)) parsed.statusNodes = [];
  if (!Array.isArray(parsed.supporters)) parsed.supporters = [];
  if (!Array.isArray(parsed.botServices)) parsed.botServices = previousVersion < 8 ? defaultBotServices() : [];
  if (!Array.isArray(parsed.paypalPurchases)) parsed.paypalPurchases = [];
  if (!Array.isArray(parsed.paypalWebhookEvents)) parsed.paypalWebhookEvents = [];
  parsed.siteSettings = mergeSettings(parsed.siteSettings || {});

  parsed.users = parsed.users.map((u) => ({
    ...u,
    role: u.role === 'admin' ? 'admin' : 'user',
    planId: ['free','premium5','premium10','premium15','premium20'].includes(u.planId) ? u.planId : 'free',
    planExpiresAt: u.planExpiresAt || null,
    statusBotLimitOverride: (u.statusBotLimitOverride !== null && u.statusBotLimitOverride !== undefined && String(u.statusBotLimitOverride).trim() !== '' && Number.isFinite(Number(u.statusBotLimitOverride))) ? Number(u.statusBotLimitOverride) : (Number(u.statusBotLimit) !== 1 && Number.isFinite(Number(u.statusBotLimit)) ? Number(u.statusBotLimit) : null),
    customBotLimit: Number.isFinite(Number(u.customBotLimit)) ? Number(u.customBotLimit) : 0,
    locale: u.locale === 'en' ? 'en' : 'de',
    freeBoost: u.freeBoost && typeof u.freeBoost === 'object' ? u.freeBoost : null,
    premiumSource: u.premiumSource && typeof u.premiumSource === 'object' ? u.premiumSource : null
  }));

  parsed.servers = parsed.servers.map((s) => s.gameType ? s : ({ ...s, gameType: 'wardogs', queryConfig: { baseUrl: s.rconUrl || '' }, querySecretEnc: s.rconPasswordEnc || null }));
  parsed.statusNodes = parsed.statusNodes.map((n) => ({ ...n, disabled: Boolean(n.disabled), acceptNewBots: n.acceptNewBots !== false }));
  parsed.supporters = parsed.supporters.map((s) => ({ ...s, id: s.id || crypto.randomUUID(), visible: s.visible !== false, featured: Boolean(s.featured) }));
  parsed.botServices = parsed.botServices.map((x, index) => ({ ...x, id: x.id || crypto.randomUUID(), slug: String(x.slug || x.id || `service-${index + 1}`), visible: x.visible !== false, featured: Boolean(x.featured), status: ['coming_soon','available','paused'].includes(x.status) ? x.status : 'coming_soon', sortOrder: Number.isFinite(Number(x.sortOrder)) ? Number(x.sortOrder) : ((index + 1) * 10), featuresDe: Array.isArray(x.featuresDe) ? x.featuresDe : [], featuresEn: Array.isArray(x.featuresEn) ? x.featuresEn : [] }));
  return parsed;
}

function ensure() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) writeDb(emptyDb());
}

export function readDb() {
  ensure();
  try { return migrate(JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); }
  catch (error) { throw new Error(`Datenbank konnte nicht gelesen werden: ${error.message}`); }
}

export function writeDb(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TMP_FILE, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(TMP_FILE, DB_FILE);
  try { fs.chmodSync(DB_FILE, 0o600); } catch {}
}

export function updateDb(mutator) {
  const db = readDb();
  const result = mutator(db);
  writeDb(db);
  return result;
}

export function assignLegacyOwnership(adminDiscordId) {
  if (!adminDiscordId) return;
  updateDb((db) => {
    for (const s of db.servers) if (!s.ownerDiscordId) s.ownerDiscordId = adminDiscordId;
    for (const b of db.customBots) if (!b.ownerDiscordId) b.ownerDiscordId = adminDiscordId;
  });
}

export function getServer(id) { return readDb().servers.find((s) => s.id === id) || null; }
export function listServersFor(discordId, isAdmin = false) { const servers = readDb().servers; return isAdmin ? servers : servers.filter((s) => s.ownerDiscordId === discordId); }
export function upsertServer(server) {
  return updateDb((db) => {
    const now = new Date().toISOString();
    const index = db.servers.findIndex((s) => s.id === server.id);
    if (index >= 0) { db.servers[index] = { ...db.servers[index], ...server, updatedAt: now }; return db.servers[index]; }
    const entry = { id: server.id || crypto.randomUUID(), createdAt: now, updatedAt: now, ...server };
    db.servers.push(entry); return entry;
  });
}
export function deleteServer(id) { updateDb((db) => { db.servers = db.servers.filter((s) => s.id !== id); }); }

export function findUser(discordId) { return readDb().users.find((u) => u.discordId === discordId) || null; }
export function upsertUser(user) {
  return updateDb((db) => {
    const now = new Date().toISOString();
    const index = db.users.findIndex((u) => u.discordId === user.discordId);
    if (index >= 0) { db.users[index] = { ...db.users[index], ...user, updatedAt: now }; return db.users[index]; }
    const entry = { role: 'user', planId: 'free', planExpiresAt: null, statusBotLimitOverride: null, customBotLimit: 0, locale: 'de', freeBoost: null, createdAt: now, updatedAt: now, ...user };
    db.users.push(entry); return entry;
  });
}
export function deleteUser(discordId) { updateDb((db) => { db.users = db.users.filter((u) => u.discordId !== discordId); }); }

export function getCustomBot(id) { return readDb().customBots.find((b) => b.id === id) || null; }
export function listCustomBotsFor(discordId, isAdmin = false) { const bots = readDb().customBots; return isAdmin ? bots : bots.filter((b) => b.ownerDiscordId === discordId); }
export function upsertCustomBot(bot) {
  return updateDb((db) => {
    const now = new Date().toISOString();
    const index = db.customBots.findIndex((b) => b.id === bot.id);
    if (index >= 0) { db.customBots[index] = { ...db.customBots[index], ...bot, updatedAt: now }; return db.customBots[index]; }
    const entry = { id: bot.id || crypto.randomUUID(), createdAt: now, updatedAt: now, ...bot };
    db.customBots.push(entry); return entry;
  });
}
export function deleteCustomBot(id) { updateDb((db) => { db.customBots = db.customBots.filter((b) => b.id !== id); }); }

export function listStatusNodes() { return readDb().statusNodes || []; }
export function getStatusNode(id) { return listStatusNodes().find((n) => n.id === id) || null; }
export function upsertStatusNode(node) {
  return updateDb((db) => {
    if (!Array.isArray(db.statusNodes)) db.statusNodes = [];
    const now = new Date().toISOString();
    const index = db.statusNodes.findIndex((n) => n.id === node.id);
    if (index >= 0) { db.statusNodes[index] = { ...db.statusNodes[index], ...node, updatedAt: now }; return db.statusNodes[index]; }
    const entry = { createdAt: now, updatedAt: now, ...node };
    db.statusNodes.push(entry); return entry;
  });
}
export function deleteStatusNode(id) { updateDb((db) => { db.statusNodes = (db.statusNodes || []).filter((n) => n.id !== id); for (const s of db.servers) if (s.assignedNodeId === id) s.assignedNodeId = null; }); }

export function getSiteSettings() { return readDb().siteSettings; }
export function updateSiteSettings(patch) { return updateDb((db) => { db.siteSettings = mergeSettings({ ...db.siteSettings, ...patch, donationLinks: { ...(db.siteSettings?.donationLinks || {}), ...(patch.donationLinks || {}) }, premiumSales: { ...(db.siteSettings?.premiumSales || {}), ...(patch.premiumSales || {}), prices: { ...(db.siteSettings?.premiumSales?.prices || {}), ...(patch.premiumSales?.prices || {}) }, paypalAuto: { ...(db.siteSettings?.premiumSales?.paypalAuto || {}), ...(patch.premiumSales?.paypalAuto || {}), amounts: { ...(db.siteSettings?.premiumSales?.paypalAuto?.amounts || {}), ...(patch.premiumSales?.paypalAuto?.amounts || {}) } } }, freeBoost: { ...(db.siteSettings?.freeBoost || {}), ...(patch.freeBoost || {}) } }); return db.siteSettings; }); }

export function listSupporters(visibleOnly = false) { const rows = readDb().supporters || []; return rows.filter((x) => !visibleOnly || x.visible !== false).sort((a,b) => Number(Boolean(b.featured)) - Number(Boolean(a.featured)) || String(b.createdAt || '').localeCompare(String(a.createdAt || ''))); }
export function upsertSupporter(supporter) {
  return updateDb((db) => {
    if (!Array.isArray(db.supporters)) db.supporters = [];
    const now = new Date().toISOString();
    const index = db.supporters.findIndex((s) => s.id === supporter.id);
    if (index >= 0) { db.supporters[index] = { ...db.supporters[index], ...supporter, updatedAt: now }; return db.supporters[index]; }
    const entry = { id: supporter.id || crypto.randomUUID(), visible: true, featured: false, createdAt: now, updatedAt: now, ...supporter };
    db.supporters.push(entry); return entry;
  });
}
export function deleteSupporter(id) { updateDb((db) => { db.supporters = (db.supporters || []).filter((s) => s.id !== id); }); }


export function listBotServices(visibleOnly = false) {
  const rows = readDb().botServices || [];
  return rows.filter((x) => !visibleOnly || x.visible !== false).sort((a, b) => Number(Boolean(b.featured)) - Number(Boolean(a.featured)) || Number(a.sortOrder || 0) - Number(b.sortOrder || 0) || String(a.nameEn || a.nameDe || '').localeCompare(String(b.nameEn || b.nameDe || '')));
}
export function getBotService(id) { return listBotServices(false).find((x) => x.id === id) || null; }
export function upsertBotService(service) {
  return updateDb((db) => {
    if (!Array.isArray(db.botServices)) db.botServices = [];
    const now = new Date().toISOString();
    const index = db.botServices.findIndex((x) => x.id === service.id);
    if (index >= 0) { db.botServices[index] = { ...db.botServices[index], ...service, updatedAt: now }; return db.botServices[index]; }
    const entry = { id: service.id || crypto.randomUUID(), createdAt: now, updatedAt: now, ...service };
    db.botServices.push(entry); return entry;
  });
}
export function deleteBotService(id) { updateDb((db) => { db.botServices = (db.botServices || []).filter((x) => x.id !== id); }); }


export function createPaypalPurchase(purchase) {
  return updateDb((db) => {
    if (!Array.isArray(db.paypalPurchases)) db.paypalPurchases = [];
    const now = new Date().toISOString();
    const entry = { id: purchase.id || crypto.randomUUID(), status: 'created', createdAt: now, updatedAt: now, ...purchase };
    db.paypalPurchases.push(entry);
    return entry;
  });
}
export function getPaypalPurchase(id) { return (readDb().paypalPurchases || []).find((x) => x.id === id) || null; }
export function getPaypalPurchaseByOrder(orderId) { return (readDb().paypalPurchases || []).find((x) => x.orderId === orderId) || null; }
export function updatePaypalPurchase(id, patch) {
  return updateDb((db) => {
    if (!Array.isArray(db.paypalPurchases)) db.paypalPurchases = [];
    const index = db.paypalPurchases.findIndex((x) => x.id === id);
    if (index < 0) return null;
    db.paypalPurchases[index] = { ...db.paypalPurchases[index], ...patch, updatedAt: new Date().toISOString() };
    return db.paypalPurchases[index];
  });
}
export function rememberPaypalWebhookEvent(eventId, eventType) {
  return updateDb((db) => {
    if (!Array.isArray(db.paypalWebhookEvents)) db.paypalWebhookEvents = [];
    if (db.paypalWebhookEvents.some((x) => x.id === eventId)) return false;
    db.paypalWebhookEvents.push({ id: eventId, eventType, processedAt: new Date().toISOString() });
    if (db.paypalWebhookEvents.length > 1000) db.paypalWebhookEvents = db.paypalWebhookEvents.slice(-1000);
    return true;
  });
}
export function paypalWebhookEventSeen(eventId) { return (readDb().paypalWebhookEvents || []).some((x) => x.id === eventId); }
