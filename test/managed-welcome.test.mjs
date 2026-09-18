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
const B = { name: 'Bravo', steamId: '76561198000000002', faction: '' };

function state() {
  return {
    welcomePending: new Set(), welcomeDelivered: new Set(), welcomeFailed: new Set(),
    welcomeAttempts: new Map(), welcomeReadyAt: new Map(), welcomeJoinTracker: createManagedJoinTracker()
  };
}

test('startup roster is baseline and does not receive a welcome', () => {
  const s = state();
  assert.deepEqual(managedJoinCandidates(s.welcomeJoinTracker, [A], 2), []);
  assert.deepEqual(managedWelcomeTargets(s, [A], [], { nowMs: 0, joinDelayMs: 30_000 }), []);
  assert.equal(s.welcomePending.size, 0);
});

test('new join survives one incomplete roster snapshot and sends after 30 seconds', () => {
  const s = state();
  managedJoinCandidates(s.welcomeJoinTracker, [A], 2);
  const joined = managedJoinCandidates(s.welcomeJoinTracker, [A, B], 2);
  assert.equal(joined.length, 1);
  managedWelcomeTargets(s, [A, B], joined, { nowMs: 1_000, joinDelayMs: 30_000 });
  assert.equal(s.welcomePending.has(B.steamId), true);

  // One temporary empty/incomplete snapshot must NOT destroy the queue.
  managedJoinCandidates(s.welcomeJoinTracker, [A], 2);
  managedWelcomeTargets(s, [A], [], { nowMs: 10_000, joinDelayMs: 30_000 });
  assert.equal(s.welcomePending.has(B.steamId), true);

  // Player appears again in the same session; original readyAt remains unchanged.
  assert.deepEqual(managedJoinCandidates(s.welcomeJoinTracker, [A, B], 2), []);
  const targets = managedWelcomeTargets(s, [A, B], [], { nowMs: 31_000, joinDelayMs: 30_000 });
  assert.equal(targets.length, 1);
  assert.equal(targets[0].steamId, B.steamId);
});

test('confirmed leave followed by rejoin creates a fresh welcome session', () => {
  const s = state();
  managedJoinCandidates(s.welcomeJoinTracker, [A], 2);
  let joined = managedJoinCandidates(s.welcomeJoinTracker, [A, B], 2);
  managedWelcomeTargets(s, [A, B], joined, { nowMs: 0, joinDelayMs: 0 });
  managedWelcomeSucceeded(s, B.steamId);
  assert.equal(s.welcomeDelivered.has(B.steamId), true);

  managedJoinCandidates(s.welcomeJoinTracker, [A], 2);
  managedWelcomeTargets(s, [A], [], { nowMs: 5_000, joinDelayMs: 0 });
  managedJoinCandidates(s.welcomeJoinTracker, [A], 2);
  managedWelcomeTargets(s, [A], [], { nowMs: 10_000, joinDelayMs: 0 });
  assert.equal(s.welcomeDelivered.has(B.steamId), false);

  joined = managedJoinCandidates(s.welcomeJoinTracker, [A, B], 2);
  assert.equal(joined.length, 1);
  const targets = managedWelcomeTargets(s, [A, B], joined, { nowMs: 15_000, joinDelayMs: 0 });
  assert.equal(targets.length, 1);
});

test('welcome variables render without requiring a faction', () => {
  assert.equal(renderManagedWelcomeMessage('Hi {player} {steamid} {faction}', B), `Hi Bravo ${B.steamId}`);
});
