import test from 'node:test';
import assert from 'node:assert/strict';
import { managementPanelSummary } from '../src/managed-panel-snapshot.js';

test('initial panel shows loading rather than fabricated zero', () => {
  const row = managementPanelSummary(null, null, 'EU1');
  assert.equal(row.players, 'Lädt … / —');
  assert.equal(row.server, 'EU1');
});
test('independent status has official occupancy, map and scores without roster', () => {
  const status = { serverName:'EU1 WARDOGS', map:'Battlefield', players:{current:60,max:64}, factionScores:[{name:'Red',score:12},{name:'Blue',score:10}] };
  const row = managementPanelSummary(status, null);
  assert.equal(row.players,'60 / 64');
  assert.equal(row.map,'Battlefield');
  assert.equal(row.scores,'Red: 12 · Blue: 10');
  assert.equal(row.actionablePlayers,null);
});
test('partial roster cannot reduce official count', () => {
  const row = managementPanelSummary({players:{current:60,max:60}}, {players:Array(55).fill({name:'p'})});
  assert.equal(row.players,'60 / 60');
  assert.equal(row.actionablePlayers,55);
});
test('bad values are safely displayed', () => {
  const row = managementPanelSummary({map:{name:'New Map'},players:{current:12,max:60},factionScores:[{name:'X',score:1}]}, []);
  assert.equal(row.map,'New Map');
  assert.equal(row.scores,'X: 1');
});

test('empty roster with no API status never claims official 0 players',()=>{
  const row=managementPanelSummary(null,{players:[]});
  assert.equal(row.players,'Lädt … / —');
});
