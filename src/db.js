import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { encryptSecret, decryptSecret } from './crypto.js';

const DATA_DIR = path.resolve('data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const TMP_FILE = path.join(DATA_DIR, 'db.tmp');

function defaultSettings() {
  const configuredDomain = String(process.env.SERVICE_DOMAIN || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const serviceDomain = configuredDomain && !/^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?$/.test(configuredDomain) && configuredDomain !== 'status.example.com' ? configuredDomain : 'status-hub.lol';
  return {
    serviceDomain,
    discordOAuth: {
      enabled: process.env.DISCORD_OAUTH_ENABLED !== 'false',
      allowRegistration: process.env.ALLOW_PUBLIC_REGISTRATION !== 'false',
      clientId: String(process.env.DISCORD_OAUTH_CLIENT_ID || ''),
      clientSecretEnc: ''
    },
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
      paypalApi: {
        mode: String(process.env.PAYPAL_MODE || 'sandbox').toLowerCase() === 'live' ? 'live' : 'sandbox',
        clientId: String(process.env.PAYPAL_CLIENT_ID || ''),
        clientSecretEnc: ''
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
      },
      paypalSubscription: {
        enabled: true,
        productId: '',
        planIds: {},
        planMeta: {},
        amounts: {
          premium5: '4.99',
          premium10: '8.99',
          premium15: '12.99',
          premium20: '16.99'
        }
      },
      stripeApi: {
        mode: 'test',
        secretKeyEnc: '',
        webhookSecretEnc: '',
        endpointId: ''
      },
      stripeAuto: {
        enabled: false,
        currency: 'EUR',
        accessDays: 30,
        amounts: { premium5: '4.99', premium10: '8.99', premium15: '12.99', premium20: '16.99' }
      },
      stripeSubscription: {
        enabled: true,
        amounts: { premium5: '4.99', premium10: '8.99', premium15: '12.99', premium20: '16.99' }
      }
    },
    freeBoost: {
      categoryName: 'Powered by status-hub.lol',
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
    nameDe: 'WARDOGS Management Bot',
    nameEn: 'WARDOGS Management Bot',
    descriptionDe: 'Managed WARDOGS Bot für Spieler-Überwachung und Server-Management. Er überwacht Spieler-Joins und sendet Discord-Warnungen, wenn deine Erkennungsregeln einen beitretenden Spieler als auffällig markieren.',
    descriptionEn: 'Managed WARDOGS bot for player monitoring and server management. It monitors player joins and sends Discord alerts when your detection rules flag a joining player as suspicious.',
    featuresDe: ['Join-Überwachung', 'Live-Spielerliste & Spieleraktionen', 'Server-Announcements (manuell & automatisch)', 'Banliste & Unban', 'Match-, Map- & Lighting-Controls', 'Serverstatus, Health, Join Code, Reserved Slots, Rotation & Audit', 'Steam-Risikoregeln: VAC-/Game-Bans, Spielzeit, Kontoalter & mehr', 'Optionaler Auto-Ban (standardmäßig AUS)', 'Permanentes Discord Management Panel', 'Granulare Discord Rollen-/Benutzerrechte', 'Discord Alert-Channel', 'Konfigurierbare Rollen-Pings', 'Join-Welcome-Whisper nach Spieler-Spawn', 'Temporäre Bans & Ban Templates', 'Discord-Link automatisch in Ban-Nachrichten', 'Detection Rules mit eigener Aktion', 'Moderations-Killfeed mit den letzten 150 Kills/Toden inkl. Distanz & Kill-Tags', 'Config Export / Import', 'Auto-Recovery', 'Whisper an ganze Fraktion', 'Dynamic Server Name: Scores, Seeding & 2-Name-Rotation', 'Mehrere WARDOGS Server pro Management Bot mit eigenem Discord Panel/Alert Channel', 'Persistente Chat-History je Server (wenn WARDOGS Chat-Events liefert)'],
    category: 'wardogs',
    featuresEn: ['Join monitoring', 'Live player list & player actions', 'Server announcements (manual & scheduled)', 'Ban list & unban', 'Match, map & lighting controls', 'Server status, health, join code, reserved slots, rotation & audit', 'Steam risk rules: VAC/game bans, playtime, account age & more', 'Optional auto-ban (OFF by default)', 'Persistent Discord management panel', 'Granular Discord role/user permissions', 'Discord alert channel', 'Configurable role mentions', 'Join welcome whisper after player spawn', 'Temporary bans & ban templates', 'Discord link appended to ban messages', 'Per-rule detection actions', 'Moderation killfeed with the latest 150 kills/deaths including distance & kill tags', 'Config export / import', 'Auto recovery', 'Whisper entire faction', 'Dynamic server name: scores, seeding & two-name rotation', 'Multiple WARDOGS servers per management bot with separate Discord panel/alert channels', 'Persistent per-server chat history (when WARDOGS emits chat events)'],
    priceLabel: '€3.99 / month',
    monthlyAmount: '3.99',
    currency: 'EUR',
    paypalProductId: '',
    paypalPlanId: '',
    paypalPlanMeta: {},
    status: 'available',
    purchaseUrl: '',
    supportUrl: '',
    visible: true,
    featured: true,
    sortOrder: 10
  }, {
    id: 'wardogs-playtime-tracker',
    slug: 'wardogs-playtime-tracker',
    category: 'wardogs',
    nameDe: 'WARDOGS Status Bot',
    nameEn: 'WARDOGS Status Bot',
    descriptionDe: 'Gehosteter WARDOGS Status Bot für mehrere Gameserver: Spielzeit, globale Spieler- und Kill-Statistiken sowie ein eigener fester Discord-Killfeed pro Server in einer Instanz.',
    descriptionEn: 'Hosted WARDOGS Status Bot for multiple game servers: playtime, global player and kill statistics, plus one fixed Discord killfeed panel per server in a single instance.',
    featuresDe: ['Mehrere WARDOGS Server pro Bot', 'Sichere Discord↔Game-Verknüpfung per Ingame-Whisper-Code', 'Slash Commands: /status, /whois, /whoisplayer, /playerstats, /linkgame & /leaderboard', 'Eigener Discord Killfeed pro Server (letzte 15 Kills)', 'Globale Stats: Kills, Tode, K/D, Headshot-Rate, Kill-Rekord, Spielzeit, Matches, Siege & Seeding-Zeit', 'Top-15 Leaderboard pro Statistik-Kategorie mit Spielersuche und exakter Platzierung', 'Spielersuche nach Name / Alias / Steam64ID mit Auswahl bei mehreren Treffern', 'Peak-Zeiten nach Tagesstunde', 'Meistgenutzte Clan-Tags', 'Webpanel mit letzten 150 Kills pro Server', 'Config Export / Import', 'Auto-Recovery'],
    featuresEn: ['Multiple WARDOGS servers per bot', 'Secure Discord↔game linking using an in-game whisper code', 'Slash commands: /status, /whois, /whoisplayer, /playerstats, /linkgame & /leaderboard', 'Dedicated Discord killfeed per server (latest 15 kills)', 'Global stats: kills, deaths, K/D, headshot rate, kill record, playtime, matches, wins & seeding time', 'Top-15 leaderboard per stat category with player search and exact placement', 'Player search by name / alias / Steam64ID with selection for ambiguous matches', 'Peak activity by hour of day', 'Most used clan tags', 'Web panel with the latest 150 kills per server', 'Config export / import', 'Auto recovery'],
    priceLabel: '€1.99 / month',
    monthlyAmount: '1.99',
    currency: 'EUR',
    paypalProductId: '',
    paypalPlanId: '',
    paypalPlanMeta: {},
    status: 'available',
    purchaseUrl: '',
    supportUrl: '',
    visible: true,
    featured: false,
    sortOrder: 20

  }];
}

const emptyDb = () => ({ version: 42, users: [], servers: [], customBots: [], managedBots: [], banSyncServers: [], statusNodes: [], supporters: [], botServices: defaultBotServices(), paypalPurchases: [], paypalSubscriptions: [], paypalServiceSubscriptions: [], paypalWebhookEvents: [], stripePurchases: [], stripeSubscriptions: [], stripeWebhookEvents: [], siteSettings: defaultSettings() });

function mergeSettings(input = {}) {
  const base = defaultSettings();
  return {
    ...base,
    ...input,
    discordOAuth: { ...base.discordOAuth, ...(input.discordOAuth || {}) },
    donationLinks: { ...base.donationLinks, ...(input.donationLinks || {}) },
    premiumSales: { ...base.premiumSales, ...(input.premiumSales || {}), prices: { ...base.premiumSales.prices, ...(input.premiumSales?.prices || {}) }, paypalApi: { ...base.premiumSales.paypalApi, ...(input.premiumSales?.paypalApi || {}) }, paypalAuto: { ...base.premiumSales.paypalAuto, ...(input.premiumSales?.paypalAuto || {}), amounts: { ...base.premiumSales.paypalAuto.amounts, ...(input.premiumSales?.paypalAuto?.amounts || {}) } }, paypalSubscription: { ...base.premiumSales.paypalSubscription, ...(input.premiumSales?.paypalSubscription || {}), planIds: { ...base.premiumSales.paypalSubscription.planIds, ...(input.premiumSales?.paypalSubscription?.planIds || {}) }, planMeta: { ...base.premiumSales.paypalSubscription.planMeta, ...(input.premiumSales?.paypalSubscription?.planMeta || {}) }, amounts: { ...base.premiumSales.paypalSubscription.amounts, ...(input.premiumSales?.paypalSubscription?.amounts || input.premiumSales?.paypalAuto?.amounts || {}) } }, stripeApi: { ...base.premiumSales.stripeApi, ...(input.premiumSales?.stripeApi || {}) }, stripeAuto: { ...base.premiumSales.stripeAuto, ...(input.premiumSales?.stripeAuto || {}), amounts: { ...base.premiumSales.stripeAuto.amounts, ...(input.premiumSales?.stripeAuto?.amounts || {}) } }, stripeSubscription: { ...base.premiumSales.stripeSubscription, ...(input.premiumSales?.stripeSubscription || {}), amounts: { ...base.premiumSales.stripeSubscription.amounts, ...(input.premiumSales?.stripeSubscription?.amounts || {}) } } },
    freeBoost: { ...base.freeBoost, ...(input.freeBoost || {}), categoryName: String(input.freeBoost?.categoryName || input.freeBoost?.channelName || base.freeBoost.categoryName), tiers: Array.isArray(input.freeBoost?.tiers) && input.freeBoost.tiers.length ? input.freeBoost.tiers : base.freeBoost.tiers },
    teamDiscordIds: Array.isArray(input.teamDiscordIds) ? input.teamDiscordIds.filter((x) => /^\d{17,20}$/.test(String(x))) : base.teamDiscordIds
  };
}

function migrate(parsed) {
  const previousVersion = Number(parsed.version || 0);
  parsed.version = 42;
  if (!Array.isArray(parsed.users)) parsed.users = [];
  if (!Array.isArray(parsed.servers)) parsed.servers = [];
  if (!Array.isArray(parsed.customBots)) parsed.customBots = [];
  if (!Array.isArray(parsed.managedBots)) parsed.managedBots = [];
  if (!Array.isArray(parsed.banSyncServers)) parsed.banSyncServers = [];
  if (!Array.isArray(parsed.statusNodes)) parsed.statusNodes = [];
  if (!Array.isArray(parsed.supporters)) parsed.supporters = [];
  if (!Array.isArray(parsed.botServices)) parsed.botServices = previousVersion < 8 ? defaultBotServices() : [];
  if (!Array.isArray(parsed.paypalPurchases)) parsed.paypalPurchases = [];
  if (!Array.isArray(parsed.paypalSubscriptions)) parsed.paypalSubscriptions = [];
  if (!Array.isArray(parsed.paypalServiceSubscriptions)) parsed.paypalServiceSubscriptions = [];
  if (!Array.isArray(parsed.paypalWebhookEvents)) parsed.paypalWebhookEvents = [];
  if (!Array.isArray(parsed.stripePurchases)) parsed.stripePurchases = [];
  if (!Array.isArray(parsed.stripeSubscriptions)) parsed.stripeSubscriptions = [];
  if (!Array.isArray(parsed.stripeWebhookEvents)) parsed.stripeWebhookEvents = [];
  parsed.siteSettings = mergeSettings(parsed.siteSettings || {});

  const migrationNow = new Date().toISOString();
  parsed.users = parsed.users.map((u) => ({
    ...u,
    role: u.role === 'admin' ? 'admin' : 'user',
    planId: ['free','premium5','premium10','premium15','premium20'].includes(u.planId) ? u.planId : 'free',
    planExpiresAt: u.planExpiresAt || null,
    statusBotLimitOverride: (u.statusBotLimitOverride !== null && u.statusBotLimitOverride !== undefined && String(u.statusBotLimitOverride).trim() !== '' && Number.isFinite(Number(u.statusBotLimitOverride))) ? Number(u.statusBotLimitOverride) : (Number(u.statusBotLimit) !== 1 && Number.isFinite(Number(u.statusBotLimit)) ? Number(u.statusBotLimit) : null),
    customBotLimit: Number.isFinite(Number(u.customBotLimit)) ? Number(u.customBotLimit) : 0,
    locale: u.locale === 'en' ? 'en' : 'de',
    freeBoost: u.freeBoost && typeof u.freeBoost === 'object' ? u.freeBoost : null,
    premiumSource: u.premiumSource && typeof u.premiumSource === 'object' ? u.premiumSource : null,
    freeRenewExempt: Boolean(u.freeRenewExempt),
    freeRenewedAt: u.freeRenewedAt || (previousVersion < 13 ? migrationNow : (u.createdAt || migrationNow)),
    freeRenewGraceStartedAt: u.freeRenewGraceStartedAt || null,
    premiumDowngradeStartedAt: u.premiumDowngradeStartedAt || null,
    premiumDowngradeUntil: u.premiumDowngradeUntil || null,
    premiumDowngradeKeepServerId: u.premiumDowngradeKeepServerId || null
  }));

  parsed.servers = parsed.servers.map((s) => s.gameType ? s : ({ ...s, gameType: 'wardogs', queryConfig: { baseUrl: s.rconUrl || '' }, querySecretEnc: s.rconPasswordEnc || null }));
  parsed.statusNodes = parsed.statusNodes.map((n) => ({ ...n, disabled: Boolean(n.disabled), acceptNewBots: n.acceptNewBots !== false }));
  parsed.supporters = parsed.supporters.map((s) => ({ ...s, id: s.id || crypto.randomUUID(), visible: s.visible !== false, featured: Boolean(s.featured) }));
  parsed.botServices = parsed.botServices.map((x, index) => ({ ...x, id: x.id || crypto.randomUUID(), slug: String(x.slug || x.id || `service-${index + 1}`), visible: x.visible !== false, featured: Boolean(x.featured), status: ['coming_soon','available','paused'].includes(x.status) ? x.status : 'coming_soon', sortOrder: Number.isFinite(Number(x.sortOrder)) ? Number(x.sortOrder) : ((index + 1) * 10), featuresDe: Array.isArray(x.featuresDe) ? x.featuresDe : [], featuresEn: Array.isArray(x.featuresEn) ? x.featuresEn : [], monthlyAmount: String(x.monthlyAmount || ''), currency: /^[A-Z]{3}$/.test(String(x.currency || '').toUpperCase()) ? String(x.currency).toUpperCase() : 'EUR', paypalProductId: String(x.paypalProductId || ''), paypalPlanId: String(x.paypalPlanId || ''), category: String(x.category || 'wardogs').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-') || 'wardogs', paypalPlanMeta: x.paypalPlanMeta && typeof x.paypalPlanMeta === 'object' ? x.paypalPlanMeta : {} }));
  if (previousVersion < 16) {
    const serviceIndex = parsed.botServices.findIndex((x) => x.id === 'wardogs-warning-bot' || x.slug === 'wardogs-warning-bot');
    const managedService = defaultBotServices()[0];
    if (serviceIndex >= 0) parsed.botServices[serviceIndex] = { ...parsed.botServices[serviceIndex], ...managedService, updatedAt: migrationNow };
    else parsed.botServices.push({ ...managedService, createdAt: migrationNow, updatedAt: migrationNow });
  }
  if (previousVersion < 17) {
    const serviceIndex = parsed.botServices.findIndex((x) => x.id === 'wardogs-warning-bot' || x.slug === 'wardogs-warning-bot');
    const managedService = defaultBotServices()[0];
    if (serviceIndex >= 0) parsed.botServices[serviceIndex] = { ...managedService, ...parsed.botServices[serviceIndex], monthlyAmount: '3.99', currency: 'EUR', priceLabel: '€3.99 / month', status: 'available', updatedAt: migrationNow };
    else parsed.botServices.push({ ...managedService, createdAt: migrationNow, updatedAt: migrationNow });
  }
  if (previousVersion < 18) {
    const serviceIndex = parsed.botServices.findIndex((x) => x.id === 'wardogs-warning-bot' || x.slug === 'wardogs-warning-bot');
    const managedService = defaultBotServices()[0];
    if (serviceIndex >= 0) parsed.botServices[serviceIndex] = { ...parsed.botServices[serviceIndex], descriptionDe: managedService.descriptionDe, descriptionEn: managedService.descriptionEn, featuresDe: managedService.featuresDe, featuresEn: managedService.featuresEn, updatedAt: migrationNow };
    else parsed.botServices.push({ ...managedService, createdAt: migrationNow, updatedAt: migrationNow });
  }
  if (previousVersion < 19) {
    const serviceIndex = parsed.botServices.findIndex((x) => x.id === 'wardogs-warning-bot' || x.slug === 'wardogs-warning-bot');
    const managedService = defaultBotServices()[0];
    if (serviceIndex >= 0) parsed.botServices[serviceIndex] = { ...parsed.botServices[serviceIndex], descriptionDe: managedService.descriptionDe, descriptionEn: managedService.descriptionEn, featuresDe: managedService.featuresDe, featuresEn: managedService.featuresEn, updatedAt: migrationNow };
    else parsed.botServices.push({ ...managedService, createdAt: migrationNow, updatedAt: migrationNow });
  }
  if (previousVersion < 20) {
    const serviceIndex = parsed.botServices.findIndex((x) => x.id === 'wardogs-warning-bot' || x.slug === 'wardogs-warning-bot');
    const managedService = defaultBotServices()[0];
    if (serviceIndex >= 0) parsed.botServices[serviceIndex] = { ...parsed.botServices[serviceIndex], descriptionDe: managedService.descriptionDe, descriptionEn: managedService.descriptionEn, featuresDe: managedService.featuresDe, featuresEn: managedService.featuresEn, updatedAt: migrationNow };
    else parsed.botServices.push({ ...managedService, createdAt: migrationNow, updatedAt: migrationNow });
    // v3.12.0 used SteamID/name/faction/ping expressions. The new screening system intentionally starts clean.
    parsed.managedBots = parsed.managedBots.map((b) => ({ ...b, rulesText: '', autoBanEnabled: false }));
  }
  if (previousVersion < 21) {
    const serviceIndex = parsed.botServices.findIndex((x) => x.id === 'wardogs-warning-bot' || x.slug === 'wardogs-warning-bot');
    const managedService = defaultBotServices()[0];
    if (serviceIndex >= 0) parsed.botServices[serviceIndex] = { ...parsed.botServices[serviceIndex], featuresDe: managedService.featuresDe, featuresEn: managedService.featuresEn, updatedAt: migrationNow };
    else parsed.botServices.push({ ...managedService, createdAt: migrationNow, updatedAt: migrationNow });
  }
  if (previousVersion < 22) {
    // v3.12.5 supports multiple instances of the same managed bot service.
    // Older databases only had one instance per user/service, so attach that
    // legacy instance to the most relevant PayPal service subscription when
    // accessRecordId was not stored yet. This keeps future recurring payments
    // tied to the correct existing bot instead of creating a duplicate.
    const claimed = new Set(parsed.managedBots.map((b) => String(b.accessRecordId || '')).filter(Boolean));
    for (const bot of parsed.managedBots) {
      if (bot.adminGrant || bot.accessRecordId) continue;
      const candidates = parsed.paypalServiceSubscriptions
        .filter((r) => r.userDiscordId === bot.ownerDiscordId && r.serviceId === String(bot.serviceId || 'wardogs-warning-bot') && !claimed.has(String(r.id || '')))
        .sort((a,b) => String(b.activatedAt || b.createdAt || '').localeCompare(String(a.activatedAt || a.createdAt || '')));
      const match = candidates.find((r) => ['ACTIVE','SUSPENDED','CANCELLED','EXPIRED'].includes(String(r.status || '').toUpperCase()) || r.activatedAt) || candidates[0];
      if (match?.id) { bot.accessRecordId = String(match.id); claimed.add(String(match.id)); }
    }
  }
  if (previousVersion < 23) {
    // v3.12.7 adds the WARDOGS Playtime Tracker and service categories.
    // Preserve existing PayPal catalog IDs on already configured services.
    for (const defaults of defaultBotServices()) {
      const index = parsed.botServices.findIndex((x) => x.id === defaults.id || x.slug === defaults.slug);
      if (index >= 0) {
        const existing = parsed.botServices[index];
        parsed.botServices[index] = {
          ...defaults,
          ...existing,
          category: defaults.category,
          descriptionDe: defaults.descriptionDe,
          descriptionEn: defaults.descriptionEn,
          featuresDe: defaults.featuresDe,
          featuresEn: defaults.featuresEn,
          priceLabel: defaults.priceLabel,
          monthlyAmount: defaults.monthlyAmount,
          currency: defaults.currency,
          status: 'available',
          updatedAt: migrationNow
        };
      } else parsed.botServices.push({ ...defaults, createdAt: migrationNow, updatedAt: migrationNow });
    }
  }
  if (previousVersion < 24) {
    // v3.12.11 adds an opt-in welcome whisper sent once per confirmed join
    // after WARDOGS reports that the player has spawned into a faction.
    const serviceIndex = parsed.botServices.findIndex((x) => x.id === 'wardogs-warning-bot' || x.slug === 'wardogs-warning-bot');
    const managedService = defaultBotServices()[0];
    if (serviceIndex >= 0) parsed.botServices[serviceIndex] = { ...parsed.botServices[serviceIndex], featuresDe: managedService.featuresDe, featuresEn: managedService.featuresEn, updatedAt: migrationNow };
    for (const bot of parsed.managedBots) {
      if (String(bot.serviceId || 'wardogs-warning-bot') !== 'wardogs-warning-bot') continue;
      if (typeof bot.welcomeWhisperEnabled !== 'boolean') bot.welcomeWhisperEnabled = false;
      if (!String(bot.welcomeWhisperMessage || '').trim()) bot.welcomeWhisperMessage = 'Hello {player}, welcome to the server! Join our Discord.';
    }
  }
  if (previousVersion < 25) {
    // v3.12.13 adds temporary bans, ban templates, per-rule actions,
    // safe config import/export and service-bot auto recovery.
    const defaults = defaultBotServices();
    for (const service of defaults) {
      const serviceIndex = parsed.botServices.findIndex((x) => x.id === service.id || x.slug === service.slug);
      if (serviceIndex >= 0) parsed.botServices[serviceIndex] = { ...parsed.botServices[serviceIndex], featuresDe: service.featuresDe, featuresEn: service.featuresEn, updatedAt: migrationNow };
    }
    for (const bot of parsed.managedBots) {
      if (typeof bot.autoRecoveryEnabled !== 'boolean') bot.autoRecoveryEnabled = true;
      if (!Array.isArray(bot.banTemplates)) bot.banTemplates = [];
      if (!Array.isArray(bot.temporaryBans)) bot.temporaryBans = [];
    }
  }
  if (previousVersion < 26) {
    // v3.12.15 adds an optional Discord invite appended to every WARDOGS ban message.
    const defaults = defaultBotServices();
    const service = defaults.find((x) => x.id === 'wardogs-warning-bot');
    const serviceIndex = parsed.botServices.findIndex((x) => x.id === 'wardogs-warning-bot' || x.slug === 'wardogs-warning-bot');
    if (service && serviceIndex >= 0) parsed.botServices[serviceIndex] = { ...parsed.botServices[serviceIndex], featuresDe: service.featuresDe, featuresEn: service.featuresEn, updatedAt: migrationNow };
    for (const bot of parsed.managedBots) if (String(bot.serviceId || 'wardogs-warning-bot') === 'wardogs-warning-bot' && typeof bot.banDiscordLink !== 'string') bot.banDiscordLink = '';
  }
  if (previousVersion < 27) {
    // v3.12.16 removes the redundant Discord-buttons bullet from the
    // public WARDOGS service feature list. The functionality is unchanged.
    const defaults = defaultBotServices();
    const service = defaults.find((x) => x.id === 'wardogs-warning-bot');
    const serviceIndex = parsed.botServices.findIndex((x) => x.id === 'wardogs-warning-bot' || x.slug === 'wardogs-warning-bot');
    if (service && serviceIndex >= 0) parsed.botServices[serviceIndex] = { ...parsed.botServices[serviceIndex], featuresDe: service.featuresDe, featuresEn: service.featuresEn, updatedAt: migrationNow };
  }
  if (previousVersion < 28) {
    // v3.12.17 adds faction-wide whispers and refreshes the WARDOGS service
    // feature list. The BAN dialog itself is UI-only and needs no data migration.
    const defaults = defaultBotServices();
    const service = defaults.find((x) => x.id === 'wardogs-warning-bot');
    const serviceIndex = parsed.botServices.findIndex((x) => x.id === 'wardogs-warning-bot' || x.slug === 'wardogs-warning-bot');
    if (service && serviceIndex >= 0) parsed.botServices[serviceIndex] = { ...parsed.botServices[serviceIndex], featuresDe: service.featuresDe, featuresEn: service.featuresEn, updatedAt: migrationNow };
  }
  if (previousVersion < 29) {
    // v3.12.19 adds the management-bot seeding nickname, a more reliable join
    // welcome queue, player search and multi-server playtime tracking.
    const defaults = defaultBotServices();
    for (const service of defaults) {
      const serviceIndex = parsed.botServices.findIndex((x) => x.id === service.id || x.slug === service.slug);
      if (serviceIndex >= 0) parsed.botServices[serviceIndex] = { ...parsed.botServices[serviceIndex], featuresDe: service.featuresDe, featuresEn: service.featuresEn, updatedAt: migrationNow };
      else parsed.botServices.push({ ...service, createdAt: migrationNow, updatedAt: migrationNow });
    }
    for (const bot of parsed.managedBots) {
      if (String(bot.serviceId || '') === 'wardogs-warning-bot' && typeof bot.seedingNameEnabled !== 'boolean') bot.seedingNameEnabled = true;
      if (String(bot.serviceId || '') === 'wardogs-playtime-tracker' && !Array.isArray(bot.playtimeServers)) {
        const url = String(bot.wardogsBaseUrl || '').trim().replace(/\/+$/, '');
        bot.playtimeServers = url ? [{ id: 'primary', label: String(bot.serverLabel || bot.name || 'Server 1').slice(0, 80), baseUrl: url, secretEnc: String(bot.wardogsSecretEnc || '') }] : [];
      }
    }
  }
  if (previousVersion < 30) {
    // v3.12.20 corrects JOIN Seeding: it belongs to the WARDOGS game-server
    // name, never the Discord bot nickname. Refresh the public feature wording.
    const defaults = defaultBotServices();
    const service = defaults.find((x) => x.id === 'wardogs-warning-bot');
    const serviceIndex = parsed.botServices.findIndex((x) => x.id === 'wardogs-warning-bot' || x.slug === 'wardogs-warning-bot');
    if (service && serviceIndex >= 0) parsed.botServices[serviceIndex] = { ...parsed.botServices[serviceIndex], featuresDe: service.featuresDe, featuresEn: service.featuresEn, updatedAt: migrationNow };
  }
  if (previousVersion < 31) {
    // v3.12.21 removes the JOIN Seeding server-name feature completely. Existing
    // instances keep a one-time cleanup marker so a suffix left by v3.12.20 can
    // be removed safely the next time that management bot starts.
    const defaults = defaultBotServices();
    const service = defaults.find((x) => x.id === 'wardogs-warning-bot');
    const serviceIndex = parsed.botServices.findIndex((x) => x.id === 'wardogs-warning-bot' || x.slug === 'wardogs-warning-bot');
    if (service && serviceIndex >= 0) parsed.botServices[serviceIndex] = { ...parsed.botServices[serviceIndex], featuresDe: service.featuresDe, featuresEn: service.featuresEn, updatedAt: migrationNow };
    for (const bot of parsed.managedBots) {
      if (String(bot.serviceId || '') !== 'wardogs-warning-bot') continue;
      delete bot.seedingNameEnabled;
      if (typeof bot.legacyJoinSeedingCleanupDone !== 'boolean') bot.legacyJoinSeedingCleanupDone = false;
    }
  }
  if (previousVersion < 32) {
    // v3.12.30 adds opt-in cross-bot ban sync, dynamic bans and a local audit log.
    // Discord panel rights are now explicit; bot ownership is no longer a permission grant.
    for (const bot of parsed.managedBots) {
      if (String(bot.serviceId || '') !== 'wardogs-warning-bot') continue;
      if (typeof bot.dynamicBanEnabled !== 'boolean') bot.dynamicBanEnabled = false;
      if (!Number.isFinite(Number(bot.dynamicBanEscalateJoins))) bot.dynamicBanEscalateJoins = 3;
      if (!Number.isFinite(Number(bot.dynamicBanEscalateWindowMinutes))) bot.dynamicBanEscalateWindowMinutes = 5;
      if (!Array.isArray(bot.dynamicBans)) bot.dynamicBans = [];
      if (typeof bot.banSyncTargetBotId !== 'string') bot.banSyncTargetBotId = '';
      if (!Array.isArray(bot.banSyncRequests)) bot.banSyncRequests = [];
      if (!Array.isArray(bot.banSyncAcceptedSources)) bot.banSyncAcceptedSources = [];
      if (!Array.isArray(bot.banSyncMirrors)) bot.banSyncMirrors = [];
      if (!Array.isArray(bot.auditLog)) bot.auditLog = [];
    }
  }
  if (previousVersion < 33) {
    // v3.12.34 replaces one-to-one Ban Sync with password-protected Ban Sync
    // Servers (rooms) that can contain any number of management bots. It also
    // normalizes the public service name to the requested "WARDOGS Management Bot".
    const defaults = defaultBotServices();
    const service = defaults.find((x) => x.id === 'wardogs-warning-bot');
    const serviceIndex = parsed.botServices.findIndex((x) => x.id === 'wardogs-warning-bot' || x.slug === 'wardogs-warning-bot');
    if (service && serviceIndex >= 0) parsed.botServices[serviceIndex] = { ...parsed.botServices[serviceIndex], nameDe: service.nameDe, nameEn: service.nameEn, updatedAt: migrationNow };
    for (const bot of parsed.managedBots) {
      if (String(bot.serviceId || '') !== 'wardogs-warning-bot') continue;
      if (typeof bot.banSyncServerId !== 'string') bot.banSyncServerId = '';
      // The old directional BOT-ID sync is retired. Existing mirrored bans are
      // intentionally left on the game servers, but no hidden legacy sync link
      // continues after upgrading.
      bot.banSyncTargetBotId = '';
      bot.banSyncRequests = [];
      bot.banSyncAcceptedSources = [];
      bot.banSyncMirrors = [];
      const oldName = String(bot.name || '');
      const match = oldName.match(/^WARDOGS Warning & Management Bot(\s*#\d+)?$/i);
      if (match) bot.name = `WARDOGS Management Bot${match[1] || ''}`;
    }
  }
  if (previousVersion < 34) {
    // v3.12.35 turns Ban Sync rooms into communities with centrally managed
    // Dynamic Ban policy. Existing communities inherit the current owner's
    // Dynamic Ban settings and every member immediately adopts that policy.
    for (const room of (Array.isArray(parsed.banSyncServers) ? parsed.banSyncServers : [])) {
      const owner = parsed.managedBots.find((bot) => String(bot?.id || '') === String(room?.ownerBotId || ''));
      const dynamicBanEnabled = owner?.dynamicBanEnabled === true;
      const dynamicBanEscalateJoins = Math.max(2, Math.min(20, Math.floor(Number(owner?.dynamicBanEscalateJoins) || 3)));
      const dynamicBanEscalateWindowMinutes = Math.max(1, Math.min(1440, Math.floor(Number(owner?.dynamicBanEscalateWindowMinutes) || 5)));
      room.dynamicBanEnabled = dynamicBanEnabled;
      room.dynamicBanEscalateJoins = dynamicBanEscalateJoins;
      room.dynamicBanEscalateWindowMinutes = dynamicBanEscalateWindowMinutes;
      const memberIds = new Set((Array.isArray(room?.members) ? room.members : []).map(String));
      for (const bot of parsed.managedBots) {
        if (!memberIds.has(String(bot?.id || ''))) continue;
        bot.dynamicBanEnabled = dynamicBanEnabled;
        bot.dynamicBanEscalateJoins = dynamicBanEscalateJoins;
        bot.dynamicBanEscalateWindowMinutes = dynamicBanEscalateWindowMinutes;
      }
    }
  }
  if (previousVersion < 35) {
    // v3.12.36 adds the hosted Killfeed & Stats Bot and persistent WARDOGS kill-feed storage.
    const defaults = defaultBotServices();
    for (const serviceId of ['wardogs-warning-bot', 'wardogs-kill-stats']) {
      const defaultsRow = defaults.find((x) => x.id === serviceId);
      if (!defaultsRow) continue;
      const serviceIndex = parsed.botServices.findIndex((x) => x.id === serviceId || x.slug === serviceId);
      if (serviceIndex >= 0) {
        const existing = parsed.botServices[serviceIndex];
        parsed.botServices[serviceIndex] = {
          ...defaultsRow, ...existing,
          nameDe: defaultsRow.nameDe, nameEn: defaultsRow.nameEn,
          descriptionDe: defaultsRow.descriptionDe, descriptionEn: defaultsRow.descriptionEn,
          featuresDe: defaultsRow.featuresDe, featuresEn: defaultsRow.featuresEn,
          priceLabel: defaultsRow.priceLabel, monthlyAmount: defaultsRow.monthlyAmount, currency: defaultsRow.currency,
          status: 'available', category: defaultsRow.category, sortOrder: defaultsRow.sortOrder, updatedAt: migrationNow
        };
      } else parsed.botServices.push({ ...defaultsRow, createdAt: migrationNow, updatedAt: migrationNow });
    }
    for (const bot of parsed.managedBots) {
      if (!Array.isArray(bot.killFeedEvents)) bot.killFeedEvents = [];
      if (!bot.killStats || typeof bot.killStats !== 'object') bot.killStats = null;
      if (typeof bot.killFeedTokenEnc !== 'string') bot.killFeedTokenEnc = '';
      if (typeof bot.killFeedChannelId !== 'string') bot.killFeedChannelId = '';
      if (typeof bot.killFeedMessageId !== 'string') bot.killFeedMessageId = '';
    }
  }
  if (previousVersion < 36) {
    // v3.12.37 integrates Killfeed & all-time kill statistics into WARDOGS
    // Status Bots. The old standalone Killfeed & Stats service is hidden and,
    // where a matching Status Bot exists, its stored data is carried over.
    const legacyService = parsed.botServices.find((x) => x.id === 'wardogs-kill-stats' || x.slug === 'wardogs-kill-stats');
    if (legacyService) {
      legacyService.visible = false;
      legacyService.featured = false;
      legacyService.status = 'paused';
      legacyService.nameDe = 'WARDOGS Status Bot';
      legacyService.nameEn = 'WARDOGS Status Bot';
      legacyService.updatedAt = migrationNow;
    }
    const normUrl = (value) => String(value || '').trim().replace(/\/+$/, '').toLowerCase();
    for (const bot of parsed.managedBots.filter((row) => row?.serviceId === 'wardogs-kill-stats')) {
      const target = parsed.servers.find((server) => server?.gameType === 'wardogs'
        && String(server?.ownerDiscordId || '') === String(bot?.ownerDiscordId || '')
        && normUrl(server?.queryConfig?.baseUrl) === normUrl(bot?.wardogsBaseUrl));
      if (!target) continue;
      if ((!target.killStats || typeof target.killStats !== 'object') && bot.killStats && typeof bot.killStats === 'object') target.killStats = bot.killStats;
      if ((!Array.isArray(target.killFeedEvents) || !target.killFeedEvents.length) && Array.isArray(bot.killStats?.recentEvents)) target.killFeedEvents = bot.killStats.recentEvents.slice(-500);
      if (!target.killFeedTokenEnc && bot.killFeedTokenEnc) target.killFeedTokenEnc = bot.killFeedTokenEnc;
      if (!target.killFeedChannelId && bot.killFeedChannelId) target.killFeedChannelId = bot.killFeedChannelId;
      if (!target.killFeedMessageId && bot.killFeedMessageId) target.killFeedMessageId = bot.killFeedMessageId;
      target.killFeedConfiguredAt ||= bot.killFeedConfiguredAt || null;
      target.killFeedPublicUrl ||= bot.killFeedPublicUrl || '';
      target.killFeedNeedsGameRestart = bot.killFeedNeedsGameRestart === true;
      target.killFeedLastEventAt ||= bot.killFeedLastEventAt || null;
      target.killFeedLastPublishedAt ||= bot.killFeedLastPublishedAt || null;
      bot.enabled = false;
      bot.migratedToStatusServerId = target.id;
    }
  }
  if (previousVersion < 37) {
    // v3.12.38 turns the former Playtime Tracker service into the visible
    // WARDOGS Status Bot and moves per-server killfeed configuration into it.
    const defaults = defaultBotServices();
    const serviceDefault = defaults.find((x) => x.id === 'wardogs-playtime-tracker');
    const service = parsed.botServices.find((x) => x.id === 'wardogs-playtime-tracker' || x.slug === 'wardogs-playtime-tracker');
    if (service && serviceDefault) {
      Object.assign(service, {
        nameDe: serviceDefault.nameDe, nameEn: serviceDefault.nameEn,
        descriptionDe: serviceDefault.descriptionDe, descriptionEn: serviceDefault.descriptionEn,
        featuresDe: serviceDefault.featuresDe, featuresEn: serviceDefault.featuresEn,
        visible: true, status: 'available', updatedAt: migrationNow
      });
    } else if (serviceDefault) {
      parsed.botServices.push({ ...serviceDefault, createdAt: migrationNow, updatedAt: migrationNow });
    }
    for (const bot of parsed.managedBots.filter((row) => row?.serviceId === 'wardogs-playtime-tracker')) {
      if (/^(?:WARDOGS\s+)?Playtime Tracker(?:\s*#\d+)?$/i.test(String(bot.name || '').trim())) {
        const suffix = String(bot.name).match(/(\s*#\d+)$/)?.[1] || '';
        bot.name = `WARDOGS Status Bot${suffix}`;
      }
      if (!bot.killStats || typeof bot.killStats !== 'object') bot.killStats = null;
      const normUrl = (value) => String(value || '').trim().replace(/\/+$/, '').toLowerCase();
      bot.playtimeServers = (Array.isArray(bot.playtimeServers) ? bot.playtimeServers : []).map((server) => {
        const matchingStatus = parsed.servers.find((row) => row?.gameType === 'wardogs'
          && String(row?.ownerDiscordId || '') === String(bot?.ownerDiscordId || '')
          && normUrl(row?.queryConfig?.baseUrl) === normUrl(server?.baseUrl || server?.wardogsBaseUrl));
        if (!bot.killStats && matchingStatus?.killStats && typeof matchingStatus.killStats === 'object') bot.killStats = matchingStatus.killStats;
        return {
          ...server,
          killFeedChannelId: String(server?.killFeedChannelId || ''),
          killFeedMessageId: String(server?.killFeedMessageId || ''),
          killFeedTokenEnc: String(server?.killFeedTokenEnc || matchingStatus?.killFeedTokenEnc || ''),
          killFeedConfiguredAt: server?.killFeedConfiguredAt || matchingStatus?.killFeedConfiguredAt || null,
          killFeedPublicUrl: String(server?.killFeedPublicUrl || matchingStatus?.killFeedPublicUrl || ''),
          killFeedNeedsGameRestart: server?.killFeedNeedsGameRestart === true || matchingStatus?.killFeedNeedsGameRestart === true,
          killFeedLastEventAt: server?.killFeedLastEventAt || matchingStatus?.killFeedLastEventAt || null,
          killFeedLastPublishedAt: server?.killFeedLastPublishedAt || null,
          killFeedEvents: Array.isArray(server?.killFeedEvents) && server.killFeedEvents.length ? server.killFeedEvents.slice(-150) : (Array.isArray(matchingStatus?.killFeedEvents) ? matchingStatus.killFeedEvents.slice(-150) : [])
        };
      });
    }
  }
  if (previousVersion < 38) {
    // v3.12.39 fixes the feature boundary: Discord killfeed + global kill stats
    // belong only to the managed WARDOGS Status Bot (former Playtime Tracker),
    // never to the classic/free Status Bot entries in db.servers.
    // v3.12.38 already copied matching historic feed data into playtimeServers;
    // here we disable the accidentally exposed classic feed endpoints without
    // deleting archived event/stat data from disk.
    for (const server of parsed.servers) {
      server.killFeedChannelId = '';
      server.killFeedMessageId = '';
      server.killFeedTokenEnc = '';
      server.killFeedConfiguredAt = null;
      server.killFeedPublicUrl = '';
      server.killFeedNeedsGameRestart = false;
      server.killFeedLastPublishedAt = null;
    }
  }
  if (previousVersion < 39) {
    // v3.12.41 adds optional Dynamic Name automation to the WARDOGS Management Bot.
    // All modes default OFF and the real/static server name is captured only when
    // the owner explicitly enables the feature.
    const defaults = defaultBotServices();
    const service = defaults.find((x) => x.id === 'wardogs-warning-bot');
    const serviceIndex = parsed.botServices.findIndex((x) => x.id === 'wardogs-warning-bot' || x.slug === 'wardogs-warning-bot');
    if (service && serviceIndex >= 0) parsed.botServices[serviceIndex] = { ...parsed.botServices[serviceIndex], featuresDe: service.featuresDe, featuresEn: service.featuresEn, updatedAt: migrationNow };
    for (const bot of parsed.managedBots) {
      if (String(bot.serviceId || '') !== 'wardogs-warning-bot') continue;
      if (typeof bot.dynamicNameEnabled !== 'boolean') bot.dynamicNameEnabled = false;
      if (typeof bot.dynamicNameStatsEnabled !== 'boolean') bot.dynamicNameStatsEnabled = false;
      if (!bot.dynamicNameStatsTemplate) bot.dynamicNameStatsTemplate = '{base} | {score1} | {score2} | {score3}';
      if (typeof bot.dynamicNameSeedingEnabled !== 'boolean') bot.dynamicNameSeedingEnabled = false;
      if (!Number.isFinite(Number(bot.dynamicNameSeedingMinPlayers))) bot.dynamicNameSeedingMinPlayers = 1;
      if (!Number.isFinite(Number(bot.dynamicNameSeedingMaxPlayers))) bot.dynamicNameSeedingMaxPlayers = 20;
      if (!bot.dynamicNameSeedingTemplate) bot.dynamicNameSeedingTemplate = 'JOIN SEEDING';
      if (typeof bot.dynamicNameRotationEnabled !== 'boolean') bot.dynamicNameRotationEnabled = false;
      if (!Number.isFinite(Number(bot.dynamicNameRotationMinutes))) bot.dynamicNameRotationMinutes = 5;
      bot.dynamicNameOriginalName = String(bot.dynamicNameOriginalName || '');
    }
  }
  if (previousVersion < 40) {
    // v3.12.43: one WARDOGS Management Bot may manage up to 12 game servers.
    // Existing single-server installations are migrated into managedServers[0].
    const defaults = defaultBotServices();
    const service = defaults.find((x) => x.id === 'wardogs-warning-bot');
    const serviceIndex = parsed.botServices.findIndex((x) => x.id === 'wardogs-warning-bot' || x.slug === 'wardogs-warning-bot');
    if (service && serviceIndex >= 0) parsed.botServices[serviceIndex] = { ...parsed.botServices[serviceIndex], featuresDe: service.featuresDe, featuresEn: service.featuresEn, updatedAt: migrationNow };
    for (const bot of parsed.managedBots) {
      if (String(bot.serviceId || '') !== 'wardogs-warning-bot') continue;
      if (!Array.isArray(bot.managedServers) || !bot.managedServers.length) {
        const url = String(bot.wardogsBaseUrl || '').trim().replace(/\/+$/, '');
        const secretEnc = String(bot.wardogsSecretEnc || '');
        bot.managedServers = url && secretEnc ? [{
          id: 'primary', label: String(bot.serverLabel || bot.name || 'Server 1').trim().slice(0,80) || 'Server 1',
          baseUrl: url, secretEnc, alertChannelId: String(bot.alertChannelId || ''),
          controlPanelEnabled: bot.controlPanelEnabled === true, controlPanelChannelId: String(bot.controlPanelChannelId || ''),
          controlPanelMessageId: String(bot.controlPanelMessageId || ''), controlPanelMessageChannelId: String(bot.controlPanelMessageChannelId || ''),
          dynamicNameOriginalName: String(bot.dynamicNameOriginalName || ''), dynamicNameLastAppliedName: String(bot.dynamicNameLastAppliedName || ''),
          killFeedTokenEnc: String(bot.killFeedTokenEnc || ''), killFeedConfiguredAt: bot.killFeedConfiguredAt || null,
          killFeedPublicUrl: String(bot.killFeedPublicUrl || ''), killFeedNeedsGameRestart: bot.killFeedNeedsGameRestart === true,
          killFeedLastEventAt: bot.killFeedLastEventAt || null, killFeedEvents: Array.isArray(bot.killFeedEvents) ? bot.killFeedEvents.slice(-150) : []
        }] : [];
      }
    }
  }
  if (previousVersion < 42) {
    // v3.12.47 expands the WARDOGS Status Bot with Discord↔game account
    // verification, slash commands, per-match stats and category leaderboards.
    const defaults = defaultBotServices();
    const service = defaults.find((x) => x.id === 'wardogs-playtime-tracker');
    const serviceIndex = parsed.botServices.findIndex((x) => x.id === 'wardogs-playtime-tracker' || x.slug === 'wardogs-playtime-tracker');
    if (service && serviceIndex >= 0) parsed.botServices[serviceIndex] = {
      ...parsed.botServices[serviceIndex],
      descriptionDe: service.descriptionDe, descriptionEn: service.descriptionEn,
      featuresDe: service.featuresDe, featuresEn: service.featuresEn,
      updatedAt: migrationNow
    };
    for (const bot of parsed.managedBots) {
      if (String(bot.serviceId || '') !== 'wardogs-playtime-tracker') continue;
      if (!Array.isArray(bot.discordPlayerLinks)) bot.discordPlayerLinks = [];
      if (!Array.isArray(bot.playerLinkChallenges)) bot.playerLinkChallenges = [];
      // Best-effort backfill of the per-match kill record from the persisted
      // recent feed window. Full historical match boundaries were not stored in
      // older versions, so older records continue accurately from this point on.
      const stats = bot.killStats && typeof bot.killStats === 'object' ? bot.killStats : null;
      if (stats?.players && typeof stats.players === 'object' && Array.isArray(stats.recentEvents)) {
        const perMatch = new Map();
        const latest = new Map();
        for (const event of stats.recentEvents) {
          const steamId = String(event?.killerSteamId || '');
          const matchId = String(event?.matchId || '');
          if (!/^\d{17}$/.test(steamId) || !matchId || event?.suicide === true) continue;
          const key = `${steamId}\u0000${matchId}`;
          const count = Number(perMatch.get(key) || 0) + 1;
          perMatch.set(key, count);
          latest.set(steamId, { matchId, count });
          const player = stats.players[steamId];
          if (player && typeof player === 'object') player.killRecord = Math.max(0, Number(player.killRecord) || 0, count);
        }
        for (const [steamId, row] of latest) {
          const player = stats.players[steamId];
          if (!player || typeof player !== 'object') continue;
          player.currentMatchId = row.matchId;
          player.currentMatchKills = row.count;
        }
      }
    }
  }
  parsed.servers = parsed.servers.map((server) => ({
    ...server,
    killFeedTokenEnc: String(server?.killFeedTokenEnc || ''),
    killFeedConfiguredAt: server?.killFeedConfiguredAt || null,
    killFeedPublicUrl: String(server?.killFeedPublicUrl || '').slice(0, 300),
    killFeedNeedsGameRestart: server?.killFeedNeedsGameRestart === true,
    killFeedLastEventAt: server?.killFeedLastEventAt || null,
    killFeedChannelId: /^\d{17,20}$/.test(String(server?.killFeedChannelId || '')) ? String(server.killFeedChannelId) : '',
    killFeedMessageId: /^\d{17,20}$/.test(String(server?.killFeedMessageId || '')) ? String(server.killFeedMessageId) : '',
    killFeedLastPublishedAt: server?.killFeedLastPublishedAt || null,
    killFeedEvents: (Array.isArray(server?.killFeedEvents) ? server.killFeedEvents : []).slice(-500),
    killStats: server?.killStats && typeof server.killStats === 'object' ? server.killStats : null
  }));
  parsed.banSyncServers = (Array.isArray(parsed.banSyncServers) ? parsed.banSyncServers : []).map((room) => ({
    id: String(room?.id || crypto.randomUUID()).slice(0, 80),
    name: String(room?.name || 'Ban Sync Server').trim().slice(0, 80) || 'Ban Sync Server',
    ownerBotId: String(room?.ownerBotId || '').slice(0, 80),
    passwordHash: String(room?.passwordHash || '').slice(0, 300),
    members: [...new Set((Array.isArray(room?.members) ? room.members : []).map((x) => String(x || '').slice(0, 80)).filter(Boolean))].slice(0, 100),
    dynamicBanEnabled: room?.dynamicBanEnabled === true,
    dynamicBanEscalateJoins: Math.max(2, Math.min(20, Math.floor(Number(room?.dynamicBanEscalateJoins) || 3))),
    dynamicBanEscalateWindowMinutes: Math.max(1, Math.min(1440, Math.floor(Number(room?.dynamicBanEscalateWindowMinutes) || 5))),
    sharedBans: (Array.isArray(room?.sharedBans) ? room.sharedBans : []).map((row) => ({
      steamId: String(row?.steamId || ''),
      mode: ['permanent','temporary','dynamic'].includes(String(row?.mode || '')) ? String(row.mode) : 'permanent',
      reason: String(row?.reason || '').slice(0, 180),
      expiresAt: row?.expiresAt || null,
      templateId: String(row?.templateId || '').slice(0, 64),
      sourceBotId: String(row?.sourceBotId || '').slice(0, 80),
      updatedAt: row?.updatedAt || null
    })).filter((row) => /^\d{17}$/.test(row.steamId)).filter((row, index, rows) => rows.findIndex((x) => x.steamId === row.steamId) === index).slice(0, 5000),
    createdAt: room?.createdAt || migrationNow,
    updatedAt: room?.updatedAt || migrationNow
  })).filter((room) => room.id && room.name && room.ownerBotId && room.passwordHash && room.members.length).slice(0, 500);
  parsed.managedBots = parsed.managedBots.map((b) => ({
    ...b,
    id: b.id || crypto.randomUUID(),
    serviceId: String(b.serviceId || 'wardogs-warning-bot'),
    sharedPanelUserIds: [...new Set((Array.isArray(b.sharedPanelUserIds) ? b.sharedPanelUserIds : []).map((x) => String(x || '').trim()).filter((x) => /^\d{17,20}$/.test(x) && x !== String(b.ownerDiscordId || '')))].slice(0, 20),
    enabled: Boolean(b.enabled),
    wardogsAuthLockedAt: b.wardogsAuthLockedAt || null,
    wardogsAuthLockedReason: String(b.wardogsAuthLockedReason || '').slice(0, 500),
    wardogsAuthFailureCount: Math.max(0, Math.min(2, Math.floor(Number(b.wardogsAuthFailureCount) || 0))),
    autoBanEnabled: b.autoBanEnabled === true,
    announcementEnabled: b.announcementEnabled === true,
    announcementIntervalMinutes: Math.max(1, Math.min(1440, Number(b.announcementIntervalMinutes) || 15)),
    announcementMessages: String(b.announcementMessages || ''),
    welcomeWhisperEnabled: b.welcomeWhisperEnabled === true,
    welcomeWhisperMessage: String(b.welcomeWhisperMessage || 'Hello {player}, welcome to the server! Join our Discord.').trim().slice(0, 200),
    dynamicNameEnabled: b.dynamicNameEnabled === true,
    dynamicNameStatsEnabled: b.dynamicNameStatsEnabled === true,
    dynamicNameStatsTemplate: String(b.dynamicNameStatsTemplate || '{base} | {score1} | {score2} | {score3}').replace(/[\r\n\0]/g, ' ').trim().slice(0, 96),
    dynamicNameSeedingEnabled: b.dynamicNameSeedingEnabled === true,
    dynamicNameSeedingMinPlayers: Math.max(1, Math.min(512, Math.floor(Number(b.dynamicNameSeedingMinPlayers) || 1))),
    dynamicNameSeedingMaxPlayers: Math.max(0, Math.min(512, Math.floor(Number(b.dynamicNameSeedingMaxPlayers) || 20))),
    dynamicNameSeedingTemplate: String(b.dynamicNameSeedingTemplate || 'JOIN SEEDING').replace(/[\r\n\0]/g, ' ').trim().slice(0, 96),
    dynamicNameRotationEnabled: b.dynamicNameRotationEnabled === true,
    dynamicNameRotationNameA: String(b.dynamicNameRotationNameA || '').replace(/[\r\n\0]/g, ' ').trim().slice(0, 96),
    dynamicNameRotationNameB: String(b.dynamicNameRotationNameB || '').replace(/[\r\n\0]/g, ' ').trim().slice(0, 96),
    dynamicNameRotationMinutes: Math.max(1, Math.min(1440, Math.floor(Number(b.dynamicNameRotationMinutes) || 5))),
    dynamicNameOriginalName: String(b.dynamicNameOriginalName || '').replace(/[\r\n\0]/g, ' ').trim().slice(0, 96),
    dynamicNameLastAppliedName: String(b.dynamicNameLastAppliedName || '').replace(/[\r\n\0]/g, ' ').trim().slice(0, 96),
    legacyJoinSeedingCleanupDone: b.legacyJoinSeedingCleanupDone === true,
    banDiscordLink: String(b.banDiscordLink || '').trim().slice(0, 120),
    controlPanelEnabled: b.controlPanelEnabled === true,
    controlPanelChannelId: /^\d{17,20}$/.test(String(b.controlPanelChannelId || '')) ? String(b.controlPanelChannelId) : '',
    controlPanelMessageId: /^\d{17,20}$/.test(String(b.controlPanelMessageId || '')) ? String(b.controlPanelMessageId) : '',
    controlPanelMessageChannelId: /^\d{17,20}$/.test(String(b.controlPanelMessageChannelId || '')) ? String(b.controlPanelMessageChannelId) : '',
    discordGrants: (Array.isArray(b.discordGrants) ? b.discordGrants : Array.isArray(b.discordRoleGrants) ? b.discordRoleGrants.map((x) => ({ ...x, type: 'role', id: x.id || x.roleId })) : []).map((g) => ({
      type: g?.type === 'user' ? 'user' : 'role',
      id: String(g?.id || g?.roleId || ''),
      permissions: Array.isArray(g?.permissions) ? [...new Set(g.permissions.map(String).filter((x) => ['view','announce','whisper','kick','ban','unban','kill','setteam','match','map','lighting','ignore'].includes(x)))] : []
    })).filter((g) => /^\d{17,20}$/.test(g.id) && g.permissions.length).slice(0, 20),
    pollSeconds: Math.max(10, Math.min(300, Number(b.pollSeconds) || 20)),
    autoRecoveryEnabled: b.autoRecoveryEnabled !== false,
    banTemplates: (Array.isArray(b.banTemplates) ? b.banTemplates : []).map((entry, index) => ({
      id: String(entry?.id || `template-${index + 1}`).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 64) || `template-${index + 1}`,
      label: String(entry?.label || '').trim().slice(0, 60),
      reason: String(entry?.reason || '').trim().slice(0, 180),
      durationMinutes: Math.max(0, Math.min(525600, Math.floor(Number(entry?.durationMinutes) || 0)))
    })).filter((entry) => entry.label && entry.reason).slice(0, 12),
    temporaryBans: (Array.isArray(b.temporaryBans) ? b.temporaryBans : []).map((entry) => ({
      steamId: String(entry?.steamId || ''),
      reason: String(entry?.reason || '').slice(0, 180),
      expiresAt: entry?.expiresAt || null,
      createdAt: entry?.createdAt || null,
      createdBy: String(entry?.createdBy || '').slice(0, 100),
      templateId: String(entry?.templateId || '').slice(0, 64)
    })).filter((entry) => /^\d{17}$/.test(entry.steamId) && Number.isFinite(Date.parse(entry.expiresAt || ''))).filter((entry, index, rows) => rows.findIndex((x) => x.steamId === entry.steamId) === index).slice(0, 1000),
    dynamicBanEnabled: b.dynamicBanEnabled === true,
    dynamicBanEscalateJoins: Math.max(2, Math.min(20, Math.floor(Number(b.dynamicBanEscalateJoins) || 3))),
    dynamicBanEscalateWindowMinutes: Math.max(1, Math.min(1440, Math.floor(Number(b.dynamicBanEscalateWindowMinutes) || 5))),
    dynamicBans: (Array.isArray(b.dynamicBans) ? b.dynamicBans : []).map((entry) => ({
      steamId: String(entry?.steamId || ''), reason: String(entry?.reason || '').slice(0, 180), expiresAt: entry?.expiresAt || null,
      createdAt: entry?.createdAt || null, createdBy: String(entry?.createdBy || '').slice(0, 100), templateId: String(entry?.templateId || '').slice(0, 64),
      escalated: entry?.escalated === true, escalatedAt: entry?.escalatedAt || null,
      joinAttempts: (Array.isArray(entry?.joinAttempts) ? entry.joinAttempts : []).map(String).filter((x) => Number.isFinite(Date.parse(x))).slice(-50)
    })).filter((entry) => /^\d{17}$/.test(entry.steamId) && Number.isFinite(Date.parse(entry.expiresAt || ''))).filter((entry, index, rows) => rows.findIndex((x) => x.steamId === entry.steamId) === index).slice(0, 1000),
    banSyncServerId: String(b.banSyncServerId || '').slice(0, 80),
    banSyncTargetBotId: String(b.banSyncTargetBotId || '').slice(0, 80),
    banSyncRequests: (Array.isArray(b.banSyncRequests) ? b.banSyncRequests : []).map((row) => ({ sourceBotId: String(row?.sourceBotId || '').slice(0, 80), sourceOwnerDiscordId: String(row?.sourceOwnerDiscordId || '').slice(0, 20), requestedAt: row?.requestedAt || null })).filter((row) => row.sourceBotId).filter((row, index, rows) => rows.findIndex((x) => x.sourceBotId === row.sourceBotId) === index).slice(0, 50),
    banSyncAcceptedSources: [...new Set((Array.isArray(b.banSyncAcceptedSources) ? b.banSyncAcceptedSources : []).map((x) => String(x || '').slice(0, 80)).filter(Boolean))].slice(0, 50),
    banSyncMirrors: (Array.isArray(b.banSyncMirrors) ? b.banSyncMirrors : []).map((row) => ({ sourceBotId: String(row?.sourceBotId || '').slice(0, 80), steamId: String(row?.steamId || ''), mode: ['permanent','temporary','dynamic'].includes(String(row?.mode || '')) ? String(row.mode) : 'permanent', expiresAt: row?.expiresAt || null, reason: String(row?.reason || '').slice(0,180), createdAt: row?.createdAt || null })).filter((row) => row.sourceBotId && /^\d{17}$/.test(row.steamId)).slice(-2000),
    auditLog: (Array.isArray(b.auditLog) ? b.auditLog : []).map((row) => ({ id: String(row?.id || ''), at: row?.at || null, actor: String(row?.actor || '').slice(0,100), action: String(row?.action || '').slice(0,80), target: String(row?.target || '').slice(0,100), detail: String(row?.detail || '').slice(0,500), status: String(row?.status || 'ok').slice(0,20) })).filter((row) => row.action && Number.isFinite(Date.parse(row.at || ''))).slice(-500),
    rulesText: String(b.rulesText || ''),
    steamWebApiKeyEnc: String(b.steamWebApiKeyEnc || ''),
    steamAppId: /^\d{1,10}$/.test(String(b.steamAppId || '')) ? String(b.steamAppId) : '1867240',
    ignoredPlayers: (Array.isArray(b.ignoredPlayers) ? b.ignoredPlayers : []).map((entry) => typeof entry === 'string' ? { steamId: entry } : entry).map((entry) => ({ steamId: String(entry?.steamId || ''), name: String(entry?.name || '').slice(0, 100), ignoredAt: entry?.ignoredAt || null, ignoredBy: String(entry?.ignoredBy || '') })).filter((entry) => /^\d{17}$/.test(entry.steamId)).filter((entry, index, rows) => rows.findIndex((x) => x.steamId === entry.steamId) === index).slice(0, 500),
    killFeedTokenEnc: String(b.killFeedTokenEnc || ''),
    killFeedConfiguredAt: b.killFeedConfiguredAt || null,
    killFeedPublicUrl: String(b.killFeedPublicUrl || '').slice(0, 300),
    killFeedNeedsGameRestart: b.killFeedNeedsGameRestart === true,
    killFeedLastEventAt: b.killFeedLastEventAt || null,
    killFeedChannelId: /^\d{17,20}$/.test(String(b.killFeedChannelId || '')) ? String(b.killFeedChannelId) : '',
    killFeedMessageId: /^\d{17,20}$/.test(String(b.killFeedMessageId || '')) ? String(b.killFeedMessageId) : '',
    killFeedLastPublishedAt: b.killFeedLastPublishedAt || null,
    killFeedEvents: (Array.isArray(b.killFeedEvents) ? b.killFeedEvents : []).slice(-150),
    killStats: b.killStats && typeof b.killStats === 'object' ? b.killStats : null,
    managedServers: (Array.isArray(b.managedServers) ? b.managedServers : []).map((row,index)=>({
      id: String(row?.id || `server-${index + 1}`).replace(/[^a-zA-Z0-9_-]+/g,'-').slice(0,64) || `server-${index + 1}`,
      label: String(row?.label || `Server ${index + 1}`).trim().slice(0,80) || `Server ${index + 1}`,
      baseUrl: String(row?.baseUrl || row?.wardogsBaseUrl || '').trim().replace(/\/+$/,''),
      secretEnc: String(row?.secretEnc || row?.wardogsSecretEnc || ''),
      alertChannelId: /^\d{17,20}$/.test(String(row?.alertChannelId || '')) ? String(row.alertChannelId) : '',
      controlPanelEnabled: row?.controlPanelEnabled === true,
      controlPanelChannelId: /^\d{17,20}$/.test(String(row?.controlPanelChannelId || '')) ? String(row.controlPanelChannelId) : '',
      controlPanelMessageId: /^\d{17,20}$/.test(String(row?.controlPanelMessageId || '')) ? String(row.controlPanelMessageId) : '',
      controlPanelMessageChannelId: /^\d{17,20}$/.test(String(row?.controlPanelMessageChannelId || '')) ? String(row.controlPanelMessageChannelId) : '',
      dynamicNameOriginalName: String(row?.dynamicNameOriginalName || '').replace(/[\r\n\0]/g,' ').trim().slice(0,96),
      dynamicNameLastAppliedName: String(row?.dynamicNameLastAppliedName || '').replace(/[\r\n\0]/g,' ').trim().slice(0,96),
      killFeedTokenEnc: String(row?.killFeedTokenEnc || ''), killFeedConfiguredAt: row?.killFeedConfiguredAt || null,
      killFeedPublicUrl: String(row?.killFeedPublicUrl || '').slice(0,300), killFeedNeedsGameRestart: row?.killFeedNeedsGameRestart === true,
      killFeedLastEventAt: row?.killFeedLastEventAt || null, killFeedEvents: (Array.isArray(row?.killFeedEvents) ? row.killFeedEvents : []).slice(-150)
    })).filter((row)=>row.baseUrl && row.secretEnc).slice(0,12),
    accessSource: String(b.accessSource || ''),
    accessRecordId: String(b.accessRecordId || ''),
    accessUntil: b.accessUntil || null,
    adminGrant: Boolean(b.adminGrant),
    statsTimezone: String(b.statsTimezone || 'Europe/Vienna').slice(0, 80),
    leaderboardChannelId: /^\d{17,20}$/.test(String(b.leaderboardChannelId || '')) ? String(b.leaderboardChannelId) : '',
    leaderboardMessageId: /^\d{17,20}$/.test(String(b.leaderboardMessageId || '')) ? String(b.leaderboardMessageId) : '',
    lastLeaderboardAt: b.lastLeaderboardAt || null,
    discordPlayerLinks: (Array.isArray(b.discordPlayerLinks) ? b.discordPlayerLinks : []).map((row) => ({
      discordUserId: String(row?.discordUserId || ''), steamId: String(row?.steamId || ''), playerName: String(row?.playerName || '').trim().slice(0, 100),
      linkedAt: row?.linkedAt || null, lastVerifiedAt: row?.lastVerifiedAt || row?.linkedAt || null
    })).filter((row) => /^\d{17,20}$/.test(row.discordUserId) && /^\d{17}$/.test(row.steamId))
      .filter((row, index, rows) => rows.findIndex((x) => x.discordUserId === row.discordUserId) === index)
      .filter((row, index, rows) => rows.findIndex((x) => x.steamId === row.steamId) === index).slice(-5000),
    playerLinkChallenges: (Array.isArray(b.playerLinkChallenges) ? b.playerLinkChallenges : []).map((row) => ({
      discordUserId: String(row?.discordUserId || ''), steamId: String(row?.steamId || ''), playerName: String(row?.playerName || '').trim().slice(0, 100),
      serverId: String(row?.serverId || '').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 64), codeHash: String(row?.codeHash || '').slice(0, 64),
      expiresAt: row?.expiresAt || null, attempts: Math.max(0, Math.min(5, Math.floor(Number(row?.attempts) || 0))), createdAt: row?.createdAt || null
    })).filter((row) => /^\d{17,20}$/.test(row.discordUserId) && /^\d{17}$/.test(row.steamId) && /^[0-9a-f]{64}$/i.test(row.codeHash) && Number.isFinite(Date.parse(row.expiresAt || ''))).slice(-100),
    playtimeStats: b.playtimeStats && typeof b.playtimeStats === 'object' ? b.playtimeStats : null,
    playtimeServers: (Array.isArray(b.playtimeServers) ? b.playtimeServers : []).map((row,index)=>({
      id: String(row?.id || `server-${index + 1}`).replace(/[^a-zA-Z0-9_-]+/g,'-').slice(0,64) || `server-${index + 1}`,
      label: String(row?.label || `Server ${index + 1}`).trim().slice(0,80) || `Server ${index + 1}`,
      baseUrl: String(row?.baseUrl || row?.wardogsBaseUrl || '').trim().replace(/\/+$/,''),
      secretEnc: String(row?.secretEnc || row?.wardogsSecretEnc || ''),
      killFeedChannelId: /^\d{17,20}$/.test(String(row?.killFeedChannelId || '')) ? String(row.killFeedChannelId) : '',
      killFeedMessageId: /^\d{17,20}$/.test(String(row?.killFeedMessageId || '')) ? String(row.killFeedMessageId) : '',
      killFeedTokenEnc: String(row?.killFeedTokenEnc || ''),
      killFeedConfiguredAt: row?.killFeedConfiguredAt || null,
      killFeedPublicUrl: String(row?.killFeedPublicUrl || '').slice(0,300),
      killFeedNeedsGameRestart: row?.killFeedNeedsGameRestart === true,
      killFeedLastEventAt: row?.killFeedLastEventAt || null,
      killFeedLastPublishedAt: row?.killFeedLastPublishedAt || null,
      killFeedEvents: (Array.isArray(row?.killFeedEvents) ? row.killFeedEvents : []).slice(-150)
    })).filter((row)=>row.baseUrl).slice(0,12)
  }));
  return parsed;
}

function ensure() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) writeDb(emptyDb());
}

export function readDb() {
  ensure();
  try {
    const stored = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    const parsed = stored?.format === 'encrypted-db-v1' && stored?.data
      ? JSON.parse(decryptSecret(stored.data))
      : stored;
    return migrate(parsed);
  } catch (error) { throw new Error(`Datenbank konnte nicht gelesen werden: ${error.message}`); }
}

export function writeDb(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const payload = { format: 'encrypted-db-v1', data: encryptSecret(JSON.stringify(db)) };
  fs.writeFileSync(TMP_FILE, JSON.stringify(payload), { mode: 0o600 });
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
    for (const b of db.managedBots || []) if (!b.ownerDiscordId) b.ownerDiscordId = adminDiscordId;
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
    const entry = { role: 'user', planId: 'free', planExpiresAt: null, statusBotLimitOverride: null, customBotLimit: 0, locale: 'de', freeBoost: null, freeRenewExempt: false, freeRenewedAt: now, freeRenewGraceStartedAt: null, premiumDowngradeStartedAt: null, premiumDowngradeUntil: null, premiumDowngradeKeepServerId: null, createdAt: now, updatedAt: now, ...user };
    db.users.push(entry); return entry;
  });
}
export function deleteUser(discordId) { updateDb((db) => {
  db.users = db.users.filter((u) => u.discordId !== discordId);
  for (const bot of db.managedBots || []) bot.sharedPanelUserIds = (Array.isArray(bot.sharedPanelUserIds) ? bot.sharedPanelUserIds : []).filter((id) => id !== discordId);
}); }

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

export function getManagedBot(id) { return (readDb().managedBots || []).find((b) => b.id === id) || null; }
export function listManagedBotsForUserService(discordId, serviceId) { return (readDb().managedBots || []).filter((b) => b.ownerDiscordId === discordId && b.serviceId === serviceId).sort((a,b) => String(a.createdAt || '').localeCompare(String(b.createdAt || ''))); }
export function listManagedBotsAccessibleToUserService(discordId, serviceId, isAdmin = false) { return (readDb().managedBots || []).filter((b) => b.serviceId === serviceId && (isAdmin || b.ownerDiscordId === discordId || (Array.isArray(b.sharedPanelUserIds) && b.sharedPanelUserIds.includes(discordId)))).sort((a,b) => String(a.createdAt || '').localeCompare(String(b.createdAt || ''))); }
export function getManagedBotForUserService(discordId, serviceId) { return listManagedBotsForUserService(discordId, serviceId)[0] || null; }
export function getManagedBotByAccessRecord(accessRecordId) { const id = String(accessRecordId || ''); return id ? (readDb().managedBots || []).find((b) => String(b.accessRecordId || '') === id) || null : null; }
export function listManagedBotsFor(discordId, isAdmin = false) { const bots = readDb().managedBots || []; return isAdmin ? bots : bots.filter((b) => b.ownerDiscordId === discordId); }
export function listManagedBotsAccessibleFor(discordId, isAdmin = false) { const bots = readDb().managedBots || []; return isAdmin ? bots : bots.filter((b) => b.ownerDiscordId === discordId || (Array.isArray(b.sharedPanelUserIds) && b.sharedPanelUserIds.includes(discordId))); }
export function upsertManagedBot(bot) {
  return updateDb((db) => {
    if (!Array.isArray(db.managedBots)) db.managedBots = [];
    const now = new Date().toISOString();
    const index = db.managedBots.findIndex((b) => b.id === bot.id);
    if (index >= 0) { db.managedBots[index] = { ...db.managedBots[index], ...bot, updatedAt: now }; return db.managedBots[index]; }
    const entry = { id: bot.id || crypto.randomUUID(), enabled: false, sharedPanelUserIds: [], wardogsAuthLockedAt: null, wardogsAuthLockedReason: '', wardogsAuthFailureCount: 0, managedServers: [], autoBanEnabled: false, autoRecoveryEnabled: true, banDiscordLink: '', banTemplates: [], temporaryBans: [], dynamicBanEnabled: false, dynamicBanEscalateJoins: 3, dynamicBanEscalateWindowMinutes: 5, dynamicBans: [], banSyncServerId: '', banSyncTargetBotId: '', banSyncRequests: [], banSyncAcceptedSources: [], banSyncMirrors: [], auditLog: [], announcementEnabled: false, announcementIntervalMinutes: 15, announcementMessages: '', dynamicNameEnabled: false, dynamicNameStatsEnabled: false, dynamicNameStatsTemplate: '{base} | {score1} | {score2} | {score3}', dynamicNameSeedingEnabled: false, dynamicNameSeedingMinPlayers: 1, dynamicNameSeedingMaxPlayers: 20, dynamicNameSeedingTemplate: 'JOIN SEEDING', dynamicNameRotationEnabled: false, dynamicNameRotationNameA: '', dynamicNameRotationNameB: '', dynamicNameRotationMinutes: 5, dynamicNameOriginalName: '', dynamicNameLastAppliedName: '', pollSeconds: 20, rulesText: '', legacyJoinSeedingCleanupDone: true, playtimeServers: [], steamWebApiKeyEnc: '', steamAppId: '1867240', ignoredPlayers: [], statsTimezone: 'Europe/Vienna', leaderboardChannelId: '', leaderboardMessageId: '', lastLeaderboardAt: null, discordPlayerLinks: [], playerLinkChallenges: [], playtimeStats: null, killFeedTokenEnc: '', killFeedConfiguredAt: null, killFeedPublicUrl: '', killFeedNeedsGameRestart: false, killFeedLastEventAt: null, killFeedChannelId: '', killFeedMessageId: '', killFeedLastPublishedAt: null, killFeedEvents: [], killStats: null, createdAt: now, updatedAt: now, ...bot };
    db.managedBots.push(entry); return entry;
  });
}
export function deleteManagedBot(id) { updateDb((db) => {
  db.managedBots = (db.managedBots || []).filter((b) => b.id !== id);
  db.banSyncServers = (db.banSyncServers || []).map((room) => {
    const members = (Array.isArray(room.members) ? room.members : []).filter((memberId) => memberId !== id);
    if (!members.length) return null;
    return { ...room, members, ownerBotId: room.ownerBotId === id ? members[0] : room.ownerBotId, updatedAt: new Date().toISOString() };
  }).filter(Boolean);
}); }

export function listBanSyncServers() { return readDb().banSyncServers || []; }
export function getBanSyncServer(id) { return listBanSyncServers().find((room) => room.id === String(id || '')) || null; }
export function upsertBanSyncServer(room) {
  return updateDb((db) => {
    if (!Array.isArray(db.banSyncServers)) db.banSyncServers = [];
    const now = new Date().toISOString();
    const index = db.banSyncServers.findIndex((x) => x.id === room.id);
    if (index >= 0) { db.banSyncServers[index] = { ...db.banSyncServers[index], ...room, updatedAt: now }; return db.banSyncServers[index]; }
    const entry = { id: room.id || crypto.randomUUID(), createdAt: now, updatedAt: now, members: [], dynamicBanEnabled: false, dynamicBanEscalateJoins: 3, dynamicBanEscalateWindowMinutes: 5, sharedBans: [], ...room };
    db.banSyncServers.push(entry); return entry;
  });
}
export function deleteBanSyncServer(id) { updateDb((db) => { db.banSyncServers = (db.banSyncServers || []).filter((room) => room.id !== String(id || '')); }); }

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
export function deleteStatusNode(id) { updateDb((db) => { db.statusNodes = (db.statusNodes || []).filter((n) => n.id !== id); for (const s of [...db.servers, ...(db.managedBots || []), ...(db.customBots || [])]) if (s.assignedNodeId === id) s.assignedNodeId = null; }); }

export function getSiteSettings() { return readDb().siteSettings; }
export function updateSiteSettings(patch) { return updateDb((db) => { db.siteSettings = mergeSettings({ ...db.siteSettings, ...patch, donationLinks: { ...(db.siteSettings?.donationLinks || {}), ...(patch.donationLinks || {}) }, premiumSales: { ...(db.siteSettings?.premiumSales || {}), ...(patch.premiumSales || {}), prices: { ...(db.siteSettings?.premiumSales?.prices || {}), ...(patch.premiumSales?.prices || {}) }, paypalApi: { ...(db.siteSettings?.premiumSales?.paypalApi || {}), ...(patch.premiumSales?.paypalApi || {}) }, paypalAuto: { ...(db.siteSettings?.premiumSales?.paypalAuto || {}), ...(patch.premiumSales?.paypalAuto || {}), amounts: { ...(db.siteSettings?.premiumSales?.paypalAuto?.amounts || {}), ...(patch.premiumSales?.paypalAuto?.amounts || {}) } }, paypalSubscription: { ...(db.siteSettings?.premiumSales?.paypalSubscription || {}), ...(patch.premiumSales?.paypalSubscription || {}), planIds: { ...(db.siteSettings?.premiumSales?.paypalSubscription?.planIds || {}), ...(patch.premiumSales?.paypalSubscription?.planIds || {}) }, planMeta: { ...(db.siteSettings?.premiumSales?.paypalSubscription?.planMeta || {}), ...(patch.premiumSales?.paypalSubscription?.planMeta || {}) }, amounts: { ...(db.siteSettings?.premiumSales?.paypalSubscription?.amounts || {}), ...(patch.premiumSales?.paypalSubscription?.amounts || {}) } }, stripeApi: { ...(db.siteSettings?.premiumSales?.stripeApi || {}), ...(patch.premiumSales?.stripeApi || {}) }, stripeAuto: { ...(db.siteSettings?.premiumSales?.stripeAuto || {}), ...(patch.premiumSales?.stripeAuto || {}), amounts: { ...(db.siteSettings?.premiumSales?.stripeAuto?.amounts || {}), ...(patch.premiumSales?.stripeAuto?.amounts || {}) } }, stripeSubscription: { ...(db.siteSettings?.premiumSales?.stripeSubscription || {}), ...(patch.premiumSales?.stripeSubscription || {}), amounts: { ...(db.siteSettings?.premiumSales?.stripeSubscription?.amounts || {}), ...(patch.premiumSales?.stripeSubscription?.amounts || {}) } } }, freeBoost: { ...(db.siteSettings?.freeBoost || {}), ...(patch.freeBoost || {}) } }); return db.siteSettings; }); }

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


export function createPaypalSubscriptionRecord(subscription) {
  return updateDb((db) => {
    if (!Array.isArray(db.paypalSubscriptions)) db.paypalSubscriptions = [];
    const now = new Date().toISOString();
    const entry = { id: subscription.id || crypto.randomUUID(), status: 'creating', createdAt: now, updatedAt: now, ...subscription };
    db.paypalSubscriptions.push(entry);
    return entry;
  });
}
export function getPaypalSubscriptionRecord(id) { return (readDb().paypalSubscriptions || []).find((x) => x.id === id) || null; }
export function getPaypalSubscriptionByPaypalId(subscriptionId) { return (readDb().paypalSubscriptions || []).find((x) => x.subscriptionId === subscriptionId) || null; }
export function listPaypalSubscriptionsForUser(discordId) { return (readDb().paypalSubscriptions || []).filter((x) => x.userDiscordId === discordId).sort((a,b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))); }
export function updatePaypalSubscriptionRecord(id, patch) {
  return updateDb((db) => {
    if (!Array.isArray(db.paypalSubscriptions)) db.paypalSubscriptions = [];
    const index = db.paypalSubscriptions.findIndex((x) => x.id === id);
    if (index < 0) return null;
    db.paypalSubscriptions[index] = { ...db.paypalSubscriptions[index], ...patch, updatedAt: new Date().toISOString() };
    return db.paypalSubscriptions[index];
  });
}

export function createPaypalServiceSubscriptionRecord(subscription) {
  return updateDb((db) => {
    if (!Array.isArray(db.paypalServiceSubscriptions)) db.paypalServiceSubscriptions = [];
    const now = new Date().toISOString();
    const entry = { id: subscription.id || crypto.randomUUID(), status: 'creating', createdAt: now, updatedAt: now, ...subscription };
    db.paypalServiceSubscriptions.push(entry);
    return entry;
  });
}
export function getPaypalServiceSubscriptionRecord(id) { return (readDb().paypalServiceSubscriptions || []).find((x) => x.id === id) || null; }
export function getPaypalServiceSubscriptionByPaypalId(subscriptionId) { return (readDb().paypalServiceSubscriptions || []).find((x) => x.subscriptionId === subscriptionId) || null; }
export function listPaypalServiceSubscriptionsForUser(discordId, serviceId = '') { return (readDb().paypalServiceSubscriptions || []).filter((x) => x.userDiscordId === discordId && (!serviceId || x.serviceId === serviceId)).sort((a,b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))); }
export function updatePaypalServiceSubscriptionRecord(id, patch) {
  return updateDb((db) => {
    if (!Array.isArray(db.paypalServiceSubscriptions)) db.paypalServiceSubscriptions = [];
    const index = db.paypalServiceSubscriptions.findIndex((x) => x.id === id);
    if (index < 0) return null;
    db.paypalServiceSubscriptions[index] = { ...db.paypalServiceSubscriptions[index], ...patch, updatedAt: new Date().toISOString() };
    return db.paypalServiceSubscriptions[index];
  });
}


export function createStripePurchase(purchase) {
  return updateDb((db) => {
    if (!Array.isArray(db.stripePurchases)) db.stripePurchases = [];
    const now = new Date().toISOString();
    const entry = { id: purchase.id || crypto.randomUUID(), status: 'created', createdAt: now, updatedAt: now, ...purchase };
    db.stripePurchases.push(entry); return entry;
  });
}
export function getStripePurchase(id) { return (readDb().stripePurchases || []).find((x) => x.id === id) || null; }
export function getStripePurchaseBySession(sessionId) { return (readDb().stripePurchases || []).find((x) => x.sessionId === sessionId) || null; }
export function updateStripePurchase(id, patch) {
  return updateDb((db) => { const i=(db.stripePurchases||[]).findIndex((x)=>x.id===id); if(i<0)return null; db.stripePurchases[i]={...db.stripePurchases[i],...patch,updatedAt:new Date().toISOString()}; return db.stripePurchases[i]; });
}
export function createStripeSubscriptionRecord(record) {
  return updateDb((db) => { if(!Array.isArray(db.stripeSubscriptions))db.stripeSubscriptions=[]; const now=new Date().toISOString(); const entry={id:record.id||crypto.randomUUID(),status:'creating',createdAt:now,updatedAt:now,...record}; db.stripeSubscriptions.push(entry); return entry; });
}
export function getStripeSubscriptionRecord(id) { return (readDb().stripeSubscriptions || []).find((x)=>x.id===id)||null; }
export function getStripeSubscriptionByStripeId(subscriptionId) { return (readDb().stripeSubscriptions || []).find((x)=>x.subscriptionId===subscriptionId)||null; }
export function getStripeSubscriptionBySession(sessionId) { return (readDb().stripeSubscriptions || []).find((x)=>x.sessionId===sessionId)||null; }
export function listStripeSubscriptionsForUser(discordId) { return (readDb().stripeSubscriptions || []).filter((x)=>x.userDiscordId===discordId).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||''))); }
export function updateStripeSubscriptionRecord(id, patch) {
  return updateDb((db) => { const i=(db.stripeSubscriptions||[]).findIndex((x)=>x.id===id); if(i<0)return null; db.stripeSubscriptions[i]={...db.stripeSubscriptions[i],...patch,updatedAt:new Date().toISOString()}; return db.stripeSubscriptions[i]; });
}
export function rememberStripeWebhookEvent(eventId, eventType) {
  return updateDb((db)=>{ if(!Array.isArray(db.stripeWebhookEvents))db.stripeWebhookEvents=[]; if(db.stripeWebhookEvents.some((x)=>x.id===eventId))return false; db.stripeWebhookEvents.push({id:eventId,eventType,processedAt:new Date().toISOString()}); if(db.stripeWebhookEvents.length>1000)db.stripeWebhookEvents=db.stripeWebhookEvents.slice(-1000); return true; });
}
export function stripeWebhookEventSeen(eventId) { return (readDb().stripeWebhookEvents || []).some((x)=>x.id===eventId); }
