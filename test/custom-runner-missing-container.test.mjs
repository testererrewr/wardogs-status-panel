import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { isMissingDockerContainerError, isMissingDockerFileError } from '../src/custom-bot-container-lifecycle.js';

const runnerSource = fs.readFileSync(new URL('../src/runner.js', import.meta.url), 'utf8');
const begin = runnerSource.indexOf('function validateEnv(obj)');
const end = runnerSource.indexOf("app.post('/ensure'", begin);
assert.ok(begin > 0 && end > begin);
const source = runnerSource.slice(begin, end);

function fixture({ present = true, imagePresent = false, copyError = '', diffError = '', inspectError = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wardogs-runner-'));
  const id = crypto.randomUUID();
  const base = path.join(dir, id);
  fs.mkdirSync(path.join(base, 'src', 'data'), { recursive: true });
  fs.mkdirSync(path.join(base, 'runtime-data'), { recursive: true });
  fs.mkdirSync(path.join(base, 'runtime-root'), { recursive: true });
  fs.writeFileSync(path.join(base, 'src', 'data', 'initial.sqlite'), 'initial source');
  fs.writeFileSync(path.join(base, 'runtime-data', 'stats.sqlite'), 'persisted host database');
  fs.writeFileSync(path.join(base, 'runtime-root', 'stats.db'), 'previously recovered root database');
  const docker = [];
  let running = false;
  let imageBuilt = imagePresent;
  const container = `statushub-custom-${id}`;
  const calls = async (cmd, args) => {
    assert.equal(cmd, 'docker');
    docker.push(args);
    if (args[0] === 'inspect') {
      if (inspectError) return { code: 1, out: '', err: inspectError };
      const idx = args.indexOf('--type');
      const isContainerOnly = idx !== -1 && args[idx + 1] === 'container';
      // Critical regression: untyped docker inspect can match a built IMAGE
      // whose name is the same as a not-yet-created container.
      if (!present && (isContainerOnly || !imageBuilt)) return { code: 1, out: '', err: `Error: No such object: ${container}` };
      if (args.includes('-f')) return { code: 0, out: running ? 'true' : 'false', err: '' };
      return { code: 0, out: imageBuilt && !present ? '{"Id":"sha256:image"}' : '{}', err: '' };
    }
    if (args[0] === 'network' && args[1] === 'inspect') return { code: 0, out: '{}', err: '' };
    if (args[0] === 'build') { imageBuilt = true; return { code: 0, out: '', err: '' }; }
    if (args[0] === 'rm') { present = false; running = false; return { code: 1, out: '', err: `No such container: ${container}` }; }
    if (args[0] === 'create') { present = true; return { code: 0, out: container, err: '' }; }
    if (args[0] === 'start') { present = true; running = true; return { code: 0, out: container, err: '' }; }
    if (args[0] === 'cp') {
      if (copyError) {
        const result = { code: 1, out: '', err: copyError };
        if (isMissingDockerContainerError(copyError)) present = false;
        return result;
      }
      return { code: 1, out: '', err: 'no such file or directory' };
    }
    if (args[0] === 'diff') {
      if (diffError) {
        const result = { code: 1, out: '', err: diffError };
        if (isMissingDockerContainerError(diffError)) present = false;
        return result;
      }
      return { code: 0, out: '', err: '' };
    }
    if (args[0] === 'pause' || args[0] === 'unpause') return { code: 0, out: '', err: '' };
    throw new Error(`unexpected Docker command: ${args.join(' ')}`);
  };
  const ctx = { fs, path, process: { env: { CUSTOM_BOTS_HOST_PATH: dir, HOSTNAME: 'runner' } }, console: { warn(){} }, root: dir,
    names: (x) => ({ container: `statushub-custom-${x}`, image: `statushub-custom-${x}:latest`, network: `statushub-net-${x}` }), run: calls,
    isMissingDockerContainerError, isMissingDockerFileError, sleep: async () => {} };
  vm.createContext(ctx);
  vm.runInContext(`${source}\nglobalThis.__test = { existsContainer, captureRuntime, captureWritableRoot, startFresh };`, ctx);
  return { ...ctx.__test, base, id, docker, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('Docker distinguishes a missing container from a daemon outage', async () => {
  assert.ok(isMissingDockerContainerError('Error response from daemon: No such container: statushub-custom-x'));
  assert.ok(isMissingDockerContainerError('Error: No such object: statushub-custom-x'));
  assert.equal(isMissingDockerContainerError('Cannot connect to the Docker daemon'), false);
  assert.equal(isMissingDockerContainerError('No such file or directory'), false);
  assert.equal(isMissingDockerFileError('Could not find the file /bot/data'), true);
  const f = fixture({ inspectError: 'Cannot connect to the Docker daemon' });
  try { await assert.rejects(f.existsContainer(`statushub-custom-${f.id}`), /Docker-Containerstatus/); }
  finally { f.cleanup(); }
});

test('missing previous Docker container skips migration and preserves persisted data', async () => {
  const f = fixture({ present: false });
  try {
    const result = await f.captureRuntime(f.id);
    assert.equal(result.files, 1);
    assert.equal(fs.readFileSync(path.join(f.base,'runtime-data','stats.sqlite'),'utf8'), 'persisted host database');
    assert.equal(fs.readFileSync(path.join(f.base,'runtime-root','stats.db'),'utf8'), 'previously recovered root database');
    assert.equal(f.docker.some(args => args[0] === 'cp' || args[0] === 'diff'), false);
  } finally { f.cleanup(); }
});

test('container disappears after inspect, during data copy: rebuild can proceed without discarding host data', async () => {
  const f = fixture({ copyError: 'Error response from daemon: No such container: statushub-custom-xx' });
  try {
    await f.captureRuntime(f.id);
    assert.equal(fs.readFileSync(path.join(f.base,'runtime-data','stats.sqlite'),'utf8'), 'persisted host database');
    assert.equal(fs.readFileSync(path.join(f.base,'runtime-root','stats.db'),'utf8'), 'previously recovered root database');
    assert.equal(fs.existsSync(path.join(f.base,'.runtime-data-next')), false);
  } finally { f.cleanup(); }
});

test('container disappears during docker diff: previous runtime-root snapshot stays intact', async () => {
  const f = fixture({ diffError: 'Error response from daemon: No such container: statushub-custom-x' });
  try {
    await f.captureRuntime(f.id);
    assert.equal(fs.readFileSync(path.join(f.base,'runtime-root','stats.db'),'utf8'), 'previously recovered root database');
    assert.equal(fs.existsSync(path.join(f.base,'.runtime-root-next')), false);
  } finally { f.cleanup(); }
});

test('non-container copy errors still stop migration (no silent data loss)', async () => {
  const f = fixture({ copyError: 'permission denied' });
  try {
    await assert.rejects(f.captureRuntime(f.id), /Container-Daten konnten nicht gelesen werden/);
    assert.equal(fs.readFileSync(path.join(f.base,'runtime-data','stats.sqlite'),'utf8'), 'persisted host database');
    assert.equal(fs.existsSync(path.join(f.base,'.runtime-data-next')), false);
  } finally { f.cleanup(); }
});

test('new build starts normally when old container was already removed', async () => {
  const f = fixture({ present: false });
  try {
    fs.writeFileSync(path.join(f.base, 'Dockerfile.generated'), 'FROM scratch');
    const started = await f.startFresh(f.id, {});
    assert.equal(started, `statushub-custom-${f.id}`);
    assert.equal(f.docker.some(x => x[0] === 'build'), true);
    assert.equal(f.docker.some(x => x[0] === 'create'), true);
    assert.equal(f.docker.some(x => x[0] === 'start'), true);
    assert.equal(fs.readFileSync(path.join(f.base,'runtime-data','stats.sqlite'),'utf8'), 'persisted host database');
  } finally { f.cleanup(); }
});


test('an existing Docker image must never be mistaken for the bot container', async () => {
  const f = fixture({ present: false, imagePresent: true });
  try {
    assert.equal(await f.existsContainer(`statushub-custom-${f.id}`), false);
    await f.captureRuntime(f.id);
    assert.equal(f.docker.filter(x => x[0] === 'inspect').every(x => x.includes('--type') && x[x.indexOf('--type') + 1] === 'container'), true);
    assert.equal(f.docker.some(x => x[0] === 'cp' || x[0] === 'diff'), false);
    assert.equal(fs.readFileSync(path.join(f.base, 'runtime-data', 'stats.sqlite'), 'utf8'), 'persisted host database');
  } finally { f.cleanup(); }
});

test('new upload builds an image, but skips copying from nonexistent old container', async () => {
  const f = fixture({ present: false, imagePresent: false });
  try {
    fs.writeFileSync(path.join(f.base, 'Dockerfile.generated'), 'FROM scratch');
    await f.startFresh(f.id, {});
    const buildIndex = f.docker.findIndex(x => x[0] === 'build');
    const createIndex = f.docker.findIndex(x => x[0] === 'create');
    assert.ok(buildIndex >= 0 && createIndex > buildIndex);
    assert.equal(f.docker.some(x => x[0] === 'cp' && x[1].endsWith(':/bot/data/.')), false);
    assert.equal(f.docker.some(x => x[0] === 'diff'), false);
    assert.equal(f.docker.filter(x => x[0] === 'inspect').every(x => x.includes('--type') && x[x.indexOf('--type') + 1] === 'container'), true);
  } finally { f.cleanup(); }
});
