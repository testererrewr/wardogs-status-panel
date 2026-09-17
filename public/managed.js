(() => {
  const rules = document.getElementById('managed-rules');
  const grants = document.getElementById('managed-grants');
  if (!rules || !grants) return;

  const lang = rules.dataset.lang === 'en' ? 'en' : 'de';
  let ruleIndex = Number(rules.dataset.nextIndex || rules.children.length || 0);
  let grantIndex = Number(grants.dataset.nextIndex || grants.children.length || 0);

  const t = {
    role: lang === 'en' ? 'Discord role' : 'Discord Rolle',
    user: lang === 'en' ? 'Discord user' : 'Discord Benutzer',
    name: lang === 'en' ? 'Player name contains' : 'Spielername enthält',
    faction: lang === 'en' ? 'Team / faction' : 'Team / Fraktion',
    reason: lang === 'en' ? 'Alert/ban reason (optional)' : 'Warn-/Banngrund (optional)'
  };
  const permissionLabels = {
    view: lang === 'en' ? 'View panel / players' : 'Panel / Spieler ansehen',
    announce: 'Announcements',
    whisper: 'Whisper',
    kick: 'Kick',
    ban: 'Ban',
    unban: 'Unban',
    kill: lang === 'en' ? 'Kill / respawn' : 'Kill / Respawn',
    setteam: lang === 'en' ? 'Set team' : 'Team setzen',
    match: lang === 'en' ? 'Match control' : 'Match steuern',
    map: lang === 'en' ? 'Change map' : 'Map wechseln',
    lighting: 'Lighting'
  };

  function ruleTemplate(i) {
    return `<div class="managed-rule-row" data-rule-row>
      <select name="ruleType_${i}" data-rule-type>
        <option value="steam">SteamID64</option>
        <option value="name">${t.name}</option>
        <option value="faction">${t.faction}</option>
        <option value="ping">Ping</option>
      </select>
      <select name="ruleOp_${i}" data-rule-op><option value="=">=</option></select>
      <input name="ruleValue_${i}" data-rule-value maxlength="100" placeholder="76561198000000001">
      <input name="ruleReason_${i}" maxlength="180" placeholder="${t.reason}">
      <button class="button danger smallbtn" type="button" data-remove-rule>×</button>
    </div>`;
  }

  function grantTemplate(i) {
    const perms = Object.entries(permissionLabels).map(([key, label]) =>
      `<label class="check"><input type="checkbox" name="grantPerm_${i}_${key}" value="1"> ${label}</label>`
    ).join('');
    return `<div class="managed-grant-row" data-grant-row>
      <div class="managed-grant-head">
        <select name="grantType_${i}"><option value="role">${t.role}</option><option value="user">${t.user}</option></select>
        <input name="grantId_${i}" inputmode="numeric" placeholder="Discord ID">
        <button class="button danger smallbtn" type="button" data-remove-grant>×</button>
      </div>
      <div class="managed-perm-grid">${perms}</div>
    </div>`;
  }

  function syncRule(row, preserve = true) {
    const type = row?.querySelector('[data-rule-type]');
    const op = row?.querySelector('[data-rule-op]');
    const value = row?.querySelector('[data-rule-value]');
    if (!type || !op || !value) return;
    const old = preserve ? op.value : '';
    if (type.value === 'ping') {
      op.innerHTML = '<option value=">">&gt;</option><option value=">=">&gt;=</option>';
      op.value = old === '>=' ? '>=' : '>';
      value.placeholder = '250';
    } else {
      op.innerHTML = `<option value="=">${type.value === 'name' ? 'contains' : '='}</option>`;
      value.placeholder = type.value === 'steam' ? '76561198000000001' : type.value === 'faction' ? 'Valkyra' : 'badword';
    }
  }

  document.getElementById('add-managed-rule')?.addEventListener('click', () => {
    if (ruleIndex >= 100) return;
    rules.insertAdjacentHTML('beforeend', ruleTemplate(ruleIndex++));
    syncRule(rules.lastElementChild, false);
  });

  document.getElementById('add-managed-grant')?.addEventListener('click', () => {
    if (grantIndex >= 20) return;
    grants.insertAdjacentHTML('beforeend', grantTemplate(grantIndex++));
  });

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.matches('[data-remove-rule]')) target.closest('[data-rule-row]')?.remove();
    if (target.matches('[data-remove-grant]')) target.closest('[data-grant-row]')?.remove();
  });

  document.addEventListener('change', (event) => {
    const target = event.target;
    if (target instanceof Element && target.matches('[data-rule-type]')) syncRule(target.closest('[data-rule-row]'), false);
  });

  rules.querySelectorAll('[data-rule-row]').forEach((row) => syncRule(row, true));
})();

(() => {
  const forms = document.querySelectorAll('[data-managed-map-form]');
  if (!forms.length) return;
  for (const form of forms) {
    const map = form.querySelector('[data-map-select]');
    const experienceBox = form.querySelector('[data-experience-options]');
    const experienceSummary = form.querySelector('[data-experience-summary]');
    const alternator = form.querySelector('[data-alternator-select]');
    const endpoint = form.dataset.optionsUrl;
    const lang = form.dataset.lang === 'en' ? 'en' : 'de';
    if (!map || !experienceBox || !alternator || !endpoint) continue;
    let sequence = 0;

    const syncSummary = () => {
      if (!experienceSummary) return;
      const selected = [...experienceBox.querySelectorAll('input[name="experiences"]:checked')];
      experienceSummary.textContent = selected.length
        ? (lang === 'en' ? `${selected.length} experience${selected.length === 1 ? '' : 's'} selected` : `${selected.length} Experience${selected.length === 1 ? '' : 's'} ausgewählt`)
        : (lang === 'en' ? 'Choose experiences…' : 'Experiences auswählen…');
    };

    const load = async () => {
      const selectedMap = map.value;
      if (!selectedMap) return;
      const own = ++sequence;
      alternator.disabled = true;
      experienceBox.setAttribute('aria-busy', 'true');
      try {
        const response = await fetch(`${endpoint}?map=${encodeURIComponent(selectedMap)}`, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
        const data = await response.json().catch(() => ({}));
        if (own !== sequence) return;
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        const exp = Array.isArray(data.experiences) ? data.experiences : [];
        experienceBox.innerHTML = exp.map((item) => {
          const id = typeof item === 'string' ? item : (item.id || item.name || '');
          const label = typeof item === 'string' ? item : (item.displayName || id);
          return id ? `<label class="check"><input type="checkbox" name="experiences" value="${escapeHtml(id)}"> ${escapeHtml(label)}</label>` : '';
        }).join('') || `<span class="muted small">${lang === 'en' ? 'No map-specific experiences reported.' : 'Keine map-spezifischen Experiences gemeldet.'}</span>`;
        const alts = Array.isArray(data.alternators) ? data.alternators : [];
        alternator.innerHTML = `<option value="">${lang === 'en' ? 'Server default' : 'Server-Standard'}</option>${alts.map((item) => {
          const value = item.tag || item.id || '';
          const label = item.displayName || item.tag || value;
          return value ? `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>` : '';
        }).join('')}`;
        syncSummary();
      } catch (error) {
        console.warn('WARDOGS map options:', error);
      } finally {
        if (own === sequence) { experienceBox.removeAttribute('aria-busy'); alternator.disabled = false; }
      }
    };
    map.addEventListener('change', load);
    experienceBox.addEventListener('change', syncSummary);
    load();
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }
})();
