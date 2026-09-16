import { games } from 'gamedig';

const SPECIAL = {
  discord: {
    hostMode: 'none',
    note: 'Benötigt eine Discord Guild ID; das Server-Widget muss aktiviert sein.',
    fields: [{ key: 'guildId', label: 'Discord Guild ID', type: 'text', required: true, secret: false, placeholder: '123456789012345678' }]
  },
  palworld: {
    note: 'RESTAPIEnabled muss True sein. Benutzer ist normalerweise admin; Admin-Passwort wird benötigt.',
    fields: [
      { key: 'username', label: 'API Benutzer', type: 'text', required: true, secret: false, default: 'admin', placeholder: 'admin' },
      { key: 'password', label: 'Admin Passwort', type: 'password', required: true, secret: true, placeholder: 'AdminPassword' }
    ]
  },
  farmingsimulator19: tokenField('Farming Simulator Webinterface-Code'),
  farmingsimulator22: tokenField('Farming Simulator Webinterface-Code'),
  farmingsimulator25: tokenField('Farming Simulator Webinterface-Code'),
  terrariatshock: {
    note: 'Benötigt TShock und einen REST User Token.',
    fields: [{ key: 'token', label: 'TShock REST Token', type: 'password', required: true, secret: true, placeholder: 'Token' }]
  },
  sdtd: {
    note: 'Spielerzahl funktioniert ohne Telnet. Für Spielernamen und Zusatzdaten kann Telnet aktiviert werden.',
    fields: [
      { key: 'telnetPort', label: 'Telnet Port', type: 'number', required: false, secret: false, placeholder: '8081' },
      { key: 'telnetPassword', label: 'Telnet Passwort', type: 'password', required: false, secret: true, placeholder: 'optional' },
      { key: 'moreData', label: 'Zusatzdaten über Telnet abrufen', type: 'checkbox', required: false, secret: false }
    ]
  },
  ssl: {
    hostMode: 'none',
    note: 'Nur verifizierte SCP: Secret Laboratory Server können abgefragt werden.',
    fields: [
      { key: 'accountId', label: 'Account ID', type: 'text', required: true, secret: false, placeholder: 'Account ID' },
      { key: 'apiKey', label: 'API Key', type: 'password', required: true, secret: true, placeholder: 'API Key' },
      { key: 'serverId', label: 'Server ID', type: 'text', required: true, secret: false, placeholder: 'Server ID' }
    ]
  },
  satisfactory: {
    note: 'Optional kann ein Auth-Token verwendet werden. Standardmäßig akzeptiert GameDig selbstsignierte Zertifikate.',
    fields: [
      { key: 'token', label: 'Auth Token', type: 'password', required: false, secret: true, placeholder: 'optional' },
      { key: 'rejectUnauthorized', label: 'Nur gültige HTTPS-Zertifikate akzeptieren', type: 'checkbox', required: false, secret: false }
    ]
  },
  shootmania: nadeoFields(),
  trackmania2: nadeoFields(),
  trackmaniaforever: nadeoFields(),
  teamspeak3: {
    note: 'Standard Query-Port ist 10011. Nur ändern, wenn dein Anbieter einen anderen Query-Port verwendet.',
    fields: [{ key: 'teamspeakQueryPort', label: 'TeamSpeak Query Port', type: 'number', required: false, secret: false, placeholder: '10011' }]
  },
  dayz: {
    note: 'Mit requestRules können zusätzliche DayZ-Tags/Modinformationen abgefragt werden. Spielernamen werden üblicherweise nicht geliefert.',
    fields: [{ key: 'requestRules', label: 'Zusätzliche Server-Regeln abrufen', type: 'checkbox', required: false, secret: false }]
  },
  soulmask: {
    note: 'requestRules liefert unter anderem die echte Spielversion statt der hardcodierten A2S-Version.',
    fields: [{ key: 'requestRules', label: 'Zusätzliche Server-Regeln abrufen', type: 'checkbox', required: false, secret: false }]
  },
  gta5am: {
    hostMode: 'optional',
    note: 'alt:V kann per Host/Port oder Public Server ID abgefragt werden.',
    fields: [{ key: 'serverId', label: 'Public Server ID', type: 'text', required: false, secret: false, placeholder: 'optional statt Host/Port' }]
  },
  brokeprotocol: {
    hostMode: 'optional',
    note: 'BROKE PROTOCOL kann per Adresse/Port oder Public Server ID abgefragt werden.',
    fields: [{ key: 'serverId', label: 'Public Server ID', type: 'text', required: false, secret: false, placeholder: 'optional statt Host/Port' }]
  },
  hawakening: {
    hostMode: 'none',
    note: 'Hawakening benötigt Server ID und ein Benutzerprofil; Token oder Passwort werden für den Zugriff benötigt.',
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
    note: 'Benötigt einen Token/Code aus dem Webinterface des eigenen Farming-Simulator-Servers.',
    fields: [{ key: 'token', label, type: 'password', required: true, secret: true, placeholder: 'Code / Token' }]
  };
}

function nadeoFields() {
  return {
    note: 'Der XML-RPC-Port muss verwendet werden. Zusätzlich wird ein Server-Account mit mindestens User-Rechten benötigt.',
    fields: [
      { key: 'login', label: 'XML-RPC Login', type: 'text', required: true, secret: false, placeholder: 'Login' },
      { key: 'password', label: 'XML-RPC Passwort', type: 'password', required: true, secret: true, placeholder: 'Passwort' }
    ]
  };
}

const EXTRA_NOTES = {
  armareforger: 'A2S muss in der Server-Konfiguration aktiviert sein. GameDig liefert keine Player-Daten.',
  valheim: 'Der Server muss public laufen. Bei Crossplay kann numplayers laut GameDig immer 0 sein.',
  conanexiles: 'Conan Exiles beantwortet laut GameDig keine Player-Query.',
  counterstrike2: 'Spielernamen werden standardmäßig nicht geliefert; Spielerzahl/Slots funktionieren über die Server-Query.',
  gta5f: 'Für Player-Details muss sv_exposePlayerIdentifiersInHttpEndpoint=1 gesetzt sein. Für FiveM empfiehlt sich im Panel der direkte FiveM-Modus.',
  minecraft: 'Je nach Minecraft-Server werden keine einzelnen Player-Details geliefert; GameDig probiert mehrere Protokolle.',
  thefront: 'GameDig dokumentiert unzuverlässige Werte für Servername und maxplayers bei The Front.',
  asa: 'Epic Online Services liefert keine Player-Liste; Playerdaten können daher eingeschränkt sein.',
  squad: 'Epic Online Services liefert keine Player-Liste; Playerdaten können daher eingeschränkt sein.',
  tie: 'Epic Online Services liefert keine Player-Liste; Playerdaten können daher eingeschränkt sein.',
  renown: 'Epic Online Services liefert keine Player-Liste; Playerdaten können daher eingeschränkt sein.'
};

function entries() {
  if (games instanceof Map) return [...games.entries()];
  if (Array.isArray(games)) return games.map((g, i) => [String(g?.id || g?.type || i), g]);
  return Object.entries(games || {});
}

function asPort(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
}

function protocolName(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.replace(/^protocol-/, '');
  if (typeof value === 'function') return value.name || '';
  if (typeof value === 'object') return String(value.name || value.id || value.type || '');
  return String(value);
}

function normalizedDefinition(id, def = {}) {
  const options = def?.options || {};
  const connectPort = asPort(options.port);
  const queryPort = asPort(options.port_query);
  const offset = Number(options.port_query_offset);
  const calculated = connectPort && Number.isFinite(offset) ? asPort(connectPort + offset) : null;
  const special = SPECIAL[id] || {};
  const protocol = protocolName(options.protocol);
  const note = [special.note, EXTRA_NOTES[id]].filter(Boolean).join(' ');
  return {
    id,
    name: String(def?.name || id),
    releaseYear: def?.release_year || null,
    protocol,
    connectPort,
    queryPort,
    defaultPort: queryPort || calculated || connectPort || null,
    hostMode: special.hostMode || 'required',
    fields: Array.isArray(special.fields) ? special.fields : [],
    note,
    playerDataLimited: ['armareforger', 'conanexiles', 'asa', 'squad', 'tie', 'renown'].includes(id)
  };
}

let cache = null;
export function gameDigCatalog() {
  if (!cache) cache = entries().map(([id, def]) => normalizedDefinition(String(id), def)).sort((a, b) => a.name.localeCompare(b.name, 'de'));
  return cache;
}

export function gameDigMeta(id) {
  const key = String(id || '').trim();
  return gameDigCatalog().find((g) => g.id === key) || null;
}

export function gameDigFieldDefs(id) {
  return gameDigMeta(id)?.fields || [];
}

export function specialCatalogEntries() {
  return [
    {
      id: 'wardogs', provider: 'Direkt', name: 'WARDOGS', category: 'Gameserver', defaultPort: 7776,
      features: ['Spieler', 'Slots', 'Map', 'Servername', 'Online/Offline'],
      note: 'Direkte /v1/status-Abfrage mit RCON/Bearer-Passwort.'
    },
    {
      id: 'fivem-direct', provider: 'Direkt', name: 'FiveM', category: 'Gameserver', defaultPort: 30120,
      features: ['Spieler', 'Slots', 'Map/Gametype', 'Servername', 'Online/Offline'],
      note: 'Direkte Abfrage von dynamic.json und players.json. Kein RCON nötig.'
    },
    {
      id: 'generic-json', provider: 'JSON', name: 'Generische JSON API', category: 'API', defaultPort: null,
      features: ['Spieler*', 'Slots*', 'Map*', 'Servername*', 'Online/Offline'],
      note: 'Frei konfigurierbare JSON-Pfade. *Felder hängen von deiner API ab.'
    }
  ];
}
