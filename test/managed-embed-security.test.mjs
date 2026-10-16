import test from 'node:test';
import assert from 'node:assert/strict';
import { allowSameOriginManagedFrame } from '../src/managed-embed-security.js';

function response(headers = {}) {
  const values = new Map(Object.entries(headers));
  return {
    getHeader(name) { return values.get(name); },
    setHeader(name, value) { values.set(name, value); },
  };
}

test('managed subpages can be framed by same origin only (CSP and X-Frame-Options)', () => {
  const res = response({
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'; form-action 'self'",
    'X-Frame-Options': 'DENY',
  });
  allowSameOriginManagedFrame(res);
  assert.equal(res.getHeader('X-Frame-Options'), 'SAMEORIGIN');
  assert.match(res.getHeader('Content-Security-Policy'), /frame-ancestors 'self'/);
  assert.doesNotMatch(res.getHeader('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.match(res.getHeader('Content-Security-Policy'), /form-action 'self'/);
  assert.match(res.getHeader('Content-Security-Policy'), /object-src 'none'/);
  assert.match(res.getHeader('Content-Security-Policy'), /script-src 'self' 'unsafe-inline'/);
});

test('reapplying the override never duplicates frame-ancestors and keeps other policy', () => {
  const res = response({ 'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; img-src 'self' data:" });
  allowSameOriginManagedFrame(res);
  allowSameOriginManagedFrame(res);
  assert.equal((res.getHeader('Content-Security-Policy').match(/frame-ancestors/g)||[]).length, 1);
  assert.match(res.getHeader('Content-Security-Policy'), /img-src 'self' data:/);
});
