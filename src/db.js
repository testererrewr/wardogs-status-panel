import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = path.resolve('data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const TMP_FILE = path.join(DATA_DIR, 'db.tmp');

const emptyDb = () => ({ version: 3, users: [], servers: [], customBots: [] });

function migrate(parsed) {
  parsed.version = 3;
  if (!Array.isArray(parsed.users)) parsed.users = [];
  if (!Array.isArray(parsed.servers)) parsed.servers = [];
  if (!Array.isArray(parsed.customBots)) parsed.customBots = [];

  parsed.users = parsed.users.map((u) => ({
    ...u,
    role: u.role === 'admin' ? 'admin' : 'user',
    statusBotLimit: Number.isFinite(Number(u.statusBotLimit)) ? Number(u.statusBotLimit) : 1,
    customBotLimit: Number.isFinite(Number(u.customBotLimit)) ? Number(u.customBotLimit) : 0
  }));

  parsed.servers = parsed.servers.map((s) => {
    if (s.gameType) return s;
    return {
      ...s,
      gameType: 'wardogs',
      queryConfig: { baseUrl: s.rconUrl || '' },
      querySecretEnc: s.rconPasswordEnc || null
    };
  });
  return parsed;
}

function ensure() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) writeDb(emptyDb());
}

export function readDb() {
  ensure();
  try {
    const parsed = migrate(JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
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

export function assignLegacyOwnership(adminDiscordId) {
  if (!adminDiscordId) return;
  updateDb((db) => {
    for (const s of db.servers) if (!s.ownerDiscordId) s.ownerDiscordId = adminDiscordId;
    for (const b of db.customBots) if (!b.ownerDiscordId) b.ownerDiscordId = adminDiscordId;
  });
}

export function getServer(id) { return readDb().servers.find((s) => s.id === id) || null; }
export function listServersFor(discordId, isAdmin = false) {
  const servers = readDb().servers;
  return isAdmin ? servers : servers.filter((s) => s.ownerDiscordId === discordId);
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
export function deleteServer(id) { updateDb((db) => { db.servers = db.servers.filter((s) => s.id !== id); }); }

export function findUser(discordId) { return readDb().users.find((u) => u.discordId === discordId) || null; }
export function upsertUser(user) {
  return updateDb((db) => {
    const now = new Date().toISOString();
    const index = db.users.findIndex((u) => u.discordId === user.discordId);
    if (index >= 0) {
      db.users[index] = { ...db.users[index], ...user, updatedAt: now };
      return db.users[index];
    }
    const entry = {
      role: 'user', statusBotLimit: 1, customBotLimit: 0,
      createdAt: now, updatedAt: now, ...user
    };
    db.users.push(entry);
    return entry;
  });
}
export function deleteUser(discordId) { updateDb((db) => { db.users = db.users.filter((u) => u.discordId !== discordId); }); }

export function getCustomBot(id) { return readDb().customBots.find((b) => b.id === id) || null; }
export function listCustomBotsFor(discordId, isAdmin = false) {
  const bots = readDb().customBots;
  return isAdmin ? bots : bots.filter((b) => b.ownerDiscordId === discordId);
}
export function upsertCustomBot(bot) {
  return updateDb((db) => {
    const now = new Date().toISOString();
    const index = db.customBots.findIndex((b) => b.id === bot.id);
    if (index >= 0) {
      db.customBots[index] = { ...db.customBots[index], ...bot, updatedAt: now };
      return db.customBots[index];
    }
    const entry = { id: bot.id || crypto.randomUUID(), createdAt: now, updatedAt: now, ...bot };
    db.customBots.push(entry);
    return entry;
  });
}
export function deleteCustomBot(id) { updateDb((db) => { db.customBots = db.customBots.filter((b) => b.id !== id); }); }
