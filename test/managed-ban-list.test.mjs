import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeManagedBans } from '../src/managed-ban-list.js';
const ID='76561198000000001';
for (const data of [ [{steamId:ID,reason:'test'}],{bans:[{steamId:ID,reason:'test'}]},{data:{entries:[{steamId64:ID,banReason:'test'}]}},{[ID]:{reason:'test'}},{items:[{steamID64:ID,reason:'test'}]} ]) {
  test('recognizes WARDOGS ban-list response variant',()=>{
    const result=normalizeManagedBans(data);
    assert.equal(result.available,true);
    assert.equal(result.bans.length,1);
    assert.equal(result.bans[0].steamId,ID);
  });
}
test('empty list is distinguishable from missing, invalid or failed response',()=>{
  assert.deepEqual(normalizeManagedBans({bans:[]}),{available:true,bans:[]});
  assert.equal(normalizeManagedBans({error:'timeout'}).available,false);
  assert.equal(normalizeManagedBans(undefined).available,false);
});
test('steam ids can be direct strings and newer capitalized fields',()=>{
  assert.equal(normalizeManagedBans({entries:[ID]}).bans[0].steamId,ID);
  assert.equal(normalizeManagedBans({items:[{SteamID:ID,reason:'test'}]}).bans[0].steamId,ID);
});
test('invalid records do not silently appear as an empty ban list',()=>{
  assert.equal(normalizeManagedBans({bans:[{unknownKey:'x'}]}).available,false);
});
