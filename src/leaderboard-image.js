import { spawn } from 'node:child_process';

const WIDTH = 1600;
const BOARD_X = 110;
const BOARD_Y = 150;
const BOARD_W = 1380;
const BOARD_PAD = 34;
const COLUMN_GAP = 54;
const COLUMN_W = Math.floor((BOARD_W - (BOARD_PAD * 2) - COLUMN_GAP) / 2);
const CATEGORY_HEADER_H = 42;
const ENTRY_H = 31;
const ENTRY_COUNT = 15;
const CATEGORY_H = CATEGORY_HEADER_H + (ENTRY_H * ENTRY_COUNT);
const CATEGORY_GAP = 46;
const CATEGORY_START_Y = 365;
const FOOTER_H = 92;
const BG = '#0b1120';
const BOARD = '#050506';
const BOARD_BORDER = '#303035';
const GOLD = '#f1c40f';
const TEXT = '#f7f7f8';
const MUTED = '#b7bcc9';
const DIM = '#8790a6';
const RULE_BG = '#10162a';
const RULE_BORDER = '#29324f';
const BADGE_BG = '#111a36';
const BADGE_BORDER = '#384465';

function safeString(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function xml(value) {
  return safeString(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function truncate(value, max = 31) {
  const text = safeString(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1))}…`;
}

function formatDate(value, timeZone = 'Europe/Vienna') {
  const date = new Date(value || '');
  if (!Number.isFinite(date.getTime())) return 'Start der Erfassung';
  try {
    return new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'long', year: 'numeric', timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'long', year: 'numeric' }).format(date);
  }
}

function titleFor(category) {
  const map = {
    kills: 'Kills',
    deaths: 'Tode',
    kd: 'K/D (ab 100 Kills)',
    playtime: 'Spielzeit',
    killrecord: 'Kill-Rekord / Match',
    headshots: 'Headshot-Rate (ab 50 Kills)',
    wins: 'Match-Siege',
    matches: 'Matches gespielt',
    seeding: 'Seeding-Zeit (1–20)'
  };
  return map[category?.id] || safeString(category?.label).replace(/^[^A-Za-z0-9ÄÖÜäöü]+\s*/, '') || 'Kategorie';
}

function accentFor(category) {
  const map = {
    kills: 'K', deaths: 'T', kd: 'K/D', playtime: 'H', killrecord: 'R', headshots: 'HS', wins: 'W', matches: 'M', seeding: 'S'
  };
  return map[category?.id] || '•';
}

function text(x, y, value, { size = 20, weight = 700, fill = TEXT, anchor = 'start', family = 'DejaVu Sans', opacity = 1, letterSpacing = 0 } = {}) {
  return `<text x="${x}" y="${y}" fill="${fill}" fill-opacity="${opacity}" font-family="${family}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}"${letterSpacing ? ` letter-spacing="${letterSpacing}"` : ''}>${xml(value)}</text>`;
}

function roundedRect(x, y, width, height, fill, stroke = 'none', radius = 8, strokeWidth = 1) {
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`;
}

function medal(x, y, rank) {
  const colors = ['#f5c518', '#c3cad5', '#d8833e'];
  const color = colors[rank - 1] || colors[0];
  const ribbon = rank === 1 ? '#e0aa12' : rank === 2 ? '#98a2b2' : '#a85f2f';
  return [
    `<path d="M${x + 10} ${y + 2} L${x + 18} ${y + 15} L${x + 23} ${y + 8} L${x + 15} ${y - 4} Z" fill="${ribbon}"/>`,
    `<path d="M${x + 30} ${y + 2} L${x + 22} ${y + 15} L${x + 17} ${y + 8} L${x + 25} ${y - 4} Z" fill="${ribbon}"/>`,
    `<circle cx="${x + 20}" cy="${y + 18}" r="12" fill="${color}" stroke="#fff" stroke-opacity="0.18"/>`,
    text(x + 20, y + 23, rank, { size: 13, weight: 950, fill: '#11131a', anchor: 'middle' })
  ].join('');
}

function rankBadge(x, y, rank) {
  if (rank <= 3) return medal(x, y + 1, rank);
  return [
    roundedRect(x, y + 2, 42, 26, BADGE_BG, BADGE_BORDER, 6, 1),
    text(x + 21, y + 21, `${rank}.`, { size: 13, weight: 950, anchor: 'middle' })
  ].join('');
}

function categorySvg(category, x, y) {
  const rows = Array.isArray(category?.rows) ? category.rows.slice(0, ENTRY_COUNT) : [];
  const parts = [];
  parts.push(roundedRect(x, y + 7, 26, 26, '#17191f', '#262a33', 7, 1));
  parts.push(text(x + 13, y + 26, accentFor(category), { size: accentFor(category).length > 1 ? 10 : 13, weight: 950, fill: GOLD, anchor: 'middle' }));
  parts.push(text(x + 38, y + 29, titleFor(category), { size: 20, weight: 900 }));
  parts.push(text(x + COLUMN_W, y + 27, 'TOP 15', { size: 11, weight: 900, fill: DIM, anchor: 'end', letterSpacing: 1.2 }));

  if (!rows.length) {
    parts.push(text(x, y + CATEGORY_HEADER_H + 31, 'Noch keine Daten erfasst.', { size: 14, weight: 650, fill: DIM }));
    return parts.join('');
  }

  for (let i = 0; i < ENTRY_COUNT; i += 1) {
    const row = rows[i];
    if (!row) break;
    const rowY = y + CATEGORY_HEADER_H + (i * ENTRY_H);
    parts.push(rankBadge(x, rowY, i + 1));
    const player = truncate(row?.name || row?.steamId || 'Unbekannt', 32);
    parts.push(text(x + 58, rowY + 22, player, { size: 16, weight: 850 }));
    let value = '—';
    try { value = category?.format ? safeString(category.format(row)) : '—'; } catch { value = '—'; }
    parts.push(text(x + COLUMN_W, rowY + 22, truncate(value, 18), { size: 15, weight: 900, anchor: 'end' }));
  }
  return parts.join('');
}

export function buildLeaderboardSvg(snapshot, { timeZone = 'Europe/Vienna', generatedAt = new Date() } = {}) {
  const categories = Array.isArray(snapshot?.categories) ? snapshot.categories : [];
  const rows = Math.max(1, Math.ceil(categories.length / 2));
  const categoriesHeight = (rows * CATEGORY_H) + (Math.max(0, rows - 1) * CATEGORY_GAP);
  const boardBottom = CATEGORY_START_Y + categoriesHeight + FOOTER_H;
  const height = Math.max(1040, boardBottom + 70);
  const innerX = BOARD_X + BOARD_PAD;
  const rightX = innerX + COLUMN_W + COLUMN_GAP;
  const playerCount = Array.isArray(snapshot?.players) ? snapshot.players.length : 0;
  const since = formatDate(snapshot?.startedAt, timeZone);
  const generated = (() => {
    try { return new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone }).format(generatedAt); }
    catch { return new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(generatedAt); }
  })();

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">`,
    `<rect width="${WIDTH}" height="${height}" fill="${BG}"/>`,
    `<defs><filter id="shadow" x="-20%" y="-20%" width="140%" height="160%"><feDropShadow dx="0" dy="12" stdDeviation="18" flood-color="#000" flood-opacity="0.45"/></filter></defs>`,
    text(WIDTH / 2, 92, 'LEADERBOARD', { size: 62, weight: 950, fill: GOLD, anchor: 'middle', letterSpacing: 2.5 }),
    `<rect x="${BOARD_X}" y="${BOARD_Y}" width="${BOARD_W}" height="${boardBottom - BOARD_Y}" rx="12" fill="${BOARD}" stroke="${BOARD_BORDER}" stroke-width="1.5" filter="url(#shadow)"/>`,
    `<rect x="${BOARD_X}" y="${BOARD_Y}" width="6" height="${boardBottom - BOARD_Y}" rx="3" fill="#f2df00"/>`,
    text(innerX, 206, '🏆  All-Time Leaderboard', { size: 22, weight: 900 }),
    text(innerX, 248, 'TOP 15 PRO KATEGORIE', { size: 22, weight: 900 }),
    text(innerX, 286, `${playerCount.toLocaleString('de-DE')} Spieler erfasst seit ${since}`, { size: 14, weight: 550, fill: MUTED }),
    roundedRect(1095, 184, 166, 38, RULE_BG, RULE_BORDER, 8, 1),
    text(1178, 209, 'K/D: ab 100 Kills', { size: 12, weight: 850, fill: '#e8ebf3', anchor: 'middle' }),
    roundedRect(1272, 184, 184, 38, RULE_BG, RULE_BORDER, 8, 1),
    text(1364, 209, 'Headshot: ab 50 Kills', { size: 12, weight: 850, fill: '#e8ebf3', anchor: 'middle' }),
    `<line x1="${innerX}" y1="326" x2="${BOARD_X + BOARD_W - BOARD_PAD}" y2="326" stroke="#22242a" stroke-width="1"/>`
  ];

  for (let i = 0; i < categories.length; i += 1) {
    const row = Math.floor(i / 2);
    const col = i % 2;
    const x = col === 0 ? innerX : rightX;
    const y = CATEGORY_START_Y + (row * (CATEGORY_H + CATEGORY_GAP));
    parts.push(categorySvg(categories[i], x, y));
  }

  const footerY = boardBottom - 54;
  parts.push(`<line x1="${innerX}" y1="${footerY - 26}" x2="${BOARD_X + BOARD_W - BOARD_PAD}" y2="${footerY - 26}" stroke="#202228" stroke-width="1"/>`);
  parts.push(text(innerX, footerY, 'Spieler suchen: Button direkt unter dem Discord-Panel · genaue Position auch außerhalb der Top 15', { size: 13, weight: 650, fill: MUTED }));
  parts.push(text(BOARD_X + BOARD_W - BOARD_PAD, footerY, `Aktualisiert ${generated}`, { size: 12, weight: 650, fill: DIM, anchor: 'end' }));
  parts.push('</svg>');
  return { svg: parts.join(''), width: WIDTH, height };
}

function runRenderer(command, args, svg, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let size = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill('SIGKILL');
      settled = true;
      reject(new Error(`${command} timed out while rendering leaderboard`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > 15 * 1024 * 1024) {
        child.kill('SIGKILL');
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = Buffer.concat(stdout);
      if (size > 15 * 1024 * 1024) return reject(new Error(`${command} rendered an oversized leaderboard image`));
      if (code !== 0 || out.length < 8 || out.subarray(1, 4).toString('ascii') !== 'PNG') {
        return reject(new Error(`${command} failed (${code}): ${Buffer.concat(stderr).toString('utf8').slice(0, 300)}`));
      }
      resolve(out);
    });
    child.stdin.end(svg);
  });
}

export async function renderLeaderboardPng(snapshot, options = {}) {
  const { svg, width, height } = buildLeaderboardSvg(snapshot, options);
  const candidates = [
    ['rsvg-convert', ['-f', 'png']],
    ['/usr/bin/rsvg-convert', ['-f', 'png']],
    ['/opt/imagemagick/bin/magick', ['svg:-', 'png:-']],
    ['magick', ['svg:-', 'png:-']],
    ['convert', ['svg:-', 'png:-']]
  ];
  const errors = [];
  for (const [command, args] of candidates) {
    try {
      const png = await runRenderer(command, args, svg);
      return { png, width, height, svg };
    } catch (error) {
      errors.push(`${command}: ${String(error?.message || error).slice(0, 180)}`);
    }
  }
  throw new Error(`Leaderboard image renderer unavailable: ${errors.join(' · ').slice(0, 900)}`);
}
