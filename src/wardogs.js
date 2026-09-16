export async function fetchWardogsStatus(rconUrl, password, timeoutMs = 5000) {
  const base = String(rconUrl || '').replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) throw new Error('RCON URL muss mit http:// oder https:// beginnen');

  const response = await fetch(`${base}/v1/status`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${password}`
    },
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    let detail = '';
    try { detail = JSON.stringify(await response.json()); } catch { detail = await response.text().catch(() => ''); }
    throw new Error(`WARDOGS HTTP ${response.status}${detail ? `: ${detail.slice(0, 180)}` : ''}`);
  }

  const data = await response.json();
  const current = Number(data?.players?.current);
  const max = Number(data?.players?.max);
  if (!Number.isFinite(current) || !Number.isFinite(max)) throw new Error('WARDOGS-Antwort enthält keine gültige Spielerzahl');
  return { current, max, serverName: data.serverName || null, map: data.map || null, raw: data };
}
