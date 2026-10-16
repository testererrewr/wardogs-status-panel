import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const originalCwd = process.cwd();
const oldKey = process.env.APP_ENCRYPTION_KEY;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wardogs-db-cache-'));
process.chdir(tempDir);
process.env.APP_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
const db = await import(`${pathToFileURL(path.join(originalCwd, 'src/db.js')).href}?db-cache-test=${Date.now()}`);

test.after(() => {
  process.chdir(originalCwd);
  if (oldKey === undefined) delete process.env.APP_ENCRYPTION_KEY;
  else process.env.APP_ENCRYPTION_KEY = oldKey;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('encrypted DB cache never returns a mutable internal object', () => {
  const first = db.readDb();
  const originalUserCount = first.users.length;
  first.users.push({ discordId: '123', username: 'must-not-persist' });
  const second = db.readDb();
  assert.equal(second.users.length, originalUserCount);
  assert.equal(second.users.some((user) => user.discordId === '123'), false);
});

test('cache reflects subsequent upserts instead of returning stale data', () => {
  const id = '12345678901234567';
  db.upsertUser({ discordId: id, username: 'before' });
  assert.equal(db.findUser(id)?.username, 'before');
  db.upsertUser({ discordId: id, username: 'after' });
  assert.equal(db.findUser(id)?.username, 'after');
});

test('cache observes external encrypted database file replacement', () => {
  const filename = path.join(tempDir, 'data', 'db.json');
  const originalEncrypted = fs.readFileSync(filename);
  const id = '23456789012345678';
  db.upsertUser({ discordId: id, username: 'injected-after-backup' });
  assert.ok(db.findUser(id));
  // An atomic backup restore changes the on-disk signature, invalidating cache.
  const staged = `${filename}.restore`;
  fs.writeFileSync(staged, originalEncrypted);
  fs.renameSync(staged, filename);
  assert.equal(db.findUser(id), null);
});
