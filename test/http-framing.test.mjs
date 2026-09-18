import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { safeHttpText } from '../src/target-safety.js';

async function withServer(handler, run) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  try { await run(`http://127.0.0.1:${port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test('safeHttpText frames JSON bodies with Content-Length, not chunked encoding', async () => {
  const received = {};
  await withServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received.headers = req.headers;
      received.body = Buffer.concat(chunks).toString('utf8');
      if (req.headers['transfer-encoding']) {
        res.writeHead(501, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'The request could not be parsed.' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'ok' }));
    });
  }, async (root) => {
    const payload = JSON.stringify({ message: 'Willkommen, äöü!' });
    const result = await safeHttpText(`${root}/v1/players/76561198000000000/message`, {
      allowPrivate: true,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    });
    assert.equal(result.status, 200);
    assert.equal(received.headers['transfer-encoding'], undefined);
    assert.equal(received.headers['content-length'], String(Buffer.byteLength(payload)));
    assert.equal(received.body, payload);
  });
});

test('safeHttpText also frames text/plain config bodies with byte-accurate Content-Length', async () => {
  const received = {};
  await withServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received.headers = req.headers;
      received.body = Buffer.concat(chunks).toString('utf8');
      res.writeHead(req.headers['transfer-encoding'] ? 501 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: !req.headers['transfer-encoding'] }));
    });
  }, async (root) => {
    const payload = '[Section]\nServerName=Grüße\n';
    const result = await safeHttpText(`${root}/v1/config`, {
      allowPrivate: true,
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: payload
    });
    assert.equal(result.status, 200);
    assert.equal(received.headers['transfer-encoding'], undefined);
    assert.equal(received.headers['content-length'], String(Buffer.byteLength(payload)));
    assert.equal(received.body, payload);
  });
});
