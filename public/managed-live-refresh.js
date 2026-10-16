// Refresh only the embedded management panel. Never reload the parent page or
// interrupt a user typing, editing a form or interacting with a dialog.
(() => {
  if (window.top === window.self) return;
  const seconds = Math.max(10, Math.min(120, Number(document.body?.dataset?.refreshSeconds || 20)));
  const indicator = document.querySelector('[data-managed-auto-refresh]');
  const refresh = () => {
    try {
      if (document.visibilityState === 'hidden' || window.parent.document.visibilityState === 'hidden') return;
      const active = document.activeElement;
      if (active && active !== document.body && active !== document.documentElement &&
          (active.matches('input,select,textarea,[contenteditable]') || active.closest('[role="dialog"]'))) return;
      if (document.querySelector('[role="dialog"]:not([hidden]), .modal-backdrop:not([hidden])')) return;
      // The BAN dialog is portaled into the parent so it stays centered in
      // the real browser viewport. Do not reload this frame while it is open.
      if (window.parent.document.querySelector('[data-managed-ban-modal]:not([hidden])')) return;
      const next = new URL(window.location.href);
      next.searchParams.set('refresh', '1');
      window.location.replace(next.href);
    } catch (error) {
      if (indicator) indicator.textContent = `Auto-refresh unavailable: ${String(error.message || error).slice(0,80)}`;
    }
  };
  if (indicator) indicator.textContent = `${seconds}s auto-refresh`;
  window.setInterval(refresh, seconds * 1000);
})();
