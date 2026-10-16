import test from 'node:test';
import assert from 'node:assert/strict';
import {levelCapDecision, patchMaxPlayerLevel, configMaxPlayerLevel, LEVEL_CAP_WAIT_MS} from '../src/managed-level-policy.js';

test('level cap waits continuously 30 minutes below 20 players', () => {
  const start=1_760_000_000_000;
  const first=levelCapDecision({},19,start,true);
  assert.equal(first.action,null);
  const intermediate=levelCapDecision(first,0,start+LEVEL_CAP_WAIT_MS-1000,true);
  assert.equal(intermediate.action,null);
  assert.equal(levelCapDecision(intermediate,19,start+LEVEL_CAP_WAIT_MS,true).action,'cap');
});

test('20–24 players cancels low-population timer and does not lift cap',()=>{
  const start=1_760_000_000_000;
  const first=levelCapDecision({},12,start,true);
  const interrupted=levelCapDecision(first,20,start+100_000,true);
  assert.equal(interrupted.lowSince,0);
  assert.equal(levelCapDecision(interrupted,19,start+LEVEL_CAP_WAIT_MS,true).action,null);
  assert.equal(levelCapDecision({capped:true,lowSince:0},24,start,true).action,null);
});

test('25+ players removes cap immediately; disabling returns restore action',()=>{
  assert.equal(levelCapDecision({capped:true},25,1760000000000,true).action,'uncap');
  assert.equal(levelCapDecision({capped:true},19,1760000000000,false).action,'restore');
  assert.equal(levelCapDecision({capped:false},25,1760000000000,false).action,null);
  assert.equal(levelCapDecision({capped:true},-1,1760000000000,true).action,null);
});

test('ini patch preserves unrelated settings and restores original nonzero level',()=>{
  const original='[Other]\r\nFoo=bar\r\n[/Script/WDGame.WDGameSession]\r\nServerMaxPlayerLevel=75\r\nAB=CD\r\n[Other2]\r\nThing=ok';
  const limited=patchMaxPlayerLevel(original,30);
  assert.equal(configMaxPlayerLevel(limited),30);
  assert.ok(limited.includes('Foo=bar\r\n'));
  assert.equal(patchMaxPlayerLevel(limited,75),original);
  assert.equal(configMaxPlayerLevel(patchMaxPlayerLevel(limited,0)),0);
});

test('ini patch creates section if missing, validates level',()=>{
  const result=patchMaxPlayerLevel('[Other]\nFoo=bar\n',30);
  assert.match(result,/\[\/Script\/WDGame\.WDGameSession\]/);
  assert.equal(configMaxPlayerLevel(result),30);
  assert.throws(()=>patchMaxPlayerLevel(result,601));
  assert.throws(()=>patchMaxPlayerLevel(result,-1));
});
