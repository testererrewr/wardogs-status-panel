import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import AdmZip from 'adm-zip';

const ROOT = path.resolve('custom-bots');

function safeEntry(value, runtime) {
  const p = String(value || '').trim().replace(/\\/g, '/');
  if (!p || p.startsWith('/') || p.includes('\0') || p.split('/').some((x) => x === '..') || !/^[A-Za-z0-9._/-]+$/.test(p)) throw new Error('Ungültiger Entrypoint');
  if (runtime === 'node22' && !p.endsWith('.js') && !p.endsWith('.mjs') && !p.endsWith('.cjs')) throw new Error('Node Entrypoint muss .js/.mjs/.cjs sein');
  if (runtime === 'python313' && !p.endsWith('.py')) throw new Error('Python Entrypoint muss .py sein');
  return p;
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
  const entry = safeEntry(entrypoint, runtime);
  const dest = path.join(ROOT, id);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.join(dest, 'src'), { recursive: true });
  try {
    fs.writeFileSync(path.join(dest, 'source.zip'), buffer, { mode: 0o640 });
    let zip;
    try { zip = new AdmZip(buffer); } catch { throw new Error('ZIP-Datei ist ungültig'); }
    const entries = zip.getEntries();
    if (!entries.length || entries.length > 300) throw new Error('ZIP muss 1 bis 300 Dateien enthalten');
    let total = 0;
    for (const item of entries) {
      const name = item.entryName.replace(/\\/g, '/');
      if (!name || name.startsWith('/') || name.includes('\0') || name.split('/').some((x) => x === '..')) throw new Error('ZIP enthält einen unsicheren Pfad');
      if (item.isDirectory) continue;
      const declared = Number(item.header?.size || 0);
      if (declared < 0 || declared > 25 * 1024 * 1024 || total + declared > 25 * 1024 * 1024) throw new Error('ZIP entpackt größer als 25 MB');
      const data = item.getData();
      total += data.length;
      if (total > 25 * 1024 * 1024) throw new Error('ZIP entpackt größer als 25 MB');
      const out = path.resolve(dest, 'src', name);
      const srcRoot = path.resolve(dest, 'src') + path.sep;
      if (!out.startsWith(srcRoot)) throw new Error('ZIP-Pfad außerhalb des Bot-Ordners');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, data, { mode: 0o640 });
    }
    if (!fs.existsSync(path.join(dest, 'src', entry))) throw new Error(`Entrypoint ${entry} wurde im ZIP nicht gefunden`);
    const dockerfile = runtime === 'node22'
      ? `FROM node:22-alpine\nWORKDIR /bot\nCOPY src/ .\nRUN if [ -f package.json ]; then npm install --omit=dev --ignore-scripts --no-audit --no-fund; fi\nRUN chown -R node:node /bot\nUSER node\nCMD [\"node\", \"${entry}\"]\n`
      : `FROM python:3.13-alpine\nWORKDIR /bot\nCOPY src/ .\nRUN if [ -f requirements.txt ]; then pip install --no-cache-dir -r requirements.txt; fi\nRUN addgroup -S bot && adduser -S bot -G bot && chown -R bot:bot /bot\nUSER bot\nCMD [\"python\", \"${entry}\"]\n`;
    fs.writeFileSync(path.join(dest, 'Dockerfile.generated'), dockerfile, { mode: 0o640 });
    fs.writeFileSync(path.join(dest, '.dockerignore'), '.git\n.env\nnode_modules\n__pycache__\nsource.zip\n', { mode: 0o640 });
    return { id, runtime, entrypoint: entry, fileCount: entries.filter((x) => !x.isDirectory).length, unpackedBytes: total };
  } catch (error) {
    fs.rmSync(dest, { recursive: true, force: true });
    throw error;
  }
}

export function deleteCustomBotFiles(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) return;
  fs.rmSync(path.join(ROOT, id), { recursive: true, force: true });
}
