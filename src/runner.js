import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { isMissingDockerContainerError, isMissingDockerFileError } from './custom-bot-container-lifecycle.js';

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

function run(cmd, args, { timeout = 120000, allowFailure = false, env = process.env, cwd = undefined, maxOutput = 120000, requireFullOutput = false } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    let truncated = false;
    const add = (target, chunk) => {
      const next = target + chunk.toString();
      if (next.length > maxOutput) truncated = true;
      return next.slice(-maxOutput);
    };
    p.stdout.on('data', (c) => { out = add(out, c); });
    p.stderr.on('data', (c) => { err = add(err, c); });
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`${cmd} Timeout`)); }, timeout);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (requireFullOutput && truncated) return reject(new Error('Zu viele Laufzeit-Dateiänderungen für eine vollständige Sicherung'));
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
  // IMPORTANT: untyped `docker inspect` matches images as well as containers.
  // Build creates an identically named :latest image before `docker create`.
  // An untyped inspect can therefore report a non-existent container as present.
  const r = await run('docker', ['inspect', '--type', 'container', name], { allowFailure: true, timeout: 15000 });
  if (r.code === 0) return true;
  // A stopped / removed container is normal; Docker daemon errors are not.
  if (isMissingDockerContainerError(`${r.err} ${r.out}`)) return false;
  throw new Error(`Docker-Containerstatus konnte nicht geprüft werden: ${(r.err || r.out).slice(0, 250)}`);
}
async function disappearedDuringCopy(container, errorText) {
  if (!isMissingDockerContainerError(errorText)) return false;
  if (await existsContainer(container)) return false;
  console.warn(`[custom-runner] Alter Container ${container} wurde während der Datenübernahme entfernt; vorhandene persistente Daten bleiben erhalten.`);
  return true;
}
async function isRunning(name) {
  const r = await run('docker', ['inspect', '--type', 'container', '-f', '{{.State.Running}}', name], { allowFailure: true, timeout: 15000 });
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
  const r = await run('docker', ['inspect', '--type', 'container', '-f', `{{if index .NetworkSettings.Networks \"${network}\"}}yes{{else}}no{{end}}`, container], { allowFailure: true, timeout: 15000 });
  return r.code === 0 && r.out.trim() === 'yes';
}
async function containerIsReadOnly(container) {
  const r = await run('docker', ['inspect', '--type', 'container', '-f', '{{.HostConfig.ReadonlyRootfs}}', container], { allowFailure: true, timeout: 15000 });
  return r.code === 0 && r.out.trim() === 'true';
}
async function recentLogs(container) {
  const r = await run('docker', ['logs', '--tail', '40', container], { allowFailure: true, timeout: 15000 });
  return `${r.out}${r.err}`.trim().slice(-2500);
}

async function build(id, image) {
  const dir = path.join(root, id);
  const dockerfile = path.join(dir, 'Dockerfile.generated');
  try {
    fs.accessSync(dir, fs.constants.R_OK | fs.constants.X_OK);
    fs.accessSync(dockerfile, fs.constants.R_OK);
  } catch (error) {
    if (error?.code === 'EACCES') throw new Error('upload files inaccessible (runner permissions)');
    throw new Error('upload files missing');
  }
  console.info(`[custom-runner] ${id}: Docker-Image wird gebaut`);
  try {
    await run('docker', ['build', '-t', image, '-f', 'Dockerfile.generated', '.'], { timeout: 240000, cwd: dir });
  } catch (error) {
    throw new Error(`Docker-Build fehlgeschlagen: ${String(error.message || error).slice(-2500)}`);
  }
  console.info(`[custom-runner] ${id}: Docker-Image erfolgreich gebaut`);
}
// Custom Bot runtime state MUST survive rebuilds. The main panel and runner
// share the same /workspace bind mount; resolve its actual HOST source from
// this runner container before asking the Docker daemon to mount it.
let hostWorkspaceCache = '';
async function hostWorkspace() {
  if (hostWorkspaceCache) return hostWorkspaceCache;
  const explicit = String(process.env.CUSTOM_BOTS_HOST_PATH || '').trim();
  // The update script passes the absolute host path explicitly. Docker's
  // auto-generated HOSTNAME may not be resolvable via self-inspect on every VPS.
  const result = explicit || (await run('docker', ['inspect', '--type', 'container', '-f', '{{range .Mounts}}{{if eq .Destination "/workspace"}}{{.Source}}{{end}}{{end}}', process.env.HOSTNAME || ''], { timeout: 12000 })).out.trim();
  if (!path.isAbsolute(result) || /[\x00-\x1f\x7f]/.test(result)) {
    throw new Error('Custom-Bot-Datenspeicher: Host-Pfad nicht gefunden. CUSTOM_BOTS_HOST_PATH in .env prüfen und Runner neu starten.');
  }
  hostWorkspaceCache = path.resolve(result);
  return hostWorkspaceCache;
}
async function containerHasDataMount(container) {
  const r = await run('docker', ['inspect', '--type', 'container', '-f', '{{range .Mounts}}{{if eq .Destination "/bot/data"}}yes{{end}}{{end}}', container], { allowFailure: true, timeout: 15000 });
  return r.code === 0 && r.out.trim() === 'yes';
}
const RUNTIME_MAX_FILES = 6000;
const RUNTIME_MAX_BYTES = 160 * 1024 * 1024;
function collectFiles(src) {
  if (!fs.existsSync(src)) return [];
  if (!fs.lstatSync(src).isDirectory()) throw new Error('Runtime-Datenordner ist ungültig');
  const out = [], stack = [src]; let bytes = 0;
  while (stack.length) {
    const dir = stack.pop();
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, item.name);
      if (item.isSymbolicLink()) throw new Error('Runtime-Daten enthalten einen unsicheren symbolischen Link');
      if (item.isDirectory()) { stack.push(absolute); continue; }
      if (!item.isFile()) continue;
      const stat = fs.lstatSync(absolute);
      if (stat.nlink !== 1) throw new Error('Runtime-Daten enthalten einen unsicheren Hardlink');
      bytes += stat.size;
      out.push(path.relative(src, absolute));
      if (out.length > RUNTIME_MAX_FILES || bytes > RUNTIME_MAX_BYTES) throw new Error('Runtime-Daten überschreiten 160 MB / 6000 Dateien – zuerst extern sichern');
    }
  }
  return out;
}
function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  for (const file of collectFiles(src)) {
    const target = path.join(dest, file);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(src, file), target);
    fs.chmodSync(target, 0o600);
  }
}
function replaceTree(dest, fresh) {
  const old = dest + '.old';
  fs.rmSync(old, { recursive: true, force: true });
  if (fs.existsSync(dest)) fs.renameSync(dest, old);
  fs.renameSync(fresh, dest);
  fs.rmSync(old, { recursive: true, force: true });
}
function writableRuntimeName(p) {
  const relative = p.startsWith('/bot/') ? p.slice(5) : '';
  if (!relative || relative.startsWith('data/') || relative === 'data') return '';
  const parts = relative.split('/');
  if (parts.some((x) => !x || x === '.' || x === '..' || /[\x00-\x1f\x7f]/.test(x))) return '';
  if (parts.some((x) => ['node_modules','.git','.venv','venv','__pycache__'].includes(x))) return '';
  // Other bot-created state (including root-level .db/.sqlite/.json) is kept;
  // changed directories are excluded by the explicit extension check below.
  const name = parts.at(-1);
  if (!/\.(?:db|sqlite|sqlite3|db-wal|db-shm|sqlite-wal|sqlite-shm|json|jsonl|yml|yaml|toml|csv|txt|log|bin|dat|pkl|pickle|parquet)$/i.test(name) && !/\.(?:db|sqlite|sqlite3)-(?:wal|shm|journal)$/i.test(name)) return '';
  return relative;
}
async function captureWritableRoot(container, id) {
  const base = path.join(root, id);
  const staged = path.join(base, '.runtime-root-next');
  fs.rmSync(staged, { recursive: true, force: true });
  fs.mkdirSync(staged, { recursive: true, mode: 0o700 });
  try {
    const result = await run('docker', ['diff', container], { timeout: 20000, maxOutput: 2_000_000, requireFullOutput: true, allowFailure: true });
    if (result.code !== 0) {
      if (await disappearedDuringCopy(container, `${result.err} ${result.out}`)) return false;
      throw new Error(`Container-Dateiänderungen konnten nicht gelesen werden: ${(result.err || result.out).slice(0, 250)}`);
    }
    const candidates = [...new Set(result.out.split(/\r?\n/).map((line) => writableRuntimeName(line.slice(2).trim())).filter(Boolean))];
    if (candidates.length > RUNTIME_MAX_FILES) throw new Error('Zu viele geänderte Laufzeitdateien für die Sicherung');
    for (const rel of candidates) {
      const out = path.join(staged, ...rel.split('/'));
      fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
      const copied = await run('docker', ['cp', `${container}:/bot/${rel}`, out], { timeout: 20000, allowFailure: true });
      if (copied.code !== 0) {
        if (await disappearedDuringCopy(container, `${copied.err} ${copied.out}`)) return false;
        // Files changed between diff and cp are possible on a live bot.
        if (isMissingDockerFileError(`${copied.err} ${copied.out}`)) continue;
        throw new Error(`Laufzeitdatei konnte nicht gesichert werden: ${(copied.err || copied.out).slice(0, 250)}`);
      }
      if (!fs.lstatSync(out).isFile() || fs.lstatSync(out).isSymbolicLink()) throw new Error('Unsichere Laufzeitdatei entdeckt');
    }
    collectFiles(staged);
    replaceTree(path.join(base, 'runtime-root'), staged);
    return true;
  } finally {
    // When the old container has vanished, never overwrite a previous good
    // runtime-root snapshot with a partial or empty staging tree.
    fs.rmSync(staged, { recursive: true, force: true });
  }
}
async function captureRuntime(id, { forBackup = false } = {}) {
  const { container } = names(id), base = path.join(root, id);
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const data = path.join(base, 'runtime-data');
  let running = false;
  if (await existsContainer(container)) {
    running = await isRunning(container);
    let paused = false, missing = false;
    try {
      if (running) {
        const pause = await run('docker', ['pause', container], { allowFailure: true, timeout: 20000 });
        if (pause.code === 0) paused = true;
        else if (await disappearedDuringCopy(container, `${pause.err} ${pause.out}`)) missing = true;
        else throw new Error(`Container konnte nicht pausiert werden: ${(pause.err || pause.out).slice(0, 250)}`);
      }
      if (!missing && !(await containerHasDataMount(container))) {
        const staging = path.join(base, '.runtime-data-next');
        fs.rmSync(staging, { recursive: true, force: true });
        fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
        try {
          const copied = await run('docker', ['cp', `${container}:/bot/data/.`, staging], { allowFailure: true, timeout: 25000 });
          if (copied.code === 0) {
            collectFiles(staging);
            replaceTree(data, staging);
          } else if (await disappearedDuringCopy(container, `${copied.err} ${copied.out}`)) {
            missing = true;
          } else if (!isMissingDockerFileError(`${copied.err} ${copied.out}`)) {
            throw new Error(`Container-Daten konnten nicht gelesen werden: ${(copied.err || copied.out).slice(0, 250)}`);
          }
          // Missing /bot/data is normal for bots that never used this folder.
        } finally {
          fs.rmSync(staging, { recursive: true, force: true });
        }
      }
      if (!missing) await captureWritableRoot(container, id);
      if (!fs.existsSync(data)) copyTree(path.join(base, 'src', 'data'), data);
      if (forBackup) {
        const staged = path.join(base, '.runtime-export-next');
        fs.rmSync(staged, { recursive: true, force: true });
        copyTree(data, staged);
        replaceTree(path.join(base, 'runtime-export-data'), staged);
      }
    } finally {
      if (paused) await run('docker', ['unpause', container], { allowFailure: true, timeout: 20000 });
    }
  }
  // Never replace existing host data because the legacy Docker container is
  // missing. Only seed data/ from the uploaded project on first creation.
  if (!fs.existsSync(data)) copyTree(path.join(base, 'src', 'data'), data);
  collectFiles(data);
  if (forBackup && !(await existsContainer(container))) {
    const staged = path.join(base, '.runtime-export-next');
    fs.rmSync(staged, { recursive: true, force: true });
    copyTree(data, staged);
    replaceTree(path.join(base, 'runtime-export-data'), staged);
  }
  return { running: running && await existsContainer(container), files: collectFiles(data).length };
}
// A snapshot, rebuild and delete for one bot must not overlap: all three
// touch the same SQLite files and staging directories.
const botLocks = new Map();
async function withBotLock(id, action) {
  const previous = botLocks.get(id) || Promise.resolve();
  let release;
  const mine = new Promise((resolve) => { release = resolve; });
  botLocks.set(id, mine);
  await previous;
  try { return await action(); }
  finally { release(); if (botLocks.get(id) === mine) botLocks.delete(id); }
}
async function startFresh(id, envObj) {
  const { container, image, network } = names(id);
  // Build first while the previous bot continues running. Stop it only for
  // the final, consistent SQLite snapshot (including WAL/SHM) before removal.
  // Build immediately from the uploaded source. Resolving the host volume
  // must never silently prevent the compile/install phase from starting.
  await build(id, image);
  await ensureNetwork(network, id);
  const hostSource = path.join(await hostWorkspace(), id, 'runtime-data');
  const hadContainer = await existsContainer(container);
  const wasRunning = hadContainer && await isRunning(container);
  if (wasRunning) {
    const stopped = await run('docker', ['stop', '-t', '10', container], { allowFailure: true, timeout: 25000 });
    if (stopped.code !== 0 && !(await disappearedDuringCopy(container, `${stopped.err} ${stopped.out}`))) {
      throw new Error(`Alter Container konnte nicht gestoppt werden: ${(stopped.err || stopped.out).slice(0, 250)}`);
    }
  }
  try { await captureRuntime(id); }
  catch (error) {
    if (wasRunning) await run('docker', ['start', container], { allowFailure: true, timeout: 20000 });
    throw error;
  }
  const localData = path.join(root, id, 'runtime-data');
  fs.mkdirSync(localData, { recursive: true, mode: 0o700 });
  await run('docker', ['rm', '-f', container], { allowFailure: true, timeout: 20000 });
  const args = ['create', '--name', container, '--restart', 'unless-stopped',
    '--memory', '256m', '--cpus', '0.50', '--pids-limit', '100',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--network', network,
    '--mount', `type=bind,src=${hostSource},dst=/bot/data`,
    '--log-opt', 'max-size=10m', '--log-opt', 'max-file=2', '--label', `server-status-hub.custom=${id}`];
  for (const [k, v] of Object.entries(validateEnv(envObj))) args.push('-e', `${k}=${v}`);
  args.push(image);
  console.info(`[custom-runner] ${id}: Docker-Container wird erstellt`);
  try {
    await run('docker', args, { timeout: 30000 });
  } catch (error) {
    throw new Error(`Docker-Container konnte nicht erstellt werden: ${String(error.message || error).slice(-1500)}`);
  }
  // Restore older root-level databases before the bot's process starts.
  const restored = path.join(root, id, 'runtime-root');
  if (fs.existsSync(restored) && collectFiles(restored).length) {
    await run('docker', ['cp', '-a', `${restored}/.`, `${container}:/bot/`], { timeout: 30000 });
  }
  console.info(`[custom-runner] ${id}: Bot wird gestartet`);
  await run('docker', ['start', container], { timeout: 20000 });
  await sleep(1200);
  if (!(await isRunning(container))) {
    const logs = await recentLogs(container);
    throw new Error(`custom bot exited directly after start${logs ? `: ${logs}` : ''}`);
  }
  console.info(`[custom-runner] ${id}: Bot läuft`);
  return container;
}

app.post('/ensure', async (req, res) => {
  try {
    const id = req.body.id; if (!validId(id)) throw new Error('invalid id');
    const result = await withBotLock(id, async () => {
      const { container, network } = names(id);
      if (await existsContainer(container)) {
        const wrongNetwork = !(await containerUsesNetwork(container, network));
        const legacyReadOnly = await containerIsReadOnly(container);
        if (wrongNetwork || legacyReadOnly) {
          await startFresh(id, req.body.env || {});
          return { ok: true, running: true, reused: false, migratedNetwork: wrongNetwork, migratedRuntime: legacyReadOnly };
        }
        if (!(await isRunning(container))) {
          const started = await run('docker', ['start', container], { allowFailure: true, timeout: 20000 });
          if (started.code !== 0) {
            if (!(await disappearedDuringCopy(container, `${started.err} ${started.out}`))) {
              throw new Error(`Bot-Container konnte nicht gestartet werden: ${(started.err || started.out).slice(0, 250)}`);
            }
            await startFresh(id, req.body.env || {});
            return { ok: true, running: true, reused: false, recoveredMissingContainer: true };
          }
        }
        return { ok: true, running: true, reused: true };
      }
      await startFresh(id, req.body.env || {});
      return { ok: true, running: true, reused: false };
    });
    res.json(result);
  } catch(e) { res.status(400).json({ error: e.message }); }
});
app.post('/restart', async (req, res) => {
  try {
    const id=req.body.id; if(!validId(id)) throw new Error('invalid id');
    await withBotLock(id, () => startFresh(id, req.body.env || {}));
    res.json({ok:true});
  } catch(e) { res.status(400).json({error:e.message}); }
});
app.post('/snapshot', async (req, res) => {
  try {
    const id=req.body.id; if(!validId(id)) throw new Error('invalid id');
    const result = await withBotLock(id, () => captureRuntime(id, { forBackup: true }));
    res.json({ok:true,...result});
  } catch(e) { res.status(400).json({error:e.message}); }
});
app.post('/runtime-stopped', async (req, res) => {
  try {
    const id=req.body.id; if(!validId(id)) throw new Error('invalid id');
    const result=await withBotLock(id, async ()=>{
      const {container}=names(id), exists=await existsContainer(names(id).container);
      return {ok:true, stopped:!exists || !(await isRunning(container)), persistent:!exists || await containerHasDataMount(container)};
    });
    res.json(result);
  } catch(e) {res.status(400).json({error:e.message});}
});
app.post('/delete-data-file', async (req, res) => {
  try {
    const id=req.body.id; if(!validId(id)) throw new Error('invalid id');
    const filename=String(req.body.path||'').replace(/\\/g,'/');
    const parts=filename.split('/');
    if (!filename || parts.some((x)=>!x || x==='.' || x==='..' || /[\x00-\x1f\x7f]/.test(x))) throw new Error('Ungültiger Dateipfad');
    const result=await withBotLock(id, async()=>{
      const {container}=names(id);
      if(await existsContainer(container)) {
        if(await isRunning(container)) throw new Error('Bot zuerst stoppen, bevor Datenbankdateien gelöscht werden.');
        if(!(await containerHasDataMount(container))) throw new Error('Bestehenden Bot zuerst über Start/Neu bauen auf persistenten Speicher umstellen.');
      }
      const base=path.resolve(root,id,'runtime-data');
      let current=base;
      for(const part of parts) {
        current=path.join(current,part);
        if(fs.lstatSync(current).isSymbolicLink()) throw new Error('Symbolische Links sind nicht erlaubt');
      }
      if(!current.startsWith(base+path.sep)) throw new Error('Ungültiger Dateipfad');
      const stat=fs.lstatSync(current);
      if(!stat.isFile() || stat.nlink>1) throw new Error('Nur normale Dateien dürfen gelöscht werden');
      fs.unlinkSync(current);
      let dir=path.dirname(current);
      while(dir!==base && fs.readdirSync(dir).length===0){fs.rmdirSync(dir);dir=path.dirname(dir);}
      return {ok:true};
    });
    res.json(result);
  } catch(e) {res.status(400).json({error:e.message});}
});
app.post('/stop', async (req, res) => {
  try {
    const id=req.body.id; if(!validId(id)) throw new Error('invalid id');
    await withBotLock(id, async ()=>{ const {container}=names(id); await run('docker',['stop','-t','10',container],{allowFailure:true,timeout:20000}); });
    res.json({ok:true});
  } catch(e) {res.status(400).json({error:e.message});}
});
app.post('/delete', async (req,res) => {
  try {
    const id=req.body.id; if(!validId(id)) throw new Error('invalid id');
    await withBotLock(id, async ()=>{
      const {container,image,network}=names(id);
      await run('docker',['rm','-f',container],{allowFailure:true,timeout:20000});
      await run('docker',['image','rm','-f',image],{allowFailure:true,timeout:30000});
      await run('docker',['network','rm',network],{allowFailure:true,timeout:20000});
    });
    res.json({ok:true});
  } catch(e) {res.status(400).json({error:e.message});}
});
// Query all custom containers with one Docker invocation instead of 2 calls per bot.
// The caller still enforces ownership; runner validates identifiers and exposes
// nothing outside the requested custom-bot container names.
app.post('/statuses', async (req, res) => {
  try {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || ids.length > 250 || ids.some((id) => !validId(id))) throw new Error('invalid bot ids');
    const unique = [...new Set(ids)];
    const statuses = Object.fromEntries(unique.map((id) => [id, { exists: false, running: false }]));
    if (!unique.length) return res.json({ ok: true, statuses });
    const byContainer = new Map(unique.map((id) => [names(id).container, id]));
    const result = await run('docker', ['ps', '--all', '--format', '{{.Names}}|{{.State}}'], { timeout: 5500 });
    for (const line of result.out.split(/\r?\n/)) {
      const separator = line.lastIndexOf('|');
      if (separator < 0) continue;
      const id = byContainer.get(line.slice(0, separator));
      if (!id) continue;
      statuses[id] = { exists: true, running: line.slice(separator + 1).trim() === 'running' };
    }
    res.json({ ok: true, statuses });
  } catch (e) { res.status(503).json({ error: e.message }); }
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
