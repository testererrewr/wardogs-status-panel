import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import AdmZip from 'adm-zip';

const ROOT = path.resolve('custom-bots');
const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 5000;
const MAX_RAW_ENTRIES = 20000;
const MAX_UNPACKED_BYTES = 100 * 1024 * 1024;
const IGNORED_PARTS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__']);
const SENSITIVE_UPLOAD_NAMES = new Set(['.env', '.env.local', '.env.production', '.npmrc', '.pypirc', '.netrc', 'id_rsa', 'id_ed25519', 'credentials.json']);
function sensitiveUploadEntry(name) { const parts = String(name || '').split('/').filter(Boolean); const base = String(parts.at(-1) || '').toLowerCase(); return SENSITIVE_UPLOAD_NAMES.has(base) || base.startsWith('.env.') || ['id_ecdsa','id_dsa'].includes(base); }

function validBotId(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(id || ''));
}

function pathParts(value, errorMessage) {
  const raw = String(value || '').replace(/\\/g, '/');
  if (!raw || raw.includes('\0') || raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) throw new Error(errorMessage);
  const originalParts = raw.split('/');
  if (originalParts.some((part) => part === '..')) throw new Error(errorMessage);
  const parts = originalParts.filter((part) => part && part !== '.');
  if (!parts.length) throw new Error(errorMessage);
  if (parts.some((part) => /[\x00-\x1f\x7f]/.test(part))) throw new Error(errorMessage);
  return parts;
}

function safeEntry(value, runtime) {
  const parts = pathParts(String(value || '').trim().replace(/^\.\//, ''), 'Ungültiger Entrypoint');
  const p = parts.join('/');
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
  const dest = path.join(ROOT, id);
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
      if (!name || noiseEntry(name)) continue;
      const data = getEntryData(item, name);
      total += data.length;
      if (total > MAX_UNPACKED_BYTES) throw new Error('ZIP entpackt größer als 100 MB');
      const out = path.resolve(dest, 'src', name);
      if (!out.startsWith(srcRoot)) throw new Error('ZIP-Pfad außerhalb des Bot-Ordners');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, data, { mode: 0o600 });
    }
    if (!fs.existsSync(path.join(dest, 'src', entry)) || !fs.statSync(path.join(dest, 'src', entry)).isFile()) throw new Error(`Entrypoint ${entry} wurde nach dem Entpacken nicht gefunden`);

    const command = runtime === 'node22' ? ['node', entry] : ['python', entry];
    const dockerfile = runtime === 'node22'
      ? `FROM node:22-alpine\nWORKDIR /bot\nCOPY src/ .\nRUN if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; elif [ -f package.json ]; then npm install --omit=dev --no-audit --no-fund; fi\nRUN chown -R node:node /bot\nUSER node\nCMD ${JSON.stringify(command)}\n`
      : `FROM python:3.13-slim\nENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1\nWORKDIR /bot\nCOPY src/ .\nRUN if [ -f requirements.txt ]; then python -m pip install --no-cache-dir -r requirements.txt; fi\nRUN useradd -m -u 10001 bot && chown -R bot:bot /bot\nUSER bot\nCMD ${JSON.stringify(command)}\n`;
    fs.writeFileSync(path.join(dest, 'Dockerfile.generated'), dockerfile, { mode: 0o600 });
    fs.writeFileSync(path.join(dest, '.dockerignore'), '.git\n.env\nnode_modules\n__pycache__\nsource.zip\n', { mode: 0o600 });
    return { id, runtime, entrypoint: entry, fileCount: files.length, unpackedBytes: total, strippedWrapper: wrapper ? wrapper.slice(0, -1) : '' };
  } catch (error) {
    fs.rmSync(dest, { recursive: true, force: true });
    throw error;
  }
}

export function deleteCustomBotFiles(id) {
  if (!validBotId(id)) return;
  fs.rmSync(path.join(ROOT, id), { recursive: true, force: true });
}
