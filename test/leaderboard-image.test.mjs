import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLeaderboardPageSvg, leaderboardPageCount } from '../src/leaderboard-image.js';

function snapshot() {
  const player = {
    steamId: '76561198000000001', name: '[AUT] Test & <Player>', kills: 120, deaths: 50, kd: 2.4,
    totalSeconds: 7200, headshotRate: 0.55, headshots: 66, killRecord: 21,
    matchWins: 4, matchesPlayed: 10, winRate: 0.4, seedingSeconds: 1800
  };
  const fmt = (key) => (p) => String(p[key] ?? '—');
  return {
    players: [player],
    startedAt: '2026-09-17T00:00:00.000Z',
    categories: [
      { id: 'kills', label: 'Kills', rows: [player], format: fmt('kills') },
      { id: 'deaths', label: 'Tode', rows: [player], format: fmt('deaths') },
      { id: 'kd', label: 'K/D', rows: [player], format: (p) => p.kd.toFixed(2) },
      { id: 'headshots', label: 'Headshot-Rate', rows: [player], format: (p) => `${(p.headshotRate * 100).toFixed(1)}%` },
      { id: 'killrecord', label: 'Kill-Rekord / Match', rows: [player], format: fmt('killRecord') },
      { id: 'playtime', label: 'Spielzeit', rows: [player], format: () => '2,0 Std' },
      { id: 'wins', label: 'Match-Siege', rows: [player], format: () => '4 (40%)' },
      { id: 'matches', label: 'Matches gespielt', rows: [player], format: fmt('matchesPlayed') },
      { id: 'seeding', label: 'Seeding-Zeit', rows: [player], format: () => '30 Min' }
    ]
  };
}

test('Discord leaderboard uses five large readable pages in the web-panel look', () => {
  assert.equal(leaderboardPageCount(), 5);
  const first = buildLeaderboardPageSvg(snapshot(), { page: 0, timeZone: 'Europe/Vienna', generatedAt: new Date('2026-09-21T20:00:00Z') });
  assert.equal(first.width, 1600);
  assert.equal(first.height, 1010);
  assert.equal(first.page, 0);
  assert.equal(first.pageCount, 5);
  assert.match(first.svg, /LEADERBOARD/);
  assert.match(first.svg, /TOP 15 PRO KATEGORIE/);
  assert.match(first.svg, /K\/D: ab 50 Kills/);
  assert.match(first.svg, /Headshot: ab 50 Kills/);
  assert.match(first.svg, /SEITE 1\/5/);
  assert.match(first.svg, /Kills/);
  assert.match(first.svg, /Tode/);
  assert.match(first.svg, /\[AUT\] Test &amp; &lt;Player&gt;/);
  assert.doesNotMatch(first.svg, /\[AUT\] Test & <Player>/);

  const second = buildLeaderboardPageSvg(snapshot(), { page: 1 });
  assert.match(second.svg, /SEITE 2\/5/);
  assert.match(second.svg, /K\/D \(ab 50 Kills\)/);
  assert.match(second.svg, /Headshot-Rate \(ab 50 Kills\)/);
  assert.doesNotMatch(second.svg, />Kills<\/text>/);

  const fifth = buildLeaderboardPageSvg(snapshot(), { page: 4 });
  assert.match(fifth.svg, /SEITE 5\/5/);
  assert.match(fifth.svg, /Seeding-Zeit \(1–20 Spieler\)/);
});
