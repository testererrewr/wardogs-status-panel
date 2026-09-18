import dns from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';

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

export async function resolveSafeHost(hostname, { allowPrivate = false } = {}) {
  const host = String(hostname || '').trim().replace(/^\[|\]$/g, '');
  if (!host) throw new Error('Host fehlt');
  if (!allowPrivate && host.toLowerCase() === 'localhost') throw new Error('Private/localhost Ziele sind für diesen Account nicht erlaubt');

  const literalFamily = net.isIP(host);
  const addresses = literalFamily
    ? [{ address: host, family: literalFamily }]
    : await dns.lookup(host, { all: true, verbatim: true });
  if (!addresses.length) throw new Error('Host konnte nicht aufgelöst werden');
  const normalized = addresses.map((x) => ({ address: String(x.address), family: Number(x.family || net.isIP(x.address)) })).filter((x) => x.family === 4 || x.family === 6);
  if (!normalized.length) throw new Error('Host konnte nicht aufgelöst werden');
  if (!allowPrivate && normalized.some((x) => isPrivateIp(x.address))) throw new Error('Private/LAN/Loopback Ziele sind für diesen Account nicht erlaubt');
  return normalized;
}

export async function assertSafeHost(hostname, options = {}) {
  await resolveSafeHost(hostname, options);
}

export async function resolveSafeUrl(rawUrl, { allowPrivate = false } = {}) {
  let url;
  try { url = new URL(String(rawUrl || '')); } catch { throw new Error('Ungültige URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Nur http:// und https:// sind erlaubt');
  if (url.username || url.password) throw new Error('Benutzername/Passwort in der URL sind nicht erlaubt');
  const addresses = await resolveSafeHost(url.hostname, { allowPrivate });
  return { url, addresses };
}

export async function assertSafeUrl(rawUrl, options = {}) {
  const { url } = await resolveSafeUrl(rawUrl, options);
  return url;
}

function pinnedLookup(addresses) {
  const ordered = [...addresses].sort((a, b) => a.family === b.family ? 0 : a.family === 4 ? -1 : 1);
  return (hostname, options, callback) => {
    const opts = typeof options === 'object' && options ? options : {};
    const family = Number(opts.family || 0);
    const choices = family === 4 || family === 6 ? ordered.filter((x) => x.family === family) : ordered;
    const list = choices.length ? choices : ordered;
    if (opts.all) return callback(null, list.map((x) => ({ address: x.address, family: x.family })));
    const pick = list[0];
    callback(null, pick.address, pick.family);
  };
}

export async function safeHttpText(rawUrl, { allowPrivate = false, method = 'GET', headers = {}, body, timeoutMs = 8000, maxBytes = 1024 * 1024 } = {}) {
  const { url, addresses } = await resolveSafeUrl(rawUrl, { allowPrivate });
  const transport = url.protocol === 'https:' ? https : http;
  const requestHeaders = { 'Accept-Encoding': 'identity', ...headers };
  const requestMethod = String(method || 'GET').toUpperCase();
  const canRetry = requestMethod === 'GET' || requestMethod === 'HEAD';

  async function once() {
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finishReject = (error) => { if (!settled) { settled = true; reject(error); } };
      const req = transport.request({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: requestMethod,
        headers: requestHeaders,
        lookup: pinnedLookup(addresses),
        // Polling endpoints do not benefit from a pooled keep-alive socket. A
        // fresh socket avoids reusing a peer-closed connection, which surfaced
        // as intermittent `socket hang up`/ECONNRESET after the hardened HTTP
        // transport was introduced.
        agent: false,
        servername: url.hostname
      }, (res) => {
        const chunks = [];
        let total = 0;
        res.on('data', (chunk) => {
          if (settled) return;
          total += chunk.length;
          if (total > maxBytes) {
            settled = true;
            req.destroy();
            res.destroy();
            reject(new Error(`HTTP Antwort ist größer als ${Math.ceil(maxBytes / 1024)} KB`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          resolve({
            status: Number(res.statusCode || 0),
            ok: Number(res.statusCode || 0) >= 200 && Number(res.statusCode || 0) < 300,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8')
          });
        });
        res.on('error', finishReject);
      });
      req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('HTTP request timed out'), { code: 'ETIMEDOUT' })));
      req.on('error', finishReject);
      if (body !== undefined && body !== null) req.write(body);
      req.end();
    });
  }

  try {
    return await once();
  } catch (error) {
    const code = String(error?.code || '').toUpperCase();
    const transientReset = ['ECONNRESET', 'EPIPE'].includes(code) || /socket hang up/i.test(String(error?.message || ''));
    if (!canRetry || !transientReset) throw error;
    return await once();
  }
}
