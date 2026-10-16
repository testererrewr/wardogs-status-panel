import test from 'node:test';
import assert from 'node:assert/strict';
import { sharedServerBanRows, mergeSharedServerBans, removeSharedServerBan, combinedManagedBanList, sharedBanActionTargets } from '../src/managed-shared-bans.js';

const id1 = '76561198000000001';
const id2 = '76561198000000002';
test('shared list is a bot-scoped distinct set, separate bots do not share records', () => {
  const botA = { id: 'bot-a', sharedServerBans: [{ steamId: id1, reason: 'rule', mode: 'permanent' }] };
  const botB = { id: 'bot-b', sharedServerBans: [] };
  assert.equal(sharedServerBanRows(botA).length, 1);
  assert.equal(sharedServerBanRows(botB).length, 0);
  assert.deepEqual(mergeSharedServerBans(botA, [{ steamId: id2, reason: 'abuse', mode: 'permanent' }]).map(x => x.steamId), [id1,id2]);
  assert.deepEqual(removeSharedServerBan(botA,id1), []);
});

test('expired temporary bans disappear and cannot replace stronger permanent bans', () => {
  const now = Date.now();
  const expired = { steamId: id1, mode: 'temporary', expiresAt: new Date(now-60000).toISOString() };
  const permanent = { steamId:id1, reason:'old', mode:'permanent' };
  assert.deepEqual(sharedServerBanRows({sharedServerBans:[expired]}), []);
  const reduced = mergeSharedServerBans({sharedServerBans:[permanent]}, [{steamId:id1,reason:'new',mode:'temporary',expiresAt:new Date(now+60000).toISOString()}]);
  assert.equal(reduced[0].mode, 'permanent');
});

test('combined view unions current WARDOGS list with shared intent', () => {
  const shared = { sharedServerBans:[{steamId:id1,reason:'Across all servers',mode:'permanent'}] };
  const rows = combinedManagedBanList([{steamId:id2,reason:'Local only'}],shared);
  assert.equal(rows.length,2);
  assert.equal(rows.find(x=>x.steamId===id1).shared,true);
  assert.equal(rows.find(x=>x.steamId===id2).shared,false);
});

test('slash /stats is installed and /status no longer registered', async () => {
  const fs = await import('node:fs');
  const source = fs.readFileSync(new URL('../src/playtime-tracker.js', import.meta.url),'utf8');
  assert.match(source, /\{ name: 'stats', description:/);
  assert.doesNotMatch(source, /\{ name: 'status', description:/);
  assert.match(source, /\['stats', 'whois', 'whoisplayer'\]/);
});

test('selected server still resolves shared action targets from one management bot', () => {
  const bot = { id:'one-bot', managedServers:[
    {id:'one', label:'EU1',baseUrl:'http://127.0.0.1:9010',secretEnc:'encrypted-1'},
    {id:'two', label:'EU2',baseUrl:'http://127.0.0.1:9020',secretEnc:'encrypted-2'}
  ] };
  assert.deepEqual(sharedBanActionTargets(bot).map(x=>x._managedServerId),['one','two']);
  assert.equal(sharedBanActionTargets(bot).every(x=>x._managedParentBotId==='one-bot'),true);
});
