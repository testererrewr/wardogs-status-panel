import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const index = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../src/html.js', import.meta.url), 'utf8');
const manager = fs.readFileSync(new URL('../src/bot-manager.js', import.meta.url), 'utf8');
const managedForm = index.slice(index.indexOf('function managedBotForm'), index.indexOf('function playtimeServersFromBody'));
const playtimeForm = index.slice(index.indexOf('function playtimeTrackerForm'), index.indexOf('function playtimeStatsPanel'));

test('classic status bot has no killfeed configuration or runtime', () => {
  assert.equal(index.includes("/servers/:id/killfeed/configure"), false);
  assert.equal(index.includes("/servers/:id/stats"), false);
  assert.equal(html.includes('name="killFeedChannelId"'), false);
  assert.equal(manager.includes('publishKillfeed('), false);
  assert.equal(manager.includes('statusstats:'), false);
});

test('former playtime tracker keeps per-server killfeed controls', () => {
  assert.equal(index.includes('trackerServerKillFeedChannelId_'), true);
  assert.equal(index.includes('killfeed/setup/${esc(row.id)}'), true);
});

test('management bot token is not described as optional/top-25 token', () => {
  assert.equal(managedForm.includes("Discord Bot Token (${tr(lang,'optional','optional')})"), false);
  assert.equal(managedForm.includes('needed for killfeed & Discord Top 25'), false);
  assert.equal(managedForm.includes('Pflicht für Discord Alerts und Management Panel'), true);
  assert.equal(playtimeForm.includes('Pflicht für Discord Killfeed, Slash Commands und Top-15 Leaderboard'), true);
});


test('status bot killfeed is compact and player search can disambiguate matches', () => {
  const tracker = fs.readFileSync(new URL('../src/playtime-tracker.js', import.meta.url), 'utf8');
  assert.equal(tracker.includes("name: 'Server events'"), false);
  assert.equal(tracker.includes('StringSelectMenuBuilder'), true);
  assert.equal(tracker.includes('wdstatus:pick:'), true);
  assert.equal(tracker.includes('Mehrere Spieler passen zu'), true);
});

test('technical WARDOGS causes have readable aliases', () => {
  const stats = fs.readFileSync(new URL('../src/kill-stats.js', import.meta.url), 'utf8');
  assert.equal(stats.includes("'Aircraft rotor'"), true);
  assert.equal(stats.includes("'Vehicle weapon'"), true);
});
