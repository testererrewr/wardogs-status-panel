import crypto from 'node:crypto';

function getKey() {
  const raw = process.env.APP_ENCRYPTION_KEY?.trim();
  if (!raw) throw new Error('APP_ENCRYPTION_KEY fehlt. Erzeuge ihn mit: npm run keygen');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('APP_ENCRYPTION_KEY muss genau 32 Byte Base64 sein. Erzeuge ihn mit: npm run keygen');
  return key;
}

export function encryptSecret(value) {
  if (!value) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

export function decryptSecret(payload) {
  if (!payload) return '';
  const [version, ivB64, tagB64, dataB64] = String(payload).split(':');
  if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) throw new Error('Ungültiges Secret-Format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}
