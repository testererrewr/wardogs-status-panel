import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('website HTML references the Status Hub favicons, not bot artwork',()=>{
 const html=fs.readFileSync('src/html.js','utf8');
 assert.match(html,/favicon\.svg\?v=3\.12\.63/);
 assert.match(html,/apple-touch-icon/);
 assert.match(html,/style\.css\?v=3\.12\.63/);
 assert.ok(fs.existsSync('public/favicon.svg'));
});
test('Bot Services only fetches subscription rows for the current user',()=>{
 const code=fs.readFileSync('src/index.js','utf8');
 assert.match(code,/selectDbRows\('paypalServiceSubscriptions', row => row\.userDiscordId === user\.discordId\)/);
 assert.doesNotMatch(code,/readDbFields\(\['siteSettings','botServices','paypalServiceSubscriptions'\]\)/);
});
test('Discord management polls WARDOGS status before roster',()=>{
 const code=fs.readFileSync('src/managed-bots.js','utf8');
 const section=code.slice(code.indexOf('async function pollPlayers('),code.indexOf('function deny(',code.indexOf('async function pollPlayers(')));
 assert.ok(section.indexOf("wardogsRequest(bot, '/v1/status'") < section.indexOf("wardogsRequest(bot, '/v1/players'"));
});
