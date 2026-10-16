import test from 'node:test';import assert from 'node:assert/strict';
import { seasonTwoFeedConfig,seasonTwoFeedEndpoint } from '../src/wardogs-feed-mode.js';
test('season two feed uses exact URL and host-only settings instead of deprecated WDServerFeed',()=>{
  assert.equal(seasonTwoFeedEndpoint('https://panel.example/app'), 'https://panel.example/api/ingest/events');
  const text=seasonTwoFeedConfig('https://panel.example/', 'test-token', 'EU 1');
  assert.match(text,/\[\/Script\/WDRCON.WDRCONSettings\]/);
  assert.match(text,/bEventFeedEnabled=True/);
  assert.match(text,/\+EventFeedEndpoints=\(Url="https:\/\/panel.example\/api\/ingest\/events",Token="test-token"\)/);
  assert.match(text,/EventFeedServerName="EU 1"/);
  assert.doesNotMatch(text,/\[WDServerFeed\]/);
});
test('feed setup text is safely normalized',()=>{
  assert.match(seasonTwoFeedConfig('https://x.example','abc','a\n"b'),/EventFeedServerName="a  b"/);
  assert.throws(()=>seasonTwoFeedConfig('https://x.example','x\nInjected','name'));
});
