// Season 2 (CL-516586+) exposes /v1/feed and requires file-only feed
// configuration. Older builds accept [WDServerFeed] via /v1/config.
export function seasonTwoFeedEndpoint(origin) {
  return `${new URL(origin).origin}/api/ingest/events`;
}
export function seasonTwoFeedConfig(origin, token, serverName) {
  const name=String(serverName||'WARDOGS').replace(/["\\\r\n\0]/g,' ').slice(0,80);
  if (!token || /["\\\r\n\0]/.test(String(token))) throw new Error('Invalid feed token');
  return `[/Script/WDRCON.WDRCONSettings]\nbEventFeedEnabled=True\n+EventFeedEndpoints=(Url="${seasonTwoFeedEndpoint(origin)}",Token="${token}")\nEventFeedServerName="${name}"`;
}
