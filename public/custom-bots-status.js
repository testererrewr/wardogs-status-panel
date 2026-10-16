// Custom-bot runtime status is loaded after the page paints: slow Docker
// inspection must never block the main website.
(() => {
  const badges = [...document.querySelectorAll('[data-custom-bot-id] [data-custom-runtime]')];
  if (!badges.length) return;
  async function refresh() {
    try {
      const response = await fetch('/custom-bots/statuses', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error('runtime unavailable');
      const json = await response.json();
      for (const badge of badges) {
        const status = json.statuses?.[badge.closest('[data-custom-bot-id]').dataset.customBotId];
        badge.classList.remove('online', 'neutral', 'error');
        badge.classList.add(status ? (status.running ? 'online' : 'neutral') : 'error');
        badge.textContent = status ? (status.running ? 'Läuft / Running' : 'Gestoppt / Stopped') : 'Status unbekannt / Unavailable';
      }
    } catch {
      for (const badge of badges) { badge.classList.remove('online', 'neutral'); badge.classList.add('error'); badge.textContent = 'Status unbekannt / Unavailable'; }
    }
  }
  refresh();
  // No repeated polls while the tab is hidden.
  setInterval(() => { if (!document.hidden) refresh(); }, 30000);
})();
