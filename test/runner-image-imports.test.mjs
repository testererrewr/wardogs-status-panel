import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dockerfile = readFileSync(path.join(root, 'Dockerfile.runner'), 'utf8');
const runner = readFileSync(path.join(root, 'src/runner.js'), 'utf8');

test('runner Dockerfile includes every local module directly imported by runner.js', () => {
  const copiedSources = new Set();
  for (const line of dockerfile.split('\n')) {
    const clean = line.trim();
    if (!/^COPY\s+/.test(clean)) continue;
    const args = clean.replace(/^COPY\s+/, '').trim().split(/\s+/);
    for (const arg of args.slice(0, -1)) {
      if (arg.startsWith('src/') && !arg.includes('*')) copiedSources.add(arg);
    }
  }
  assert.ok(copiedSources.has('src/runner.js'), 'runner entrypoint must be copied');
  const imports = [...runner.matchAll(/(?:import|export)\s+(?:[^;\n]*?\s+from\s+)?['"](\.[^'"]+)['"]/g)];
  const localModules = imports.map(([, target]) => path.posix.normalize(path.posix.join('src', target)));
  assert.ok(localModules.length > 0, 'expected local runner imports to validate');
  for (const module of localModules) {
    assert.ok(existsSync(path.join(root, module)), `local source module not found: ${module}`);
    assert.ok(copiedSources.has(module), `Runner image missing COPY for imported module: ${module}`);
  }
});
