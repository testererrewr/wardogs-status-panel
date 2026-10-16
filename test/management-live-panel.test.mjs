import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const code=fs.readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
const refresh=fs.readFileSync(new URL('../public/managed-live-refresh.js',import.meta.url),'utf8');
const health=code.slice(code.indexOf("app.get('/bot-health'"),code.indexOf("// Server-side latency trace"));
const live=code.slice(code.indexOf("app.get('/bot-services/:id/live'"),code.indexOf("app.get('/bot-services/:id/stats'"));
test('bot health is restricted to actual owners including for admins',()=>{
  assert.match(health,/filter\(bot=>String\(bot.ownerDiscordId\|\|''\)===String\(user.discordId\)\)/);
  assert.match(health,/const ownerVisible = row => String\(row.ownerDiscordId\|\|''\)===String\(user.discordId\)/);
});
test('live and killfeed fragments have access checks and separate auto refresh',()=>{
  assert.match(live,/managedAccessActive\(bot\)/);
  assert.match(live,/autoRefreshSeconds:20/);
  assert.match(live,/app.get\('\/bot-services\/:id\/feed'/);
  assert.match(live,/autoRefreshSeconds:12/);
  assert.match(live,/row=servers.find/);
  assert.match(code,/managedLazyFrame\(req,`\/bot-services\/\$\{encodeURIComponent\(service.id\)\}\/feed/);
  assert.match(code,/document.currentScript\?\.previousElementSibling/);
  assert.match(refresh,/window.location.replace/);
  assert.match(refresh,/document.visibilityState/);
  assert.match(refresh,/document.activeElement/);
});
test('an unknown ban API response cannot be presented as no bans',()=>{
  assert.match(code,/banResult=normalizeManagedBans\(live.bans\)/);
  assert.match(code,/!banResult.available\?/);
});
test('secret season two configuration is only available to the owning panel user',()=>{
  const route=code.slice(code.indexOf("app.get('/managed-bots/:id/feed-setup/manual'"), code.indexOf("app.post('/managed-bots/:id/killfeed/setup/:serverId'"));
  assert.match(route,/String\(bot.ownerDiscordId\|\|''\)!==String\(user.discordId\|\|''\)/);
  assert.match(route,/Cache-Control','private, no-store'/);
  assert.match(route,/Referrer-Policy','no-referrer'/);
  assert.match(route,/seasonTwoFeedConfig/);
  assert.match(code,/manualRequired\?'Season 2/);
});
