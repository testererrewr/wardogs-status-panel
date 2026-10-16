import { spawn } from 'node:child_process';

const WIDTH = 1600;
const HEIGHT = 1010;
const BOARD_X = 70;
const BOARD_Y = 125;
const BOARD_W = 1460;
const BOARD_H = 815;
const BOARD_PAD = 40;
const COLUMN_GAP = 58;
const CATEGORY_START_Y = 330;
const CATEGORY_HEADER_H = 46;
const ENTRY_H = 34;
const ENTRY_COUNT = 15;
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

export const LEADERBOARD_PAGE_GROUPS = Object.freeze([
  Object.freeze(['kills', 'deaths']),
  Object.freeze(['kd', 'headshots']),
  Object.freeze(['killrecord', 'playtime']),
  Object.freeze(['wins', 'matches']),
  Object.freeze(['seeding'])
]);

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
    kd: 'K/D (ab 50 Kills)',
    playtime: 'Spielzeit',
    killrecord: 'Kill-Rekord / Match',
    headshots: 'Headshot-Rate (ab 50 Kills)',
    wins: 'Match-Siege',
    matches: 'Matches gespielt',
    seeding: 'Seeding-Zeit (1–20 Spieler)'
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
    roundedRect(x, y + 2, 44, 28, BADGE_BG, BADGE_BORDER, 6, 1),
    text(x + 22, y + 22, `${rank}.`, { size: 14, weight: 950, anchor: 'middle' })
  ].join('');
}

function categorySvg(category, x, y, width) {
  const rows = Array.isArray(category?.rows) ? category.rows.slice(0, ENTRY_COUNT) : [];
  const parts = [];
  parts.push(roundedRect(x, y + 7, 29, 29, '#17191f', '#262a33', 7, 1));
  parts.push(text(x + 14.5, y + 28, accentFor(category), { size: accentFor(category).length > 1 ? 10 : 14, weight: 950, fill: GOLD, anchor: 'middle' }));
  parts.push(text(x + 43, y + 31, titleFor(category), { size: 23, weight: 900 }));
  parts.push(text(x + width, y + 29, 'TOP 15', { size: 12, weight: 900, fill: DIM, anchor: 'end', letterSpacing: 1.2 }));

  if (!rows.length) {
    parts.push(text(x, y + CATEGORY_HEADER_H + 34, 'Noch keine Daten erfasst.', { size: 16, weight: 650, fill: DIM }));
    return parts.join('');
  }

  for (let i = 0; i < ENTRY_COUNT; i += 1) {
    const row = rows[i];
    if (!row) break;
    const rowY = y + CATEGORY_HEADER_H + (i * ENTRY_H);
    parts.push(rankBadge(x, rowY, i + 1));
    const player = truncate(row?.name || row?.steamId || 'Unbekannt', width > 900 ? 50 : 31);
    parts.push(text(x + 62, rowY + 23, player, { size: 18, weight: 850 }));
    let value = '—';
    try { value = category?.format ? safeString(category.format(row)) : '—'; } catch { value = '—'; }
    parts.push(text(x + width, rowY + 23, truncate(value, 19), { size: 17, weight: 900, anchor: 'end' }));
  }
  return parts.join('');
}

function pageCategories(snapshot, page = 0) {
  const categories = Array.isArray(snapshot?.categories) ? snapshot.categories : [];
  const byId = new Map(categories.map((category) => [category.id, category]));
  const normalizedPage = Math.max(0, Math.min(LEADERBOARD_PAGE_GROUPS.length - 1, Number(page) || 0));
  return LEADERBOARD_PAGE_GROUPS[normalizedPage].map((id) => byId.get(id)).filter(Boolean);
}

export function leaderboardPageCount() {
  return LEADERBOARD_PAGE_GROUPS.length;
}

export function buildLeaderboardPageSvg(snapshot, { page = 0, timeZone = 'Europe/Vienna', generatedAt = new Date() } = {}) {
  const pageCount = leaderboardPageCount();
  const normalizedPage = Math.max(0, Math.min(pageCount - 1, Number(page) || 0));
  const categories = pageCategories(snapshot, normalizedPage);
  const innerX = BOARD_X + BOARD_PAD;
  const innerW = BOARD_W - (BOARD_PAD * 2);
  const columnW = Math.floor((innerW - COLUMN_GAP) / 2);
  const playerCount = Array.isArray(snapshot?.players) ? snapshot.players.length : 0;
  const since = formatDate(snapshot?.startedAt, timeZone);
  const generated = (() => {
    try { return new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone }).format(generatedAt); }
    catch { return new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(generatedAt); }
  })();

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`,
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="${BG}"/>`,
    `<defs><filter id="shadow" x="-20%" y="-20%" width="140%" height="160%"><feDropShadow dx="0" dy="12" stdDeviation="18" flood-color="#000" flood-opacity="0.45"/></filter></defs>`,
    text(WIDTH / 2, 84, 'LEADERBOARD', { size: 64, weight: 950, fill: GOLD, anchor: 'middle', letterSpacing: 2.5 }),
    `<rect x="${BOARD_X}" y="${BOARD_Y}" width="${BOARD_W}" height="${BOARD_H}" rx="12" fill="${BOARD}" stroke="${BOARD_BORDER}" stroke-width="1.5" filter="url(#shadow)"/>`,
    `<rect x="${BOARD_X}" y="${BOARD_Y}" width="7" height="${BOARD_H}" rx="3" fill="#f2df00"/>`,
    text(innerX, 180, 'ALL-TIME LEADERBOARD', { size: 24, weight: 950 }),
    text(innerX, 222, 'TOP 15 PRO KATEGORIE', { size: 23, weight: 900 }),
    text(innerX, 260, `${playerCount.toLocaleString('de-DE')} Spieler erfasst seit ${since}`, { size: 15, weight: 550, fill: MUTED }),
    roundedRect(1030, 157, 178, 42, RULE_BG, RULE_BORDER, 8, 1),
    text(1119, 184, 'K/D: ab 50 Kills', { size: 13, weight: 850, fill: '#e8ebf3', anchor: 'middle' }),
    roundedRect(1220, 157, 207, 42, RULE_BG, RULE_BORDER, 8, 1),
    text(1323.5, 184, 'Headshot: ab 50 Kills', { size: 13, weight: 850, fill: '#e8ebf3', anchor: 'middle' }),
    roundedRect(1290, 220, 137, 38, '#17191f', '#2c2f38', 8, 1),
    text(1358.5, 245, `SEITE ${normalizedPage + 1}/${pageCount}`, { size: 13, weight: 900, fill: GOLD, anchor: 'middle', letterSpacing: 0.8 }),
    `<line x1="${innerX}" y1="295" x2="${BOARD_X + BOARD_W - BOARD_PAD}" y2="295" stroke="#22242a" stroke-width="1"/>`
  ];

  if (categories.length === 1) {
    const singleW = 980;
    const singleX = Math.round((WIDTH - singleW) / 2);
    parts.push(categorySvg(categories[0], singleX, CATEGORY_START_Y, singleW));
  } else {
    parts.push(categorySvg(categories[0], innerX, CATEGORY_START_Y, columnW));
    if (categories[1]) parts.push(categorySvg(categories[1], innerX + columnW + COLUMN_GAP, CATEGORY_START_Y, columnW));
  }

  const footerY = BOARD_Y + BOARD_H - 31;
  parts.push(`<line x1="${innerX}" y1="${footerY - 30}" x2="${BOARD_X + BOARD_W - BOARD_PAD}" y2="${footerY - 30}" stroke="#202228" stroke-width="1"/>`);
  parts.push(text(innerX, footerY, 'Spieler suchen: Button unter dem Discord-Panel · exakte Position auch außerhalb der Top 15', { size: 14, weight: 650, fill: MUTED }));
  parts.push(text(BOARD_X + BOARD_W - BOARD_PAD, footerY, `Aktualisiert ${generated}`, { size: 13, weight: 650, fill: DIM, anchor: 'end' }));
  parts.push('</svg>');
  return { svg: parts.join(''), width: WIDTH, height: HEIGHT, page: normalizedPage, pageCount };
}

// Backwards-compatible API: callers that do not specify a page receive page 1.
export function buildLeaderboardSvg(snapshot, options = {}) {
  return buildLeaderboardPageSvg(snapshot, options);
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

export async function renderLeaderboardPagePng(snapshot, options = {}) {
  const { svg, width, height, page, pageCount } = buildLeaderboardPageSvg(snapshot, options);
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
      return { png, width, height, svg, page, pageCount };
    } catch (error) {
      errors.push(`${command}: ${String(error?.message || error).slice(0, 180)}`);
    }
  }
  throw new Error(`Leaderboard image renderer unavailable: ${errors.join(' · ').slice(0, 900)}`);
}

export async function renderLeaderboardPng(snapshot, options = {}) {
  return renderLeaderboardPagePng(snapshot, options);
}
