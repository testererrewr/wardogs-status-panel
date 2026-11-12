import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const index=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
const feeds=readFileSync(new URL('../src/kill-stats.js',import.meta.url),'utf8');
const manager=readFileSync(new URL('../src/managed-bots.js',import.meta.url),'utf8');
test('Season 2 feed can be skipped without modifying the game-host CFG',()=>{
  assert.match(index,/management-feed\/skip\/:serverId/);
  assert.match(index,/killFeedSetupMode:'skipped',killFeedNeedsGameRestart:false/);
  assert.match(index,/Ohne Server-CFG fortfahren/);
  assert.match(feeds,/killFeedSetupMode:'manual',killFeedNeedsGameRestart:false/);
});
test('welcome and auto level management do not depend on incoming event feed',()=>{
  assert.match(manager,/pollManagedWelcome\(server, serverState\)/);
  assert.match(manager,/UNLIMITED_LEVEL_CANDIDATES/);
  assert.match(manager,/levelCapOpened/);
});
