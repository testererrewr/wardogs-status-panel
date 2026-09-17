import fs from 'node:fs';
import path from 'node:path';
import session from 'express-session';
import { encryptSecret, decryptSecret } from './crypto.js';

export class FileSessionStore extends session.Store {
  constructor(options = {}) {
    super();
    this.file = path.resolve(options.file || 'data/sessions.json');
    this.tmp = `${this.file}.tmp`;
    this.sessions = new Map();
    this.load();
  }

  load() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (!fs.existsSync(this.file)) return;
    try {
      const stored = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const raw = stored?.format === 'encrypted-v1' && stored?.data
        ? JSON.parse(decryptSecret(stored.data))
        : stored;
      for (const [sid, value] of Object.entries(raw || {})) this.sessions.set(sid, value);
      this.prune(false);
    } catch (error) {
      console.error('Session-Datei konnte nicht gelesen werden:', error.message);
    }
  }

  isExpired(sess) {
    const expires = sess?.cookie?.expires;
    return expires ? new Date(expires).getTime() <= Date.now() : false;
  }

  persist() {
    const obj = Object.fromEntries(this.sessions.entries());
    const payload = { format: 'encrypted-v1', data: encryptSecret(JSON.stringify(obj)) };
    fs.writeFileSync(this.tmp, JSON.stringify(payload), { mode: 0o600 });
    fs.renameSync(this.tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch {}
  }

  prune(save = true) {
    let changed = false;
    for (const [sid, sess] of this.sessions) {
      if (this.isExpired(sess)) {
        this.sessions.delete(sid);
        changed = true;
      }
    }
    if (changed && save) this.persist();
  }

  get(sid, cb) {
    try {
      const sess = this.sessions.get(sid);
      if (!sess || this.isExpired(sess)) {
        if (sess) { this.sessions.delete(sid); this.persist(); }
        return cb(null, null);
      }
      cb(null, sess);
    } catch (error) { cb(error); }
  }

  set(sid, sess, cb = () => {}) {
    try {
      this.sessions.set(sid, sess);
      this.prune(false);
      this.persist();
      cb(null);
    } catch (error) { cb(error); }
  }

  destroy(sid, cb = () => {}) {
    try {
      this.sessions.delete(sid);
      this.persist();
      cb(null);
    } catch (error) { cb(error); }
  }

  touch(sid, sess, cb = () => {}) {
    try {
      if (this.sessions.has(sid)) {
        this.sessions.set(sid, sess);
        this.persist();
      }
      cb(null);
    } catch (error) { cb(error); }
  }

  clear(cb = () => {}) {
    try { this.sessions.clear(); this.persist(); cb(null); } catch (error) { cb(error); }
  }

  length(cb) {
    try { this.prune(false); cb(null, this.sessions.size); } catch (error) { cb(error); }
  }
}
