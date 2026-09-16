export function esc(value = '') {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

export function layout({ title, body, user, csrf, flash }) {
  const nav = user ? `
  <header class="topbar">
    <a class="brand" href="/">Server Status Hub</a>
    <nav><a href="/">Status Bots</a><a href="/custom-bots">Custom Bots</a>${user.role === 'admin' ? '<a href="/users">Benutzer</a>' : ''}
    <form method="post" action="/logout" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf)}"><button class="linkbtn">Logout</button></form></nav>
    <div class="userchip">${user.avatarUrl ? `<img src="${esc(user.avatarUrl)}" alt="">` : ''}<span>${esc(user.globalName || user.username || user.discordId)}</span></div>
  </header>` : '';
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Server Status Hub</title><link rel="stylesheet" href="/style.css"></head>
  <body>${nav}<main class="container">${flash ? `<div class="flash ${esc(flash.type)}">${esc(flash.message)}</div>` : ''}${body}</main></body></html>`;
}

function selected(a, b) { return a === b ? 'selected' : ''; }

export function serverForm({ server = {}, csrf, isEdit = false, isAdmin = false }) {
  const id = server.id || '';
  const cfg = server.queryConfig || {};
  const type = server.gameType || 'fivem';
  return `<form method="post" action="${isEdit ? `/servers/${esc(id)}/edit` : '/servers/new'}" class="panel formgrid" id="serverForm">
    <input type="hidden" name="_csrf" value="${esc(csrf)}">
    <label>Servername<input name="name" required maxlength="80" value="${esc(server.name || '')}" placeholder="Mein Gameserver"></label>
    <label>Servertyp<select name="gameType" id="gameType"><option value="fivem" ${selected(type,'fivem')}>FiveM</option><option value="wardogs" ${selected(type,'wardogs')}>WARDOGS</option><option value="gamedig" ${selected(type,'gamedig')}>GameDig (300+ Games)</option><option value="generic_json" ${selected(type,'generic_json')}>Generische JSON API</option></select></label>
    <label>Discord Bot Token<input name="botToken" ${isEdit ? '' : 'required'} type="password" autocomplete="new-password" placeholder="${isEdit ? 'Leer = unverändert' : 'Bot Token'}"></label>
    <label>Abfrage-Intervall (Sek.)<input name="intervalSeconds" type="number" min="10" max="3600" value="${esc(server.intervalSeconds || 30)}"></label>

    <div class="span2 gamebox" data-types="fivem wardogs"><h3>HTTP Serveradresse</h3><label>Basis-URL<input name="baseUrl" value="${esc(cfg.baseUrl || '')}" placeholder="http://1.2.3.4:30120"></label></div>
    <div class="span2 gamebox" data-types="wardogs"><h3>WARDOGS</h3><label>RCON/Bearer Passwort<input name="querySecret" type="password" autocomplete="new-password" placeholder="${isEdit ? 'Leer = unverändert' : 'RCON Passwort'}"></label></div>
    <div class="span2 gamebox" data-types="gamedig"><h3>GameDig</h3><div class="formgrid inner"><label>Host / IP<input name="queryHost" value="${esc(cfg.host || '')}" placeholder="play.example.com"></label><label>Port (optional)<input name="queryPort" type="number" min="1" max="65535" value="${esc(cfg.port || '')}" placeholder="25565"></label><label>GameDig Game-ID<input name="gameId" value="${esc(cfg.gameId || '')}" placeholder="minecraft"></label><div class="help">GameDig unterstützt über 300 Games. Verwende die jeweilige Game-ID, z. B. <code>minecraft</code>.</div></div></div>
    <div class="span2 gamebox" data-types="generic_json"><h3>Generische JSON API</h3><div class="formgrid inner"><label class="span2">JSON URL<input name="jsonUrl" value="${esc(cfg.url || '')}" placeholder="https://status.example.com/server.json"></label><label>Spieler-Pfad<input name="currentPath" value="${esc(cfg.currentPath || 'players.current')}"></label><label>Max-Pfad<input name="maxPath" value="${esc(cfg.maxPath || 'players.max')}"></label><label>Map-Pfad<input name="mapPath" value="${esc(cfg.mapPath || 'map')}"></label><label>Name-Pfad<input name="namePath" value="${esc(cfg.namePath || 'serverName')}"></label><label class="span2">Bearer Token (optional)<input name="genericToken" type="password" autocomplete="new-password" placeholder="${isEdit ? 'Leer = unverändert' : 'optional'}"></label></div></div>

    ${isAdmin ? `<label class="check span2"><input name="allowPrivateTarget" type="checkbox" value="1" ${server.allowPrivateTarget ? 'checked' : ''}> Private/LAN/localhost-Ziele erlauben (Admin-Option)</label>` : ''}
    <label>Status-Wechsel (Sek.)<input name="switchSeconds" type="number" min="5" max="3600" value="${esc(server.switchSeconds || 15)}"></label>
    <label>Status offline<input name="offlineTemplate" maxlength="128" value="${esc(server.offlineTemplate || 'Server offline')}"></label>
    <label class="span2">Online-Status Rotation<textarea name="onlineTemplates" rows="5" maxlength="1290">${esc((Array.isArray(server.onlineTemplates) && server.onlineTemplates.length ? server.onlineTemplates : ['{players}/{max} Spieler online','Map: {map}']).join('\n'))}</textarea></label>
    <label class="check"><input name="enabled" type="checkbox" value="1" ${server.enabled !== false ? 'checked' : ''}> Bot aktivieren</label>
    <div class="span2 help">Eine Zeile = ein Status. Platzhalter: <code>{players}</code>, <code>{max}</code>, <code>{server}</code>, <code>{map}</code>, <code>{game}</code>, <code>{ping}</code>. Secrets werden verschlüsselt gespeichert.</div>
    <div class="span2 actions"><a class="button ghost" href="/">Abbrechen</a><button class="button primary" type="submit">${isEdit ? 'Speichern & neu starten' : 'Status Bot erstellen'}</button></div>
  </form>
  <script>const s=document.getElementById('gameType');function show(){document.querySelectorAll('.gamebox').forEach(x=>x.style.display=x.dataset.types.split(' ').includes(s.value)?'block':'none')}s.addEventListener('change',show);show();</script>`;
}

export function customBotForm({ csrf }) {
  return `<form method="post" action="/custom-bots/new" enctype="multipart/form-data" class="panel formgrid">
    <input type="hidden" name="_csrf" value="${esc(csrf)}">
    <label>Name<input name="name" required maxlength="80" placeholder="Mein Discord Bot"></label>
    <label>Runtime<select name="runtime"><option value="node22">Node.js 22</option><option value="python313">Python 3.13</option></select></label>
    <label class="span2">ZIP-Datei<input name="archive" type="file" accept=".zip,application/zip" required></label>
    <label class="span2">Entrypoint<input name="entrypoint" required value="index.js" placeholder="index.js oder bot.py"></label>
    <label class="span2">Umgebungsvariablen<textarea name="envText" rows="8" placeholder="DISCORD_TOKEN=...&#10;API_KEY=..."></textarea></label>
    <div class="span2 warning"><strong>Sicherheitsmodell:</strong> Uploads starten nicht automatisch. Ein Admin muss jeden neuen Upload freigeben. Danach läuft der Bot in einem eigenen Docker-Container mit CPU/RAM/PID-Limits, read-only Root-Dateisystem, ohne Host-Mounts und ohne Linux-Capabilities.</div>
    <div class="span2 actions"><a class="button ghost" href="/custom-bots">Abbrechen</a><button class="button primary">Hochladen</button></div>
  </form>`;
}
