import { decryptSecret } from './crypto.js';
import { managedRulesNeedSteam } from './managed-rules.js';

const cache = new Map();
const CACHE_MS = 5 * 60_000;
export const WARDOGS_STEAM_APP_ID = '1867240';
function validSteamId(value) { return /^\d{17}$/.test(String(value || '').trim()); }
export function steamApiKeyAvailable(bot) {
  if (String(process.env.STEAM_WEB_API_KEY || '').trim()) return true;
  if (!bot?.steamWebApiKeyEnc) return false;
  try { return Boolean(String(decryptSecret(bot.steamWebApiKeyEnc) || '').trim()); } catch { return false; }
}
function steamApiKey(bot) {
  if (bot?.steamWebApiKeyEnc) { try { const own=String(decryptSecret(bot.steamWebApiKeyEnc)||'').trim(); if(own)return own; } catch {} }
  return String(process.env.STEAM_WEB_API_KEY || '').trim();
}
async function steamRequest(pathname, params, key) {
  const url=new URL(`https://api.steampowered.com${pathname}`);url.searchParams.set('key',key);
  for(const [name,value] of Object.entries(params||{}))if(value!==undefined&&value!==null&&String(value)!=='')url.searchParams.set(name,String(value));
  const response=await fetch(url,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(8000)});if(!response.ok)throw new Error(`Steam Web API ${response.status}`);return response.json();
}
function ruleTypes(rules){return new Set((rules||[]).map((rule)=>String(rule?.type||'')));}
function chunks(items,size){const out=[];for(let i=0;i<items.length;i+=size)out.push(items.slice(i,i+size));return out;}
function cacheKey(steamId,appId,types){return `${steamId}:${appId}:${[...types].sort().join(',')}`;}
async function withConcurrency(items,limit,worker){const results=new Array(items.length);let next=0;async function run(){while(true){const i=next++;if(i>=items.length)return;results[i]=await worker(items[i],i);}}await Promise.all(Array.from({length:Math.min(limit,items.length)},()=>run()));return results;}

export async function getSteamRiskProfiles(bot, steamIds, rules = []) {
  const ids=[...new Set((steamIds||[]).map((x)=>String(x||'').trim()).filter(validSteamId))].slice(0,500),out=new Map();
  if(!ids.length||!managedRulesNeedSteam(rules))return out;
  const key=steamApiKey(bot);if(!key)throw new Error('Steam Web API key is missing for the enabled detection rules');
  const types=ruleTypes(rules),appId=String(bot?.steamAppId||WARDOGS_STEAM_APP_ID).trim()||WARDOGS_STEAM_APP_ID,pending=[];
  for(const steamId of ids){const cached=cache.get(cacheKey(steamId,appId,types));if(cached&&Date.now()-cached.at<CACHE_MS)out.set(steamId,cached.value);else pending.push(steamId);}
  if(!pending.length)return out;
  const profiles=new Map(pending.map((steamId)=>[steamId,{steamId,vacBans:null,gameBans:null,daysSinceLastBan:null,communityBanned:null,economyBanned:null,profilePrivate:null,accountAgeDays:null,playtimeHours:null}]));
  const needsBans=['vac_bans','game_bans','recent_ban','community_ban','economy_ban'].some((type)=>types.has(type));
  const needsSummary=types.has('account_age')||types.has('private_profile')||types.has('playtime');
  if(needsBans)for(const group of chunks(pending,100)){const data=await steamRequest('/ISteamUser/GetPlayerBans/v1/',{steamids:group.join(',')},key);for(const bans of Array.isArray(data?.players)?data.players:[]){const row=profiles.get(String(bans?.SteamId||bans?.steamid||''));if(!row)continue;row.vacBans=Number(bans.NumberOfVACBans||0);row.gameBans=Number(bans.NumberOfGameBans||0);row.daysSinceLastBan=Number(bans.DaysSinceLastBan||0);row.communityBanned=bans.CommunityBanned===true;row.economyBanned=String(bans.EconomyBan||'none').toLowerCase()!=='none';}}
  if(needsSummary)for(const group of chunks(pending,100)){const data=await steamRequest('/ISteamUser/GetPlayerSummaries/v2/',{steamids:group.join(',')},key);for(const summary of Array.isArray(data?.response?.players)?data.response.players:[]){const row=profiles.get(String(summary?.steamid||''));if(!row)continue;row.profilePrivate=Number(summary.communityvisibilitystate||0)!==3;const created=Number(summary.timecreated||0);if(created>0)row.accountAgeDays=Math.max(0,Math.floor((Date.now()/1000-created)/86400));}}
  if(types.has('playtime'))await withConcurrency(pending,6,async(steamId)=>{const row=profiles.get(steamId);if(!row||row.profilePrivate!==false)return;try{const owned=await steamRequest('/IPlayerService/GetOwnedGames/v1/',{steamid:steamId,include_appinfo:0,include_played_free_games:1,'appids_filter[0]':appId},key),games=Array.isArray(owned?.response?.games)?owned.response.games:[],game=games.find((entry)=>String(entry?.appid||'')===appId);row.playtimeHours=game?Math.round((Number(game.playtime_forever||0)/60)*10)/10:0;}catch{row.playtimeHours=null;}});
  for(const [steamId,value] of profiles){out.set(steamId,value);cache.set(cacheKey(steamId,appId,types),{at:Date.now(),value});}
  if(cache.size>2000){const oldest=[...cache.entries()].sort((a,b)=>a[1].at-b[1].at).slice(0,400);for(const [keyName] of oldest)cache.delete(keyName);}return out;
}
export async function getSteamRiskProfile(bot,steamId,rules=[]){if(!validSteamId(steamId))throw new Error('Invalid SteamID64');const profiles=await getSteamRiskProfiles(bot,[steamId],rules);return profiles.get(String(steamId))||null;}
