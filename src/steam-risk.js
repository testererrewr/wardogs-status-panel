import { decryptSecret } from './crypto.js';
import { managedRulesNeedSteam } from './managed-rules.js';

const cache = new Map();
const CACHE_MS = 5 * 60_000;

function validSteamId(value) { return /^\d{17}$/.test(String(value || '').trim()); }

export function steamApiKeyAvailable(bot) {
  if (String(process.env.STEAM_WEB_API_KEY || '').trim()) return true;
  if (!bot?.steamWebApiKeyEnc) return false;
  try { return Boolean(String(decryptSecret(bot.steamWebApiKeyEnc) || '').trim()); } catch { return false; }
}

function steamApiKey(bot) {
  if (bot?.steamWebApiKeyEnc) {
    try {
      const own = String(decryptSecret(bot.steamWebApiKeyEnc) || '').trim();
      if (own) return own;
    } catch {}
  }
  return String(process.env.STEAM_WEB_API_KEY || '').trim();
}

async function steamRequest(pathname, params, key) {
  const url = new URL(`https://api.steampowered.com${pathname}`);
  url.searchParams.set('key', key);
  for (const [name, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && String(value) !== '') url.searchParams.set(name, String(value));
  }
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Steam Web API ${response.status}`);
  return response.json();
}

function ruleTypes(rules) { return new Set((rules || []).map((rule) => String(rule?.type || ''))); }

export async function getSteamRiskProfile(bot, steamId, rules = []) {
  if (!validSteamId(steamId)) throw new Error('Ungültige SteamID64');
  if (!managedRulesNeedSteam(rules)) return null;
  const key = steamApiKey(bot);
  if (!key) throw new Error('Steam Web API Key fehlt für die aktivierten Detection Rules');

  const types = ruleTypes(rules);
  const appId = String(bot?.steamAppId || '').trim();
  if (types.has('playtime') && !/^\d{1,10}$/.test(appId)) throw new Error('Steam App ID fehlt für die Spielzeit-Regel');

  const cacheKey = `${steamId}:${appId || '-'}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;

  const needsBans = ['vac_bans','game_bans','recent_ban','community_ban','economy_ban'].some((type) => types.has(type));
  const needsSummary = types.has('account_age') || types.has('private_profile') || types.has('playtime');
  const result = {
    steamId,
    vacBans: null,
    gameBans: null,
    daysSinceLastBan: null,
    communityBanned: null,
    economyBanned: null,
    profilePrivate: null,
    accountAgeDays: null,
    playtimeHours: null
  };

  const [bansResult, summaryResult] = await Promise.allSettled([
    needsBans ? steamRequest('/ISteamUser/GetPlayerBans/v1/', { steamids: steamId }, key) : Promise.resolve(null),
    needsSummary ? steamRequest('/ISteamUser/GetPlayerSummaries/v2/', { steamids: steamId }, key) : Promise.resolve(null)
  ]);

  if (needsBans) {
    if (bansResult.status === 'rejected') throw bansResult.reason;
    const bans = Array.isArray(bansResult.value?.players) ? bansResult.value.players[0] : null;
    if (bans) {
      result.vacBans = Number(bans.NumberOfVACBans || 0);
      result.gameBans = Number(bans.NumberOfGameBans || 0);
      result.daysSinceLastBan = Number(bans.DaysSinceLastBan || 0);
      result.communityBanned = bans.CommunityBanned === true;
      result.economyBanned = String(bans.EconomyBan || 'none').toLowerCase() !== 'none';
    }
  }

  let summary = null;
  if (needsSummary) {
    if (summaryResult.status === 'rejected') throw summaryResult.reason;
    summary = Array.isArray(summaryResult.value?.response?.players) ? summaryResult.value.response.players[0] : null;
    if (summary) {
      result.profilePrivate = Number(summary.communityvisibilitystate || 0) !== 3;
      const created = Number(summary.timecreated || 0);
      if (created > 0) result.accountAgeDays = Math.max(0, Math.floor((Date.now() / 1000 - created) / 86400));
    }
  }

  if (types.has('playtime') && summary && result.profilePrivate === false) {
    try {
      const owned = await steamRequest('/IPlayerService/GetOwnedGames/v1/', {
        steamid: steamId,
        include_appinfo: 0,
        include_played_free_games: 1,
        'appids_filter[0]': appId
      }, key);
      const games = Array.isArray(owned?.response?.games) ? owned.response.games : [];
      const game = games.find((entry) => String(entry?.appid || '') === appId);
      result.playtimeHours = game ? Math.round((Number(game.playtime_forever || 0) / 60) * 10) / 10 : 0;
    } catch {
      result.playtimeHours = null;
    }
  }

  cache.set(cacheKey, { at: Date.now(), value: result });
  if (cache.size > 1000) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 200);
    for (const [keyName] of oldest) cache.delete(keyName);
  }
  return result;
}
