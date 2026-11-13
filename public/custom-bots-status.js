// Read-only status display. A failed Docker/runner query says nothing about
// whether a bot is running. Never turn an unknown state into "Stopped".
(() => {
  const badges = [...document.querySelectorAll('[data-custom-bot-id] [data-custom-runtime]')];
  if (!badges.length) return;
  let inFlight = false;
  const reasons = {
    runner_configuration: 'Runner-Konfiguration prüfen',
    docker_permissions: 'Runner hat keinen Docker-Zugriff',
    docker_unavailable: 'Docker-Daemon nicht erreichbar',
    runner_unavailable: 'Runner nicht erreichbar',
    timeout: 'Statusabfrage zu langsam',
    status_query_failed: 'Statusabfrage fehlgeschlagen'
  };
  function showWarning(statuses) {
    let warning = document.querySelector('[data-custom-runtime-warning]');
    const problemCodes = [...new Set(Object.values(statuses).filter((s) => s?.unknown).map((s) => s.reason || 'status_query_failed'))];
    if (!problemCodes.length) {
      if (warning) warning.remove();
      return;
    }
    if (!warning) {
      warning = document.createElement('div');
      warning.className = 'panel warning';
      warning.dataset.customRuntimeWarning = '';
      const heading = document.querySelector('.pagehead');
      if (heading) heading.insertAdjacentElement('afterend', warning);
    }
    warning.textContent = `Custom-Bot-Status derzeit nicht prüfbar: ${problemCodes.map((code) => reasons[code] || reasons.status_query_failed).join(', ')}. Die Bots können weiterhin laufen. Bitte Runner/Docker auf der VPS prüfen; es wurde nichts automatisch gestoppt oder neu gebaut.`;
  }
  function show(badge, status) {
    badge.classList.remove('online', 'neutral', 'error');
    if (status?.unknown || !status) {
      badge.classList.add('neutral');
      badge.textContent = 'Status nicht prüfbar';
      badge.title = `${reasons[status?.reason] || reasons.status_query_failed}. Der Bot kann trotzdem laufen.`;
    } else if (status.exists === false) {
      badge.classList.add('neutral');
      badge.textContent = 'Kein Container / Not created';
      badge.title = 'Für diesen Bot ist derzeit kein Container vorhanden.';
    } else if (status.running) {
      badge.classList.add('online');
      badge.textContent = 'Läuft / Running';
      badge.title = '';
    } else {
      badge.classList.add('neutral');
      badge.textContent = 'Gestoppt / Stopped';
      badge.title = '';
    }
  }
  async function refresh() {
    if (inFlight) return;
    inFlight = true;
    try {
      const response = await fetch('/custom-bots/statuses', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error('status query failed');
      const json = await response.json();
      if (!json.ok || !json.statuses) throw new Error('invalid status response');
      const received = {};
      for (const badge of badges) {
        const id = badge.closest('[data-custom-bot-id]').dataset.customBotId;
        received[id] = json.statuses[id] || { unknown: true, reason: 'status_query_failed' };
        show(badge, received[id]);
      }
      showWarning(received);
    } catch {
      const unknown = {};
      for (const badge of badges) {
        show(badge, { unknown: true, reason: 'runner_unavailable' });
        unknown[badge.closest('[data-custom-bot-id]').dataset.customBotId] = { unknown: true, reason: 'runner_unavailable' };
      }
      showWarning(unknown);
    } finally { inFlight = false; }
  }
  refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, 30000);
})();
