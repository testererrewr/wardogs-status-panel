import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import AdmZip from 'adm-zip';

const ROOT = path.resolve('custom-bots');
const MAX_FILES = 5000;
const MAX_RAW_ENTRIES = 20000;
const MAX_UNPACKED_BYTES = 100 * 1024 * 1024;

function safeEntry(value, runtime) {
  const p = String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!p || p.startsWith('/') || p.includes('\0') || p.split('/').some((x) => x === '..') || !/^[A-Za-z0-9._/-]+$/.test(p)) throw new Error('Ungültiger Entrypoint');
  if (runtime === 'node22' && !/\.(?:js|mjs|cjs)$/i.test(p)) throw new Error('Node Entrypoint muss .js/.mjs/.cjs sein');
  if (runtime === 'python313' && !p.endsWith('.py')) throw new Error('Python Entrypoint muss .py sein');
  return p;
}

function cleanZipName(value) {
  const name = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!name || name.startsWith('/') || name.includes('\0') || name.split('/').some((x) => x === '..')) throw new Error('ZIP enthält einen unsicheren Pfad');
  return name;
}

function noiseEntry(name) {
  return name === '.DS_Store' || name.endsWith('/.DS_Store') || name === '__MACOSX' || name.startsWith('__MACOSX/');
}

function ignoredDependencyEntry(name) {
  const parts = String(name || '').split('/').filter(Boolean);
  return parts.some((part) => ['node_modules', '.git', '.venv', 'venv', '__pycache__'].includes(part));
}


function detectWrapper(fileNames) {
  if (!fileNames.length || fileNames.some((name) => !name.includes('/'))) return '';
  const first = fileNames[0].split('/')[0];
  if (!first || !fileNames.every((name) => name.startsWith(`${first}/`))) return '';
  return `${first}/`;
}

function entryCandidates(runtime) {
  return runtime === 'python313'
    ? ['bot.py', 'main.py', 'app.py', 'index.py', 'src/bot.py', 'src/main.py', 'src/app.py']
    : ['index.js', 'bot.js', 'main.js', 'app.js', 'index.mjs', 'bot.mjs', 'main.mjs', 'src/index.js', 'src/bot.js', 'src/main.js'];
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
  if (!['node22', 'python313'].includes(runtime)) throw new Error('Unbekannte Runtime');
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('ZIP-Datei ist leer');
  const rawEntrypoint = String(entrypoint || '').trim();
  const requestedEntry = rawEntrypoint ? safeEntry(rawEntrypoint, runtime) : '';
  const dest = path.join(ROOT, id);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.join(dest, 'src'), { recursive: true });
  try {
    fs.writeFileSync(path.join(dest, 'source.zip'), buffer, { mode: 0o640 });
    let zip;
    try { zip = new AdmZip(buffer); } catch { throw new Error('ZIP-Datei ist ungültig'); }
    const rawEntries = zip.getEntries();
    if (rawEntries.length > MAX_RAW_ENTRIES) throw new Error(`ZIP enthält zu viele Einträge (maximal ${MAX_RAW_ENTRIES})`);
    const entries = rawEntries.filter((item) => {
      const name = cleanZipName(item.entryName);
      return !noiseEntry(name) && !ignoredDependencyEntry(name);
    });
    const files = entries.filter((item) => !item.isDirectory);
    if (!files.length) throw new Error('ZIP enthält keine verwendbaren Quelldateien');
    if (files.length > MAX_FILES) throw new Error(`ZIP enthält zu viele Quelldateien (maximal ${MAX_FILES}). node_modules, .git, venv und Cache-Ordner werden automatisch ignoriert.`);

    const originalFileNames = files.map((item) => cleanZipName(item.entryName));
    const wrapper = detectWrapper(originalFileNames);
    const normalizedFileNames = originalFileNames.map((name) => wrapper && name.startsWith(wrapper) ? name.slice(wrapper.length) : name);
    let entry = requestedEntry;
    if (!entry || !normalizedFileNames.includes(entry)) {
      const candidates = entryCandidates(runtime).filter((candidate) => normalizedFileNames.includes(candidate));
      if (candidates.length === 1) entry = candidates[0];
      else {
        const wrapperHint = wrapper ? ` Der äußere ZIP-Ordner „${wrapper.slice(0, -1)}“ wurde automatisch erkannt.` : '';
        const found = candidates.length ? ` Mögliche Entrypoints: ${candidates.join(', ')}` : '';
        if (!requestedEntry) throw new Error(`Entrypoint konnte nicht automatisch erkannt werden.${wrapperHint}${found} Bitte Entrypoint im Upload-Formular angeben.`);
        throw new Error(`Entrypoint ${requestedEntry} wurde im ZIP nicht gefunden.${wrapperHint}${found}`);
      }
    }

    let total = 0;
    for (const item of entries) {
      const originalName = cleanZipName(item.entryName);
      if (item.isDirectory) continue;
      const name = wrapper && originalName.startsWith(wrapper) ? originalName.slice(wrapper.length) : originalName;
      if (!name || noiseEntry(name)) continue;
      const declared = Number(item.header?.size || 0);
      if (declared < 0 || declared > MAX_UNPACKED_BYTES || total + declared > MAX_UNPACKED_BYTES) throw new Error('ZIP entpackt größer als 100 MB');
      const data = item.getData();
      total += data.length;
      if (total > MAX_UNPACKED_BYTES) throw new Error('ZIP entpackt größer als 100 MB');
      const out = path.resolve(dest, 'src', name);
      const srcRoot = path.resolve(dest, 'src') + path.sep;
      if (!out.startsWith(srcRoot)) throw new Error('ZIP-Pfad außerhalb des Bot-Ordners');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, data, { mode: 0o640 });
    }
    if (!fs.existsSync(path.join(dest, 'src', entry))) throw new Error(`Entrypoint ${entry} wurde nach dem Entpacken nicht gefunden`);

    const dockerfile = runtime === 'node22'
      ? `FROM node:22-alpine\nWORKDIR /bot\nCOPY src/ .\nRUN if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; elif [ -f package.json ]; then npm install --omit=dev --no-audit --no-fund; fi\nRUN chown -R node:node /bot\nUSER node\nCMD ["node", "${entry}"]\n`
      : `FROM python:3.13-slim\nWORKDIR /bot\nCOPY src/ .\nRUN if [ -f requirements.txt ]; then pip install --no-cache-dir -r requirements.txt; fi\nRUN useradd -m -u 10001 bot && chown -R bot:bot /bot\nUSER bot\nCMD ["python", "${entry}"]\n`;
    fs.writeFileSync(path.join(dest, 'Dockerfile.generated'), dockerfile, { mode: 0o640 });
    fs.writeFileSync(path.join(dest, '.dockerignore'), '.git\n.env\nnode_modules\n__pycache__\nsource.zip\n', { mode: 0o640 });
    return { id, runtime, entrypoint: entry, fileCount: files.length, unpackedBytes: total, strippedWrapper: wrapper ? wrapper.slice(0, -1) : '' };
  } catch (error) {
    fs.rmSync(dest, { recursive: true, force: true });
    throw error;
  }
}

export function deleteCustomBotFiles(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) return;
  fs.rmSync(path.join(ROOT, id), { recursive: true, force: true });
}
