import test from 'node:test';
import assert from 'node:assert/strict';
import { createStatusStatsDocx, buildStatusStatsExportData } from '../src/stats-docx.js';

const bot={name:'WARDOGS Status Bot #1',statsTimezone:'Europe/Vienna'};
const playtimeSnapshot={startedAt:'2026-09-01T10:00:00Z',lastPollAt:'2026-09-19T20:00:00Z',totalSeconds:7200,rows:[{steamId:'76561198000000001',name:'Player One',totalSeconds:7200,sessionCount:3,firstSeenAt:'2026-09-01T10:00:00Z',lastSeenAt:'2026-09-19T20:00:00Z',servers:[{label:'EU1'}]}],servers:[{id:'eu1',label:'EU1',uniquePlayers:1,totalSeconds:7200,lastPollAt:'2026-09-19T20:00:00Z'}]};
const killSnapshot={startedAt:'2026-09-01T10:00:00Z',lastEventAt:'2026-09-19T19:59:00Z',totalEvents:15,players:[{steamId:'76561198000000001',name:'Player One',kills:10,deaths:5,kd:2,headshots:3,penetrations:2,ricochets:1,meleeKills:1,vehicleKills:0,roadKills:0,suicides:0,environmentalDeaths:0,longestKillMeters:321.4,topCauses:[['Rifle',8]],firstSeenAt:'2026-09-01T10:00:00Z',lastSeenAt:'2026-09-19T19:59:00Z'}]};

test('combines stored playtime and kill stats by SteamID64',()=>{
  const data=buildStatusStatsExportData(bot,playtimeSnapshot,killSnapshot);
  assert.equal(data.players.length,1); assert.equal(data.players[0].kills,10); assert.equal(data.players[0].totalSeconds,7200); assert.equal(data.players[0].servers[0],'EU1');
});

test('creates a valid DOCX package with player statistics',()=>{
  const buffer=createStatusStatsDocx({bot,playtimeSnapshot,killSnapshot,lang:'de',exportedAt:new Date('2026-09-19T21:00:00Z')});
  assert.ok(buffer.length>1500);
  assert.equal(buffer.subarray(0,4).toString('hex'),'504b0304');
  const text=buffer.toString('utf8');
  assert.match(text,/\[Content_Types\]\.xml/); assert.match(text,/word\/document\.xml/);
  assert.match(text,/Player One/); assert.match(text,/76561198000000001/); assert.match(text,/Top 25 nach Kills/); assert.match(text,/321\.4 m/);
});
