import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// managed-chat resolves data/ relative to cwd, so isolate it in a temporary directory.
test('chat history paginates 50 messages per page and remains server-scoped', async () => {
  const cwd=process.cwd();
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'managed-chat-'));
  process.chdir(tmp);
  process.env.APP_ENCRYPTION_KEY ||= Buffer.alloc(32,7).toString('base64');
  try {
    const mod=await import(new URL(`../src/managed-chat.js?${Date.now()}`, import.meta.url));
    for(let i=0;i<120;i++) mod.appendManagedChat('botA','eu1',{id:`e${i}`,direction:'in',kind:'chat',playerName:'P',message:`msg-${i}`});
    mod.appendManagedChat('botA','eu2',{id:'other',direction:'in',kind:'chat',message:'EU2 only'});
    const first=mod.readManagedChatPage('botA','eu1',0,50);
    const third=mod.readManagedChatPage('botA','eu1',2,50);
    const other=mod.readManagedChatPage('botA','eu2',0,50);
    assert.equal(first.total,120); assert.equal(first.rows.length,50); assert.equal(first.pages,3);
    assert.equal(third.rows.length,20);
    assert.equal(other.total,1); assert.equal(other.rows[0].message,'EU2 only');
  } finally { process.chdir(cwd); fs.rmSync(tmp,{recursive:true,force:true}); }
});
