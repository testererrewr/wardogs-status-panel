import dns from 'node:dns/promises';
import net from 'node:net';

function isPrivateV4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) || (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

function isPrivateV6(ip) {
  const value = ip.toLowerCase().split('%')[0];
  if (value.startsWith('::ffff:')) { const tail = value.slice(7); if (net.isIP(tail) === 4) return isPrivateV4(tail); }
  return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') ||
    value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb') ||
    value.startsWith('ff') || value.startsWith('2001:db8:');
}

export function isPrivateIp(ip) {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateV4(ip);
  if (family === 6) return isPrivateV6(ip);
  return true;
}

export async function assertSafeHost(hostname, { allowPrivate = false } = {}) {
  const host = String(hostname || '').trim().replace(/^\[|\]$/g, '');
  if (!host) throw new Error('Host fehlt');
  if (allowPrivate) return;
  if (host.toLowerCase() === 'localhost') throw new Error('Private/localhost Ziele sind für diesen Account nicht erlaubt');

  const literalFamily = net.isIP(host);
  const addresses = literalFamily ? [{ address: host }] : await dns.lookup(host, { all: true, verbatim: true });
  if (!addresses.length) throw new Error('Host konnte nicht aufgelöst werden');
  if (addresses.some((x) => isPrivateIp(x.address))) throw new Error('Private/LAN/Loopback Ziele sind für diesen Account nicht erlaubt');
}

export async function assertSafeUrl(rawUrl, { allowPrivate = false } = {}) {
  let url;
  try { url = new URL(String(rawUrl || '')); } catch { throw new Error('Ungültige URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Nur http:// und https:// sind erlaubt');
  if (url.username || url.password) throw new Error('Benutzername/Passwort in der URL sind nicht erlaubt');
  await assertSafeHost(url.hostname, { allowPrivate });
  return url;
}
