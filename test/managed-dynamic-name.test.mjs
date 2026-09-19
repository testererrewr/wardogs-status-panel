import test from 'node:test';
import assert from 'node:assert/strict';
import { desiredDynamicServerName, renderDynamicNameTemplate } from '../src/managed-dynamic-name.js';

const status = {
  serverName: '[EU1] AUTDOGS',
  map: 'Kavkazi',
  players: { current: 25, max: 60 },
  factionScores: [
    { name: 'Valkyra', score: 123 },
    { name: 'Lonestar', score: 456 },
    { name: 'Manticore', score: 789 }
  ]
};

test('stats template appends three scores behind the base name', () => {
  const name = desiredDynamicServerName({
    dynamicNameOriginalName: '[EU1] AUTDOGS',
    dynamicNameStatsEnabled: true,
    dynamicNameStatsTemplate: '{base} | {score1} | {score2} | {score3}'
  }, status, {}, 0, 25);
  assert.equal(name, '[EU1] AUTDOGS | 123 | 456 | 789');
});

test('seeding overrides stats only inside the configured player window', () => {
  const bot = {
    dynamicNameOriginalName: '[EU1] AUTDOGS',
    dynamicNameStatsEnabled: true,
    dynamicNameStatsTemplate: '{base} | {score1}',
    dynamicNameSeedingEnabled: true,
    dynamicNameSeedingMinPlayers: 1,
    dynamicNameSeedingMaxPlayers: 20,
    dynamicNameSeedingTemplate: 'JOIN SEEDING | {players}/{max}'
  };
  assert.equal(desiredDynamicServerName(bot, status, {}, 0, 12), 'JOIN SEEDING | 12/60');
  assert.equal(desiredDynamicServerName(bot, status, {}, 0, 25), '[EU1] AUTDOGS | 123');
});

test('two-name rotation switches on the requested interval and can feed stats base', () => {
  const bot = {
    dynamicNameOriginalName: '[EU1] AUTDOGS',
    dynamicNameRotationEnabled: true,
    dynamicNameRotationNameA: 'NAME A',
    dynamicNameRotationNameB: 'NAME B',
    dynamicNameRotationMinutes: 5,
    dynamicNameStatsEnabled: true,
    dynamicNameStatsTemplate: '{base} | {players}'
  };
  const state = { dynamicNameRotationStartedAt: 1_000 };
  assert.equal(desiredDynamicServerName(bot, status, state, 1_000, 10), 'NAME A | 10');
  assert.equal(desiredDynamicServerName(bot, status, state, 1_000 + 5 * 60_000, 10), 'NAME B | 10');
});

test('unknown placeholders remain visible and output is sanitized', () => {
  assert.equal(renderDynamicNameTemplate('  Test\n{name} {unknown}  ', { name: 'X' }), 'Test X {unknown}');
});
