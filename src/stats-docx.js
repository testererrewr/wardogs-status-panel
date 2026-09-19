
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buffer) {
  let c = 0xFFFFFFFF;
  for (const byte of buffer) c = CRC32_TABLE[(c ^ byte) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((Math.floor(date.getSeconds() / 2)) & 31),
    date: (((year - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31)
  };
}
function createStoredZip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  const dt = dosDateTime();
  for (const [name, input] of files) {
    const nameBuf = Buffer.from(String(name), 'utf8');
    const data = Buffer.isBuffer(input) ? input : Buffer.from(input);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dt.time, 10); local.writeUInt16LE(dt.date, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dt.time, 12); central.writeUInt16LE(dt.date, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralOffset = offset;
  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(centralBuffer.length, 12); end.writeUInt32LE(centralOffset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuffer, end]);
}

function xml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function safeNumber(value) { const n = Number(value); return Number.isFinite(n) ? n : 0; }
function formatDuration(seconds, lang = 'de') {
  const total = Math.max(0, Math.floor(safeNumber(seconds)));
  const days = Math.floor(total / 86400), hours = Math.floor((total % 86400) / 3600), minutes = Math.floor((total % 3600) / 60);
  const parts = [];
  if (days) parts.push(`${days} ${lang === 'de' ? 'T' : 'd'}`);
  if (hours || days) parts.push(`${hours} h`);
  parts.push(`${minutes} min`);
  return parts.join(' ');
}
function formatDate(value, locale = 'de-DE', timeZone = 'Europe/Vienna') {
  if (!value) return '—';
  const date = new Date(value); if (!Number.isFinite(date.getTime())) return '—';
  try { return new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short', timeZone }).format(date); }
  catch { return date.toISOString(); }
}
function paragraph(text, opts = {}) {
  const size = Math.max(12, Number(opts.size || 18));
  const bold = opts.bold ? '<w:b/>' : '';
  const color = opts.color ? `<w:color w:val="${xml(opts.color)}"/>` : '';
  const align = opts.align ? `<w:jc w:val="${xml(opts.align)}"/>` : '';
  const before = Number.isFinite(opts.before) ? `<w:spacing w:before="${Math.max(0, opts.before)}"/>` : '';
  const after = Number.isFinite(opts.after) ? `<w:spacing w:after="${Math.max(0, opts.after)}"/>` : '';
  return `<w:p><w:pPr>${align}${before}${after}</w:pPr><w:r><w:rPr>${bold}${color}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr><w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`;
}
function cell(text, opts = {}) {
  const width = Math.max(300, Number(opts.width || 1200));
  const shade = opts.shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${xml(opts.shade)}"/>` : '';
  const bold = opts.bold ? '<w:b/>' : '';
  const size = Math.max(12, Number(opts.size || 15));
  return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${shade}<w:vAlign w:val="center"/></w:tcPr><w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr><w:r><w:rPr>${bold}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr><w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p></w:tc>`;
}
function table(headers, rows, widths) {
  const grid = widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('');
  const border = '<w:tblBorders><w:top w:val="single" w:sz="4" w:color="B9C2D0"/><w:left w:val="single" w:sz="4" w:color="B9C2D0"/><w:bottom w:val="single" w:sz="4" w:color="B9C2D0"/><w:right w:val="single" w:sz="4" w:color="B9C2D0"/><w:insideH w:val="single" w:sz="3" w:color="D7DEE8"/><w:insideV w:val="single" w:sz="3" w:color="D7DEE8"/></w:tblBorders>';
  const head = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${headers.map((h, i) => cell(h, { width: widths[i], shade: 'E8EDF5', bold: true, size: 14 })).join('')}</w:tr>`;
  const body = rows.map((row) => `<w:tr>${row.map((v, i) => cell(v, { width: widths[i], size: 13 })).join('')}</w:tr>`).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblLayout w:type="fixed"/>${border}<w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="80" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${head}${body}</w:tbl>`;
}
function minDate(...values) { return values.filter(Boolean).sort()[0] || null; }
function maxDate(...values) { return values.filter(Boolean).sort().at(-1) || null; }

export function buildStatusStatsExportData(bot, playtimeSnapshot, killSnapshot) {
  const playMap = new Map((playtimeSnapshot?.rows || []).map((p) => [String(p.steamId), p]));
  const killMap = new Map((killSnapshot?.players || []).map((p) => [String(p.steamId), p]));
  const ids = new Set([...playMap.keys(), ...killMap.keys()]);
  const players = [...ids].map((steamId) => {
    const p = playMap.get(steamId) || {}, k = killMap.get(steamId) || {};
    const name = String(k.name || p.name || steamId);
    const kills = Math.max(0, safeNumber(k.kills));
    const deaths = Math.max(0, safeNumber(k.deaths));
    return {
      steamId, name,
      aliases: Array.isArray(k.aliases) ? k.aliases : [],
      totalSeconds: Math.max(0, safeNumber(p.totalSeconds)), sessionCount: Math.max(0, safeNumber(p.sessionCount)),
      servers: Array.isArray(p.servers) ? p.servers.map((x) => String(x.label || x.id || '')).filter(Boolean) : [],
      kills, deaths, kd: deaths > 0 ? kills / deaths : kills,
      headshots: Math.max(0, safeNumber(k.headshots)), penetrations: Math.max(0, safeNumber(k.penetrations)), ricochets: Math.max(0, safeNumber(k.ricochets)),
      meleeKills: Math.max(0, safeNumber(k.meleeKills)), vehicleKills: Math.max(0, safeNumber(k.vehicleKills)), roadKills: Math.max(0, safeNumber(k.roadKills)),
      suicides: Math.max(0, safeNumber(k.suicides)), environmentalDeaths: Math.max(0, safeNumber(k.environmentalDeaths)), longestKillMeters: Math.max(0, safeNumber(k.longestKillMeters)),
      topCauses: Array.isArray(k.topCauses) ? k.topCauses.slice(0, 3) : [],
      firstSeenAt: minDate(p.firstSeenAt, k.firstSeenAt), lastSeenAt: maxDate(p.lastSeenAt, k.lastSeenAt)
    };
  }).sort((a, b) => b.kills - a.kills || b.totalSeconds - a.totalSeconds || a.name.localeCompare(b.name));
  return {
    botName: String(bot?.name || 'WARDOGS Status Bot'), timezone: String(bot?.statsTimezone || 'Europe/Vienna'),
    players,
    servers: Array.isArray(playtimeSnapshot?.servers) ? playtimeSnapshot.servers : [],
    totalSeconds: Math.max(0, safeNumber(playtimeSnapshot?.totalSeconds)),
    totalKills: players.reduce((s, p) => s + p.kills, 0), totalDeaths: players.reduce((s, p) => s + p.deaths, 0),
    totalHeadshots: players.reduce((s, p) => s + p.headshots, 0),
    killEvents: Math.max(0, safeNumber(killSnapshot?.totalEvents)),
    playtimeStartedAt: playtimeSnapshot?.startedAt || null, killStartedAt: killSnapshot?.startedAt || null,
    lastPlaytimeAt: playtimeSnapshot?.lastPollAt || null, lastKillAt: killSnapshot?.lastEventAt || null
  };
}

export function createStatusStatsDocx({ bot, playtimeSnapshot, killSnapshot, lang = 'de', exportedAt = new Date() }) {
  const d = buildStatusStatsExportData(bot, playtimeSnapshot, killSnapshot);
  const de = lang !== 'en', locale = de ? 'de-DE' : 'en-US';
  const T = (deText, enText) => de ? deText : enText;
  const summaryRows = [
    [T('Exportiert am', 'Exported at'), formatDate(exportedAt, locale, d.timezone)],
    [T('Getrackte Server', 'Tracked servers'), String(d.servers.length)],
    [T('Bekannte Spieler', 'Known players'), String(d.players.length)],
    [T('Gesamtspielzeit', 'Total playtime'), formatDuration(d.totalSeconds, lang)],
    [T('Kills / Tode', 'Kills / deaths'), `${Math.round(d.totalKills)} / ${Math.round(d.totalDeaths)}`],
    ['Headshots', String(Math.round(d.totalHeadshots))],
    [T('Gespeicherte Kill-Events', 'Stored kill events'), String(Math.round(d.killEvents))],
    [T('Letzter Playtime-Datensatz', 'Last playtime data'), formatDate(d.lastPlaytimeAt, locale, d.timezone)],
    [T('Letztes Kill-Event', 'Last kill event'), formatDate(d.lastKillAt, locale, d.timezone)]
  ];
  const serverRows = d.servers.map((s) => [
    String(s.label || s.id || 'Server'), String(Math.max(0, safeNumber(s.uniquePlayers))), formatDuration(s.totalSeconds, lang), formatDate(s.lastPollAt, locale, d.timezone)
  ]);
  const mainRows = d.players.map((p) => [
    p.name, p.steamId, formatDuration(p.totalSeconds, lang), String(Math.round(p.sessionCount)), String(Math.round(p.kills)), String(Math.round(p.deaths)), p.kd.toFixed(2), String(Math.round(p.headshots)), `${p.longestKillMeters.toFixed(1)} m`, formatDate(p.lastSeenAt, locale, d.timezone)
  ]);
  const advancedRows = d.players.filter((p) => p.kills || p.deaths).map((p) => [
    p.name, p.steamId, String(Math.round(p.penetrations)), String(Math.round(p.ricochets)), String(Math.round(p.meleeKills)), String(Math.round(p.vehicleKills)), String(Math.round(p.roadKills)), String(Math.round(p.suicides)), String(Math.round(p.environmentalDeaths)), p.topCauses.map(([cause, count]) => `${cause}: ${count}`).join(' | ') || '—'
  ]);
  const topRows = d.players.slice(0, 25).map((p, i) => [String(i + 1), p.name, p.steamId, String(Math.round(p.kills)), String(Math.round(p.deaths)), p.kd.toFixed(2), String(Math.round(p.headshots)), `${p.longestKillMeters.toFixed(1)} m`]);

  const body = [
    paragraph(d.botName, { size: 34, bold: true, color: '1E2A44', after: 40 }),
    paragraph(T('Statistik-Export', 'Statistics export'), { size: 24, bold: true, color: '4B5D7A', after: 180 }),
    paragraph(T('Dieser Bericht wird aus den im Panel gespeicherten Daten erzeugt und funktioniert auch, wenn der Status Bot gerade offline oder deaktiviert ist.', 'This report is generated from data stored in the panel and works even while the Status Bot is offline or disabled.'), { size: 17, color: '4B5563', after: 180 }),
    paragraph(T('Übersicht', 'Summary'), { size: 24, bold: true, before: 120, after: 80 }),
    table([T('Wert', 'Metric'), T('Stand', 'Value')], summaryRows, [4200, 10000]),
    paragraph(T('Serverübersicht', 'Server overview'), { size: 24, bold: true, before: 220, after: 80 }),
    serverRows.length ? table([T('Server', 'Server'), T('Spieler', 'Players'), T('Spielzeit', 'Playtime'), T('Letzter Poll', 'Last poll')], serverRows, [4300, 1800, 3000, 5100]) : paragraph(T('Keine Serverdaten gespeichert.', 'No server data stored.'), { size: 16 }),
    paragraph(T('Top 25 nach Kills', 'Top 25 by kills'), { size: 24, bold: true, before: 220, after: 80 }),
    topRows.length ? table(['#', T('Spieler', 'Player'), 'SteamID64', 'Kills', T('Tode', 'Deaths'), 'K/D', 'Headshots', T('Längster Kill', 'Longest kill')], topRows, [500, 2600, 2500, 900, 900, 900, 1100, 1800]) : paragraph(T('Noch keine Kill-Stats gespeichert.', 'No kill stats stored yet.'), { size: 16 }),
    paragraph(T('Alle Spieler · Kernstatistiken', 'All players · core statistics'), { size: 24, bold: true, before: 220, after: 80 }),
    mainRows.length ? table([T('Spieler', 'Player'), 'SteamID64', T('Spielzeit', 'Playtime'), 'Sessions', 'Kills', T('Tode', 'Deaths'), 'K/D', 'HS', T('Längster Kill', 'Longest kill'), T('Letzte Aktivität', 'Last activity')], mainRows, [2300, 2300, 1700, 1000, 800, 800, 800, 700, 1500, 2300]) : paragraph(T('Noch keine Spielerstatistiken gespeichert.', 'No player statistics stored yet.'), { size: 16 }),
    paragraph(T('Erweiterte Kill-Statistiken', 'Advanced kill statistics'), { size: 24, bold: true, before: 220, after: 80 }),
    advancedRows.length ? table([T('Spieler', 'Player'), 'SteamID64', 'Pen', 'Rico', 'Melee', 'Vehicle', 'Road', T('Suizide', 'Suicides'), 'Env', T('Top Ursachen', 'Top causes')], advancedRows, [2200, 2300, 700, 700, 800, 800, 700, 800, 700, 4300]) : paragraph(T('Noch keine erweiterten Kill-Statistiken gespeichert.', 'No advanced kill statistics stored yet.'), { size: 16 }),
    paragraph(`status-hub.lol · ${T('Export aus gespeicherten WARDOGS Status Bot Daten', 'Export from stored WARDOGS Status Bot data')}`, { size: 13, color: '6B7280', before: 240 })
  ].join('');

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="600" w:right="600" w:bottom="600" w:left="600" w:header="300" w:footer="300" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos" w:eastAsia="Aptos" w:cs="Aptos"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="80"/></w:pPr></w:pPrDefault></w:docDefaults></w:styles>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  return createStoredZip([
    ['[Content_Types].xml', Buffer.from(contentTypes)],
    ['_rels/.rels', Buffer.from(rootRels)],
    ['word/document.xml', Buffer.from(documentXml)],
    ['word/styles.xml', Buffer.from(stylesXml)],
    ['word/_rels/document.xml.rels', Buffer.from(docRels)]
  ]);
}
