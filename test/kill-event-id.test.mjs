import test from 'node:test';
import assert from 'node:assert/strict';
import { stableKillEventId, killEventSeenKey } from '../src/kill-event-id.js';

const event = {
  type: 'Killed', matchId: 'match-1', eventTime: 98234,
  killerSteamId: '76561198000000001', victimSteamId: '76561198000000002',
  cause: 'Rifle', distance: 1252, contextTags: ['Headshot']
};
test('replayed WARDOGS kills without explicit eventId derive an identical ID', () => {
  const a = stableKillEventId({ serverId: 's1' }, event);
  const b = stableKillEventId({ serverId: 's1' }, { ...event });
  assert.equal(a, b);
  assert.notEqual(a, stableKillEventId({ serverId: 's2' }, event));
  assert.notEqual(a, stableKillEventId({ serverId: 's1' }, { ...event, eventTime: 98235 }));
});
test('events on different servers do not share deduplication slots', () => {
  assert.notEqual(killEventSeenKey({ id: '1', serverId: 'a' }), killEventSeenKey({ id: '1', serverId: 'b' }));
});
test('without a reliable timestamp events are not accidentally collapsed', () => {
  assert.notEqual(stableKillEventId({ serverId: 's1' }, { ...event, eventTime: 0 }), stableKillEventId({ serverId: 's1' }, { ...event, eventTime: 0 }));
});
