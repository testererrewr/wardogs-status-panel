import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const originalCwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'status-hub-sharing-'));
process.chdir(tmp);
process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const db = await import(`${pathToFileURL(path.join(originalCwd, 'src/db.js')).href}?sharing-test=${Date.now()}`);

test.after(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('service bot can be shared with panel users without changing ownership', () => {
  const owner = '11111111111111111';
  const shared = '22222222222222222';
  db.upsertUser({ discordId: owner, username: 'owner' });
  db.upsertUser({ discordId: shared, username: 'shared' });
  const bot = db.upsertManagedBot({ ownerDiscordId: owner, serviceId: 'wardogs-warning-bot', name: 'Shared WARDOGS Bot', sharedPanelUserIds: [shared] });

  assert.equal(db.listManagedBotsForUserService(owner, 'wardogs-warning-bot').some((row) => row.id === bot.id), true);
  assert.equal(db.listManagedBotsForUserService(shared, 'wardogs-warning-bot').some((row) => row.id === bot.id), false);
  assert.equal(db.listManagedBotsAccessibleToUserService(shared, 'wardogs-warning-bot').some((row) => row.id === bot.id), true);
  assert.equal(db.getManagedBot(bot.id).ownerDiscordId, owner);
});

test('deleting a panel user removes its service-bot shares', () => {
  const shared = '22222222222222222';
  const bot = db.readDb().managedBots[0];
  assert.ok(bot.sharedPanelUserIds.includes(shared));
  db.deleteUser(shared);
  assert.equal(db.getManagedBot(bot.id).sharedPanelUserIds.includes(shared), false);
});
