import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import AdmZip from 'adm-zip';

const ROOT = path.resolve('custom-bots');
const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 5000;
const MAX_RAW_ENTRIES = 20000;
const MAX_UNPACKED_BYTES = 100 * 1024 * 1024;
const MAX_LOOSE_FILES = 20;
const IGNORED_PARTS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__']);
const SENSITIVE_UPLOAD_NAMES = new Set(['.npmrc', '.pypirc', '.netrc', 'id_rsa', 'id_ed25519', 'credentials.json']);
function sensitiveUploadEntry(name) { const parts = String(name || '').split('/').filter(Boolean); const base = String(parts.at(-1) || '').toLowerCase(); return SENSITIVE_UPLOAD_NAMES.has(base) || ['id_ecdsa','id_dsa'].includes(base); }

function validBotId(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(id || ''));
}

function pathParts(value, errorMessage, allowEmpty = false) {
  const raw = String(value || '').replace(/\\/g, '/').trim();
  if (!raw && allowEmpty) return [];
  if (!raw || raw.includes('\0') || raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) throw new Error(errorMessage);
  const originalParts = raw.split('/');
  if (originalParts.some((part) => part === '..')) throw new Error(errorMessage);
  const parts = originalParts.filter((part) => part && part !== '.');
  if (!parts.length) {
    if (allowEmpty) return [];
    throw new Error(errorMessage);
  }
  if (parts.some((part) => /[\x00-\x1f\x7f]/.test(part))) throw new Error(errorMessage);
  return parts;
}

function safeRelativePath(value, errorMessage = 'Ungültiger Dateipfad', allowEmpty = false) {
  return pathParts(value, errorMessage, allowEmpty).join('/');
}

function safeEntry(value, runtime) {
  const p = safeRelativePath(String(value || '').trim().replace(/^\.\//, ''), 'Ungültiger Entrypoint');
  if (runtime === 'node22' && !/\.(?:js|mjs|cjs)$/i.test(p)) throw new Error('Node Entrypoint muss .js/.mjs/.cjs sein');
  if (runtime === 'python313' && !/\.py$/i.test(p)) throw new Error('Python Entrypoint muss .py sein');
  return p;
}

function cleanZipName(value, allowEmptyDirectory = false) {
  const raw = String(value || '').replace(/\\/g, '/');
  if (!raw || raw.includes('\0') || raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) throw new Error('ZIP enthält einen unsicheren Pfad');
  const originalParts = raw.split('/');
  if (originalParts.some((part) => part === '..')) throw new Error('ZIP enthält einen unsicheren Pfad');
  const parts = originalParts.filter((part) => part && part !== '.');
  if (!parts.length) {
    if (allowEmptyDirectory) return '';
    throw new Error('ZIP enthält einen unsicheren Pfad');
  }
  if (parts.some((part) => /[\x00-\x1f\x7f]/.test(part))) throw new Error('ZIP enthält einen unsicheren Pfad');
  return parts.join('/');
}

function noiseEntry(name) {
  const lower = String(name || '').toLowerCase();
  return lower === '.ds_store' || lower.endsWith('/.ds_store') || lower === '__macosx' || lower.startsWith('__macosx/');
}

function ignoredDependencyEntry(name) {
  const parts = String(name || '').split('/').filter(Boolean).map((part) => part.toLowerCase());
  return parts.some((part) => IGNORED_PARTS.has(part));
}

function assertWritableProjectPath(name) {
  if (!name) throw new Error('Ungültiger Dateipfad');
  if (sensitiveUploadEntry(name)) throw new Error(`Die sensible Datei ${name} darf nicht hochgeladen werden. Secrets bitte ausschließlich über die ENV-Felder hinterlegen.`);
  if (ignoredDependencyEntry(name)) throw new Error(`Der Pfad ${name} liegt in einem nicht erlaubten Dependency-/Cache-Ordner.`);
  if (noiseEntry(name)) throw new Error(`Die Datei ${name} wird nicht als Projektdatei akzeptiert.`);
}

function detectWrapper(fileNames) {
  if (!fileNames.length || fileNames.some((name) => !name.includes('/'))) return '';
  const first = fileNames[0].split('/')[0];
  if (!first || !fileNames.every((name) => name.startsWith(`${first}/`))) return '';
  return `${first}/`;
}

function entryCandidates(runtime) {
  return runtime === 'python313'
    ? ['bot.py', 'main.py', 'app.py', 'run.py', 'index.py', 'src/bot.py', 'src/main.py', 'src/app.py', 'src/run.py']
    : ['index.js', 'bot.js', 'main.js', 'app.js', 'server.js', 'run.js', 'index.mjs', 'bot.mjs', 'main.mjs', 'app.mjs', 'index.cjs', 'bot.cjs', 'main.cjs', 'src/index.js', 'src/bot.js', 'src/main.js', 'src/app.js'];
}

function declaredSize(item) {
  const size = Number(item?.header?.size ?? 0);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('ZIP enthält eine Datei mit ungültiger Größenangabe');
  return size;
}

function getEntryData(item, label) {
  try {
    const data = item.getData();
    if (!Buffer.isBuffer(data)) return Buffer.from(data || '');
    return data;
  } catch (error) {
    throw new Error(`ZIP-Datei ${label} konnte nicht gelesen werden: ${String(error?.message || error).slice(0, 180)}`);
  }
}

function packageEntrypoints(filesByName, runtime) {
  if (runtime !== 'node22') return [];
  const item = filesByName.get('package.json');
  if (!item) return [];
  const size = declaredSize(item);
  if (size > 1024 * 1024) throw new Error('package.json ist ungewöhnlich groß');
  let pkg;
  try { pkg = JSON.parse(getEntryData(item, 'package.json').toString('utf8')); }
  catch (error) {
    if (/konnte nicht gelesen/.test(String(error?.message || ''))) throw error;
    throw new Error('package.json ist ungültiges JSON');
  }
  const out = [];
  if (typeof pkg?.main === 'string' && pkg.main.trim()) {
    try { out.push(safeEntry(pkg.main, runtime)); } catch {}
  }
  const start = typeof pkg?.scripts?.start === 'string' ? pkg.scripts.start.trim() : '';
  const match = start.match(/^node(?:\s+--[A-Za-z0-9._=-]+)*\s+([^;&|]+\.(?:js|mjs|cjs))\s*$/i);
  if (match) {
    const candidate = match[1].trim().replace(/^['"]|['"]$/g, '');
    try { out.push(safeEntry(candidate, runtime)); } catch {}
  }
  return [...new Set(out)];
}

function botDir(id) {
  if (!validBotId(id)) throw new Error('Ungültige Bot-ID');
  return path.join(ROOT, id);
}

function botSourceRoot(id) {
  return path.join(botDir(id), 'src');
}

function resolveSourcePath(id, relativePath) {
  const rel = safeRelativePath(relativePath, 'Ungültiger Dateipfad');
  const root = path.resolve(botSourceRoot(id));
  const candidate = path.resolve(root, rel);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) throw new Error('Dateipfad liegt außerhalb des Bot-Projekts');
  return { rel, absolute: candidate, root };
}

function buildDockerfile(runtime, entrypoint) {
  const entry = safeEntry(entrypoint, runtime);
  const command = runtime === 'node22' ? ['node', entry] : ['python', entry];
  if (runtime === 'node22') {
    return `FROM node:22-alpine\nWORKDIR /bot\nCOPY src/ .\nRUN if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; elif [ -f package.json ]; then npm install --omit=dev --no-audit --no-fund; fi\nRUN chown -R node:node /bot\nUSER node\nCMD ${JSON.stringify(command)}\n`;
  }
  if (runtime === 'python313') {
    return `FROM python:3.13-slim\nENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1\nWORKDIR /bot\nCOPY src/ .\nRUN if [ -f requirements.txt ]; then python -m pip install --no-cache-dir -r requirements.txt; fi\nRUN useradd -m -u 10001 bot && chown -R bot:bot /bot\nUSER bot\nCMD ${JSON.stringify(command)}\n`;
  }
  throw new Error('Unbekannte Runtime');
}

function writeGeneratedRuntimeFiles(id, runtime, entrypoint) {
  const dest = botDir(id);
  fs.writeFileSync(path.join(dest, 'Dockerfile.generated'), buildDockerfile(runtime, entrypoint), { mode: 0o600 });
  fs.writeFileSync(path.join(dest, '.dockerignore'), '.git\nnode_modules\n__pycache__\nsource.zip\n', { mode: 0o600 });
}

function projectStats(id) {
  const root = botSourceRoot(id);
  if (!fs.existsSync(root)) return { fileCount: 0, unpackedBytes: 0 };
  let fileCount = 0;
  let unpackedBytes = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Symbolische Links sind in Custom-Bot-Projekten nicht erlaubt');
      if (entry.isDirectory()) { stack.push(full); continue; }
      if (!entry.isFile()) continue;
      const rel = path.relative(root, full).split(path.sep).join('/');
      assertWritableProjectPath(rel);
      const stat = fs.statSync(full);
      fileCount += 1;
      unpackedBytes += stat.size;
      if (fileCount > MAX_FILES) throw new Error(`Projekt enthält zu viele Quelldateien (maximal ${MAX_FILES})`);
      if (unpackedBytes > MAX_UNPACKED_BYTES) throw new Error('Projekt ist entpackt größer als 100 MB');
    }
  }
  return { fileCount, unpackedBytes };
}

function rebuildSourceZip(id) {
  const root = botSourceRoot(id);
  const dest = botDir(id);
  const zip = new AdmZip();
  const files = listCustomBotFiles(id);
  for (const file of files) zip.addFile(file.path, fs.readFileSync(path.join(root, ...file.path.split('/'))));
  const out = path.join(dest, 'source.zip');
  zip.writeZip(out);
  try { fs.chmodSync(out, 0o600); } catch {}
  return out;
}

export function parseEnvText(text) {
  const env = {};
  const lines = String(text || '').split(/\r?\n/).filter((x) => x.trim() && !x.trim().startsWith('#'));
  if (lines.length > 50) throw new Error('Maximal 50 Umgebungsvariablen');
  for (const line of lines) {
    const idx = line.indexOf('=');
    if (idx < 1) throw new Error(`Ungültige ENV-Zeile: ${line.slice(0, 40)}`);
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1);
    if (!/^[A-Z_][A-Z0-9_]{0,63}$/i.test(key)) throw new Error(`Ungültiger ENV-Name: ${key}`);
    if (value.length > 4096) throw new Error(`ENV ${key} ist zu lang`);
    env[key] = value;
  }
  return env;
}

export function prepareCustomBot({ id = crypto.randomUUID(), buffer, runtime, entrypoint }) {
  if (!validBotId(id)) throw new Error('Ungültige Bot-ID');
  if (!['node22', 'python313'].includes(runtime)) throw new Error('Unbekannte Runtime');
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('ZIP-Datei ist leer');
  if (buffer.length > MAX_ARCHIVE_BYTES) throw new Error('ZIP-Datei ist größer als 25 MB');

  const rawEntrypoint = String(entrypoint || '').trim();
  let requestedEntry = rawEntrypoint ? safeEntry(rawEntrypoint, runtime) : '';
  const dest = botDir(id);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.join(dest, 'src'), { recursive: true });

  try {
    let zip;
    try { zip = new AdmZip(buffer); } catch { throw new Error('ZIP-Datei ist ungültig oder beschädigt'); }
    const rawEntries = zip.getEntries();
    if (!Array.isArray(rawEntries) || !rawEntries.length) throw new Error('ZIP-Datei ist leer');
    if (rawEntries.length > MAX_RAW_ENTRIES) throw new Error(`ZIP enthält zu viele Einträge (maximal ${MAX_RAW_ENTRIES})`);
    const safeRawEntries = rawEntries.map((item) => ({ item, name: cleanZipName(item.entryName, item.isDirectory) }));
    const sensitive = safeRawEntries.find(({ item, name }) => !item.isDirectory && sensitiveUploadEntry(name));
    if (sensitive) throw new Error(`ZIP enthält die sensible Datei ${sensitive.name}. Secrets bitte ausschließlich über die ENV-Felder hinterlegen.`);
    fs.writeFileSync(path.join(dest, 'source.zip'), buffer, { mode: 0o600 });

    const entries = safeRawEntries.filter(({ name }) => name && !noiseEntry(name) && !ignoredDependencyEntry(name));
    const files = entries.filter(({ item }) => !item.isDirectory);
    if (!files.length) throw new Error('ZIP enthält keine verwendbaren Quelldateien');
    if (files.length > MAX_FILES) throw new Error(`ZIP enthält zu viele Quelldateien (maximal ${MAX_FILES}). node_modules, .git, venv und Cache-Ordner werden automatisch ignoriert.`);

    let declaredTotal = 0;
    for (const { item } of files) {
      const size = declaredSize(item);
      if (size > MAX_UNPACKED_BYTES || declaredTotal + size > MAX_UNPACKED_BYTES) throw new Error('ZIP entpackt größer als 100 MB');
      declaredTotal += size;
    }

    const originalFileNames = files.map(({ name }) => name);
    const wrapper = detectWrapper(originalFileNames);
    const normalized = files.map(({ item, name }) => ({ item, originalName: name, name: wrapper && name.startsWith(wrapper) ? name.slice(wrapper.length) : name }));
    const filesByName = new Map();
    for (const file of normalized) {
      if (!file.name) continue;
      if (filesByName.has(file.name)) throw new Error(`ZIP enthält den Dateipfad mehrfach: ${file.name}`);
      filesByName.set(file.name, file.item);
    }

    if (requestedEntry && wrapper && requestedEntry.startsWith(wrapper)) requestedEntry = safeEntry(requestedEntry.slice(wrapper.length), runtime);

    let entry = requestedEntry;
    if (entry) {
      if (!filesByName.has(entry)) {
        const wrapperHint = wrapper ? ` Der äußere ZIP-Ordner „${wrapper.slice(0, -1)}“ wurde automatisch erkannt.` : '';
        throw new Error(`Entrypoint ${entry} wurde im ZIP nicht gefunden.${wrapperHint}`);
      }
    } else {
      const packageCandidates = packageEntrypoints(filesByName, runtime).filter((candidate) => filesByName.has(candidate));
      if (packageCandidates.length === 1) {
        entry = packageCandidates[0];
      } else if (packageCandidates.length > 1) {
        throw new Error(`Mehrere Entrypoints aus package.json erkannt: ${packageCandidates.join(', ')}. Bitte Entrypoint im Upload-Formular angeben.`);
      } else {
        const candidates = entryCandidates(runtime).filter((candidate) => filesByName.has(candidate));
        if (candidates.length === 1) entry = candidates[0];
        else {
          const wrapperHint = wrapper ? ` Der äußere ZIP-Ordner „${wrapper.slice(0, -1)}“ wurde automatisch erkannt.` : '';
          const found = candidates.length ? ` Mögliche Entrypoints: ${candidates.join(', ')}` : '';
          throw new Error(`Entrypoint konnte nicht automatisch erkannt werden.${wrapperHint}${found} Bitte Entrypoint im Upload-Formular angeben.`);
        }
      }
    }

    let total = 0;
    const srcRoot = path.resolve(dest, 'src') + path.sep;
    for (const { item, name } of normalized) {
      if (!name || noiseEntry(name) || ignoredDependencyEntry(name)) continue;
      assertWritableProjectPath(name);
      const data = getEntryData(item, name);
      total += data.length;
      if (total > MAX_UNPACKED_BYTES) throw new Error('ZIP entpackt größer als 100 MB');
      const out = path.resolve(dest, 'src', name);
      if (!out.startsWith(srcRoot)) throw new Error('ZIP-Pfad außerhalb des Bot-Ordners');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, data, { mode: 0o600 });
    }
    if (!fs.existsSync(path.join(dest, 'src', entry)) || !fs.statSync(path.join(dest, 'src', entry)).isFile()) throw new Error(`Entrypoint ${entry} wurde nach dem Entpacken nicht gefunden`);

    writeGeneratedRuntimeFiles(id, runtime, entry);
    return { id, runtime, entrypoint: entry, fileCount: files.length, unpackedBytes: total, strippedWrapper: wrapper ? wrapper.slice(0, -1) : '' };
  } catch (error) {
    fs.rmSync(dest, { recursive: true, force: true });
    throw error;
  }
}

export function listCustomBotFiles(id) {
  const root = botSourceRoot(id);
  if (!fs.existsSync(root)) return [];
  const rows = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { stack.push(full); continue; }
      if (!entry.isFile()) continue;
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (sensitiveUploadEntry(rel) || ignoredDependencyEntry(rel) || noiseEntry(rel)) continue;
      const stat = fs.statSync(full);
      rows.push({ path: rel, size: stat.size, modifiedAt: stat.mtime.toISOString() });
      if (rows.length > MAX_FILES) throw new Error(`Projekt enthält zu viele Quelldateien (maximal ${MAX_FILES})`);
    }
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path, 'en', { numeric: true, sensitivity: 'base' }));
}

export function resolveCustomBotFile(id, relativePath) {
  const resolved = resolveSourcePath(id, relativePath);
  if (!fs.existsSync(resolved.absolute)) throw new Error('Datei wurde nicht gefunden');
  const stat = fs.lstatSync(resolved.absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Datei wurde nicht gefunden');
  return { ...resolved, size: stat.size, modifiedAt: stat.mtime.toISOString() };
}

export function overlayCustomBotFiles({ id, runtime, entrypoint, archiveBuffer = null, files = [], targetDir = '' }) {
  if (!validBotId(id)) throw new Error('Ungültige Bot-ID');
  if (!['node22', 'python313'].includes(runtime)) throw new Error('Unbekannte Runtime');
  const dest = botDir(id);
  const root = botSourceRoot(id);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error('Custom-Bot-Projektdateien wurden nicht gefunden');
  const entry = safeEntry(entrypoint, runtime);
  const targetPrefix = safeRelativePath(targetDir, 'Ungültiger Zielordner', true);
  const pending = new Map();
  let strippedWrapper = '';

  if (archiveBuffer) {
    if (!Buffer.isBuffer(archiveBuffer) || !archiveBuffer.length) throw new Error('ZIP-Datei ist leer');
    if (archiveBuffer.length > MAX_ARCHIVE_BYTES) throw new Error('ZIP-Datei ist größer als 25 MB');
    let zip;
    try { zip = new AdmZip(archiveBuffer); } catch { throw new Error('ZIP-Datei ist ungültig oder beschädigt'); }
    const rawEntries = zip.getEntries();
    if (!Array.isArray(rawEntries) || !rawEntries.length) throw new Error('ZIP-Datei ist leer');
    if (rawEntries.length > MAX_RAW_ENTRIES) throw new Error(`ZIP enthält zu viele Einträge (maximal ${MAX_RAW_ENTRIES})`);
    const cleaned = rawEntries.map((item) => ({ item, name: cleanZipName(item.entryName, item.isDirectory) }))
      .filter(({ item, name }) => !item.isDirectory && name && !noiseEntry(name) && !ignoredDependencyEntry(name));
    if (!cleaned.length) throw new Error('ZIP enthält keine verwendbaren Quelldateien');
    const sensitive = cleaned.find(({ name }) => sensitiveUploadEntry(name));
    if (sensitive) throw new Error(`ZIP enthält die sensible Datei ${sensitive.name}. Secrets bitte ausschließlich über die ENV-Felder hinterlegen.`);
    const wrapper = detectWrapper(cleaned.map(({ name }) => name));
    strippedWrapper = wrapper ? wrapper.slice(0, -1) : '';
    let total = 0;
    for (const { item, name } of cleaned) {
      const normalized = wrapper && name.startsWith(wrapper) ? name.slice(wrapper.length) : name;
      if (!normalized) continue;
      const rel = [targetPrefix, normalized].filter(Boolean).join('/');
      const safe = safeRelativePath(rel, 'ZIP enthält einen unsicheren Pfad');
      assertWritableProjectPath(safe);
      if (pending.has(safe)) throw new Error(`ZIP enthält den Dateipfad mehrfach: ${safe}`);
      const declared = declaredSize(item);
      if (declared > MAX_UNPACKED_BYTES || total + declared > MAX_UNPACKED_BYTES) throw new Error('ZIP entpackt größer als 100 MB');
      const data = getEntryData(item, name);
      total += data.length;
      if (total > MAX_UNPACKED_BYTES) throw new Error('ZIP entpackt größer als 100 MB');
      pending.set(safe, data);
    }
  }

  if (Array.isArray(files) && files.length) {
    if (files.length > MAX_LOOSE_FILES) throw new Error(`Maximal ${MAX_LOOSE_FILES} lose Dateien pro Upload`);
    let looseTotal = 0;
    for (const file of files) {
      if (!Buffer.isBuffer(file?.buffer) || !file.buffer.length) throw new Error('Eine hochgeladene Datei ist leer');
      const original = String(file.originalname || '').replace(/\\/g, '/');
      const base = path.posix.basename(original);
      const safeBase = safeRelativePath(base, 'Ungültiger Dateiname');
      const rel = [targetPrefix, safeBase].filter(Boolean).join('/');
      const safe = safeRelativePath(rel, 'Ungültiger Zieldateipfad');
      assertWritableProjectPath(safe);
      looseTotal += file.buffer.length;
      if (looseTotal > MAX_ARCHIVE_BYTES) throw new Error('Lose Dateien sind zusammen größer als 25 MB');
      pending.set(safe, file.buffer);
    }
  }

  if (!pending.size) throw new Error('Keine Dateien zum Hochladen ausgewählt');

  // Validate the final projected size/count before touching the project. This makes
  // the overlay operation atomic with regard to quota/validation failures.
  const existing = new Map(listCustomBotFiles(id).map((row) => [row.path, row.size]));
  for (const [rel, data] of pending) existing.set(rel, data.length);
  if (existing.size > MAX_FILES) throw new Error(`Projekt enthält danach zu viele Quelldateien (maximal ${MAX_FILES})`);
  const projectedBytes = [...existing.values()].reduce((sum, size) => sum + Number(size || 0), 0);
  if (projectedBytes > MAX_UNPACKED_BYTES) throw new Error('Projekt wäre danach größer als 100 MB');

  for (const [rel, data] of pending) {
    const resolved = resolveSourcePath(id, rel);
    fs.mkdirSync(path.dirname(resolved.absolute), { recursive: true });
    fs.writeFileSync(resolved.absolute, data, { mode: 0o600 });
  }

  const entryFile = resolveSourcePath(id, entry).absolute;
  if (!fs.existsSync(entryFile) || !fs.statSync(entryFile).isFile()) throw new Error(`Entrypoint ${entry} wurde im Projekt nicht gefunden`);
  const stats = projectStats(id);
  writeGeneratedRuntimeFiles(id, runtime, entry);
  rebuildSourceZip(id);
  return { ...stats, overwrittenOrAdded: pending.size, paths: [...pending.keys()].sort(), strippedWrapper };
}

export function deleteCustomBotFiles(id) {
  if (!validBotId(id)) return;
  fs.rmSync(path.join(ROOT, id), { recursive: true, force: true });
}
