import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveCustomBotStatuses, statusFailureKind } from '../src/custom-bot-statuses.js';

const bots = ['a', 'b', 'c'].map((id) => ({ id }));

test('fast batch reports all bot states in one query without a fallback', async () => {
  let individualCalls = 0;
  const result = await resolveCustomBotStatuses(bots, {
    batch: async () => ({ statuses: { a: { exists: true, running: true }, b: { exists: true, running: false }, c: { exists: false, running: false } } }),
    individual: async () => { individualCalls++; }
  });
  assert.equal(individualCalls, 0);
  assert.equal(result.degraded, false);
  assert.deepEqual(result.statuses.b, { exists: true, running: false });
  assert.deepEqual(result.statuses.c, { exists: false, running: false });
});

test('if batch query fails, inspect individual bots and preserve actual online/offline status', async () => {
  const result = await resolveCustomBotStatuses(bots, {
    batch: async () => { throw new Error('docker ps timed out'); },
    individual: async (bot) => ({ exists: true, running: bot.id !== 'b' })
  });
  assert.equal(result.degraded, false);
  assert.equal(result.statuses.a.running, true);
  assert.equal(result.statuses.b.running, false);
});

test('a failed fallback is unknown, never falsely stopped', async () => {
  const result = await resolveCustomBotStatuses(bots, {
    batch: async () => { throw new Error('Cannot connect to the Docker daemon'); },
    individual: async (bot) => {
      if (bot.id === 'b') throw new Error('permission denied while connecting to the Docker daemon socket');
      return { exists: true, running: true };
    }
  });
  assert.equal(result.degraded, true);
  assert.deepEqual(result.statuses.b, { unknown: true, reason: 'docker_permissions' });
  assert.equal(result.statuses.a.running, true);
});

test('malformed batch response falls back, partial valid response only inspects missing bots', async () => {
  let calls = [];
  const result = await resolveCustomBotStatuses(bots, {
    batch: async () => ({ statuses: { a: { exists: true, running: true }, b: null, c: { exists: false, running: false } } }),
    individual: async (bot) => { calls.push(bot.id); return { exists: true, running: true }; }
  });
  assert.deepEqual(calls, ['b']);
  assert.equal(result.degraded, false);
  assert.deepEqual(result.statuses.c, { exists: false, running: false });
});

test('fallback is bounded for high counts to protect the runner', async () => {
  const big = Array.from({length: 13}, (_, i) => ({id: `x${i}`}));
  let count = 0;
  const result = await resolveCustomBotStatuses(big, {
    batch: async () => { throw new Error('Docker daemon unreachable'); },
    individual: async () => { count++; return { exists: true, running: true }; }
  });
  assert.equal(count, 0);
  assert.equal(result.degraded, true);
  assert.equal(result.statuses.x0.unknown, true);
});

test('no leak of daemon error string in user-visible reasons', () => {
  assert.equal(statusFailureKind(new Error('password=abc /var/run/docker.sock permission denied')), 'docker_permissions');
  assert.equal(statusFailureKind(new Error('fetch failed ECONNREFUSED')), 'runner_unavailable');
  assert.equal(statusFailureKind(new Error('RUNNER_SHARED_SECRET fehlt')), 'runner_configuration');
  assert.equal(statusFailureKind(new Error('Unexpected error in secret file')), 'status_query_failed');
});

test('website uses explicit unknown-state badge and no destructive actions on status failure', () => {
  const js = fs.readFileSync(new URL('../public/custom-bots-status.js', import.meta.url), 'utf8');
  assert.match(js, /Status nicht prüfbar/);
  assert.match(js, /Kein Container/);
  assert.doesNotMatch(js, /Start\/Neu bauen/);
  assert.doesNotMatch(js, /\.click\(/);
  const server = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(server, /resolveCustomBotStatuses\(bots\.slice/);
});
