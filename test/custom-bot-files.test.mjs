import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

// The production ZIP library is an external dependency. Test file selection,
// path protection, fresh-export logic and deletion without needing Docker or
// network access in the test container.
const original = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wardogs-custom-files-'));
const raw = fs.readFileSync(path.join(original,'src/custom-bots.js'),'utf8')
  .replace("import AdmZip from 'adm-zip';", `class AdmZip {
    constructor() { this.entries = new Map(); }
    addFile(name, value) { this.entries.set(name, Buffer.from(value).toString('base64')); }
    toBuffer() { return Buffer.from(JSON.stringify(Object.fromEntries(this.entries))); }
    writeZip(filename) { fs.writeFileSync(filename, this.toBuffer()); }
  }`);
process.chdir(temp);
const lib = await import('data:text/javascript;base64,'+Buffer.from(raw).toString('base64'));
const id = crypto.randomUUID();
const base = path.join(temp, 'custom-bots', id);
const src = path.join(base, 'src');
fs.mkdirSync(path.join(src,'lib'),{recursive:true});
fs.writeFileSync(path.join(src,'index.js'),'console.log("bot")');
fs.writeFileSync(path.join(src,'lib','old.js'),'remove me');
fs.writeFileSync(path.join(base,'source.zip'),'stale');
fs.mkdirSync(path.join(base,'runtime-export-data'),{recursive:true});
fs.mkdirSync(path.join(base,'runtime-data'),{recursive:true});
fs.mkdirSync(path.join(base,'runtime-root'),{recursive:true});
fs.writeFileSync(path.join(base,'runtime-export-data','stats.sqlite'), 'current sqlite data');
fs.writeFileSync(path.join(base,'runtime-data','stats.sqlite'), 'current sqlite data');
fs.writeFileSync(path.join(base,'runtime-root','root.db'), 'root data');

test.after(()=>{process.chdir(original);fs.rmSync(temp,{recursive:true,force:true});});

test('fresh full backup lists source + runtime/data + root DB, not old source.zip',()=>{
  const archive = JSON.parse(lib.createCustomBotBackup(id,'Bot').toString());
  assert.equal(Buffer.from(archive['project/index.js'],'base64').toString(), 'console.log("bot")');
  assert.equal(Buffer.from(archive['data/stats.sqlite'],'base64').toString(), 'current sqlite data');
  assert.equal(Buffer.from(archive['runtime-root/root.db'],'base64').toString(), 'root data');
  assert.ok(!archive['project/source.zip']);
  assert.match(Buffer.from(archive['BACKUP-INFO.json'],'base64').toString(), /runtime-root/);
});

test('can delete one source file without deleting the bot',()=>{
  assert.throws(()=>lib.deleteCustomBotSourceFile(id,'index.js','index.js','node22'),/Entrypoint/);
  assert.throws(()=>lib.deleteCustomBotSourceFile(id,'../other','index.js','node22'),/Ungültig/);
  const result = lib.deleteCustomBotSourceFile(id,'lib/old.js','index.js','node22');
  assert.equal(result.fileCount,1);
  assert.equal(fs.existsSync(path.join(src,'lib','old.js')), false);
  assert.equal(fs.existsSync(path.join(src,'index.js')), true);
  assert.equal(fs.existsSync(base), true);
});

test('persistent runtime file is deletable independently',()=>{
  assert.deepEqual(lib.listCustomBotRuntimeFiles(id).map(x=>x.path),['stats.sqlite']);
  assert.throws(()=>lib.resolveCustomBotRuntimeFile(id,'runtime-data','../index.js'),/Ungültig/);
  lib.deleteCustomBotRuntimeFile(id,'stats.sqlite');
  assert.equal(fs.existsSync(path.join(base,'runtime-data','stats.sqlite')),false);
  assert.equal(fs.existsSync(path.join(base,'runtime-root','root.db')),true);
});

test('runtime file browser never follows symlink escapes',()=>{
  fs.symlinkSync('/etc/passwd',path.join(base,'runtime-data','passwd.txt'));
  assert.throws(()=>lib.listCustomBotRuntimeFiles(id),/symbolischen Link/);
  assert.throws(()=>lib.resolveCustomBotRuntimeFile(id,'runtime-data','passwd.txt'),/Symbolische Links/);
});

test('runner preserves databases before replacing container and mounts /bot/data',()=>{
  const r=fs.readFileSync(path.join(original,'src/runner.js'),'utf8');
  assert.ok(r.indexOf('await captureRuntime(id);') < r.indexOf("['rm', '-f', container]"));
  assert.match(r,/--mount.*type=bind,src=.*dst=\/bot\/data/s);
  assert.match(r,/captureWritableRoot\(container, id\)/);
});
