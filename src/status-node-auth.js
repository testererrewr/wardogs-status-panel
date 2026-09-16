import crypto from 'node:crypto';

export function newNodeToken() { return crypto.randomBytes(36).toString('base64url'); }
export function hashNodeToken(token) { return crypto.createHash('sha256').update(String(token || '')).digest('hex'); }
export function safeTokenEqual(token, hash) {
  const a = Buffer.from(hashNodeToken(token), 'hex');
  const b = Buffer.from(String(hash || ''), 'hex');
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}
