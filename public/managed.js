(() => {
  const rules = document.getElementById('managed-rules');
  const grants = document.getElementById('managed-grants');
  if (!rules || !grants) return;

  const banTemplates = document.getElementById('managed-ban-templates');
  const lang = rules.dataset.lang === 'en' ? 'en' : 'de';
  let ruleIndex = Number(rules.dataset.nextIndex || 0);
  let grantIndex = Number(grants.dataset.nextIndex || grants.children.length || 0);
  let banTemplateIndex = Number(banTemplates?.dataset.nextIndex || banTemplates?.children.length || 0);

  const t = {
    role: lang === 'en' ? 'Discord role' : 'Discord Rolle',
    user: lang === 'en' ? 'Discord user' : 'Discord Benutzer',
    reason: lang === 'en' ? 'Alert / action reason (optional)' : 'Warn-/Aktionsgrund (optional)',
    count: lang === 'en' ? 'count' : 'Anzahl',
    minutes: lang === 'en' ? 'minutes' : 'Minuten',
    hours: lang === 'en' ? 'hours' : 'Stunden',
    days: lang === 'en' ? 'days' : 'Tage',
    active: lang === 'en' ? 'active' : 'aktiv',
    templateName: lang === 'en' ? 'Template name' : 'Template-Name',
    banReason: lang === 'en' ? 'Ban reason' : 'Ban-Grund',
    permanent: lang === 'en' ? 'Permanent' : 'Permanent'
  };
  const ruleLabels = {
    vac_bans: 'VAC-Bans',
    game_bans: lang === 'en' ? 'Game bans' : 'Game-Bans',
    playtime: lang === 'en' ? 'Low playtime' : 'Wenig Spielzeit',
    account_age: lang === 'en' ? 'New Steam account' : 'Neues Steam-Konto',
    recent_ban: lang === 'en' ? 'Recent Steam ban' : 'Kürzlicher Steam-Ban',
    community_ban: 'Community-Ban',
    economy_ban: 'Economy-Ban',
    private_profile: lang === 'en' ? 'Private Steam profile' : 'Privates Steam-Profil'
  };
  const permissionLabels = {
    view: lang === 'en' ? 'View panel / players' : 'Panel / Spieler ansehen',
    announce: 'Announcements', whisper: 'Whisper', kick: 'Kick', ban: 'Ban', unban: 'Unban',
    kill: lang === 'en' ? 'Kill / respawn' : 'Kill / Respawn',
    setteam: lang === 'en' ? 'Set team' : 'Team setzen',
    match: lang === 'en' ? 'Match control' : 'Match steuern',
    map: lang === 'en' ? 'Change map' : 'Map wechseln', lighting: 'Lighting',
    ignore: lang === 'en' ? 'Ignore detection alerts' : 'Warnungen ignorieren'
  };

  function durationControls(baseName, { temporaryOnly = false, unit = '', value = 1 } = {}) {
    const selectedUnit = unit || (temporaryOnly ? 'days' : 'permanent');
    const permanent = temporaryOnly ? '' : `<option value="permanent" ${selectedUnit === 'permanent' ? 'selected' : ''}>${t.permanent}</option>`;
    const hidden = selectedUnit === 'permanent' && !temporaryOnly;
    return `<span class="managed-duration" data-ban-duration><select name="${baseName}Unit" data-duration-unit>${permanent}<option value="minutes" ${selectedUnit === 'minutes' ? 'selected' : ''}>${t.minutes}</option><option value="hours" ${selectedUnit === 'hours' ? 'selected' : ''}>${t.hours}</option><option value="days" ${selectedUnit === 'days' ? 'selected' : ''}>${t.days}</option></select><input name="${baseName}Value" data-duration-value type="number" min="1" max="525600" step="1" value="${value}" ${hidden ? 'hidden disabled' : ''}></span>`;
  }

  function syncDuration(container) {
    const unit = container?.querySelector?.('[data-duration-unit]');
    const value = container?.querySelector?.('[data-duration-value]');
    if (!unit || !value) return;
    const permanent = unit.value === 'permanent';
    value.hidden = permanent;
    value.disabled = permanent;
    if (!permanent) {
      value.min = '1';
      value.step = '1';
      value.max = unit.value === 'days' ? '365' : unit.value === 'hours' ? '8760' : '525600';
      if (!Number(value.value) || Number(value.value) <= 0) value.value = '1';
    }
  }

  function ruleOptions(selected = 'vac_bans') {
    return Object.entries(ruleLabels).map(([value, label]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`).join('');
  }

  function actionOptions(selected = 'alert') {
    const rows = [
      ['alert', lang === 'en' ? 'Alert only' : 'Nur Warnung'],
      ['kick', 'Kick'],
      ['ban', lang === 'en' ? 'Permanent ban' : 'Permanenter Ban'],
      ['tempban', lang === 'en' ? 'Temporary ban' : 'Temporärer Ban']
    ];
    return rows.map(([value, label]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`).join('');
  }

  function ruleTemplate(i) {
    return `<div class="managed-rule-row" data-rule-row>
      <select name="ruleType_${i}" data-rule-type>${ruleOptions()}</select>
      <span class="managed-rule-op" data-rule-op-label>≥</span>
      <input name="ruleValue_${i}" data-rule-value type="number" min="0" step="1" value="1" placeholder="1">
      <span class="managed-rule-unit" data-rule-unit>${t.count}</span>
      <input name="ruleReason_${i}" maxlength="180" placeholder="${t.reason}">
      <select name="ruleAction_${i}" data-rule-action>${actionOptions()}</select>
      <span data-rule-duration hidden>${durationControls(`ruleDuration_${i}`, { temporaryOnly: true, unit: 'days', value: 1 })}</span>
      <button class="button danger smallbtn" type="button" data-remove-rule>×</button>
    </div>`;
  }

  function grantTemplate(i) {
    const perms = Object.entries(permissionLabels).map(([key, label]) => `<label class="check"><input type="checkbox" name="grantPerm_${i}_${key}" value="1"> ${label}</label>`).join('');
    return `<div class="managed-grant-row" data-grant-row><div class="managed-grant-head"><select name="grantType_${i}"><option value="role">${t.role}</option><option value="user">${t.user}</option></select><input name="grantId_${i}" inputmode="numeric" placeholder="Discord ID"><button class="button danger smallbtn" type="button" data-remove-grant>×</button></div><div class="managed-perm-grid">${perms}</div></div>`;
  }

  function banTemplate(i) {
    return `<div class="managed-ban-template-row" data-ban-template-row>
      <input name="banTemplateLabel_${i}" maxlength="60" required placeholder="${t.templateName}">
      <input name="banTemplateReason_${i}" maxlength="180" required placeholder="${t.banReason}">
      ${durationControls(`banTemplateDuration_${i}`, { unit: 'permanent', value: 1 })}
      <button class="button danger smallbtn" type="button" data-remove-ban-template>×</button>
    </div>`;
  }

  function syncRuleAction(row) {
    const action = row?.querySelector('[data-rule-action]');
    const duration = row?.querySelector('[data-rule-duration]');
    if (!action || !duration) return;
    const temporary = action.value === 'tempban';
    duration.hidden = !temporary;
    for (const field of duration.querySelectorAll('input,select')) field.disabled = !temporary;
    if (temporary) syncDuration(duration.querySelector('[data-ban-duration]'));
  }

  function syncRule(row) {
    const type = row?.querySelector('[data-rule-type]');
    const value = row?.querySelector('[data-rule-value]');
    const op = row?.querySelector('[data-rule-op-label]');
    const unit = row?.querySelector('[data-rule-unit]');
    if (!type || !value || !op || !unit) return;
    const bool = ['community_ban','economy_ban','private_profile'].includes(type.value);
    value.disabled = bool;
    value.hidden = bool;
    if (bool) { op.textContent = '='; unit.textContent = t.active; syncRuleAction(row); return; }
    value.hidden = false;
    if (type.value === 'playtime') { op.textContent = '<'; unit.textContent = t.hours; value.step = '0.1'; value.min = '0.1'; value.placeholder = '10'; }
    else if (type.value === 'account_age') { op.textContent = '<'; unit.textContent = t.days; value.step = '1'; value.min = '1'; value.placeholder = '30'; }
    else if (type.value === 'recent_ban') { op.textContent = '≤'; unit.textContent = t.days; value.step = '1'; value.min = '0'; value.placeholder = '365'; }
    else { op.textContent = '≥'; unit.textContent = t.count; value.step = '1'; value.min = '1'; value.placeholder = '1'; }
    syncRuleAction(row);
  }

  document.getElementById('add-managed-rule')?.addEventListener('click', () => {
    if (ruleIndex >= 100) return;
    rules.querySelector('.managed-rule-empty')?.remove();
    rules.insertAdjacentHTML('beforeend', ruleTemplate(ruleIndex++));
    syncRule(rules.lastElementChild);
  });

  document.getElementById('add-managed-grant')?.addEventListener('click', () => {
    if (grantIndex >= 20) return;
    grants.insertAdjacentHTML('beforeend', grantTemplate(grantIndex++));
  });

  document.getElementById('add-ban-template')?.addEventListener('click', () => {
    if (!banTemplates || banTemplateIndex >= 12) return;
    banTemplates.insertAdjacentHTML('beforeend', banTemplate(banTemplateIndex++));
    syncDuration(banTemplates.lastElementChild?.querySelector('[data-ban-duration]'));
  });

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.matches('[data-remove-rule]')) target.closest('[data-rule-row]')?.remove();
    if (target.matches('[data-remove-grant]')) target.closest('[data-grant-row]')?.remove();
    if (target.matches('[data-remove-ban-template]')) target.closest('[data-ban-template-row]')?.remove();
  });

  document.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.matches('[data-rule-type]')) syncRule(target.closest('[data-rule-row]'));
    if (target.matches('[data-rule-action]')) syncRuleAction(target.closest('[data-rule-row]'));
    if (target.matches('[data-duration-unit]')) syncDuration(target.closest('[data-ban-duration]'));
  });

  rules.querySelectorAll('[data-rule-row]').forEach(syncRule);
  document.querySelectorAll('[data-ban-duration]').forEach(syncDuration);
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

(() => {
  const modal = document.querySelector('[data-managed-ban-modal]');
  if (!modal) return;
  const form = modal.querySelector('[data-managed-ban-form]');
  const steamInput = modal.querySelector('[data-ban-steam-id]');
  const reason = modal.querySelector('[data-ban-reason]');
  const reasonCount = modal.querySelector('[data-ban-reason-count]');
  const template = modal.querySelector('[data-ban-template]');
  const targetLabel = modal.querySelector('[data-ban-target-label]');
  const duration = modal.querySelector('[data-ban-duration]');
  const durationUnit = duration?.querySelector('[data-duration-unit]');
  const durationValue = duration?.querySelector('[data-duration-value]');
  const submit = modal.querySelector('.managed-ban-confirm');

  const syncDuration = () => {
    if (!durationUnit || !durationValue) return;
    const permanent = durationUnit.value === 'permanent';
    durationValue.hidden = permanent;
    durationValue.disabled = permanent;
    if (!permanent) {
      durationValue.min = '1';
      durationValue.step = '1';
      durationValue.max = durationUnit.value === 'days' ? '365' : durationUnit.value === 'hours' ? '8760' : '525600';
      if (!Number(durationValue.value) || Number(durationValue.value) <= 0) durationValue.value = '1';
    }
  };
  const syncCount = () => { if (reasonCount) reasonCount.textContent = String(reason?.value?.length || 0); };
  const resetForm = () => {
    form?.reset();
    if (template) template.value = '';
    if (reason) reason.value = '';
    if (durationUnit) durationUnit.value = 'permanent';
    if (durationValue) durationValue.value = '1';
    syncDuration(); syncCount();
    if (submit) submit.disabled = false;
  };
  const open = (button) => {
    resetForm();
    const steam = String(button?.dataset?.steamId || '');
    const player = String(button?.dataset?.playerName || '').trim();
    if (steamInput) {
      steamInput.value = steam;
      steamInput.readOnly = Boolean(steam);
    }
    if (targetLabel) targetLabel.textContent = steam ? `${player || 'Player'} · ${steam}` : 'SteamID64';
    modal.hidden = false;
    document.body.classList.add('modal-open');
    window.setTimeout(() => (steam ? reason : steamInput)?.focus(), 0);
  };
  const close = () => {
    modal.hidden = true;
    document.body.classList.remove('modal-open');
  };

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const opener = target.closest('[data-open-managed-ban]');
    if (opener) { open(opener); return; }
    if (target.closest('[data-close-managed-ban]')) { close(); return; }
    if (target === modal) close();
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !modal.hidden) close(); });
  reason?.addEventListener('input', () => { if (template?.value) template.value = ''; syncCount(); });
  durationUnit?.addEventListener('change', () => { if (template?.value) template.value = ''; syncDuration(); });
  durationValue?.addEventListener('input', () => { if (template?.value) template.value = ''; });
  template?.addEventListener('change', () => {
    const option = template.selectedOptions?.[0];
    if (!option || !option.value) return;
    if (reason) reason.value = option.dataset.banReason || '';
    if (durationUnit) durationUnit.value = option.dataset.banUnit || 'permanent';
    if (durationValue) durationValue.value = option.dataset.banValue || '1';
    syncDuration(); syncCount();
  });
  form?.addEventListener('submit', () => { if (submit) { submit.disabled = true; submit.textContent = 'BAN…'; } });
  syncDuration(); syncCount();
})();
