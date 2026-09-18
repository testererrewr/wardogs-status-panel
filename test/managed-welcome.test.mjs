import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createManagedJoinTracker,
  managedJoinCandidates,
  managedWelcomeSucceeded,
  managedWelcomeTargets,
  renderManagedWelcomeMessage
} from '../src/managed-welcome.js';

const A = { name: 'Alpha', steamId: '76561198000000001', faction: 'Valkyra' };
const B_SELECTING = { name: 'Bravo', steamId: '76561198000000002', faction: '' };
const B_SPAWNED = { ...B_SELECTING, faction: 'Valkyra' };

function state() {
  return {
    welcomePending: new Set(), welcomeDelivered: new Set(), welcomeFailed: new Set(),
    welcomeAttempts: new Map(), welcomeReadyAt: new Map(), welcomeJoinTracker: createManagedJoinTracker()
  };
}

test('startup roster is baseline and does not receive a welcome', () => {
  const s = state();
  assert.deepEqual(managedJoinCandidates(s.welcomeJoinTracker, [A], 2), []);
  assert.deepEqual(managedWelcomeTargets(s, [A], [], { nowMs: 0, spawnSettleMs: 2_000 }), []);
  assert.equal(s.welcomePending.size, 0);
});

test('new join stays queued until a faction/team appears, then becomes eligible after settle delay', () => {
  const s = state();
  managedJoinCandidates(s.welcomeJoinTracker, [A], 2);
  const joined = managedJoinCandidates(s.welcomeJoinTracker, [A, B_SELECTING], 2);
  assert.equal(joined.length, 1);

  let targets = managedWelcomeTargets(s, [A, B_SELECTING], joined, { nowMs: 1_000, spawnSettleMs: 2_000 });
  assert.equal(targets.length, 0);
  assert.equal(s.welcomePending.has(B_SELECTING.steamId), true);
  assert.equal(s.welcomeReadyAt.has(B_SELECTING.steamId), false);

  // The player can remain in team selection for any amount of time. No blind
  // 30-second timeout should discard or repeatedly reset the session.
  targets = managedWelcomeTargets(s, [A, B_SELECTING], [], { nowMs: 61_000, spawnSettleMs: 2_000 });
  assert.equal(targets.length, 0);
  assert.equal(s.welcomePending.has(B_SELECTING.steamId), true);

  // WARDOGS reports a faction once the player has chosen a team / entered the
  // gameplay flow. Start a short settle window, then whisper.
  targets = managedWelcomeTargets(s, [A, B_SPAWNED], [], { nowMs: 70_000, spawnSettleMs: 2_000 });
  assert.equal(targets.length, 0);
  targets = managedWelcomeTargets(s, [A, B_SPAWNED], [], { nowMs: 72_000, spawnSettleMs: 2_000 });
  assert.equal(targets.length, 1);
  assert.equal(targets[0].steamId, B_SPAWNED.steamId);
});

test('one incomplete roster snapshot does not delete a queued join', () => {
  const s = state();
  managedJoinCandidates(s.welcomeJoinTracker, [A], 2);
  const joined = managedJoinCandidates(s.welcomeJoinTracker, [A, B_SELECTING], 2);
  managedWelcomeTargets(s, [A, B_SELECTING], joined, { nowMs: 1_000, spawnSettleMs: 0 });
  assert.equal(s.welcomePending.has(B_SELECTING.steamId), true);

  // First miss is not a confirmed leave.
  managedJoinCandidates(s.welcomeJoinTracker, [A], 2);
  managedWelcomeTargets(s, [A], [], { nowMs: 5_000, spawnSettleMs: 0 });
  assert.equal(s.welcomePending.has(B_SELECTING.steamId), true);

  // Same session comes back and later chooses a faction.
  assert.deepEqual(managedJoinCandidates(s.welcomeJoinTracker, [A, B_SPAWNED], 2), []);
  const targets = managedWelcomeTargets(s, [A, B_SPAWNED], [], { nowMs: 10_000, spawnSettleMs: 0 });
  assert.equal(targets.length, 1);
});

test('confirmed leave followed by rejoin creates a fresh welcome session', () => {
  const s = state();
  managedJoinCandidates(s.welcomeJoinTracker, [A], 2);
  let joined = managedJoinCandidates(s.welcomeJoinTracker, [A, B_SPAWNED], 2);
  let targets = managedWelcomeTargets(s, [A, B_SPAWNED], joined, { nowMs: 0, spawnSettleMs: 0 });
  assert.equal(targets.length, 1);
  managedWelcomeSucceeded(s, B_SPAWNED.steamId);
  assert.equal(s.welcomeDelivered.has(B_SPAWNED.steamId), true);

  managedJoinCandidates(s.welcomeJoinTracker, [A], 2);
  managedWelcomeTargets(s, [A], [], { nowMs: 5_000, spawnSettleMs: 0 });
  managedJoinCandidates(s.welcomeJoinTracker, [A], 2);
  managedWelcomeTargets(s, [A], [], { nowMs: 10_000, spawnSettleMs: 0 });
  assert.equal(s.welcomeDelivered.has(B_SPAWNED.steamId), false);

  joined = managedJoinCandidates(s.welcomeJoinTracker, [A, B_SPAWNED], 2);
  assert.equal(joined.length, 1);
  targets = managedWelcomeTargets(s, [A, B_SPAWNED], joined, { nowMs: 15_000, spawnSettleMs: 0 });
  assert.equal(targets.length, 1);
});

test('welcome variables render with the faction reported at spawn time', () => {
  assert.equal(renderManagedWelcomeMessage('Hi {player} {steamid} {faction}', B_SPAWNED), `Hi Bravo ${B_SPAWNED.steamId} Valkyra`);
});
