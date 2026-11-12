import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const original = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wardogs-private-dotfiles-'));
const source = fs.readFileSync(path.join(original,'src/custom-bots.js'),'utf8')
  .replace("import AdmZip from 'adm-zip';", 'class AdmZip {}');
process.chdir(temp);
const files = await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const { sendPrivateCustomBotDownload } = await import('../src/custom-bot-download.js');
const id = crypto.randomUUID();
const root = path.join(temp, 'custom-bots', id);
const src = path.join(root,'src');
fs.mkdirSync(path.join(src,'.config'), { recursive:true });
fs.mkdirSync(path.join(root,'runtime-data','.state'), { recursive:true });
fs.writeFileSync(path.join(src,'.env'), 'BOT_TOKEN=private-test-value');
fs.writeFileSync(path.join(src,'.gitignore'), 'node_modules/');
fs.writeFileSync(path.join(src,'.config','settings.json'), '{}');
fs.writeFileSync(path.join(src,'normal.txt'), 'visible');
fs.writeFileSync(path.join(root,'runtime-data','.state','.db'), 'persistent');

test.after(() => { process.chdir(original); fs.rmSync(temp,{recursive:true,force:true}); });

function fakeResponse() {
  return {
    headers: {}, statusCode: 200, headersSent: false, downloadCall: null, sent: null,
    setHeader(key,value) { this.headers[key.toLowerCase()] = value; },
    download(absolute,name,opts,callback) { this.downloadCall = { absolute,name,opts,callback }; return this; },
    status(code) { this.statusCode = code; return this; },
    type(mime) { this.mime = mime; return this; },
    send(body) { this.sent = body; return this; }
  };
}

test('source dotfiles (.env, .gitignore, .config/) are selectable and downloaded as attachments', () => {
  const names = files.listCustomBotFiles(id).map(x=>x.path);
  assert.deepEqual(names.sort(), ['.config/settings.json','.env','.gitignore','normal.txt'].sort());
  for (const name of names) {
    const file = files.resolveCustomBotFile(id,name);
    const res = fakeResponse();
    sendPrivateCustomBotDownload(res,file);
    assert.equal(res.downloadCall.absolute,file.absolute);
    assert.equal(res.downloadCall.name,name.replace(/\//g,'__'));
    assert.equal(res.downloadCall.opts.dotfiles,'allow');
    assert.equal(res.downloadCall.opts.cacheControl,false);
    assert.match(res.headers['cache-control'], /no-store/);
    assert.equal(res.headers['x-content-type-options'],'nosniff');
  }
});

test('hidden runtime files and hidden subdirectories are downloadable', () => {
  assert.deepEqual(files.listCustomBotRuntimeFiles(id).map(x=>x.path),['.state/.db']);
  const file = files.resolveCustomBotRuntimeFile(id, 'runtime-data', '.state/.db');
  const res = fakeResponse();
  sendPrivateCustomBotDownload(res,file);
  assert.equal(res.downloadCall.opts.dotfiles,'allow');
  assert.equal(res.downloadCall.name,'.state__.db');
});

test('hidden file access cannot traverse directories or follow symlinks', () => {
  for (const p of ['../.env','/etc/passwd','.config/../../.env']) {
    assert.throws(()=>files.resolveCustomBotFile(id,p), /Ungültig|außerhalb/);
    assert.throws(()=>files.resolveCustomBotRuntimeFile(id,'runtime-data',p), /Ungültig/);
  }
  fs.symlinkSync('/etc/passwd',path.join(src,'.secret-link'));
  assert.throws(()=>files.resolveCustomBotFile(id,'.secret-link'),/Datei wurde nicht gefunden/);
  fs.symlinkSync('/etc',path.join(root,'runtime-data','.etc-link'));
  assert.throws(()=>files.resolveCustomBotRuntimeFile(id,'runtime-data','.etc-link/passwd'),/Symbolische Links/);
});

test('download failure returns readable status, without leaking path/credentials', () => {
  const res = fakeResponse();
  sendPrivateCustomBotDownload(res,{absolute:'/private/bot/.env',rel:'.env'});
  const originalLog = console.error;
  console.error = () => {};
  try {
    res.downloadCall.callback({ code: 'ENOENT', message: 'Failed at /private/bot/.env' });
  } finally { console.error = originalLog; }
  assert.equal(res.statusCode,404);
  assert.doesNotMatch(res.sent,/\/private\/bot|BOT_TOKEN/);
});

test('only owner-authorized routes enable dotfile downloads; public static files still deny dotfiles', () => {
  const web = fs.readFileSync(path.join(original,'src/index.js'),'utf8');
  for (const route of ['files/download','files/runtime-download']) {
    const start = web.indexOf(`app.get('/custom-bots/:id/${route}'`);
    assert.ok(start > -1, route);
    const chunk = web.slice(start,start+530);
    assert.match(chunk,/requireLogin/);
    assert.match(chunk,/ownedCustom\(req,req\.params\.id\)/);
    assert.match(chunk,/sendPrivateCustomBotDownload\(res,file\)/);
  }
  assert.match(web,/express\.static\('public',\s*\{[^}]*dotfiles:\s*'deny'/);
});
