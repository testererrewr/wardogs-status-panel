import test from 'node:test';
import assert from 'node:assert/strict';
import {
  factionMatches,
  normalizeFactionKey,
  playerHasFaction,
  playerHasPlayableFaction,
  playerSteamId,
  playerWardogsApiId,
  wardogsPlayerRows
} from '../src/wardogs-players.js';

test('keeps the exact roster identifier for per-player WARDOGS routes', () => {
  const player = { name: 'Alpha', steamId: '[U:1:39734273]' };
  assert.equal(playerWardogsApiId(player), '[U:1:39734273]');
  assert.equal(playerSteamId(player), (76561197960265728n + 39734273n).toString());
});

test('faction matching accepts display and namespaced WARDOGS values', () => {
  assert.equal(normalizeFactionKey('Id.Faction.Valkyra'), 'valkyra');
  assert.equal(factionMatches('Faction.Valkyra', 'Valkyra'), true);
  assert.equal(factionMatches('Valkyra', 'Isengard'), false);
});

test('team selection / spectator values are not spawn ready', () => {
  assert.equal(playerHasFaction({ faction: '' }), false);
  assert.equal(playerHasFaction({ faction: 'unassigned' }), false);
  assert.equal(playerHasFaction({ faction: 'spectator' }), false);
  assert.equal(playerHasFaction({ faction: 'Faction.Invalid' }), false);
  assert.equal(playerHasFaction({ faction: 'Faction.Valkyra' }), true);
  assert.equal(playerHasPlayableFaction({ faction: 'Faction.Valkyra' }, ['Valkyra','Lonestar','Manticore']), true);
  assert.equal(playerHasPlayableFaction({ faction: 'Faction.Invalid' }, ['Valkyra','Lonestar','Manticore']), false);
  assert.equal(playerHasPlayableFaction({ faction: 'Valkyra' }, []), false);
});

test('player rows accept the official object wrapper and direct mocks', () => {
  const rows = [{ steamId: '76561198000000001' }];
  assert.equal(wardogsPlayerRows({ players: rows }), rows);
  assert.equal(wardogsPlayerRows(rows), rows);
});
