import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeManagedServers, managedServerContext, managedServerByChannel } from '../src/managed-servers.js';

test('management bot keeps multiple WARDOGS servers with separate Discord channels', () => {
  const bot={id:'bot1',managedServers:[
    {id:'eu1',label:'EU1',baseUrl:'http://eu1:8080',secretEnc:'x',alertChannelId:'12345678901234567',controlPanelEnabled:true,controlPanelChannelId:'22345678901234567'},
    {id:'eu2',label:'EU2',baseUrl:'http://eu2:8080',secretEnc:'y',alertChannelId:'32345678901234567',controlPanelEnabled:true,controlPanelChannelId:'42345678901234567'}
  ]};
  const rows=normalizeManagedServers(bot);
  assert.equal(rows.length,2);
  assert.equal(managedServerContext(bot,'eu2').wardogsBaseUrl,'http://eu2:8080');
  assert.equal(managedServerByChannel(bot,'42345678901234567')._managedServerId,'eu2');
});
