import { games } from 'gamedig';

const SPECIAL = {
  discord: {
    hostMode: 'none',
    noteDe: 'Benötigt eine Discord Guild ID; das Server-Widget muss aktiviert sein.',
    noteEn: 'Requires a Discord Guild ID; the server widget must be enabled.',
    fields: [{ key: 'guildId', label: 'Discord Guild ID', type: 'text', required: true, secret: false, placeholder: '123456789012345678' }]
  },
  palworld: {
    noteDe: 'RESTAPIEnabled muss True sein. Benutzer ist normalerweise admin; Admin-Passwort wird benötigt.',
    noteEn: 'RESTAPIEnabled must be True. The user is usually admin; the admin password is required.',
    fields: [
      { key: 'username', label: 'API Benutzer', type: 'text', required: true, secret: false, default: 'admin', placeholder: 'admin' },
      { key: 'password', label: 'Admin Passwort', type: 'password', required: true, secret: true, placeholder: 'AdminPassword' }
    ]
  },
  farmingsimulator19: tokenField('Farming Simulator Webinterface-Code'),
  farmingsimulator22: tokenField('Farming Simulator Webinterface-Code'),
  farmingsimulator25: tokenField('Farming Simulator Webinterface-Code'),
  terrariatshock: {
    noteDe: 'Benötigt TShock und einen REST User Token.',
    noteEn: 'Requires TShock and a REST user token.',
    fields: [{ key: 'token', label: 'TShock REST Token', type: 'password', required: true, secret: true, placeholder: 'Token' }]
  },
  sdtd: {
    noteDe: 'Spielerzahl funktioniert ohne Telnet. Für Spielernamen und Zusatzdaten kann Telnet aktiviert werden.',
    noteEn: 'Player count works without Telnet. Telnet can be enabled for player names and additional data.',
    fields: [
      { key: 'telnetPort', label: 'Telnet Port', type: 'number', required: false, secret: false, placeholder: '8081' },
      { key: 'telnetPassword', label: 'Telnet Passwort', type: 'password', required: false, secret: true, placeholder: 'optional' },
      { key: 'moreData', label: 'Zusatzdaten über Telnet abrufen', type: 'checkbox', required: false, secret: false }
    ]
  },
  ssl: {
    hostMode: 'none',
    noteDe: 'Nur verifizierte SCP: Secret Laboratory Server können abgefragt werden.',
    noteEn: 'Only verified SCP: Secret Laboratory servers can be queried.',
    fields: [
      { key: 'accountId', label: 'Account ID', type: 'text', required: true, secret: false, placeholder: 'Account ID' },
      { key: 'apiKey', label: 'API Key', type: 'password', required: true, secret: true, placeholder: 'API Key' },
      { key: 'serverId', label: 'Server ID', type: 'text', required: true, secret: false, placeholder: 'Server ID' }
    ]
  },
  satisfactory: {
    noteDe: 'Optional kann ein Auth-Token verwendet werden. Standardmäßig akzeptiert GameDig selbstsignierte Zertifikate.',
    noteEn: 'An auth token can be used optionally. By default, GameDig accepts self-signed certificates.',
    fields: [
      { key: 'token', label: 'Auth Token', type: 'password', required: false, secret: true, placeholder: 'optional' },
      { key: 'rejectUnauthorized', label: 'Nur gültige HTTPS-Zertifikate akzeptieren', type: 'checkbox', required: false, secret: false }
    ]
  },
  shootmania: nadeoFields(),
  trackmania2: nadeoFields(),
  trackmaniaforever: nadeoFields(),
  teamspeak3: {
    noteDe: 'Standard Query-Port ist 10011. Nur ändern, wenn dein Anbieter einen anderen Query-Port verwendet.',
    noteEn: 'The default query port is 10011. Change it only if your provider uses a different query port.',
    fields: [{ key: 'teamspeakQueryPort', label: 'TeamSpeak Query Port', type: 'number', required: false, secret: false, placeholder: '10011' }]
  },
  dayz: {
    noteDe: 'Mit requestRules können zusätzliche DayZ-Tags/Modinformationen abgefragt werden. Spielernamen werden üblicherweise nicht geliefert.',
    noteEn: 'requestRules can fetch additional DayZ tags and mod information. Player names are usually not provided.',
    fields: [{ key: 'requestRules', label: 'Zusätzliche Server-Regeln abrufen', type: 'checkbox', required: false, secret: false }]
  },
  soulmask: {
    noteDe: 'requestRules liefert unter anderem die echte Spielversion statt der hardcodierten A2S-Version.',
    noteEn: 'requestRules can return the real game version instead of the hard-coded A2S version.',
    fields: [{ key: 'requestRules', label: 'Zusätzliche Server-Regeln abrufen', type: 'checkbox', required: false, secret: false }]
  },
  gta5am: {
    hostMode: 'optional',
    noteDe: 'alt:V kann per Host/Port oder Public Server ID abgefragt werden.',
    noteEn: 'alt:V can be queried by host/port or public server ID.',
    fields: [{ key: 'serverId', label: 'Public Server ID', type: 'text', required: false, secret: false, placeholder: 'optional statt Host/Port' }]
  },
  brokeprotocol: {
    hostMode: 'optional',
    noteDe: 'BROKE PROTOCOL kann per Adresse/Port oder Public Server ID abgefragt werden.',
    noteEn: 'BROKE PROTOCOL can be queried by address/port or public server ID.',
    fields: [{ key: 'serverId', label: 'Public Server ID', type: 'text', required: false, secret: false, placeholder: 'optional statt Host/Port' }]
  },
  hawakening: {
    hostMode: 'none',
    noteDe: 'Hawakening benötigt Server ID und ein Benutzerprofil; Token oder Passwort werden für den Zugriff benötigt.',
    noteEn: 'Hawakening requires a server ID and user profile; a token or password is required for access.',
    fields: [
      { key: 'serverId', label: 'Server ID', type: 'text', required: true, secret: false, placeholder: 'Server ID' },
      { key: 'username', label: 'Account E-Mail', type: 'text', required: true, secret: false, placeholder: 'name@example.com' },
      { key: 'token', label: 'Access Token', type: 'password', required: false, secret: true, placeholder: 'Token oder Passwort' },
      { key: 'password', label: 'Account Passwort', type: 'password', required: false, secret: true, placeholder: 'Token oder Passwort' }
    ]
  }
};

function tokenField(label) {
  return {
    noteDe: 'Benötigt einen Token/Code aus dem Webinterface des eigenen Farming-Simulator-Servers.',
    noteEn: 'Requires a token/code from the web interface of your Farming Simulator server.',
    fields: [{ key: 'token', label, type: 'password', required: true, secret: true, placeholder: 'Code / Token' }]
  };
}

function nadeoFields() {
  return {
    noteDe: 'Der XML-RPC-Port muss verwendet werden. Zusätzlich wird ein Server-Account mit mindestens User-Rechten benötigt.',
    noteEn: 'The XML-RPC port must be used. A server account with at least user permissions is also required.',
    fields: [
      { key: 'login', label: 'XML-RPC Login', type: 'text', required: true, secret: false, placeholder: 'Login' },
      { key: 'password', label: 'XML-RPC Passwort', type: 'password', required: true, secret: true, placeholder: 'Passwort' }
    ]
  };
}

const EXTRA_NOTES = {
  armareforger: ['A2S muss in der Server-Konfiguration aktiviert sein. GameDig liefert keine Player-Daten.', 'A2S must be enabled in the server configuration. GameDig does not provide player data.'],
  valheim: ['Der Server muss public laufen. Bei Crossplay kann numplayers laut GameDig immer 0 sein.', 'The server must be public. With crossplay, GameDig may always report numplayers as 0.'],
  conanexiles: ['Conan Exiles beantwortet laut GameDig keine Player-Query.', 'According to GameDig, Conan Exiles does not answer player queries.'],
  counterstrike2: ['Spielernamen werden standardmäßig nicht geliefert; Spielerzahl/Slots funktionieren über die Server-Query.', 'Player names are not provided by default; player count and slots work through the server query.'],
  gta5f: ['Für Player-Details muss sv_exposePlayerIdentifiersInHttpEndpoint=1 gesetzt sein. Für FiveM empfiehlt sich im Panel der direkte FiveM-Modus.', 'For player details, sv_exposePlayerIdentifiersInHttpEndpoint=1 must be set. For FiveM, the direct FiveM mode in the panel is recommended.'],
  minecraft: ['Je nach Minecraft-Server werden keine einzelnen Player-Details geliefert; GameDig probiert mehrere Protokolle.', 'Depending on the Minecraft server, individual player details may not be available; GameDig tries multiple protocols.'],
  thefront: ['GameDig dokumentiert unzuverlässige Werte für Servername und maxplayers bei The Front.', 'GameDig documents unreliable server name and maxplayers values for The Front.'],
  asa: ['Epic Online Services liefert keine Player-Liste; Playerdaten können daher eingeschränkt sein.', 'Epic Online Services does not provide a player list, so player data may be limited.'],
  squad: ['Epic Online Services liefert keine Player-Liste; Playerdaten können daher eingeschränkt sein.', 'Epic Online Services does not provide a player list, so player data may be limited.'],
  tie: ['Epic Online Services liefert keine Player-Liste; Playerdaten können daher eingeschränkt sein.', 'Epic Online Services does not provide a player list, so player data may be limited.'],
  renown: ['Epic Online Services liefert keine Player-Liste; Playerdaten können daher eingeschränkt sein.', 'Epic Online Services does not provide a player list, so player data may be limited.']
};

function entries() {
  if (games instanceof Map) return [...games.entries()];
  if (Array.isArray(games)) return games.map((g, i) => [String(g?.id || g?.type || i), g]);
  return Object.entries(games || {});
}
function asPort(value) { const n = Number(value); return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null; }
function protocolName(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.replace(/^protocol-/, '');
  if (typeof value === 'function') return value.name || '';
  if (typeof value === 'object') return String(value.name || value.id || value.type || '');
  return String(value);
}

function normalizedDefinition(id, def = {}) {
  const options = def?.options || {};
  const connectPort = asPort(options.port); const queryPort = asPort(options.port_query); const offset = Number(options.port_query);
  const queryOffset = Number(options.port_query_offset);
  const calculated = connectPort && Number.isFinite(queryOffset) ? asPort(connectPort + queryOffset) : null;
  const special = SPECIAL[id] || {}; const protocol = protocolName(options.protocol); const extra = EXTRA_NOTES[id] || ['', ''];
  const noteDe = [special.noteDe, extra[0]].filter(Boolean).join(' '); const noteEn = [special.noteEn, extra[1]].filter(Boolean).join(' ');
  const playerDataLimited = ['armareforger', 'conanexiles', 'asa', 'squad', 'tie', 'renown'].includes(id);
  const serviceLike = ['discord', 'teamspeak2', 'teamspeak3', 'mumble', 'ventrilo'].includes(id) || /discord|teamspeak|mumble|ventrilo/i.test(protocol);
  const placeholders = ['{server}', '{ping}']; if (!playerDataLimited) placeholders.unshift('{players}', '{max}'); else placeholders.unshift('{max}'); if (!serviceLike) placeholders.splice(placeholders.length - 1, 0, '{map}');
  return { id, name: String(def?.name || id), releaseYear: def?.release_year || null, protocol, connectPort, queryPort, defaultPort: queryPort || calculated || connectPort || null, hostMode: special.hostMode || 'required', fields: Array.isArray(special.fields) ? special.fields : [], note: noteDe, noteDe, noteEn, playerDataLimited, placeholders };
}

let cache = null;
export function gameDigCatalog() { if (!cache) cache = entries().map(([id, def]) => normalizedDefinition(String(id), def)).sort((a, b) => a.name.localeCompare(b.name, 'de')); return cache; }
export function gameDigMeta(id) { const key = String(id || '').trim(); return gameDigCatalog().find((g) => g.id === key) || null; }
export function gameDigFieldDefs(id) { return gameDigMeta(id)?.fields || []; }
export function gameDigPlaceholders(id) { return gameDigMeta(id)?.placeholders || []; }

export function specialCatalogEntries() {
  return [
    { id: 'wardogs', provider: 'direct', name: 'WARDOGS', category: 'gameserver', defaultPort: 7776, features: ['Spieler', 'Slots', 'Map', 'Servername', 'Punktestand', 'Online/Offline'], noteDe: 'Direkte /v1/status-Abfrage mit RCON/Bearer-Passwort inklusive Live-Punktestand pro Fraktion.', noteEn: 'Direct /v1/status query using an RCON/Bearer password, including live faction scores.' },
    { id: 'fivem-direct', provider: 'direct', name: 'FiveM', category: 'gameserver', defaultPort: 30120, features: ['Spieler', 'Slots', 'Map/Gametype', 'Servername', 'Online/Offline'], noteDe: 'Direkte Abfrage von dynamic.json und players.json. Kein RCON nötig.', noteEn: 'Direct query of dynamic.json and players.json. No RCON required.' },
    { id: 'generic-json', provider: 'json', name: 'Generische JSON API', nameEn: 'Generic JSON API', category: 'api', defaultPort: null, features: ['Spieler*', 'Slots*', 'Map*', 'Servername*', 'Online/Offline'], noteDe: 'Frei konfigurierbare JSON-Pfade. *Felder hängen von deiner API ab.', noteEn: 'Configurable JSON paths. *Fields depend on your API.' }
  ];
}
