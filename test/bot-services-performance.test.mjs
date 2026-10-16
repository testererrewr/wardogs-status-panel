import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const previousCwd = process.cwd();
const previousKey = process.env.APP_ENCRYPTION_KEY;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wardogs-service-perf-'));
process.chdir(tmp);
process.env.APP_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
const db = await import(`${pathToFileURL(path.join(previousCwd,'src/db.js')).href}?service-perf=${Date.now()}`);

test.after(() => {
  process.chdir(previousCwd);
  if (previousKey === undefined) delete process.env.APP_ENCRYPTION_KEY;
  else process.env.APP_ENCRYPTION_KEY = previousKey;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('Bot Services only reads lightweight summaries without cloning stats history', () => {
  const owner = '12345678901234567';
  const shared = '23456789012345678';
  const outsider = '34567890123456789';
  const seed = db.readDb();
  const largeStats = { history: Array.from({length: 6000}, (_,i) => ({steamId: String(i), kills:i, other:'x'.repeat(50)})) };
  seed.managedBots = [
    { id:'bot1', serviceId:'wardogs-warning-bot', ownerDiscordId:owner, name:'A', adminGrant:true, enabled:true, playtimeStats:largeStats, createdAt:'2026-01-01' },
    { id:'bot2', serviceId:'wardogs-playtime-tracker', ownerDiscordId:outsider, sharedPanelUserIds:[shared], name:'B', playtimeStats:largeStats, createdAt:'2026-01-02' },
    { id:'bot3', serviceId:'wardogs-playtime-tracker', ownerDiscordId:outsider, name:'C', playtimeStats:largeStats }
  ];
  db.writeDb(seed);
  const now = performance.now();
  const summaries = db.listManagedBotServiceSummariesForUser(owner);
  for(let i=0;i<30;i++) db.listManagedBotServiceSummariesForUser(owner);
  const lightweightMs = performance.now() - now;
  assert.deepEqual(summaries.map(x=>x.id), ['bot1']);
  assert.equal(summaries[0].adminGrant, true);
  assert.equal(summaries[0].playtimeStats, undefined);
  const configs = db.listManagedBotConfigsAccessibleToUserService(owner,'wardogs-warning-bot');
  assert.equal(configs.length,1);
  assert.equal(configs[0].playtimeStats,undefined);
  assert.equal(configs[0].killStats,undefined);
  assert.equal(configs[0].name,'A');
  configs[0].name='tampered';
  assert.equal(db.getManagedBot('bot1').name,'A');
  assert.deepEqual(db.listManagedBotServiceSummariesForUser(shared).map(x=>x.id), ['bot2']);
  assert.equal(db.listManagedBotServiceSummariesForUser('99999999999999999').length, 0);
  assert.ok(JSON.stringify(summaries).length < 1000);
  console.log(`30 lightweight service lookups: ${lightweightMs.toFixed(1)}ms`);
});

test('Filtered access does not leak other bots or return mutable cache references', () => {
  const shared = '23456789012345678';
  const first = db.listManagedBotsAccessibleToUserService(shared,'wardogs-playtime-tracker');
  assert.deepEqual(first.map(x=>x.id),['bot2']);
  first[0].name='tampered';
  assert.equal(db.getManagedBot('bot2').name,'B');
  assert.deepEqual(db.selectDbRows('managedBots', row=>row.id==='bot3').map(x=>x.id),['bot3']);
  assert.equal(db.selectDbRows('users',()=>true).length,db.readDb().users.length);
});

test('Selective reads observe updates and external database replacement', () => {
  const before = db.readDb();
  db.upsertUser({discordId:'45678901234567890',username:'updated'});
  assert.equal(db.findUser('45678901234567890')?.username,'updated');
  const filename = path.join(tmp,'data','db.json');
  const staged = filename+'.restore';
  // Simulate restored DB with no new user.
  db.writeDb(before);
  assert.equal(db.findUser('45678901234567890'),null);
  const backup = fs.readFileSync(filename);
  db.upsertUser({discordId:'56789012345678901',username:'external'});
  fs.writeFileSync(staged,backup);
  fs.renameSync(staged,filename);
  assert.equal(db.findUser('56789012345678901'),null);
});
