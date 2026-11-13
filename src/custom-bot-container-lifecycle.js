// A Docker container disappearing between inspect and cp/diff is recoverable:
// its old writable layer is gone, but any already persisted host data remains.
// Do not confuse this with a daemon outage, permission failure, or missing file.
export function isMissingDockerContainerError(message) {
  return /\bno such (?:container|object)\s*:/i.test(String(message || ''));
}

export function isMissingDockerFileError(message) {
  return /\b(?:no such file(?: or directory)?|could not find(?: the file)?)\b/i.test(String(message || ''));
}
