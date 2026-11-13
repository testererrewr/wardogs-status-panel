import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const runner = fs.readFileSync(new URL('../src/runner.js', import.meta.url), 'utf8');
const compose = fs.readFileSync(new URL('../compose.yaml', import.meta.url), 'utf8');
const update = fs.readFileSync(new URL('../update.sh', import.meta.url), 'utf8');
const customBots = fs.readFileSync(new URL('../src/custom-bots.js', import.meta.url), 'utf8');

test('runner host volume is deterministic on install and exposed to runner container', () => {
  assert.match(update, /CUSTOM_BOTS_HOST_PATH="\$\(realpath custom-bots\)"/);
  assert.match(update, /CUSTOM_BOTS_HOST_PATH=.*>> \.env/);
  assert.match(compose, /CUSTOM_BOTS_HOST_PATH: \${CUSTOM_BOTS_HOST_PATH:-}/);
});

test('new uploads build before resolving host mount, while existing container is not stopped until after build', () => {
  const start = runner.slice(runner.indexOf('async function startFresh('), runner.indexOf("app.post('/ensure'"));
  assert.ok(start.indexOf('await build(id, image)') < start.indexOf('await hostWorkspace()'));
  assert.ok(start.indexOf('await build(id, image)') < start.indexOf("['stop', '-t', '10', container]"));
  assert.ok(start.lastIndexOf("['start', container]") > start.indexOf("const args = ['create', '--name'"));
});

test('Node builds run package build scripts with development toolchain, prune dev deps after compilation', () => {
  const begin = customBots.indexOf('function buildDockerfile(');
  const end = customBots.indexOf('function writeGeneratedRuntimeFiles(', begin);
  assert.ok(begin > 0 && end > begin);
  const code = customBots.slice(begin, end);
  const context = { safeEntry: (entry) => entry };
  vm.createContext(context);
  const makeDockerfile = vm.runInContext(`${code}\nbuildDockerfile`, context);
  const node = makeDockerfile('node22', 'src/index.js');
  assert.match(node, /npm ci --no-audit/);
  assert.match(node, /npm run build --if-present/);
  assert.match(node, /npm prune --omit=dev/);
  assert.match(node, /CMD \["node","src\/index\.js"\]/);
  const python = makeDockerfile('python313', 'bot.py');
  assert.match(python, /pip install/);
  assert.doesNotMatch(python, /npm run build/);
});
