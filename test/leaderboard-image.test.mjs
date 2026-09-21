import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLeaderboardSvg } from '../src/leaderboard-image.js';

function snapshot() {
  const player = { steamId: '76561198000000001', name: '[AUT] Test & <Player>', kills: 120, deaths: 50, kd: 2.4, totalSeconds: 7200, headshotRate: 0.55 };
  return {
    players: [player],
    startedAt: '2026-09-17T00:00:00.000Z',
    categories: [
      { id: 'kills', label: 'Kills', rows: [player], format: (p) => String(p.kills) },
      { id: 'headshots', label: 'Headshot-Rate', rows: [player], format: (p) => `${(p.headshotRate * 100).toFixed(1)}%` }
    ]
  };
}

test('leaderboard SVG mirrors the web leaderboard structure and safely escapes names', () => {
  const { svg, width, height } = buildLeaderboardSvg(snapshot(), { timeZone: 'Europe/Vienna', generatedAt: new Date('2026-09-21T20:00:00Z') });
  assert.equal(width, 1600);
  assert.ok(height >= 1040);
  assert.match(svg, /LEADERBOARD/);
  assert.match(svg, /TOP 15 PRO KATEGORIE/);
  assert.match(svg, /K\/D: ab 100 Kills/);
  assert.match(svg, /Headshot: ab 50 Kills/);
  assert.match(svg, /Spieler suchen/);
  assert.match(svg, /\[AUT\] Test &amp; &lt;Player&gt;/);
  assert.doesNotMatch(svg, /\[AUT\] Test & <Player>/);
});
