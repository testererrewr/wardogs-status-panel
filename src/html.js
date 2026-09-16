export function esc(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function layout({ title, body, user, csrf, flash }) {
  const nav = user ? `
    <header class="topbar">
      <a class="brand" href="/">WARDOGS Status Panel</a>
      <nav>
        <a href="/">Server</a>
        ${user.role === 'admin' ? '<a href="/users">Benutzer</a>' : ''}
        <form method="post" action="/logout" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf)}"><button class="linkbtn">Logout</button></form>
      </nav>
      <div class="userchip">${user.avatarUrl ? `<img src="${esc(user.avatarUrl)}" alt="">` : ''}<span>${esc(user.globalName || user.username || user.discordId)}</span></div>
    </header>` : '';

  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · WARDOGS Status Panel</title><link rel="stylesheet" href="/style.css"></head>
<body>${nav}<main class="container">${flash ? `<div class="flash ${esc(flash.type)}">${esc(flash.message)}</div>` : ''}${body}</main></body></html>`;
}

export function serverForm({ server = {}, csrf, isEdit = false }) {
  const id = server.id || '';
  return `
  <form method="post" action="${isEdit ? `/servers/${esc(id)}/edit` : '/servers/new'}" class="panel formgrid">
    <input type="hidden" name="_csrf" value="${esc(csrf)}">
    <label>Servername<input name="name" required maxlength="80" value="${esc(server.name || '')}" placeholder="EU Server #1"></label>
    <label>Discord Bot Token<input name="botToken" ${isEdit ? '' : 'required'} type="password" autocomplete="new-password" placeholder="${isEdit ? 'Leer lassen = unverändert' : 'Bot Token'}"></label>
    <label>WARDOGS RCON URL<input name="rconUrl" required value="${esc(server.rconUrl || '')}" placeholder="http://1.2.3.4:7776"></label>
    <label>RCON Passwort<input name="rconPassword" ${isEdit ? '' : 'required'} type="password" autocomplete="new-password" placeholder="${isEdit ? 'Leer lassen = unverändert' : 'RCON Passwort'}"></label>
    <label>RCON Update-Intervall (Sek.)<input name="intervalSeconds" type="number" min="10" max="3600" value="${esc(server.intervalSeconds || 30)}"></label>
    <label>Status-Wechsel (Sek.)<input name="switchSeconds" type="number" min="5" max="3600" value="${esc(server.switchSeconds || 15)}"></label>
    <label class="span2">Online-Status Rotation<textarea name="onlineTemplates" rows="5" maxlength="1290" placeholder="{players}/{max} Spieler online&#10;Map: {map}">${esc((Array.isArray(server.onlineTemplates) && server.onlineTemplates.length ? server.onlineTemplates : [server.onlineTemplate || '{players}/{max} Spieler online', 'Map: {map}']).join('\n'))}</textarea></label>
    <label>Status offline<input name="offlineTemplate" maxlength="128" value="${esc(server.offlineTemplate || 'Server offline')}"></label>
    <label class="check"><input name="enabled" type="checkbox" value="1" ${server.enabled !== false ? 'checked' : ''}> Bot aktivieren</label>
    <div class="span2 help">Eine Zeile = ein Status. Beispiel: <code>{players}/{max} Spieler online</code> und <code>Map: {map}</code>. Platzhalter: <code>{players}</code>, <code>{max}</code>, <code>{server}</code>, <code>{map}</code>. Tokens/Passwörter werden verschlüsselt gespeichert.</div>
    <div class="span2 actions"><a class="button ghost" href="/">Abbrechen</a><button class="button primary" type="submit">${isEdit ? 'Speichern & neu starten' : 'Server hinzufügen'}</button></div>
  </form>`;
}
