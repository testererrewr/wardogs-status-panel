import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const app = express();
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false, hsts: false }));
app.use(express.json({ limit: '256kb' }));
app.use(rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: 'draft-8', legacyHeaders: false }));
const port = Number(process.env.RUNNER_PORT || 4000);
const shared = process.env.RUNNER_SHARED_SECRET || '';
const root = '/workspace';

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}
function validId(id) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(id || '')); }
function names(id) { return { container: `statushub-custom-${id}`, image: `statushub-custom-${id}:latest`, network: `statushub-net-${id}` }; }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function auth(req, res, next) { if (!shared || !safeEqual(req.get('X-Runner-Secret'), shared)) return res.status(403).json({ error: 'forbidden' }); next(); }
app.use(auth);

function run(cmd, args, { timeout = 120000, allowFailure = false, env = process.env, cwd = undefined } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const add = (target, chunk) => (target + chunk.toString()).slice(-120000);
    p.stdout.on('data', (c) => { out = add(out, c); });
    p.stderr.on('data', (c) => { err = add(err, c); });
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`${cmd} Timeout`)); }, timeout);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 || allowFailure) resolve({ code, out, err });
      else reject(new Error((err || out || `${cmd} exit ${code}`).slice(-4000)));
    });
  });
}

function validateEnv(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const entries = Object.entries(obj);
  if (entries.length > 50) throw new Error('too many env vars');
  const out = {};
  for (const [k, v] of entries) {
    if (!/^[A-Z_][A-Z0-9_]{0,63}$/i.test(k)) throw new Error('invalid env key');
    if (String(v).length > 4096) throw new Error('env value too long');
    out[k] = String(v);
  }
  return out;
}

async function existsContainer(name) {
  const r = await run('docker', ['inspect', name], { allowFailure: true, timeout: 15000 });
  return r.code === 0;
}
async function isRunning(name) {
  const r = await run('docker', ['inspect', '-f', '{{.State.Running}}', name], { allowFailure: true, timeout: 15000 });
  return r.code === 0 && r.out.trim() === 'true';
}
async function ensureNetwork(name, id) {
  const exists = await run('docker', ['network', 'inspect', name], { allowFailure: true, timeout: 15000 });
  if (exists.code === 0) return;
  const created = await run('docker', ['network', 'create', '--driver', 'bridge', '--opt', 'com.docker.network.bridge.enable_icc=false', '--label', `server-status-hub.custom=${id}`, name], { allowFailure: true, timeout: 20000 });
  if (created.code !== 0) {
    const retry = await run('docker', ['network', 'inspect', name], { allowFailure: true, timeout: 15000 });
    if (retry.code !== 0) throw new Error('custom bot network could not be created');
  }
}
async function containerUsesNetwork(container, network) {
  const r = await run('docker', ['inspect', '-f', `{{if index .NetworkSettings.Networks \"${network}\"}}yes{{else}}no{{end}}`, container], { allowFailure: true, timeout: 15000 });
  return r.code === 0 && r.out.trim() === 'yes';
}
async function containerIsReadOnly(container) {
  const r = await run('docker', ['inspect', '-f', '{{.HostConfig.ReadonlyRootfs}}', container], { allowFailure: true, timeout: 15000 });
  return r.code === 0 && r.out.trim() === 'true';
}
async function recentLogs(container) {
  const r = await run('docker', ['logs', '--tail', '40', container], { allowFailure: true, timeout: 15000 });
  return `${r.out}${r.err}`.trim().slice(-2500);
}

async function build(id, image) {
  const dir = path.join(root, id);
  if (!fs.existsSync(path.join(dir, 'Dockerfile.generated'))) throw new Error('upload files missing');
  await run('docker', ['build', '-t', image, '-f', 'Dockerfile.generated', '.'], { timeout: 240000, cwd: dir });
}
async function startFresh(id, envObj) {
  const { container, image, network } = names(id);
  await run('docker', ['rm', '-f', container], { allowFailure: true, timeout: 20000 });
  await ensureNetwork(network, id);
  await build(id, image);
  const args = ['run', '-d', '--name', container, '--restart', 'unless-stopped',
    '--memory', '256m', '--cpus', '0.50', '--pids-limit', '100',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--network', network,
    '--log-opt', 'max-size=10m', '--log-opt', 'max-file=2', '--label', `server-status-hub.custom=${id}`];
  for (const [k, v] of Object.entries(validateEnv(envObj))) args.push('-e', `${k}=${v}`);
  args.push(image);
  const r = await run('docker', args, { timeout: 30000 });
  // A custom bot is expected to be a long-running process. Give it a brief
  // startup window so an immediate crash is surfaced instead of being reported
  // as a successful start. Docker still keeps the normal unless-stopped policy.
  await sleep(1200);
  if (!(await isRunning(container))) {
    const logs = await recentLogs(container);
    throw new Error(`custom bot exited directly after start${logs ? `: ${logs}` : ''}`);
  }
  return r.out.trim();
}

app.post('/ensure', async (req, res) => {
  try {
    const id = req.body.id; if (!validId(id)) throw new Error('invalid id');
    const { container, network } = names(id);
    if (await existsContainer(container)) {
      const wrongNetwork = !(await containerUsesNetwork(container, network));
      const legacyReadOnly = await containerIsReadOnly(container);
      if (wrongNetwork || legacyReadOnly) {
        await startFresh(id, req.body.env || {});
        return res.json({ ok: true, running: true, reused: false, migratedNetwork: wrongNetwork, migratedRuntime: legacyReadOnly });
      }
      if (!(await isRunning(container))) await run('docker', ['start', container], { timeout: 20000 });
      return res.json({ ok: true, running: true, reused: true });
    }
    await startFresh(id, req.body.env || {});
    res.json({ ok: true, running: true, reused: false });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/restart', async (req, res) => {
  try { const id = req.body.id; if (!validId(id)) throw new Error('invalid id'); await startFresh(id, req.body.env || {}); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/stop', async (req, res) => {
  try { const id = req.body.id; if (!validId(id)) throw new Error('invalid id'); const { container } = names(id); await run('docker', ['stop', '-t', '10', container], { allowFailure: true, timeout: 20000 }); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/delete', async (req, res) => {
  try { const id = req.body.id; if (!validId(id)) throw new Error('invalid id'); const { container, image, network } = names(id); await run('docker', ['rm', '-f', container], { allowFailure: true, timeout: 20000 }); await run('docker', ['image', 'rm', '-f', image], { allowFailure: true, timeout: 30000 }); await run('docker', ['network', 'rm', network], { allowFailure: true, timeout: 20000 }); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/status', async (req, res) => {
  try { const id = req.body.id; if (!validId(id)) throw new Error('invalid id'); const { container } = names(id); const exists = await existsContainer(container); res.json({ ok: true, exists, running: exists ? await isRunning(container) : false }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
function redactLogs(text, values = []) {
  let out = String(text || '');
  for (const value of values.filter((x) => typeof x === 'string' && x.length >= 6).slice(0, 50)) out = out.split(value).join('[REDACTED]');
  out = out
    .replace(/((?:token|secret|password|passwd|api[_-]?key|authorization)\s*[:=]\s*)([^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/(Bot\s+)[A-Za-z0-9._-]{20,}/gi, '$1[REDACTED]');
  return out.slice(-50000);
}
app.post('/logs', async (req, res) => {
  try { const id = req.body.id; if (!validId(id)) throw new Error('invalid id'); const { container } = names(id); const r = await run('docker', ['logs', '--tail', '200', container], { allowFailure: true, timeout: 20000 }); res.json({ ok: true, logs: redactLogs(`${r.out}${r.err}`, Array.isArray(req.body.redact) ? req.body.redact.map(String) : []) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/healthz', (req, res) => res.json({ ok: true }));
const server = app.listen(port, '0.0.0.0', () => console.log(`Custom bot runner listening on ${port}`));
server.headersTimeout = 10_000;
server.requestTimeout = 20_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 500;
server.maxHeadersCount = 60;
