import test from 'node:test';
import assert from 'node:assert/strict';
import {
  combinedStatsSnapshot,
  searchCombinedPlayers,
  leaderboardPositions,
  finalizeTrackedMatch,
  updateServerStats,
  buildLeaderboardPayload,
  HEADSHOT_RATE_MIN_KILLS
} from '../src/playtime-tracker.js';

const SID = '76561198000000001';
const SID2 = '76561198000000002';

function hours() {
  return Array.from({ length: 24 }, (_, hour) => ({ hour, samples: 0, playerSum: 0, maxPlayers: 0 }));
}

function baseBot() {
  return {
    id: 'status-test',
    name: 'Stats Bot',
    statsTimezone: 'UTC',
    playtimeServers: [{ id: 's1', label: 'Server 1', baseUrl: 'https://example.invalid' }],
    playtimeStats: {
      startedAt: '2026-09-01T00:00:00.000Z',
      hours: hours(),
      servers: {
        s1: {
          players: {
            [SID]: {
              name: '[GWD] breazy', totalSeconds: 13.2 * 3600, seedingSeconds: 1800,
              sessionCount: 3, matchesPlayed: 15, matchWins: 2, lastFaction: 'Valkyra',
              firstSeenAt: '2026-09-01T00:00:00.000Z', lastSeenAt: '2026-09-21T17:01:00.000Z'
            }
          },
          hours: hours(), matchTracker: { snapshot: null, participants: {}, startedAt: null }
        }
      }
    },
    killStats: {
      startedAt: '2026-09-01T00:00:00.000Z', totalEvents: 179,
      players: {
        [SID]: {
          steamId: SID, name: '[=GWD=] breazy', aliases: ['breazy'], kills: 85, deaths: 94,
          headshots: 34, killRecord: 21, longestKillMeters: 412.4,
          causes: { Rifle: 50 }, firstSeenAt: '2026-09-01T00:00:00.000Z', lastSeenAt: '2026-09-21T17:01:00.000Z'
        }
      }, recentEvents: [], seenEventIds: []
    }
  };
}

test('combined Status Bot stats contain requested metrics', () => {
  const snap = combinedStatsSnapshot(baseBot());
  const p = snap.players.find((row) => row.steamId === SID);
  assert.ok(p);
  assert.equal(p.kills, 85);
  assert.equal(p.deaths, 94);
  assert.equal(Number(p.kd.toFixed(2)), 0.90);
  assert.equal(p.killRecord, 21);
  assert.equal(Number((p.headshotRate * 100).toFixed(1)), 40.0);
  assert.equal(p.matchesPlayed, 15);
  assert.equal(p.matchWins, 2);
  assert.equal(Number((p.winRate * 100).toFixed(0)), 13);
  assert.equal(p.seedingSeconds, 1800);
  assert.equal(p.lastFaction, 'Valkyra');
  assert.deepEqual(snap.categories.map((c) => c.id), ['kills','deaths','kd','playtime','killrecord','headshots','wins','matches','seeding']);
  assert.equal(snap.categories.find((c) => c.id === 'kd').rows.some((row) => row.steamId === SID), false, 'K/D leaderboard starts at 100 kills');
  assert.equal(HEADSHOT_RATE_MIN_KILLS, 50);
  assert.equal(snap.categories.find((c) => c.id === 'headshots').rows.some((row) => row.steamId === SID), true, '85-kill player is eligible for headshot rate');
});

test('headshot-rate leaderboard hides players below 50 total kills', () => {
  const bot = baseBot();
  const low = '76561198000000003';
  const edge = '76561198000000004';
  bot.killStats.players[low] = { steamId: low, name: 'LowKills', aliases: [], kills: 49, deaths: 1, headshots: 49, killRecord: 4, causes: {} };
  bot.killStats.players[edge] = { steamId: edge, name: 'EdgeKills', aliases: [], kills: 50, deaths: 10, headshots: 25, killRecord: 5, causes: {} };
  const snap = combinedStatsSnapshot(bot);
  const rows = snap.categories.find((c) => c.id === 'headshots').rows;
  assert.equal(rows.some((row) => row.steamId === low), false, '49 kills must not be ranked even with 100% headshots');
  assert.equal(rows.some((row) => row.steamId === edge), true, '50 kills unlocks headshot-rate ranking');
  assert.match(snap.categories.find((c) => c.id === 'headshots').label, /ab 50 Kills/);
});

test('player search keeps ambiguous matches for explicit selection and rank works outside Top 15', () => {
  const bot = baseBot();
  bot.playtimeStats.servers.s1.players = {};
  bot.killStats.players = {};
  for (let i = 1; i <= 20; i += 1) {
    const steamId = String(76561198000001000n + BigInt(i));
    bot.killStats.players[steamId] = {
      name: i === 19 ? 'RexAlpha' : i === 20 ? 'RexBravo' : `Player ${String(i).padStart(2,'0')}`,
      aliases: [], kills: 1000 - i, deaths: 100 + i, headshots: 100 - i,
      killRecord: 30 - i, causes: {}, firstSeenAt: null, lastSeenAt: null
    };
  }
  const snap = combinedStatsSnapshot(bot);
  const ambiguous = searchCombinedPlayers(snap, 'rex');
  assert.equal(ambiguous.length, 2);
  const twentieth = String(76561198000001000n + 20n);
  const ranks = leaderboardPositions(snap, twentieth);
  assert.equal(ranks.kills, 20);
  assert.ok(ranks.kills > 15);
});

test('match finalization counts participation and winner faction', () => {
  const serverStats = {
    players: {
      [SID]: { matchesPlayed: 4, matchWins: 1, lastFaction: 'Valkyra' },
      [SID2]: { matchesPlayed: 7, matchWins: 3, lastFaction: 'Cerberus' }
    }
  };
  const tracker = {
    snapshot: { scores: { valkyra: 300, cerberus: 250 } },
    participants: {
      [SID]: { faction: 'Faction.Valkyra' },
      [SID2]: { faction: 'Cerberus' }
    }
  };
  assert.equal(finalizeTrackedMatch(serverStats, tracker), 2);
  assert.equal(serverStats.players[SID].matchesPlayed, 5);
  assert.equal(serverStats.players[SID].matchWins, 2);
  assert.equal(serverStats.players[SID2].matchesPlayed, 8);
  assert.equal(serverStats.players[SID2].matchWins, 3);
});

test('seeding time is accumulated only while the current server population is 1-20', () => {
  const serverStats = { players: {}, hours: hours(), matchTracker: { snapshot: null, participants: {}, startedAt: null } };
  const previous = new Map();
  const current = new Map();
  for (let i = 0; i < 10; i += 1) {
    const steamId = String(76561198000002000n + BigInt(i));
    const player = { name: `Seed ${i}`, faction: 'Valkyra', steamId };
    previous.set(steamId, player); current.set(steamId, player);
    serverStats.players[steamId] = { name: player.name, totalSeconds: 120, seedingSeconds: 0, sessionCount: 1 };
  }
  updateServerStats({ statsTimezone: 'UTC' }, { id: 's1' }, serverStats, previous, current, 1_000, 61_000, null);
  assert.equal(serverStats.players[String(76561198000002000n)].totalSeconds, 180);
  assert.equal(serverStats.players[String(76561198000002000n)].seedingSeconds, 60);

  const crowded = new Map(current);
  for (let i = 10; i < 21; i += 1) {
    const steamId = String(76561198000002000n + BigInt(i));
    crowded.set(steamId, { name: `Crowd ${i}`, faction: 'Valkyra', steamId });
  }
  updateServerStats({ statsTimezone: 'UTC' }, { id: 's1' }, serverStats, current, crowded, 61_000, 121_000, null);
  assert.equal(serverStats.players[String(76561198000002000n)].seedingSeconds, 60);
});

test('Top-15 category leaderboard stays within Discord embed character limit', async () => {
  const bot = baseBot();
  bot.playtimeStats.servers.s1.players = {};
  bot.killStats.players = {};
  for (let i = 1; i <= 30; i += 1) {
    const steamId = String(76561198000003000n + BigInt(i));
    const name = `VeryLongPlayerName${String(i).padStart(2,'0')}ExtraSuffix`;
    bot.playtimeStats.servers.s1.players[steamId] = {
      name, totalSeconds: (400 - i) * 3600, seedingSeconds: (200 - i) * 60,
      sessionCount: i, matchesPlayed: 100 - i, matchWins: 50 - i, lastFaction: 'Valkyra'
    };
    bot.killStats.players[steamId] = {
      name, aliases: [], kills: 1000 - i, deaths: 200 + i, headshots: 500 - i,
      killRecord: 100 - i, causes: {}, firstSeenAt: null, lastSeenAt: null
    };
  }
  const payload = await buildLeaderboardPayload(bot, null);
  const embeds = payload.embeds.map((e) => e.toJSON());
  const chars = embeds.reduce((sum, e) => sum
    + String(e.title || '').length + String(e.description || '').length
    + String(e.footer?.text || '').length
    + (e.fields || []).reduce((fieldSum, f) => fieldSum + String(f.name || '').length + String(f.value || '').length, 0), 0);
  assert.ok(chars <= 6000, `leaderboard embeds use ${chars} characters`);
  assert.equal(embeds.reduce((sum, e) => sum + (e.fields || []).length, 0), 9);
  assert.match(embeds[0].title, /ALL-TIME LEADERBOARD/);
  assert.match(embeds[0].description, /Top 15 pro Kategorie/);
  assert.match(embeds[0].description, /Headshot-Rate ab \*\*50 Kills\*\*/);
  assert.equal(payload.components.length, 1);
});
