import test from 'node:test';
import assert from 'node:assert/strict';
import { discordPanelMessageMissing } from '../src/managed-panel-recovery.js';
import { readFileSync } from 'node:fs';

const manager = readFileSync(new URL('../src/managed-bots.js', import.meta.url), 'utf8');

test('repost only after confirmed deleted Discord message', () => {
  assert.equal(discordPanelMessageMissing({ code: 10008, status: 404 }), true);
  assert.equal(discordPanelMessageMissing({ rawError: { code: 10008 } }), true);
  assert.equal(discordPanelMessageMissing({ status: 404 }), true);
  assert.equal(discordPanelMessageMissing({ code: 50013, status: 403 }), false);
  assert.equal(discordPanelMessageMissing({ code: 50001, status: 403 }), false);
  assert.equal(discordPanelMessageMissing({ status: 503 }), false);
});

test('Discord panel publishing does not wait for RCON player polling', () => {
  const start = manager.indexOf('async function controlPanelPayload(bot)');
  const end = manager.indexOf('async function deleteStoredControlPanel', start);
  const content = manager.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.doesNotMatch(content, /wardogsRequest\(/);
  const startup = manager.indexOf('async function startOne(bot)');
  const scheduled = manager.indexOf('await refreshControlPanels(freshBeforeRun, client, rootState)', startup);
  const poll = manager.indexOf('await pollPlayers(server, serverState, client)', startup);
  assert.ok(scheduled > startup && poll > scheduled, 'Discord panel initializes before player polling');
  assert.match(manager, /rootState\.panelTimer\s*=\s*setInterval\(/);
  assert.match(manager, /preservePanel: true/);
});
