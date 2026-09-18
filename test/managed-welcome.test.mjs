import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createManagedJoinTracker,
  managedJoinCandidates,
  managedWelcomeSucceeded,
  managedWelcomeTargets,
  renderManagedWelcomeMessage
} from '../src/managed-welcome.js';

const FACTIONS = ['Valkyra', 'Lonestar', 'Manticore'];
const A = { name: 'Alpha', steamId: '76561198000000001', faction: 'Valkyra' };
const B_SELECTING = { name: 'Bravo', steamId: '76561198000000002', faction: 'Faction.Invalid' };
const B_SPAWNED = { ...B_SELECTING, faction: 'Valkyra' };
const B_PREASSIGNED = { ...B_SELECTING, faction: 'Valkyra' };
const B_OTHER_TEAM = { ...B_SELECTING, faction: 'Lonestar' };

function state() {
  return {
    welcomePending: new Set(), welcomeDelivered: new Set(), welcomeFailed: new Set(),
    welcomeAttempts: new Map(), welcomeReadyAt: new Map(), welcomeJoinTracker: createManagedJoinTracker()
  };
}

function targets(s, players, joined, nowMs, extra = {}) {
  return managedWelcomeTargets(s, players, joined, {
    nowMs, spawnSettleMs: 5_000, teamStablePolls: 2, validFactions: FACTIONS, ...extra
  });
}

test('startup roster is baseline and does not receive a welcome', () => {
  const s = state();
  assert.deepEqual(managedJoinCandidates(s.welcomeJoinTracker, [A], 2), []);
  assert.deepEqual(targets(s, [A], [], 0), []);
  assert.equal(s.welcomePending.size, 0);
});

test('placeholder faction is not considered a playable selected team', () => {
  const s = state();
  managedJoinCandidates(s.welcomeJoinTracker, [A], 2);
  const joined = managedJoinCandidates(s.welcomeJoinTracker, [A, B_SELECTING], 2);
  assert.equal(joined.length, 1);
  assert.deepEqual(targets(s, [A, B_SELECTING], joined, 1_000), []);
  assert.equal(s.welcomeSawPreTeam.has(B_SELECTING.steamId), true);
  assert.equal(s.welcomeTeamChoiceConfirmed.has(B_SELECTING.steamId), false);
});

test('welcome waits for observed team selection, stable polls, then spawn settle', () => {
  const s = state();
  managedJoinCandidates(s.welcomeJoinTracker, [A], 2);
  const joined = managedJoinCandidates(s.welcomeJoinTracker, [A, B_SELECTING], 2);
  assert.deepEqual(targets(s, [A, B_SELECTING], joined, 1_000), []);

  // First real-team observation confirms selection but is only stable poll 1.
  assert.deepEqual(targets(s, [A, B_SPAWNED], [], 3_000), []);
  assert.equal(s.welcomeTeamChoiceConfirmed.has(B_SPAWNED.steamId), true);

  // Stable poll 2 starts the spawn settle window.
  assert.deepEqual(targets(s, [A, B_SPAWNED], [], 5_000), []);
  assert.equal(s.welcomeReadyAt.get(B_SPAWNED.steamId), 10_000);

  assert.deepEqual(targets(s, [A, B_SPAWNED], [], 9_999), []);
  const ready = targets(s, [A, B_SPAWNED], [], 10_000);
  assert.equal(ready.length, 1);
  assert.equal(ready[0].steamId, B_SPAWNED.steamId);
});

test('a playable faction already present in the join snapshot is not enough to send early', () => {
  const s = state();
  managedJoinCandidates(s.welcomeJoinTracker, [A], 2);
  const joined = managedJoinCandidates(s.welcomeJoinTracker, [A, B_PREASSIGNED], 2);
  assert.equal(joined.length, 1);
  assert.deepEqual(targets(s, [A, B_PREASSIGNED], joined, 1_000), []);
  assert.deepEqual(targets(s, [A, B_PREASSIGNED], [], 30_000), []);
  assert.equal(s.welcomeTeamChoiceConfirmed.has(B_PREASSIGNED.steamId), false);
});

test('a post-join change from one real faction to another confirms team selection', () => {
  const s = state();
  managedJoinCandidates(s.welcomeJoinTracker, [A], 2);
  const joined = managedJoinCandidates(s.welcomeJoinTracker, [A, B_PREASSIGNED], 2);
  targets(s, [A, B_PREASSIGNED], joined, 1_000);
  assert.deepEqual(targets(s, [A, B_OTHER_TEAM], [], 3_000), []);
  assert.equal(s.welcomeTeamChoiceConfirmed.has(B_OTHER_TEAM.steamId), true);
  targets(s, [A, B_OTHER_TEAM], [], 5_000);
  assert.equal(targets(s, [A, B_OTHER_TEAM], [], 10_000).length, 1);
});

test('one incomplete roster snapshot does not delete a queued join', () => {
  const s = state();
  managedJoinCandidates(s.welcomeJoinTracker, [A], 2);
  const joined = managedJoinCandidates(s.welcomeJoinTracker, [A, B_SELECTING], 2);
  targets(s, [A, B_SELECTING], joined, 1_000);
  assert.equal(s.welcomePending.has(B_SELECTING.steamId), true);

  managedJoinCandidates(s.welcomeJoinTracker, [A], 2);
  targets(s, [A], [], 5_000);
  assert.equal(s.welcomePending.has(B_SELECTING.steamId), true);

  assert.deepEqual(managedJoinCandidates(s.welcomeJoinTracker, [A, B_SPAWNED], 2), []);
  targets(s, [A, B_SPAWNED], [], 10_000);
  targets(s, [A, B_SPAWNED], [], 12_000);
  assert.equal(targets(s, [A, B_SPAWNED], [], 17_000).length, 1);
});

test('confirmed leave followed by rejoin creates a fresh welcome session', () => {
  const s = state();
  managedJoinCandidates(s.welcomeJoinTracker, [A], 2);
  let joined = managedJoinCandidates(s.welcomeJoinTracker, [A, B_SELECTING], 2);
  targets(s, [A, B_SELECTING], joined, 0);
  targets(s, [A, B_SPAWNED], [], 2_000);
  targets(s, [A, B_SPAWNED], [], 4_000);
  let ready = targets(s, [A, B_SPAWNED], [], 9_000);
  assert.equal(ready.length, 1);
  managedWelcomeSucceeded(s, B_SPAWNED.steamId);
  assert.equal(s.welcomeDelivered.has(B_SPAWNED.steamId), true);

  managedJoinCandidates(s.welcomeJoinTracker, [A], 2);
  targets(s, [A], [], 11_000);
  managedJoinCandidates(s.welcomeJoinTracker, [A], 2);
  targets(s, [A], [], 13_000);
  assert.equal(s.welcomeDelivered.has(B_SPAWNED.steamId), false);

  joined = managedJoinCandidates(s.welcomeJoinTracker, [A, B_SELECTING], 2);
  assert.equal(joined.length, 1);
  assert.deepEqual(targets(s, [A, B_SELECTING], joined, 15_000), []);
});

test('welcome variables render with the faction reported at delivery time', () => {
  assert.equal(renderManagedWelcomeMessage('Hi {player} {steamid} {faction}', B_SPAWNED), `Hi Bravo ${B_SPAWNED.steamId} Valkyra`);
});
