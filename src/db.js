import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = path.resolve('data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const TMP_FILE = path.join(DATA_DIR, 'db.tmp');

const emptyDb = () => ({ version: 1, users: [], servers: [] });

function ensure() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) writeDb(emptyDb());
}

export function readDb() {
  ensure();
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!Array.isArray(parsed.users) || !Array.isArray(parsed.servers)) throw new Error('DB schema invalid');
    return parsed;
  } catch (error) {
    throw new Error(`Datenbank konnte nicht gelesen werden: ${error.message}`);
  }
}

export function writeDb(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TMP_FILE, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(TMP_FILE, DB_FILE);
  try { fs.chmodSync(DB_FILE, 0o600); } catch {}
}

export function updateDb(mutator) {
  const db = readDb();
  const result = mutator(db);
  writeDb(db);
  return result;
}

export function getServer(id) {
  return readDb().servers.find((s) => s.id === id) || null;
}

export function upsertServer(server) {
  return updateDb((db) => {
    const now = new Date().toISOString();
    const index = db.servers.findIndex((s) => s.id === server.id);
    if (index >= 0) {
      db.servers[index] = { ...db.servers[index], ...server, updatedAt: now };
      return db.servers[index];
    }
    const entry = { id: server.id || crypto.randomUUID(), createdAt: now, updatedAt: now, ...server };
    db.servers.push(entry);
    return entry;
  });
}

export function deleteServer(id) {
  updateDb((db) => { db.servers = db.servers.filter((s) => s.id !== id); });
}

export function findUser(discordId) {
  return readDb().users.find((u) => u.discordId === discordId) || null;
}

export function upsertUser(user) {
  return updateDb((db) => {
    const now = new Date().toISOString();
    const index = db.users.findIndex((u) => u.discordId === user.discordId);
    if (index >= 0) {
      db.users[index] = { ...db.users[index], ...user, updatedAt: now };
      return db.users[index];
    }
    const entry = { createdAt: now, updatedAt: now, ...user };
    db.users.push(entry);
    return entry;
  });
}

export function deleteUser(discordId) {
  updateDb((db) => { db.users = db.users.filter((u) => u.discordId !== discordId); });
}
