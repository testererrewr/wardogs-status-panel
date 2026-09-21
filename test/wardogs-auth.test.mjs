import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WARDOGS_AUTH_MAX_FAILURES,
  isWardogsAuthFailure,
  wardogsAuthLockedMessage,
  createWardogsAuthLockedError
} from '../src/wardogs-auth.js';

test('WARDOGS auth protection locks after two authentication failures', () => {
  assert.equal(WARDOGS_AUTH_MAX_FAILURES, 2);
  assert.equal(isWardogsAuthFailure(Object.assign(new Error('unauthorized'), { status: 401 })), true);
  assert.equal(isWardogsAuthFailure(Object.assign(new Error('forbidden'), { status: 403 })), true);
  assert.equal(isWardogsAuthFailure(Object.assign(new Error('server error'), { status: 500 })), false);
  assert.match(wardogsAuthLockedMessage('WARDOGS API 401'), /2 Fehlversuchen/);
  const locked = createWardogsAuthLockedError('WARDOGS API 401');
  assert.equal(locked.wardogsAuthLocked, true);
  assert.equal(locked.status, 401);
});
