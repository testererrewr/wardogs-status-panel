import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { combinedManagedBanList, mergeSharedServerBans, sharedServerBanRows, hasPermanentManagedBan, removeSharedServerBan } from '../src/managed-shared-bans.js';
const id='76561198000000001';
const later=new Date(Date.now()+3*24*60*60*1000).toISOString();
test('permanent intent has no expiration and dominates shorter temporary intent',()=>{
  const original={sharedServerBans:[{steamId:id,reason:'Cheating',mode:'temporary',expiresAt:later}]};
  const permanent=mergeSharedServerBans(original,[{steamId:id,reason:'Cheating',mode:'permanent'}]);
  assert.equal(permanent.length,1);
  assert.equal(permanent[0].mode,'permanent');
  assert.equal(permanent[0].expiresAt,null);
  assert.equal(hasPermanentManagedBan({sharedServerBans:permanent},id),true);
  assert.equal(hasPermanentManagedBan(original,id),false);
  const downgrade=mergeSharedServerBans({sharedServerBans:permanent},[{steamId:id,reason:'XP Farming',mode:'temporary',expiresAt:later}]);
  assert.equal(downgrade[0].mode,'permanent');
  assert.equal(downgrade[0].expiresAt,null);
});
test('permanent pending ban appears for offline player even on one server',()=>{
  const bot={sharedServerBans:[{steamId:id,reason:'Cheating',mode:'permanent'}]};
  const rows=combinedManagedBanList([],bot);
  assert.equal(rows.length,1);
  assert.equal(rows[0].pending,true);
  assert.equal(rows[0].sharedMode,'permanent');
  assert.equal(hasPermanentManagedBan(bot,id),true);
  assert.equal(rows[0].expiresAtUtc,'');
});
test('WARDOGS expiry is overridden by permanent shared intent when ban already native',()=>{
  const bot={sharedServerBans:[{steamId:id,reason:'Cheating',mode:'permanent'}]};
  const rows=combinedManagedBanList([{steamId:id,expiresAtUtc:later,reason:'Cheating'}],bot);
  assert.equal(rows.length,1);
  assert.equal(rows[0].pending,false);
  assert.equal(rows[0].expiresAtUtc,'');
});
test('explicit unban deletes local permanent intent',()=>{
  const bot={sharedServerBans:[{steamId:id,mode:'permanent'}]};
  assert.equal(removeSharedServerBan(bot,id).length,0);
  assert.equal(sharedServerBanRows(bot)[0].mode,'permanent');
});
test('management source preserves permanent across temporary/dynamic expiry and exposes conversion',()=>{
  const managed=fs.readFileSync(new URL('../src/managed-bots.js',import.meta.url),'utf8');
  const panel=fs.readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
  assert.match(managed,/function rememberPermanentManagedBan\(/);
  assert.match(managed,/function enforceManagedSharedBansForPlayers\(/);
  assert.match(managed,/Permanent ban preserved; no WARDOGS unban issued/);
  assert.match(managed,/row\.mode === 'permanent' \|\| !due\.some/);
  assert.match(panel,/\/ban\/promote/);
  assert.match(panel,/Permanent machen/);
  assert.match(panel,/sharedServers=normalizeManagedServers\(bot\)\.length>1,bans=combinedManagedBanList/);
});
