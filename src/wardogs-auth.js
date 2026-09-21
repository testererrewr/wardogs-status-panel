export const WARDOGS_AUTH_MAX_FAILURES = 2;

export function isWardogsAuthFailure(error) {
  const status = Number(error?.status || 0);
  if (status === 401 || status === 403) return true;
  const message = String(error?.message || error || '');
  return /(?:WARDOGS API|HTTP)\s+(?:401|403)\b/i.test(message);
}

export function wardogsAuthLockedMessage(reason = '') {
  const detail = String(reason || '').trim().slice(0, 220);
  return `WARDOGS Login nach ${WARDOGS_AUTH_MAX_FAILURES} Fehlversuchen gesperrt. Bot bleibt offline bis zum manuellen Neustart.${detail ? ` Letzter Fehler: ${detail}` : ''}`;
}

export function createWardogsAuthLockedError(reason = '') {
  const error = new Error(wardogsAuthLockedMessage(reason));
  error.code = 'WARDOGS_AUTH_LOCKED';
  error.status = 401;
  error.wardogsAuthLocked = true;
  return error;
}
